const { supabase } = require('../src/config/supabase');

async function inspectTables() {
  console.log('--- Inspecting Existing Tables ---');
  
  const tables = [
    'departments', 'categories', 'courses', 'modules', 'lessons',
    'topics', 'lesson_topics', 'pricing_plans', 'course_pricing',
    'installments', 'enrollments', 'orders', 'payments', 'batches', 'students'
  ];

  for (const table of tables) {
    const { data, error } = await supabase.from(table).select('*').limit(1);
    if (error) {
      console.log(`❌ ${table}: ${error.message} (code: ${error.code})`);
    } else {
      console.log(`✅ ${table}: accessible! Count sample: ${data ? data.length : 0}`);
      if (data && data[0]) {
        console.log(`   Columns in ${table}:`, Object.keys(data[0]));
      }
    }
  }
}

inspectTables();
