const { supabase } = require('../src/config/supabase');

async function inspectCourseDb() {
  const courseId = '578ec351-7f3d-4916-8356-974a4e59e377';
  console.log(`=== DATABASE INSPECTION FOR COURSE ID: ${courseId} ===\n`);

  try {
    // 1. Course Record
    const { data: course, error: courseErr } = await supabase
      .from('courses')
      .select('*')
      .eq('id', courseId)
      .maybeSingle();

    console.log('--- 1. COURSE DB RECORD ---');
    console.log(JSON.stringify(course, null, 2));

    if (course) {
      // 2. Department / Category Record
      const deptId = course.category_id || course.department_id;
      if (deptId) {
        const { data: dept } = await supabase.from('categories').select('*').eq('id', deptId).maybeSingle();
        console.log('\n--- DEPARTMENT DB RECORD ---');
        console.log(JSON.stringify(dept, null, 2));
      }
    }

    // 3. Course Versions
    const { data: versions } = await supabase.from('course_versions').select('*').eq('course_id', courseId);
    console.log('\n--- 2. COURSE VERSION DB RECORDS ---');
    console.log(JSON.stringify(versions, null, 2));

    // 4. Modules
    const { data: modules } = await supabase.from('modules').select('*').eq('course_id', courseId);
    console.log('\n--- 3. MODULE DB RECORDS (Relational) ---');
    console.log(JSON.stringify(modules, null, 2));

    // 5. Lessons & Topics
    const { data: lessons } = await supabase.from('lessons').select('*');
    console.log('\n--- 4. LESSON DB RECORDS ---');
    console.log(JSON.stringify(lessons || [], null, 2));

    // 6. Pricing Records
    const { data: pricing } = await supabase.from('course_pricing').select('*').eq('course_id', courseId);
    console.log('\n--- 5. PRICING DB RECORDS ---');
    console.log(JSON.stringify(pricing, null, 2));

    // 7. Installment Phases
    const { data: phases } = await supabase.from('installments').select('*');
    console.log('\n--- 6. INSTALLMENT PHASES DB RECORDS ---');
    console.log(JSON.stringify(phases || [], null, 2));

  } catch (err) {
    console.error('Inspection failed:', err);
  } finally {
    process.exit(0);
  }
}

inspectCourseDb();
