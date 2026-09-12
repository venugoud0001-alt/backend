const {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  ListMultipartUploadsCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand
} = require('@aws-sdk/client-s3');
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
   * Generates a pre-signed URL for direct browser-to-S3 single PUT upload (< 100 MB)
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
   * Generates a pre-signed GET URL for secure video streaming with byte-range support
   */
  async generatePresignedGetUrl({ s3Bucket, s3Key, expiresInSeconds = 3600 }) {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const command = new GetObjectCommand({
      Bucket: s3Bucket || this.outputBucket,
      Key: s3Key
    });
    return getSignedUrl(this.s3Client, command, { expiresIn: expiresInSeconds });
  }

  /**
   * 1. Initializes an AWS S3 Multipart Upload
   */
  async createMultipartUpload({ s3Key, contentType }) {
    const command = new CreateMultipartUploadCommand({
      Bucket: this.sourceBucket,
      Key: s3Key,
      ContentType: contentType || 'video/mp4'
    });

    const response = await this.s3Client.send(command);
    return {
      uploadId: response.UploadId,
      s3Bucket: this.sourceBucket,
      s3Key
    };
  }

  /**
   * 2. Generates presigned URLs for all upload parts in batch
   */
  async generatePresignedPartUrls({ s3Key, uploadId, totalParts, expiresInSeconds = 3600 }) {
    const partPromises = [];

    for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
      const command = new UploadPartCommand({
        Bucket: this.sourceBucket,
        Key: s3Key,
        UploadId: uploadId,
        PartNumber: partNumber
      });

      partPromises.push(
        getSignedUrl(this.s3Client, command, { expiresIn: expiresInSeconds }).then((uploadUrl) => ({
          partNumber,
          uploadUrl,
          presignedUrl: uploadUrl
        }))
      );
    }

    const parts = await Promise.all(partPromises);
    return parts;
  }

  /**
   * 3. Generates a single presigned part URL (for retry or refreshed token)
   */
  async generateSinglePresignedPartUrl({ s3Key, uploadId, partNumber, expiresInSeconds = 3600 }) {
    const command = new UploadPartCommand({
      Bucket: this.sourceBucket,
      Key: s3Key,
      UploadId: uploadId,
      PartNumber: Number(partNumber)
    });

    const uploadUrl = await getSignedUrl(this.s3Client, command, { expiresIn: expiresInSeconds });
    return {
      partNumber: Number(partNumber),
      uploadUrl,
      presignedUrl: uploadUrl,
      expiresInSeconds
    };
  }

  /**
   * 4. Completes the S3 Multipart Upload after all parts are received
   */
  async completeMultipartUpload({ s3Key, uploadId, parts }) {
    // Ensure parts are sorted in strictly ascending PartNumber order
    const sortedParts = [...parts]
      .map((p) => ({
        PartNumber: Number(p.PartNumber || p.partNumber),
        ETag: String(p.ETag || p.etag).replace(/^"+|"+$/g, '').trim() ? `"${String(p.ETag || p.etag).replace(/^"+|"+$/g, '').trim()}"` : String(p.ETag || p.etag)
      }))
      .sort((a, b) => a.PartNumber - b.PartNumber);

    try {
      const command = new CompleteMultipartUploadCommand({
        Bucket: this.sourceBucket,
        Key: s3Key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: sortedParts
        }
      });

      const response = await this.s3Client.send(command);
      return {
        location: response.Location,
        s3Bucket: response.Bucket || this.sourceBucket,
        s3Key: response.Key || s3Key,
        etag: response.ETag
      };
    } catch (err) {
      if (err.name === 'NoSuchUpload' || err.$metadata?.httpStatusCode === 404 || err.message?.includes('NoSuchUpload')) {
        const head = await this.verifyObjectExists(this.sourceBucket, s3Key).catch(() => ({ exists: false }));
        if (head && head.exists) {
          console.log(`ℹ️ [AWS S3 Multipart] Upload ${uploadId} was already completed in S3: s3://${this.sourceBucket}/${s3Key}`);
          return {
            alreadyCompleted: true,
            s3Bucket: this.sourceBucket,
            s3Key,
            contentLength: head.contentLength
          };
        }
      }
      throw err;
    }
  }

  /**
   * 5. Aborts an incomplete S3 Multipart Upload (purges dangling part fragments)
   */
  async abortMultipartUpload({ s3Key, uploadId }) {
    try {
      const command = new AbortMultipartUploadCommand({
        Bucket: this.sourceBucket,
        Key: s3Key,
        UploadId: uploadId
      });
      await this.s3Client.send(command);
      console.log(`🛑 [AWS S3 Multipart] Successfully aborted uploadId: ${uploadId} for key: ${s3Key}`);
      return { aborted: true };
    } catch (err) {
      console.warn(`⚠️ [AWS S3 Multipart Abort Notice] uploadId ${uploadId}:`, err.message);
      return { aborted: false, error: err.message };
    }
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
        lastModified: response.LastModified,
        etag: response.ETag
      };
    } catch (err) {
      if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
        return { exists: false };
      }
      throw err;
    }
  }

  /**
   * Permanently deletes any object from S3
   */
  async deleteObject(bucket, key) {
    const targetBucket = bucket || this.sourceBucket;
    try {
      const command = new DeleteObjectCommand({
        Bucket: targetBucket,
        Key: key
      });
      await this.s3Client.send(command);
      console.log(`✅ [AWS S3] Successfully purged object: s3://${targetBucket}/${key}`);
      return { deleted: true };
    } catch (err) {
      console.error(`⚠️ [AWS S3 Delete Error] Could not purge object s3://${targetBucket}/${key}:`, err.message);
      return { deleted: false, error: err.message };
    }
  }

  /**
   * Lists all objects matching a given key prefix in S3
   */
  async listObjectsUnderPrefix(bucket, prefix) {
    const targetBucket = bucket || this.sourceBucket;
    try {
      const command = new ListObjectsV2Command({
        Bucket: targetBucket,
        Prefix: prefix
      });
      const response = await this.s3Client.send(command);
      return response.Contents || [];
    } catch (err) {
      console.warn(`⚠️ [AWS S3 List Notice] Prefix ${prefix}:`, err.message);
      return [];
    }
  }

  /**
   * Permanently deletes the temporary raw source video from S3 ingest bucket
   */
  async deleteSourceVideo(bucket, key) {
    return this.deleteObject(bucket, key);
  }

  /**
   * Clean abandoned / incomplete multipart uploads older than maxAgeHours (Default: 24h)
   */
  async cleanAbandonedMultipartUploads({ bucket, maxAgeHours = 24 }) {
    const targetBucket = bucket || this.sourceBucket;
    try {
      const command = new ListMultipartUploadsCommand({
        Bucket: targetBucket
      });
      const response = await this.s3Client.send(command);
      const uploads = response.Uploads || [];
      const cutoffTime = Date.now() - (maxAgeHours * 60 * 60 * 1000);
      let abortedCount = 0;

      for (const u of uploads) {
        const initiatedTime = u.Initiated ? new Date(u.Initiated).getTime() : 0;
        if (initiatedTime < cutoffTime && u.UploadId && u.Key) {
          console.log(`🧹 [AWS S3 Cleanup] Aborting abandoned multipart upload: ${u.UploadId} for key: ${u.Key}`);
          await this.abortMultipartUpload({ s3Key: u.Key, uploadId: u.UploadId });
          abortedCount++;
        }
      }

      return { totalFound: uploads.length, abortedCount };
    } catch (err) {
      console.warn(`⚠️ [AWS S3 Cleanup Notice] Could not list multipart uploads:`, err.message);
      return { totalFound: 0, abortedCount: 0, error: err.message };
    }
  }

  /**
   * Counts active HLS .ts segment and manifest files currently generated in S3 output prefix with real storage sizes
   */
  async countHlsSegments({ bucket, prefix }) {
    try {
      if (!prefix) {
        return {
          segmentCount: 0,
          manifestCount: 0,
          totalFiles: 0,
          segments480p: 0,
          segments720p: 0,
          segments1080p: 0,
          bytes480p: 0,
          bytes720p: 0,
          bytes1080p: 0,
          totalHlsBytes: 0,
          size480pMB: '0.0',
          size720pMB: '0.0',
          size1080pMB: '0.0',
          totalHlsMB: '0.0'
        };
      }
      let continuationToken = null;
      let segmentCount = 0;
      let manifestCount = 0;
      let totalFiles = 0;
      let segments480p = 0;
      let segments720p = 0;
      let segments1080p = 0;
      let bytes480p = 0;
      let bytes720p = 0;
      let bytes1080p = 0;
      let totalHlsBytes = 0;

      do {
        const command = new ListObjectsV2Command({
          Bucket: bucket || this.outputBucket,
          Prefix: prefix,
          ContinuationToken: continuationToken
        });
        const response = await this.s3Client.send(command);
        const contents = response.Contents || [];
        totalFiles += contents.length;
        for (const item of contents) {
          const key = item.Key || '';
          const size = Number(item.Size) || 0;
          totalHlsBytes += size;
          if (key.endsWith('.ts')) {
            segmentCount++;
            if (key.includes('480p')) {
              segments480p++;
              bytes480p += size;
            } else if (key.includes('720p')) {
              segments720p++;
              bytes720p += size;
            } else if (key.includes('1080p')) {
              segments1080p++;
              bytes1080p += size;
            }
          }
          if (key.endsWith('.m3u8')) {
            manifestCount++;
            if (key.includes('480p')) bytes480p += size;
            else if (key.includes('720p')) bytes720p += size;
            else if (key.includes('1080p')) bytes1080p += size;
          }
        }
        continuationToken = response.IsTruncated ? response.NextContinuationToken : null;
      } while (continuationToken);

      return {
        segmentCount,
        manifestCount,
        totalFiles,
        segments480p,
        segments720p,
        segments1080p,
        bytes480p,
        bytes720p,
        bytes1080p,
        totalHlsBytes,
        size480pMB: (bytes480p / (1024 * 1024)).toFixed(1),
        size720pMB: (bytes720p / (1024 * 1024)).toFixed(1),
        size1080pMB: (bytes1080p / (1024 * 1024)).toFixed(1),
        totalHlsMB: (totalHlsBytes / (1024 * 1024)).toFixed(1)
      };
    } catch (err) {
      return {
        segmentCount: 0,
        manifestCount: 0,
        totalFiles: 0,
        segments480p: 0,
        segments720p: 0,
        segments1080p: 0,
        bytes480p: 0,
        bytes720p: 0,
        bytes1080p: 0,
        totalHlsBytes: 0,
        size480pMB: '0.0',
        size720pMB: '0.0',
        size1080pMB: '0.0',
        totalHlsMB: '0.0'
      };
    }
  }

  /**
   * Lists verified uploaded parts for an active S3 multipart upload session
   */
  async listUploadedParts({ uploadId, s3Key, bucket }) {
    try {
      if (!uploadId || !s3Key) return [];
      let partNumberMarker = undefined;
      const uploadedParts = [];

      do {
        const command = new ListPartsCommand({
          Bucket: bucket || this.sourceBucket,
          Key: s3Key,
          UploadId: uploadId,
          PartNumberMarker: partNumberMarker
        });
        const response = await this.s3Client.send(command);
        const parts = response.Parts || [];
        for (const p of parts) {
          uploadedParts.push({
            PartNumber: p.PartNumber,
            ETag: p.ETag ? p.ETag.replace(/"/g, '') : '',
            Size: p.Size
          });
        }
        partNumberMarker = response.IsTruncated ? response.NextPartNumberMarker : undefined;
      } while (partNumberMarker);

      return uploadedParts;
    } catch (err) {
      console.warn(`⚠️ [AWS S3 ListParts Notice] Could not list parts for uploadId ${uploadId}:`, err.message);
      return [];
    }
  }

  /**
   * Fully paginated S3 object listing with ContinuationToken
   */
  async listObjectsWithPagination({ bucket, prefix, maxKeys = 1000 }) {
    const targetBucket = bucket || this.sourceBucket;
    const allObjects = [];
    let continuationToken = undefined;

    try {
      do {
        const command = new ListObjectsV2Command({
          Bucket: targetBucket,
          Prefix: prefix || '',
          MaxKeys: maxKeys,
          ContinuationToken: continuationToken
        });
        const response = await this.s3Client.send(command);
        const contents = response.Contents || [];
        for (const item of contents) {
          allObjects.push({
            Key: item.Key,
            Size: item.Size || 0,
            LastModified: item.LastModified,
            ETag: item.ETag
          });
        }
        continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
      } while (continuationToken);

      return allObjects;
    } catch (err) {
      console.warn(`⚠️ [AWS S3 ListObjects Notice] Error listing prefix '${prefix}':`, err.message);
      return allObjects;
    }
  }

  /**
   * Deletes multiple S3 objects in batches of up to 1,000 keys per call (DeleteObjectsCommand)
   */
  async deleteObjectsBatch(bucket, keys = []) {
    const targetBucket = bucket || this.sourceBucket;
    if (!Array.isArray(keys) || keys.length === 0) {
      return { deletedCount: 0, errors: [] };
    }

    const validKeys = keys.filter(k => typeof k === 'string' && k.trim().length > 0);
    if (validKeys.length === 0) {
      return { deletedCount: 0, errors: [] };
    }

    const batchSize = 1000;
    let totalDeleted = 0;
    const allErrors = [];

    for (let i = 0; i < validKeys.length; i += batchSize) {
      const chunk = validKeys.slice(i, i + batchSize);
      try {
        const command = new DeleteObjectsCommand({
          Bucket: targetBucket,
          Delete: {
            Objects: chunk.map(Key => ({ Key })),
            Quiet: true
          }
        });
        const response = await this.s3Client.send(command);
        if (response.Errors && response.Errors.length > 0) {
          allErrors.push(...response.Errors);
          totalDeleted += (chunk.length - response.Errors.length);
        } else {
          totalDeleted += chunk.length;
        }
      } catch (err) {
        console.warn(`⚠️ [AWS S3 Batch Delete Chunk Error]:`, err.message);
        // Fallback: Delete individually for this chunk
        for (const key of chunk) {
          const res = await this.deleteObject(targetBucket, key);
          if (res.deleted) totalDeleted++;
          else allErrors.push({ Key: key, Message: res.error });
        }
      }
    }

    return {
      deletedCount: totalDeleted,
      errors: allErrors,
      success: allErrors.length === 0
    };
  }

  /**
   * Video-Scoped Prefix Purge:
   * Recursively paginates, batch deletes all objects under exact prefix, and verifies zero objects remain.
   */
  async purgeVideoPrefix({ bucket, prefix }) {
    const targetBucket = bucket || this.sourceBucket;
    if (!prefix || typeof prefix !== 'string' || prefix.trim().length < 5) {
      throw new Error(`Invalid or unsafe S3 prefix for video purge: '${prefix}'`);
    }

    // Safety Lock: Prefix must contain 'videos/', 'lessons/', 'source/', 'hls/', or 'topics/' to prevent accidental root/course wipe
    if (!prefix.includes('videos/') && !prefix.includes('/source/') && !prefix.includes('/hls/') && !prefix.includes('/lessons/') && !prefix.includes('topics/')) {
      throw new Error(`Safety lock rejected broad S3 purge on non-video prefix: '${prefix}'`);
    }

    console.log(`🧹 [AWS S3 Purge] Initiating video-scoped recursive purge for: s3://${targetBucket}/${prefix}`);

    // 1. Fully paginated list of all objects
    const objects = await this.listObjectsWithPagination({ bucket: targetBucket, prefix });
    if (objects.length === 0) {
      console.log(`ℹ️ [AWS S3 Purge] Prefix s3://${targetBucket}/${prefix} is already empty (0 objects).`);
      return { success: true, deletedCount: 0, remainingCount: 0 };
    }

    // 2. Batch delete all keys
    const keys = objects.map(o => o.Key).filter(Boolean);
    const delResult = await this.deleteObjectsBatch(targetBucket, keys);

    // 3. Verify zero objects remain
    const remaining = await this.listObjectsWithPagination({ bucket: targetBucket, prefix });
    const isClean = remaining.length === 0;

    if (!isClean) {
      console.error(`⚠️ [AWS S3 Purge Warning] Prefix s3://${targetBucket}/${prefix} still has ${remaining.length} objects remaining after batch delete.`);
    } else {
      console.log(`✅ [AWS S3 Purge Verified] Successfully purged ${delResult.deletedCount} objects under s3://${targetBucket}/${prefix}. Remaining: 0`);
    }

    return {
      success: isClean,
      deletedCount: delResult.deletedCount,
      remainingCount: remaining.length,
      errors: delResult.errors
    };
  }
}

module.exports = new S3VideoService();
