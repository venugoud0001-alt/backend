const { supabase } = require('../config/supabase');

async function auditNullability() {
  console.log('=== CHECKING FOR ACCIDENTAL NULL VALUES ===\n');

  // Courses
  const { data: courses } = await supabase.from('courses').select('id, title, slug, price, status');
  const nullCourseTitle = (courses || []).filter(c => !c.title);
  const nullCourseSlug = (courses || []).filter(c => !c.slug);
  const nullCoursePrice = (courses || []).filter(c => c.price === null || c.price === undefined);
  console.log(`Courses null titles: ${nullCourseTitle.length}, null slugs: ${nullCourseSlug.length}, null price: ${nullCoursePrice.length}`);

  // Students
  const { data: students } = await supabase.from('students').select('id, email, full_name');
  const nullStuEmail = (students || []).filter(s => !s.email);
  console.log(`Students null emails: ${nullStuEmail.length}`);

  // Enrollments
  const { data: enrs } = await supabase.from('enrollments').select('id, student_id, course_id, payment_status, course_access_status');
  const nullEnrStu = (enrs || []).filter(e => !e.student_id);
  const nullEnrCourse = (enrs || []).filter(e => !e.course_id);
  const nullEnrStatus = (enrs || []).filter(e => !e.payment_status || !e.course_access_status);
  console.log(`Enrollments null student_id: ${nullEnrStu.length}, null course_id: ${nullEnrCourse.length}, null status: ${nullEnrStatus.length}`);

  // Orders
  const { data: orders } = await supabase.from('orders').select('order_id, student_id, course_id, amount, status');
  const nullOrdId = (orders || []).filter(o => !o.order_id);
  const nullOrdStu = (orders || []).filter(o => !o.student_id);
  const nullOrdCourse = (orders || []).filter(o => !o.course_id);
  const nullOrdAmt = (orders || []).filter(o => o.amount === null || o.amount === undefined);
  console.log(`Orders null order_id: ${nullOrdId.length}, null student_id: ${nullOrdStu.length}, null course_id: ${nullOrdCourse.length}, null amount: ${nullOrdAmt.length}`);

  // Topics
  const { data: topics } = await supabase.from('topics').select('id, course_id, title, display_order');
  const nullTopId = (topics || []).filter(t => !t.id);
  const nullTopTitle = (topics || []).filter(t => !t.title);
  const nullTopOrder = (topics || []).filter(t => t.display_order === null || t.display_order === undefined);
  console.log(`Topics null id: ${nullTopId.length}, null title: ${nullTopTitle.length}, null display_order: ${nullTopOrder.length}`);

  // Progress
  const { data: progs } = await supabase.from('lesson_video_progress').select('id, student_id, lesson_id, completion_percent');
  const nullProgStu = (progs || []).filter(p => !p.student_id);
  const nullProgLesson = (progs || []).filter(p => !p.lesson_id);
  console.log(`Progress null student_id: ${nullProgStu.length}, null lesson_id: ${nullProgLesson.length}`);
}

auditNullability().then(() => process.exit(0)).catch(console.error);
