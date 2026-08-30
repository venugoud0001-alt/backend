const { supabase } = require('../src/config/supabase');

async function inspectFeeTestingPricing() {
  const courseId = '343f3dc3-355e-4a8a-999a-1247f8f7e37e';
  console.log(`=== DATABASE INSPECTION FOR 'fee testing' (ID: ${courseId}) ===\n`);

  try {
    // 1. Course Record
    const { data: course, error: courseErr } = await supabase
      .from('courses')
      .select('*')
      .eq('id', courseId)
      .maybeSingle();

    console.log('--- 1. COURSE DB RECORD ---');
    console.log(JSON.stringify(course, null, 2));

    // 2. course_pricing table records
    const { data: coursePricing } = await supabase
      .from('course_pricing')
      .select('*')
      .eq('course_id', courseId);
    console.log('\n--- 2. course_pricing TABLE RECORDS ---');
    console.log(JSON.stringify(coursePricing, null, 2));

    // 3. pricing_plans table records (if V2 table exists)
    const { data: pricingPlans } = await supabase
      .from('pricing_plans')
      .select('*, installments(*)')
      .eq('course_id', courseId);
    console.log('\n--- 3. pricing_plans TABLE RECORDS ---');
    console.log(JSON.stringify(pricingPlans || [], null, 2));

  } catch (err) {
    console.error('Inspection failed:', err);
  } finally {
    process.exit(0);
  }
}

inspectFeeTestingPricing();
