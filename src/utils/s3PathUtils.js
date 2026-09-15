/**
 * S3 Path and Slug Generation Utilities for Video Pipeline
 * Produces clean, safe, human-readable S3 storage keys without altering database UUIDs.
 *
 * Example:
 * Course: "Cyber Security & Ethical Hacking"
 * Module: "Module 1: Cyber Security Fundamentals" (index 0)
 * File: "Cyber_Security_Lesson_1.mp4"
 *
 * Source: courses/cyber-security-ethical-hacking/modules/01-cyber-security-fundamentals/source/cyber-security-fundamentals.mp4
 * HLS Output: courses/cyber-security-ethical-hacking/modules/01-cyber-security-fundamentals/hls/
 */

const { generateSlug } = require('./slug');

/**
 * Generates a safe S3 course slug
 * @param {Object|string} course - Course object (with title, slug, id) or course name string
 * @returns {string} Clean course slug (e.g. 'cyber-security-cloud-computing')
 */
function generateS3CourseSlug(course) {
  if (!course) return 'course';
  
  if (typeof course === 'string') {
    const clean = generateSlug(course);
    return clean || 'course';
  }

  // If course has an explicit slug or title
  const rawTitle = course.slug || course.title || course.name || 'course';
  const clean = generateSlug(rawTitle);
  return clean || 'course';
}

/**
 * Generates a safe S3 module folder slug with 2-digit index prefix
 * @param {Object|string} module - Module object or module title
 * @param {number} [index=1] - 1-based or 0-based module index
 * @returns {string} e.g. '01-cyber-security-fundamentals'
 */
function generateS3ModuleSlug(module, index = 1) {
  let rawTitle = '';
  let modNum = index;

  if (typeof module === 'string') {
    rawTitle = module;
  } else if (module && typeof module === 'object') {
    rawTitle = module.title || module.name || '';
    if (module.id && !isNaN(Number(module.id))) {
      modNum = Number(module.id);
    }
  }

  // Extract leading module number if present in title (e.g. "Module 1: Intro" -> 1)
  const numMatch = rawTitle.match(/module\s*(\d+)[:\s-]*/i);
  if (numMatch) {
    modNum = parseInt(numMatch[1], 10);
    rawTitle = rawTitle.replace(/module\s*\d+[:\s-]*/i, '').trim();
  }

  const paddedNum = String(Math.max(1, modNum || 1)).padStart(2, '0');
  const slugifiedTitle = generateSlug(rawTitle) || 'module';
  
  // Clean up if slug already starts with numeric prefix
  const cleanTitle = slugifiedTitle.replace(/^\d+-/, '');

  return `${paddedNum}-${cleanTitle || 'module'}`;
}

/**
 * Sanitizes video filename, stripping path traversal and unsafe characters
 * @param {string} fileName - Original uploaded filename
 * @param {string} [fallbackPrefix='video']
 * @returns {string} Safe filename (e.g. 'cyber-security-fundamentals.mp4')
 */
function sanitizeS3FileName(fileName, fallbackPrefix = 'video') {
  if (!fileName || typeof fileName !== 'string') {
    return `${fallbackPrefix}_${Date.now()}.mp4`;
  }

  // Strip path traversal sequences (../ or ..\ or absolute paths)
  const baseName = fileName.replace(/^.*[\\/]/, '');
  const lastDot = baseName.lastIndexOf('.');
  const ext = lastDot !== -1 ? baseName.substring(lastDot + 1).toLowerCase() : 'mp4';
  const nameWithoutExt = lastDot !== -1 ? baseName.substring(0, lastDot) : baseName;

  const safeName = generateSlug(nameWithoutExt) || fallbackPrefix;
  const safeExt = ext.replace(/[^a-z0-9]/g, '') || 'mp4';

  return `${safeName}.${safeExt}`;
}

/**
 * Builds the full S3 source object key
 * Supports both isolated structure: courses/{courseSlug}/modules/{moduleSlug}/videos/{videoId}/source/{filename}
 * and backward-compatible legacy structure: courses/{courseSlug}/modules/{moduleSlug}/source/{filename}
 */
function buildS3SourceKey(courseSlug, moduleSlug, videoIdOrFileName, optionalFileName) {
  let videoId = null;
  let rawFileName = videoIdOrFileName;

  if (optionalFileName) {
    videoId = String(videoIdOrFileName).trim();
    rawFileName = optionalFileName;
  }

  const cleanFileName = sanitizeS3FileName(rawFileName);

  if (videoId) {
    return `courses/${courseSlug}/modules/${moduleSlug}/videos/${videoId}/source/${cleanFileName}`;
  }
  return `courses/${courseSlug}/modules/${moduleSlug}/source/${cleanFileName}`;
}

function buildS3HlsPrefix(courseSlug, moduleSlug, optionalVideoId) {
  if (optionalVideoId) {
    const cleanVideoId = String(optionalVideoId).trim();
    return `courses/${courseSlug}/modules/${moduleSlug}/videos/${cleanVideoId}/hls/`;
  }
  return `courses/${courseSlug}/modules/${moduleSlug}/hls/`;
}

/**
 * Builds the S3 HLS prefix for individual Topic MediaConvert outputs
 * Structure: courses/{courseSlug}/modules/{moduleSlug}/videos/{sourceVideoId}/topics/{topicId}/hls/
 */
function buildS3TopicHlsPrefix(courseSlug, moduleSlug, sourceVideoId, topicId) {
  const cleanSourceId = String(sourceVideoId).trim();
  const cleanTopicId = String(topicId).trim();
  return `courses/${courseSlug}/modules/${moduleSlug}/videos/${cleanSourceId}/topics/${cleanTopicId}/hls/`;
}

/**
 * Builds the S3 master playlist key for a topic
 */
function buildS3TopicMasterKey(courseSlug, moduleSlug, sourceVideoId, topicId) {
  const prefix = buildS3TopicHlsPrefix(courseSlug, moduleSlug, sourceVideoId, topicId);
  return `${prefix}master.m3u8`;
}

/**
 * Extracts CloudFront resource prefix from an HLS master playlist URL
 * Supports isolated videoId paths, slug structures, and legacy paths
 * @param {string} masterUrl - Master m3u8 URL or S3 key
 * @returns {string} e.g. "courses/cyber-security/modules/01-fundamentals/videos/uuid-123/hls/"
 */
function extractResourcePrefixFromUrl(masterUrl) {
  if (!masterUrl || typeof masterUrl !== 'string') return '';
  try {
    const urlObj = new URL(masterUrl.startsWith('http') ? masterUrl : `https://dummy.com/${masterUrl}`);
    const pathname = urlObj.pathname.replace(/^\//, ''); // remove leading slash
    const masterIdx = pathname.lastIndexOf('master.m3u8');
    if (masterIdx !== -1) {
      return pathname.substring(0, masterIdx);
    }
    const hlsIdx = pathname.lastIndexOf('/hls/');
    if (hlsIdx !== -1) {
      return pathname.substring(0, hlsIdx + 5);
    }
    const lastSlash = pathname.lastIndexOf('/');
    if (lastSlash !== -1) {
      return pathname.substring(0, lastSlash + 1);
    }
    return pathname;
  } catch {
    return masterUrl.replace(/master\.m3u8.*$/, '');
  }
}

/**
 * Builds the S3 source key for direct individual topic uploads
 * Structure: courses/{courseSlug}/modules/{moduleSlug}/videos/{videoAssetId}/topics/{topicId}/source/{cleanFileName}
 */
function buildS3TopicSourceKey(courseSlug, moduleSlug, videoAssetId, topicId, rawFileName) {
  const cleanVideoId = String(videoAssetId).trim();
  const cleanTopicId = String(topicId).trim();
  const cleanFileName = sanitizeS3FileName(rawFileName);
  return `courses/${courseSlug}/modules/${moduleSlug}/videos/${cleanVideoId}/topics/${cleanTopicId}/source/${cleanFileName}`;
}

module.exports = {
  generateS3CourseSlug,
  generateS3ModuleSlug,
  sanitizeS3FileName,
  buildS3SourceKey,
  buildS3HlsPrefix,
  buildS3TopicSourceKey,
  buildS3TopicHlsPrefix,
  buildS3TopicMasterKey,
  extractResourcePrefixFromUrl
};



