const { supabase } = require('../src/config/supabase');

async function inspectDbImages() {
  console.log("=== INSPECTING DATABASE STORED IMAGE VALUES V2 ===\n");

  const { data: courses, error: cErr } = await supabase.from('courses').select('*');
  console.log(`1. COURSES TABLE (${courses?.length || 0} rows):`);
  if (cErr) console.error("Course query err:", cErr);
  (courses || []).slice(0, 15).forEach(c => {
    console.log(` - [${c.title}]: image_url="${c.image_url}", thumbnail_url="${c.thumbnail_url}"`);
  });

  const { data: depts, error: dErr } = await supabase.from('departments').select('*');
  console.log(`\n2. DEPARTMENTS TABLE (${depts?.length || 0} rows):`);
  if (dErr) console.error("Dept query err:", dErr);
  (depts || []).forEach(d => {
    console.log(` - [${d.name}]: image_url="${d.image_url}", banner_url="${d.banner_url}"`);
  });

  process.exit(0);
}

inspectDbImages();
