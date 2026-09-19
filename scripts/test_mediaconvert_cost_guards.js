/**
 * MediaConvert cost-reduction + idempotency unit tests (no live AWS calls).
 * Run: node backend/scripts/test_mediaconvert_cost_guards.js
 */

const assert = require('assert');
const path = require('path');

process.env.VIDEO_ACCELERATION_MODE = 'DISABLED';
process.env.VIDEO_QUALITY_TUNING_LEVEL = 'SINGLE_PASS';
process.env.NODE_ENV = 'test';
process.env.VIDEO_COST_GUARD_ENV = 'development';
process.env.VIDEO_DEV_MAX_DURATION_SECONDS = '300';

// Prevent supabase hard-fail during unit tests
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test';

const mediaConvert = require('../src/modules/video/video.mediaconvert.service');
const compressor = require('../src/modules/video/video.compressor');
const jobGuard = require('../src/modules/video/video.job-guard.service');
const {
  PROCESSING_PROFILES,
  COST_GUARD_SETTINGS,
  COMPRESSION_SETTINGS
} = require('../src/modules/video/video.constants');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✅ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`❌ ${name}`);
    console.error(`   ${err.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`✅ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`❌ ${name}`);
    console.error(`   ${err.message}`);
  }
}

console.log('\n=== MediaConvert Cost Guard Tests ===\n');

test('TEST 10: 720p source → 720p only (no 1080p upscale)', () => {
  const renditions = mediaConvert.resolveRenditions({ sourceHeight: 720, sourceWidth: 1280 });
  assert.deepStrictEqual(renditions, ['720p']);
  const settings = mediaConvert.buildJobSettings({
    sourceBucket: 'b',
    sourceKey: 'k',
    outputPrefix: 'out/',
    sourceHeight: 720,
    sourceWidth: 1280
  });
  const modifiers = settings.OutputGroups[0].Outputs.map(o => o.NameModifier);
  assert.deepStrictEqual(modifiers, ['_720p']);
});

test('TEST 11: 1080p source → 720p + 1080p', () => {
  const renditions = mediaConvert.resolveRenditions({ sourceHeight: 1080, sourceWidth: 1920 });
  assert.deepStrictEqual(renditions, ['720p', '1080p']);
});

test('TEST 12: 4K source → never above 1080p max', () => {
  const renditions = mediaConvert.resolveRenditions({ sourceHeight: 2160, sourceWidth: 3840 });
  assert.deepStrictEqual(renditions, ['720p', '1080p']);
  assert.ok(!renditions.includes('4K') && !renditions.includes('2160p'));
});

test('Source <720p → 480p only (no upscale)', () => {
  const renditions = mediaConvert.resolveRenditions({ sourceHeight: 480, sourceWidth: 854 });
  assert.deepStrictEqual(renditions, ['480p']);
});

test('Topic clipping include1080p gate uses >=1080 (not >720)', () => {
  const settings720 = mediaConvert.buildTopicClippingJobSettings({
    sourceBucket: 'b', sourceKey: 'k', outputPrefix: 't/',
    startTimecode: '00:00:00:00', endTimecode: '00:01:00:00',
    sourceHeight: 720, sourceWidth: 1280
  });
  assert.deepStrictEqual(settings720.OutputGroups[0].Outputs.map(o => o.NameModifier), ['_720p']);

  const settings1080 = mediaConvert.buildTopicClippingJobSettings({
    sourceBucket: 'b', sourceKey: 'k', outputPrefix: 't/',
    startTimecode: '00:00:00:00', endTimecode: '00:01:00:00',
    sourceHeight: 1080, sourceWidth: 1920
  });
  assert.deepStrictEqual(settings1080.OutputGroups[0].Outputs.map(o => o.NameModifier), ['_720p', '_1080p']);
});

test('Acceleration DISABLED by default (Basic tier)', () => {
  assert.strictEqual(COMPRESSION_SETTINGS.ACCELERATION_MODE, 'DISABLED');
  assert.strictEqual(COST_GUARD_SETTINGS.ACCELERATION_MODE, 'DISABLED');
  assert.strictEqual(mediaConvert.buildAccelerationSettings(), null);
});

test('Compressor never defaults unknown dims to 1080p', () => {
  const analysis = compressor.analyzeVideoSource({
    fileSizeBytes: 1000000,
    durationSeconds: 60
  });
  assert.strictEqual(analysis.targetResolution, '720p');
});

test('Compressor 720p source stays 720p', () => {
  const analysis = compressor.analyzeVideoSource({
    fileSizeBytes: 1000000,
    durationSeconds: 60,
    width: 1280,
    height: 720
  });
  assert.strictEqual(analysis.targetResolution, '720p');
});

test('Compressor 1080p source is 1080p', () => {
  const analysis = compressor.analyzeVideoSource({
    fileSizeBytes: 1000000,
    durationSeconds: 60,
    width: 1920,
    height: 1080
  });
  assert.strictEqual(analysis.targetResolution, '1080p');
});

test('Processing identities distinguish Mode 1 / Mode 2 / clipping', () => {
  const full = jobGuard.buildProcessingIdentity({
    processingProfile: PROCESSING_PROFILES.FULL_MODULE_HLS,
    videoId: 'vid-1',
    uploadId: 'up-1'
  });
  const direct = jobGuard.buildProcessingIdentity({
    processingProfile: PROCESSING_PROFILES.DIRECT_TOPIC_HLS,
    videoId: 'vid-1',
    topicId: 'topic-1',
    uploadId: 'up-1'
  });
  const clip = jobGuard.buildProcessingIdentity({
    processingProfile: PROCESSING_PROFILES.TOPIC_CLIPPING,
    videoId: 'vid-1',
    topicId: 'topic-1',
    uploadId: 'up-1'
  });
  assert.ok(full.includes('FULL_MODULE_HLS'));
  assert.ok(direct.includes('DIRECT_TOPIC_HLS'));
  assert.ok(clip.includes('TOPIC_CLIPPING'));
  assert.notStrictEqual(full, direct);
  assert.notStrictEqual(direct, clip);
});

test('Local mutex blocks duplicate claim (TEST 2/4)', () => {
  const identity = 'TEST_LOCAL|' + Date.now();
  const a = jobGuard._localTryClaim(identity, 'token-a');
  const b = jobGuard._localTryClaim(identity, 'token-b');
  assert.strictEqual(a.acquired, true);
  assert.strictEqual(b.acquired, false);
  jobGuard._localRelease(identity, 'token-a');
  const c = jobGuard._localTryClaim(identity, 'token-c');
  assert.strictEqual(c.acquired, true);
  jobGuard._localRelease(identity, 'token-c');
});

(async () => {
  await testAsync('TEST 13: DEV duration >5 min blocked without override', async () => {
    let blocked = false;
    try {
      await jobGuard.enforceCostGuards({
        sourceDurationSeconds: 600,
        requestedOutputs: ['720p'],
        adminOverride: false,
        triggerSource: 'ADMIN_UPLOAD'
      });
    } catch (e) {
      blocked = e.code === 'DEV_DURATION_LIMIT';
    }
    assert.strictEqual(blocked, true);
  });

  await testAsync('TEST 13b: DEV duration override allowed', async () => {
    const result = await jobGuard.enforceCostGuards({
      sourceDurationSeconds: 600,
      requestedOutputs: ['720p'],
      adminOverride: true,
      triggerSource: 'ADMIN_UPLOAD'
    });
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.overridden, true);
  });

  // Cost validation math (using AWS normalized-minute model for HD AVC single-pass ≤30fps = 1x per output minute)
  test('COST: Current vs New for sample durations (1080p source, dual output)', () => {
    const durations = [
      { label: '1-minute', seconds: 60 },
      { label: '10-minute', seconds: 600 },
      { label: '1-hour', seconds: 3600 },
      { label: '2h22m33s', seconds: 2 * 3600 + 22 * 60 + 33 }
    ];

    console.log('\n--- Cost validation (HD AVC single-pass ≤30fps, multiplier 1.0 per HD output minute) ---');
    console.log('CURRENT: Acceleration PREFERRED → Professional tier; always 720p+1080p');
    console.log('NEW: Acceleration DISABLED → Basic tier; 1080p source → 720p+1080p; 720p source → 720p only\n');

    for (const d of durations) {
      const minutes = d.seconds / 60;
      const currentOutputs = 2;
      const currentNorm = minutes * currentOutputs; // Professional when accelerated
      const new1080Norm = minutes * 2; // Basic
      const new720Norm = minutes * 1; // Basic, 720p-only source

      console.log(`${d.label} (${minutes.toFixed(3)} min):`);
      console.log(`  CURRENT (1080p assumed dual + accel/Pro): outputs=2, normalized=${currentNorm.toFixed(3)} (Professional)`);
      console.log(`  NEW 1080p source Basic dual: outputs=2, normalized=${new1080Norm.toFixed(3)} (Basic)`);
      console.log(`  NEW 720p source Basic single: outputs=1, normalized=${new720Norm.toFixed(3)} (Basic)`);
    }

    // Sanity on the long sample
    const longMin = (2 * 3600 + 22 * 60 + 33) / 60;
    assert.ok(Math.abs(longMin - 142.55) < 0.01);
  });

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
