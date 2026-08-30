const { supabase } = require('../src/config/supabase');

async function testColumns() {
  const courseId = '9577facc-ed47-4f09-842b-9b4132e3c974';

  const { data, error } = await supabase
    .from('courses')
    .update({
      price: 15000,
      installment_price: null
    })
    .eq('id', courseId)
    .select();

  console.log("UPDATE COURSES WITH NULL INSTALLMENT PRICE RESULT:");
  console.log("Data:", data);
  console.log("Error:", error);

  process.exit(0);
}

testColumns();
