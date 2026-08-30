const axios = require('axios');
const { getStudentEnrollments } = require('../src/modules/enrollments/studentEnrollment.controller');

async function runVerification() {
  console.log('====================================================');
  console.log('🚀 [VERIFICATION] Student Enrollment Data Flow Tests');
  console.log('====================================================');

  const testCases = [
    {
      name: 'Case A: Student enrolled ONLY in Finance',
      email: 'pranaya313@gmail.com',
      expectedCourse: 'Finance',
      forbiddenCourse: 'AI + Machine Learning'
    },
    {
      name: 'Case B: Student enrolled ONLY in Business Analytics (Shiva)',
      email: 'singirikondashivacharan008@gmail.com',
      expectedCourse: 'Business Analytics',
      forbiddenCourse: 'AI + Machine Learning'
    },
    {
      name: 'Case B2: Student enrolled ONLY in Business Analytics (Manvitha)',
      email: 'manvithakrishna8@gmail.com',
      expectedCourse: 'Business Analytics',
      forbiddenCourse: 'AI + Machine Learning'
    },
    {
      name: 'Case C: Student enrolled in AI/ML',
      email: 'venulucky27853@gmail.com',
      expectedCourse: 'AI + ML',
      forbiddenCourse: null
    },
    {
      name: 'Case D: Student with multiple enrollments (Full Stack + AI/ML)',
      email: 'venugoud0001@gmail.com',
      expectedCourses: ['Full Stack Development', 'AI + ML'],
      forbiddenCourse: null
    }
  ];

  let allPassed = true;

  for (const tc of testCases) {
    console.log(`\n▶ Testing ${tc.name} (${tc.email})...`);

    const req = { query: { email: tc.email }, headers: {} };
    let responseData = null;
    const res = {
      status: (code) => ({
        json: (data) => { responseData = { code, data }; }
      })
    };

    await getStudentEnrollments(req, res);

    if (responseData.code !== 200) {
      console.error(`❌ FAILED: Received HTTP ${responseData.code}`);
      allPassed = false;
      continue;
    }

    const enrollments = responseData.data?.data || [];
    console.log(`   Enrollments returned (${enrollments.length}):`);
    enrollments.forEach(e => {
      console.log(`   • ID: ${e.id} | Name: "${e.name}" | Slug: "${e.slug}" | Fee: ₹${e.totalFee} | Pending: ₹${e.amountPending}`);
    });

    // Validations
    if (tc.expectedCourse) {
      const found = enrollments.some(e => e.name.toLowerCase() === tc.expectedCourse.toLowerCase() || e.title.toLowerCase() === tc.expectedCourse.toLowerCase());
      if (!found) {
        console.error(`❌ FAILED: Expected course "${tc.expectedCourse}" not found in results!`);
        allPassed = false;
      } else {
        console.log(`   ✓ Found expected course: "${tc.expectedCourse}"`);
      }
    }

    if (tc.expectedCourses) {
      for (const exp of tc.expectedCourses) {
        const found = enrollments.some(e => e.name.toLowerCase() === exp.toLowerCase() || e.title.toLowerCase() === exp.toLowerCase());
        if (!found) {
          console.error(`❌ FAILED: Expected course "${exp}" not found in multi-enrollment results!`);
          allPassed = false;
        } else {
          console.log(`   ✓ Found expected multi-enrollment course: "${exp}"`);
        }
      }
    }

    if (tc.forbiddenCourse) {
      const hasForbidden = enrollments.some(e => 
        e.name.toLowerCase().includes('machine learning') || 
        e.name.toLowerCase() === 'ai + ml' || 
        e.name.toLowerCase() === 'ai & machine learning'
      );
      if (hasForbidden) {
        console.error(`❌ FAILED: Forbidden course "${tc.forbiddenCourse}" was incorrectly returned!`);
        allPassed = false;
      } else {
        console.log(`   ✓ Verified: No bogus "${tc.forbiddenCourse}" present`);
      }
    }
  }

  // Case E: Test live HTTP endpoint via express server if running
  console.log('\n▶ Testing Live HTTP Endpoint: http://localhost:5000/api/student/enrollments...');
  try {
    const httpRes = await axios.get('http://localhost:5000/api/student/enrollments?email=singirikondashivacharan008@gmail.com', {
      timeout: 3000
    });
    if (httpRes.status === 200 && httpRes.data?.data?.[0]?.name === 'Business Analytics') {
      console.log('   ✓ Live HTTP Endpoint responding correctly with Business Analytics!');
    } else {
      console.warn('   ⚠️ HTTP response data unexpected:', httpRes.data);
    }
  } catch (err) {
    console.log('   (Note: Backend server port 5000 checked:', err.message, ')');
  }

  console.log('\n====================================================');
  if (allPassed) {
    console.log('🎉 ALL 5 ENROLLMENT VERIFICATION TEST CASES PASSED CLEANLY!');
  } else {
    console.error('❌ SOME TEST CASES FAILED. Review logs above.');
    process.exit(1);
  }
  console.log('====================================================\n');
}

runVerification().catch(console.error);
