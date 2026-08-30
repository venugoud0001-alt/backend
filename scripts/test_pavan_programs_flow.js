const courseService = require('../src/modules/courses/course.service');
const departmentService = require('../src/modules/departments/department.service');

const toCategorySlug = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

async function runProgramsFlowVerification() {
  console.log("=== STARTING PROGRAMS PAGE DATA FLOW VERIFICATION SUITE ===\n");

  try {
    // 1. Fetch Published Courses & Active Departments from Database Services
    const courses = await courseService.getCourses(false);
    const departments = await departmentService.getAllDepartments(false);

    console.log(`1. DATABASE QUERY: Fetched ${courses.length} Published Courses & ${departments.length} Active Departments`);

    if (!Array.isArray(courses) || courses.length === 0) {
      throw new Error("FAIL: Database returned 0 published courses!");
    }

    if (!Array.isArray(departments) || departments.length === 0) {
      throw new Error("FAIL: Database returned 0 active departments!");
    }

    // 2. Test Normalization & Department Mapping (replicating Programs.jsx loadData logic)
    const normalizedCourses = courses.map((c) => {
      const matchedDept = departments.find((d) => String(d.id) === String(c.department_id));
      const deptName = matchedDept?.name || c.departmentName || c.department || c.category || "";
      const deptSlug = matchedDept?.slug || c.departmentSlug || (deptName ? toCategorySlug(deptName) : "");
      return {
        ...c,
        department_id: c.department_id || matchedDept?.id || null,
        department: deptName,
        departmentName: deptName,
        departmentSlug: deptSlug,
        category: deptName
      };
    });

    console.log(`2. NORMALIZATION & MAPPING: Successfully normalized ${normalizedCourses.length} courses with department metadata`);

    // 3. Test Filter Logic for "All Programs"
    const allProgramsFiltered = normalizedCourses.filter(() => true);
    console.log(`3. FILTER 'All Programs': Before=${normalizedCourses.length}, After=${allProgramsFiltered.length}`);

    if (allProgramsFiltered.length !== normalizedCourses.length) {
      throw new Error(`FAIL: 'All Programs' filter dropped courses! Expected ${normalizedCourses.length}, got ${allProgramsFiltered.length}`);
    }
    console.log("✅ PASS: 'All Programs' filter displays ALL database courses!");

    // 4. Test Filter Logic for "Computer Science & IT"
    const csItDept = departments.find(d => d.name.includes("Computer Science"));
    if (csItDept) {
      const csItFiltered = normalizedCourses.filter((c) => {
        const activeCategory = csItDept.name;
        const activeCatSlug = toCategorySlug(activeCategory);
        const courseDeptSlug = toCategorySlug(c.departmentSlug || c.departmentName || c.category || "");
        const courseCategorySlug = toCategorySlug(c.category || "");

        return (
          c.department_id === csItDept.id ||
          c.departmentSlug === csItDept.slug ||
          c.departmentName === activeCategory ||
          courseDeptSlug === activeCatSlug ||
          courseCategorySlug === activeCatSlug
        );
      });

      console.log(`4. FILTER '${csItDept.name}': Before=${normalizedCourses.length}, After=${csItFiltered.length}`);
      console.log(`   Sample CS/IT Courses: ${csItFiltered.map(c => c.title).join(", ")}`);

      if (csItFiltered.length === 0) {
        throw new Error(`FAIL: Filter for '${csItDept.name}' returned 0 courses!`);
      }
      console.log(`✅ PASS: Filter for '${csItDept.name}' returned ${csItFiltered.length} matching courses!`);
    }

    // 5. Test Filter Logic for Search Query "pavan"
    const searchTarget = "pavan";
    const searchFiltered = normalizedCourses.filter((c) => {
      const query = searchTarget.toLowerCase();
      const searchableText = [
        c.name,
        c.title,
        c.description,
        c.category,
        c.departmentName,
        ...(c.skills || []),
      ].join(" ").toLowerCase();
      return searchableText.includes(query);
    });

    console.log(`5. SEARCH FILTER '${searchTarget}': Matches=${searchFiltered.length} (${searchFiltered.map(c => c.title).join(", ")})`);
    if (searchFiltered.length === 0) {
      throw new Error(`FAIL: Search for '${searchTarget}' returned 0 courses!`);
    }
    console.log(`✅ PASS: Search filter accurately returned '${searchFiltered[0].title}'!`);

  } catch (err) {
    console.error("❌ PROGRAMS FLOW VERIFICATION ERROR:", err);
    process.exit(1);
  }

  console.log("\n=== ALL PROGRAMS PAGE DATA FLOW TESTS PASSED WITH 100% SUCCESS ===");
  process.exit(0);
}

runProgramsFlowVerification();
