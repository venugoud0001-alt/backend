const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const url = process.env.VITE_SUPABASE_URL || 'https://uvetznwcnsezyuxgjoou.supabase.co';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!key) {
  console.error("Missing SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(url, key);

async function syncProfiles() {
  console.log("🔄 [PROFILES SYNC] Starting authoritative enrollment sync for all profiles...");

  // 1. Fetch all students and their real enrollments
  const { data: enrollments, error: eErr } = await supabase
    .from('enrollments')
    .select('student_id, course_name, created_at, students(id, email, full_name)')
    .order('created_at', { ascending: false });

  if (eErr) {
    console.error("Error fetching enrollments:", eErr);
    return;
  }

  console.log(`Found ${enrollments.length} enrollment records.`);

  // Map student email -> Set of actual enrolled courses
  const studentCoursesMap = new Map();

  enrollments.forEach(enr => {
    const email = enr.students?.email?.toLowerCase().trim();
    const course = (enr.course_name || '').trim();
    if (email && course) {
      if (!studentCoursesMap.has(email)) {
        studentCoursesMap.set(email, new Set());
      }
      studentCoursesMap.get(email).add(course);
    }
  });

  console.log(`Mapped ${studentCoursesMap.size} distinct enrolled students.`);

  // 2. Fetch all profiles
  const { data: profiles, error: pErr } = await supabase
    .from('profiles')
    .select('id, email, full_name, role, enrolled_course');

  if (pErr) {
    console.error("Error fetching profiles:", pErr);
    return;
  }

  console.log(`Found ${profiles.length} profile rows.`);

  let updatedCount = 0;

  for (const prof of profiles) {
    const email = prof.email?.toLowerCase().trim();
    if (!email) continue;

    // Check if this student has real enrollments
    if (studentCoursesMap.has(email)) {
      const realCourses = Array.from(studentCoursesMap.get(email)).join(', ');
      if (prof.enrolled_course !== realCourses) {
        console.log(`  Updating ${email}: "${prof.enrolled_course}" -> "${realCourses}"`);
        await supabase
          .from('profiles')
          .update({ enrolled_course: realCourses })
          .eq('id', prof.id);
        updatedCount++;
      }
    } else {
      // Not enrolled in any course - if profile has default "AI & Machine Learning" or "AI + ML", clear it
      const current = (prof.enrolled_course || '').trim().toLowerCase();
      if (current === 'ai & machine learning' || current === 'ai + ml') {
        console.log(`  Clearing stale default for ${email}: "${prof.enrolled_course}" -> ""`);
        await supabase
          .from('profiles')
          .update({ enrolled_course: '' })
          .eq('id', prof.id);
        updatedCount++;
      }
    }
  }

  console.log(`✅ [PROFILES SYNC] Complete! Updated ${updatedCount} profile records.`);
}

syncProfiles().catch(console.error);
