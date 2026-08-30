const { supabase } = require('../src/config/supabase');
const pricingService = require('../src/modules/pricing/pricing.service');

async function setPriceCourse15k() {
  const courseId = '9577facc-ed47-4f09-842b-9b4132e3c974';

  console.log("Updating course record in DB...");
  await supabase.from('courses').update({
    price: 15000,
    installment_price: 6000
  }).eq('id', courseId);

  console.log("Updating course_pricing record in DB...");
  await pricingService.saveCoursePricing({
    course_id: courseId,
    full_payment_amount: 15000,
    installment_total_amount: 15000,
    currency: 'INR',
    phases: [
      { phase_number: 1, name: '1st Installment', amount: 6000 },
      { phase_number: 2, name: '2nd Installment', amount: 9000 }
    ]
  });

  console.log("✓ Updated 'price course' to Full: 15000, Installment: 15000 [P1: 6000, P2: 9000]");
}

setPriceCourse15k();
