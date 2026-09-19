/**
 * One-shot backfill: sync every DRAFT/missing-HLS topic that already has READY lesson_videos.
 * Safe across all courses. Run: node backend/scripts/backfill_topic_ready_sync.cjs
 */
const path = require('path');
const fs = require('fs');

function loadEnv(p) {
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (!m) continue;
    const k = m[1].trim();
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
}

loadEnv(path.join(__dirname, '../.env'));
loadEnv(path.join(__dirname, '../../.env'));

const { createClient } = require('../node_modules/@supabase/supabase-js');
const topicReadySync = require('../src/modules/video/video.topic-ready-sync.service');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

(async () => {
  const { data: courses, error } = await sb.from('courses').select('id, slug, title');
  if (error) throw error;

  let totalSynced = 0;
  for (const course of courses || []) {
    const result = await topicReadySync.syncCourseTopicsReadyFromLessonVideos(course.id);
    if (result.syncedCount > 0) {
      console.log(`✅ ${course.slug || course.id}: synced ${result.syncedCount}/${result.checked}`);
      totalSynced += result.syncedCount;
    } else {
      console.log(`— ${course.slug || course.id}: nothing to sync (checked ${result.checked})`);
    }
  }
  console.log(`DONE totalSynced=${totalSynced}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
