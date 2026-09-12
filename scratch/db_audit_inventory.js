/**
 * Phase 2 Comprehensive Database Inventory & Data Integrity Audit Script
 */
const { supabase } = require('../config/supabase');

async function runAudit() {
  console.log('====================================================');
  console.log('🔍 INTERNNETRA DATABASE & DATA INTEGRITY AUDIT');
  console.log('====================================================\n');

  const tables = [
    'courses',
    'course_versions',
    'modules',
    'lessons',
    'topics',
    'lesson_videos',
    'students',
    'enrollments',
    'orders',
    'payments',
    'course_pricing',
    'lesson_video_progress',
    'certificate_requests',
    'batches',
    'coupons',
    'sub_users',
    'roles',
    'permissions',
    'otp_verifications'
  ];

  const inventory = {};

  // 1. Table Counts & Connectivity Check
  console.log('--- 1. TABLE INVENTORY & RECORD COUNTS ---');
  for (const table of tables) {
    try {
      const { data, count, error } = await supabase
        .from(table)
        .select('*', { count: 'exact', head: true });

      if (error) {
        inventory[table] = { status: 'ERROR', error: error.message, count: 0 };
        console.log(`❌ ${table.padEnd(25)}: ERROR (${error.message})`);
      } else {
        inventory[table] = { status: 'ONLINE', count: count || 0 };
        console.log(`✅ ${table.padEnd(25)}: ${String(count || 0).padStart(6)} records`);
      }
    } catch (err) {
      inventory[table] = { status: 'EXCEPTION', error: err.message, count: 0 };
      console.log(`❌ ${table.padEnd(25)}: EXCEPTION (${err.message})`);
    }
  }

  // 2. Orphan Records Audit
  console.log('\n--- 2. ORPHAN RECORD AUDIT ---');

  // 2a. Modules without course_versions or courses
  try {
    const { data: allMods } = await supabase.from('modules').select('id, name, course_version_id');
    const { data: allVersions } = await supabase.from('course_versions').select('id, course_id');
    const versionIds = new Set((allVersions || []).map(v => v.id));
    const orphanedMods = (allMods || []).filter(m => m.course_version_id && !versionIds.has(m.course_version_id));
    console.log(`Modules without valid course_version: ${orphanedMods.length}`);
  } catch (e) {
    console.log(`Modules check note: ${e.message}`);
  }

  // 2b. Lessons without valid modules
  try {
    const { data: allLessons } = await supabase.from('lessons').select('id, title, module_id');
    const { data: allMods } = await supabase.from('modules').select('id');
    const modIds = new Set((allMods || []).map(m => m.id));
    const orphanedLessons = (allLessons || []).filter(l => l.module_id && !modIds.has(l.module_id));
    console.log(`Lessons without valid module: ${orphanedLessons.length}`);
  } catch (e) {
    console.log(`Lessons check note: ${e.message}`);
  }

  // 2c. Topics without valid modules/lessons
  try {
    const { data: allTopics } = await supabase.from('topics').select('id, title, module_id');
    const { data: allMods } = await supabase.from('modules').select('id');
    const modIds = new Set((allMods || []).map(m => m.id));
    const orphanedTopics = (allTopics || []).filter(t => t.module_id && !modIds.has(t.module_id));
    console.log(`Topics without valid module: ${orphanedTopics.length}`);
  } catch (e) {
    console.log(`Topics check note: ${e.message}`);
  }

  // 2d. Lesson videos without valid lesson/topic
  try {
    const { data: allVideos } = await supabase.from('lesson_videos').select('id, lesson_id, topic_id, status, hls_master_url');
    console.log(`Total lesson_videos: ${allVideos ? allVideos.length : 0}`);
    const readyWithHls = (allVideos || []).filter(v => v.status === 'READY' && v.hls_master_url);
    const readyNoHls = (allVideos || []).filter(v => v.status === 'READY' && !v.hls_master_url);
    console.log(`  - READY with HLS: ${readyWithHls.length}`);
    console.log(`  - READY missing HLS: ${readyNoHls.length}`);
  } catch (e) {
    console.log(`Lesson videos check note: ${e.message}`);
  }

  // 2e. Enrollments without valid students or courses
  try {
    const { data: allEnrs } = await supabase.from('enrollments').select('id, student_id, course_id, payment_status, course_access_status');
    const { data: allStudents } = await supabase.from('students').select('id');
    const { data: allCourses } = await supabase.from('courses').select('id');
    const stuIds = new Set((allStudents || []).map(s => s.id));
    const courseIds = new Set((allCourses || []).map(c => c.id));
    const enrOrphanStudent = (allEnrs || []).filter(e => e.student_id && !stuIds.has(e.student_id));
    const enrOrphanCourse = (allEnrs || []).filter(e => e.course_id && !courseIds.has(e.course_id));
    console.log(`Enrollments without valid student: ${enrOrphanStudent.length}`);
    console.log(`Enrollments without valid course: ${enrOrphanCourse.length}`);
  } catch (e) {
    console.log(`Enrollments check note: ${e.message}`);
  }

  // 2f. Orders without valid student or enrollment
  try {
    const { data: allOrders } = await supabase.from('orders').select('order_id, student_id, enrollment_id, status');
    const { data: allStudents } = await supabase.from('students').select('id');
    const { data: allEnrs } = await supabase.from('enrollments').select('id');
    const stuIds = new Set((allStudents || []).map(s => s.id));
    const enrIds = new Set((allEnrs || []).map(e => e.id));
    const ordOrphanStudent = (allOrders || []).filter(o => o.student_id && !stuIds.has(o.student_id));
    const ordOrphanEnr = (allOrders || []).filter(o => o.enrollment_id && !enrIds.has(o.enrollment_id));
    console.log(`Orders without valid student: ${ordOrphanStudent.length}`);
    console.log(`Orders without valid enrollment: ${ordOrphanEnr.length}`);
  } catch (e) {
    console.log(`Orders check note: ${e.message}`);
  }

  // 2g. Progress without valid student
  try {
    const { data: allProgress } = await supabase.from('lesson_video_progress').select('id, student_id, lesson_id, progress_percentage');
    const { data: allStudents } = await supabase.from('students').select('id');
    const stuIds = new Set((allStudents || []).map(s => s.id));
    const progOrphan = (allProgress || []).filter(p => p.student_id && !stuIds.has(p.student_id));
    console.log(`Progress records without valid student: ${progOrphan.length}`);
  } catch (e) {
    console.log(`Progress check note: ${e.message}`);
  }

  // 3. Duplicate Records Audit
  console.log('\n--- 3. DUPLICATE RECORD AUDIT ---');

  // 3a. Students duplicate emails
  try {
    const { data: students } = await supabase.from('students').select('id, email');
    const emailCounts = {};
    for (const s of (students || [])) {
      const email = String(s.email || '').toLowerCase().trim();
      emailCounts[email] = (emailCounts[email] || 0) + 1;
    }
    const dupEmails = Object.entries(emailCounts).filter(([e, c]) => c > 1);
    console.log(`Duplicate student emails: ${dupEmails.length} ${dupEmails.length > 0 ? JSON.stringify(dupEmails) : ''}`);
  } catch (e) {
    console.log(`Student duplicates check note: ${e.message}`);
  }

  // 3b. Courses duplicate slugs
  try {
    const { data: courses } = await supabase.from('courses').select('id, title, slug');
    const slugCounts = {};
    for (const c of (courses || [])) {
      const slug = String(c.slug || '').toLowerCase().trim();
      slugCounts[slug] = (slugCounts[slug] || 0) + 1;
    }
    const dupSlugs = Object.entries(slugCounts).filter(([s, c]) => c > 1);
    console.log(`Duplicate course slugs: ${dupSlugs.length} ${dupSlugs.length > 0 ? JSON.stringify(dupSlugs) : ''}`);
  } catch (e) {
    console.log(`Course slug duplicates check note: ${e.message}`);
  }

  // 3c. Duplicate active enrollments for same student + course
  try {
    const { data: enrs } = await supabase.from('enrollments').select('id, student_id, course_id, payment_status, course_access_status');
    const activeMap = {};
    for (const e of (enrs || [])) {
      if (e.course_access_status === 'ACTIVE' || e.payment_status === 'PAID') {
        const key = `${e.student_id}_${e.course_id}`;
        activeMap[key] = (activeMap[key] || 0) + 1;
      }
    }
    const dupActive = Object.entries(activeMap).filter(([k, c]) => c > 1);
    console.log(`Duplicate active enrollments (same student + course): ${dupActive.length}`);
  } catch (e) {
    console.log(`Duplicate active enrollment note: ${e.message}`);
  }

  // 3d. Duplicate progress records for same student + lesson / topic
  try {
    const { data: progList } = await supabase.from('lesson_video_progress').select('id, student_id, lesson_id, topic_id');
    const progMap = {};
    for (const p of (progList || [])) {
      const key = `${p.student_id}_${p.lesson_id}_${p.topic_id || 'notopic'}`;
      progMap[key] = (progMap[key] || 0) + 1;
    }
    const dupProg = Object.entries(progMap).filter(([k, c]) => c > 1);
    console.log(`Duplicate progress records (same student + lesson + topic): ${dupProg.length}`);
  } catch (e) {
    console.log(`Duplicate progress note: ${e.message}`);
  }

  // 3e. Duplicate pending certificate requests (same student + course)
  try {
    const { data: certs } = await supabase.from('certificate_requests').select('certificate_id, student_id, course_id, status');
    const certMap = {};
    for (const c of (certs || [])) {
      if (c.status === 'PENDING_APPROVAL') {
        const key = `${c.student_id}_${c.course_id}`;
        certMap[key] = (certMap[key] || 0) + 1;
      }
    }
    const dupCert = Object.entries(certMap).filter(([k, c]) => c > 1);
    console.log(`Duplicate pending certificate requests (same student + course): ${dupCert.length}`);
  } catch (e) {
    console.log(`Duplicate certificate note: ${e.message}`);
  }

  // 4. Status Value Consistency
  console.log('\n--- 4. STATUS VALUES CONSISTENCY ---');
  try {
    const { data: enrs } = await supabase.from('enrollments').select('payment_status, course_access_status');
    const pmtStatuses = new Set((enrs || []).map(e => e.payment_status));
    const accessStatuses = new Set((enrs || []).map(e => e.course_access_status));
    console.log('Enrollments payment_status values:', Array.from(pmtStatuses));
    console.log('Enrollments course_access_status values:', Array.from(accessStatuses));

    const { data: ords } = await supabase.from('orders').select('status');
    console.log('Orders status values:', Array.from(new Set((ords || []).map(o => o.status))));

    const { data: vids } = await supabase.from('lesson_videos').select('status');
    console.log('Lesson videos status values:', Array.from(new Set((vids || []).map(v => v.status))));

    const { data: certs } = await supabase.from('certificate_requests').select('status');
    console.log('Certificate requests status values:', Array.from(new Set((certs || []).map(c => c.status))));
  } catch (e) {
    console.log(`Status value check note: ${e.message}`);
  }

  console.log('\n====================================================');
  console.log('🏁 DATABASE AUDIT PRELIMINARY DATA EXTRACTION FINISHED');
  console.log('====================================================\n');
}

runAudit().catch(console.error);
