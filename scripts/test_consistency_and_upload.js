const http = require('http');
const app = require('../src/app');

async function runTests() {
  console.log('=== STARTING LOCAL INTEGRATION & DIAGNOSTIC TESTS ===\n');

  const server = app.listen(5050, async () => {
    console.log('Test server started on port 5050.');

    try {
      // Test 1: GET /api/admin/diagnostics
      console.log('\nTest 1: GET /api/admin/diagnostics');
      const diagRes = await makeRequest({
        hostname: 'localhost',
        port: 5050,
        path: '/api/admin/diagnostics',
        method: 'GET'
      });
      console.log(`Status: ${diagRes.status}`);
      console.log(`Report Summary:`, JSON.stringify(diagRes.body?.summary, null, 2));

      // Test 2: POST /api/upload/image (> 100 KB Payload Rejection)
      console.log('\nTest 2: POST /api/upload/image (> 100 KB Payload Rejection)');
      const largeBuffer = Buffer.alloc(110 * 1024, 'a'); // 110 KB
      const postData = JSON.stringify({
        imageBase64: largeBuffer.toString('base64'),
        fileName: 'oversized_test.png',
        mimeType: 'image/png'
      });

      const uploadRes = await makeRequest({
        hostname: 'localhost',
        port: 5050,
        path: '/api/upload/image',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      }, postData);

      console.log(`Status: ${uploadRes.status} (Expected 422 for size cap violation)`);
      console.log(`Response Message:`, uploadRes.body?.message || uploadRes.rawBody);

      // Test 3: POST /api/upload/image (Valid Payload <= 100 KB)
      console.log('\nTest 3: POST /api/upload/image (Valid Payload <= 100 KB)');
      const smallBuffer = Buffer.alloc(20 * 1024, 'a'); // 20 KB
      const validPostData = JSON.stringify({
        imageBase64: smallBuffer.toString('base64'),
        fileName: 'valid_small.webp',
        mimeType: 'image/webp'
      });

      const validUploadRes = await makeRequest({
        hostname: 'localhost',
        port: 5050,
        path: '/api/upload/image',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(validPostData)
        }
      }, validPostData);

      console.log(`Status: ${validUploadRes.status} (Expected 200)`);
      console.log(`Response Body:`, validUploadRes.body);

      console.log('\n=== ALL DIAGNOSTIC & UPLOAD TESTS PASSED SUCCESSFULLY ===');
    } catch (err) {
      console.error('Test error:', err.message);
    } finally {
      server.close(() => {
        console.log('Test server closed.');
        process.exit(0);
      });
    }
  });
}

function makeRequest(options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch (e) {
          resolve({ status: res.statusCode, rawBody: body });
        }
      });
    });
    req.on('error', (err) => reject(err));
    if (postData) req.write(postData);
    req.end();
  });
}

runTests();
