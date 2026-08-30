const { supabase } = require('./src/config/supabase');

async function checkCourses() {
  const { data, error } = await supabase.from('courses').select('id, title, slug, status');
  console.log('Database Courses Count:', data?.length);
  console.log('Sample Database Courses:', JSON.stringify(data?.slice(0, 5), null, 2));
}
checkCourses().catch(console.error);
