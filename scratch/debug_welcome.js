const couponService = require('../src/modules/coupons/coupon.service');
const { supabase } = require('../src/config/supabase');

async function debugWelcome() {
  console.log("Checking DB for WELCOME:");
  const dbRes = await supabase.from('coupons').select('*').eq('code', 'WELCOME');
  console.log("DB result:", dbRes.data);

  console.log("Checking couponService.getCouponByCode('WELCOME'):");
  const srvRes = await couponService.getCouponByCode('WELCOME');
  console.log("Service result:", srvRes);
}

debugWelcome();
