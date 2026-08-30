const { supabase } = require('../src/config/supabase');

async function inspectColumns() {
  const { data, error } = await supabase.from('coupons').select('*').limit(1);
  if (error) {
    console.error("Error inspecting coupons:", error);
    return;
  }
  if (data && data.length > 0) {
    console.log("Coupons table column keys:", Object.keys(data[0]));
    console.log("Sample row:", data[0]);
  } else {
    console.log("Coupons table is empty.");
  }
}

inspectColumns();
