const { supabase } = require('../src/config/supabase');

async function testAllColumns() {
  console.log("--- TESTING COLUMNS ONE BY ONE ---");
  const candidates = [
    'description',
    'discount_type',
    'discount_value',
    'discount_amount',
    'status',
    'starts_at',
    'expires_at',
    'usage_limit',
    'used_count',
    'per_user_limit',
    'minimum_course_amount',
    'maximum_discount_amount',
    'applicability',
    'course_id',
    'department_id',
    'updated_at'
  ];

  const validColumns = [];
  const invalidColumns = [];

  for (const col of candidates) {
    let testObj = {
      code: `COL_${col}_${Date.now().toString().slice(-4)}`,
      discount_amount: 10
    };
    if (col !== 'discount_amount') {
      testObj[col] = col.includes('at') ? new Date().toISOString() : (col.includes('limit') || col.includes('count') || col.includes('amount') || col.includes('value') ? 5 : 'TEST');
    }

    const res = await supabase.from('coupons').insert([testObj]).select();
    if (res.error) {
      invalidColumns.push({ col, error: res.error.message });
    } else {
      validColumns.push(col);
      if (res.data && res.data[0]) {
        await supabase.from('coupons').delete().eq('id', res.data[0].id);
      }
    }
  }

  console.log("\n✅ VALID COLUMNS IN SUPABASE 'coupons':", validColumns);
  console.log("\n❌ INVALID/MISSING COLUMNS IN SUPABASE 'coupons':", invalidColumns);
}

testAllColumns();
