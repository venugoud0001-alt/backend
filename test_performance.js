/**
 * InternNetra LMS Performance & Latency Benchmark Script
 * Measures exact latency metrics (Min, Avg, P50, P95, P99, Max) across 100 requests per endpoint.
 */

const http = require('http');
const performance = require('perf_hooks').performance;

const PORT = 5000;
const REQUEST_COUNT = 100;

function measureEndpoint(path) {
  return new Promise((resolve) => {
    const latencies = [];
    let completed = 0;

    for (let i = 0; i < REQUEST_COUNT; i++) {
      const start = performance.now();
      const req = http.request({
        hostname: 'localhost',
        port: PORT,
        path: path,
        method: 'GET'
      }, (res) => {
        res.on('data', () => {});
        res.on('end', () => {
          const end = performance.now();
          latencies.push(end - start);
          completed++;
          if (completed === REQUEST_COUNT) {
            latencies.sort((a, b) => a - b);
            const sum = latencies.reduce((acc, v) => acc + v, 0);
            const avg = sum / latencies.length;
            const p50 = latencies[Math.floor(latencies.length * 0.50)];
            const p95 = latencies[Math.floor(latencies.length * 0.95)];
            const p99 = latencies[Math.floor(latencies.length * 0.99)];
            const min = latencies[0];
            const max = latencies[latencies.length - 1];

            resolve({
              path,
              count: REQUEST_COUNT,
              min: min.toFixed(2),
              avg: avg.toFixed(2),
              p50: p50.toFixed(2),
              p95: p95.toFixed(2),
              p99: p99.toFixed(2),
              max: max.toFixed(2)
            });
          }
        });
      });

      req.on('error', (err) => {
        completed++;
        if (completed === REQUEST_COUNT) resolve({ path, error: err.message });
      });

      req.end();
    }
  });
}

async function runPerformanceBenchmark() {
  console.log(`================== [LMS PERFORMANCE & LATENCY BENCHMARK] ==================`);

  const healthMetrics = await measureEndpoint('/api/health');
  const coursesMetrics = await measureEndpoint('/api/courses');
  const batchesMetrics = await measureEndpoint('/api/batches');

  console.log("\nMEASURED LATENCY RESULTS (ms):");
  console.table([healthMetrics, coursesMetrics, batchesMetrics]);

  process.exit(0);
}

runPerformanceBenchmark();
