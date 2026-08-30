/**
 * Storage Service Abstraction Layer
 * Provides uniform interface for storage operations (local / direct URL passthrough / future AWS S3)
 */

class StorageService {
  /**
   * Upload file asset
   * @param {Object} file File object / buffer / url payload
   * @param {string} destinationFolder Category / folder path
   * @returns {Promise<string>} Public URL of uploaded asset
   */
  async upload(file, destinationFolder = 'general') {
    // Current implementation: return file URL or string directly
    if (typeof file === 'string') {
      return file;
    }
    if (file && file.url) {
      return file.url;
    }
    return file?.path || `https://assets.internnetra.com/${destinationFolder}/${Date.now()}_asset`;
  }

  /**
   * Delete asset by URL or Key
   * @param {string} fileUrlOrKey Asset URL or identifier
   * @returns {Promise<boolean>} Success status
   */
  async delete(fileUrlOrKey) {
    if (!fileUrlOrKey) return false;
    console.log(`[StorageService] Simulated deletion of asset: ${fileUrlOrKey}`);
    return true;
  }

  /**
   * Retrieve resolved public access URL
   * @param {string} assetPath Relative path or URL
   * @returns {string} Public URL
   */
  getUrl(assetPath) {
    if (!assetPath) return '';
    if (assetPath.startsWith('http://') || assetPath.startsWith('https://')) {
      return assetPath;
    }
    return `https://assets.internnetra.com/${assetPath.replace(/^\/+/, '')}`;
  }
}

module.exports = new StorageService();
