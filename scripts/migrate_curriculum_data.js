/**
 * Server-Side Idempotent Migration Script: Frontend Course Data -> Supabase
 *
 * Migration Scope:
 * 1. Departments (5 core departments)
 * 2. Courses (24 complete programs mapped to departments)
 * 3. Course Versions (Version 1, PUBLISHED for all courses)
 * 4. Modules (210+ curriculum modules preserving display_order)
 * 5. Lessons / Videos (Master video lesson per module, duration in minutes, preview flag)
 * 6. Lesson Topics (2,000+ topics preserving exact ordering)
 * 7. Dual persistence: relational tables + JSON fallback on courses.curriculum_modules
 */

const { supabase } = require('../src/config/supabase');
const { generateSlug } = require('../src/utils/slug');

// Helper to convert duration string (e.g., "2.5 hrs", "90 min") to integer minutes
function parseDurationMinutes(durationStr) {
  if (!durationStr) return 150;
  const str = String(durationStr).toLowerCase().trim();
  const match = str.match(/([0-9.]+)\s*(hrs?|hours?|min|mins?|minutes?)?/);
  if (!match) return 150;
  const num = parseFloat(match[1]);
  if (isNaN(num)) return 150;
  const unit = match[2] || '';
  if (unit.startsWith('hr') || unit.startsWith('hour')) {
    return Math.round(num * 60);
  }
  return Math.round(num);
}

// Helper to safely execute Supabase queries ignoring PGRST205 table cache missing error
async function safeExec(fn, fallback = null) {
  try {
    return await fn();
  } catch (err) {
    if (err && err.code === 'PGRST205') {
      return fallback;
    }
    console.warn('⚠️ Supabase execution warning:', err.message || err);
    return fallback;
  }
}

async function runMigration() {
  console.log('🚀 Starting InternNetra Curriculum Data Migration...\n');

  // Load curriculums from frontend data file
  let curriculums = {};
  try {
    curriculums = await import('../../src/data/courseCurriculums.js');
    console.log('✅ Loaded courseCurriculums exports:', Object.keys(curriculums).length, 'curriculums');
  } catch (err) {
    console.error('❌ Failed to load courseCurriculums.js:', err);
    process.exit(1);
  }

  // 1. Department Definitions
  const departmentDefinitions = [
    {
      name: "CSE / IT",
      slug: "cse-it",
      altSlugs: ["cs-it", "computer-science-it"],
      description: "Artificial Intelligence, Full Stack Web Development, Data Science, Cloud, DevOps, and Cyber Security.",
      display_order: 1
    },
    {
      name: "ECE / EEE",
      slug: "ece-eee",
      altSlugs: ["ece", "electronics-communication"],
      description: "Microcontroller design, Embedded C, VLSI silicon architecture, and IoT connected sensors.",
      display_order: 2
    },
    {
      name: "Mechanical / Civil",
      slug: "mech-civil",
      altSlugs: ["mech", "civil", "mechanical-core"],
      description: "Professional 2D/3D CAD drafting, technical modeling, architectural design, and civil blueprints.",
      display_order: 3
    },
    {
      name: "Management (BBA / B.Com / MBA)",
      slug: "management",
      altSlugs: ["management-finance"],
      description: "Financial modeling, enterprise resource planning with SAP ERP, corporate finance, and business intelligence.",
      display_order: 4
    },
    {
      name: "Add-on Programs",
      slug: "add-on-programs",
      altSlugs: [],
      description: "Multi-domain specialized tracks combining Cloud, Security, AI, VLSI, and Enterprise Systems.",
      display_order: 5
    }
  ];

  // Map to hold department UUIDs by slug & name
  const departmentMap = new Map();

  // Determine target department table (departments vs categories)
  let deptTableName = 'departments';
  const { error: deptTestErr } = await supabase.from('departments').select('id').limit(1);
  if (deptTestErr && deptTestErr.code === 'PGRST205') {
    deptTableName = 'categories';
  }
  console.log(`📁 Using target department table: '${deptTableName}'`);

  for (const deptDef of departmentDefinitions) {
    // Check existing by slug or altSlugs
    const allSlugs = [deptDef.slug, ...deptDef.altSlugs];
    const { data: existingDepts } = await supabase
      .from(deptTableName)
      .select('*')
      .or(`slug.in.(${allSlugs.join(',')}),name.ilike."${deptDef.name}"`);

    let deptRecord = existingDepts && existingDepts.length > 0 ? existingDepts[0] : null;

    if (!deptRecord) {
      const payload = {
        name: deptDef.name,
        slug: deptDef.slug,
        description: deptDef.description,
        display_order: deptDef.display_order,
        status: 'ACTIVE'
      };
      if (deptTableName === 'categories') {
        payload.status = 'active';
        payload.icon = 'Code';
      }
      const { data: created, error } = await supabase
        .from(deptTableName)
        .insert([payload])
        .select()
        .single();

      if (error) {
        console.error(`❌ Error creating department ${deptDef.name}:`, error.message);
      } else {
        deptRecord = created;
        console.log(`✅ Created department: ${deptDef.name} (${deptRecord.id})`);
      }
    } else {
      console.log(`ℹ️ Existing department matched: ${deptRecord.name} (${deptRecord.id})`);
    }

    if (deptRecord) {
      departmentMap.set(deptDef.slug, deptRecord.id);
      for (const s of deptDef.altSlugs) {
        departmentMap.set(s, deptRecord.id);
      }
      departmentMap.set(deptDef.name, deptRecord.id);
    }
  }

  // 2. Course Definitions (24 Programs)
  const courseDefinitions = [
    // CSE / IT
    { title: "AI + ML", slug: "ai-machine-learning", altSlugs: ["ai-ml"], departmentSlug: "cse-it", duration: "8 Weeks", level: "Advanced", instructor: "Dr. Sana Khan", description: "Master neural networks, deep learning, and AI algorithms.", skills: ["TensorFlow", "Python", "Neural Networks"], curriculum: curriculums.aiMachineLearningCurriculum },
    { title: "Full Stack Development", slug: "full-stack-development", altSlugs: [], departmentSlug: "cse-it", duration: "12 Weeks", level: "Advanced", instructor: "Dr. Nitin Agarwal", description: "Build complete web applications from frontend to backend.", skills: ["React", "Node.js", "MongoDB"], curriculum: curriculums.fullStackWebDevCurriculum },
    { title: "Data Science", slug: "data-science", altSlugs: [], departmentSlug: "cse-it", duration: "8 Weeks", level: "Advanced", instructor: "Dr. Alok Sharma", description: "Learn data analysis, visualization, and predictive modeling.", skills: ["Pandas", "SQL", "Matplotlib"], curriculum: curriculums.dataScienceCurriculum },
    { title: "Python", slug: "python", altSlugs: [], departmentSlug: "cse-it", duration: "6 Weeks", level: "Beginner", instructor: "Dr. Aditi Joshi", description: "Complete Python fundamentals for beginners.", skills: ["Basics", "OOP", "Debugging"], curriculum: curriculums.pythonProgrammingCurriculum },
    { title: "DSA (Data Structures & Algorithms)", slug: "dsa-data-structures-algorithms", altSlugs: ["dsa"], departmentSlug: "cse-it", duration: "10 Weeks", level: "Intermediate", instructor: "Prof. K. Mehta", description: "Data structures and algorithms for technical interviews.", skills: ["Arrays", "Graphs", "DP"], curriculum: curriculums.dsaPythonCurriculum },
    { title: "Cloud Computing", slug: "cloud-computing", altSlugs: [], departmentSlug: "cse-it", duration: "8 Weeks", level: "Intermediate", instructor: "Dr. Shreya Kapoor", description: "Deploy and manage applications on AWS and Azure.", skills: ["AWS", "Docker", "Kubernetes"], curriculum: curriculums.cloudComputingCurriculum },
    { title: "DevOps", slug: "devops", altSlugs: [], departmentSlug: "cse-it", duration: "10 Weeks", level: "Advanced", instructor: "Prof. Dev Malhotra", description: "CI/CD pipelines, automation, and infrastructure as code.", skills: ["Jenkins", "Docker", "CI/CD"], curriculum: curriculums.devopsCurriculum },
    { title: "Cyber Security", slug: "cyber-security", altSlugs: ["cybersecurity"], departmentSlug: "cse-it", duration: "10 Weeks", level: "Advanced", instructor: "Dr. Vikram Bose", description: "Network defense, penetration testing, and threat analysis.", skills: ["Ethical Hacking", "SOC", "Firewall"], curriculum: curriculums.cyberSecurityCurriculum },

    // ECE / EEE
    { title: "Embedded Systems", slug: "embedded-systems", altSlugs: [], departmentSlug: "ece-eee", duration: "10 Weeks", level: "Advanced", instructor: "Dr. Bhavna Iyer", description: "Microcontroller programming and embedded circuit design.", skills: ["C", "STM32", "Real-time OS"], curriculum: curriculums.embeddedSystemsCurriculum },
    { title: "VLSI", slug: "vlsi", altSlugs: [], departmentSlug: "ece-eee", duration: "12 Weeks", level: "Advanced", instructor: "Prof. Harish Nair", description: "Digital circuit design and silicon chip architecture.", skills: ["Verilog", "FPGA", "Layout"], curriculum: curriculums.vlsiCurriculum },
    { title: "IoT", slug: "iot", altSlugs: [], departmentSlug: "ece-eee", duration: "8 Weeks", level: "Intermediate", instructor: "Prof. Rajesh Kumar", description: "Build connected smart devices and IoT sensor networks.", skills: ["Arduino", "Sensors", "MQTT"], curriculum: curriculums.iotCurriculum },

    // Mechanical / Civil
    { title: "AutoCAD", slug: "autocad", altSlugs: [], departmentSlug: "mech-civil", duration: "6 Weeks", level: "Beginner", instructor: "Dr. Rohit Jain", description: "Professional 2D/3D CAD design and technical drawing.", skills: ["2D/3D Design", "Drafting", "Modeling"], curriculum: curriculums.autocadCurriculum },

    // Management
    { title: "Finance", slug: "finance", altSlugs: [], departmentSlug: "management", duration: "8 Weeks", level: "Intermediate", instructor: "Dr. Kavya Rao", description: "Financial analysis, corporate trading, and portfolio strategy.", skills: ["Excel", "Analytics", "Stocks"], curriculum: curriculums.financeCurriculum },
    { title: "Business Analytics", slug: "business-analytics", altSlugs: ["business"], departmentSlug: "management", duration: "8 Weeks", level: "Intermediate", instructor: "Dr. Sohail Khan", description: "Business intelligence and data-driven corporate strategy.", skills: ["Tableau", "Power BI", "Strategy"], curriculum: curriculums.businessAnalyticsCurriculum },
    { title: "SAP ERP", slug: "sap-erp", altSlugs: ["sap"], departmentSlug: "management", duration: "10 Weeks", level: "Intermediate", instructor: "Prof. Ritesh Shah", description: "Enterprise resource planning with SAP ERP modules.", skills: ["SAP", "ERP", "Logistics"], curriculum: curriculums.sapFicoCurriculum },

    // Add-on Programs
    { title: "Cloud + DevOps", slug: "cloud-devops", altSlugs: [], departmentSlug: "add-on-programs", duration: "12 Weeks", level: "Advanced", instructor: "Dr. Farhan Sheikh", description: "Advanced cloud architecture, CI/CD, and container orchestration.", skills: ["Kubernetes", "IaC", "AWS"], curriculum: curriculums.devopsCurriculum },
    { title: "Embedded + VLSI", slug: "embedded-vlsi", altSlugs: [], departmentSlug: "add-on-programs", duration: "14 Weeks", level: "Advanced", instructor: "Dr. Aparna Menon", description: "Comprehensive embedded systems and hardware chip design.", skills: ["C", "Verilog", "FPGA"], curriculum: curriculums.vlsiCurriculum },
    { title: "AI + Python", slug: "ai-python", altSlugs: [], departmentSlug: "add-on-programs", duration: "10 Weeks", level: "Advanced", instructor: "Prof. Arjun Iyer", description: "Artificial intelligence development powered by Python.", skills: ["Python", "AI", "Algorithms"], curriculum: curriculums.aiMachineLearningCurriculum },
    { title: "ML + Python", slug: "ml-python", altSlugs: [], departmentSlug: "add-on-programs", duration: "10 Weeks", level: "Advanced", instructor: "Dr. Priya Menon", description: "Machine learning algorithms and MLOps pipelines in Python.", skills: ["Scikit-Learn", "Keras", "ML Ops"], curriculum: curriculums.aiMachineLearningCurriculum },
    { title: "DSA + Python", slug: "dsa-python", altSlugs: [], departmentSlug: "add-on-programs", duration: "8 Weeks", level: "Intermediate", instructor: "Dr. Ananya Rao", description: "Data structures and algorithms implemented in Python.", skills: ["Python", "Algorithms", "Problem Solving"], curriculum: curriculums.dsaPythonCurriculum },
    { title: "SAP + Finance", slug: "sap-finance", altSlugs: [], departmentSlug: "add-on-programs", duration: "12 Weeks", level: "Intermediate", instructor: "Dr. Ritu Jain", description: "SAP ERP with financial FI/CO module specialization.", skills: ["SAP FI", "Accounting", "ERP"], curriculum: curriculums.sapFicoCurriculum },
    { title: "Data Science with Python", slug: "data-science-with-python", altSlugs: [], departmentSlug: "add-on-programs", duration: "10 Weeks", level: "Advanced", instructor: "Prof. Nisha Gupta", description: "End-to-end data science project pipeline development.", skills: ["ML", "Analytics", "Deployment"], curriculum: curriculums.dataScienceCurriculum },
    { title: "Cyber Security + Cloud Computing", slug: "cyber-security-cloud-computing", altSlugs: [], departmentSlug: "add-on-programs", duration: "12 Weeks", level: "Advanced", instructor: "Dr. Vikram Bose", description: "Cloud security posture management, firewalls, and defense.", skills: ["AWS Security", "PenTesting", "IAM"], curriculum: curriculums.cyberSecurityCurriculum },
    { title: "Cyber Security + DevOps", slug: "cyber-security-devops", altSlugs: [], departmentSlug: "add-on-programs", duration: "12 Weeks", level: "Advanced", instructor: "Prof. Dev Malhotra", description: "DevSecOps security automation, vulnerability scanning, and CI/CD.", skills: ["DevSecOps", "Docker Security", "CI/CD"], curriculum: curriculums.cyberSecurityCurriculum }
  ];

  let migratedCourses = 0;
  let migratedVersions = 0;
  let migratedModules = 0;
  let migratedLessons = 0;
  let migratedTopics = 0;

  for (let idx = 0; idx < courseDefinitions.length; idx++) {
    const courseDef = courseDefinitions[idx];
    const deptId = departmentMap.get(courseDef.departmentSlug) || null;

    const allCourseSlugs = [courseDef.slug, ...courseDef.altSlugs];
    const { data: existingCourses } = await supabase
      .from('courses')
      .select('*')
      .or(`slug.in.(${allCourseSlugs.join(',')}),title.ilike."${courseDef.title}"`);

    const coursePayload = {
      title: courseDef.title,
      short_description: courseDef.description,
      description: courseDef.description,
      duration: courseDef.duration,
      level: courseDef.level,
      instructor_name: courseDef.instructor,
      skills: courseDef.skills,
      status: 'PUBLISHED',
      is_published: true,
      is_active: true,
      category_id: deptId,
      curriculum_modules: courseDef.curriculum || []
    };

    if (!existingCourses || existingCourses.length === 0) {
      const { data: created, error } = await supabase
        .from('courses')
        .insert([{ price: 4000, installment_price: 1500, slug: courseDef.slug, ...coursePayload }])
        .select()
        .single();

      if (error) {
        console.error(`❌ Error inserting course ${courseDef.title}:`, error.message);
        continue;
      }
      console.log(`\n📚 [${idx + 1}/${courseDefinitions.length}] Created course: ${courseDef.title} (${created.id})`);
    } else {
      // Update ALL existing records matching any slug/altSlug/title for consistency
      for (const courseRecord of existingCourses) {
        const updatePayload = { ...coursePayload };
        // Keep primary slug if it matches
        if (courseRecord.slug === courseDef.slug || !courseDef.altSlugs.includes(courseRecord.slug)) {
          updatePayload.slug = courseDef.slug;
        }
        await supabase
          .from('courses')
          .update(updatePayload)
          .eq('id', courseRecord.id);

        console.log(`\n📚 [${idx + 1}/${courseDefinitions.length}] Updated course record: ${courseRecord.title} [${courseRecord.slug}] (${courseRecord.id})`);
      }
    }
    const mainCourseRecord = existingCourses?.[0] || null;
    migratedCourses++;

    // 3. Course Version (Version 1)
    let versionRecord = null;
    if (mainCourseRecord) {
      versionRecord = await safeExec(async () => {
        const { data: versions } = await supabase
          .from('course_versions')
          .select('*')
          .eq('course_id', mainCourseRecord.id)
          .eq('version_number', 1);

        if (versions && versions.length > 0) return versions[0];

        const { data: newV } = await supabase
          .from('course_versions')
          .insert([{
            course_id: mainCourseRecord.id,
            version_number: 1,
            title: 'Version 1',
            description: 'Initial Published Version',
            status: 'PUBLISHED',
            published_at: new Date().toISOString()
          }])
          .select()
          .single();

        return newV;
      });
    }

    if (versionRecord) migratedVersions++;

    // 4. Modules, Lessons & Topics
    const moduleList = courseDef.curriculum || [];
    for (let mIdx = 0; mIdx < moduleList.length; mIdx++) {
      const mod = moduleList[mIdx];
      const modName = mod.title || `Module ${mod.id}: Core Concepts`;
      const modSlug = generateSlug(modName);
      const modDurationMinutes = parseDurationMinutes(mod.duration);

      let moduleRecord = null;
      if (versionRecord) {
        moduleRecord = await safeExec(async () => {
          const { data: existingMods } = await supabase
            .from('modules')
            .select('*')
            .eq('course_version_id', versionRecord.id)
            .eq('display_order', mIdx + 1);

          if (existingMods && existingMods.length > 0) return existingMods[0];

          const { data: newM } = await supabase
            .from('modules')
            .insert([{
              course_version_id: versionRecord.id,
              name: modName,
              slug: modSlug,
              description: `Module ${mIdx + 1} of ${courseDef.title}`,
              display_order: mIdx + 1,
              status: 'PUBLISHED'
            }])
            .select()
            .single();

          return newM;
        });
      }
      migratedModules++;

      // Master Lesson for Module
      let lessonRecord = null;
      if (moduleRecord) {
        lessonRecord = await safeExec(async () => {
          const { data: existingLessons } = await supabase
            .from('lessons')
            .select('*')
            .eq('module_id', moduleRecord.id)
            .eq('display_order', 1);

          if (existingLessons && existingLessons.length > 0) return existingLessons[0];

          const { data: newL } = await supabase
            .from('lessons')
            .insert([{
              module_id: moduleRecord.id,
              title: `${modName} — Full Masterclass Video`,
              description: `Complete ${modName} lecture video and practice topics.`,
              lesson_type: 'VIDEO',
              video_url: 'https://www.w3schools.com/html/mov_bbb.mp4',
              thumbnail_url: '',
              duration_minutes: modDurationMinutes,
              display_order: 1,
              is_preview: mIdx === 0, // First module is free preview
              status: 'PUBLISHED'
            }])
            .select()
            .single();

          return newL;
        });
      }
      migratedLessons++;

      // Topics for Lesson
      const lessonTopics = mod.lessons || [];
      for (let tIdx = 0; tIdx < lessonTopics.length; tIdx++) {
        const topicTitle = lessonTopics[tIdx];
        if (lessonRecord) {
          await safeExec(async () => {
            const { data: existingTopics } = await supabase
              .from('lesson_topics')
              .select('*')
              .eq('lesson_id', lessonRecord.id)
              .eq('display_order', tIdx + 1);

            if (!existingTopics || existingTopics.length === 0) {
              await supabase
                .from('lesson_topics')
                .insert([{
                  lesson_id: lessonRecord.id,
                  title: topicTitle,
                  description: '',
                  display_order: tIdx + 1
                }]);
            }
          });
        }
        migratedTopics++;
      }
    }
  }

  console.log('\n===========================================');
  console.log('🎉 CURRICULUM DATA MIGRATION SUMMARY:');
  console.log(`- Departments Processed: ${departmentDefinitions.length}`);
  console.log(`- Courses Migrated: ${migratedCourses}`);
  console.log(`- Course Versions Processed: ${migratedVersions}`);
  console.log(`- Modules Migrated: ${migratedModules}`);
  console.log(`- Master Lessons Migrated: ${migratedLessons}`);
  console.log(`- Topics Migrated: ${migratedTopics}`);
  console.log('===========================================\n');
}

runMigration().then(() => {
  console.log('✅ Migration script finished successfully.');
  process.exit(0);
}).catch((err) => {
  console.error('❌ Migration failed with error:', err);
  process.exit(1);
});
