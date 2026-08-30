const { supabase } = require('../src/config/supabase');
const courseService = require('../src/modules/courses/course.service');
const departmentService = require('../src/modules/departments/department.service');

async function inspectDbAndApis() {
  console.log("=== INSPECTING DATABASE & BACKEND APIS FOR PROGRAMS PAGE ===\n");

  // 1. Inspect Departments in DB
  const { data: dbDepts } = await supabase
    .from('departments')
    .select('id, name, slug, display_order, status');

  console.log("1. DEPARTMENTS IN DATABASE:", JSON.stringify(dbDepts, null, 2));

  // 2. Inspect Courses in DB
  const { data: dbCourses } = await supabase
    .from('courses')
    .select('id, title, slug, category_id, department_id, status, price, installment_price');

  console.log("\n2. COURSES IN DATABASE:", JSON.stringify(dbCourses, null, 2));

  // 3. Inspect courseService.getCourses() output
  try {
    const serviceCourses = await courseService.getCourses(false);
    console.log("\n3. courseService.getCourses(false) OUTPUT SUMMARY:");
    console.log(serviceCourses.map(c => ({
      id: c.id,
      title: c.title,
      slug: c.slug,
      department_id: c.department_id,
      status: c.status
    })));
  } catch (err) {
    console.error("Error calling courseService.getCourses:", err);
  }

  // 4. Inspect departmentService.getAllDepartments() output
  try {
    const serviceDepts = await departmentService.getAllDepartments(false);
    console.log("\n4. departmentService.getAllDepartments(false) OUTPUT SUMMARY:");
    console.log(serviceDepts.map(d => ({
      id: d.id,
      name: d.name,
      slug: d.slug,
      status: d.status
    })));
  } catch (err) {
    console.error("Error calling departmentService.getAllDepartments:", err);
  }

  process.exit(0);
}

inspectDbAndApis();
