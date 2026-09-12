/**
 * Strict Identifier Validation & Classification Utility
 * Remediates Finding 8: PostgREST Filter Injection Protection.
 * 
 * Boundary:
 * UNTRUSTED IDENTIFIER -> VALIDATE -> CLASSIFY UUID / SLUG -> USE CORRECT COLUMN -> QUERY
 * Invalid input NEVER reaches Supabase query construction.
 */

// Strict UUID regex: standard 8-4-4-4-12 hex format (accepts standard v1-v5 UUIDs)
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Strict Slug regex: matches all production LMS course slugs (e.g., "ai-ml", "full-stack-web-development")
// Lowercase alphanumeric segments separated by single hyphens
const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Characters strictly forbidden in any identifier (PostgREST injection, SQL injection, operators, delimiters)
const DANGEROUS_CHARS_REGEX = /[\s,'"();<>{}\[\]\\\/%&|`^~*+=:?!@#$]/;

/**
 * Validates if the input is a strictly formed UUID.
 * Rejects whitespace, injection strings, commas, parens, operators.
 *
 * @param {*} value
 * @returns {boolean}
 */
function isUUID(value) {
  if (!value || typeof value !== 'string') return false;
  // Reject leading/trailing whitespace
  if (value.trim() !== value) return false;
  // Reject dangerous injection characters
  if (DANGEROUS_CHARS_REGEX.test(value)) return false;
  return UUID_REGEX.test(value);
}

/**
 * Validates if the input is a strictly formed slug.
 * Matches existing production slugs: lowercase alphanumeric with single hyphens.
 * Rejects whitespace, injection strings, commas, parens, operators, uppercase (unless normalized).
 *
 * @param {*} value
 * @returns {boolean}
 */
function isValidSlug(value) {
  if (!value || typeof value !== 'string') return false;
  if (value.trim() !== value) return false;
  if (value.length < 2 || value.length > 120) return false;
  if (DANGEROUS_CHARS_REGEX.test(value)) return false;
  // Production slugs are lowercase alphanumeric with hyphens
  return SLUG_REGEX.test(value.toLowerCase());
}

/**
 * Classifies an untrusted identifier into UUID, SLUG, or INVALID.
 * Invalid values must NEVER reach the database query layer.
 *
 * @param {*} value
 * @returns {'UUID' | 'SLUG' | 'INVALID'}
 */
function classifyIdentifier(value) {
  if (!value || typeof value !== 'string') return 'INVALID';
  
  // Reject any injection syntax, spaces, operators immediately
  if (DANGEROUS_CHARS_REGEX.test(value)) return 'INVALID';

  if (isUUID(value)) {
    return 'UUID';
  }

  if (isValidSlug(value)) {
    return 'SLUG';
  }

  return 'INVALID';
}

/**
 * Normalizes slug case only if classified as SLUG.
 * Does not modify UUID values.
 *
 * @param {string} value
 * @returns {string}
 */
function normalizeIdentifier(value, type) {
  if (type === 'SLUG') {
    return value.toLowerCase().trim();
  }
  return value.trim();
}

// Strict alphanumeric identifier for lessons, modules, topics, and uploads
// Must be alphanumeric with hyphens or underscores (length 1-128), and contain no dangerous injection characters
const SAFE_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;

function isSafeId(value) {
  if (!value || typeof value !== 'string') return false;
  if (value.trim() !== value) return false;
  if (DANGEROUS_CHARS_REGEX.test(value)) return false;
  return SAFE_ID_REGEX.test(value);
}

module.exports = {
  isUUID,
  isValidSlug,
  isSafeId,
  classifyIdentifier,
  normalizeIdentifier,
  UUID_REGEX,
  SLUG_REGEX
};
