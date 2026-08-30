const axios = require('axios');

async function testGetCourse() {
  try {
    const res = await axios.get('http://localhost:5000/api/courses/9577facc-ed47-4f09-842b-9b4132e3c974');
    console.log("STATUS:", res.status);
    console.log("COURSE API RESPONSE:", JSON.stringify(res.data, null, 2));
  } catch (err) {
    console.error("ERROR:", err.response?.data || err.message);
  }
}

testGetCourse();
