const fs = require('fs');
const path = require('path');
const { supabase } = require('../../config/supabase');

const saveLocalFile = (storageKey, fileBuffer) => {
  try {
    const cleanKey = storageKey.replace(/^uploads\//, '');
    const targetPath = path.join(__dirname, '../../../uploads', cleanKey);
    const targetDir = path.dirname(targetPath);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    fs.writeFileSync(targetPath, fileBuffer);
  } catch (e) {
    console.error("Local file save error:", e.message);
  }
};

class SupabaseStorageProvider {
  constructor(bucketName = 'course-content') {
    this.bucketName = bucketName;
  }

  /**
   * Upload file to Supabase Storage with graceful local fallback
   */
  async upload(fileBuffer, storageKey, mimeType = 'video/mp4') {
    try {
      const { data, error } = await supabase.storage
        .from(this.bucketName)
        .upload(storageKey, fileBuffer, {
          contentType: mimeType,
          upsert: true
        });

      if (error) {
        if (error.message && error.message.includes('Bucket not found')) {
          saveLocalFile(storageKey, fileBuffer);
          const cleanKey = storageKey.replace(/^uploads\//, '');
          return {
            storage_provider: 'LOCAL',
            storage_key: storageKey,
            video_url: `/uploads/${cleanKey}`
          };
        }
        throw new Error(`Supabase Storage upload error: ${error.message}`);
      }

      return {
        storage_provider: 'SUPABASE',
        storage_key: data.path,
        video_url: this.getUrl(data.path)
      };
    } catch (err) {
      if (err.message && err.message.includes('Bucket not found')) {
        saveLocalFile(storageKey, fileBuffer);
        const cleanKey = storageKey.replace(/^uploads\//, '');
        return {
          storage_provider: 'LOCAL',
          storage_key: storageKey,
          video_url: `/uploads/${cleanKey}`
        };
      }
      throw err;
    }
  }

  /**
   * Get public URL for storage key
   */
  getUrl(storageKey) {
    if (!storageKey) return '';
    if (storageKey.startsWith('http://') || storageKey.startsWith('https://')) {
      return storageKey;
    }
    const { data } = supabase.storage.from(this.bucketName).getPublicUrl(storageKey);
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
