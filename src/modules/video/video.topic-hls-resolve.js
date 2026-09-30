const s3VideoService = require('./video.s3.service');
const s3PathUtils = require('../../utils/s3PathUtils');
const cloudFrontVideoService = require('./video.cloudfront.service');

const finishedMasterCache = new Map();
const CACHE_MS = 5 * 60 * 1000;

function hlsUrlNamesTopic(url, topicId) {
  const topic = String(topicId || '').trim().toLowerCase();
  if (!url || !topic) return false;
  try {
    const path = new URL(url).pathname;
    const match = path.match(/\/topics\/([^/]+)\//i);
    return Boolean(match && match[1].toLowerCase() === topic);
  } catch (e) {
    return false;
  }
}

function publicMasterUrl(key) {
  const domain = String(cloudFrontVideoService.domain || '').replace(/\/$/, '');
  if (!domain || !key) return '';
  const origin = domain.startsWith('http') ? domain : `https://${domain}`;
  return `${origin}/${String(key).replace(/^\/+/, '')}`;
}

/**
 * A topic encode can finish in S3 while the curriculum row is still PROCESSING
 * and has no playlist URL. Confirm only this topic's own asset.
 */
async function findFinishedTopicMaster({ courseSlug, module, moduleIndex, topicId, assetId }) {
  const topic = String(topicId || '').trim();
  const asset = String(assetId || '').trim();
  const slug = String(courseSlug || '').trim();
  if (!slug || !topic || !asset || !module) return null;

  const cacheKey = `${slug}:${topic}:${asset}`;
  const cached = finishedMasterCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;

  const moduleSlug = s3PathUtils.generateS3ModuleSlug(module, moduleIndex || 1);
  const key = s3PathUtils.buildS3TopicMasterKey(slug, moduleSlug, asset, topic);
  if (!key.includes(`/topics/${topic}/`)) return null;

  let value = null;
  try {
    const head = await s3VideoService.verifyObjectExists(s3VideoService.outputBucket, key);
    if (head?.exists) {
      const hlsMasterUrl = publicMasterUrl(key);
      if (hlsMasterUrl && hlsUrlNamesTopic(hlsMasterUrl, topic)) {
        value = {
          hlsMasterUrl,
          hlsPrefix: key.replace(/master\.m3u8$/, '')
        };
      }
    }
  } catch (e) {
    value = null;
  }

  finishedMasterCache.set(cacheKey, { value, at: Date.now() });
  return value;
}

const IN_PROGRESS = new Set(['PROCESSING', 'QUEUED', 'ENCODING', 'TRANSCODING', 'UPLOADING', 'READY']);

async function recoverFinishedTopicMasters(course, jsonModules, sortModuleFn) {
  const found = new Map();
  const sorted = [...(jsonModules || [])].sort(sortModuleFn);
  for (let idx = 0; idx < sorted.length; idx += 1) {
    const moduleRow = sorted[idx];
    const topics = Array.isArray(moduleRow?.topics) ? moduleRow.topics : [];
    for (const topic of topics) {
      if (!topic || typeof topic !== 'object' || !topic.id) continue;
      const existing = topic.hls_master_url || topic.video_url || '';
      if (hlsUrlNamesTopic(existing, topic.id)) continue;
      const assetId = topic.video_asset_id || topic.source_video_id;
      const status = String(topic.processing_status || topic.video_status || '').toUpperCase();
      if (!assetId || !IN_PROGRESS.has(status)) continue;
      const hit = await findFinishedTopicMaster({
        courseSlug: course?.slug,
        module: moduleRow,
        moduleIndex: idx + 1,
        topicId: topic.id,
        assetId
      });
      if (hit?.hlsMasterUrl) found.set(String(topic.id), hit);
    }
  }
  return found;
}

module.exports = {
  hlsUrlNamesTopic,
  findFinishedTopicMaster,
  recoverFinishedTopicMasters
};
