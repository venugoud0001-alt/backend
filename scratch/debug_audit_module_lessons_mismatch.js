const { supabase } = require('../src/config/supabase');

async function auditModuleLessonsMismatch() {
  console.log("=================================================");
  console.log("  AUDITING CURRICULUM MODULES & LESSONS IN DB");
  console.log("=================================================");

  const { data: courses, error } = await supabase.from('courses').select('id, title, slug, curriculum_modules');
  if (error) {
    console.error("Failed to query courses:", error);
    return;
  }

  console.log(`Found ${courses.length} courses in database.\n`);

  for (const c of courses) {
    if (!Array.isArray(c.curriculum_modules) || c.curriculum_modules.length === 0) {
      continue;
    }

    console.log(`Course: "${c.title}" (ID: ${c.id}, Slug: ${c.slug})`);
    console.log(`Curriculum Module Count: ${c.curriculum_modules.length}`);

    c.curriculum_modules.forEach((mod, idx) => {
      const lessons = Array.isArray(mod.lessons) ? mod.lessons : [];
      const videos = Array.isArray(mod.videos) ? mod.videos : [];
      console.log(`  [Module ${idx + 1}] ID: "${mod.id || 'UNDEFINED'}", Title: "${mod.title || mod.name}", Lessons Count: ${lessons.length}, Videos Count: ${videos.length}`);
      if (lessons.length > 0) {
        lessons.forEach((l, lIdx) => {
          console.log(`    -> Lesson ${lIdx + 1}: ID: "${l.id}", Title: "${l.title || l.name}"`);
        });
      }
    });
    console.log("-------------------------------------------------");
  }
}

auditModuleLessonsMismatch();
