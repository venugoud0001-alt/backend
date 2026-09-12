const { supabase } = require('../config/supabase');

async function auditSchema() {
  console.log('--- 1. AUDITING CONSTRAINTS & INDEXES ---');

  // Let's test unique constraints on key tables by checking behavior and migrations
  // Table 1: lesson_video_progress unique constraint: (student_id, lesson_id)
  console.log('Auditing lesson_video_progress unique constraint...');
  const { data: progList } = await supabase.from('lesson_video_progress').select('student_id, lesson_id');
  const seenProg = new Set();
  let progDuplicates = 0;
  for (const p of (progList || [])) {
    const key = `${p.student_id}_${p.lesson_id}`;
    if (seenProg.has(key)) progDuplicates++;
    seenProg.add(key);
  }
  console.log(`lesson_video_progress total: ${progList ? progList.length : 0}, duplicate (student_id, lesson_id) pairs: ${progDuplicates}`);

  // Table 2: enrollments unique constraint / active enrollment integrity
  console.log('\nAuditing enrollments active state...');
  const { data: enrList } = await supabase.from('enrollments').select('id, student_id, course_id, payment_status, course_access_status');
  const seenActiveEnr = new Set();
  let enrActiveDuplicates = 0;
  for (const e of (enrList || [])) {
    if (e.course_access_status === 'UNLOCKED' || e.payment_status === 'PAID') {
      const key = `${e.student_id}_${e.course_id}`;
      if (seenActiveEnr.has(key)) enrActiveDuplicates++;
      seenActiveEnr.add(key);
    }
  }
  console.log(`enrollments total: ${enrList ? enrList.length : 0}, duplicate active enrollments: ${enrActiveDuplicates}`);

  // Table 3: orders cashfree_order_id & order_id uniqueness
  console.log('\nAuditing orders uniqueness...');
  const { data: orderList } = await supabase.from('orders').select('order_id, cashfree_order_id');
  const seenOrderId = new Set();
  let orderIdDuplicates = 0;
  for (const o of (orderList || [])) {
    if (seenOrderId.has(o.order_id)) orderIdDuplicates++;
    seenOrderId.add(o.order_id);
  }
  console.log(`orders total: ${orderList ? orderList.length : 0}, duplicate order_ids: ${orderIdDuplicates}`);

  // Table 4: payments txn_id & cashfree_payment_id uniqueness
  console.log('\nAuditing payments uniqueness...');
  const { data: pmtList } = await supabase.from('payments').select('id, txn_id, cashfree_payment_id');
  const seenTxn = new Set();
  let pmtDuplicates = 0;
  for (const p of (pmtList || [])) {
    if (seenTxn.has(p.txn_id)) pmtDuplicates++;
    seenTxn.add(p.txn_id);
  }
  console.log(`payments total: ${pmtList ? pmtList.length : 0}, duplicate txn_ids: ${pmtDuplicates}`);

  // Table 5: students email uniqueness
  console.log('\nAuditing students email uniqueness...');
  const { data: studentList } = await supabase.from('students').select('id, email');
  const seenEmail = new Set();
  let studentEmailDuplicates = 0;
  for (const s of (studentList || [])) {
    const email = String(s.email || '').toLowerCase().trim();
    if (seenEmail.has(email)) studentEmailDuplicates++;
    seenEmail.add(email);
  }
  console.log(`students total: ${studentList ? studentList.length : 0}, duplicate emails: ${studentEmailDuplicates}`);

  // Table 6: topics uniqueness and display ordering
  console.log('\nAuditing topics ordering...');
  const { data: topicList } = await supabase.from('topics').select('id, module_id, course_id, display_order');
  const seenTopicOrder = new Set();
  let topicOrderCollisions = 0;
  for (const t of (topicList || [])) {
    const key = `${t.course_id}_${t.module_id}_${t.display_order}`;
    if (seenTopicOrder.has(key)) topicOrderCollisions++;
    seenTopicOrder.add(key);
  }
  console.log(`topics total: ${topicList ? topicList.length : 0}, order collisions: ${topicOrderCollisions}`);
}

auditSchema().then(() => process.exit(0)).catch(console.error);
