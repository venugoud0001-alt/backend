/**
 * diagnose_module1.js
 * Inspects all topics in DB and all S3 keys related to Module 1 / course.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
const { S3Client, ListObjectsV2Command, HeadObjectCommand } = require('@aws-sdk/client-s3');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const s3 = new S3Client({
  region: process.env.AWS_REGION || 'ap-south-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

const BUCKET = process.env.AWS_S3_BUCKET_OUTPUT || 'internnetra-lms-videos-prod-365957110532-ap-south-1-an';
const COURSE_ID = 'ac3d8a52-753e-4c49-a1c7-6cdd250d8183';

async function run() {
  console.log('=== 1. COURSE CURRICULUM MODULES ===');
  const { data: course, error: cErr } = await sb
    .from('courses')
    .select('id, title, slug, curriculum_modules')
    .eq('id', COURSE_ID)
    .single();

  if (cErr) {
    console.error('Course fetch error:', cErr.message);
    return;
  }

  console.log('Course Title:', course.title);
  console.log('Course Slug:', course.slug);
  console.log('Module count:', course.curriculum_modules?.length);

  course.curriculum_modules?.forEach((m, idx) => {
    console.log(`\nModule index ${idx}:`);
    console.log('  id:', JSON.stringify(m.id));
    console.log('  title:', m.title);
    console.log('  video_url:', m.video_url);
    console.log('  video_status:', m.video_status);
    console.log('  hasVideo:', m.hasVideo);
    console.log('  topics count:', m.topics?.length);
    if (m.topics && m.topics.length > 0) {
      console.log('  first topic:', JSON.stringify(m.topics[0]));
    }
  });

  console.log('\n=== 2. TOPICS TABLE IN SUPABASE ===');
  const { data: dbTopics, error: tErr } = await sb
    .from('topics')
    .select('id, module_id, course_id, title, processing_status, hls_master_url, hls_prefix, display_order')
    .eq('course_id', COURSE_ID)
    .order('module_id')
    .order('display_order');

  if (tErr) {
    console.error('Topics fetch error:', tErr.message);
  } else {
    console.log('Total topics in DB for course:', dbTopics?.length);
    dbTopics?.forEach(t => {
      console.log(`  id: ${t.id} | module_id: ${t.module_id} | status: ${t.processing_status} | title: ${t.title}`);
      console.log(`    hls_master_url: ${t.hls_master_url}`);
      console.log(`    hls_prefix: ${t.hls_prefix}`);
    });
  }

  console.log('\n=== 3. LESSON_VIDEOS TABLE IN SUPABASE ===');
  const { data: lv, error: lvErr } = await sb
    .from('lesson_videos')
    .select('*')
    .eq('course_id', COURSE_ID);

  if (lvErr) {
    console.error('lesson_videos error:', lvErr.message);
  } else {
    console.log('lesson_videos count:', lv?.length);
    lv?.forEach(v => {
      console.log(`  id: ${v.id} | lesson_id: ${v.lesson_id} | module_id: ${v.module_id} | status: ${v.status} | title: ${v.title}`);
      console.log(`    hls_master_url: ${v.hls_master_url}`);
      console.log(`    source_s3_key: ${v.source_s3_key}`);
    });
  }

  console.log('\n=== 4. S3 OBJECTS SEARCH FOR MODULE 1 ===');
  // List prefixes under courses/ or general
  try {
    const prefixesToTest = [
      'courses/',
      '01',
      '02',
      '03'
    ];
    for (const prefix of prefixesToTest) {
      const cmd = new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: prefix,
        MaxKeys: 30
      });
      const res = await s3.send(cmd);
      console.log(`\nS3 Prefix "${prefix}" (count: ${res.KeyCount || 0}):`);
      (res.Contents || []).slice(0, 10).forEach(obj => {
        console.log(`  ${obj.Key} (${obj.Size} bytes)`);
      });
      if ((res.CommonPrefixes || []).length > 0) {
        console.log('  CommonPrefixes:', res.CommonPrefixes.map(cp => cp.Prefix));
      }
    }
  } catch (s3Err) {
    console.error('S3 list error:', s3Err.message);
  }
}

run().catch(console.error);
