const { supabase } = require('../src/config/supabase');
const courseService = require('../src/modules/courses/course.service');
const curriculumService = require('../src/modules/curriculum/curriculum.service');

async function testModuleDelete() {
  console.log("=== TESTING MODULE DELETE ===");
  const testCourse = await courseService.createCourse({
    title: `Mod Delete Test ${Date.now()}`,
    department_id: 'af969be3-f98a-46e6-82e2-54a13433612b',
    curriculum_modules: [
      { id: 'm1', title: 'Module One' },
      { id: 'm2', title: 'Module Two' }
    ]
  });

  console.log("Created Course ID:", testCourse.id, "Slug:", testCourse.slug);

  // Fetch direct from DB
  const { data: dbCourse1 } = await supabase.from('courses').select('curriculum_modules').eq('id', testCourse.id).single();
  console.log("Initial DB curriculum_modules:", dbCourse1.curriculum_modules);

  // Delete m1
  console.log("Deleting m1...");
  await curriculumService.deleteModule('m1');

  const { data: dbCourse2 } = await supabase.from('courses').select('curriculum_modules').eq('id', testCourse.id).single();
  console.log("After deleting m1 DB curriculum_modules:", dbCourse2.curriculum_modules);

  // Delete m2
  console.log("Deleting m2...");
  await curriculumService.deleteModule('m2');

  const { data: dbCourse3 } = await supabase.from('courses').select('curriculum_modules').eq('id', testCourse.id).single();
  console.log("After deleting m2 DB curriculum_modules:", dbCourse3.curriculum_modules);

  // Attempt course delete
  console.log("Attempting course delete now...");
  await courseService.deleteCourse(testCourse.id);
  console.log("Course delete SUCCESS!");
}

testModuleDelete();
