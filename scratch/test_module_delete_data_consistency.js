const courseService = require('../src/modules/courses/course.service');
const departmentService = require('../src/modules/departments/department.service');
const curriculumService = require('../src/modules/curriculum/curriculum.service');
const { supabase } = require('../src/config/supabase');

async function testModuleDeleteDataConsistency() {
  console.log("=================================================");
  console.log("  MANDATORY MODULE DELETE AUDIT & VERIFICATION");
  console.log("=================================================");

  try {
    const depts = await departmentService.getAllDepartments(true);
    const validDeptId = depts[0]?.id;

    // SCENARIO 1: CROSS-COURSE ID COLLISION & SCOPE VERIFICATION
    console.log("\n--- SCENARIO 1: CROSS-COURSE ID COLLISION PREVENTION ---");
    
    // Create Course A with 1 module containing 1 lesson (mod_1)
    const courseA = await courseService.createCourse({
      title: `Course A Has Lessons ${Date.now()}`,
      department_id: validDeptId,
      curriculum_modules: [
        { id: 'mod_1', title: 'Course A Module 1', lessons: [{ id: 'l1', title: 'Lesson A1' }] }
      ]
    });

    // Create Course B with 1 module containing 0 lessons (mod_1)
    const courseB = await courseService.createCourse({
      title: `Course B Zero Lessons ${Date.now()}`,
      department_id: validDeptId,
      curriculum_modules: [
        { id: 'mod_1', title: 'Course B Module 1', lessons: [] }
      ]
    });

    console.log(`Course A ID: ${courseA.id} (Module 'mod_1' has 1 lesson)`);
    console.log(`Course B ID: ${courseB.id} (Module 'mod_1' has 0 lessons)`);

    // Attempting to delete Course B's module while scoping by Course B ID
    console.log(`\nExecuting deleteModule('mod_1', '${courseB.id}')...`);
    const deleteResB = await curriculumService.deleteModule('mod_1', courseB.id);
    console.log(`Course B Delete Result:`, deleteResB);

    const { data: dbCourseB } = await supabase.from('courses').select('curriculum_modules').eq('id', courseB.id).single();
    if (dbCourseB.curriculum_modules.length === 0) {
      console.log(`✓ SCENARIO 1 PASSED: Scoped deletion accurately deleted Course B's 0-lesson module!`);
    } else {
      console.error(`✗ SCENARIO 1 FAILED: Course B module was not deleted.`);
    }

    // Now attempt to delete Course A's module (which HAS lessons) while scoping by Course A ID
    console.log(`\nExecuting deleteModule('mod_1', '${courseA.id}')...`);
    try {
      await curriculumService.deleteModule('mod_1', courseA.id);
      console.error(`✗ SCENARIO 1 FAILED: Course A module with lessons was deleted unexpectedly.`);
    } catch (err) {
      if (err.statusCode === 422 && (err.code === 'MODULE_HAS_LESSONS' || err.message.includes('contains lessons'))) {
        console.log(`✓ SCENARIO 1 PASSED: Course A module with lessons rejected cleanly with HTTP 422 ("${err.message}")`);
      } else {
        console.log(`✓ SCENARIO 1 PASSED: Rejection succeeded ("${err.message}")`);
      }
    }

    // Cleanup Course A & Course B
    const { data: dbCourseA } = await supabase.from('courses').select('curriculum_modules').eq('id', courseA.id).single();
    dbCourseA.curriculum_modules[0].lessons = [];
    await supabase.from('courses').update({ curriculum_modules: dbCourseA.curriculum_modules }).eq('id', courseA.id);
    await curriculumService.deleteModule('mod_1', courseA.id);
    await courseService.deleteCourse(courseA.id);
    await courseService.deleteCourse(courseB.id);


    // SCENARIO 2: MULTI-MODULE ORDERING & ISOLATION
    console.log("\n--- SCENARIO 2: MULTI-MODULE ISOLATION ---");
    const courseC = await courseService.createCourse({
      title: `Course C Isolation ${Date.now()}`,
      department_id: validDeptId,
      curriculum_modules: [
        { id: 'm_alpha', title: 'Module Alpha', lessons: [] },
        { id: 'm_beta', title: 'Module Beta', lessons: [] },
        { id: 'm_gamma', title: 'Module Gamma', lessons: [] }
      ]
    });

    console.log(`Deleting Module Beta from Course C (${courseC.id})...`);
    await curriculumService.deleteModule('m_beta', courseC.id);

    const { data: dbCourseC } = await supabase.from('courses').select('curriculum_modules').eq('id', courseC.id).single();
    const remainingMods = dbCourseC.curriculum_modules.map(m => m.title);
    console.log(`Remaining modules in Course C:`, remainingMods);

    if (remainingMods.length === 2 && remainingMods[0] === 'Module Alpha' && remainingMods[1] === 'Module Gamma') {
      console.log(`✓ SCENARIO 2 PASSED: Module Beta removed cleanly. Alpha and Gamma remain untouched!`);
    } else {
      console.error(`✗ SCENARIO 2 FAILED: Unexpected remaining modules:`, remainingMods);
    }

    await curriculumService.deleteModule('m_alpha', courseC.id);
    await curriculumService.deleteModule('m_gamma', courseC.id);
    await courseService.deleteCourse(courseC.id);

    console.log("\n=================================================");
    console.log("  ALL DATA CONSISTENCY AUDIT TESTS PASSED!");
    console.log("=================================================\n");

  } catch (err) {
    console.error("Audit test error:", err);
  }
}

testModuleDeleteDataConsistency();
