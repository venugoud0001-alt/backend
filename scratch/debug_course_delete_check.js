const { supabase } = require('../src/config/supabase');

async function debugCourseDelete() {
  const targetId = 'edf73c7b-b75f-4dff-bf04-8ca942f190e7';
  console.log(`=== AUDITING COURSE ${targetId} ===`);

  // 1. Fetch from courses table
  const { data: courseRow, error: courseErr } = await supabase
    .from('courses')
    .select('*')
    .eq('id', targetId)
    .maybeSingle();

  if (courseErr) {
    console.error("Course fetch error:", courseErr);
  } else {
    console.log("Course row:", courseRow ? {
      id: courseRow.id,
      title: courseRow.title,
      slug: courseRow.slug,
      category_id: courseRow.category_id,
      status: courseRow.status,
      curriculum_modules: courseRow.curriculum_modules
    } : "NOT FOUND");
  }

  // 2. Check enrollments table
  const { data: enrollments, error: enrErr } = await supabase
    .from('enrollments')
    .select('*')
    .eq('course_id', targetId);

  console.log("Enrollments count:", enrollments ? enrollments.length : 0, enrErr ? `(Error: ${enrErr.message})` : "");
  if (enrollments && enrollments.length > 0) {
    console.log("Enrollments samples:", enrollments);
  }

  // 3. Check orders table
  const { data: orders, error: ordErr } = await supabase
    .from('orders')
    .select('*')
    .eq('course_id', targetId);

  console.log("Orders count:", orders ? orders.length : 0, ordErr ? `(Error: ${ordErr.message})` : "");

  // 4. Check payments table
  const { data: payments, error: pmtErr } = await supabase
    .from('payments')
    .select('*')
    .eq('course_id', targetId);

  console.log("Payments count:", payments ? payments.length : 0, pmtErr ? `(Error: ${pmtErr.message})` : "");

  // 5. Check if a separate curriculum_modules table exists in Supabase
  try {
    const { data: modRows, error: modErr } = await supabase
      .from('curriculum_modules')
      .select('*')
      .eq('course_id', targetId);

    console.log("curriculum_modules table rows:", modRows ? modRows.length : 0, modErr ? `(Error: ${modErr.message})` : "");
  } catch (err) {
    console.log("curriculum_modules table query exception:", err.message);
  }
}

debugCourseDelete();
