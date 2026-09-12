const { supabase } = require('../config/supabase');

async function checkAllDuplicates() {
  console.log('=== CHECKING ALL TABLES FOR DUPLICATES ===\n');

  // 1. Students duplicate emails
  const { data: students } = await supabase.from('students').select('id, email');
  const stuMap = {};
  for (const s of (students || [])) {
    const e = String(s.email).toLowerCase().trim();
    stuMap[e] = (stuMap[e] || 0) + 1;
  }
  const dupStu = Object.entries(stuMap).filter(([_, c]) => c > 1);
  console.log(`1. Students duplicate emails: ${dupStu.length}`);

  // 2. Courses duplicate slugs
  const { data: courses } = await supabase.from('courses').select('id, title, slug');
  const slugMap = {};
  for (const c of (courses || [])) {
    const s = String(c.slug).toLowerCase().trim();
    slugMap[s] = (slugMap[s] || 0) + 1;
  }
  const dupSlugs = Object.entries(slugMap).filter(([_, c]) => c > 1);
  console.log(`2. Courses duplicate slugs: ${dupSlugs.length} ->`, dupSlugs);

  // 3. Enrollments duplicate active enrollments (same student + course)
  const { data: enrs } = await supabase.from('enrollments').select('id, student_id, course_id, payment_status, course_access_status');
  const enrMap = {};
  for (const e of (enrs || [])) {
    if (e.course_access_status === 'UNLOCKED' || e.payment_status === 'PAID') {
      const key = `${e.student_id}_${e.course_id}`;
      enrMap[key] = (enrMap[key] || 0) + 1;
    }
  }
  const dupEnrs = Object.entries(enrMap).filter(([_, c]) => c > 1);
  console.log(`3. Duplicate active enrollments: ${dupEnrs.length}`);

  // 4. Orders duplicate cashfree_order_id
  const { data: orders } = await supabase.from('orders').select('order_id, cashfree_order_id');
  const ordMap = {};
  for (const o of (orders || [])) {
    ordMap[o.cashfree_order_id] = (ordMap[o.cashfree_order_id] || 0) + 1;
  }
  const dupOrders = Object.entries(ordMap).filter(([_, c]) => c > 1);
  console.log(`4. Orders duplicate cashfree_order_id: ${dupOrders.length}`);

  // 5. Course pricing duplicate course_id
  const { data: pricing } = await supabase.from('course_pricing').select('id, course_id');
  const priceMap = {};
  for (const p of (pricing || [])) {
    if (p.course_id) {
      priceMap[p.course_id] = (priceMap[p.course_id] || 0) + 1;
    }
  }
  const dupPricing = Object.entries(priceMap).filter(([_, c]) => c > 1);
  console.log(`5. Course pricing duplicate course_id: ${dupPricing.length}`);

  // 6. Topics duplicate display order per module
  const { data: topics } = await supabase.from('topics').select('id, course_id, module_id, display_order');
  const topMap = {};
  for (const t of (topics || [])) {
    const key = `${t.course_id}_${t.module_id}_${t.display_order}`;
    topMap[key] = (topMap[key] || 0) + 1;
  }
  const dupTopics = Object.entries(topMap).filter(([_, c]) => c > 1);
  console.log(`6. Topics duplicate display_order in same module: ${dupTopics.length}`);

  // 7. Lesson video progress duplicate (student_id, lesson_id)
  const { data: progs } = await supabase.from('lesson_video_progress').select('student_id, lesson_id');
  const pMap = {};
  for (const p of (progs || [])) {
    const key = `${p.student_id}_${p.lesson_id}`;
    pMap[key] = (pMap[key] || 0) + 1;
  }
  const dupProgs = Object.entries(pMap).filter(([_, c]) => c > 1);
  console.log(`7. Progress duplicate (student_id, lesson_id): ${dupProgs.length}`);
}

checkAllDuplicates().then(() => process.exit(0)).catch(console.error);
