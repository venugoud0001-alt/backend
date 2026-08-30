const { supabase } = require('../src/config/supabase');
const courseService = require('../src/modules/courses/course.service');
const curriculumService = require('../src/modules/curriculum/curriculum.service');

async function debugCurriculum404() {
  console.log("=== DEBUGGING CURRICULUM 404 ERROR FOR c7485c67-5d3c-40f3-abc5-792073dc4750 ===\n");

  const courseId = "c7485c67-5d3c-40f3-abc5-792073dc4750";

  // 1. Direct Supabase query
  const { data: dbCourse, error: dbErr } = await supabase
    .from('courses')
    .select('*')
    .eq('id', courseId)
    .single();

  console.log("1. DATABASE QUERY FOR COURSE:", JSON.stringify(dbCourse, null, 2));
  if (dbErr) console.error("DB Query Error:", dbErr);

  // 2. Test courseService.getCourseById(courseId, false)
  try {
    const courseByIdPublic = await courseService.getCourseById(courseId, false);
    console.log("\n2. courseService.getCourseById(courseId, false):", JSON.stringify(courseByIdPublic, null, 2));
  } catch (err) {
    console.error("courseService.getCourseById Error:", err);
  }

  // 3. Test curriculumService.getPublicCourseCurriculum(courseId)
  try {
    const curriculum = await curriculumService.getPublicCourseCurriculum(courseId);
    console.log("\n3. curriculumService.getPublicCourseCurriculum(courseId):", JSON.stringify(curriculum, null, 2));
  } catch (err) {
    console.error("\n3. curriculumService.getPublicCourseCurriculum ERROR:", err);
  }

  process.exit(0);
}

debugCurriculum404();
