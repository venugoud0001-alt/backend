const { supabase } = require('../src/config/supabase');

async function testIndex() {
  const testCourseId = '343f3dc3-355e-4a8a-999a-1247f8f7e37e';

  // Test inserting a row with is_active = false
  const { data, error } = await supabase
    .from('course_pricing')
    .insert({
      course_id: testCourseId,
      currency: 'INR',
      sale_price: 12000,
      original_price: 36000,
      installment_1_price: 6000,
      installment_2_price: 6000,
      is_active: false
    })
    .select();

  console.log("INSERT INACTIVE ROW RESULT:");
  console.log("Data:", data);
  console.log("Error:", error);

  if (data && data[0]) {
    // clean up
    await supabase.from('course_pricing').delete().eq('id', data[0].id);
  }

  process.exit(0);
}

testIndex();
