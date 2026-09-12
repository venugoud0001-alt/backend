const { supabase } = require('../config/supabase');

async function checkCourseEnrollments() {
  const id1 = '2a541ca1-0400-4867-a5fe-87d591fd347c';
  const id2 = '5eeae4e4-1051-4879-a3a2-79896a35c91a';

  const { count: count1 } = await supabase.from('enrollments').select('*', { count: 'exact', head: true }).eq('course_id', id1);
  const { count: count2 } = await supabase.from('enrollments').select('*', { count: 'exact', head: true }).eq('course_id', id2);

  console.log(`Course 1 (${id1} - "Full Stack Web Development"): ${count1} enrollments`);
  console.log(`Course 2 (${id2} - "Full Stack Development"): ${count2} enrollments`);

  // Check frontend routes / slug lookups
  console.log('\nChecking courses lookup by slug in codebase...');
}

checkCourseEnrollments().then(() => process.exit(0));
