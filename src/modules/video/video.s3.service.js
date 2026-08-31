/**
 * AWS S3 Storage Service for Video Pipeline (100% Production AWS SDK)
 * Handles presigned direct-to-S3 upload URLs, object verification, and source deletion.
 */

const { S3Client, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const env = require('../../config/env');

class S3VideoService {
  constructor() {
    this.region = env.AWS_REGION || 'ap-south-1';
    this.sourceBucket = env.AWS_S3_BUCKET_SOURCE || 'internnetra-lms-videos-prod-365957110532-ap-south-1-an';
    this.outputBucket = env.AWS_S3_BUCKET_OUTPUT || 'internnetra-lms-videos-prod-365957110532-ap-south-1-an';

    if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
      console.warn('⚠️ [AWS S3 Video] AWS_ACCESS_KEY_ID or AWS_SECRET_ACCESS_KEY is not defined.');
    }

    this.s3Client = new S3Client({
      region: this.region,
      credentials: {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY
      }
    });
  }

  /**
   * Generates a pre-signed URL for direct browser-to-S3 upload
   * Supports human-readable slug keys or legacy ID paths
   */
  async generatePresignedUploadUrl({ s3Key, courseSlug, moduleSlug, courseId, moduleId, lessonId, fileName, contentType }) {
    let finalKey = s3Key;
    if (!finalKey) {
      if (courseSlug && moduleSlug) {
        const { buildS3SourceKey } = require('../../utils/s3PathUtils');
        finalKey = buildS3SourceKey(courseSlug, moduleSlug, fileName || 'video.mp4');
      } else {
        const ext = (fileName || 'video.mp4').split('.').pop() || 'mp4';
        const cleanFileName = `source_${Date.now()}.${ext}`;
        finalKey = `courses/${courseId || 'general'}/modules/${moduleId || 'general'}/lessons/${lessonId || '1'}/${cleanFileName}`;
      }
    }

    const command = new PutObjectCommand({
      Bucket: this.sourceBucket,
      Key: finalKey,
      ContentType: contentType || 'video/mp4'
    });

    // 60-minute expiration for direct upload
    const uploadUrl = await getSignedUrl(this.s3Client, command, { expiresIn: 3600 });
    return {
      uploadUrl,
      s3Bucket: this.sourceBucket,
      s3Key: finalKey,
      expiresInSeconds: 3600
    };
  }

  /**
   * Verifies that the uploaded file exists in the S3 source bucket
   */
  async verifyObjectExists(bucket, key) {
    try {
      const command = new HeadObjectCommand({
        Bucket: bucket || this.sourceBucket,
        Key: key
      });
      const response = await this.s3Client.send(command);
      return {
        exists: true,
        contentLength: response.ContentLength,
        contentType: response.ContentType,
        lastModified: response.LastModified
      };
    } catch (err) {
      if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
        return { exists: false };
      }
      throw err;
    }
  }

  /**
   * Permanently deletes the temporary raw source video from S3 ingest bucket
   */
  async deleteSourceVideo(bucket, key) {
    const targetBucket = bucket || this.sourceBucket;
    try {
      const command = new DeleteObjectCommand({
        Bucket: targetBucket,
        Key: key
      });
      await this.s3Client.send(command);
      console.log(`✅ [AWS S3] Successfully purged temporary source file: s3://${targetBucket}/${key}`);
      return { deleted: true };
    } catch (err) {
      console.error(`⚠️ [AWS S3 Delete Error] Could not purge source s3://${targetBucket}/${key}:`, err.message);
      return { deleted: false, error: err.message };
    }
  }
}

module.exports = new S3VideoService();
