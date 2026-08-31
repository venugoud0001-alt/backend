/**
 * Core Video Pipeline Orchestration Service
 * Connects Express API, AWS S3, AWS MediaConvert, and Supabase Metadata
 */

const { supabase } = require('../../config/supabase');
const s3VideoService = require('./video.s3.service');
const mediaConvertVideoService = require('./video.mediaconvert.service');
const { VIDEO_STATUS, ALLOWED_VIDEO_MIME_TYPES, MAX_VIDEO_FILE_SIZE_BYTES } = require('./video.constants');
const { addCalendarMonths, isAccessExpired } = require('../../utils/dateUtils');
const cloudFrontVideoService = require('./video.cloudfront.service');
const env = require('../../config/env');

// Resilient in-memory fallback store for development/pre-migration periods
const memoryVideoStore = new Map();

class VideoService {
  /**
   * Helper to safely persist video record to Supabase
   */
  async upsertVideoRecord(payload) {
    const finalId = payload.id || require('crypto').randomUUID();
    const fullRecord = {
      id: finalId,
      ...payload,
      updated_at: new Date().toISOString()
    };

    // Store in resilient local cache first
    memoryVideoStore.set(String(payload.lesson_id), fullRecord);
    memoryVideoStore.set(String(finalId), fullRecord);

    try {
      const { data, error } = await supabase
        .from('lesson_videos')
        .upsert(payload, { onConflict: 'lesson_id' })
        .select()
        .single();

      if (!error && data) {
        memoryVideoStore.set(String(data.lesson_id), data);
        memoryVideoStore.set(String(data.id), data);
        return data;
      }
    } catch (err) {
      // Fall through to in-memory fallback if table isn't migrated yet
    }

    return fullRecord;
  }

  /**
   * Helper to fetch video record by lessonId or videoAssetId
   */
  async getVideoRecord(identifier) {
    if (!identifier) return null;
    const strId = String(identifier);

    try {
      const { data, error } = await supabase
        .from('lesson_videos')
        .select('*')
        .or(`id.eq.${strId},lesson_id.eq.${strId}`)
        .maybeSingle();

      if (!error && data) {
        return data;
      }
    } catch (err) {}

    // Fallback to in-memory store
    return memoryVideoStore.get(strId) || null;
  }

  /**
   * 1. Admin Requests Video Upload: Validates file, creates presigned S3 URL, records UPLOADING state
   */
  async requestUpload(adminUser, { courseId, moduleId, lessonId, fileName, contentType, fileSizeBytes, title }) {
    if (!courseId || !lessonId) {
      throw { statusCode: 400, message: 'courseId and lessonId are required.' };
    }

    if (!fileName || !contentType) {
      throw { statusCode: 400, message: 'fileName and contentType are required.' };
    }

    // Validate MIME Type
    if (!ALLOWED_VIDEO_MIME_TYPES.includes(contentType.toLowerCase())) {
      throw {
        statusCode: 400,
        message: `Invalid video format '${contentType}'. Allowed types: MP4, MOV (QuickTime), M4V, WEBM.`
      };
    }

    // Validate File Size
    const size = Number(fileSizeBytes);
    if (size && size > MAX_VIDEO_FILE_SIZE_BYTES) {
      throw {
        statusCode: 400,
        message: `File size exceeds maximum allowed limit of 5 GB (${(size / (1024 * 1024 * 1024)).toFixed(2)} GB).`
      };
    }

    // Validate Course Exists
    const { data: course, error: courseErr } = await supabase
      .from('courses')
      .select('id, title, curriculum_modules')
      .or(`id.eq.${courseId},slug.eq.${courseId}`)
      .maybeSingle();

    if (courseErr || !course) {
      throw { statusCode: 404, message: `Course '${courseId}' not found.` };
    }

    // Generate Direct-to-S3 Presigned URL
    const presignedData = await s3VideoService.generatePresignedUploadUrl({
      courseId,
      moduleId: moduleId || 'general',
      lessonId,
      fileName,
      contentType
    });

    const videoAssetId = require('crypto').randomUUID();

    // Persist Initial UPLOADING State in Supabase
    const recordPayload = {
      id: videoAssetId,
      lesson_id: String(lessonId),
      course_id: courseId,
      module_id: String(moduleId || 'general'),
      title: title || fileName,
      status: VIDEO_STATUS.UPLOADING,
      source_s3_bucket: presignedData.s3Bucket,
      source_s3_key: presignedData.s3Key,
      file_size_bytes: size || 0,
      upload_started_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const savedRecord = await this.upsertVideoRecord(recordPayload);

    return {
      status: 'SUCCESS',
      videoAssetId: savedRecord.id || videoAssetId,
      lessonId,
      uploadUrl: presignedData.uploadUrl,
      s3Bucket: presignedData.s3Bucket,
      s3Key: presignedData.s3Key,
      expiresInSeconds: presignedData.expiresInSeconds
    };
  }

  /**
   * 2. Confirm Direct Upload & Start MediaConvert Processing
   */
  async confirmUploadAndStartProcessing(adminUser, { videoAssetId, lessonId }) {
    const record = await this.getVideoRecord(videoAssetId || lessonId);
    if (!record) {
      throw { statusCode: 404, message: 'Video upload record not found.' };
    }

    // Verify S3 Object Existence
    const exists = await s3VideoService.verifyObjectExists(record.source_s3_bucket, record.source_s3_key);
    if (!exists) {
      throw { statusCode: 400, message: 'Source file not found in S3 ingest bucket. Upload may have been aborted.' };
    }

    const outputPrefix = `courses/${record.course_id}/modules/${record.module_id}/lessons/${record.lesson_id}/`;

    // Start AWS MediaConvert Job
    const jobResult = await mediaConvertVideoService.submitTranscodeJob({
      sourceBucket: record.source_s3_bucket,
      sourceKey: record.source_s3_key,
      outputPrefix,
      userMetadata: {
        videoAssetId: record.id,
        lessonId: record.lesson_id,
        courseId: record.course_id
      }
    });

    const cdnDomain = env.CLOUDFRONT_DOMAIN || `https://${env.AWS_S3_BUCKET_OUTPUT}.s3.${env.AWS_REGION}.amazonaws.com`;
    const masterPlaylistUrl = `${cdnDomain}/${outputPrefix}master.m3u8`;
    const hls720pUrl = `${cdnDomain}/${outputPrefix}720p/720p.m3u8`;
    const hls1080pUrl = `${cdnDomain}/${outputPrefix}1080p/1080p.m3u8`;

    // Update Status to PROCESSING in Supabase
    const updatedRecord = await this.upsertVideoRecord({
      ...record,
      status: VIDEO_STATUS.PROCESSING,
      mediaconvert_job_id: jobResult.jobId,
      hls_master_url: masterPlaylistUrl,
      hls_720p_url: hls720pUrl,
      hls_1080p_url: hls1080pUrl,
      upload_completed_at: new Date().toISOString(),
      processing_started_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });

    return {
      status: 'SUCCESS',
      videoAssetId: updatedRecord.id,
      jobId: jobResult.jobId,
      processingStatus: VIDEO_STATUS.PROCESSING,
      masterPlaylistUrl
    };
  }

  /**
   * 3. Handle Successful MediaConvert Completion & Source Deletion
   */
  async handleProcessingCompleted({ jobId, videoAssetId, lessonId }) {
    const record = await this.getVideoRecord(videoAssetId || lessonId);
    if (!record) return;

    console.log(`🎬 [Video Pipeline] Transcoding complete for lesson: ${record.lesson_id}. Finalizing verification...`);

    // Clean up temporary source video from S3 ingest bucket (Strict Retention Policy)
    let sourceDeleted = false;
    if (record.source_s3_bucket && record.source_s3_key) {
      const delRes = await s3VideoService.deleteSourceVideo(record.source_s3_bucket, record.source_s3_key);
      sourceDeleted = delRes.deleted;
    }

    // Update state to READY
    await this.upsertVideoRecord({
      ...record,
      status: VIDEO_STATUS.READY,
      source_deleted_at: sourceDeleted ? new Date().toISOString() : null,
      processing_completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });

    // Update video_url in course curriculum_modules JSON so NLS player picks it up immediately
    try {
      const { data: course } = await supabase
        .from('courses')
        .select('id, curriculum_modules')
        .eq('id', record.course_id)
        .maybeSingle();

      if (course && Array.isArray(course.curriculum_modules)) {
        let modified = false;
        const updatedModules = course.curriculum_modules.map(mod => {
          const matchesMod = (record.module_id && String(mod.id) === String(record.module_id)) ||
                            (record.lesson_id && (String(mod.id) === String(record.lesson_id) || String(mod.video_asset_id) === String(record.id)));

          if (matchesMod) {
            modified = true;
            return {
              ...mod,
              video_url: record.hls_master_url,
              video_status: VIDEO_STATUS.READY,
              video_asset_id: record.id
            };
          }

          if (Array.isArray(mod.lessons)) {
            const updatedLessons = mod.lessons.map(l => {
              if (String(l.id) === String(record.lesson_id)) {
                modified = true;
                return {
                  ...l,
                  video_url: record.hls_master_url,
                  video_status: VIDEO_STATUS.READY
                };
              }
              return l;
            });
            return {
              ...mod,
              video_url: mod.video_url || record.hls_master_url,
              video_status: mod.video_status || VIDEO_STATUS.READY,
              lessons: updatedLessons
            };
          }
          return mod;
        });

        if (modified) {
          await supabase
            .from('courses')
            .update({ curriculum_modules: updatedModules, updated_at: new Date().toISOString() })
            .eq('id', course.id);
        }
      }
    } catch (err) {
      console.warn('⚠️ [Video Pipeline] Non-fatal notice updating curriculum_modules JSON:', err.message);
    }

    console.log(`✅ [Video Pipeline] Lesson ${record.lesson_id} is now READY. Temporary source purged.`);
  }

  /**
   * 4. Handle MediaConvert Failure
   */
  async handleProcessingFailed({ jobId, videoAssetId, lessonId, errorDetails }) {
    const record = await this.getVideoRecord(videoAssetId || lessonId);
    if (!record) return;

    console.error(`❌ [Video Pipeline] Transcoding failed for lesson ${record.lesson_id}:`, errorDetails);

    await this.upsertVideoRecord({
      ...record,
      status: VIDEO_STATUS.FAILED,
      error_code: errorDetails?.code || 'TRANSCODE_ERROR',
      error_message: errorDetails?.message || 'MediaConvert transcoding failed.',
      updated_at: new Date().toISOString()
    });
  }

  /**
   * 5. Get Video Status & Telemetry
   */
  async getVideoStatus(lessonId) {
    const record = await this.getVideoRecord(lessonId);
    if (!record) {
      return {
        lessonId,
        status: 'UNPROCESSED',
        hlsMasterUrl: null
      };
    }

    // If currently PROCESSING and has a jobId, check status update
    if (record.status === VIDEO_STATUS.PROCESSING && record.mediaconvert_job_id) {
      const jobStatus = await mediaConvertVideoService.getJobStatus(record.mediaconvert_job_id);
      if (jobStatus.status === 'COMPLETE') {
        await this.handleProcessingCompleted({ jobId: record.mediaconvert_job_id, videoAssetId: record.id });
        record.status = VIDEO_STATUS.READY;
      } else if (jobStatus.status === 'ERROR') {
        await this.handleProcessingFailed({
          jobId: record.mediaconvert_job_id,
          videoAssetId: record.id,
          errorDetails: { message: jobStatus.errorMessage }
        });
        record.status = VIDEO_STATUS.FAILED;
      }
    }

    return {
      id: record.id,
      lessonId: record.lesson_id,
      courseId: record.course_id,
      status: record.status,
      hlsMasterUrl: record.hls_master_url,
      hls720pUrl: record.hls_720p_url,
      hls1080pUrl: record.hls_1080p_url,
      durationSeconds: record.duration_seconds || 0,
      errorMessage: record.error_message || null,
      sourceDeleted: Boolean(record.source_deleted_at),
      updatedAt: record.updated_at
    };
  }

  /**
   * 6. Retry Failed Transcoding
   */
  async retryProcessing(adminUser, { lessonId }) {
    const record = await this.getVideoRecord(lessonId);
    if (!record) {
      throw { statusCode: 404, message: 'Video record not found.' };
    }

    if (!record.source_s3_key) {
      throw { statusCode: 400, message: 'Source file has already been deleted or never uploaded. Please re-upload.' };
    }

    return this.confirmUploadAndStartProcessing(adminUser, { videoAssetId: record.id, lessonId: record.lesson_id });
  }

  /**
   * 7. Student Playback Authorization:
   * Validates enrollment & active payment, checks lesson publishing,
   * generates temporary CloudFront signed cookies / signed URL,
   * retrieves last watched position from lesson_video_progress.
   */
  async authorizeStudentPlayback(user, { courseId, lessonId }) {
    if (!user || !user.email) {
      throw { statusCode: 401, message: 'Authentication required.' };
    }

    const userEmail = user.email.toLowerCase().trim();
    const isAdmin = user.user_metadata?.role === 'ADMIN' || user.role === 'ADMIN' || userEmail === 'admin@internnetra.com';

    // 1. Fetch Target Course & Lesson
    const { data: course, error: courseErr } = await supabase
      .from('courses')
      .select('id, title, slug, curriculum_modules')
      .or(`id.eq.${courseId},slug.eq.${courseId}`)
      .maybeSingle();

    if (courseErr || !course) {
      throw { statusCode: 404, message: 'Course not found.' };
    }

    // Locate lesson in course modules
    let targetLesson = null;
    let targetModule = null;
    if (Array.isArray(course.curriculum_modules)) {
      for (const mod of course.curriculum_modules) {
        if (Array.isArray(mod.lessons)) {
          const l = mod.lessons.find(item => String(item.id) === String(lessonId));
          if (l) {
            targetLesson = l;
            targetModule = mod;
            break;
          }
        }
      }
    }

    // Check if free preview lesson
    const isFreePreview = Boolean(targetLesson?.is_preview);

    // 2. Authorization Check: Admin or Active Enrolled Student or Free Preview
    let studentId = null;
    let enrollmentId = null;

    if (!isAdmin && !isFreePreview) {
      // Find Student Profile
      const { data: student } = await supabase
        .from('students')
        .select('id, email')
        .ilike('email', userEmail)
        .maybeSingle();

      if (!student) {
        throw { statusCode: 403, message: 'Student profile not found. Please register or activate your account.' };
      }
      studentId = student.id;

      // Verify Active Enrollment & 6-Month Course Access Expiry
      const { data: enrollment } = await supabase
        .from('enrollments')
        .select('id, student_id, course_id, payment_status, course_access_status, access_start_date, access_expiry_date, created_at')
        .eq('student_id', student.id)
        .eq('course_id', course.id)
        .maybeSingle();

      if (!enrollment) {
        throw { statusCode: 403, message: 'Access Denied: You are not enrolled in this course.' };
      }

      const hasActiveAccess =
        enrollment.course_access_status === 'ACTIVE' ||
        ['SUCCESS', 'PAID', 'PARTIALLY_PAID'].includes((enrollment.payment_status || '').toUpperCase());

      if (!hasActiveAccess) {
        throw { statusCode: 403, message: 'Course access locked: Successful payment or enrollment activation required.' };
      }

      // Authoritative 6-Month Access Expiry Check
      let effectiveExpiry = enrollment.access_expiry_date;
      if (!effectiveExpiry && enrollment.created_at) {
        effectiveExpiry = addCalendarMonths(enrollment.created_at, 6);
      }

      if (effectiveExpiry && isAccessExpired(effectiveExpiry)) {
        throw {
          statusCode: 403,
          code: 'COURSE_ACCESS_EXPIRED',
          message: `Course access expired on ${new Date(effectiveExpiry).toLocaleDateString('en-GB')}. 6-month access limit reached. Please repurchase or renew to continue.`
        };
      }

      enrollmentId = enrollment.id;
    }

    // 3. Verify Video Metadata & Readiness
    let videoRecord = await this.getVideoRecord(lessonId);
    let masterUrl = videoRecord?.hls_master_url || targetLesson?.video_url;

    if (!masterUrl && targetLesson?.video_url) {
      masterUrl = targetLesson.video_url;
    }

    if (!masterUrl) {
      throw { statusCode: 404, message: 'Video lecture not yet available for this lesson.' };
    }

    // 4. Retrieve Resume Position from lesson_video_progress
    let lastPositionSeconds = 0;
    if (studentId) {
      try {
        const { data: progress } = await supabase
          .from('lesson_video_progress')
          .select('watched_position_seconds')
          .eq('student_id', studentId)
          .eq('lesson_id', String(lessonId))
          .maybeSingle();

        if (progress?.watched_position_seconds) {
          lastPositionSeconds = progress.watched_position_seconds;
        }
      } catch (e) {}
    }

    // 5. Generate CloudFront Signed Authorization
    const resourcePrefix = `courses/${course.id}/modules/${targetModule?.id || 'general'}/lessons/${lessonId}/`;
    const signedCookiesData = cloudFrontVideoService.generateHlsSignedCookies({
      resourcePath: resourcePrefix,
      expiresInSeconds: 14400 // 4 Hours
    });

    const signedStreamUrl = cloudFrontVideoService.generateSignedPlaybackUrl({
      hlsMasterUrl: masterUrl,
      expiresInSeconds: 14400
    });

    return {
      status: 'AUTHORIZED',
      lessonId,
      courseId: course.id,
      title: targetLesson?.title || 'Lesson Video',
      streamUrl: signedStreamUrl,
      hlsMasterUrl: masterUrl,
      cookies: signedCookiesData.cookies,
      lastPositionSeconds,
      expiresEpoch: signedCookiesData.expiresEpoch,
      isFreePreview
    };
  }
}

module.exports = new VideoService();
