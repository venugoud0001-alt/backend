const { supabase } = require('../src/config/supabase');

async function testZeroInstallment() {
  const testCourseId = '9577facc-ed47-4f09-842b-9b4132e3c974';

  const { data, error } = await supabase
    .from('course_pricing')
    .update({
      sale_price: 15000,
      installment_1_price: 0,
      installment_2_price: 0,
      updated_at: new Date().toISOString()
    })
    .eq('course_id', testCourseId)
    .select();

  console.log("UPDATE WITH ZERO INSTALLMENTS RESULT:");
  console.log("Data:", data);
  console.log("Error:", error);

  process.exit(0);
}

testZeroInstallment();
