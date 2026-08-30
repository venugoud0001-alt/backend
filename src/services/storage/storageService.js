const env = require('../../config/env');
const SupabaseStorageProvider = require('./supabaseStorageProvider');

class StorageService {
  constructor() {
    this.providerName = (env.STORAGE_PROVIDER || 'SUPABASE').toUpperCase();
    
    if (this.providerName === 'SUPABASE') {
      this.provider = new SupabaseStorageProvider();
    } else {
      // Default fallback to Supabase, structured to plug AWS S3 / CloudFront easily via config
      this.provider = new SupabaseStorageProvider();
    }
  }

  async upload(fileBuffer, storageKey, mimeType) {
    return this.provider.upload(fileBuffer, storageKey, mimeType);
  }

  getUrl(storageKey) {
    return this.provider.getUrl(storageKey);
  }

  async getSignedUrl(storageKey, expiresInSeconds) {
    return this.provider.getSignedUrl(storageKey, expiresInSeconds);
  }

  async delete(storageKey) {
    return this.provider.delete(storageKey);
  }
}

module.exports = new StorageService();
