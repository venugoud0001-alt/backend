const { supabase } = require('../src/config/supabase');

async function inspectDbImages() {
  console.log("=== INSPECTING DATABASE STORED IMAGE VALUES ===\n");

  const { data: courses } = await supabase.from('courses').select('id, title, slug, image_url, thumbnail_url');
  console.log("1. COURSES TABLE IMAGES (sample):");
  (courses || []).slice(0, 10).forEach(c => {
    console.log(` - [${c.title}]: image_url="${c.image_url}", thumbnail_url="${c.thumbnail_url}"`);
  });

  const { data: depts } = await supabase.from('departments').select('id, name, slug, image_url, banner_url');
  console.log("\n2. DEPARTMENTS TABLE IMAGES:");
  (depts || []).forEach(d => {
    console.log(` - [${d.name}]: image_url="${d.image_url}", banner_url="${d.banner_url}"`);
  });

  process.exit(0);
}

inspectDbImages();
