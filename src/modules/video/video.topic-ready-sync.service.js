/**
 * Topic Playback Ready Sync
 * Guarantees Mode 2 topics become student-playable whenever lesson_videos has READY+HLS.
 * Closes the failure mode where MediaConvert finishes (lesson_videos READY) but
 * topics / curriculum_modules stay DRAFT → student sees "WILL BE UPDATED SOON".
 */

const { supabase } = require('../../config/supabase');

function invalidatePublicCurriculumCacheSafe(course) {
  try {
    const curriculumService = require('../curriculum/curriculum.service');
    if (typeof curriculumService.invalidatePublicCurriculumCache === 'function') {
      curriculumService.invalidatePublicCurriculumCache(course);
    }
  } catch (_) {}
}

function pickBestReadyVideo(rows = []) {
  const ready = (rows || []).filter(
    (v) => String(v?.status || '').toUpperCase() === 'READY' && v?.hls_master_url
  );
  if (!ready.length) return null;
  ready.sort((a, b) => {
    const da = Number(a.duration_seconds) || 0;
    const db = Number(b.duration_seconds) || 0;
    if (db !== da) return db - da;
    return String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
  });
  return ready[0];
}

function topicNeedsReadySync(topic, readyVideo) {
  if (!topic?.id || !readyVideo?.hls_master_url) return false;
  const status = String(topic.processing_status || '').toUpperCase();
  if (status !== 'READY') return true;
  if (!topic.hls_master_url) return true;
  if (String(topic.hls_master_url) !== String(readyVideo.hls_master_url)) return true;
  const topicDur = Number(topic.duration_seconds) || 0;
  const videoDur = Number(readyVideo.duration_seconds) || 0;
  if (videoDur > 1 && (topicDur <= 1 || topicDur === 855)) return true;
  return false;
}

/**
 * Sync one topic row (+ curriculum JSON) from its best READY lesson_videos asset.
 * @returns {Promise<{synced:boolean, topicId?:string, reason?:string}>}
 */
async function syncTopicReadyFromLessonVideos(topicId, options = {}) {
  const cleanTopicId = String(topicId || '').trim();
  if (!cleanTopicId) return { synced: false, reason: 'missing_topic_id' };

  const { data: topic, error: topicErr } = await supabase
    .from('topics')
    .select('id, title, module_id, course_id, processing_status, hls_master_url, hls_prefix, source_video_id, duration_seconds')
    .eq('id', cleanTopicId)
    .maybeSingle();

  if (topicErr || !topic) {
    return { synced: false, topicId: cleanTopicId, reason: 'topic_not_found' };
  }

  let best = null;
  if (options.preferredVideoId) {
    const { data: preferred } = await supabase
      .from('lesson_videos')
      .select('id, topic_id, lesson_id, status, hls_master_url, hls_prefix, duration_seconds, updated_at')
      .eq('id', options.preferredVideoId)
      .maybeSingle();
    if (preferred?.hls_master_url && String(preferred.status || '').toUpperCase() === 'READY') {
      best = preferred;
    }
  }

  if (!best) {
    const { data: videos, error: videoErr } = await supabase
      .from('lesson_videos')
      .select('id, topic_id, lesson_id, status, hls_master_url, hls_prefix, duration_seconds, updated_at')
      .or(`topic_id.eq.${cleanTopicId},lesson_id.eq.${cleanTopicId}`)
      .eq('status', 'READY')
      .not('hls_master_url', 'is', null)
      .order('updated_at', { ascending: false })
      .limit(10);

    if (videoErr) {
      return { synced: false, topicId: cleanTopicId, reason: videoErr.message };
    }
    best = pickBestReadyVideo(videos);
  }

  if (!best) {
    return { synced: false, topicId: cleanTopicId, reason: 'no_ready_hls' };
  }

  return applyTopicReadySync(topic, best, options);
}

async function applyTopicReadySync(topic, readyVideo, options = {}) {
  if (!topicNeedsReadySync(topic, readyVideo) && !options.force) {
    return { synced: false, topicId: topic.id, reason: 'already_ready' };
  }

  const durationSeconds = Number(readyVideo.duration_seconds) > 1
    ? Number(readyVideo.duration_seconds)
    : (Number(topic.duration_seconds) > 1 ? Number(topic.duration_seconds) : null);

  const patch = {
    processing_status: 'READY',
    hls_master_url: readyVideo.hls_master_url,
    hls_prefix: readyVideo.hls_prefix || topic.hls_prefix || null,
    source_video_id: readyVideo.id,
    processing_error: null,
    updated_at: new Date().toISOString()
  };
  if (durationSeconds) patch.duration_seconds = durationSeconds;

  const { error: upErr } = await supabase.from('topics').update(patch).eq('id', topic.id);
  if (upErr) {
    console.error(`❌ [TopicReadySync] topics update failed for ${topic.id}:`, upErr.message || upErr);
    return { synced: false, topicId: topic.id, reason: upErr.message };
  }

  // Keep curriculum_modules JSON in sync so student/admin UIs never see stale DRAFT
  const courseId = topic.course_id || options.courseId;
  if (courseId) {
    try {
      const { data: courseObj } = await supabase
        .from('courses')
        .select('id, slug, curriculum_modules')
        .eq('id', courseId)
        .maybeSingle();

      if (courseObj && Array.isArray(courseObj.curriculum_modules)) {
        let jsonChanged = false;
        const moduleId = String(topic.module_id || options.moduleId || '');
        const updatedModules = courseObj.curriculum_modules.map((m) => {
          if (!m || !Array.isArray(m.topics)) return m;
          if (moduleId && String(m.id) !== moduleId) return m;

          const topics = m.topics.map((t) => {
            if (!t || typeof t !== 'object') return t;
            const match =
              String(t.id) === String(topic.id) ||
              (topic.title && String(t.title || t.name || '') === String(topic.title));
            if (!match) return t;
            jsonChanged = true;
            return {
              ...t,
              id: topic.id,
              processing_status: 'READY',
              video_status: 'READY',
              hls_master_url: readyVideo.hls_master_url,
              video_url: readyVideo.hls_master_url,
              hls_prefix: readyVideo.hls_prefix || t.hls_prefix || null,
              source_video_id: readyVideo.id,
              video_asset_id: readyVideo.id,
              duration_seconds: durationSeconds || t.duration_seconds || 0
            };
          });
          return { ...m, topics };
        });

        if (jsonChanged) {
          await supabase
            .from('courses')
            .update({
              curriculum_modules: updatedModules,
              updated_at: new Date().toISOString()
            })
            .eq('id', courseObj.id);
          invalidatePublicCurriculumCacheSafe(courseObj);
        }
      }
    } catch (jsonErr) {
      console.warn(`⚠️ [TopicReadySync] curriculum JSON sync notice for ${topic.id}:`, jsonErr.message || jsonErr);
    }
  }

  console.log(`✅ [TopicReadySync] Topic ${topic.id} synced to READY from lesson_videos ${readyVideo.id}`);
  return {
    synced: true,
    topicId: topic.id,
    videoId: readyVideo.id,
    hls_master_url: readyVideo.hls_master_url
  };
}

/**
 * Heal all DRAFT/missing-HLS topics in a course that already have READY lesson_videos.
 * Safe for Mode 1 (only touches topics with their own READY topic/lesson video rows).
 */
async function syncCourseTopicsReadyFromLessonVideos(courseId) {
  const cleanCourseId = String(courseId || '').trim();
  if (!cleanCourseId) return { syncedCount: 0, checked: 0 };

  const { data: topics, error } = await supabase
    .from('topics')
    .select('id, title, module_id, course_id, processing_status, hls_master_url, hls_prefix, source_video_id, duration_seconds')
    .eq('course_id', cleanCourseId);

  if (error || !Array.isArray(topics) || topics.length === 0) {
    return { syncedCount: 0, checked: 0, error: error?.message };
  }

  const candidates = topics.filter((t) => {
    const status = String(t.processing_status || '').toUpperCase();
    return status !== 'READY' || !t.hls_master_url;
  });

  let syncedCount = 0;
  for (const topic of candidates) {
    const result = await syncTopicReadyFromLessonVideos(topic.id, {
      courseId: cleanCourseId,
      moduleId: topic.module_id
    });
    if (result.synced) syncedCount += 1;
  }

  if (syncedCount > 0) {
    invalidatePublicCurriculumCacheSafe({ id: cleanCourseId });
  }

  return { syncedCount, checked: candidates.length };
}

/**
 * Apply in-memory enrichment for a topic list using READY lesson_videos maps.
 * Does not write DB — used on hot curriculum reads for immediate student playback.
 */
function enrichTopicsWithReadyLessonVideos(topics = [], lessonVideos = []) {
  if (!Array.isArray(topics) || topics.length === 0) return topics;

  const byTopic = new Map();
  const byLesson = new Map();
  const byId = new Map();
  for (const v of lessonVideos || []) {
    if (!v) continue;
    if (v.id) byId.set(String(v.id), v);
    if (v.topic_id) {
      const list = byTopic.get(String(v.topic_id)) || [];
      list.push(v);
      byTopic.set(String(v.topic_id), list);
    }
    if (v.lesson_id) {
      const list = byLesson.get(String(v.lesson_id)) || [];
      list.push(v);
      byLesson.set(String(v.lesson_id), list);
    }
  }

  return topics.map((t) => {
    if (!t || typeof t !== 'object') return t;
    const keys = [t.id, t.source_video_id, t.video_asset_id].filter(Boolean).map(String);
    let best = null;
    for (const key of keys) {
      best = pickBestReadyVideo(byTopic.get(key)) || pickBestReadyVideo(byLesson.get(key)) || (
        byId.get(key)?.status === 'READY' && byId.get(key)?.hls_master_url ? byId.get(key) : null
      );
      if (best) break;
    }
    if (!best) return t;
    if (!topicNeedsReadySync(t, best)) return t;
    const durationSeconds = Number(best.duration_seconds) > 1
      ? Number(best.duration_seconds)
      : (Number(t.duration_seconds) || 0);
    return {
      ...t,
      processing_status: 'READY',
      hls_master_url: best.hls_master_url,
      source_video_id: best.id,
      video_asset_id: t.video_asset_id || best.id,
      duration_seconds: durationSeconds || t.duration_seconds
    };
  });
}

module.exports = {
  syncTopicReadyFromLessonVideos,
  syncCourseTopicsReadyFromLessonVideos,
  enrichTopicsWithReadyLessonVideos,
  pickBestReadyVideo,
  topicNeedsReadySync
};
