const axios = require('axios');
const { supabase } = require('../src/config/supabase');

const targetCourseId = 'af753d70-d782-49a6-9c0b-0db0db54733a'; // 'AI + Machine Learning'

async function auditCoursePricing() {
  console.log(`=== AUDITING PRICING FOR COURSE: ${targetCourseId} ===\n`);

  // 1. Query Supabase 'courses' table for this ID
  console.log("--- 1. Supabase 'courses' table record ---");
  const { data: courseRow, error: courseErr } = await supabase
    .from('courses')
    .select('*')
    .eq('id', targetCourseId)
    .single();

  if (courseErr) {
    console.error("Error querying 'courses' table:", courseErr.message);
  } else {
    console.log("Course DB Row:", JSON.stringify(courseRow, null, 2));
  }

  // 2. Query Supabase 'course_pricing' table for this ID
  console.log("\n--- 2. Supabase 'course_pricing' table records ---");
  const { data: pricingRows, error: pricingErr } = await supabase
    .from('course_pricing')
    .select('*')
    .eq('course_id', targetCourseId);

  if (pricingErr) {
    console.error("Error querying 'course_pricing' table:", pricingErr.message);
  } else {
    console.log(`Found ${pricingRows ? pricingRows.length : 0} rows in 'course_pricing' table:`);
    console.log(JSON.stringify(pricingRows, null, 2));
  }

  // 3. Call GET /api/courses/:id/pricing API endpoint directly
  console.log("\n--- 3. Backend Pricing API Endpoint response ---");
  try {
    const res = await axios.get(`http://localhost:5000/api/courses/${targetCourseId}/pricing`);
    console.log("API Status:", res.status);
    console.log("API Payload:", JSON.stringify(res.data, null, 2));
  } catch (err) {
    console.error("API Call Failed:", err.response?.status, err.response?.data || err.message);
  }
}

auditCoursePricing();
