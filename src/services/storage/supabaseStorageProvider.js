const path = require('path');
const { supabase } = require('../../config/supabase');
const env = require('../../config/env');

class SupabaseStorageProvider {
  constructor(bucketName = env.SUPABASE_STORAGE_BUCKET || 'course-assets') {
    this.bucketName = bucketName;
  }

  /**
   * Upload file strictly to Supabase Storage (public course-assets bucket)
   * Permanent cloud storage that never expires or wipes on server restarts
   */
  async upload(fileBuffer, storageKey, mimeType = 'image/webp') {
    if (!fileBuffer || !Buffer.isBuffer(fileBuffer)) {
      throw new Error('Supabase Storage: Valid fileBuffer is required for upload.');
    }
    const cleanStorageKey = String(storageKey || '').replace(/^\/+/, '');
    if (!cleanStorageKey) {
      throw new Error('Supabase Storage: Storage key must not be empty.');
    }

    const { data, error } = await supabase.storage
      .from(this.bucketName)
      .upload(cleanStorageKey, fileBuffer, {
        contentType: mimeType,
        upsert: true
      });

    if (error) {
      console.error(`[SupabaseStorageProvider] Upload failed to bucket '${this.bucketName}':`, error.message);
      throw new Error(`Supabase Storage upload error (${this.bucketName}): ${error.message}`);
    }

    const publicUrl = this.getUrl(data.path || cleanStorageKey);

    return {
      storage_provider: 'SUPABASE',
      storage_key: data.path || cleanStorageKey,
      video_url: publicUrl,
      imageUrl: publicUrl,
      publicUrl: publicUrl
    };
  }

  /**
   * Get public URL for storage key
   */
  getUrl(storageKey) {
    if (!storageKey) return '';
    if (storageKey.startsWith('http://') || storageKey.startsWith('https://')) {
      return storageKey;
    }
    const cleanKey = storageKey.replace(/^\/+/, '');
    const { data } = supabase.storage.from(this.bucketName).getPublicUrl(cleanKey);
    return data?.publicUrl || '';
  }

  /**
   * Get signed URL for private content
   */
  async getSignedUrl(storageKey, expiresInSeconds = 3600) {
    if (!storageKey) return '';
    const { data, error } = await supabase.storage
      .from(this.bucketName)
      .createSignedUrl(storageKey, expiresInSeconds);

    if (error) throw error;
    return data?.signedUrl || '';
  }

  /**
   * Delete file from storage
   */
  async delete(storageKey) {
    if (!storageKey) return true;
    const { error } = await supabase.storage
      .from(this.bucketName)
      .remove([storageKey]);

    if (error) throw error;
    return true;
  }
}

module.exports = SupabaseStorageProvider;
