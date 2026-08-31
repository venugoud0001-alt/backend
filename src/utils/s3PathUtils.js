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
 */
function buildS3SourceKey(courseSlug, moduleSlug, fileName) {
  const cleanFileName = sanitizeS3FileName(fileName);
  return `courses/${courseSlug}/modules/${moduleSlug}/source/${cleanFileName}`;
}

/**
 * Builds the S3 HLS prefix for MediaConvert outputs
 */
function buildS3HlsPrefix(courseSlug, moduleSlug) {
  return `courses/${courseSlug}/modules/${moduleSlug}/hls/`;
}

/**
 * Extracts CloudFront resource prefix from an HLS master playlist URL
 * Supports both new slug structure and legacy UUID paths
 * @param {string} masterUrl - Master m3u8 URL or S3 key
 * @returns {string} e.g. "courses/cyber-security/modules/01-fundamentals/hls/"
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
    const lastSlash = pathname.lastIndexOf('/');
    if (lastSlash !== -1) {
      return pathname.substring(0, lastSlash + 1);
    }
    return pathname;
  } catch {
    return masterUrl.replace(/master\.m3u8.*$/, '');
  }
}

module.exports = {
  generateS3CourseSlug,
  generateS3ModuleSlug,
  sanitizeS3FileName,
  buildS3SourceKey,
  buildS3HlsPrefix,
  extractResourcePrefixFromUrl
};
