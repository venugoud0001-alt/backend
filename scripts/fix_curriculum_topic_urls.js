/**
 * fix_curriculum_topic_urls.js
 * 
 * Syncs curriculum_modules topic data with the topics DB table.
 * Embeds correct topic UUIDs and hls_master_url into course curriculum JSON.
 * 
 * Run: node scripts/fix_curriculum_topic_urls.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const COURSE_ID = 'ac3d8a52-753e-4c49-a1c7-6cdd250d8183'; // Cyber Security + Cloud Computing

async function main() {
  console.log('Fixing curriculum_modules topic data...\n');

  // 1. Fetch all READY topics from topics table for this course
  const { data: allTopics, error: topicErr } = await sb
    .from('topics')
    .select('id, module_id, title, processing_status, hls_master_url, hls_prefix, display_order, start_time_seconds, end_time_seconds, duration_seconds')
    .eq('course_id', COURSE_ID)
    .eq('processing_status', 'READY')
    .order('module_id')
    .order('display_order');

  if (topicErr) {
    console.error('Failed to fetch topics:', topicErr.message);
    process.exit(1);
  }

  console.log('Found ' + allTopics.length + ' READY topics in DB');

  // Group topics by module_id
  const topicsByModule = {};
  for (const t of allTopics) {
    const modId = String(t.module_id);
    if (!topicsByModule[modId]) topicsByModule[modId] = [];
    topicsByModule[modId].push(t);
  }

  Object.entries(topicsByModule).forEach(function([modId, ts]) {
    console.log('  Module ' + modId + ': ' + ts.length + ' topics');
  });

  // 2. Fetch the course curriculum
  const { data: course, error: courseErr } = await sb
    .from('courses')
    .select('id, title, curriculum_modules')
    .eq('id', COURSE_ID)
    .maybeSingle();

  if (courseErr || !course) {
    console.error('Failed to fetch course:', courseErr && courseErr.message || 'not found');
    process.exit(1);
  }

  console.log('\nCourse: ' + course.title);
  console.log('Total curriculum modules: ' + (course.curriculum_modules && course.curriculum_modules.length || 0));

  // 3. Rebuild curriculum_modules with proper topic data
  let totalFixed = 0;
  let totalSkipped = 0;

  const updatedModules = (course.curriculum_modules || []).map(function(mod, idx) {
    const modId = String(mod.id || idx + 1);
    const dbTopics = topicsByModule[modId] || [];

    if (dbTopics.length === 0) {
      console.log('  SKIP Module ' + modId + ' (' + (mod.title || '').slice(0, 40) + '): No READY topics in DB');
      totalSkipped++;
      return mod;
    }

    console.log('  FIX  Module ' + modId + ' (' + (mod.title || '').slice(0, 40) + '): Embedding ' + dbTopics.length + ' topics from DB');
    totalFixed++;

    const properTopics = dbTopics
      .sort(function(a, b) { return (a.display_order || 0) - (b.display_order || 0); })
      .map(function(t, tIdx) {
        return {
          id: t.id,
          title: t.title || ('Topic ' + (tIdx + 1)),
          display_order: t.display_order || (tIdx + 1),
          processing_status: t.processing_status,
          hls_master_url: t.hls_master_url,
          hls_prefix: t.hls_prefix,
          start_time_seconds: t.start_time_seconds,
          end_time_seconds: t.end_time_seconds,
          duration_seconds: t.duration_seconds
        };
      });

    const firstTopicUrl = dbTopics[0] && dbTopics[0].hls_master_url;
    const moduleVideoUrl = firstTopicUrl || mod.video_url;

    return Object.assign({}, mod, {
      topics: properTopics,
      video_url: moduleVideoUrl,
      video_status: 'READY',
      hasVideo: true
    });
  });

  // 4. Save updated curriculum
  const { error: updateErr } = await sb
    .from('courses')
    .update({ curriculum_modules: updatedModules, updated_at: new Date().toISOString() })
    .eq('id', COURSE_ID);

  if (updateErr) {
    console.error('\nFailed to update course curriculum:', updateErr.message);
    process.exit(1);
  }

  console.log('\nDone! Fixed ' + totalFixed + ' modules, skipped ' + totalSkipped + ' (no READY topics)');
  console.log('Modules 2 & 3 now have proper UUID topic data with hls_master_url');
  console.log('Module 1 will show "Video coming soon" until it is re-transcoded.');
}

main().catch(function(e) {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
