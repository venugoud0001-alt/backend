const { supabase } = require('../config/supabase');

async function inspectDetails() {
  try {
    console.log('--- 1. INSPECTING DUPLICATE SLUG "full-stack-development" ---');
    const { data: dupCourses, error: cErr } = await supabase
      .from('courses')
      .select('id, title, slug, price, status, created_at, updated_at')
      .eq('slug', 'full-stack-development');
    if (cErr) console.error('Course query error:', cErr.message);
    else console.log(JSON.stringify(dupCourses, null, 2));

    console.log('\n--- 2. INSPECTING LESSON_VIDEO_PROGRESS SAMPLE ---');
    const { data: prog, error: pErr } = await supabase
      .from('lesson_video_progress')
      .select('id, student_id, lesson_id, completion_percent, is_completed, watched_position_seconds, watched_duration_seconds')
      .limit(3);
    if (pErr) console.error('Progress query error:', pErr.message);
    else console.log(JSON.stringify(prog, null, 2));

    console.log('\n--- 3. INSPECTING LESSON_VIDEOS SAMPLE ---');
    const { data: vids, error: vErr } = await supabase
      .from('lesson_videos')
      .select('id, lesson_id, module_id, title, status, hls_master_url, mediaconvert_job_id')
      .limit(3);
    if (vErr) console.error('Videos query error:', vErr.message);
    else console.log(JSON.stringify(vids, null, 2));

    console.log('\n--- 4. INSPECTING TOPICS SAMPLE ---');
    const { data: tops, error: tErr } = await supabase
      .from('topics')
      .select('id, module_id, title, display_order, start_time_seconds, end_time_seconds, processing_status')
      .limit(3);
    if (tErr) console.error('Topics query error:', tErr.message);
    else console.log(JSON.stringify(tops, null, 2));

    console.log('\n--- 5. INSPECTING ORDERS & PAYMENTS RELATIONSHIP ---');
    const { data: pmts, error: pmErr } = await supabase
      .from('payments')
      .select('id, txn_id, cashfree_order_id, cashfree_payment_id, student_name, email, course_name, amount_paid, status')
      .limit(3);
    if (pmErr) console.error('Payments query error:', pmErr.message);
    else console.log(JSON.stringify(pmts, null, 2));

  } catch (err) {
    console.error('Fatal inspect error:', err.message);
  }
}

inspectDetails().then(() => process.exit(0));
