/**
 * Slug Generation Utility
 * Converts text string into a URL-safe slug.
 *
 * Example:
 * "Full Stack Web Development!" -> "full-stack-web-development"
 */

function generateSlug(text) {
  if (!text || typeof text !== 'string') {
    return '';
  }

  return text
    .toString()
    .toLowerCase()
    .trim()
    // Replace accented characters
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    // Replace non-alphanumeric characters (excluding spaces and hyphens) with space
    .replace(/[^a-z0-9\s-]/g, '')
    // Replace spaces and multiple hyphens with a single hyphen
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    // Trim leading and trailing hyphens
    .replace(/^-+|-+$/g, '');
}

/**
 * Validates whether a given string is already a valid slug format
 */
function isValidSlug(slug) {
  if (!slug || typeof slug !== 'string') return false;
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
}

module.exports = {
  generateSlug,
  isValidSlug
};
