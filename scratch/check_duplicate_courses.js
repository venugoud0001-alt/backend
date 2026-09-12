const { supabase } = require('../config/supabase');

async function checkConstraints() {
  const { data: c1 } = await supabase.from('courses').select('id, title, slug').eq('id', '2a541ca1-0400-4867-a5fe-87d591fd347c').single();
  const { data: c2 } = await supabase.from('courses').select('id, title, slug').eq('id', '5eeae4e4-1051-4879-a3a2-79896a35c91a').single();

  console.log('Course 1:', c1);
  console.log('Course 2:', c2);

  // Check how many students are enrolled in each
  const { count: enrCount1 } = await supabase.from('enrollments').select('*', { count: 'exact', head: true }).eq('course_id', c1.id);
  const { count: enrCount2 } = await supabase.from('enrollments').select('*', { count: 'exact', head: true }).eq('course_id', c2.id);

  console.log(`Course 1 (${c1.title}) has ${enrCount1} enrollments.`);
  console.log(`Course 2 (${c2.title}) has ${enrCount2} enrollments.`);
}

checkConstraints().then(() => process.exit(0)).catch(console.error);
