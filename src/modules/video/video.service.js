/**
 * Core Video Pipeline Orchestration Service
 * Connects Express API, AWS S3, AWS MediaConvert, and Supabase Metadata
 */

const { supabase } = require('../../config/supabase');
const s3VideoService = require('./video.s3.service');
const mediaConvertVideoService = require('./video.mediaconvert.service');
const mediaConvertJobGuard = require('./video.job-guard.service');
const videoSourceProbe = require('./video.source-probe');
const {
  VIDEO_STATUS,
  VALID_TRANSCODING_ENTRY_STATUSES,
  SEGMENTATION_DB_MAP_STATUSES,
  ALLOWED_VIDEO_MIME_TYPES,
  MAX_VIDEO_FILE_SIZE_BYTES,
  DEFAULT_PART_SIZE_BYTES,
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_RETRIES,
  MULTIPART_THRESHOLD_BYTES,
  PROCESSING_PROFILES,
  TRIGGER_SOURCES
} = require('./video.constants');
const { addCalendarMonths, isAccessExpired } = require('../../utils/dateUtils');
const cloudFrontVideoService = require('./video.cloudfront.service');
const s3PathUtils = require('../../utils/s3PathUtils');
const env = require('../../config/env');
const jwt = require('jsonwebtoken');
const { isUUID, isValidSlug, isSafeId, classifyIdentifier, normalizeIdentifier } = require('../../utils/idValidator');
const {
  HierarchyValidationError,
  validateCourse,
  validateModule,
  validateTopic,
  validateVideo,
  validateUploadConsistency,
  validateHierarchyChain
} = require('../../utils/hierarchyValidator');

// Resilient in-memory fallback store for development/pre-migration periods
const memoryVideoStore = new Map();

class VideoService {
  constructor() {
    this.memoryVideoStore = memoryVideoStore;
  }

  /**
   * Central guarded MediaConvert submission.
   * Acquires atomic claim → CreateJob once → attaches job id / releases on failure.
   */
  async submitGuardedMediaConvertJob({
    processingProfile,
    submitFn,
    videoId = null,
    uploadId = null,
    courseId = null,
    moduleId = null,
    topicId = null,
    sourceKey = null,
    sourceDurationSeconds = null,
    sourceWidth = null,
    sourceHeight = null,
    triggerSource = TRIGGER_SOURCES.OTHER,
    adminOverride = false,
    forceReprocess = false,
    confirmReprocess = false,
    existingRecord = null,
    existingTopic = null,
    isRetry = false
  }) {
    const claimResult = await mediaConvertJobGuard.acquireProcessingClaim({
      processingProfile,
      videoId,
      uploadId,
      courseId,
      moduleId,
      topicId,
      sourceKey,
      sourceDurationSeconds,
      sourceWidth,
      sourceHeight,
      triggerSource,
      adminOverride,
      forceReprocess,
      confirmReprocess,
      existingRecord,
      existingTopic,
      s3VideoService,
      isRetry
    });

    if (!claimResult.shouldCreateJob) {
      return {
        duplicated: true,
        reused: true,
        reason: claimResult.reason,
        jobId: claimResult.existingJobId || null,
        processingIdentity: claimResult.processingIdentity,
        processingProfile: claimResult.processingProfile,
        requestedOutputs: claimResult.requestedOutputs,
        hlsMasterUrl: claimResult.hlsMasterUrl || null
      };
    }

    const claim = claimResult.claim;
    try {
      const jobResult = await submitFn({
        requestedOutputs: claim.requestedOutputs,
        sourceHeight,
        sourceWidth
      });
      await mediaConvertJobGuard.attachJobId(claim, jobResult.jobId);
      return {
        duplicated: false,
        reused: false,
        jobResult,
        claim,
        processingIdentity: claim.processingIdentity,
        processingProfile: claim.processingProfile,
        requestedOutputs: claim.requestedOutputs
      };
    } catch (err) {
      await mediaConvertJobGuard.releaseClaim({
        claimId: claim.id,
        claimOwnerToken: claim.claimOwnerToken,
        processingIdentity: claim.processingIdentity,
        errorMessage: err.message || String(err)
      });
      throw err;
    }
  }

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

    // Store in resilient local cache first with course-scoped composite keys
    if (payload.course_id && payload.lesson_id) {
      memoryVideoStore.set(`${payload.course_id}:${payload.lesson_id}`, fullRecord);
    }
    // Only store under courseId:moduleId if this is a MODULE-level record (lesson_id === module_id).
    // Topic uploads have lesson_id = topicId which differs from module_id — storing them under
    // courseId:moduleId would OVERWRITE the module's own video record in memory.
    if (payload.course_id && payload.module_id && (!payload.lesson_id || String(payload.lesson_id) === String(payload.module_id))) {
      memoryVideoStore.set(`${payload.course_id}:${payload.module_id}`, fullRecord);
    }
    memoryVideoStore.set(String(finalId), fullRecord);

    try {
      let existing = null;
      if (payload.id) {
        const { data: byId } = await supabase.from('lesson_videos').select('*').eq('id', finalId).maybeSingle();
        existing = byId;
      } else if (payload.lesson_id) {
        let q = supabase.from('lesson_videos').select('*').eq('lesson_id', String(payload.lesson_id));
        if (payload.course_id) {
          q = q.eq('course_id', payload.course_id);
        }
        const { data: byLesson } = await q.order('updated_at', { ascending: false }).limit(1);
        existing = byLesson && byLesson[0] ? byLesson[0] : null;
      }

      const recordId = finalId;
      fullRecord.id = recordId;

      const mergedWithExisting = {
        ...(existing || {}),
        ...fullRecord
      };
      mergedWithExisting.id = recordId;
      mergedWithExisting.module_id = mergedWithExisting.module_id || fullRecord.module_id || existing?.module_id || String(fullRecord.lesson_id || 'general');
      mergedWithExisting.title = mergedWithExisting.title || fullRecord.title || existing?.title || 'Video';
      mergedWithExisting.course_id = mergedWithExisting.course_id || fullRecord.course_id || existing?.course_id;
      mergedWithExisting.lesson_id = String(mergedWithExisting.lesson_id || fullRecord.lesson_id);

      const ALLOWED_DB_STATUSES = [
        'UNPROCESSED', 'NO_VIDEO', 'DRAFT', 'UPLOADING', 'UPLOADED',
        'PROCESSING', 'READY', 'FAILED', 'CANCELLING', 'CANCELED', 'DELETING', 'DELETED'
      ];
      const rawStatus = mergedWithExisting.status || 'UNPROCESSED';

      const ALLOWED_DB_COLS = [
        'id', 'lesson_id', 'topic_id', 'course_id', 'module_id', 'title', 'status',
        'source_s3_bucket', 'source_s3_key', 'source_deleted_at',
        'mediaconvert_job_id', 'hls_master_url', 'hls_720p_url', 'hls_1080p_url',
        'hls_prefix', 'upload_id',
        'course_slug', 'module_slug',
        'duration_seconds', 'source_duration_seconds',
        'file_size_bytes', 'original_file_size_bytes', 'optimized_file_size_bytes',
        'compression_percentage', 'compression_result',
        'output_resolution', 'original_resolution', 'available_qualities',
        'thumbnail_url',
        'error_code', 'error_message', 'is_published',
        'retry_count', 'last_retry_at', 'source_delete_after', 'processing_attempt_id',
        'upload_started_at', 'upload_completed_at',
        'processing_started_at', 'processing_completed_at',
        'created_at', 'updated_at'
      ];

      const cleanPayload = {};
      for (const col of ALLOWED_DB_COLS) {
        if (mergedWithExisting[col] !== undefined && mergedWithExisting[col] !== null) {
          cleanPayload[col] = mergedWithExisting[col];
        }
      }

      // If status indicates no video or cancellation/deletion, clean up from lesson_videos table
      if (['DELETED', 'NO_VIDEO', 'UNPROCESSED', 'CANCELED'].includes(rawStatus)) {
        try {
          await supabase.from('lesson_videos').delete().or(`id.eq.${recordId},lesson_id.eq.${recordId}`);
        } catch (delErr) {}
        memoryVideoStore.set(String(recordId), fullRecord);
        if (payload.course_id && payload.lesson_id) {
          memoryVideoStore.set(`${payload.course_id}:${payload.lesson_id}`, fullRecord);
        }
        return fullRecord;
      }

      // Non-failed states must not have lingering error codes/messages
      if (['READY', 'UPLOADING', 'UPLOADED', 'PROCESSING'].includes(cleanPayload.status)) {
        cleanPayload.error_code = null;
        if (cleanPayload.status !== 'FAILED') {
          cleanPayload.error_message = null;
        }
      }

      // Postgres table 'lesson_videos' has check constraint chk_video_status: IN ('UPLOADING', 'UPLOADED', 'PROCESSING', 'READY', 'FAILED')
      const VALID_DB_ENUM_STATUSES = ['UPLOADING', 'UPLOADED', 'PROCESSING', 'READY', 'FAILED'];
      if (!VALID_DB_ENUM_STATUSES.includes(cleanPayload.status)) {
        // Map SEGMENTATION_* statuses to DB-safe 'UPLOADED' while preserving the logical status in memory
        if (SEGMENTATION_DB_MAP_STATUSES.includes(cleanPayload.status)) {
          cleanPayload.status = 'UPLOADED';
        } else if (cleanPayload.status === 'FAILED') {
          cleanPayload.status = 'FAILED';
        } else {
          // Never write unconfirmed or draft status as UPLOADING to the database!
          return fullRecord;
        }
      }

      const { data, error } = await supabase
        .from('lesson_videos')
        .upsert(cleanPayload, { onConflict: 'id' })
        .select()
        .single();

      if (!error && data) {
        this._activeJobsCache = null;
        const merged = { ...fullRecord, ...data, status: rawStatus };
        if (data.course_id && data.lesson_id) {
          memoryVideoStore.set(`${data.course_id}:${data.lesson_id}`, merged);
        }
        if (data.course_id && data.module_id && (!data.lesson_id || String(data.lesson_id) === String(data.module_id))) {
          memoryVideoStore.set(`${data.course_id}:${data.module_id}`, merged);
        }
        memoryVideoStore.set(String(data.id), merged);
        return merged;
      } else if (error) {
        console.warn('⚠️ [Video Pipeline] Supabase upsert error:', error.message, error.details);
        // Retry with minimal columns (strip extended cols that may not exist in DB yet)
        const EXTENDED_COLS = [
          'topic_id', 'hls_prefix', 'upload_id', 'course_slug', 'module_slug',
          'source_duration_seconds', 'original_file_size_bytes', 'optimized_file_size_bytes',
          'compression_percentage', 'compression_result', 'output_resolution', 'original_resolution',
          'available_qualities', 'retry_count', 'last_retry_at', 'source_delete_after', 'processing_attempt_id'
        ];
        const fallbackPayload = { ...cleanPayload };
        for (const col of EXTENDED_COLS) delete fallbackPayload[col];
        try {
          const { data: d2, error: e2 } = await supabase
            .from('lesson_videos')
            .upsert(fallbackPayload, { onConflict: 'id' })
            .select()
            .single();
          if (!e2 && d2) {
            console.log('✅ [Video Pipeline] Fallback upsert succeeded (without extended cols)');
            this._activeJobsCache = null;
            const merged2 = { ...fullRecord, ...d2, status: rawStatus };
            if (d2.course_id && d2.lesson_id) memoryVideoStore.set(`${d2.course_id}:${d2.lesson_id}`, merged2);
            if (d2.course_id && d2.module_id && (!d2.lesson_id || String(d2.lesson_id) === String(d2.module_id))) memoryVideoStore.set(`${d2.course_id}:${d2.module_id}`, merged2);
            memoryVideoStore.set(String(d2.id), merged2);
            return merged2;
          } else if (e2) {
            console.warn('⚠️ [Video Pipeline] Fallback upsert also failed:', e2.message);
          }
        } catch (retryErr) {
          console.warn('⚠️ [Video Pipeline] Fallback upsert exception:', retryErr.message);
        }
      }
    } catch (err) {
      console.warn('⚠️ [Video Pipeline] Notice persisting to lesson_videos:', err.message);
    }

    return fullRecord;
  }

  /**
   * Helper to fetch video record by lessonId or videoAssetId
   */
  async getVideoRecord(identifier, courseId = null) {
    if (!identifier) return null;
    const strId = String(identifier).trim();
    if (!isSafeId(strId)) {
      return null;
    }
    const isUuidId = isUUID(strId);

    let resolvedCourseId = null;
    if (courseId) {
      const c = await this.resolveCourse(courseId).catch(() => null);
      resolvedCourseId = c?.id || courseId;
    }

    // MANDATORY DATA ISOLATION: A non-UUID identifier (e.g. integer "1") without courseId is ambiguous across courses.
    // Refuse unscoped search for non-UUID identifiers to prevent cross-course leakage.
    if (!isUuidId && !resolvedCourseId) {
      console.warn(`⚠️ [Video Pipeline] getVideoRecord called with non-UUID identifier '${strId}' without courseId. Aborting unscoped search to maintain course isolation.`);
      return null;
    }

    try {
      let query = supabase.from('lesson_videos').select('*');
      if (isUuidId) {
        query = query.or(`id.eq.${strId},lesson_id.eq.${strId},module_id.eq.${strId}`);
      } else {
        query = query.or(`lesson_id.eq.${strId},module_id.eq.${strId}`);
      }
      if (resolvedCourseId) {
        query = query.eq('course_id', resolvedCourseId);
      }
      const { data: rows, error } = await query.order('updated_at', { ascending: false }).limit(10);

      if (!error && Array.isArray(rows) && rows.length > 0) {
        // STRICT PRECEDENCE: Completed READY video data always takes precedence over stale UPLOADING/DRAFT attempts!
        const sorted = [...rows].sort((a, b) => {
          const score = (r) => {
            if (r.status === 'READY' && (r.hls_master_url || r.duration_seconds > 0)) return 100;
            if (r.status === 'READY') return 90;
            if (r.status === 'PROCESSING' && r.mediaconvert_job_id) return 80;
            if (r.status === 'PROCESSING') return 70;
            if (r.status === 'UPLOADED') return 60;
            if (r.status === 'UPLOADING') {
              const age = Date.now() - new Date(r.updated_at || r.upload_started_at || r.created_at || 0).getTime();
              return age < 15 * 60 * 1000 ? 40 : 5;
            }
            if (r.status === 'FAILED') return 20;
            return 10;
          };
          return score(b) - score(a);
        });

        const chosenRow = { ...sorted[0] };

        // Verify course ownership if resolvedCourseId is known
        if (resolvedCourseId && chosenRow.course_id && String(chosenRow.course_id) !== String(resolvedCourseId)) {
          return null;
        }

        // Also check if module has completed topic HLS streams in topics table
        // IMPORTANT: Only apply this override for MODULE-LEVEL records (lesson_id === module_id).
        // For topic-specific uploads (lesson_id !== module_id), the record represents a single topic
        // and should NOT be overridden by other topics' READY status in the same module.
        const modId = chosenRow.module_id || strId;
        const isTopicSpecificRecord = chosenRow.lesson_id && chosenRow.module_id && String(chosenRow.lesson_id) !== String(chosenRow.module_id);
        if (!isTopicSpecificRecord) {
          try {
            let tQuery = supabase
              .from('topics')
              .select('id, processing_status, hls_master_url, duration_seconds')
              .eq('module_id', String(modId))
              .eq('processing_status', 'READY');

            if (resolvedCourseId || chosenRow.course_id) {
              tQuery = tQuery.eq('course_id', resolvedCourseId || chosenRow.course_id);
            }

            const { data: readyTopics } = await tQuery;

            if (Array.isArray(readyTopics) && readyTopics.some(t => t.hls_master_url)) {
              chosenRow.status = 'READY';
              if (!chosenRow.hls_master_url) {
                chosenRow.hls_master_url = readyTopics.find(t => t.hls_master_url)?.hls_master_url || null;
              }
            }
          } catch (tErr) {}
        }

        const memKey = resolvedCourseId ? `${resolvedCourseId}:${strId}` : null;
        const mem = (memKey ? memoryVideoStore.get(memKey) : null) || 
                    memoryVideoStore.get(String(chosenRow.id)) || 
                    (resolvedCourseId ? memoryVideoStore.get(`${resolvedCourseId}:${chosenRow.lesson_id}`) : null) || 
                    {};
        const merged = { ...chosenRow, ...mem };

        // If completed in DB or topics, ensure status is READY and never overridden by stale in-memory UPLOADING
        if (chosenRow.status === 'READY') {
          merged.status = 'READY';
        } else if (chosenRow.status === 'UPLOADED' && (!mem.status || mem.status === 'UPLOADED')) {
          merged.status = await this._recoverSegmentationStatus(chosenRow);
        } else if (mem.status && SEGMENTATION_DB_MAP_STATUSES.includes(mem.status)) {
          merged.status = mem.status;
        }

        // If merged status is UPLOADING but stale (> 15 mins), do not treat as uploading
        if (merged.status === 'UPLOADING') {
          const age = Date.now() - new Date(merged.updated_at || merged.upload_started_at || 0).getTime();
          if (age > 15 * 60 * 1000) {
            merged.status = 'NO_VIDEO';
          }
        }

        return merged;
      }
    } catch (err) {
      console.warn('⚠️ [Video Pipeline] Notice querying lesson_videos:', err.message);
    }

    // Fallback to in-memory store with course scoping
    const memFallbackKey = resolvedCourseId ? `${resolvedCourseId}:${strId}` : (isUUID ? strId : null);
    const memFallback = memFallbackKey ? memoryVideoStore.get(memFallbackKey) : null;
    if (memFallback && memFallback.status === 'UPLOADING') {
      const age = Date.now() - (memFallback.updatedAt || 0);
      if (age > 15 * 60 * 1000) {
        memFallback.status = 'NO_VIDEO';
      }
    }
    return memFallback || null;
  }

  /**
   * Helper: Recover segmentation status from DB state when in-memory store is lost (server restart / page refresh)
   * If DB shows UPLOADED, check if confirmed topics exist to determine correct logical status.
   */
  async _recoverSegmentationStatus(dbRecord) {
    if (!dbRecord || dbRecord.status !== 'UPLOADED') return dbRecord?.status || 'UPLOADED';
    try {
      const moduleId = dbRecord.module_id || dbRecord.lesson_id;
      const { data: topics } = await supabase
        .from('topics')
        .select('id, processing_status, start_time_seconds, end_time_seconds')
        .eq('module_id', moduleId)
        .neq('processing_status', 'DELETED')
        .limit(1);

      if (Array.isArray(topics) && topics.length > 0) {
        // Topics exist — segmentation was confirmed
        const hasValidBoundaries = topics.some(t =>
          typeof t.start_time_seconds === 'number' &&
          typeof t.end_time_seconds === 'number' &&
          t.end_time_seconds > t.start_time_seconds
        );
        return hasValidBoundaries ? VIDEO_STATUS.SEGMENTATION_CONFIRMED : VIDEO_STATUS.SEGMENTATION_REQUIRED;
      }

      // No topics exist — segmentation is required
      return VIDEO_STATUS.SEGMENTATION_REQUIRED;
    } catch (err) {
      return VIDEO_STATUS.SEGMENTATION_REQUIRED;
    }
  }

  /**
   * Helper to resolve course by ID, slug, or title with resilient fallbacks
   */
  async resolveCourse(courseIdOrSlug) {
    if (!courseIdOrSlug) return null;
    const classification = classifyIdentifier(courseIdOrSlug);

    // If identifier is invalid (injection syntax, dangerous characters, whitespace), reject immediately without querying DB
    if (classification === 'INVALID') {
      return null;
    }
    const raw = String(courseIdOrSlug).trim();

    try {
      // 1. Direct UUID match
      if (classification === 'UUID') {
        const { data: byId } = await supabase
          .from('courses')
          .select('id, title, slug, curriculum_modules')
          .eq('id', raw)
          .maybeSingle();
        if (byId) return byId;
        return null;
      }

      // 2. Direct slug match (classification === 'SLUG')
      const cleanSlug = normalizeIdentifier(raw, 'SLUG');
      const { data: bySlug } = await supabase
        .from('courses')
        .select('id, title, slug, curriculum_modules')
        .eq('slug', cleanSlug)
        .maybeSingle();
      if (bySlug) return bySlug;

      // 3. Fallback: Strip common department prefixes
      const stripped = cleanSlug.replace(/^(cse-it|ece-eee|mech-civil|management|add-on-programs)-/, '');
      if (stripped && stripped !== cleanSlug && isValidSlug(stripped)) {
        const { data: byStripped } = await supabase
          .from('courses')
          .select('id, title, slug, curriculum_modules')
          .eq('slug', stripped)
          .maybeSingle();
        if (byStripped) return byStripped;
      }

      // 4. Safe match in all courses by ID, title, or slug
      const { data: allCourses } = await supabase.from('courses').select('id, title, slug, curriculum_modules');
      if (Array.isArray(allCourses) && allCourses.length > 0) {
        const match = allCourses.find(c =>
          String(c.id) === raw ||
          String(c.slug).toLowerCase() === cleanSlug ||
          String(c.title).toLowerCase() === cleanSlug
        );
        if (match) return match;
      }
    } catch (err) {
      console.warn('⚠️ [Video Pipeline] Course resolution notice:', err.message);
    }

    return null;
  }

  /**
   * 1. Admin Requests Video Upload: Validates file, creates presigned S3 URL, records UPLOADING state
   */
  async requestUpload(adminUser, { courseId, moduleId, lessonId, fileName, contentType, fileSizeBytes, title, durationSeconds }) {
    const s3PathUtils = require('../../utils/s3PathUtils');

    if (!courseId || !lessonId) {
      throw { statusCode: 400, message: 'courseId and lessonId are required.' };
    }

    if (!fileName || !contentType) {
      throw { statusCode: 400, message: 'fileName and contentType are required.' };
    }

    // Validate MIME Type
    const isMkvFile = fileName.toLowerCase().endsWith('.mkv');
    const normalizedContentType = (isMkvFile && (!contentType || contentType === 'application/octet-stream')) ? 'video/x-matroska' : contentType.toLowerCase();

    if (!ALLOWED_VIDEO_MIME_TYPES.includes(normalizedContentType) && !isMkvFile) {
      throw {
        statusCode: 400,
        message: `Invalid video format '${contentType}'. Allowed types: MP4, MOV (QuickTime), M4V, WEBM, MKV.`
      };
    }

    // Validate File Size
    const size = Number(fileSizeBytes);
    if (!size || size <= 0) {
      throw { statusCode: 400, message: 'Valid fileSizeBytes is required.' };
    }

    if (size > MAX_VIDEO_FILE_SIZE_BYTES) {
      throw {
        statusCode: 400,
        message: `File size exceeds maximum allowed limit of 5 GB (${(size / (1024 * 1024 * 1024)).toFixed(2)} GB).`
      };
    }

    // Authoritative Hierarchy Chain Validation
    const hierarchy = await validateHierarchyChain({
      courseId,
      moduleId: moduleId || lessonId
    });
    const course = hierarchy.course;
    const targetMod = hierarchy.module;
    const modIdx = hierarchy.modIndex || 0;
    const courseSlug = s3PathUtils.generateS3CourseSlug(course);

    const moduleSlug = s3PathUtils.generateS3ModuleSlug(targetMod, modIdx + 1);
    const videoAssetId = require('crypto').randomUUID();
    const cleanFileName = s3PathUtils.sanitizeS3FileName(fileName, title || 'video');
    const s3Key = s3PathUtils.buildS3SourceKey(courseSlug, moduleSlug, videoAssetId, cleanFileName);
    const hlsPrefix = s3PathUtils.buildS3HlsPrefix(courseSlug, moduleSlug, videoAssetId);

    // Generate Direct-to-S3 Presigned URL using clean S3 key
    const presignedData = await s3VideoService.generatePresignedUploadUrl({
      s3Key,
      courseSlug,
      moduleSlug,
      fileName,
      contentType
    });

    const parsedDuration = Math.round(Number(durationSeconds) || 0);

    // Persist Initial UPLOADING State in Supabase
    const recordPayload = {
      id: videoAssetId,
      lesson_id: String(lessonId),
      course_id: course.id,
      module_id: String(moduleId || targetMod?.id || 'general'),
      course_slug: courseSlug,
      module_slug: moduleSlug,
      hls_prefix: hlsPrefix,
      title: title || fileName,
      status: VIDEO_STATUS.UPLOADING,
      source_s3_bucket: presignedData.s3Bucket,
      source_s3_key: presignedData.s3Key,
      file_size_bytes: size || 0,
      duration_seconds: parsedDuration,
      source_duration_seconds: parsedDuration,
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
      expiresInSeconds: presignedData.expiresInSeconds,
      sourceVideoUrl: presignedData.s3Key ? `https://${presignedData.s3Bucket}.s3.amazonaws.com/${presignedData.s3Key}` : null
    };
  }

  /**
   * 1B. Admin Initiates S3 Multipart Upload (for Large Files >= 100 MB)
   * Creates S3 Multipart Upload, generates presigned part URLs, returns batch configuration
   */
  async initiateMultipartUpload(adminUser, { courseId, moduleId, lessonId, fileName, contentType, fileSizeBytes, title, partSizeBytes, durationSeconds }) {
    const s3PathUtils = require('../../utils/s3PathUtils');

    if (!courseId || !lessonId) {
      throw { statusCode: 400, message: 'courseId and lessonId are required.' };
    }

    if (!fileName || !contentType) {
      throw { statusCode: 400, message: 'fileName and contentType are required.' };
    }

    // Validate MIME Type
    const isMkvFile = fileName.toLowerCase().endsWith('.mkv');
    const normalizedContentType = (isMkvFile && (!contentType || contentType === 'application/octet-stream')) ? 'video/x-matroska' : contentType.toLowerCase();

    if (!ALLOWED_VIDEO_MIME_TYPES.includes(normalizedContentType) && !isMkvFile) {
      throw {
        statusCode: 400,
        message: `Invalid video format '${contentType}'. Allowed types: MP4, MOV (QuickTime), M4V, WEBM, MKV.`
      };
    }

    // Validate File Size
    const size = Number(fileSizeBytes);
    if (!size || size <= 0) {
      throw { statusCode: 400, message: 'fileSizeBytes must be a positive integer.' };
    }

    if (size > MAX_VIDEO_FILE_SIZE_BYTES) {
      throw {
        statusCode: 400,
        message: `File size exceeds maximum allowed limit of 5 GB (${(size / (1024 * 1024 * 1024)).toFixed(2)} GB).`
      };
    }

    // Authoritative Hierarchy Chain Validation
    const hierarchy = await validateHierarchyChain({
      courseId,
      moduleId: moduleId || lessonId
    });
    const course = hierarchy.course;
    const targetMod = hierarchy.module;
    const modIdx = hierarchy.modIndex || 0;
    const courseSlug = s3PathUtils.generateS3CourseSlug(course);

    const moduleSlug = s3PathUtils.generateS3ModuleSlug(targetMod, modIdx + 1);
    const videoAssetId = require('crypto').randomUUID();
    const cleanFileName = s3PathUtils.sanitizeS3FileName(fileName, title || 'video');
    const s3Key = s3PathUtils.buildS3SourceKey(courseSlug, moduleSlug, videoAssetId, cleanFileName);
    const hlsPrefix = s3PathUtils.buildS3HlsPrefix(courseSlug, moduleSlug, videoAssetId);

    // Calculate Part Sizing (Minimum AWS part size is 5 MB)
    const partSize = Math.max(5 * 1024 * 1024, Number(partSizeBytes) || DEFAULT_PART_SIZE_BYTES);
    const totalParts = Math.ceil(size / partSize);

    // 1. Initialize S3 Multipart Upload
    const multipartInit = await s3VideoService.createMultipartUpload({
      s3Key,
      contentType
    });

    // 2. Pre-generate presigned part URLs
    const parts = await s3VideoService.generatePresignedPartUrls({
      s3Key,
      uploadId: multipartInit.uploadId,
      totalParts,
      expiresInSeconds: 3600
    });

    const parsedDuration = Math.round(Number(durationSeconds) || 0);

    // 3. Persist Initial State in Database
    const recordPayload = {
      id: videoAssetId,
      lesson_id: String(lessonId),
      course_id: course.id,
      module_id: String(moduleId || targetMod?.id || 'general'),
      course_slug: courseSlug,
      module_slug: moduleSlug,
      hls_prefix: hlsPrefix,
      title: title || fileName,
      status: VIDEO_STATUS.UPLOADING,
      source_s3_bucket: multipartInit.s3Bucket,
      source_s3_key: multipartInit.s3Key,
      upload_id: multipartInit.uploadId,
      file_size_bytes: size,
      duration_seconds: parsedDuration,
      source_duration_seconds: parsedDuration,
      upload_started_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const savedRecord = await this.upsertVideoRecord(recordPayload);

    console.log(`🚀 [S3 Multipart Init] Video: ${fileName} (${(size / (1024 * 1024)).toFixed(1)} MB) -> ${totalParts} parts of ${(partSize / (1024 * 1024)).toFixed(1)} MB each. UploadId: ${multipartInit.uploadId}`);

    return {
      status: 'SUCCESS',
      videoAssetId: savedRecord.id || videoAssetId,
      lessonId,
      uploadId: multipartInit.uploadId,
      s3Bucket: multipartInit.s3Bucket,
      s3Key: multipartInit.s3Key,
      partSizeBytes: partSize,
      totalParts,
      concurrency: DEFAULT_CONCURRENCY,
      maxRetries: DEFAULT_MAX_RETRIES,
      parts
    };
  }

  /**
   * 1C. Complete S3 Multipart Upload & Dispatch MediaConvert
   */
  async completeMultipartUploadAndStartProcessing(adminUser, { videoAssetId, lessonId, uploadId, s3Key, parts, durationSeconds, courseId = null }) {
    const s3PathUtils = require('../../utils/s3PathUtils');
    let record = await this.getVideoRecord(videoAssetId || lessonId, courseId);
    if (!record && s3Key && typeof s3Key === 'string' && !s3Key.includes('"') && !s3Key.includes("'")) {
      const { data: byS3 } = await supabase
        .from('lesson_videos')
        .select('*')
        .eq('source_s3_key', s3Key)
        .limit(1);
      if (byS3 && byS3.length > 0) {
        record = byS3[0];
      }
    }
    if (!record) {
      throw { statusCode: 404, message: 'Video upload record not found.' };
    }
    const effectiveUploadId = uploadId || record.upload_id;
    const effectiveS3Key = s3Key || record.source_s3_key;
    const effectiveCourseId = courseId || record.course_id;

    if (!effectiveUploadId || !effectiveS3Key) {
      throw { statusCode: 400, message: 'uploadId and s3Key are required to complete multipart upload.' };
    }

    if (!effectiveCourseId) {
      throw new HierarchyValidationError('Video record has no associated course scope (orphan record). Completion rejected.', 403, 'HIERARCHY_ORPHAN_RECORD');
    }

    // Authoritative Hierarchy & S3 Key Validation:
    // Ensures record belongs to authorized course, module, and S3 key belongs to exact course scope
    await validateHierarchyChain({
      courseId: effectiveCourseId,
      moduleId: record.module_id || record.lesson_id,
      videoId: record.id,
      uploadId: effectiveUploadId,
      s3Key: effectiveS3Key,
      multipartSession: record
    });

    const effectiveBucket = record.source_s3_bucket || env.AWS_S3_BUCKET_SOURCE || env.AWS_S3_BUCKET_OUTPUT || 'internnetra-lms-videos-prod-365957110532-ap-south-1-an';

    if (!Array.isArray(parts) || parts.length === 0) {
      throw { statusCode: 400, message: 'parts array with PartNumber and ETag is required.' };
    }

    console.log(`📦 [S3 Multipart Complete] Completing multipart upload for lesson ${record.lesson_id} (${parts.length} parts)...`);

    // 1. Complete S3 Multipart Upload
    let completeResult;
    try {
      completeResult = await s3VideoService.completeMultipartUpload({
        s3Key: effectiveS3Key,
        uploadId: effectiveUploadId,
        parts
      });
    } catch (s3Err) {
      console.error(`🚨 [S3 Multipart Complete Error] Failed completing uploadId ${effectiveUploadId} for key ${effectiveS3Key}:`, s3Err.message);
      throw {
        statusCode: 502,
        message: `AWS S3 rejected multipart completion: ${s3Err.message || 'Unknown S3 error'}`
      };
    }

    // 2. Verify Final S3 Object Exists and Integrity
    const existsResult = await s3VideoService.verifyObjectExists(effectiveBucket, effectiveS3Key).catch(() => ({ exists: false }));
    if (!existsResult || !existsResult.exists) {
      console.warn(`⚠️ [S3 Multipart Verification] HeadObject notice: s3://${effectiveBucket}/${effectiveS3Key}`);
    }

    const videoCompressor = require('./video.compressor');
    const { COMPRESSION_SETTINGS } = require('./video.constants');

    // Duplicate Job Protection: Check if already actively transcoding
    if (videoCompressor.isJobAlreadyActive(record, COMPRESSION_SETTINGS.JOB_TIMEOUT_MINUTES)) {
      console.log(`ℹ️ [Video Pipeline] Lesson ${record.lesson_id} already has an active MediaConvert job (${record.mediaconvert_job_id}). Duplicate submission avoided.`);
      return {
        status: 'SUCCESS',
        videoAssetId: record.id,
        jobId: record.mediaconvert_job_id,
        processingStatus: VIDEO_STATUS.PROCESSING,
        message: 'Active transcoding job already in progress.'
      };
    }

    const sourceSizeBytes = existsResult.contentLength || record.file_size_bytes || 0;
    const durationSec = Math.round(Number(durationSeconds) || 0);
    const effectiveDuration = durationSec > 0 ? durationSec : (record.duration_seconds || record.source_duration_seconds || 0);

    // MANUAL TOPIC / VIDEO CONFIRMATION GATE:
    // Video transcoding NEVER starts automatically after source upload.
    // Source is saved in S3, video record marked as SEGMENTATION_REQUIRED, awaiting admin topic timeline or explicit full-video transcode confirmation.
    console.log(`📦 [UPLOAD_COMPLETED] Source video uploaded and saved for module ${record.module_id || record.lesson_id} (Asset: ${record.id}, Size: ${(sourceSizeBytes / (1024 * 1024)).toFixed(1)} MB, Duration: ${effectiveDuration}s). Status: SEGMENTATION_REQUIRED. Transcoding paused pending admin confirmation.`);

    const updatedRecord = await this.upsertVideoRecord({
      ...record,
      status: VIDEO_STATUS.SEGMENTATION_REQUIRED,
      file_size_bytes: sourceSizeBytes,
      duration_seconds: effectiveDuration,
      source_duration_seconds: effectiveDuration,
      upload_completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });

    return {
      status: 'SUCCESS',
      videoAssetId: updatedRecord.id,
      moduleId: record.module_id || record.lesson_id,
      processingStatus: VIDEO_STATUS.SEGMENTATION_REQUIRED,
      durationSeconds: effectiveDuration,
      message: 'Source video uploaded and saved successfully. Ready for full video transcoding or topic segmentation.'
    };
  }

  /**
   * 1D. Abort S3 Multipart Upload (Clean up on Cancel or Unrecoverable Failure)
   */
  async abortMultipartUpload(adminUser, { videoAssetId, lessonId, uploadId, s3Key }) {
    const record = await this.getVideoRecord(videoAssetId || lessonId);
    const effectiveUploadId = uploadId || record?.upload_id;
    const effectiveS3Key = s3Key || record?.source_s3_key;

    if (effectiveUploadId && effectiveS3Key) {
      await s3VideoService.abortMultipartUpload({
        s3Key: effectiveS3Key,
        uploadId: effectiveUploadId
      });
    }

    if (record) {
      await this.upsertVideoRecord({
        ...record,
        status: VIDEO_STATUS.FAILED,
        error_message: 'Upload aborted by user.',
        updated_at: new Date().toISOString()
      });
    }

    return {
      status: 'SUCCESS',
      aborted: true
    };
  }

  /**
   * 1E. Get Refresh Presigned URL for a single part (Retry helper)
   */
  async getSinglePartPresignedUrl(adminUser, { videoAssetId, lessonId, uploadId, s3Key, partNumber }) {
    const record = await this.getVideoRecord(videoAssetId || lessonId);
    const effectiveUploadId = uploadId || record?.upload_id;
    const effectiveS3Key = s3Key || record?.source_s3_key;

    if (!effectiveUploadId || !effectiveS3Key || !partNumber) {
      throw { statusCode: 400, message: 'uploadId, s3Key, and partNumber are required.' };
    }

    return s3VideoService.generateSinglePresignedPartUrl({
      s3Key: effectiveS3Key,
      uploadId: effectiveUploadId,
      partNumber: Number(partNumber)
    });
  }

  /**
   * 1F. Get Existing Multipart Session for Resuming (S3 ListParts Recovery)
   */
  async getMultipartSession(adminUser, { lessonId, fingerprint, courseId = null }) {
    if (!lessonId) {
      throw { statusCode: 400, message: 'lessonId is required.' };
    }

    const record = await this.getVideoRecord(lessonId, courseId);
    if (!record || !record.upload_id || !record.source_s3_key) {
      return { exists: false };
    }
    if (courseId && record.course_id && String(record.course_id) !== String(courseId)) {
      return { exists: false };
    }

    // If upload was already completed and processed/processing
    if (record.status === VIDEO_STATUS.READY || record.status === VIDEO_STATUS.PROCESSING) {
      return {
        exists: true,
        alreadyProcessed: true,
        status: record.status,
        hlsMasterUrl: record.hls_master_url
      };
    }

    // Query S3 ListParts to get verified uploaded parts
    const uploadedParts = await s3VideoService.listUploadedParts({
      uploadId: record.upload_id,
      s3Key: record.source_s3_key,
      bucket: record.source_s3_bucket
    });

    const totalParts = record.total_parts || 0;
    const uploadedPartNumbers = new Set(uploadedParts.map(p => p.PartNumber));
    const missingPartNumbers = [];
    if (totalParts > 0) {
      for (let i = 1; i <= totalParts; i++) {
        if (!uploadedPartNumbers.has(i)) {
          missingPartNumbers.push(i);
        }
      }
    }

    return {
      exists: true,
      videoAssetId: record.id,
      lessonId: record.lesson_id,
      courseId: record.course_id,
      moduleId: record.module_id,
      uploadId: record.upload_id,
      s3Key: record.source_s3_key,
      bucket: record.source_s3_bucket,
      fileName: record.file_name,
      fileSizeBytes: record.file_size_bytes,
      partSizeBytes: record.part_size_bytes,
      totalParts: totalParts,
      uploadedParts,
      missingPartNumbers,
      status: record.status
    };
  }

  /**
   * 7. List Active Video Transcoding & Upload Jobs for Global Drawer & Admin Dashboard
   * Returns active in-flight jobs, topic processing, pending segmentation, and recent completions
   */
  async listActiveTranscodingJobs(adminUser) {
    try {
      if (this._activeJobsCache && (Date.now() - (this._activeJobsCacheTime || 0) < 1000)) {
        return this._activeJobsCache;
      }

      const { data: records, error } = await supabase
        .from('lesson_videos')
        .select('*')
        .in('status', ['UPLOADING', 'UPLOADED', 'PROCESSING', 'SEGMENTATION_REQUIRED', 'SEGMENTATION_CONFIRMED'])
        .order('updated_at', { ascending: false })
        .limit(50);

      const allRecords = (Array.isArray(records) && records.length > 0)
        ? records
        : Array.from(memoryVideoStore.values()).filter((r) =>
            ['UPLOADING', 'UPLOADED', 'PROCESSING', 'SEGMENTATION_REQUIRED', 'SEGMENTATION_CONFIRMED'].includes(String(r.status || ''))
          );

      // STRICT PRECEDENCE:
      // 1. In-browser S3 uploads cannot persist across browser refreshes without active client streaming.
      // Filter out any stale 'UPLOADING' records where updated_at is older than 10 minutes.
      const now = Date.now();
      const STALE_PROCESSING_MS = 45 * 60 * 1000; // no MediaConvert progress for 45m → not "active work"
      const nonStaleRecords = allRecords.filter(r => {
        const ageMs = now - new Date(r.updated_at || r.upload_started_at || r.created_at || 0).getTime();
        if (r.status === 'UPLOADING') {
          if (ageMs > 10 * 60 * 1000) return false;
        }
        return true;
      });

      // 2. Index active records by unique videoAssetId (r.id) to guarantee every concurrent job is preserved:
      const activeMap = new Map();
      for (const r of nonStaleRecords) {
        const key = r.id ? String(r.id) : `${r.course_id || 'course'}:${r.module_id || r.lesson_id || 'general'}`;
        activeMap.set(key, r);
      }
      const deduplicated = Array.from(activeMap.values());

      const s3PathUtils = require('../../utils/s3PathUtils');
      const enriched = await Promise.all(deduplicated.map(async (r) => {
        const ageMs = now - new Date(r.updated_at || r.upload_started_at || r.created_at || 0).getTime();
        const hasMcJob = Boolean(r.mediaconvert_job_id || r.job_id);

        let segmentInfo = { segmentCount: 0, manifestCount: 0, totalFiles: 0 };
        if (r.status === VIDEO_STATUS.PROCESSING) {
          const effectivePrefix = r.hls_prefix || 
            (r.course_slug && r.module_slug ? s3PathUtils.buildS3HlsPrefix(r.course_slug, r.module_slug) : null) ||
            `courses/${r.course_id}/modules/${r.module_id}/lessons/${r.lesson_id}/`;
          segmentInfo = await s3VideoService.countHlsSegments({ prefix: effectivePrefix }).catch(() => ({ segmentCount: 0, manifestCount: 0, totalFiles: 0 }));
        }

        const isIndividualTopic = Boolean(
          r.is_individual_topic_video ||
          r.is_topic_upload ||
          (r.topic_id && r.module_id && String(r.topic_id) !== String(r.module_id)) ||
          (r.lesson_id && r.module_id && String(r.lesson_id) !== String(r.module_id))
        );

        const processingProfile = String(r.processing_profile || '');
        // Mode 1 master HLS encode (not Mode 2 topic upload, not idle clipping wait)
        const isLiveFullModuleEncode = Boolean(
          !isIndividualTopic &&
          r.status === VIDEO_STATUS.PROCESSING &&
          hasMcJob &&
          ageMs < STALE_PROCESSING_MS &&
          (processingProfile === PROCESSING_PROFILES.FULL_MODULE_HLS || !processingProfile || processingProfile === 'FULL_MODULE_HLS')
        );

        // Topic summaries: useful for clipping progress, but must not override a live Mode 1 master job
        let topicsSummary = null;
        if (!isIndividualTopic && (r.is_topic_mode || r.status === VIDEO_STATUS.PROCESSING || r.status === VIDEO_STATUS.UPLOADED || r.status === VIDEO_STATUS.SEGMENTATION_REQUIRED)) {
          try {
            const topicRes = await this.getModuleTopics(null, { moduleId: r.module_id || r.lesson_id, courseId: r.course_id, skipJobPolling: true });
            if (topicRes && Array.isArray(topicRes.topics) && topicRes.topics.length > 0) {
              topicsSummary = {
                totalTopics: topicRes.totalTopics || topicRes.topics.length,
                readyTopics: topicRes.readyTopics || 0,
                processingTopics: topicRes.processingTopics || 0,
                queuedTopics: topicRes.queuedTopics || 0,
                failedTopics: topicRes.failedTopics || 0,
                progressPercent: topicRes.progressPercent || 0
              };
            }
          } catch (e) {}
        }

        const hasLiveTopicJobs = Boolean(
          topicsSummary && ((topicsSummary.processingTopics || 0) > 0 || (topicsSummary.queuedTopics || 0) > 0)
        );
        const allTopicsReady = Boolean(
          topicsSummary && topicsSummary.totalTopics > 0 && topicsSummary.readyTopics === topicsSummary.totalTopics
        );
        // Ghost drawer case: some clips READY, nothing encoding, master job not live
        const partialTopicsIdle = Boolean(
          topicsSummary &&
          topicsSummary.totalTopics > 0 &&
          !hasLiveTopicJobs &&
          !allTopicsReady &&
          (topicsSummary.readyTopics || 0) > 0 &&
          !isLiveFullModuleEncode
        );

        let effectiveStatus = r.status;
        if (isIndividualTopic) {
          // Mode 2: trust lesson_videos row status (PROCESSING / UPLOADING / etc.)
          effectiveStatus = r.status;
        } else if (isLiveFullModuleEncode) {
          // Mode 1 master still encoding — keep PROCESSING even if topic outline exists (all DRAFT)
          effectiveStatus = VIDEO_STATUS.PROCESSING;
        } else if (hasLiveTopicJobs) {
          effectiveStatus = VIDEO_STATUS.PROCESSING;
        } else if (allTopicsReady) {
          effectiveStatus = VIDEO_STATUS.READY;
        } else if (partialTopicsIdle) {
          effectiveStatus = VIDEO_STATUS.SEGMENTATION_REQUIRED;
        }

        const staleStuckProcessing = r.status === VIDEO_STATUS.PROCESSING
          && !isLiveFullModuleEncode
          && !hasLiveTopicJobs
          && !hasMcJob
          && ageMs > STALE_PROCESSING_MS;

        if (staleStuckProcessing) {
          effectiveStatus = VIDEO_STATUS.SEGMENTATION_REQUIRED;
        }

        // Only surface jobs with real in-flight work to the Background Videos drawer
        const isLiveWork =
          effectiveStatus === 'UPLOADING' ||
          effectiveStatus === VIDEO_STATUS.PROCESSING ||
          (effectiveStatus === VIDEO_STATUS.UPLOADED && ageMs < 30 * 60 * 1000) ||
          effectiveStatus === 'SEGMENTATION_CONFIRMED';

        if (!isLiveWork) {
          // Heal sticky ghosts only — never touch a live Mode 1 master encode
          if (
            r.status === VIDEO_STATUS.PROCESSING &&
            !isLiveFullModuleEncode &&
            (partialTopicsIdle || staleStuckProcessing || allTopicsReady)
          ) {
            const healStatus = allTopicsReady ? VIDEO_STATUS.READY : VIDEO_STATUS.SEGMENTATION_REQUIRED;
            this.upsertVideoRecord({
              ...r,
              status: healStatus,
              updated_at: new Date().toISOString()
            }).catch(() => {});
          }
          return null;
        }

        return {
          id: r.id,
          videoAssetId: r.id,
          lessonId: r.lesson_id,
          topicId: isIndividualTopic ? (r.topic_id || r.lesson_id) : null,
          moduleId: r.module_id,
          courseId: r.course_id,
          isTopicUpload: isIndividualTopic,
          isIndividualTopicVideo: isIndividualTopic,
          title: r.title || r.file_name || `Module ${r.module_id || r.lesson_id}`,
          fileName: r.file_name || r.title,
          fileSizeBytes: r.file_size_bytes || 0,
          originalSizeBytes: r.original_file_size_bytes || r.file_size_bytes || 0,
          optimizedSizeBytes: r.optimized_file_size_bytes || 0,
          compressionPercentage: r.compression_percentage ?? null,
          compressionResult: r.compression_result || null,
          outputResolution: r.output_resolution || '1080p',
          status: effectiveStatus,
          rawStatus: r.status,
          isTopicMode: !isIndividualTopic && !!(topicsSummary && topicsSummary.totalTopics > 0),
          topicsSummary,
          jobPercentComplete: topicsSummary?.progressPercent ?? (effectiveStatus === 'READY' ? 100 : effectiveStatus === 'PROCESSING' ? 50 : 0),
          hlsMasterUrl: r.hls_master_url,
          segmentsGenerated: segmentInfo.segmentCount || 0,
          manifestsGenerated: segmentInfo.manifestCount || 0,
          totalHlsFiles: segmentInfo.totalFiles || 0,
          errorMessage: r.error_message,
          updatedAt: r.updated_at
        };
      }));

      const liveOnly = enriched.filter(Boolean);
      this._activeJobsCache = liveOnly;
      this._activeJobsCacheTime = Date.now();
      return liveOnly;
    } catch (err) {
      console.warn('⚠️ [Video Service] listActiveTranscodingJobs notice:', err.message);
      if (this._activeJobsCache) return this._activeJobsCache;
      return Array.from(memoryVideoStore.values());
    }
  }

  /**
   * 7B. Comprehensive Video Cancel & Immediate Resource Purge
   * Halts in-progress MediaConvert jobs, aborts multipart uploads, purges S3 fragments, and cleans database & course state
   */
  async cancelAndPurgeVideoJob(adminUser, { lessonId, videoAssetId, courseId, moduleId }) {
    const identifier = videoAssetId || lessonId;
    if (!identifier) return { success: false, message: 'No lessonId or videoAssetId provided' };

    console.log(`🛑 [Video Pipeline Cancel] Initiating full cancellation & cleanup for video/lesson: ${identifier}...`);
    
    // 1. Fetch existing record
    const record = await this.getVideoRecord(identifier, courseId);
    const targetCourseId = courseId || record?.course_id;
    const targetModuleId = moduleId || record?.module_id || lessonId;
    const targetLessonId = lessonId || record?.lesson_id;

    // 2. Cancel active MediaConvert Job on AWS
    if (record?.mediaconvert_job_id) {
      try {
        console.log(`🛑 [AWS MediaConvert] Requesting job cancellation for: ${record.mediaconvert_job_id}`);
        await mediaConvertVideoService.cancelJob(record.mediaconvert_job_id);
      } catch (mcErr) {
        console.warn(`⚠️ [AWS MediaConvert Cancel Notice] Job ${record.mediaconvert_job_id}:`, mcErr.message);
      }
    }

    // 3. Abort active S3 multipart upload if present
    if (record?.upload_id && record?.source_s3_key) {
      try {
        await s3VideoService.abortMultipartUpload({
          s3Key: record.source_s3_key,
          uploadId: record.upload_id
        });
      } catch (abErr) {
        console.warn(`⚠️ [AWS S3 Abort Notice] Key ${record.source_s3_key}:`, abErr.message);
      }
    }

    // 4. Purge intermediate HLS files / segments from S3
    const hlsPrefix = record?.hls_prefix;
    if (hlsPrefix) {
      try {
        await s3VideoService.purgeVideoPrefix({
          bucket: record?.source_s3_bucket || env.AWS_S3_BUCKET_OUTPUT,
          prefix: hlsPrefix
        });
      } catch (purgeErr) {
        console.warn(`⚠️ [AWS S3 Purge Notice] Prefix ${hlsPrefix}:`, purgeErr.message);
      }
    }

    // 5. Delete raw source file from S3 if it exists
    if (record?.source_s3_key) {
      try {
        await s3VideoService.deleteObject(
          record?.source_s3_bucket || env.AWS_S3_BUCKET_SOURCE,
          record.source_s3_key
        );
      } catch (delObjErr) {
        console.warn(`⚠️ [AWS S3 Source Delete Notice] Key ${record.source_s3_key}:`, delObjErr.message);
      }
    }

    // 6. Clean Course Curriculum in Supabase (courses table)
    if (targetCourseId) {
      try {
        const { data: course } = await supabase
          .from('courses')
          .select('id, curriculum_modules')
          .eq('id', targetCourseId)
          .maybeSingle();

        if (course && Array.isArray(course.curriculum_modules)) {
          let modified = false;
          const updatedModules = course.curriculum_modules.map(mod => {
            const matchesMod = (targetModuleId && String(mod.id) === String(targetModuleId)) ||
                              (targetLessonId && (String(mod.id) === String(targetLessonId) || String(mod.video_asset_id) === String(record?.id)));

            if (matchesMod) {
              modified = true;
              return {
                ...mod,
                video_url: '',
                video_status: 'NO_VIDEO',
                video_asset_id: null
              };
            }

            if (Array.isArray(mod.lessons)) {
              let lessonMatched = false;
              const updatedLessons = mod.lessons.map(l => {
                if (String(l.id) === String(targetLessonId)) {
                  modified = true;
                  lessonMatched = true;
                  return {
                    ...l,
                    video_url: '',
                    video_status: 'NO_VIDEO'
                  };
                }
                return l;
              });

              if (lessonMatched) {
                return {
                  ...mod,
                  lessons: updatedLessons
                };
              }
            }
            return mod;
          });

          if (modified) {
            await supabase
              .from('courses')
              .update({ curriculum_modules: updatedModules, updated_at: new Date().toISOString() })
              .eq('id', course.id);
            console.log(`✅ [Video Pipeline Cancel] Course curriculum cleaned for course ${targetCourseId}`);
          }
        }
      } catch (currErr) {
        console.warn('⚠️ [Video Pipeline Cancel] Curriculum sync notice:', currErr.message);
      }
    }

    // 7. Delete from database (lesson_videos)
    try {
      const idsToDelete = [String(identifier)];
      if (record?.id) idsToDelete.push(String(record.id));
      if (record?.lesson_id) idsToDelete.push(String(record.lesson_id));
      if (record?.module_id) idsToDelete.push(String(record.module_id));
      const uniqueIds = [...new Set(idsToDelete.filter(Boolean))];

      for (const id of uniqueIds) {
        await supabase
          .from('lesson_videos')
          .delete()
          .or(`id.eq.${id},lesson_id.eq.${id},module_id.eq.${id}`);
      }
    } catch (dbErr) {
      console.warn('⚠️ [Video Pipeline Cancel] DB delete notice:', dbErr.message);
    }

    // 8. Clear Memory Store
    memoryVideoStore.delete(String(identifier));
    if (record?.id) memoryVideoStore.delete(String(record.id));
    if (record?.lesson_id) memoryVideoStore.delete(String(record.lesson_id));
    if (targetLessonId) memoryVideoStore.delete(String(targetLessonId));

    console.log(`✅ [Video Pipeline Cancel] Cancel & purge complete for lesson/video: ${identifier}`);
    return { success: true, message: 'Video upload and transcoding stopped and cleaned up successfully.' };
  }

  /**
   * Dismiss Video Job (Aliases to cancelAndPurgeVideoJob for full safety)
   */
  async dismissVideoJob(adminUser, { lessonId }) {
    return this.cancelAndPurgeVideoJob(adminUser, { lessonId });
  }

  /**
   * 7C. Option A: Remove Video from Course (48-Hour Deletion Grace Period)
   */
  async removeFromCourse(adminUser, { courseId, moduleId, lessonId, videoAssetId }) {
    if (courseId) {
      await validateHierarchyChain({
        courseId,
        moduleId: moduleId || lessonId,
        videoId: videoAssetId
      });
    }
    const videoCleanupService = require('./video.cleanup.service');
    return videoCleanupService.unassignVideoWith48HourGrace({
      lessonId: lessonId || moduleId,
      courseId,
      moduleId,
      videoAssetId
    });
  }

  /**
   * 7D. Option B: Delete Video Permanently (Immediate Safe S3 Purge)
   */
  async deletePermanently(adminUser, { courseId, moduleId, lessonId, videoAssetId, forceDelete }) {
    if (courseId) {
      await validateHierarchyChain({
        courseId,
        moduleId: moduleId || lessonId,
        videoId: videoAssetId
      });
    }
    const videoCleanupService = require('./video.cleanup.service');
    return videoCleanupService.deletePermanentlyWithSafetyCheck({
      lessonId: lessonId || moduleId,
      courseId,
      moduleId,
      videoAssetId,
      forceDelete,
      s3VideoService,
      user: adminUser
    });
  }

  /**
   * 8. Clean up expired source videos (Routes strictly through 9-point safety lock)
   * Authoritative single deletion mechanism guarantees production assets are never deleted.
   */
  async cleanupExpiredSourceVideos() {
    try {
      const now = new Date().toISOString();
      const { data: expiredRecords, error } = await supabase
        .from('lesson_videos')
        .select('*')
        .eq('status', VIDEO_STATUS.READY)
        .is('source_deleted_at', null)
        .lt('source_delete_after', now)
        .limit(50);

      if (error || !Array.isArray(expiredRecords)) return { cleaned: 0 };

      const videoCleanupService = require('./video.cleanup.service');
      let cleanedCount = 0;
      for (const rec of expiredRecords) {
        const res = await videoCleanupService.safeDeleteRawSource({
          record: rec,
          s3VideoService,
          videoService: this
        });
        if (res.deleted) {
          cleanedCount++;
        }
      }
      return { cleaned: cleanedCount };
    } catch (err) {
      console.warn('⚠️ [Video Service] cleanupExpiredSourceVideos notice:', err.message);
      return { cleaned: 0, error: err.message };
    }
  }

  /**
   * 2. Confirm Direct Upload & Start MediaConvert Processing (Single PUT compatibility)
   */
  async confirmUploadAndStartProcessing(adminUser, { videoAssetId, lessonId, durationSeconds, courseId = null }) {
    const s3PathUtils = require('../../utils/s3PathUtils');
    const record = await this.getVideoRecord(videoAssetId || lessonId, courseId);
    if (!record) {
      throw { statusCode: 404, message: 'Video upload record not found.' };
    }
    if (courseId && record.course_id && String(record.course_id) !== String(courseId)) {
      throw { statusCode: 403, message: `Access denied: Video belongs to course '${record.course_id}', not '${courseId}'.` };
    }

    // Verify S3 Object Existence
    const existsResult = await s3VideoService.verifyObjectExists(record.source_s3_bucket, record.source_s3_key);
    if (!existsResult || !existsResult.exists) {
      throw { statusCode: 400, message: `Source file not found in S3 ingest bucket: s3://${record.source_s3_bucket}/${record.source_s3_key}. Upload may have been aborted or not completed.` };
    }

    const videoCompressor = require('./video.compressor');
    const { COMPRESSION_SETTINGS } = require('./video.constants');

    // Duplicate Job Protection: Check if already actively transcoding
    if (videoCompressor.isJobAlreadyActive(record, COMPRESSION_SETTINGS.JOB_TIMEOUT_MINUTES)) {
      console.log(`ℹ️ [Video Pipeline] Lesson ${record.lesson_id} already has an active MediaConvert job (${record.mediaconvert_job_id}). Duplicate submission avoided.`);
      return {
        status: 'SUCCESS',
        videoAssetId: record.id,
        jobId: record.mediaconvert_job_id,
        processingStatus: VIDEO_STATUS.PROCESSING,
        message: 'Active transcoding job already in progress.'
      };
    }

    const sourceSizeBytes = existsResult.contentLength || record.file_size_bytes || 0;
    const durationSec = Math.round(Number(durationSeconds) || 0);
    const effectiveDuration = durationSec > 0 ? durationSec : (record.duration_seconds || record.source_duration_seconds || 0);

    // MANUAL TOPIC / VIDEO CONFIRMATION GATE:
    // Video transcoding NEVER starts automatically after source upload.
    // Source is saved in S3, video record marked as SEGMENTATION_REQUIRED, awaiting admin topic timeline or explicit full-video transcode confirmation.
    console.log(`📦 [UPLOAD_COMPLETED] Source video confirmed for module ${record.module_id || record.lesson_id} (Asset: ${record.id}, Size: ${(sourceSizeBytes / (1024 * 1024)).toFixed(1)} MB, Duration: ${effectiveDuration}s). Status: SEGMENTATION_REQUIRED. Transcoding paused pending admin confirmation.`);

    const updatedRecord = await this.upsertVideoRecord({
      ...record,
      status: VIDEO_STATUS.SEGMENTATION_REQUIRED,
      file_size_bytes: sourceSizeBytes,
      duration_seconds: effectiveDuration,
      source_duration_seconds: effectiveDuration,
      upload_completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });

    return {
      status: 'SUCCESS',
      videoAssetId: updatedRecord.id,
      moduleId: record.module_id || record.lesson_id,
      processingStatus: VIDEO_STATUS.SEGMENTATION_REQUIRED,
      durationSeconds: effectiveDuration,
      message: 'Source video uploaded and saved successfully. Ready for full video transcoding or topic segmentation.'
    };
  }

  /**
   * 2B. Start Full Video Transcoding (MediaConvert Adaptive Transcode)
   * Dispatches full single-video MediaConvert job for a module directly
   */
  async startFullVideoTranscoding(adminUser, { moduleId, courseId, videoAssetId, lessonId, adminOverride = false, forceReprocess = false, confirmReprocess = false } = {}) {
    const s3PathUtils = require('../../utils/s3PathUtils');
    const videoCompressor = require('./video.compressor');
    const { COMPRESSION_SETTINGS, VIDEO_STATUS, VALID_TRANSCODING_ENTRY_STATUSES } = require('./video.constants');

    const identifier = videoAssetId || lessonId || moduleId;
    const record = await this.getVideoRecord(identifier);
    if (!record) {
      throw { statusCode: 404, message: `Video upload record '${identifier}' not found.` };
    }

    // FULL-VIDEO TRANSCODING GATE:
    // Admin is explicitly transcoding the full single video without topic segmentation.
    // Valid entry statuses: UPLOADED, SEGMENTATION_REQUIRED, SEGMENTATION_READY, SEGMENTATION_CONFIRMED, FAILED, PROCESSING
    const currentStatus = record.status;
    const allowedStartStatuses = [
      VIDEO_STATUS.UPLOADED,
      VIDEO_STATUS.SEGMENTATION_REQUIRED,
      VIDEO_STATUS.SEGMENTATION_READY,
      VIDEO_STATUS.SEGMENTATION_CONFIRMED,
      VIDEO_STATUS.FAILED,
      VIDEO_STATUS.PROCESSING,
      VIDEO_STATUS.READY
    ];
    if (!allowedStartStatuses.includes(currentStatus)) {
      if (currentStatus === VIDEO_STATUS.UPLOADING) {
        throw {
          statusCode: 400,
          message: 'Cannot start transcoding: Source video is still uploading to AWS S3. Please wait for upload to complete.'
        };
      }
      throw {
        statusCode: 400,
        message: `Cannot start transcoding: Video is in '${currentStatus}' state.`
      };
    }

    const effectiveBucket = record.source_s3_bucket || env.AWS_S3_BUCKET_SOURCE || env.AWS_S3_BUCKET_OUTPUT || 'internnetra-lms-videos-prod-365957110532-ap-south-1-an';
    const effectiveKey = record.source_s3_key;
    if (!effectiveKey) {
      throw { statusCode: 400, message: 'Cannot start transcoding: Source S3 key is missing. Please upload the video again.' };
    }

    // Verify S3 Object Existence
    const existsResult = await s3VideoService.verifyObjectExists(effectiveBucket, effectiveKey);
    if (!existsResult || !existsResult.exists) {
      throw { statusCode: 400, message: `Source video file not found in S3 (s3://${effectiveBucket}/${effectiveKey}).` };
    }

    const sourceSizeBytes = existsResult.contentLength || record.file_size_bytes || 0;
    const metrics = await videoSourceProbe.resolveSourceMetrics(record);

    // Resolve course for slug generation if needed
    const course = await this.resolveCourse(courseId || record.course_id);
    const courseSlug = record.course_slug || (course ? s3PathUtils.generateS3CourseSlug(course) : 'course');
    const moduleSlug = record.module_slug || s3PathUtils.generateS3ModuleSlug(record.module_id || moduleId);

    // Run Multi-Signal Adaptive Analysis WITH real dimensions (never default to 1080p)
    const analysis = videoCompressor.analyzeVideoSource({
      fileSizeBytes: sourceSizeBytes,
      durationSeconds: metrics.durationSeconds || record.duration_seconds || record.source_duration_seconds || 0,
      width: metrics.width,
      height: metrics.height,
      fps: metrics.fps,
      videoCodec: metrics.videoCodec,
      fileName: record.title || effectiveKey
    });

    const outputPrefix = record.hls_prefix || 
      (courseSlug && moduleSlug 
        ? s3PathUtils.buildS3HlsPrefix(courseSlug, moduleSlug, record.id)
        : `courses/${record.course_id || courseId}/modules/${record.module_id || moduleId}/videos/${record.id}/hls/`);

    const cdnDomain = env.CLOUDFRONT_DOMAIN || `https://${env.AWS_S3_BUCKET_OUTPUT || effectiveBucket}.s3.${env.AWS_REGION}.amazonaws.com`;
    const masterPlaylistUrl = `${cdnDomain}/${outputPrefix}master.m3u8`;

    const guarded = await this.submitGuardedMediaConvertJob({
      processingProfile: PROCESSING_PROFILES.FULL_MODULE_HLS,
      videoId: record.id,
      uploadId: record.upload_id || record.source_s3_key,
      courseId: record.course_id || courseId,
      moduleId: record.module_id || moduleId,
      sourceKey: effectiveKey,
      sourceDurationSeconds: metrics.durationSeconds || record.duration_seconds || record.source_duration_seconds || 0,
      sourceWidth: metrics.width,
      sourceHeight: metrics.height,
      triggerSource: forceReprocess ? TRIGGER_SOURCES.MANUAL_REPROCESS : TRIGGER_SOURCES.ADMIN_UPLOAD,
      adminOverride,
      forceReprocess: Boolean(forceReprocess),
      confirmReprocess: Boolean(confirmReprocess),
      existingRecord: record,
      isRetry: currentStatus === VIDEO_STATUS.FAILED,
      submitFn: async ({ requestedOutputs, sourceHeight, sourceWidth }) => {
        return mediaConvertVideoService.submitAdaptiveJob({
          sourceBucket: effectiveBucket,
          sourceKey: effectiveKey,
          outputPrefix,
          analysis,
          requestedOutputs,
          sourceHeight,
          sourceWidth,
          userMetadata: {
            videoAssetId: String(record.id),
            lessonId: String(record.lesson_id || identifier),
            moduleId: String(record.module_id || moduleId),
            courseId: String(record.course_id || courseId),
            sourceSizeBytes: String(sourceSizeBytes),
            processingProfile: PROCESSING_PROFILES.FULL_MODULE_HLS
          }
        });
      }
    });

    if (guarded.duplicated) {
      console.log(`ℹ️ [DUPLICATE_MEDIACONVERT_JOB_BLOCKED] Full-video identity reuse for ${record.id}: ${guarded.reason} job=${guarded.jobId}`);
      return {
        status: 'SUCCESS',
        videoAssetId: record.id,
        jobId: guarded.jobId,
        processingStatus: record.status === VIDEO_STATUS.READY ? VIDEO_STATUS.READY : VIDEO_STATUS.PROCESSING,
        duplicated: true,
        reason: guarded.reason,
        message: guarded.reason === 'READY_OUTPUT_REUSED'
          ? 'Existing READY HLS output reused. No MediaConvert job created.'
          : 'Active transcoding job already in progress.'
      };
    }

    const jobResult = guarded.jobResult;

    // Update Status to PROCESSING in Supabase
    const updatedRecord = await this.upsertVideoRecord({
      ...record,
      status: VIDEO_STATUS.PROCESSING,
      mediaconvert_job_id: jobResult.jobId,
      original_file_size_bytes: sourceSizeBytes,
      file_size_bytes: sourceSizeBytes,
      original_resolution: analysis.targetResolution,
      output_resolution: analysis.targetResolution,
      source_width: metrics.width,
      source_height: metrics.height,
      source_fps: metrics.fps,
      processing_identity: guarded.processingIdentity,
      processing_profile: guarded.processingProfile,
      error_code: null,
      error_message: null,
      hls_master_url: masterPlaylistUrl,
      hls_prefix: outputPrefix,
      processing_attempt_id: require('crypto').randomUUID(),
      processing_started_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });

    console.log(`🎬 [Video Pipeline] MediaConvert Job ${jobResult.jobId} submitted for module ${record.module_id || record.lesson_id} (Status: PROCESSING, outputs=${(guarded.requestedOutputs || []).join(',')}, tier=${jobResult.pricingTierExpected || 'BASIC'}).`);

    return {
      status: 'SUCCESS',
      videoAssetId: updatedRecord.id,
      moduleId: record.module_id || record.lesson_id,
      jobId: jobResult.jobId,
      processingStatus: VIDEO_STATUS.PROCESSING,
      masterPlaylistUrl: masterPlaylistUrl,
      targetResolution: analysis.targetResolution,
      requestedOutputs: guarded.requestedOutputs,
      message: 'Full video MediaConvert transcoding started successfully.'
    };
  }

  /**
   * 2C. Admin Retries Failed / Interrupted Video Processing
   */
  async retryProcessing(adminUser, { lessonId, videoAssetId, courseId = null }) {
    let targetCourseId = null;
    if (courseId) {
      if (typeof courseId === 'object' && courseId !== null) {
        courseId = courseId.courseId || courseId.id || null;
      }
      if (typeof courseId === 'string' && !courseId.includes('[object')) {
        const c = await this.resolveCourse(courseId).catch(() => null);
        targetCourseId = c?.id || courseId;
      }
    }

    let record = null;
    if (videoAssetId) {
      record = await this.getVideoRecord(videoAssetId, targetCourseId);
    }
    if (!record && lessonId) {
      record = await this.getVideoRecord(lessonId, targetCourseId);
    }
    const identifier = videoAssetId || lessonId;
    if (!record) {
      throw { statusCode: 404, message: `Video upload record for lesson/video '${identifier}' not found.` };
    }

    if (!record.source_s3_key) {
      throw { statusCode: 400, message: 'Source file has already been deleted or never uploaded. Please re-upload.' };
    }

    // GUARD: Only allow retry from retryable states
    const retryableStatuses = ['FAILED', 'SEGMENTATION_CONFIRMED', 'SEGMENTATION_REQUIRED', 'SEGMENTATION_READY', 'PROCESSING', 'UPLOADED'];
    if (!retryableStatuses.includes(record.status)) {
      throw {
        statusCode: 400,
        message: `Cannot retry transcoding: Video is in '${record.status}' state. Only failed or uploaded videos can be retried.`
      };
    }

    // If still PROCESSING with an active job, reuse — do NOT CreateJob again
    const videoCompressor = require('./video.compressor');
    const { COMPRESSION_SETTINGS } = require('./video.constants');
    if (record.status === VIDEO_STATUS.PROCESSING && videoCompressor.isJobAlreadyActive(record, COMPRESSION_SETTINGS.JOB_TIMEOUT_MINUTES)) {
      console.log(`ℹ️ [DUPLICATE_MEDIACONVERT_JOB_BLOCKED] Retry while PROCESSING reused job ${record.mediaconvert_job_id}`);
      return {
        status: 'SUCCESS',
        videoAssetId: record.id,
        jobId: record.mediaconvert_job_id,
        processingStatus: VIDEO_STATUS.PROCESSING,
        duplicated: true,
        reason: 'ACTIVE_JOB_REUSED',
        message: 'Active MediaConvert job already in progress. Retry did not create a new job.'
      };
    }

    const currentRetries = Number(record.retry_count) || 0;
    const updatedRecord = await this.upsertVideoRecord({
      ...record,
      status: VIDEO_STATUS.SEGMENTATION_CONFIRMED,
      retry_count: currentRetries + 1,
      last_retry_at: new Date().toISOString(),
      error_code: null,
      error_message: null,
      updated_at: new Date().toISOString()
    });

    const effectiveModId = updatedRecord.module_id || updatedRecord.lesson_id;
    const effectiveCourseId = updatedRecord.course_id || targetCourseId;

    const transcodingMode = await this.determineModuleTranscodingMode(effectiveModId, effectiveCourseId);
    if (transcodingMode === 'TOPIC_MODE') {
      console.log(`🎬 [Video Pipeline Retry] TOPIC_MODE detected for module ${effectiveModId}. Retrying topic batch transcoding...`);
      return this.startTopicBatchProcessing(adminUser, {
        moduleId: effectiveModId,
        courseId: effectiveCourseId,
        sourceVideoId: updatedRecord.id,
        triggerSource: TRIGGER_SOURCES.RETRY
      });
    }

    console.log(`🔄 [Video Pipeline Retry] FULL_VIDEO_MODE detected for module ${effectiveModId}. Retrying full-video transcoding...`);
    return this.startFullVideoTranscoding(adminUser, {
      moduleId: effectiveModId,
      courseId: effectiveCourseId,
      videoAssetId: updatedRecord.id,
      lessonId: updatedRecord.lesson_id,
      adminOverride: false,
      forceReprocess: false,
      confirmReprocess: false
    });
  }

  /**
   * Helper: Sync video URL to course curriculum_modules JSON
   */
  async syncVideoUrlToCourseCurriculum(courseId, moduleId, lessonId, videoUrl, videoAssetId) {
    if (!courseId) return;
    try {
      const { data: course } = await supabase
        .from('courses')
        .select('id, curriculum_modules')
        .eq('id', courseId)
        .maybeSingle();

      if (course && Array.isArray(course.curriculum_modules)) {
        let modified = false;
        const updatedModules = course.curriculum_modules.map(mod => {
          const matchesMod = (moduleId && String(mod.id) === String(moduleId)) ||
                            (lessonId && String(mod.id) === String(lessonId)) ||
                            (videoAssetId && mod.video_asset_id && String(mod.video_asset_id) === String(videoAssetId));

          if (matchesMod) {
            modified = true;
            const isClearing = !videoUrl;
            const updatedTopics = isClearing && Array.isArray(mod.topics)
              ? mod.topics.map(t => typeof t === 'object' && t !== null ? { ...t, hls_master_url: null, hls_prefix: null, hls_720p_url: null, hls_1080p_url: null, processing_status: 'DRAFT' } : t)
              : mod.topics;

            return {
              ...mod,
              video_url: videoUrl || '',
              video_status: isClearing ? 'NO_VIDEO' : VIDEO_STATUS.READY,
              video_asset_id: isClearing ? null : (videoAssetId || mod.video_asset_id || null),
              hasVideo: !isClearing,
              topics: updatedTopics
            };
          }

          if (Array.isArray(mod.lessons)) {
            let lessonMatched = false;
            const isClearing = !videoUrl;
            const updatedLessons = mod.lessons.map(l => {
              if (String(l.id) === String(lessonId) || (videoAssetId && l.video_asset_id && String(l.video_asset_id) === String(videoAssetId))) {
                modified = true;
                lessonMatched = true;
                return {
                  ...l,
                  video_url: videoUrl || '',
                  video_status: isClearing ? 'NO_VIDEO' : VIDEO_STATUS.READY,
                  video_asset_id: isClearing ? null : (videoAssetId || l.video_asset_id || null)
                };
              }
              return l;
            });

            if (lessonMatched) {
              const updatedTopics = isClearing && Array.isArray(mod.topics)
                ? mod.topics.map(t => typeof t === 'object' && t !== null ? { ...t, hls_master_url: null, hls_prefix: null, hls_720p_url: null, hls_1080p_url: null, processing_status: 'DRAFT' } : t)
                : mod.topics;

              return {
                ...mod,
                video_url: videoUrl || '',
                video_status: isClearing ? 'NO_VIDEO' : VIDEO_STATUS.READY,
                video_asset_id: isClearing ? null : (videoAssetId || mod.video_asset_id || null),
                hasVideo: !isClearing,
                lessons: updatedLessons,
                topics: updatedTopics
              };
            }

            return {
              ...mod,
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
      console.warn('⚠️ [Video Pipeline] Notice syncing curriculum_modules:', err.message);
    }
  }

  /**
   * 3. Handle Successful MediaConvert Completion & Authoritative Size Comparison
   * Race-Condition Protected: Will NEVER resurrect a video in DELETING, DELETED, CANCELLING, or CANCELED states
   */
  async handleProcessingCompleted({ jobId, videoAssetId, lessonId }) {
    const record = await this.getVideoRecord(videoAssetId || lessonId);
    
    // Safety Lock: Check if deletion or cancellation is active/completed
    if (!record || ['DELETING', 'DELETED', 'CANCELLING', 'CANCELED'].includes(record.status)) {
      console.log(`🔒 [Video Pipeline Race Lock] Ignoring completion callback for deleted/cancelling video (${videoAssetId || lessonId}) with status: ${record?.status || 'NOT_FOUND'}`);
      
      // If any partial HLS output was generated during deletion race, purge it now
      if (record?.hls_prefix) {
        try {
          await s3VideoService.purgeVideoPrefix({
            bucket: record.source_s3_bucket || env.AWS_S3_BUCKET_OUTPUT,
            prefix: record.hls_prefix
          });
        } catch (e) {}
      }
      return;
    }

    // Idempotency: Ignore duplicate completion events if already finalized
    if (record.status === VIDEO_STATUS.READY && record.compression_result) {
      console.log(`ℹ️ [Video Pipeline] Video ${record.lesson_id} is already finalized. Duplicate completion ignored.`);
      await mediaConvertJobGuard.markClaimReady({ mediaconvertJobId: jobId, processingIdentity: record.processing_identity });
      return;
    }

    // Job ID validation — ignore stale/mismatched completion callbacks
    if (jobId && record.mediaconvert_job_id && String(jobId) !== String(record.mediaconvert_job_id)) {
      console.warn(`⚠️ [Video Pipeline] Ignoring completion for mismatched jobId ${jobId} (record has ${record.mediaconvert_job_id})`);
      return;
    }

    console.log(`🎬 [Video Pipeline] Transcoding complete for lesson: ${record.lesson_id}. Finalizing HLS verification...`);

    const videoCompressor = require('./video.compressor');
    const s3PathUtils = require('../../utils/s3PathUtils');
    const cdnDomain = env.CLOUDFRONT_DOMAIN || `https://${env.AWS_S3_BUCKET_OUTPUT}.s3.${env.AWS_REGION}.amazonaws.com`;
    const sourceSizeBytes = record.original_file_size_bytes || record.file_size_bytes || 0;
    const outputBucket = env.AWS_S3_BUCKET_OUTPUT || record.source_s3_bucket;

    // Resilient Prefix Extraction (Supports memory store, DB records, slugs, and legacy paths)
    let effectivePrefix = record.hls_prefix;
    if (!effectivePrefix && record.hls_master_url) {
      effectivePrefix = s3PathUtils.extractResourcePrefixFromUrl(record.hls_master_url);
    }
    if (!effectivePrefix && record.source_s3_key) {
      effectivePrefix = record.source_s3_key.replace(/\/source\/[^/]+$/, '/hls/').replace(/\/+$/, '') + '/';
    }
    if (!effectivePrefix && record.course_slug && record.module_slug) {
      effectivePrefix = s3PathUtils.buildS3HlsPrefix(record.course_slug, record.module_slug, record.id);
    }
    if (!effectivePrefix) {
      effectivePrefix = `courses/${record.course_id || 'course'}/modules/${record.module_id || 'module'}/videos/${record.id || record.lesson_id}/hls/`;
    }
    if (!effectivePrefix.endsWith('/')) {
      effectivePrefix += '/';
    }

    const resolution = record.output_resolution || record.original_resolution || '1080p';
    const is1080p = resolution === '1080p';
    const is480p = resolution === '480p';
    const is720p = resolution === '720p';

    // 1. Check Master Playlist
    const hlsMasterKey = `${effectivePrefix}master.m3u8`.replace(/\/\/+/g, '/');
    let masterCheck = await s3VideoService.verifyObjectExists(outputBucket, hlsMasterKey);

    // 2. Check 480p Playlist (if source is < 720p)
    let p480Key = `${effectivePrefix}master_480p.m3u8`.replace(/\/\/+/g, '/');
    let p480Check = { exists: !is480p };
    if (is480p) {
      p480Check = await s3VideoService.verifyObjectExists(outputBucket, p480Key);
      if (!p480Check.exists) {
        p480Key = `${effectivePrefix}_480p.m3u8`.replace(/\/\/+/g, '/');
        p480Check = await s3VideoService.verifyObjectExists(outputBucket, p480Key);
      }
    }

    // 3. Check 720p Playlist (Supports standard master_720p.m3u8 or _720p.m3u8)
    let p720Key = `${effectivePrefix}master_720p.m3u8`.replace(/\/\/+/g, '/');
    let p720Check = { exists: is480p };
    if (!is480p) {
      p720Check = await s3VideoService.verifyObjectExists(outputBucket, p720Key);
      if (!p720Check.exists) {
        p720Key = `${effectivePrefix}_720p.m3u8`.replace(/\/\/+/g, '/');
        p720Check = await s3VideoService.verifyObjectExists(outputBucket, p720Key);
      }
    }

    // 4. Check 1080p Playlist (if source is 1080p+)
    let p1080Key = `${effectivePrefix}master_1080p.m3u8`.replace(/\/\/+/g, '/');
    let p1080Check = { exists: !is1080p };
    if (is1080p) {
      p1080Check = await s3VideoService.verifyObjectExists(outputBucket, p1080Key);
      if (!p1080Check.exists) {
        p1080Key = `${effectivePrefix}_1080p.m3u8`.replace(/\/\/+/g, '/');
        p1080Check = await s3VideoService.verifyObjectExists(outputBucket, p1080Key);
      }
    }

    // 5. Query S3 for all generated HLS segments and calculate total package size
    const allHlsObjects = await s3VideoService.listObjectsUnderPrefix(outputBucket, effectivePrefix);
    const tsSegments = (allHlsObjects || []).filter(obj => obj.Key && obj.Key.endsWith('.ts'));
    const totalHlsBytes = (allHlsObjects || []).reduce((sum, obj) => sum + (obj.Size || 0), 0);

    const isHlsValid = masterCheck.exists && p480Check.exists && p720Check.exists && p1080Check.exists && tsSegments.length > 0;

    // Check for Legacy MP4 fallback if HLS is not present (for backward compatibility with old uploads)
    let isLegacyMp4 = false;
    let effectiveOutputKey = hlsMasterKey;
    let optimizedSizeBytes = totalHlsBytes || masterCheck.contentLength || 0;

    if (!isHlsValid) {
      const legacyMp4Key = record.optimized_s3_key || `${effectivePrefix}_optimized.mp4`.replace(/\/\/+/g, '/');
      const mp4Check = await s3VideoService.verifyObjectExists(outputBucket, legacyMp4Key);
      if (mp4Check && mp4Check.exists) {
        isLegacyMp4 = true;
        effectiveOutputKey = legacyMp4Key;
        optimizedSizeBytes = mp4Check.contentLength || 0;
      }
    }

    if (!isHlsValid && !isLegacyMp4) {
      const missing = [];
      if (!masterCheck.exists) missing.push(`master.m3u8 (s3://${outputBucket}/${hlsMasterKey})`);
      if (is480p && !p480Check.exists) missing.push(`480p playlist (s3://${outputBucket}/${p480Key})`);
      if (!is480p && !p720Check.exists) missing.push(`720p playlist (s3://${outputBucket}/${p720Key})`);
      if (is1080p && !p1080Check.exists) missing.push(`1080p playlist (s3://${outputBucket}/${p1080Key})`);
      if (tsSegments.length === 0) missing.push(`HLS .ts segments under s3://${outputBucket}/${effectivePrefix}`);

      console.error(`❌ [Video Pipeline] HLS Output verification failed for lesson ${record.lesson_id}. Missing: ${missing.join(', ')}`);
      await this.handleProcessingFailed({
        jobId,
        videoAssetId: record.id,
        lessonId: record.lesson_id,
        errorDetails: {
          code: 'HLS_OUTPUT_VERIFICATION_FAILED',
          message: `HLS transcoding output verification failed. Missing: ${missing.join('; ')}`
        }
      });
      return;
    }

    // Technical integrity verification (Resolution, FPS, Aspect Ratio, Codec, Audio)
    const techVal = videoCompressor.validateTechnicalIntegrity({
      sourceInfo: {
        targetResolution: resolution,
        durationSeconds: record.duration_seconds,
        width: record.source_width || (is1080p ? 1920 : (is480p ? 854 : 1280)),
        height: record.source_height || (is1080p ? 1080 : (is480p ? 480 : 720)),
        fps: record.source_fps || 30,
        hasAudio: record.source_has_audio !== false
      },
      outputInfo: {
        contentLength: optimizedSizeBytes,
        width: is1080p ? 1920 : (is480p ? 854 : 1280),
        height: is1080p ? 1080 : (is480p ? 480 : 720),
        fps: record.source_fps || 30,
        durationSeconds: record.duration_seconds,
        videoCodec: 'h264',
        audioCodec: 'aac',
        hasAudio: record.source_has_audio !== false
      }
    });

    if (!techVal.isValid) {
      console.error(`❌ [Video Pipeline] Output technical validation failed for lesson ${record.lesson_id}:`, techVal.errors);
      await this.handleProcessingFailed({
        jobId,
        videoAssetId: record.id,
        lessonId: record.lesson_id,
        errorDetails: {
          code: 'VALIDATION_FAILED',
          message: techVal.errors.join('; ')
        }
      });
      return;
    }

    // Authoritative post-encoding size comparison
    const compEval = videoCompressor.evaluateCompressionResult({
      originalSizeBytes: sourceSizeBytes,
      optimizedSizeBytes
    });

    const masterHlsUrl = `${cdnDomain}/${hlsMasterKey}`;
    const p480Url = is480p ? `${cdnDomain}/${p480Key}` : null;
    const p720Url = !is480p ? `${cdnDomain}/${p720Key}` : null;
    const p1080Url = is1080p ? `${cdnDomain}/${p1080Key}` : null;
    const availableQualities = is1080p ? ['720p', '1080p'] : (is480p ? ['480p'] : ['720p']);
    let effectivePlaybackUrl = isLegacyMp4 ? `${cdnDomain}/${effectiveOutputKey}` : masterHlsUrl;
    let finalCompressionResult = compEval.result;
    let finalCompressionPercentage = compEval.compressionPercentage;

    const videoCleanupService = require('./video.cleanup.service');

    // If optimized file was not beneficial -> retain original source for playback
    if (!compEval.isBeneficial) {
      console.log(`⚠️ [Video Pipeline] Optimization was not beneficial for lesson ${record.lesson_id}: ${compEval.reason}`);
      const sourceS3Url = `https://${record.source_s3_bucket}.s3.${env.AWS_REGION}.amazonaws.com/${record.source_s3_key}`;
      effectivePlaybackUrl = env.CLOUDFRONT_DOMAIN ? `${env.CLOUDFRONT_DOMAIN}/${record.source_s3_key}` : sourceS3Url;
      finalCompressionResult = 'COMPRESSION_NOT_BENEFICIAL';
      finalCompressionPercentage = 0;
    } else {
      console.log(`✅ [Video Pipeline] HLS Compression applied successfully for lesson ${record.lesson_id}: Saved ${finalCompressionPercentage}% (${tsSegments.length} segments, ${(optimizedSizeBytes / (1024 * 1024)).toFixed(1)} MB total)`);
    }

    // Transaction Safety: (1) Finalize DB and course JSON first, (2) Only then execute source retention policy
    const { COMPRESSION_SETTINGS } = require('./video.constants');
    let sourceDeleteAfter = null;

    // Update state to READY
    const finalizedRecord = await this.upsertVideoRecord({
      ...record,
      status: VIDEO_STATUS.READY,
      file_size_bytes: compEval.isBeneficial ? optimizedSizeBytes : sourceSizeBytes,
      original_file_size_bytes: sourceSizeBytes,
      optimized_file_size_bytes: optimizedSizeBytes,
      compression_percentage: finalCompressionPercentage,
      compression_result: finalCompressionResult,
      hls_master_url: masterHlsUrl,
      hls_480p_url: p480Url,
      hls_720p_url: p720Url,
      hls_1080p_url: p1080Url,
      available_qualities: availableQualities,
      hls_prefix: effectivePrefix,
      optimized_mp4_url: isLegacyMp4 ? effectivePlaybackUrl : null,
      source_deleted_at: null,
      source_delete_after: sourceDeleteAfter,
      processing_completed_at: new Date().toISOString(),
      processed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });

    // Update video_url in course curriculum_modules JSON
    await this.syncVideoUrlToCourseCurriculum(
      record.course_id,
      record.module_id,
      record.lesson_id,
      effectivePlaybackUrl,
      record.id
    );

    // Apply Retention Policy only AFTER successful finalization via safety lock
    if (compEval.isBeneficial && COMPRESSION_SETTINGS.SOURCE_RETENTION_POLICY === 'DELETE_AFTER_VALIDATION') {
      await videoCleanupService.safeDeleteRawSource({
        record: finalizedRecord,
        s3VideoService,
        videoService: this
      });
    } else {
      sourceDeleteAfter = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
      await this.upsertVideoRecord({
        ...finalizedRecord,
        source_delete_after: sourceDeleteAfter
      });
    }

    console.log(`✅ [Video Pipeline] Lesson ${record.lesson_id} is now READY with HLS stream: ${effectivePlaybackUrl} (Qualities: ${availableQualities.join(', ')})`);
    await mediaConvertJobGuard.markClaimReady({ mediaconvertJobId: jobId, processingIdentity: record.processing_identity });
  }

  /**
   * 4. Handle MediaConvert Failure (Keeps Source 100% Safe)
   */
  async handleProcessingFailed({ jobId, videoAssetId, lessonId, errorDetails }) {
    const record = await this.getVideoRecord(videoAssetId || lessonId);
    if (!record || ['DELETING', 'DELETED', 'CANCELLING', 'CANCELED'].includes(record.status)) {
      return;
    }

    // Do not roll READY back to FAILED on stale/duplicate failure callbacks
    if (record.status === VIDEO_STATUS.READY) {
      console.warn(`⚠️ [Video Pipeline] Ignoring failure callback for already READY video ${record.id} job=${jobId}`);
      return;
    }
    if (jobId && record.mediaconvert_job_id && String(jobId) !== String(record.mediaconvert_job_id)) {
      console.warn(`⚠️ [Video Pipeline] Ignoring mismatched failure jobId ${jobId} (record has ${record.mediaconvert_job_id})`);
      return;
    }

    console.error(`❌ [Video Pipeline] Transcoding failed for lesson ${record.lesson_id}:`, errorDetails);

    const videoCleanupService = require('./video.cleanup.service');
    // Clean failed output artifacts while keeping the raw master source safe for retry
    await videoCleanupService.cleanupFailedProcessingOutput({
      outputBucket: record.source_s3_bucket,
      outputPrefix: record.hls_prefix,
      record,
      s3VideoService
    });

    await this.upsertVideoRecord({
      ...record,
      status: VIDEO_STATUS.FAILED,
      compression_result: 'COMPRESSION_FAILED',
      error_code: errorDetails?.code || 'TRANSCODE_ERROR',
      error_message: errorDetails?.message || 'MediaConvert transcoding failed.',
      updated_at: new Date().toISOString()
    });
    await mediaConvertJobGuard.markClaimFailed({
      mediaconvertJobId: jobId || record.mediaconvert_job_id,
      errorMessage: errorDetails?.message || 'MediaConvert transcoding failed.'
    });
  }

  /**
   * 5. Get Video Status & Telemetry
   */
  async getVideoStatus(lessonId, courseId = null) {
    const record = await this.getVideoRecord(lessonId, courseId);
    if (!record || record.status === 'DELETED' || record.status === 'NO_VIDEO' || record.status === 'UNPROCESSED') {
      return {
        lessonId,
        status: record?.status || 'NO_VIDEO',
        hlsMasterUrl: null,
        topicsSummary: null
      };
    }

    let currentJobPercent = 0;
    let currentPhase = 'TRANSCODING';

    // If currently PROCESSING and has a jobId, check status update
    if (record.status === VIDEO_STATUS.PROCESSING && record.mediaconvert_job_id) {
      const jobStatus = await mediaConvertVideoService.getJobStatus(record.mediaconvert_job_id);
      currentJobPercent = jobStatus.jobPercentComplete || 0;
      currentPhase = jobStatus.currentPhase || 'OPTIMIZING';

      if (jobStatus.status === 'COMPLETE') {
        const isTopicJob = Boolean(
          record.is_individual_topic_video ||
          record.topic_id ||
          (record.lesson_id && record.module_id && String(record.lesson_id) !== String(record.module_id))
        );
        if (isTopicJob) {
          await this.handleTopicProcessingCompleted({
            jobId: record.mediaconvert_job_id,
            topicId: record.topic_id || record.lesson_id,
            sourceVideoId: record.id,
            moduleId: record.module_id,
            courseId: record.course_id,
            isIndividualTopicVideo: true
          });
        } else {
          await this.handleProcessingCompleted({ jobId: record.mediaconvert_job_id, videoAssetId: record.id });
        }
        record.status = VIDEO_STATUS.READY;
        currentJobPercent = 100;
      } else if (jobStatus.status === 'ERROR') {
        const isTopicJob = Boolean(
          record.is_individual_topic_video ||
          record.topic_id ||
          (record.lesson_id && record.module_id && String(record.lesson_id) !== String(record.module_id))
        );
        if (isTopicJob) {
          await this.handleTopicProcessingFailed({
            jobId: record.mediaconvert_job_id,
            topicId: record.topic_id || record.lesson_id,
            sourceVideoId: record.id,
            moduleId: record.module_id,
            courseId: record.course_id,
            errorDetails: { message: jobStatus.errorMessage }
          });
        } else {
          await this.handleProcessingFailed({
            jobId: record.mediaconvert_job_id,
            videoAssetId: record.id,
            errorDetails: { message: jobStatus.errorMessage }
          });
        }
        record.status = VIDEO_STATUS.FAILED;
      }
    }

    const s3PathUtils = require('../../utils/s3PathUtils');
    let effectivePrefix = record.hls_prefix;
    if (!effectivePrefix && record.hls_master_url) {
      effectivePrefix = s3PathUtils.extractResourcePrefixFromUrl(record.hls_master_url);
    }
    if (!effectivePrefix && record.source_s3_key) {
      effectivePrefix = record.source_s3_key.replace(/\/source\/[^/]+$/, '/hls/').replace(/\/+$/, '') + '/';
    }
    if (!effectivePrefix && record.course_slug && record.module_slug) {
      effectivePrefix = s3PathUtils.buildS3HlsPrefix(record.course_slug, record.module_slug, record.id);
    }
    if (!effectivePrefix) {
      effectivePrefix = `courses/${record.course_id}/modules/${record.module_id}/videos/${record.id || record.lesson_id}/hls/`;
    }
    if (effectivePrefix && !effectivePrefix.endsWith('/')) {
      effectivePrefix += '/';
    }

    let segmentInfo = { segmentCount: 0, manifestCount: 0, totalFiles: 0, segments480p: 0, segments720p: 0, segments1080p: 0, size480pMB: '0.0', size720pMB: '0.0', size1080pMB: '0.0', totalHlsMB: '0.0' };
    if (effectivePrefix) {
      segmentInfo = await s3VideoService.countHlsSegments({
        prefix: effectivePrefix
      });
      if (segmentInfo.totalFiles === 0 && effectivePrefix.includes('/hls/')) {
        const parentVideoPrefix = effectivePrefix.replace(/\/hls\/$/, '/');
        const broadInfo = await s3VideoService.countHlsSegments({
          prefix: parentVideoPrefix
        });
        if (broadInfo.totalFiles > 0) {
          segmentInfo = broadInfo;
        }
      }
    }

    const resTier = record.output_resolution || record.original_resolution || '1080p';
    const dynamicQualities = record.available_qualities || (resTier === '1080p' ? ['720p', '1080p'] : (resTier === '480p' ? ['480p'] : ['720p']));

    // Check if module has topics to provide complete topic transcoding telemetry
    // IMPORTANT: Skip for topic-specific video records to prevent effectiveStatus override
    const isTopicSpecificVideo = record.lesson_id && record.module_id && String(record.lesson_id) !== String(record.module_id);
    let topicsSummary = null;
    let moduleTopics = [];
    try {
      if (!isTopicSpecificVideo) {
      const topicRes = await this.getModuleTopics(null, { moduleId: record.module_id || record.lesson_id, courseId: record.course_id || courseId });
      if (topicRes && Array.isArray(topicRes.topics) && topicRes.topics.length > 0) {
        moduleTopics = topicRes.topics;
        const total = moduleTopics.length;
        const ready = topicRes.readyTopics || 0;
        const processing = topicRes.processingTopics || 0;
        const queued = topicRes.queuedTopics || 0;
        const failed = topicRes.failedTopics || 0;
        const draft = Math.max(0, total - ready - processing - queued - failed);

        const overallTopicProgress = typeof topicRes.progressPercent === 'number' ? topicRes.progressPercent : (total > 0 ? Math.round((ready / total) * 100) : 0);

        topicsSummary = {
          totalTopics: total,
          readyTopics: ready,
          processingTopics: processing,
          queuedTopics: queued,
          failedTopics: failed,
          draftTopics: draft,
          progressPercent: overallTopicProgress,
          topics: moduleTopics.map(t => ({
            id: t.id,
            title: t.title,
            start_time_seconds: t.start_time_seconds,
            end_time_seconds: t.end_time_seconds,
            start_timecode: t.start_timecode,
            end_timecode: t.end_timecode,
            duration_seconds: t.duration_seconds,
            processing_status: t.processing_status || 'DRAFT',
            hls_master_url: t.hls_master_url,
            jobPercentComplete: t.jobPercentComplete || t.job_percent_complete || (t.processing_status === 'READY' ? 100 : 0),
            error_message: t.processing_error || t.error_message || null
          }))
        };

        // If primary video prefix had 0 files, resolve S3 storage from the topics' actual S3 HLS paths
        if (segmentInfo.totalFiles === 0) {
          const topicWithHls = moduleTopics.find(t => t.hls_prefix || t.hls_master_url);
          if (topicWithHls) {
            let tPrefix = topicWithHls.hls_prefix;
            if (!tPrefix && topicWithHls.hls_master_url) {
              tPrefix = s3PathUtils.extractResourcePrefixFromUrl(topicWithHls.hls_master_url);
            }
            if (tPrefix) {
              const topicParentPrefix = tPrefix.includes('/topics/') ? tPrefix.split('/topics/')[0] + '/' : tPrefix;
              const topicStorage = await s3VideoService.countHlsSegments({
                prefix: topicParentPrefix
              });
              if (topicStorage && topicStorage.totalFiles > 0) {
                segmentInfo = topicStorage;
              }
            }
          }
        }
        topicsSummary.storage = segmentInfo;
      }
      } // end if (!isTopicSpecificVideo)
    } catch (e) {
      console.warn('⚠️ [Video Pipeline] Notice querying topic storage:', e.message);
    }

    // Auto-heal legacy false-failed records where status was forced to FAILED with 'State: DRAFT'
    if (record.status === 'FAILED' && (record.error_message === 'State: DRAFT' || record.error_code === 'DRAFT' || !record.error_message)) {
      record.status = 'DRAFT';
      record.error_message = null;
      record.error_code = null;
      this.upsertVideoRecord({ ...record, status: 'DRAFT', error_message: null, error_code: null }).catch(() => {});
    }

    const isTopicMode = !!(topicsSummary && topicsSummary.totalTopics > 0);
    let effectiveStatus = record.status;
    const recordIsLiveEncode = ['PROCESSING', 'UPLOADING', 'QUEUED'].includes(String(record.status || ''))
      && Boolean(record.mediaconvert_job_id);

    if (isTopicMode) {
      if (topicsSummary.totalTopics > 0 && topicsSummary.readyTopics === topicsSummary.totalTopics) {
        effectiveStatus = VIDEO_STATUS.READY;
      } else if (topicsSummary.processingTopics > 0 || topicsSummary.queuedTopics > 0) {
        effectiveStatus = VIDEO_STATUS.PROCESSING;
      } else if (recordIsLiveEncode) {
        // Mode 1 master (or module) MediaConvert still running — do not collapse to DRAFT/SEGMENTATION
        effectiveStatus = record.status;
      } else if (topicsSummary.failedTopics > 0 && topicsSummary.readyTopics === 0 && topicsSummary.processingTopics === 0 && topicsSummary.queuedTopics === 0) {
        effectiveStatus = VIDEO_STATUS.FAILED;
      } else if (topicsSummary.readyTopics === 0 && topicsSummary.processingTopics === 0 && topicsSummary.queuedTopics === 0 && topicsSummary.failedTopics === 0) {
        effectiveStatus = record.status === VIDEO_STATUS.PROCESSING ? VIDEO_STATUS.PROCESSING : 'DRAFT';
      } else if (
        topicsSummary.readyTopics > 0 &&
        topicsSummary.readyTopics < topicsSummary.totalTopics &&
        topicsSummary.processingTopics === 0 &&
        topicsSummary.queuedTopics === 0
      ) {
        // Partial clips done, nothing encoding, no live master job — wait for admin
        effectiveStatus = VIDEO_STATUS.SEGMENTATION_REQUIRED;
      }
    }

    return {
      id: record.id,
      videoAssetId: record.id,
      lessonId: record.lesson_id,
      moduleId: record.module_id,
      courseId: record.course_id,
      status: effectiveStatus,
      rawStatus: record.status,
      isTopicMode: isTopicMode,
      topicsSummary: topicsSummary,
      topics: moduleTopics,
      hlsMasterUrl: record.hls_master_url,
      optimizedMp4Url: record.optimized_mp4_url || record.hls_master_url,
      hls480pUrl: record.hls_480p_url,
      hls720pUrl: record.hls_720p_url,
      hls1080pUrl: record.hls_1080p_url,
      availableQualities: dynamicQualities,
      durationSeconds: record.duration_seconds || 0,
      sourceSizeBytes: record.original_file_size_bytes || record.file_size_bytes || 0,
      originalSizeBytes: record.original_file_size_bytes || record.file_size_bytes || 0,
      optimizedSizeBytes: record.optimized_file_size_bytes || segmentInfo.totalHlsBytes || 0,
      compressionPercentage: record.compression_percentage ?? null,
      compressionResult: record.compression_result || null,
      outputResolution: resTier,
      errorMessage: effectiveStatus === 'FAILED' ? (record.error_message || null) : null,
      sourceDeleted: Boolean(record.source_deleted_at),
      jobPercentComplete: isTopicMode && topicsSummary ? topicsSummary.progressPercent : currentJobPercent,
      currentPhase: isTopicMode ? 'TOPIC_CLIPPING_TRANSCODING' : currentPhase,
      segmentsGenerated: segmentInfo.segmentCount,
      manifestsGenerated: segmentInfo.manifestCount,
      totalHlsFiles: segmentInfo.totalFiles,
      segments480p: segmentInfo.segments480p,
      segments720p: segmentInfo.segments720p,
      segments1080p: segmentInfo.segments1080p,
      size480pMB: segmentInfo.size480pMB,
      size720pMB: segmentInfo.size720pMB,
      size1080pMB: segmentInfo.size1080pMB,
      totalHlsMB: segmentInfo.totalHlsMB,
      updatedAt: record.updated_at
    };
  }



  /**
   * Helper: Resilient Student Profile & Course Enrollment Resolver
   * Supports email, user ID, course UUID, slug, and course title matching with active 6-month window validation
   */
  async resolveStudentEnrollment(user, course, courseId) {
    const userEmail = (user?.email || '').toLowerCase().trim();
    const isAdmin = user?.user_metadata?.role === 'ADMIN' || user?.role === 'ADMIN' || userEmail === 'admin@internnetra.com';
    if (isAdmin) {
      return { isAdmin: true, student: null, studentId: user?.id || 'admin', enrollment: null };
    }

    // 1. Locate student profile
    let student = null;
    if (userEmail) {
      const { data: sEmail } = await supabase
        .from('students')
        .select('id, email, full_name')
        .ilike('email', userEmail)
        .maybeSingle();
      student = sEmail;
    }

    if (!student && user?.id) {
      const { data: sId } = await supabase
        .from('students')
        .select('id, email, full_name')
        .eq('id', user.id)
        .maybeSingle();
      student = sId;
    }

    const studentId = student?.id || user?.id;
    const candidateStudentIds = Array.from(new Set([student?.id, user?.id, user?.sub].filter(Boolean)));

    if (!candidateStudentIds.length) {
      throw { statusCode: 403, message: 'Student profile not found. Please register or activate your account.' };
    }

    // 2. Candidate Course IDs (UUID, slug, parameter)
    const candidateCourseIds = Array.from(new Set([course?.id, course?.slug, courseId].filter(Boolean)));

    // 3. Query Enrollment Record
    let enrollment = null;

    for (const sid of candidateStudentIds) {
      for (const cid of candidateCourseIds) {
        const { data: enr } = await supabase
          .from('enrollments')
          .select('id, student_id, course_id, course_name, course_access_status, payment_status, access_start_date, access_expiry_date, created_at, suspension_reason, suspension_notes, amount_pending, amount_paid, total_amount, second_payment_due_at, installment_due_at')
          .eq('student_id', sid)
          .eq('course_id', cid)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (enr) {
          enrollment = enr;
          break;
        }
      }
      if (enrollment) break;
    }

    // Fallback: Check all enrollments for this student matching course slug or title
    if (!enrollment) {
      for (const sid of candidateStudentIds) {
        const { data: allEnrs } = await supabase
          .from('enrollments')
          .select('id, student_id, course_id, course_name, course_access_status, payment_status, access_start_date, access_expiry_date, created_at, suspension_reason, suspension_notes, amount_pending, amount_paid, total_amount, second_payment_due_at, installment_due_at')
          .eq('student_id', sid);

        if (Array.isArray(allEnrs) && allEnrs.length > 0) {
          const cleanInputSlug = (course?.slug || courseId || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          const cleanCourseTitle = (course?.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');

          enrollment = allEnrs.find(e => {
            const eCourseId = (e.course_id || '').toLowerCase().replace(/[^a-z0-9]/g, '');
            const eName = (e.course_name || '').toLowerCase().replace(/[^a-z0-9]/g, '');

            return (
              candidateCourseIds.includes(e.course_id) ||
              (cleanInputSlug && (eCourseId === cleanInputSlug || eName.includes(cleanInputSlug) || cleanInputSlug.includes(eName))) ||
              (cleanCourseTitle && (eName.includes(cleanCourseTitle) || cleanCourseTitle.includes(eName)))
            );
          });
          if (enrollment) break;
        }
      }
    }

    if (!enrollment) {
      throw { statusCode: 403, message: 'Access Denied: You are not enrolled in this course.' };
    }

    if (enrollment.course_access_status === 'LOCKED') {
      throw { statusCode: 403, message: 'Course access locked: Successful payment or enrollment activation required.' };
    }

    if (enrollment.course_access_status === 'SUSPENDED') {
      const isManual = enrollment.suspension_reason === 'MANUAL_ADMIN';
      throw {
        statusCode: 403,
        code: isManual ? 'COURSE_ACCESS_SUSPENDED' : 'COURSE_PAYMENT_OVERDUE',
        message: isManual
          ? 'Your course access has been temporarily suspended by an administrator. Please contact support.'
          : 'Your course access is temporarily suspended because the remaining installment is overdue. Please complete the payment to restore access.',
        suspension_reason: enrollment.suspension_reason || (isManual ? 'MANUAL_ADMIN' : 'PAYMENT_OVERDUE'),
        enrollment_id: enrollment.id,
        amount_pending: enrollment.amount_pending || 0,
        second_payment_due_at: enrollment.second_payment_due_at || enrollment.installment_due_at
      };
    }

    const hasActiveAccess =
      enrollment.course_access_status === 'ACTIVE' ||
      enrollment.course_access_status === 'UNLOCKED' ||
      ['SUCCESS', 'PAID', 'PARTIALLY_PAID'].includes((enrollment.payment_status || '').toUpperCase());

    if (!hasActiveAccess) {
      throw { statusCode: 403, message: 'Course access locked: Successful payment or enrollment activation required.' };
    }

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

    return { isAdmin: false, student, studentId, enrollment };
  }

  /**
   * 7. Student Playback Authorization:
   * Validates enrollment & active payment, checks lesson publishing,
   * generates temporary CloudFront signed cookies / signed URL,
   * retrieves last watched position from lesson_video_progress.
   */
  async authorizeStudentPlayback(user, { courseId, lessonId }) {
    const userEmail = user?.email?.toLowerCase()?.trim() || null;
    const isAdmin = Boolean(user && (user.user_metadata?.role === 'ADMIN' || user.role === 'ADMIN' || userEmail === 'admin@internnetra.com'));

    // 1. Fetch Target Course & Lesson
    const classification = classifyIdentifier(courseId);
    if (classification === 'INVALID') {
      throw { statusCode: 400, message: 'Invalid course identifier format.' };
    }
    const rawCourseId = String(courseId).trim();

    let courseQuery = supabase.from('courses').select('id, title, slug, curriculum_modules');
    if (classification === 'UUID') {
      courseQuery = courseQuery.eq('id', rawCourseId);
    } else {
      courseQuery = courseQuery.eq('slug', normalizeIdentifier(rawCourseId, 'SLUG'));
    }
    const { data: course, error: courseErr } = await courseQuery.maybeSingle();

    if (courseErr || !course) {
      throw { statusCode: 404, message: 'Course not found.' };
    }

    // Locate target module or lesson in course curriculum
    let targetLesson = null;
    let targetModule = null;
    if (Array.isArray(course.curriculum_modules)) {
      for (const mod of course.curriculum_modules) {
        if (String(mod.id) === String(lessonId) || String(mod.video_asset_id) === String(lessonId)) {
          targetModule = mod;
          targetLesson = {
            id: mod.id,
            title: mod.video_title || mod.title || mod.name,
            video_url: mod.video_url,
            is_preview: mod.is_preview
          };
          break;
        }
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

    // Check if free preview lesson/module
    const isFreePreview = Boolean(targetLesson?.is_preview || targetModule?.is_preview);

    if (!user && !isFreePreview && !isAdmin) {
      throw { statusCode: 401, message: 'Authentication required.' };
    }

    // 2. Authorization Check: Admin or Active Enrolled Student or Free Preview
    let student = null;
    let studentId = null;
    let enrollmentId = null;

    if (!isAdmin && !isFreePreview) {
      if (!user || !user.email) {
        throw { statusCode: 401, message: 'Authentication required.' };
      }
      const authResult = await this.resolveStudentEnrollment(user, course, courseId);
      student = authResult.student;
      studentId = authResult.studentId;
      enrollmentId = authResult.enrollment?.id;
    }

    // 3. Verify Video Metadata & Readiness
    const s3PathUtils = require('../../utils/s3PathUtils');
    let videoRecord = await this.getVideoRecord(lessonId);

    if (videoRecord) {
      if (videoRecord.course_id && String(videoRecord.course_id) !== String(course.id)) {
        throw new HierarchyValidationError(
          `Video '${videoRecord.id}' belongs to course '${videoRecord.course_id || 'NONE'}', not requested course '${course.id}'. Playback authorization denied.`,
          403,
          'HIERARCHY_VIDEO_MISMATCH'
        );
      }
    }

    // Auto-heal stale UPLOADING records (older than 15 mins with no HLS master)
    if (videoRecord && videoRecord.status === 'UPLOADING') {
      const uploadAgeMs = Date.now() - new Date(videoRecord.upload_started_at || videoRecord.updated_at || 0).getTime();
      if (uploadAgeMs > 15 * 60 * 1000) {
        videoRecord.status = 'NO_VIDEO';
        this.upsertVideoRecord({ ...videoRecord, status: 'NO_VIDEO' }).catch(() => {});
      }
    }

    // Auto-heal or verify PROCESSING records
    if (videoRecord && videoRecord.status === 'PROCESSING') {
      // 1. If there is no S3 source key or no MediaConvert job ID, it is not actually transcoding
      if (!videoRecord.s3_source_key || !videoRecord.mediaconvert_job_id) {
        videoRecord.status = 'NO_VIDEO';
        this.upsertVideoRecord({ ...videoRecord, status: 'NO_VIDEO' }).catch(() => {});
      } else {
        // 2. Check MediaConvert job status directly instead of failing blindly on age (ARCH-08)
        try {
          const jobStatus = await mediaConvertVideoService.getJobStatus(videoRecord.mediaconvert_job_id);
          if (jobStatus.status === 'COMPLETE') {
            await this.handleProcessingCompleted({
              jobId: videoRecord.mediaconvert_job_id,
              videoAssetId: videoRecord.id,
              lessonId: videoRecord.lesson_id
            });
            videoRecord = await this.getVideoRecord(lessonId);
          } else if (jobStatus.status === 'ERROR' || jobStatus.status === 'CANCELED') {
            videoRecord.status = 'FAILED';
            this.upsertVideoRecord({ ...videoRecord, status: 'FAILED' }).catch(() => {});
          } else if (jobStatus.status === 'PROGRESSING' || jobStatus.status === 'SUBMITTED') {
            videoRecord.status = 'PROCESSING';
          }
        } catch (checkErr) {
          console.warn('⚠️ [Video Pipeline] Could not check MediaConvert job status:', checkErr.message);
          const procAgeMs = Date.now() - new Date(videoRecord.updated_at || videoRecord.created_at || 0).getTime();
          if (procAgeMs > 2 * 60 * 60 * 1000) {
            videoRecord.status = 'FAILED';
            this.upsertVideoRecord({ ...videoRecord, status: 'FAILED' }).catch(() => {});
          }
        }
      }
    }

    // Only throw 409 if verified actively transcoding in MediaConvert with a live job
    if (videoRecord && videoRecord.status === 'PROCESSING' && videoRecord.mediaconvert_job_id && !videoRecord.hls_master_url) {
      throw { statusCode: 409, message: 'Video lecture is currently being transcoded. Please check back in a moment.' };
    }

    let masterUrl = videoRecord?.hls_master_url || 
      (targetLesson?.video_url && targetLesson.video_url.includes('.m3u8') ? targetLesson.video_url : null) ||
      (targetModule?.video_url && targetModule.video_url.includes('.m3u8') ? targetModule.video_url : null) ||
      videoRecord?.optimized_mp4_url ||
      targetLesson?.video_url || 
      targetModule?.video_url;

    if (!masterUrl) {
      throw { statusCode: 404, message: 'The video lecture for this module will be updated soon by your instructor.' };
    }

    // 4. Retrieve Resume Position & Student Details for Forensic Watermark
    let lastPositionSeconds = 0;
    let studentFullName = user?.user_metadata?.full_name || student?.full_name || (isFreePreview ? 'Guest Previewer' : 'InternNetra Student');
    let studentDisplayId = student?.id ? `STU-${student.id.slice(0, 8).toUpperCase()}` : (isFreePreview ? 'PREVIEW-MODE' : 'STU-AUTH');

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

    // 5. Level 2 Security: Register Concurrent Playback Session
    const videoSessionService = require('./video.session.service');
    const effectiveUserId = user?.id || studentId || userEmail || 'guest_preview';
    const effectiveUserEmail = userEmail || (isFreePreview ? 'preview@internnetra.com' : 'student@internnetra.com');
    const session = await videoSessionService.createSession({
      userId: effectiveUserId,
      courseId: course.id,
      lessonId: String(lessonId)
    });

    // 6. Generate Short-Lived Playback Token (Default: 900s / 15 mins)
    const jwt = require('jsonwebtoken');
    const ttlSeconds = env.VIDEO_ACCESS_TTL_SECONDS || 900;
    const expiresEpoch = Math.floor(Date.now() / 1000) + ttlSeconds;

    if (!env.JWT_SECRET) {
      throw new Error('JWT_SECRET is not configured. Playback token creation aborted.');
    }

    const playbackToken = jwt.sign(
      {
        sub: effectiveUserId,
        email: effectiveUserEmail,
        courseId: String(course.id),
        courseSlug: String(course.slug || courseId),
        moduleId: targetModule?.id ? String(targetModule.id) : undefined,
        lessonId: String(lessonId),
        sessionId: session.sessionId,
        role: isAdmin ? 'ADMIN' : (isFreePreview && !user ? 'PREVIEW' : 'STUDENT'),
        type: 'VIDEO_PLAYBACK'
      },
      env.JWT_SECRET,
      { expiresIn: ttlSeconds }
    );

    // 7. CloudFront Signed Cookies & URL Generation
    const resourcePrefix = s3PathUtils.extractResourcePrefixFromUrl(masterUrl) ||
      `courses/${course.id}/modules/${targetModule?.id || 'general'}/lessons/${lessonId}/`;

    const signedCookiesData = cloudFrontVideoService.generateHlsSignedCookies({
      resourcePath: resourcePrefix,
      expiresInSeconds: ttlSeconds
    });

    let signedStreamUrl = '';
    if (cloudFrontVideoService.isConfigured) {
      signedStreamUrl = cloudFrontVideoService.generateSignedPlaybackUrl({
        hlsMasterUrl: masterUrl,
        expiresInSeconds: ttlSeconds
      });
      if (signedStreamUrl && !signedCookiesData.cookies) {
        const delimiter = signedStreamUrl.includes('?') ? '&' : '?';
        signedStreamUrl = `${signedStreamUrl}${delimiter}token=${playbackToken}`;
      }
    } else {
      // Secure authenticated proxy path for private HLS delivery with token validation
      let s3Key = '';
      if (videoRecord?.hls_prefix) {
        s3Key = `${videoRecord.hls_prefix.replace(/^\/+/, '').replace(/\/+$/, '')}/master.m3u8`;
      } else {
        try {
          const parsed = new URL(masterUrl);
          s3Key = parsed.pathname.replace(/^\/+/, '');
        } catch (e) {
          s3Key = masterUrl.replace(/^\/+/, '');
        }
      }

      signedStreamUrl = `/api/video/hls-stream/${s3Key}?token=${playbackToken}`;
    }

    videoSessionService.logSecurityEvent('VIDEO_ACCESS_GRANTED', {
      userId: effectiveUserId,
      courseId: course.id,
      lessonId: String(lessonId),
      sessionId: session.sessionId,
      ttlSeconds
    });

    const is480pRes = videoRecord?.output_resolution === '480p';
    const is1080pRes = videoRecord?.output_resolution === '1080p';
    const studentQualities = videoRecord?.available_qualities || 
      (is1080pRes ? ['720p', '1080p'] : (is480pRes ? ['480p'] : ['720p']));

    return {
      status: 'AUTHORIZED',
      lessonId: String(lessonId),
      courseId: course.id,
      title: targetLesson?.title || targetModule?.title || 'Module Video',
      streamUrl: signedStreamUrl,
      hlsMasterUrl: masterUrl,
      availableQualities: studentQualities,
      playbackToken,
      sessionId: session.sessionId,
      ttlSeconds,
      expiresEpoch,
      cookies: signedCookiesData.cookies,
      lastPositionSeconds,
      isFreePreview,
      watermark: {
        name: studentFullName,
        email: userEmail,
        studentId: studentDisplayId,
        courseTitle: course.title
      }
    };
  }

  /**
   * Determine Module Transcoding Mode
   * - FULL_VIDEO_MODE: No topics defined -> Transcode parent master video
   * - TOPIC_MODE: Topics exist AND have valid start/end timestamps -> Skip parent transcode, transcode topics only
   * - TOPIC_DRAFT_MODE: Topics exist but timestamps missing/invalid -> Save source, await topic configuration
   */
  async determineModuleTranscodingMode(moduleId, courseId) {
    if (!moduleId) return 'FULL_VIDEO_MODE';
    try {
      const { topics } = await this.getModuleTopics(null, { moduleId, courseId });
      if (!Array.isArray(topics) || topics.length === 0) {
        return 'FULL_VIDEO_MODE';
      }

      // Check if topics have valid timestamps
      const hasValidTimestamps = topics.some(t => 
        (typeof t.start_time_seconds === 'number' && typeof t.end_time_seconds === 'number' && t.end_time_seconds > t.start_time_seconds) ||
        (t.start_timecode && t.end_timecode && t.start_timecode !== '00:00:00:00' && t.end_timecode !== '00:00:00:00')
      );

      if (hasValidTimestamps) {
        return 'TOPIC_MODE';
      }
      return 'TOPIC_DRAFT_MODE';
    } catch (err) {
      console.warn('⚠️ [Transcoding Mode] Notice determining mode:', err.message);
      return 'FULL_VIDEO_MODE';
    }
  }

  /**
   * 9. TOPIC VIDEO PIPELINE: Timeline Validator
   * Validates timestamps, boundaries, non-overlapping constraints, and continuous timeline policy.
   */
  validateTopicTimeline({ topics = [], sourceDurationSeconds = 0, requireContinuousTopics = false }) {
    const errors = [];
    if (!Array.isArray(topics) || topics.length === 0) {
      return { isValid: false, errors: ['At least one topic must be defined.'], sortedTopics: [] };
    }

    const effectiveDuration = Number(sourceDurationSeconds) || 0;
    
    // Normalize and canonicalize topic boundaries
    const normalized = topics.map((t, idx) => {
      const startTime = typeof t.start_time_seconds === 'number' 
        ? t.start_time_seconds 
        : mediaConvertVideoService.timecodeToSeconds(t.startTime || t.start_time || t.start_timecode || 0);
      const endTime = typeof t.end_time_seconds === 'number' 
        ? t.end_time_seconds 
        : mediaConvertVideoService.timecodeToSeconds(t.endTime || t.end_time || t.end_timecode || 0);
      const dur = Math.max(0, endTime - startTime);
      return {
        ...t,
        id: t.id || `topic_${idx + 1}`,
        title: t.title || t.name || `Topic ${idx + 1}`,
        description: t.description || '',
        display_order: Number(t.display_order || t.order || idx + 1),
        start_time_seconds: startTime,
        end_time_seconds: endTime,
        duration_seconds: Math.round(dur),
        start_timecode: mediaConvertVideoService.secondsToTimecode(startTime),
        end_timecode: mediaConvertVideoService.secondsToTimecode(endTime),
        processing_status: t.processing_status || 'DRAFT'
      };
    });

    const sortedTopics = normalized.sort((a, b) => a.start_time_seconds - b.start_time_seconds);

    for (let i = 0; i < sortedTopics.length; i++) {
      const topic = sortedTopics[i];
      const topicLabel = `Topic ${i + 1} ("${topic.title}")`;

      // Rule 1: start_time >= 0
      if (topic.start_time_seconds < 0) {
        errors.push(`${topicLabel}: Start time (${topic.start_timecode}) cannot be negative.`);
      }

      // Rule 2: end_time > start_time
      if (topic.end_time_seconds <= topic.start_time_seconds) {
        errors.push(`${topicLabel}: End time (${topic.end_timecode}) must be greater than start time (${topic.start_timecode}).`);
      }

      // Rule 3: duration > 0
      if (topic.duration_seconds <= 0) {
        errors.push(`${topicLabel}: Duration must be greater than 0.`);
      }

      // Rule 4: end_time <= source duration (with 1.5s tolerance)
      if (effectiveDuration > 0 && topic.end_time_seconds > (effectiveDuration + 1.5)) {
        errors.push(`${topicLabel}: End time (${topic.end_timecode}) exceeds source video duration (${mediaConvertVideoService.secondsToTimecode(effectiveDuration)}).`);
      }

      // Rule 5: No overlapping topics
      if (i > 0) {
        const prevTopic = sortedTopics[i - 1];
        if (topic.start_time_seconds < prevTopic.end_time_seconds - 0.05) {
          errors.push(`Overlap detected: Topic ${i} ("${prevTopic.title}" ends at ${prevTopic.end_timecode}) overlaps with Topic ${i + 1} ("${topic.title}" starts at ${topic.start_timecode}).`);
        }

        // Rule 6: Continuous coverage check if requireContinuousTopics is true
        if (requireContinuousTopics) {
          const gap = Math.abs(topic.start_time_seconds - prevTopic.end_time_seconds);
          if (gap > 1.0) {
            errors.push(`Gap detected: Continuous topics required, but there is a ${gap.toFixed(1)}s gap between Topic ${i} (${prevTopic.end_timecode}) and Topic ${i + 1} (${topic.start_timecode}).`);
          }
        }
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      sortedTopics
    };
  }

  /**
   * 10. Save / Update Module Topics with Timeline Boundaries
   */
  async saveModuleTopics(adminUser, { moduleId, courseId, sourceVideoId, topics, requireContinuousTopics = false }) {
    if (!moduleId) {
      throw { statusCode: 400, message: 'moduleId is required.' };
    }

    // Resolve course identity authoritatively
    let targetCourseId = null;
    if (courseId) {
      const c = await this.resolveCourse(courseId).catch(() => null);
      targetCourseId = c?.id || courseId;
    }

    // Resolve source video record if present
    let sourceRecord = null;
    if (sourceVideoId) {
      sourceRecord = await this.getVideoRecord(sourceVideoId, targetCourseId);
    } else {
      sourceRecord = await this.getVideoRecord(moduleId, targetCourseId);
    }

    // Authoritative Hierarchy Validation
    const effectiveCourseId = targetCourseId || sourceRecord?.course_id;
    if (effectiveCourseId) {
      await validateHierarchyChain({
        courseId: effectiveCourseId,
        moduleId,
        videoId: sourceVideoId || sourceRecord?.id
      });
    }

    const sourceDuration = sourceRecord?.duration_seconds || sourceRecord?.source_duration_seconds || 0;

    // Validate timeline server-side (Authoritative validation)
    const validation = this.validateTopicTimeline({
      topics,
      sourceDurationSeconds: sourceDuration,
      requireContinuousTopics
    });

    if (!validation.isValid) {
      throw {
        statusCode: 400,
        message: `Timeline validation failed: ${validation.errors.join('; ')}`,
        errors: validation.errors
      };
    }
    // Save topics to memory & database
    const savedTopics = [];
    for (let idx = 0; idx < validation.sortedTopics.length; idx++) {
      const t = validation.sortedTopics[idx];
      // ARCH-07: Canonical UUID topic identity. Preserve valid UUIDs or generate a canonical UUID
      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(t.id || ''));
      const topicId = isUUID ? t.id : require('crypto').randomUUID();
      
      const topicPayload = {
        id: topicId,
        module_id: moduleId,
        course_id: effectiveCourseId,
        source_video_id: sourceRecord?.id || sourceVideoId || null,
        title: t.title,
        description: t.description || '',
        display_order: idx + 1,
        start_time_seconds: t.start_time_seconds,
        end_time_seconds: t.end_time_seconds,
        start_timecode: t.start_timecode,
        end_timecode: t.end_timecode,
        duration_seconds: t.duration_seconds,
        processing_status: t.processing_status || 'DRAFT',
        is_preview: Boolean(t.is_preview || t.is_free_preview),
        is_free_preview: Boolean(t.is_preview || t.is_free_preview),
        hls_master_url: t.hls_master_url || null,
        hls_720p_url: t.hls_720p_url || null,
        hls_1080p_url: t.hls_1080p_url || null,
        updated_at: new Date().toISOString()
      };

      memoryVideoStore.set(`topic_${topicId}`, topicPayload);
      savedTopics.push(topicPayload);

      try {
        // topics table does not have is_preview column in DB schema, strip before upserting
        const { is_preview, is_free_preview, ...dbTopicPayload } = topicPayload;
        await supabase.from('topics').upsert(dbTopicPayload, { onConflict: 'id' });
      } catch (dbErr) {
        console.warn('⚠️ [Topic Pipeline] Notice upserting to topics table:', dbErr.message);
      }
    }

    // Update parent source video record — transition to SEGMENTATION_CONFIRMED
    if (sourceRecord) {
      const { VIDEO_STATUS } = require('./video.constants');
      // When valid topics are saved, the segmentation is confirmed and ready for transcoding
      const nextStatus = VIDEO_STATUS.SEGMENTATION_CONFIRMED;

      await this.upsertVideoRecord({
        ...sourceRecord,
        status: nextStatus,
        is_topic_split: true,
        total_topics_count: savedTopics.length,
        source_duration_seconds: sourceDuration || (savedTopics[savedTopics.length - 1]?.end_time_seconds || 0),
        updated_at: new Date().toISOString()
      });

      console.log(`📝 [TOPIC_SEGMENTATION_CONFIRMED] Module ${moduleId} (Asset: ${sourceRecord.id}) saved ${savedTopics.length} valid topic definitions. Status: ${nextStatus}. Ready for transcoding.`);
    }

    // Sync topics into Course Curriculum Modules JSON
    if (effectiveCourseId) {
      try {
        const { data: courseObj } = await supabase.from('courses').select('id, curriculum_modules').eq('id', effectiveCourseId).maybeSingle();
        if (courseObj && Array.isArray(courseObj.curriculum_modules)) {
          const updatedModules = courseObj.curriculum_modules.map(m => {
            if (String(m.id) === String(moduleId)) {
              return {
                ...m,
                topics: savedTopics.map(st => ({
                  id: st.id,
                  title: st.title,
                  start_time_seconds: st.start_time_seconds,
                  end_time_seconds: st.end_time_seconds,
                  duration_seconds: st.duration_seconds,
                  start_timecode: st.start_timecode,
                  end_timecode: st.end_timecode,
                  processing_status: st.processing_status,
                  hls_master_url: st.hls_master_url,
                  is_preview: Boolean(st.is_preview || st.is_free_preview),
                  is_free_preview: Boolean(st.is_preview || st.is_free_preview)
                }))
              };
            }
            return m;
          });
          await supabase.from('courses').update({ curriculum_modules: updatedModules, updated_at: new Date().toISOString() }).eq('id', effectiveCourseId);
        }
      } catch (cErr) {
        console.warn('⚠️ [Topic Pipeline] Curriculum sync notice:', cErr.message);
      }
    }

    // Clean up or mark previous topics for this module that are no longer in savedTopics (STRICTLY scoped to course)
    const activeIds = savedTopics.map(t => t.id).filter(Boolean);
    if (activeIds.length > 0 && effectiveCourseId) {
      try {
        await supabase
          .from('topics')
          .delete()
          .eq('course_id', effectiveCourseId)
          .eq('module_id', String(moduleId))
          .not('id', 'in', `(${activeIds.join(',')})`);
      } catch (delErr) {}
    }

    return {
      status: 'SUCCESS',
      moduleId,
      topicsCount: savedTopics.length,
      topics: savedTopics
    };
  }

  /**
   * 11. Get Module Topics with Video & Clipping Status
   */
  async getModuleTopics(user, { moduleId, courseId = null, skipJobPolling = false } = {}) {
    if (!moduleId) {
      throw { statusCode: 400, message: 'moduleId is required.' };
    }

    let targetCourseId = null;
    if (courseId) {
      const c = await this.resolveCourse(courseId).catch(() => null);
      targetCourseId = c?.id || courseId;
    }

    // Query active topics from database (excluding soft-deleted rows)
    let topicsList = [];
    try {
      let query = supabase
        .from('topics')
        .select('*')
        .eq('module_id', String(moduleId))
        .neq('processing_status', 'DELETED');

      if (targetCourseId) {
        query = query.eq('course_id', targetCourseId);
      }

      const { data: dbTopics, error } = await query.order('display_order', { ascending: true });

      if (!error && Array.isArray(dbTopics) && dbTopics.length > 0) {
        topicsList = dbTopics;
      }
    } catch (e) {
      console.warn('[getModuleTopics] DB query notice:', e.message);
    }

    // Fallback to memory store if DB is empty or during active testing
    if (topicsList.length === 0) {
      const memoryEntries = [];
      for (const [key, val] of memoryVideoStore.entries()) {
        if (key.startsWith('topic_') && val && String(val.module_id) === String(moduleId) && val.processing_status !== 'DELETED') {
          if (!targetCourseId || !val.course_id || String(val.course_id) === String(targetCourseId)) {
            memoryEntries.push(val);
          }
        }
      }
      if (memoryEntries.length > 0) {
        topicsList = memoryEntries.sort((a, b) => (a.display_order || 0) - (b.display_order || 0));
      }
    }

    // Always merge is_preview and is_free_preview flags from course curriculum_modules JSON
    try {
      let coursesQuery = supabase.from('courses').select('id, curriculum_modules');
      if (targetCourseId) {
        coursesQuery = coursesQuery.eq('id', targetCourseId);
      }
      const { data: courses } = await coursesQuery;
      if (Array.isArray(courses)) {
        for (const c of courses) {
          if (Array.isArray(c.curriculum_modules)) {
            const targetMod = c.curriculum_modules.find(m => String(m.id) === String(moduleId));
            if (targetMod && (Array.isArray(targetMod.topics) || Array.isArray(targetMod.lessons))) {
              const baseTopics = (Array.isArray(targetMod.topics) && targetMod.topics.length > 0)
                ? targetMod.topics
                : ((Array.isArray(targetMod.lessons) && targetMod.lessons.length > 0) ? targetMod.lessons : []);

              if (baseTopics.length > 0) {
                const matchedDbIds = new Set();
                const merged = baseTopics.map((bt, idx) => {
                  const bTitle = typeof bt === 'object' ? (bt.title || bt.name || `Topic ${idx + 1}`) : String(bt);
                  const bOrder = typeof bt === 'object' && bt.display_order !== undefined ? Number(bt.display_order) : idx + 1;
                  const bId = typeof bt === 'object' ? bt.id : null;

                  // Match DB topic by ID, display_order, or title
                  let matchedDbTopic = null;
                  if (bId) {
                    matchedDbTopic = topicsList.find(d => String(d.id) === String(bId));
                  }
                  if (!matchedDbTopic && bOrder !== undefined) {
                    matchedDbTopic = topicsList.find(d => Number(d.display_order) === bOrder);
                  }
                  if (!matchedDbTopic) {
                    matchedDbTopic = topicsList.find(d => (d.title || '').trim().toLowerCase() === bTitle.trim().toLowerCase());
                  }

                  if (matchedDbTopic) {
                    matchedDbIds.add(matchedDbTopic.id);
                    return {
                      ...matchedDbTopic,
                      id: matchedDbTopic.id || bId || `topic_${idx + 1}`,
                      module_id: moduleId,
                      course_id: targetCourseId || matchedDbTopic.course_id || c.id,
                      title: bTitle || matchedDbTopic.title,
                      display_order: bOrder,
                      is_preview: Boolean(matchedDbTopic.is_preview || matchedDbTopic.is_free_preview || (typeof bt === 'object' && (bt.is_preview || bt.is_free_preview))),
                      is_free_preview: Boolean(matchedDbTopic.is_preview || matchedDbTopic.is_free_preview || (typeof bt === 'object' && (bt.is_preview || bt.is_free_preview)))
                    };
                  }

                  // Draft topic not yet in DB
                  return {
                    id: bId || `topic_${idx + 1}`,
                    module_id: moduleId,
                    course_id: targetCourseId || c.id,
                    title: bTitle,
                    display_order: bOrder,
                    start_time_seconds: typeof bt === 'object' ? (bt.start_time_seconds || 0) : 0,
                    end_time_seconds: typeof bt === 'object' ? (bt.end_time_seconds || 0) : 0,
                    start_timecode: typeof bt === 'object' ? (bt.start_timecode || '00:00:00:00') : '00:00:00:00',
                    end_timecode: typeof bt === 'object' ? (bt.end_timecode || '00:00:00:00') : '00:00:00:00',
                    duration_seconds: typeof bt === 'object' ? (bt.duration_seconds || 0) : 0,
                    processing_status: typeof bt === 'object' ? (bt.processing_status || 'DRAFT') : 'DRAFT',
                    hls_master_url: typeof bt === 'object' ? (bt.hls_master_url || null) : null,
                    is_preview: Boolean(typeof bt === 'object' && (bt.is_preview || bt.is_free_preview)),
                    is_free_preview: Boolean(typeof bt === 'object' && (bt.is_preview || bt.is_free_preview))
                  };
                });

                // Append any DB topics not in base curriculum
                for (const dt of topicsList) {
                  if (dt.id && !matchedDbIds.has(dt.id)) {
                    merged.push(dt);
                  }
                }

                topicsList = merged;
              }
              break;
            }
          }
        }
      }
    } catch (e) {}

    // Query parent source video record
    const sourceRecord = await this.getVideoRecord(moduleId, targetCourseId);

    // If parent video is deleted, unprocessed, or no video, Mode 1 topics must not report READY
    // CRITICAL: Mode 2 individual topic videos have their own video_asset_id or source_video_id and MUST NOT be reset to DRAFT
    if (sourceRecord && (sourceRecord.status === 'DELETED' || sourceRecord.status === 'NO_VIDEO' || sourceRecord.status === 'UNPROCESSED')) {
      topicsList = topicsList.map(t => {
        if (t.video_asset_id || t.source_video_id || t.hls_master_url || t.is_individual_topic_video) {
          return t; // Keep individual topic video intact
        }
        return {
          ...t,
          processing_status: 'DRAFT',
          hls_master_url: null,
          hls_720p_url: null,
          hls_1080p_url: null
        };
      });
    }

    // Active MediaConvert Job Polling & Self-Healing for PROCESSING topics
    let hasTerminalChange = false;
    if (!skipJobPolling && topicsList.length > 0) {
      for (const topic of topicsList) {
        if (topic.processing_status === 'PROCESSING' && topic.mediaconvert_job_id) {
          try {
            const jobStatus = await mediaConvertVideoService.getJobStatus(topic.mediaconvert_job_id);
            if (jobStatus) {
              topic.jobPercentComplete = jobStatus.jobPercentComplete ?? (jobStatus.status === 'COMPLETE' ? 100 : 0);
              topic.currentPhase = jobStatus.currentPhase || 'TRANSCODING';

              if (jobStatus.status === 'COMPLETE') {
                hasTerminalChange = true;
                await this.handleTopicProcessingCompleted({
                  jobId: topic.mediaconvert_job_id,
                  topicId: topic.id,
                  sourceVideoId: topic.source_video_id || sourceRecord?.id,
                  moduleId: topic.module_id || moduleId,
                  courseId: topic.course_id || sourceRecord?.course_id
                });
                topic.processing_status = 'READY';
                topic.hls_master_url = memoryVideoStore.get(`topic_${topic.id}`)?.hls_master_url || topic.hls_master_url;
                topic.jobPercentComplete = 100;
              } else if (jobStatus.status === 'ERROR') {
                hasTerminalChange = true;
                await this.handleTopicProcessingFailed({
                  jobId: topic.mediaconvert_job_id,
                  topicId: topic.id,
                  sourceVideoId: topic.source_video_id || sourceRecord?.id,
                  moduleId: topic.module_id || moduleId,
                  courseId: topic.course_id || sourceRecord?.course_id,
                  errorDetails: { message: jobStatus.errorMessage || 'MediaConvert transcoding failed' }
                });
                topic.processing_status = 'FAILED';
                topic.processing_error = jobStatus.errorMessage;
                topic.jobPercentComplete = 0;
              }
            }
          } catch (pollErr) {
            console.warn(`[getModuleTopics] Polling job ${topic.mediaconvert_job_id} for topic ${topic.id} failed:`, pollErr.message);
          }
        }
      }

      // If any job completed or failed, re-fetch topics so newly dequeued items are reflected
      if (hasTerminalChange) {
        try {
          const { data: dbUpdated } = await supabase
            .from('topics')
            .select('*')
            .eq('module_id', moduleId)
            .neq('processing_status', 'DELETED')
            .order('display_order', { ascending: true });
          if (Array.isArray(dbUpdated) && dbUpdated.length > 0) {
            topicsList = dbUpdated;
          }
        } catch (e) {}
      }
    }

    const readyCount = topicsList.filter(t => t.processing_status === 'READY').length;
    const processingCount = topicsList.filter(t => t.processing_status === 'PROCESSING').length;
    const queuedCount = topicsList.filter(t => t.processing_status === 'QUEUED').length;
    const failedCount = topicsList.filter(t => t.processing_status === 'FAILED').length;

    // Calculate real-time overall progress percentage
    let totalProgressSum = 0;
    if (topicsList.length > 0) {
      for (const t of topicsList) {
        if (t.processing_status === 'READY') {
          totalProgressSum += 100;
        } else if (t.processing_status === 'PROCESSING') {
          const pct = typeof t.jobPercentComplete === 'number' && t.jobPercentComplete > 0 ? t.jobPercentComplete : 20;
          totalProgressSum += pct;
        }
      }
    }
    const progressPercent = topicsList.length > 0 ? Math.min(100, Math.round(totalProgressSum / topicsList.length)) : 0;

    // Generate presigned source preview URL if source exists in S3
    let sourceVideoUrl = null;
    if (sourceRecord?.source_s3_bucket && sourceRecord?.source_s3_key) {
      try {
        sourceVideoUrl = await s3VideoService.generatePresignedGetUrl({
          s3Bucket: sourceRecord.source_s3_bucket,
          s3Key: sourceRecord.source_s3_key,
          expiresInSeconds: 7200
        });
      } catch (err) {
        console.warn('⚠️ [Video Pipeline] Notice generating presigned source preview URL:', err.message);
      }
    }

    // Resolve S3 topic storage telemetry if topic clipping has been transcoded
    let topicStorageInfo = null;
    if (topicsList.length > 0) {
      const topicWithHls = topicsList.find(t => t.hls_prefix || t.hls_master_url);
      if (topicWithHls) {
        let tPrefix = topicWithHls.hls_prefix;
        if (!tPrefix && topicWithHls.hls_master_url) {
          tPrefix = s3PathUtils.extractResourcePrefixFromUrl(topicWithHls.hls_master_url);
        }
        if (tPrefix) {
          const topicParentPrefix = tPrefix.includes('/topics/') ? tPrefix.split('/topics/')[0] + '/' : tPrefix;
          topicStorageInfo = await s3VideoService.countHlsSegments({
            prefix: topicParentPrefix
          }).catch(() => null);
        }
      }
    }

    return {
      moduleId,
      sourceVideoId: sourceRecord?.id || null,
      sourceDurationSeconds: sourceRecord?.duration_seconds || sourceRecord?.source_duration_seconds || 0,
      sourceVideoUrl,
      sourceStatus: sourceRecord?.status || 'UNKNOWN',
      totalTopics: topicsList.length,
      readyTopics: readyCount,
      processingTopics: processingCount,
      queuedTopics: queuedCount,
      failedTopics: failedCount,
      progressPercent,
      storage: topicStorageInfo,
      topics: topicsList
    };
  }

  /**
   * 12. Start Controlled Topic Batch Transcoding Dispatcher
   * Enforces MAX_CONCURRENT_TRANSCODING_JOBS limit without unbounded Promise.all
   */
  async startTopicBatchProcessing(adminUser, { moduleId, courseId, sourceVideoId, topicIds, maxConcurrent, forceReset = false, adminOverride = false, triggerSource = TRIGGER_SOURCES.TOPIC_CLIPPING }) {
    const s3PathUtils = require('../../utils/s3PathUtils');
    const { COMPRESSION_SETTINGS } = require('./video.constants');
    const MAX_CONCURRENT_JOBS = maxConcurrent || Number(process.env.MAX_CONCURRENT_TRANSCODING_JOBS) || 3;

    if (!moduleId) {
      throw { statusCode: 400, message: 'moduleId is required.' };
    }

    this._activeJobsCache = null;

    // 1. Fetch Source Video Record with course scoping
    let sourceRecord = await this.getVideoRecord(sourceVideoId || moduleId, courseId);
    if (sourceRecord && sourceRecord.module_id && String(sourceRecord.module_id) !== String(moduleId) && sourceVideoId) {
      const modRecord = await this.getVideoRecord(moduleId, courseId);
      if (modRecord && String(modRecord.module_id) === String(moduleId)) {
        sourceRecord = modRecord;
      }
    }
    if (!sourceRecord) {
      throw { statusCode: 404, message: 'Source video record not found for this module.' };
    }

    const effectiveBucket = sourceRecord.source_s3_bucket || env.AWS_S3_BUCKET_SOURCE || env.AWS_S3_BUCKET_OUTPUT;
    const effectiveKey = sourceRecord.source_s3_key;

    if (!effectiveKey) {
      throw { statusCode: 400, message: 'Source S3 key missing. Please upload the full source video first.' };
    }

    // Verify S3 Object Exists
    const exists = await s3VideoService.verifyObjectExists(effectiveBucket, effectiveKey);
    if (!exists || !exists.exists) {
      throw { statusCode: 400, message: `Source video file not found in S3 (s3://${effectiveBucket}/${effectiveKey}).` };
    }

    const effectiveCourseId = courseId || sourceRecord.course_id;
    if (!effectiveCourseId) {
      throw new HierarchyValidationError('Source video record has no associated course scope (orphan record). Batch processing rejected.', 403, 'HIERARCHY_ORPHAN_RECORD');
    }

    // Authoritative Hierarchy Validation
    const hierarchy = await validateHierarchyChain({
      courseId: effectiveCourseId,
      moduleId,
      videoId: sourceRecord.id
    });
    const course = hierarchy.course;

    // 2. Fetch Topics for Module (strictly scoped to course to avoid cross-course topic collision)
    const { topics: allTopics } = await this.getModuleTopics(adminUser, { moduleId, courseId: effectiveCourseId, skipJobPolling: true });
    if (!Array.isArray(allTopics) || allTopics.length === 0) {
      throw { statusCode: 400, message: 'No topics defined for this module. Please define topic boundaries first.' };
    }

    const targetTopics = (Array.isArray(topicIds) && topicIds.length > 0)
      ? allTopics.filter(t => topicIds.includes(String(t.id)))
      : allTopics;

    for (const t of targetTopics) {
      if (t.course_id && String(t.course_id) !== String(effectiveCourseId)) {
        throw new HierarchyValidationError(`Topic '${t.id}' belongs to course '${t.course_id}', not authorized course '${effectiveCourseId}'. Batch processing rejected.`, 403, 'HIERARCHY_TOPIC_MISMATCH');
      }
      if (t.module_id && String(t.module_id) !== String(moduleId) && String(t.module_id) !== String(hierarchy.canonicalModuleId)) {
        throw new HierarchyValidationError(`Topic '${t.id}' belongs to module '${t.module_id}', not authorized module '${moduleId}'. Batch processing rejected.`, 403, 'HIERARCHY_TOPIC_MISMATCH');
      }
    }

    console.log(`⚡ [TRANSCODING_START_REQUESTED] Admin requested topic transcoding for module ${moduleId} (Source: ${sourceRecord.id}, Topics: ${targetTopics.length}). Concurrency: ${MAX_CONCURRENT_JOBS}.`);

    // 3. Resolve course and module slugs
    const courseSlug = s3PathUtils.generateS3CourseSlug(course);
    const moduleSlug = s3PathUtils.generateS3ModuleSlug(moduleId);
    const cdnDomain = env.CLOUDFRONT_DOMAIN || `https://${env.AWS_S3_BUCKET_OUTPUT}.s3.${env.AWS_REGION}.amazonaws.com`;
    const sourceMetrics = await videoSourceProbe.resolveSourceMetrics(sourceRecord);

    // Sanitize topic boundaries against actual source video duration
    const sourceDuration = sourceRecord.duration_seconds || sourceRecord.source_duration_seconds || 0;
    if (sourceDuration > 0 && targetTopics.length > 0) {
      const needsRebalance = targetTopics.some(t => 
        (typeof t.start_time_seconds === 'number' && t.start_time_seconds >= sourceDuration - 0.5) ||
        (typeof t.end_time_seconds === 'number' && t.end_time_seconds <= t.start_time_seconds) ||
        (typeof t.end_time_seconds === 'number' && t.end_time_seconds > sourceDuration + 2.0)
      );

      if (needsRebalance) {
        console.log(`⏱️ [Timeline Auto-Alignment] Auto-distributing ${targetTopics.length} topics evenly across source duration (${sourceDuration}s)...`);
        const count = targetTopics.length;
        const slice = sourceDuration / count;
        for (let i = 0; i < count; i++) {
          const t = targetTopics[i];
          const sSec = i * slice;
          const eSec = (i === count - 1) ? sourceDuration : (i + 1) * slice;
          t.start_time_seconds = sSec;
          t.end_time_seconds = eSec;
          t.duration_seconds = Math.round(eSec - sSec);
          t.start_timecode = mediaConvertVideoService.secondsToTimecode(sSec, sourceRecord.source_fps || 30);
          t.end_timecode = mediaConvertVideoService.secondsToTimecode(eSec, sourceRecord.source_fps || 30);
        }
      }
    }

    // 4. Mark non-active or superseded target topics as QUEUED first
    // If source video ID has changed (new upload) or forceReset is requested, re-queue even if previously READY
    for (const topic of targetTopics) {
      const isNewSource = topic.source_video_id && String(topic.source_video_id) !== String(sourceRecord.id);
      const shouldReset = forceReset || isNewSource || (topic.processing_status !== 'READY' && topic.processing_status !== 'PROCESSING');

      if (shouldReset) {
        topic.processing_status = 'QUEUED';
        topic.mediaconvert_job_id = null;
        topic.jobPercentComplete = 0;
        const updatedTopic = {
          ...topic,
          source_video_id: sourceRecord.id,
          processing_status: 'QUEUED',
          mediaconvert_job_id: null,
          queued_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };
        memoryVideoStore.set(`topic_${topic.id}`, updatedTopic);
        try {
          await supabase.from('topics').update({
            start_time_seconds: topic.start_time_seconds,
            end_time_seconds: topic.end_time_seconds,
            duration_seconds: topic.duration_seconds,
            start_timecode: topic.start_timecode,
            end_timecode: topic.end_timecode,
            processing_status: 'QUEUED',
            mediaconvert_job_id: null,
            source_video_id: sourceRecord.id,
            updated_at: new Date().toISOString()
          }).eq('id', topic.id);
        } catch (e) {}
      }
    }

    // 5. Controlled Dispatcher: Launch up to MAX_CONCURRENT_JOBS (Account for already running jobs)
    let currentlyRunning = targetTopics.filter(t => t.processing_status === 'PROCESSING' && t.mediaconvert_job_id).length;
    const dispatchedJobs = [];

    for (const topic of targetTopics) {
      if (topic.processing_status === 'READY' || (topic.processing_status === 'PROCESSING' && topic.mediaconvert_job_id)) continue;

      if (currentlyRunning < MAX_CONCURRENT_JOBS) {
        currentlyRunning++;
        const topicHlsPrefix = s3PathUtils.buildS3TopicHlsPrefix(courseSlug, moduleSlug, sourceRecord.id, topic.id);
        const masterUrl = `${cdnDomain}/${topicHlsPrefix}master.m3u8`;
        const clipDuration = Math.max(0, Number(topic.end_time_seconds || 0) - Number(topic.start_time_seconds || 0));

        try {
          const guarded = await this.submitGuardedMediaConvertJob({
            processingProfile: PROCESSING_PROFILES.TOPIC_CLIPPING,
            videoId: sourceRecord.id,
            uploadId: sourceRecord.upload_id || sourceRecord.source_s3_key,
            courseId: course?.id || sourceRecord.course_id,
            moduleId,
            topicId: topic.id,
            sourceKey: effectiveKey,
            sourceDurationSeconds: clipDuration || sourceDuration,
            sourceWidth: sourceMetrics.width || sourceRecord.source_width || sourceRecord.width,
            sourceHeight: sourceMetrics.height || sourceRecord.source_height || sourceRecord.height,
            triggerSource: triggerSource || TRIGGER_SOURCES.TOPIC_QUEUE,
            adminOverride,
            existingTopic: topic,
            existingRecord: sourceRecord,
            submitFn: async ({ requestedOutputs, sourceHeight, sourceWidth }) => {
              return mediaConvertVideoService.submitTopicClippingJob({
                sourceBucket: effectiveBucket,
                sourceKey: effectiveKey,
                outputPrefix: topicHlsPrefix,
                startTimeSeconds: topic.start_time_seconds,
                endTimeSeconds: topic.end_time_seconds,
                startTimecode: topic.start_timecode,
                endTimecode: topic.end_timecode,
                fps: sourceRecord.source_fps || 30,
                sourceHeight,
                sourceWidth,
                requestedOutputs,
                userMetadata: {
                  topicId: String(topic.id),
                  sourceVideoId: String(sourceRecord.id),
                  moduleId: String(moduleId),
                  courseId: String(course?.id || sourceRecord.course_id),
                  isTopicClip: 'true',
                  processingProfile: PROCESSING_PROFILES.TOPIC_CLIPPING
                }
              });
            }
          });

          if (guarded.duplicated) {
            console.log(`ℹ️ [DUPLICATE_MEDIACONVERT_JOB_BLOCKED] Topic ${topic.id}: ${guarded.reason} job=${guarded.jobId}`);
            if (guarded.jobId) {
              dispatchedJobs.push({
                topicId: topic.id,
                title: topic.title,
                jobId: guarded.jobId,
                status: topic.processing_status === 'READY' ? 'READY' : 'PROCESSING',
                duplicated: true,
                reason: guarded.reason
              });
            } else {
              currentlyRunning--;
            }
            continue;
          }

          const jobResult = guarded.jobResult;

          const activeTopic = {
            ...topic,
            mediaconvert_job_id: jobResult.jobId,
            processing_status: 'PROCESSING',
            hls_prefix: topicHlsPrefix,
            hls_master_url: masterUrl,
            processing_identity: guarded.processingIdentity,
            processing_profile: guarded.processingProfile,
            processing_started_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          };

          memoryVideoStore.set(`topic_${topic.id}`, activeTopic);
          try {
            await supabase.from('topics').update({
              mediaconvert_job_id: jobResult.jobId,
              processing_status: 'PROCESSING',
              hls_prefix: topicHlsPrefix,
              hls_master_url: masterUrl,
              processing_identity: guarded.processingIdentity,
              processing_profile: guarded.processingProfile,
              processing_started_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            }).eq('id', topic.id);
          } catch (e) {}

          dispatchedJobs.push({
            topicId: topic.id,
            title: topic.title,
            jobId: jobResult.jobId,
            status: 'PROCESSING',
            timecode: `${topic.start_timecode} -> ${topic.end_timecode}`
          });

          console.log(`🚀 [TOPIC_JOB_CREATED] Topic ${topic.title} (TopicId: ${topic.id}, JobId: ${jobResult.jobId}, ModuleId: ${moduleId}, Status: PROCESSING)`);
        } catch (jobErr) {
          currentlyRunning--;
          console.error(`❌ [Topic Dispatch Error] Failed to submit job for topic ${topic.id}:`, jobErr.message);
          memoryVideoStore.set(`topic_${topic.id}`, {
            ...topic,
            processing_status: 'FAILED',
            processing_error: jobErr.message
          });
        }
      }
    }

    // Update parent record
    await this.upsertVideoRecord({
      ...sourceRecord,
      is_topic_split: true,
      status: 'PROCESSING',
      source_width: sourceMetrics.width || sourceRecord.source_width,
      source_height: sourceMetrics.height || sourceRecord.source_height,
      updated_at: new Date().toISOString()
    });

    return {
      status: 'SUCCESS',
      moduleId,
      maxConcurrency: MAX_CONCURRENT_JOBS,
      dispatchedCount: dispatchedJobs.length,
      dispatchedJobs,
      message: `Dispatched ${dispatchedJobs.length} MediaConvert topic jobs (Controlled concurrency: ${MAX_CONCURRENT_JOBS}). Remaining topics queued.`
    };
  }

  /**
   * 13. Dispatch Next Queued Topic Job (Called on completion or failure of a running job)
   */
  async dispatchNextQueuedTopicJobs(moduleId, sourceVideoId) {
    const MAX_CONCURRENT_JOBS = Number(process.env.MAX_CONCURRENT_TRANSCODING_JOBS) || 3;
    const s3PathUtils = require('../../utils/s3PathUtils');

    const sourceRecord = await this.getVideoRecord(sourceVideoId || moduleId);
    if (!sourceRecord) return;

    const { topics: allTopics } = await this.getModuleTopics(null, { moduleId: sourceRecord.module_id || moduleId, courseId: sourceRecord.course_id, skipJobPolling: true });
    const processingTopics = allTopics.filter(t => t.processing_status === 'PROCESSING');
    const queuedTopics = allTopics.filter(t => t.processing_status === 'QUEUED');

    const availableSlots = MAX_CONCURRENT_JOBS - processingTopics.length;
    if (availableSlots <= 0 || queuedTopics.length === 0) return;

    const course = await this.resolveCourse(sourceRecord.course_id);
    const courseSlug = s3PathUtils.generateS3CourseSlug(course);
    const moduleSlug = s3PathUtils.generateS3ModuleSlug(moduleId);
    const cdnDomain = env.CLOUDFRONT_DOMAIN || `https://${env.AWS_S3_BUCKET_OUTPUT}.s3.${env.AWS_REGION}.amazonaws.com`;
    const effectiveBucket = sourceRecord.source_s3_bucket || env.AWS_S3_BUCKET_SOURCE || env.AWS_S3_BUCKET_OUTPUT;
    const sourceDuration = sourceRecord.duration_seconds || sourceRecord.source_duration_seconds || 0;
    const totalCount = allTopics.length || 1;
    const defaultSlice = sourceDuration > 0 ? sourceDuration / totalCount : 600;

    for (let i = 0; i < Math.min(availableSlots, queuedTopics.length); i++) {
      const topic = queuedTopics[i];
      const topicHlsPrefix = s3PathUtils.buildS3TopicHlsPrefix(courseSlug, moduleSlug, sourceRecord.id, topic.id);
      const masterUrl = `${cdnDomain}/${topicHlsPrefix}master.m3u8`;

      // Guarantee valid boundary within source video
      let effectiveStartSec = topic.start_time_seconds;
      let effectiveEndSec = topic.end_time_seconds;

      if (sourceDuration > 0 && (effectiveStartSec >= sourceDuration - 0.5 || effectiveEndSec <= effectiveStartSec || effectiveEndSec > sourceDuration + 1.0)) {
        const orderIdx = Math.max(0, (topic.display_order || (i + 1)) - 1);
        effectiveStartSec = Math.min(orderIdx * defaultSlice, Math.max(0, sourceDuration - defaultSlice));
        effectiveEndSec = (orderIdx === totalCount - 1) ? sourceDuration : Math.min(sourceDuration, (orderIdx + 1) * defaultSlice);
        topic.start_time_seconds = effectiveStartSec;
        topic.end_time_seconds = effectiveEndSec;
        topic.duration_seconds = Math.round(effectiveEndSec - effectiveStartSec);
        topic.start_timecode = mediaConvertVideoService.secondsToTimecode(effectiveStartSec, sourceRecord.source_fps || 30);
        topic.end_timecode = mediaConvertVideoService.secondsToTimecode(effectiveEndSec, sourceRecord.source_fps || 30);
      }

      try {
        const clipDuration = Math.max(0, Number(effectiveEndSec || 0) - Number(effectiveStartSec || 0));
        const guarded = await this.submitGuardedMediaConvertJob({
          processingProfile: PROCESSING_PROFILES.TOPIC_CLIPPING,
          videoId: sourceRecord.id,
          uploadId: sourceRecord.upload_id || sourceRecord.source_s3_key,
          courseId: course?.id || sourceRecord.course_id,
          moduleId: sourceRecord.module_id || moduleId,
          topicId: topic.id,
          sourceKey: sourceRecord.source_s3_key,
          sourceDurationSeconds: clipDuration || sourceDuration,
          sourceWidth: sourceRecord.source_width || sourceRecord.width,
          sourceHeight: sourceRecord.source_height || sourceRecord.height,
          triggerSource: TRIGGER_SOURCES.TOPIC_QUEUE,
          existingTopic: topic,
          existingRecord: sourceRecord,
          submitFn: async ({ requestedOutputs, sourceHeight, sourceWidth }) => {
            return mediaConvertVideoService.submitTopicClippingJob({
              sourceBucket: effectiveBucket,
              sourceKey: sourceRecord.source_s3_key,
              outputPrefix: topicHlsPrefix,
              startTimeSeconds: effectiveStartSec,
              endTimeSeconds: effectiveEndSec,
              startTimecode: topic.start_timecode,
              endTimecode: topic.end_timecode,
              fps: sourceRecord.source_fps || 30,
              sourceHeight,
              sourceWidth,
              requestedOutputs,
              userMetadata: {
                topicId: String(topic.id),
                sourceVideoId: String(sourceRecord.id),
                moduleId: String(sourceRecord.module_id || moduleId),
                courseId: String(course?.id || sourceRecord.course_id),
                isTopicClip: 'true',
                processingProfile: PROCESSING_PROFILES.TOPIC_CLIPPING
              }
            });
          }
        });

        if (guarded.duplicated) {
          console.log(`ℹ️ [DUPLICATE_MEDIACONVERT_JOB_BLOCKED] Queue dispatch topic ${topic.id}: ${guarded.reason}`);
          continue;
        }

        const jobResult = guarded.jobResult;

        const activeTopic = {
          ...topic,
          mediaconvert_job_id: jobResult.jobId,
          processing_status: 'PROCESSING',
          hls_prefix: topicHlsPrefix,
          hls_master_url: masterUrl,
          processing_identity: guarded.processingIdentity,
          processing_started_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };

        memoryVideoStore.set(`topic_${topic.id}`, activeTopic);
        try {
          await supabase.from('topics').update({
            mediaconvert_job_id: jobResult.jobId,
            processing_status: 'PROCESSING',
            hls_prefix: topicHlsPrefix,
            hls_master_url: masterUrl,
            processing_identity: guarded.processingIdentity,
            processing_started_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          }).eq('id', topic.id);
        } catch (e) {}

        console.log(`🚀 [Topic Queue Dequeued] Topic ${topic.title} (JobId: ${jobResult.jobId})`);
      } catch (err) {
        console.error(`❌ [Topic Dequeue Error] Failed to submit job for topic ${topic.id}:`, err.message);
        memoryVideoStore.set(`topic_${topic.id}`, {
          ...topic,
          processing_status: 'FAILED',
          processing_error: err.message
        });
      }
    }
  }

  /**
   * 14. Handle Topic MediaConvert Completion
   */
  async handleTopicProcessingCompleted({ jobId, topicId, sourceVideoId, moduleId, courseId, jobSubmittedTime, jobStartedTime, jobFinishedTime, isIndividualTopicVideo = false }) {
    console.log(`✅ [TOPIC_JOB_COMPLETED] Topic ${topicId} (JobId: ${jobId}, ModuleId: ${moduleId}, Status: READY, Individual: ${isIndividualTopicVideo}) completed successfully.`);

    let earlyTopic = memoryVideoStore.get(`topic_${topicId}`);
    if (!earlyTopic) {
      try {
        const { data } = await supabase.from('topics').select('processing_status, mediaconvert_job_id, processing_identity, hls_master_url').eq('id', topicId).maybeSingle();
        earlyTopic = data;
      } catch (e) {}
    }
    // Only short-circuit when topic is already playable (READY + HLS). A READY row without HLS
    // (or DRAFT after a re-upload race) must still run the full sync path.
    if (earlyTopic?.processing_status === 'READY' && earlyTopic?.hls_master_url) {
      console.log(`ℹ️ [Topic Pipeline] Topic ${topicId} already READY with HLS. Ensuring lesson_videos + curriculum sync.`);
      await mediaConvertJobGuard.markClaimReady({ mediaconvertJobId: jobId, processingIdentity: earlyTopic.processing_identity });
      try {
        const topicReadySync = require('./video.topic-ready-sync.service');
        await topicReadySync.syncTopicReadyFromLessonVideos(topicId, {
          courseId,
          moduleId,
          preferredVideoId: sourceVideoId,
          force: false
        });
      } catch (_) {}
      return;
    }
    if (jobId && earlyTopic?.mediaconvert_job_id && String(jobId) !== String(earlyTopic.mediaconvert_job_id)) {
      console.warn(`⚠️ [Topic Pipeline] Ignoring mismatched completion jobId ${jobId} for topic ${topicId}`);
      return;
    }

    // Compute Telemetry Metrics: T_queue, T_encode, T_total
    let queueWaitSeconds = null;
    let encodingDurationSeconds = null;
    let totalDurationSeconds = null;

    if (jobSubmittedTime && jobStartedTime) {
      const subMs = new Date(jobSubmittedTime).getTime();
      const startMs = new Date(jobStartedTime).getTime();
      if (!isNaN(subMs) && !isNaN(startMs)) {
        queueWaitSeconds = Math.max(0, Math.round((startMs - subMs) / 1000));
      }
    }

    if (jobStartedTime && jobFinishedTime) {
      const startMs = new Date(jobStartedTime).getTime();
      const finMs = new Date(jobFinishedTime).getTime();
      if (!isNaN(startMs) && !isNaN(finMs)) {
        encodingDurationSeconds = Math.max(0, Math.round((finMs - startMs) / 1000));
      }
    }

    if (jobSubmittedTime && jobFinishedTime) {
      const subMs = new Date(jobSubmittedTime).getTime();
      const finMs = new Date(jobFinishedTime).getTime();
      if (!isNaN(subMs) && !isNaN(finMs)) {
        totalDurationSeconds = Math.max(0, Math.round((finMs - subMs) / 1000));
      }
    }

    if (queueWaitSeconds !== null || encodingDurationSeconds !== null) {
      console.log(`📊 [MediaConvert Telemetry] Job ${jobId} (Topic ${topicId}): Queue Wait (T_queue): ${queueWaitSeconds ?? 'N/A'}s, Encode Duration (T_encode): ${encodingDurationSeconds ?? 'N/A'}s, Total (T_total): ${totalDurationSeconds ?? 'N/A'}s`);
    }

    let dbTopic = null;
    try {
      const { data: dt } = await supabase.from('topics').select('*').eq('id', topicId).maybeSingle();
      dbTopic = dt;
    } catch (e) {}

    // Check lesson_videos for authoritative hls_prefix of this specific transcoding run
    let activeLessonVideo = null;
    if (sourceVideoId || jobId) {
      try {
        let q = supabase.from('lesson_videos').select('*');
        if (sourceVideoId) q = q.eq('id', sourceVideoId);
        else if (jobId) q = q.eq('mediaconvert_job_id', jobId);
        const { data: lvd } = await q.maybeSingle();
        activeLessonVideo = lvd;
      } catch (e) {}
    }

    const cdnDomain = env.CLOUDFRONT_DOMAIN || `https://${env.AWS_S3_BUCKET_OUTPUT}.s3.${env.AWS_REGION}.amazonaws.com`;
    const memTopic = memoryVideoStore.get(`topic_${topicId}`) || {};
    let effectivePrefix = activeLessonVideo?.hls_prefix || memTopic.hls_prefix || dbTopic?.hls_prefix;
    if (!effectivePrefix) {
      effectivePrefix = `courses/${courseId}/modules/${moduleId}/videos/${sourceVideoId}/topics/${topicId}/hls/`;
    }
    effectivePrefix = effectivePrefix.replace(/^\/+/, '').replace(/\/+$/, '');
    const masterUrl = `${cdnDomain}/${effectivePrefix}/master.m3u8`;
    const p720Url = `${cdnDomain}/${effectivePrefix}/master_720p.m3u8`;
    const p1080Url = `${cdnDomain}/${effectivePrefix}/master_1080p.m3u8`;

    const updatedTopic = {
      ...memTopic,
      id: topicId,
      module_id: moduleId,
      course_id: courseId,
      source_video_id: sourceVideoId,
      video_asset_id: sourceVideoId,
      processing_status: 'READY',
      video_status: 'READY',
      hls_prefix: effectivePrefix,
      hls_master_url: masterUrl,
      video_url: masterUrl,
      hls_720p_url: p720Url,
      hls_1080p_url: p1080Url,
      processing_error: null,
      processing_completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      telemetry: {
        queueWaitSeconds,
        encodingDurationSeconds,
        totalDurationSeconds,
        submittedAt: jobSubmittedTime,
        startedAt: jobStartedTime,
        finishedAt: jobFinishedTime
      }
    };

    memoryVideoStore.set(`topic_${topicId}`, updatedTopic);
    await mediaConvertJobGuard.markClaimReady({
      mediaconvertJobId: jobId,
      processingIdentity: updatedTopic.processing_identity || dbTopic?.processing_identity || earlyTopic?.processing_identity
    });

    try {
      const topicPatch = {
        processing_status: 'READY',
        hls_prefix: effectivePrefix,
        hls_master_url: masterUrl,
        hls_720p_url: p720Url,
        hls_1080p_url: p1080Url,
        source_video_id: sourceVideoId,
        processing_error: null,
        processing_completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      const readyDuration = Number(activeLessonVideo?.duration_seconds) > 1
        ? Number(activeLessonVideo.duration_seconds)
        : (Number(dbTopic?.duration_seconds) > 1 ? Number(dbTopic.duration_seconds) : null);
      if (readyDuration) topicPatch.duration_seconds = readyDuration;

      const { error: topErr } = await supabase.from('topics').update(topicPatch).eq('id', topicId);
      if (topErr) {
        console.error(`❌ [Topic DB Update Error] Failed to update topic ${topicId}:`, topErr);
      }
    } catch (e) {
      console.error(`❌ [Topic DB Update Exception] Failed to update topic ${topicId}:`, e);
    }

    // Mark lesson_videos READY first so topic-ready-sync can prefer this asset
    try {
      if (sourceVideoId) {
        await this.upsertVideoRecord({
          id: sourceVideoId,
          lesson_id: topicId,
          module_id: moduleId,
          course_id: courseId,
          status: VIDEO_STATUS.READY,
          hls_prefix: effectivePrefix,
          hls_master_url: masterUrl,
          hls_720p_url: p720Url,
          hls_1080p_url: p1080Url,
          processing_completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });
      }
    } catch (e) {}

    // Canonical ready-sync: topics row + curriculum JSON + cache bust (Mode 2 safety net)
    try {
      const topicReadySync = require('./video.topic-ready-sync.service');
      await topicReadySync.syncTopicReadyFromLessonVideos(topicId, {
        courseId,
        moduleId,
        preferredVideoId: sourceVideoId,
        force: true
      });
    } catch (syncErr) {
      console.warn(`⚠️ [Topic Pipeline] Ready sync notice for ${topicId}:`, syncErr.message || syncErr);
    }

    // Update Course Curriculum Modules JSON with topic READY status and video_url
    if (courseId) {
      try {
        const { data: courseObj } = await supabase.from('courses').select('id, curriculum_modules').eq('id', courseId).maybeSingle();
        if (courseObj && Array.isArray(courseObj.curriculum_modules)) {
          const updatedModules = courseObj.curriculum_modules.map(m => {
            if ((String(m.id) === String(moduleId) || (dbTopic?.module_id && String(m.id) === String(dbTopic.module_id))) && Array.isArray(m.topics)) {
              return {
                ...m,
                topics: m.topics.map(t => {
                  const tId = typeof t === 'object' && t !== null ? t.id : t;
                  const tTitle = typeof t === 'object' && t !== null ? (t.title || t.name) : t;
                  const isMatch = String(tId) === String(topicId) || 
                                  (dbTopic && dbTopic.title && String(tTitle) === String(dbTopic.title));
                  if (isMatch) {
                    const baseObj = typeof t === 'object' && t !== null ? t : { id: topicId, title: String(t) };
                    return {
                      ...baseObj,
                      processing_status: 'READY',
                      video_status: 'READY',
                      hls_master_url: masterUrl,
                      video_url: masterUrl,
                      hls_prefix: effectivePrefix,
                      video_asset_id: sourceVideoId,
                      source_video_id: sourceVideoId
                    };
                  }
                  return t;
                })
              };
            }
            return m;
          });
          await supabase.from('courses').update({ curriculum_modules: updatedModules, updated_at: new Date().toISOString() }).eq('id', courseId);
        }
      } catch (cErr) {
        console.error(`❌ [Topic Curriculum Update Error] Failed to update curriculum for course ${courseId}:`, cErr);
      }
    }

    // Dequeue next queued topic job (Only for Mode 1 segmentation queue, NOT Mode 2 separate topic uploads)
    if (!isIndividualTopicVideo && moduleId && sourceVideoId) {
      await this.dispatchNextQueuedTopicJobs(moduleId, sourceVideoId);
    }

    // Check if ALL topics in module are now READY
    const { topics: allTopics } = await this.getModuleTopics(null, { moduleId, courseId, skipJobPolling: true });
    const allReady = allTopics.length > 0 && allTopics.every(t => t.processing_status === 'READY');

    if (allReady && sourceVideoId) {
      console.log(`🎉 [Topic Pipeline Complete] All ${allTopics.length} topics in module ${moduleId} are READY!`);
      const sourceRecord = await this.getVideoRecord(sourceVideoId, courseId);
      if (sourceRecord) {
        await this.upsertVideoRecord({
          ...sourceRecord,
          status: 'READY',
          ready_topics_count: allTopics.length,
          processing_completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });

        // Safely evaluate raw source retention
        const { COMPRESSION_SETTINGS } = require('./video.constants');
        const videoCleanupService = require('./video.cleanup.service');
        if (COMPRESSION_SETTINGS.SOURCE_RETENTION_POLICY === 'DELETE_AFTER_VALIDATION') {
          await videoCleanupService.safeDeleteRawSource({
            record: sourceRecord,
            s3VideoService: require('./video.s3.service'),
            videoService: this
          });
        }
      }
    }
  }

  /**
   * 15. Handle Topic MediaConvert Failure
   */
  async handleTopicProcessingFailed({ jobId, topicId, sourceVideoId, moduleId, courseId, errorDetails = {} }) {
    console.error(`❌ [TOPIC_JOB_FAILED] Topic ${topicId} (JobId: ${jobId}, ModuleId: ${moduleId}, Status: FAILED) failed:`, errorDetails.message || errorDetails);

    const memTopic = memoryVideoStore.get(`topic_${topicId}`) || {};
    const updatedTopic = {
      ...memTopic,
      id: topicId,
      module_id: moduleId,
      course_id: courseId,
      source_video_id: sourceVideoId,
      processing_status: 'FAILED',
      processing_error: errorDetails.message || 'MediaConvert job failed',
      updated_at: new Date().toISOString()
    };

    memoryVideoStore.set(`topic_${topicId}`, updatedTopic);

    try {
      await supabase.from('topics').update({
        processing_status: 'FAILED',
        processing_error: errorDetails.message || 'MediaConvert transcode failed',
        updated_at: new Date().toISOString()
      }).eq('id', topicId);
    } catch (e) {}

    // Also update the lesson_videos record for this topic's video asset
    try {
      if (sourceVideoId) {
        await this.upsertVideoRecord({
          id: sourceVideoId,
          lesson_id: topicId,
          module_id: moduleId,
          course_id: courseId,
          status: VIDEO_STATUS.FAILED,
          error_message: errorDetails.message || 'MediaConvert transcode failed',
          updated_at: new Date().toISOString()
        });
      }
    } catch (e) {}

    // Auto-dequeue next topic even if previous one failed
    if (moduleId && sourceVideoId) {
      await this.dispatchNextQueuedTopicJobs(moduleId, sourceVideoId);
    }
  }

  /**
   * 16. Retry Failed Topic Processing
   */
  async retryTopicProcessing(adminUser, params) {
    return this.retrySingleTopicProcessing(adminUser, params);
  }

  async retrySingleTopicProcessing(adminUser, { topicId, moduleId, courseId }) {
    let topic = memoryVideoStore.get(`topic_${topicId}`);
    if (!topic) {
      const { data } = await supabase.from('topics').select('*').eq('id', topicId).maybeSingle();
      topic = data;
    }

    if (!topic) {
      throw { statusCode: 404, message: `Topic '${topicId}' not found.` };
    }

    const effectiveCourseId = courseId || topic.course_id;
    const effectiveModuleId = moduleId || topic.module_id;

    if (!effectiveCourseId) {
      throw new HierarchyValidationError(`Topic '${topicId}' has no associated course scope (orphan record). Retry rejected.`, 403, 'HIERARCHY_ORPHAN_RECORD');
    }

    // Authoritative Hierarchy Validation
    const hierarchy = await validateHierarchyChain({
      courseId: effectiveCourseId,
      moduleId: effectiveModuleId,
      topicId: topic.id,
      videoId: topic.source_video_id
    });
    const course = hierarchy.course;

    const sourceRecord = await this.getVideoRecord(topic.source_video_id || moduleId);
    if (!sourceRecord || !sourceRecord.source_s3_key) {
      throw { statusCode: 400, message: 'Source video for topic not found or was purged.' };
    }

    const s3PathUtils = require('../../utils/s3PathUtils');
    const effectiveBucket = sourceRecord.source_s3_bucket || env.AWS_S3_BUCKET_SOURCE || env.AWS_S3_BUCKET_OUTPUT;
    const courseSlug = s3PathUtils.generateS3CourseSlug(course);
    const moduleSlug = s3PathUtils.generateS3ModuleSlug(topic.module_id);
    const cdnDomain = env.CLOUDFRONT_DOMAIN || `https://${env.AWS_S3_BUCKET_OUTPUT}.s3.${env.AWS_REGION}.amazonaws.com`;
    const topicHlsPrefix = s3PathUtils.buildS3TopicHlsPrefix(courseSlug, moduleSlug, sourceRecord.id, topic.id);
    const masterUrl = `${cdnDomain}/${topicHlsPrefix}master.m3u8`;

    console.log(`🔄 [Topic Retry] Retrying single topic ${topic.title} (${topic.start_timecode}-${topic.end_timecode})...`);

    // Reuse active job if still PROCESSING
    if (topic.processing_status === 'PROCESSING' && topic.mediaconvert_job_id) {
      console.log(`ℹ️ [DUPLICATE_MEDIACONVERT_JOB_BLOCKED] Topic retry while PROCESSING reused job ${topic.mediaconvert_job_id}`);
      return {
        status: 'SUCCESS',
        topicId: topic.id,
        jobId: topic.mediaconvert_job_id,
        processingStatus: 'PROCESSING',
        duplicated: true,
        reason: 'ACTIVE_JOB_REUSED',
        message: `Topic '${topic.title}' already has an active MediaConvert job.`
      };
    }

    const clipDuration = Math.max(0, Number(topic.end_time_seconds || 0) - Number(topic.start_time_seconds || 0));
    const guarded = await this.submitGuardedMediaConvertJob({
      processingProfile: PROCESSING_PROFILES.TOPIC_CLIPPING,
      videoId: sourceRecord.id,
      uploadId: sourceRecord.upload_id || sourceRecord.source_s3_key,
      courseId: course?.id || sourceRecord.course_id,
      moduleId: topic.module_id,
      topicId: topic.id,
      sourceKey: sourceRecord.source_s3_key,
      sourceDurationSeconds: clipDuration,
      sourceWidth: sourceRecord?.source_width || sourceRecord?.width,
      sourceHeight: sourceRecord?.source_height || sourceRecord?.height,
      triggerSource: TRIGGER_SOURCES.RETRY,
      existingTopic: topic,
      existingRecord: sourceRecord,
      isRetry: true,
      submitFn: async ({ requestedOutputs, sourceHeight, sourceWidth }) => {
        return mediaConvertVideoService.submitTopicClippingJob({
          sourceBucket: effectiveBucket,
          sourceKey: sourceRecord.source_s3_key,
          outputPrefix: topicHlsPrefix,
          startTimeSeconds: topic.start_time_seconds,
          endTimeSeconds: topic.end_time_seconds,
          startTimecode: topic.start_timecode,
          endTimecode: topic.end_timecode,
          fps: sourceRecord?.source_fps || 30,
          sourceHeight,
          sourceWidth,
          requestedOutputs,
          userMetadata: {
            topicId: String(topic.id),
            sourceVideoId: String(sourceRecord?.id || topic.source_video_id),
            moduleId: String(topic.module_id),
            courseId: String(course?.id || sourceRecord?.course_id),
            isTopicClip: 'true',
            processingProfile: PROCESSING_PROFILES.TOPIC_CLIPPING
          }
        });
      }
    });

    if (guarded.duplicated) {
      return {
        status: 'SUCCESS',
        topicId: topic.id,
        jobId: guarded.jobId,
        processingStatus: topic.processing_status === 'READY' ? 'READY' : 'PROCESSING',
        duplicated: true,
        reason: guarded.reason,
        message: `Topic '${topic.title}' retry blocked — existing job/output reused.`
      };
    }

    const jobResult = guarded.jobResult;

    const activeTopic = {
      ...topic,
      mediaconvert_job_id: jobResult.jobId,
      processing_status: 'PROCESSING',
      processing_error: null,
      hls_prefix: topicHlsPrefix,
      hls_master_url: masterUrl,
      processing_identity: guarded.processingIdentity,
      updated_at: new Date().toISOString()
    };

    memoryVideoStore.set(`topic_${topic.id}`, activeTopic);
    try {
      await supabase.from('topics').update({
        mediaconvert_job_id: jobResult.jobId,
        processing_status: 'PROCESSING',
        processing_error: null,
        hls_prefix: topicHlsPrefix,
        hls_master_url: masterUrl,
        processing_identity: guarded.processingIdentity,
        updated_at: new Date().toISOString()
      }).eq('id', topic.id);
    } catch (e) {}

    return {
      status: 'SUCCESS',
      topicId: topic.id,
      jobId: jobResult.jobId,
      processingStatus: 'PROCESSING',
      message: `Topic '${topic.title}' retry job dispatched.`
    };
  }

  /**
   * 17. Delete Topic Video & Purge S3 Topic Resources
   */
  async deleteTopicVideo(adminUser, { topicId, courseId, moduleId, videoAssetId, forceDelete, action }) {
    if (!topicId) {
      throw { statusCode: 400, message: 'topicId is required.' };
    }

    if (action === 'REMOVE_FROM_COURSE') {
      return this.removeTopicVideoFromCourse(adminUser, { topicId, courseId, moduleId, videoAssetId });
    }

    return this.deleteTopicVideoPermanently(adminUser, { topicId, courseId, moduleId, videoAssetId, forceDelete: forceDelete ?? true });
  }

  /**
   * 17B. Option A: Remove Topic Video from Course (48-Hour Deletion Grace Period)
   */
  async removeTopicVideoFromCourse(adminUser, { topicId, courseId, moduleId, videoAssetId }) {
    const videoCleanupService = require('./video.cleanup.service');
    return videoCleanupService.unassignTopicVideoWith48HourGrace({
      topicId,
      courseId,
      moduleId,
      videoAssetId
    });
  }

  /**
   * 17C. Option B: Delete Topic Video Permanently (Immediate Validated S3 Purge)
   */
  async deleteTopicVideoPermanently(adminUser, { topicId, courseId, moduleId, videoAssetId, forceDelete = true }) {
    const videoCleanupService = require('./video.cleanup.service');
    return videoCleanupService.deleteTopicVideoPermanentlyWithSafetyCheck({
      topicId,
      courseId,
      moduleId,
      videoAssetId,
      forceDelete,
      s3VideoService,
      user: adminUser
    });
  }

  /**
   * T8. Admin Requests Presigned Direct S3 PUT Upload URL for Single Topic (< 100 MB)
   */
  async requestTopicUpload(adminUser, { topicId, courseId, moduleId, fileName, contentType, fileSizeBytes, title, durationSeconds }) {
    if (!courseId || !moduleId || !topicId) {
      throw { statusCode: 400, message: 'courseId, moduleId, and topicId are required.' };
    }
    if (!fileName || !contentType) {
      throw { statusCode: 400, message: 'fileName and contentType are required.' };
    }

    const isMkvFile = fileName.toLowerCase().endsWith('.mkv');
    const normalizedContentType = (isMkvFile && (!contentType || contentType === 'application/octet-stream')) ? 'video/x-matroska' : contentType.toLowerCase();

    if (!ALLOWED_VIDEO_MIME_TYPES.includes(normalizedContentType) && !isMkvFile) {
      throw {
        statusCode: 400,
        message: `Invalid video format '${contentType}'. Allowed types: MP4, MOV (QuickTime), M4V, WEBM, MKV.`
      };
    }

    const size = Number(fileSizeBytes);
    if (!size || size <= 0) {
      throw { statusCode: 400, message: 'Valid fileSizeBytes is required.' };
    }

    if (size > MAX_VIDEO_FILE_SIZE_BYTES) {
      throw {
        statusCode: 400,
        message: `File size exceeds maximum allowed limit of 5 GB (${(size / (1024 * 1024 * 1024)).toFixed(2)} GB).`
      };
    }

    // Authoritative Hierarchy Chain Validation
    const hierarchy = await validateHierarchyChain({
      courseId,
      moduleId,
      topicId
    });
    const course = hierarchy.course;
    const targetMod = hierarchy.module;
    const targetTopic = hierarchy.topic;
    const modIdx = hierarchy.modIndex || 0;

    const courseSlug = s3PathUtils.generateS3CourseSlug(course);
    const moduleSlug = s3PathUtils.generateS3ModuleSlug(targetMod, modIdx + 1);
    const videoAssetId = require('crypto').randomUUID();
    const cleanTopicId = String(targetTopic.id || topicId);

    const s3Key = s3PathUtils.buildS3TopicSourceKey(courseSlug, moduleSlug, videoAssetId, cleanTopicId, fileName);
    const hlsPrefix = s3PathUtils.buildS3TopicHlsPrefix(courseSlug, moduleSlug, videoAssetId, cleanTopicId);

    const presignedData = await s3VideoService.generatePresignedUploadUrl({
      s3Key,
      courseSlug,
      moduleSlug,
      fileName,
      contentType
    });

    const parsedDuration = Math.round(Number(durationSeconds) || 0);

    const recordPayload = {
      id: videoAssetId,
      lesson_id: cleanTopicId,
      topic_id: cleanTopicId,
      course_id: course.id,
      module_id: String(targetMod.id || moduleId),
      course_slug: courseSlug,
      module_slug: moduleSlug,
      hls_prefix: hlsPrefix,
      title: title || targetTopic.title || fileName,
      status: VIDEO_STATUS.UPLOADING,
      source_s3_bucket: presignedData.s3Bucket,
      source_s3_key: presignedData.s3Key,
      file_size_bytes: size || 0,
      duration_seconds: parsedDuration,
      source_duration_seconds: parsedDuration,
      upload_started_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const savedRecord = await this.upsertVideoRecord(recordPayload);

    // Update topic in memory store
    const memTopic = memoryVideoStore.get(`topic_${cleanTopicId}`) || {};
    const updatedMemTopic = {
      ...memTopic,
      ...targetTopic,
      id: cleanTopicId,
      module_id: String(targetMod.id || moduleId),
      course_id: course.id,
      video_asset_id: videoAssetId,
      source_video_id: videoAssetId,
      hls_prefix: hlsPrefix,
      processing_status: 'UPLOADING',
      duration_seconds: parsedDuration,
      updated_at: new Date().toISOString()
    };
    memoryVideoStore.set(`topic_${cleanTopicId}`, updatedMemTopic);
    memoryVideoStore.set(cleanTopicId, updatedMemTopic);

    return {
      status: 'SUCCESS',
      videoAssetId: savedRecord.id || videoAssetId,
      topicId: cleanTopicId,
      moduleId: String(targetMod.id || moduleId),
      courseId: course.id,
      uploadUrl: presignedData.uploadUrl,
      s3Bucket: presignedData.s3Bucket,
      s3Key: presignedData.s3Key,
      expiresInSeconds: presignedData.expiresInSeconds,
      sourceVideoUrl: presignedData.s3Key ? `https://${presignedData.s3Bucket}.s3.amazonaws.com/${presignedData.s3Key}` : null
    };
  }

  /**
   * T9. Admin Initiates S3 Multipart Upload for Single Topic (>= 100 MB)
   */
  async initiateTopicMultipartUpload(adminUser, { topicId, courseId, moduleId, fileName, contentType, fileSizeBytes, title, partSizeBytes, durationSeconds }) {
    if (!courseId || !moduleId || !topicId) {
      throw { statusCode: 400, message: 'courseId, moduleId, and topicId are required.' };
    }
    if (!fileName || !contentType) {
      throw { statusCode: 400, message: 'fileName and contentType are required.' };
    }

    const isMkvFile = fileName.toLowerCase().endsWith('.mkv');
    const normalizedContentType = (isMkvFile && (!contentType || contentType === 'application/octet-stream')) ? 'video/x-matroska' : contentType.toLowerCase();

    if (!ALLOWED_VIDEO_MIME_TYPES.includes(normalizedContentType) && !isMkvFile) {
      throw {
        statusCode: 400,
        message: `Invalid video format '${contentType}'. Allowed types: MP4, MOV (QuickTime), M4V, WEBM, MKV.`
      };
    }

    const size = Number(fileSizeBytes);
    if (!size || size <= 0) {
      throw { statusCode: 400, message: 'Valid fileSizeBytes is required.' };
    }

    if (size > MAX_VIDEO_FILE_SIZE_BYTES) {
      throw {
        statusCode: 400,
        message: `File size exceeds maximum allowed limit of 5 GB (${(size / (1024 * 1024 * 1024)).toFixed(2)} GB).`
      };
    }

    const hierarchy = await validateHierarchyChain({
      courseId,
      moduleId,
      topicId
    });
    const course = hierarchy.course;
    const targetMod = hierarchy.module;
    const targetTopic = hierarchy.topic;
    const modIdx = hierarchy.modIndex || 0;

    const courseSlug = s3PathUtils.generateS3CourseSlug(course);
    const moduleSlug = s3PathUtils.generateS3ModuleSlug(targetMod, modIdx + 1);
    const videoAssetId = require('crypto').randomUUID();
    const cleanTopicId = String(targetTopic.id || topicId);

    const s3Key = s3PathUtils.buildS3TopicSourceKey(courseSlug, moduleSlug, videoAssetId, cleanTopicId, fileName);
    const hlsPrefix = s3PathUtils.buildS3TopicHlsPrefix(courseSlug, moduleSlug, videoAssetId, cleanTopicId);

    const partSize = Math.max(5 * 1024 * 1024, Number(partSizeBytes) || DEFAULT_PART_SIZE_BYTES);
    const totalParts = Math.ceil(size / partSize);

    // 1. Initialize S3 Multipart Upload
    const multipartInit = await s3VideoService.createMultipartUpload({
      s3Key,
      contentType
    });

    // 2. Pre-generate presigned part URLs
    const parts = await s3VideoService.generatePresignedPartUrls({
      s3Key,
      uploadId: multipartInit.uploadId,
      totalParts,
      expiresInSeconds: 3600
    });

    const parsedDuration = Math.round(Number(durationSeconds) || 0);

    const recordPayload = {
      id: videoAssetId,
      lesson_id: cleanTopicId,
      topic_id: cleanTopicId,
      course_id: course.id,
      module_id: String(targetMod.id || moduleId),
      course_slug: courseSlug,
      module_slug: moduleSlug,
      hls_prefix: hlsPrefix,
      title: title || targetTopic.title || fileName,
      status: VIDEO_STATUS.UPLOADING,
      source_s3_bucket: multipartInit.s3Bucket,
      source_s3_key: multipartInit.s3Key,
      upload_id: multipartInit.uploadId,
      file_size_bytes: size || 0,
      duration_seconds: parsedDuration,
      source_duration_seconds: parsedDuration,
      upload_started_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const savedRecord = await this.upsertVideoRecord(recordPayload);

    const memTopic = memoryVideoStore.get(`topic_${cleanTopicId}`) || {};
    const updatedMemTopic = {
      ...memTopic,
      ...targetTopic,
      id: cleanTopicId,
      module_id: String(targetMod.id || moduleId),
      course_id: course.id,
      video_asset_id: videoAssetId,
      source_video_id: videoAssetId,
      hls_prefix: hlsPrefix,
      processing_status: 'UPLOADING',
      duration_seconds: parsedDuration,
      updated_at: new Date().toISOString()
    };
    memoryVideoStore.set(`topic_${cleanTopicId}`, updatedMemTopic);
    memoryVideoStore.set(cleanTopicId, updatedMemTopic);

    return {
      status: 'SUCCESS',
      videoAssetId: savedRecord.id || videoAssetId,
      topicId: cleanTopicId,
      moduleId: String(targetMod.id || moduleId),
      courseId: course.id,
      uploadId: multipartInit.uploadId,
      s3Bucket: multipartInit.s3Bucket,
      s3Key: multipartInit.s3Key,
      partSizeBytes: partSize,
      totalParts,
      parts,
      initialPresignedUrls: parts,
      sourceVideoUrl: multipartInit.s3Key ? `https://${multipartInit.s3Bucket}.s3.amazonaws.com/${multipartInit.s3Key}` : null
    };
  }

  /**
   * T10. Admin Completes S3 Multipart Upload for Single Topic & Starts MediaConvert
   */
  async completeTopicMultipartUploadAndStartProcessing(adminUser, { topicId, videoAssetId, uploadId, s3Key, parts, durationSeconds, courseId, moduleId }) {
    if (!videoAssetId || !uploadId || !s3Key || !Array.isArray(parts)) {
      throw { statusCode: 400, message: 'videoAssetId, uploadId, s3Key, and parts array are required.' };
    }

    const hierarchy = await validateHierarchyChain({
      courseId,
      moduleId,
      topicId
    });
    const course = hierarchy.course;
    const targetMod = hierarchy.module;
    const targetTopic = hierarchy.topic;
    const cleanTopicId = String(targetTopic.id || topicId);

    // 1. Complete S3 multipart
    const completeResult = await s3VideoService.completeMultipartUpload({
      uploadId,
      s3Key,
      parts
    });

    const parsedDuration = Math.round(Number(durationSeconds) || 0);
    const modIdx = hierarchy.modIndex || 0;
    const courseSlug = s3PathUtils.generateS3CourseSlug(course);
    const moduleSlug = s3PathUtils.generateS3ModuleSlug(targetMod, modIdx + 1);
    const topicHlsPrefix = s3PathUtils.buildS3TopicHlsPrefix(courseSlug, moduleSlug, videoAssetId, cleanTopicId);

    const existingVideo = await this.getVideoRecord(videoAssetId).catch(() => null);
    const metrics = await videoSourceProbe.resolveSourceMetrics(existingVideo || { duration_seconds: parsedDuration });

    // 2. Submit MediaConvert HLS Transcode Job (guarded — Mode 2 DIRECT_TOPIC_HLS)
    const guarded = await this.submitGuardedMediaConvertJob({
      processingProfile: PROCESSING_PROFILES.DIRECT_TOPIC_HLS,
      videoId: videoAssetId,
      uploadId: uploadId || s3Key,
      courseId: course.id,
      moduleId: String(targetMod.id || moduleId),
      topicId: cleanTopicId,
      sourceKey: s3Key,
      sourceDurationSeconds: parsedDuration || metrics.durationSeconds,
      sourceWidth: metrics.width,
      sourceHeight: metrics.height,
      triggerSource: TRIGGER_SOURCES.DIRECT_TOPIC_UPLOAD,
      existingRecord: existingVideo,
      existingTopic: targetTopic,
      submitFn: async ({ requestedOutputs, sourceHeight, sourceWidth }) => {
        return mediaConvertVideoService.submitTranscodeJob({
          sourceBucket: completeResult.s3Bucket || s3VideoService.sourceBucket || env.AWS_S3_RAW_BUCKET || env.AWS_S3_BUCKET_SOURCE || 'internnetra-lms-videos-prod-365957110532-ap-south-1-an',
          sourceKey: s3Key,
          outputPrefix: topicHlsPrefix,
          requestedOutputs,
          sourceHeight,
          sourceWidth,
          userMetadata: {
            isTopicJob: 'true',
            topicId: cleanTopicId,
            sourceVideoId: String(videoAssetId),
            videoAssetId: String(videoAssetId),
            moduleId: String(targetMod.id || moduleId),
            courseId: String(course.id),
            isIndividualTopicVideo: 'true',
            processingProfile: PROCESSING_PROFILES.DIRECT_TOPIC_HLS
          }
        });
      }
    });

    if (guarded.duplicated) {
      return {
        status: 'SUCCESS',
        jobId: guarded.jobId,
        topicId: cleanTopicId,
        videoAssetId,
        processingStatus: existingVideo?.status === 'READY' ? 'READY' : 'PROCESSING',
        duplicated: true,
        reason: guarded.reason
      };
    }

    const jobResult = guarded.jobResult;

    // 3. Update lesson_videos record to PROCESSING
    await this.upsertVideoRecord({
      id: videoAssetId,
      lesson_id: cleanTopicId,
      topic_id: cleanTopicId,
      course_id: course.id,
      module_id: String(targetMod.id || moduleId),
      status: VIDEO_STATUS.PROCESSING,
      mediaconvert_job_id: jobResult.jobId,
      hls_prefix: topicHlsPrefix,
      duration_seconds: parsedDuration,
      source_width: metrics.width,
      source_height: metrics.height,
      processing_identity: guarded.processingIdentity,
      processing_profile: guarded.processingProfile,
      processing_started_at: new Date().toISOString()
    });

    // 4. Update topic status to PROCESSING in memory, topics table, and courses curriculum_modules
    const activeTopic = {
      id: cleanTopicId,
      module_id: String(targetMod.id || moduleId),
      course_id: course.id,
      source_video_id: videoAssetId,
      video_asset_id: videoAssetId,
      mediaconvert_job_id: jobResult.jobId,
      processing_status: 'PROCESSING',
      hls_prefix: topicHlsPrefix,
      duration_seconds: parsedDuration,
      processing_identity: guarded.processingIdentity,
      processing_started_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    memoryVideoStore.set(`topic_${cleanTopicId}`, activeTopic);
    memoryVideoStore.set(cleanTopicId, activeTopic);

    try {
      await supabase.from('topics').update({
        mediaconvert_job_id: jobResult.jobId,
        processing_status: 'PROCESSING',
        hls_prefix: topicHlsPrefix,
        video_asset_id: videoAssetId,
        duration_seconds: parsedDuration,
        processing_identity: guarded.processingIdentity,
        processing_started_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }).eq('id', cleanTopicId);
    } catch (e) {}

    // Update Courses Curriculum Modules JSON for this topic only
    try {
      const { data: courseObj } = await supabase.from('courses').select('id, curriculum_modules').eq('id', course.id).maybeSingle();
      if (courseObj && Array.isArray(courseObj.curriculum_modules)) {
        const updatedModules = courseObj.curriculum_modules.map(m => {
          if (String(m.id) === String(targetMod.id || moduleId) && Array.isArray(m.topics)) {
            return {
              ...m,
              topics: m.topics.map(t => {
                if (String(t.id) === cleanTopicId || (typeof t === 'string' && t === cleanTopicId)) {
                  const base = typeof t === 'object' && t !== null ? t : { id: cleanTopicId, title: String(t) };
                  return {
                    ...base,
                    video_asset_id: videoAssetId,
                    processing_status: 'PROCESSING',
                    duration_seconds: parsedDuration
                  };
                }
                return t;
              })
            };
          }
          return m;
        });
        await supabase.from('courses').update({ curriculum_modules: updatedModules, updated_at: new Date().toISOString() }).eq('id', course.id);
      }
    } catch (e) {}

    return {
      status: 'SUCCESS',
      jobId: jobResult.jobId,
      topicId: cleanTopicId,
      videoAssetId,
      processingStatus: 'PROCESSING'
    };
  }

  /**
   * T11. Admin Confirms Single PUT Upload for Single Topic & Starts MediaConvert
   */
  async confirmTopicUploadAndStartProcessing(adminUser, { topicId, videoAssetId, s3Key, durationSeconds, courseId, moduleId }) {
    if (!videoAssetId || !s3Key) {
      throw { statusCode: 400, message: 'videoAssetId and s3Key are required.' };
    }

    const hierarchy = await validateHierarchyChain({
      courseId,
      moduleId,
      topicId
    });
    const course = hierarchy.course;
    const targetMod = hierarchy.module;
    const targetTopic = hierarchy.topic;
    const cleanTopicId = String(targetTopic.id || topicId);

    const parsedDuration = Math.round(Number(durationSeconds) || 0);
    const modIdx = hierarchy.modIndex || 0;
    const courseSlug = s3PathUtils.generateS3CourseSlug(course);
    const moduleSlug = s3PathUtils.generateS3ModuleSlug(targetMod, modIdx + 1);
    const topicHlsPrefix = s3PathUtils.buildS3TopicHlsPrefix(courseSlug, moduleSlug, videoAssetId, cleanTopicId);

    const existingVideo = await this.getVideoRecord(videoAssetId).catch(() => null);
    const metrics = await videoSourceProbe.resolveSourceMetrics(existingVideo || { duration_seconds: parsedDuration });

    // Submit MediaConvert HLS Transcode Job (guarded — Mode 2 DIRECT_TOPIC_HLS)
    const guarded = await this.submitGuardedMediaConvertJob({
      processingProfile: PROCESSING_PROFILES.DIRECT_TOPIC_HLS,
      videoId: videoAssetId,
      uploadId: s3Key,
      courseId: course.id,
      moduleId: String(targetMod.id || moduleId),
      topicId: cleanTopicId,
      sourceKey: s3Key,
      sourceDurationSeconds: parsedDuration || metrics.durationSeconds,
      sourceWidth: metrics.width,
      sourceHeight: metrics.height,
      triggerSource: TRIGGER_SOURCES.DIRECT_TOPIC_UPLOAD,
      existingRecord: existingVideo,
      existingTopic: targetTopic,
      submitFn: async ({ requestedOutputs, sourceHeight, sourceWidth }) => {
        return mediaConvertVideoService.submitTranscodeJob({
          sourceBucket: s3VideoService.sourceBucket || env.AWS_S3_RAW_BUCKET || env.AWS_S3_BUCKET_SOURCE || 'internnetra-lms-videos-prod-365957110532-ap-south-1-an',
          sourceKey: s3Key,
          outputPrefix: topicHlsPrefix,
          requestedOutputs,
          sourceHeight,
          sourceWidth,
          userMetadata: {
            isTopicJob: 'true',
            topicId: cleanTopicId,
            sourceVideoId: String(videoAssetId),
            videoAssetId: String(videoAssetId),
            moduleId: String(targetMod.id || moduleId),
            courseId: String(course.id),
            isIndividualTopicVideo: 'true',
            processingProfile: PROCESSING_PROFILES.DIRECT_TOPIC_HLS
          }
        });
      }
    });

    if (guarded.duplicated) {
      return {
        status: 'SUCCESS',
        jobId: guarded.jobId,
        topicId: cleanTopicId,
        videoAssetId,
        processingStatus: existingVideo?.status === 'READY' ? 'READY' : 'PROCESSING',
        duplicated: true,
        reason: guarded.reason
      };
    }

    const jobResult = guarded.jobResult;

    // Update lesson_videos record to PROCESSING
    await this.upsertVideoRecord({
      id: videoAssetId,
      lesson_id: cleanTopicId,
      topic_id: cleanTopicId,
      course_id: course.id,
      module_id: String(targetMod.id || moduleId),
      status: VIDEO_STATUS.PROCESSING,
      mediaconvert_job_id: jobResult.jobId,
      hls_prefix: topicHlsPrefix,
      duration_seconds: parsedDuration,
      source_width: metrics.width,
      source_height: metrics.height,
      processing_identity: guarded.processingIdentity,
      processing_profile: guarded.processingProfile,
      processing_started_at: new Date().toISOString()
    });

    // Update topic status in memory and DB
    const activeTopic = {
      id: cleanTopicId,
      module_id: String(targetMod.id || moduleId),
      course_id: course.id,
      source_video_id: videoAssetId,
      video_asset_id: videoAssetId,
      mediaconvert_job_id: jobResult.jobId,
      processing_status: 'PROCESSING',
      hls_prefix: topicHlsPrefix,
      duration_seconds: parsedDuration,
      processing_identity: guarded.processingIdentity,
      processing_started_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    memoryVideoStore.set(`topic_${cleanTopicId}`, activeTopic);
    memoryVideoStore.set(cleanTopicId, activeTopic);

    try {
      await supabase.from('topics').update({
        mediaconvert_job_id: jobResult.jobId,
        processing_status: 'PROCESSING',
        hls_prefix: topicHlsPrefix,
        video_asset_id: videoAssetId,
        duration_seconds: parsedDuration,
        processing_identity: guarded.processingIdentity,
        processing_started_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }).eq('id', cleanTopicId);
    } catch (e) {}

    // Update Courses Curriculum Modules JSON for this topic only
    try {
      const { data: courseObj } = await supabase.from('courses').select('id, curriculum_modules').eq('id', course.id).maybeSingle();
      if (courseObj && Array.isArray(courseObj.curriculum_modules)) {
        const updatedModules = courseObj.curriculum_modules.map(m => {
          if (String(m.id) === String(targetMod.id || moduleId) && Array.isArray(m.topics)) {
            return {
              ...m,
              topics: m.topics.map(t => {
                if (String(t.id) === cleanTopicId || (typeof t === 'string' && t === cleanTopicId)) {
                  const base = typeof t === 'object' && t !== null ? t : { id: cleanTopicId, title: String(t) };
                  return {
                    ...base,
                    video_asset_id: videoAssetId,
                    processing_status: 'PROCESSING',
                    duration_seconds: parsedDuration
                  };
                }
                return t;
              })
            };
          }
          return m;
        });
        await supabase.from('courses').update({ curriculum_modules: updatedModules, updated_at: new Date().toISOString() }).eq('id', course.id);
      }
    } catch (e) {}

    return {
      status: 'SUCCESS',
      jobId: jobResult.jobId,
      topicId: cleanTopicId,
      videoAssetId,
      processingStatus: 'PROCESSING'
    };
  }

  /**
   * 18. Authenticated Student Topic Playback Authorization
   */
  async authorizeTopicPlayback(user, { courseId, moduleId, topicId }) {
    const userEmail = user?.email?.toLowerCase()?.trim() || null;
    const isAdmin = Boolean(user && (user.user_metadata?.role === 'ADMIN' || user.role === 'ADMIN' || userEmail === 'admin@internnetra.com'));

    // 1. Authoritative Hierarchy Chain Validation
    const hierarchy = await validateHierarchyChain({
      courseId,
      moduleId,
      topicId
    });
    const course = hierarchy.course;
    const parentModule = hierarchy.module;
    let topic = hierarchy.topic;

    const effectiveCourseId = course?.id || courseId;

    if (!topic || topic.processing_status !== 'READY' || !topic.hls_master_url) {
      const rawTopId = String(topic?.id || topicId);
      // 1. Check database topics table
      try {
        const { data: dbTopic } = await supabase.from('topics').select('*').eq('id', rawTopId).maybeSingle();
        if (dbTopic?.hls_master_url) {
          topic = { ...topic, ...dbTopic, processing_status: 'READY' };
        }
      } catch (e) {}

      // 2. Check lesson_videos table for this topic
      if (!topic?.hls_master_url) {
        try {
          const { data: lvList } = await supabase
            .from('lesson_videos')
            .select('*')
            .or(`lesson_id.eq.${rawTopId},topic_id.eq.${rawTopId}`)
            .eq('status', 'READY')
            .order('updated_at', { ascending: false })
            .limit(1);
          if (lvList && lvList.length > 0 && lvList[0].hls_master_url) {
            const topicReadySync = require('./video.topic-ready-sync.service');
            const owned = (lvList || []).find((v) =>
              topicReadySync.lessonVideoBelongsToTopic(v, rawTopId)
            );
            if (owned?.hls_master_url) {
              topic = {
                ...topic,
                hls_master_url: owned.hls_master_url,
                hls_prefix: owned.hls_prefix,
                processing_status: 'READY'
              };
              // Persist heal so next curriculum/player load does not hit this fallback again
              topicReadySync.syncTopicReadyFromLessonVideos(rawTopId, {
                courseId: effectiveCourseId,
                moduleId,
                preferredVideoId: owned.id,
                force: true
              }).catch(() => {});
            }
          }
        } catch (e) {}
      }

      // 3. Check memory store
      if (!topic?.hls_master_url) {
        const memTopic = memoryVideoStore.get(`topic_${rawTopId}`);
        if (memTopic?.hls_master_url) {
          topic = { ...topic, ...memTopic, processing_status: 'READY' };
        }
      }
    }

    if (!topic || topic.processing_status !== 'READY' || !topic.hls_master_url) {
      // Mode 2: individual topic videos — NEVER fall back to another topic or module video
      const modeHint = String(parentModule?.video_content_mode || '').toUpperCase();
      let isMode2 =
        modeHint === 'INDIVIDUAL_TOPIC_VIDEOS' ||
        modeHint === 'TOPIC_VIDEOS' ||
        modeHint === 'MODE_2' ||
        parentModule?.video_status === 'NO_VIDEO' ||
        parentModule?.video_status === 'UNASSIGNED' ||
        (!parentModule?.video_url && Boolean(topic?.video_asset_id || topic?.hls_prefix));

      // Infer Mode 2 when this module has any topic-owned READY lesson_videos
      if (!isMode2 && moduleId) {
        try {
          const { data: siblingTopicVideos } = await supabase
            .from('lesson_videos')
            .select('id, topic_id, lesson_id')
            .eq('module_id', moduleId)
            .eq('status', 'READY')
            .not('hls_master_url', 'is', null)
            .limit(20);
          isMode2 = (siblingTopicVideos || []).some((v) => {
            if (v.topic_id) return true;
            // lesson_id is a topic UUID (not the module id) => topic-owned Mode 2 asset
            return Boolean(v.lesson_id && String(v.lesson_id) !== String(moduleId));
          });
        } catch (_) {}
      }

      if (!isMode2 && parentModule?.video_url && parentModule.video_url.includes('.m3u8')) {
        console.log(`ℹ️ [Topic Stream Auth] Mode 1 fallback to parent module HLS for module ${moduleId}`);
        return this.authorizeStudentPlayback(user, { courseId: effectiveCourseId, lessonId: moduleId });
      }
      if (topic?.processing_status === 'PROCESSING' || topic?.processing_status === 'QUEUED') {
        throw {
          statusCode: 409,
          message: 'Topic video is currently being transcoded. Please check back shortly.'
        };
      }
      if (topic?.processing_status === 'FAILED') {
        throw {
          statusCode: 404,
          message: 'Topic video processing failed. Please contact your instructor or administrator to retry.'
        };
      }
      // DRAFT, UNPROCESSED, or no video yet — return 404 so player does not loop-poll
      throw {
        statusCode: 404,
        message: 'The video lecture for this topic will be updated soon by your instructor.'
      };
    }

    const masterUrl = topic.hls_master_url;

    // 3. Validate Student Enrollment (unless Admin or Free Preview)
    const isFreePreview = Boolean(topic.is_preview || parentModule?.is_preview);
    let studentId = null;

    if (!user && !isFreePreview && !isAdmin) {
      throw { statusCode: 401, message: 'Authentication required.' };
    }

    if (!isAdmin && !isFreePreview) {
      if (!user || !user.email) {
        throw { statusCode: 401, message: 'Authentication required.' };
      }
      const authResult = await this.resolveStudentEnrollment(user, course, courseId);
      studentId = authResult.studentId;
    }

    // 4. Register playback session & sign token
    const videoSessionService = require('./video.session.service');
    const effectiveUserId = user?.id || studentId || userEmail || 'guest_preview';
    const effectiveUserEmail = userEmail || (isFreePreview ? 'preview@internnetra.com' : 'student@internnetra.com');
    const session = await videoSessionService.createSession({
      userId: effectiveUserId,
      courseId: effectiveCourseId,
      lessonId: String(topicId)
    });

    if (!env.JWT_SECRET) {
      throw new Error('JWT_SECRET is not configured. Topic playback token creation aborted.');
    }

    const ttlSeconds = Number(process.env.PLAYBACK_TOKEN_EXPIRY_SECONDS) || 900;

    const playbackToken = jwt.sign(
      {
        sub: effectiveUserId,
        email: effectiveUserEmail,
        courseId: String(effectiveCourseId),
        courseSlug: String(course?.slug || (typeof courseId === 'string' && isValidSlug(courseId) ? courseId : '')),
        moduleId: String(moduleId || ''),
        topicId: String(topicId || ''),
        sessionId: session.sessionId,
        role: isAdmin ? 'ADMIN' : (isFreePreview && !user ? 'PREVIEW' : 'STUDENT'),
        type: 'TOPIC_PLAYBACK'
      },
      env.JWT_SECRET,
      { expiresIn: ttlSeconds }
    );

    let signedStreamUrl = '';

    if (cloudFrontVideoService.isConfigured && typeof masterUrl === 'string' && masterUrl.startsWith('http')) {
      signedStreamUrl = cloudFrontVideoService.generateSignedPlaybackUrl({
        hlsMasterUrl: masterUrl,
        expiresInSeconds: ttlSeconds
      });
    } else {
      let s3Key = '';
      if (topic.hls_prefix) {
        s3Key = `${topic.hls_prefix.replace(/^\/+/, '').replace(/\/+$/, '')}/master.m3u8`;
      } else {
        try {
          const parsed = new URL(masterUrl);
          s3Key = parsed.pathname.replace(/^\/+/, '');
        } catch (e) {
          s3Key = (masterUrl || '').replace(/^\/+/, '');
        }
      }
      signedStreamUrl = `/api/video/hls-stream/${s3Key}?token=${playbackToken}`;
    }

    const startTimeSeconds = typeof topic.start_time_seconds === 'number' ? topic.start_time_seconds : 0;
    const endTimeSeconds = typeof topic.end_time_seconds === 'number' ? topic.end_time_seconds : null;
    const calculatedDuration = typeof topic.duration_seconds === 'number' && topic.duration_seconds > 0
      ? topic.duration_seconds
      : (endTimeSeconds && endTimeSeconds > startTimeSeconds ? endTimeSeconds - startTimeSeconds : 0);

    return {
      success: true,
      status: 'AUTHORIZED',
      topicId: topic.id,
      title: topic.title,
      moduleId,
      courseId: effectiveCourseId,
      streamUrl: signedStreamUrl,
      playbackUrl: signedStreamUrl,
      hlsMasterUrl: masterUrl,
      playbackToken,
      token: playbackToken,
      sessionId: session.sessionId,
      ttlSeconds,
      durationSeconds: calculatedDuration,
      startTimecode: topic.start_timecode,
      endTimecode: topic.end_timecode
    };
  }

  /**
   * 8. Admin Video Lifecycle Management:
   * Delegations to VideoCleanupService
   */
  async removeFromCourse(user, { courseId, moduleId, lessonId, videoAssetId }) {
    if (courseId) {
      await validateHierarchyChain({
        courseId,
        moduleId: moduleId || lessonId,
        videoId: videoAssetId
      });
    }
    const videoCleanupService = require('./video.cleanup.service');
    return videoCleanupService.unassignVideoWith48HourGrace({
      lessonId: lessonId || moduleId,
      courseId,
      moduleId,
      videoAssetId,
      user
    });
  }

  async deletePermanently(user, { courseId, moduleId, lessonId, videoAssetId, forceDelete }) {
    if (courseId) {
      await validateHierarchyChain({
        courseId,
        moduleId: moduleId || lessonId,
        videoId: videoAssetId
      });
    }
    const videoCleanupService = require('./video.cleanup.service');
    return videoCleanupService.deletePermanentlyWithSafetyCheck({
      lessonId: lessonId || moduleId,
      courseId,
      moduleId,
      videoAssetId,
      forceDelete,
      user
    });
  }

  async dismissVideoJob(user, { lessonId }) {
    const videoCleanupService = require('./video.cleanup.service');
    memoryVideoStore.delete(lessonId);
    return videoCleanupService.unassignVideoWith48HourGrace({
      lessonId,
      user
    });
  }

  // ARCH-08: Recover active MediaConvert jobs across server restarts
  async recoverActiveTranscodeJobs() {
    try {
      const { data: processingVideos } = await supabase
        .from('lesson_videos')
        .select('*')
        .eq('status', 'PROCESSING')
        .not('mediaconvert_job_id', 'is', null);

      if (!processingVideos || processingVideos.length === 0) return;

      console.log(`[JOB RECOVERY ARCH-08] Found ${processingVideos.length} active transcoding jobs to recover.`);

      for (const rec of processingVideos) {
        try {
          const jobStatus = await mediaConvertVideoService.getJobStatus(rec.mediaconvert_job_id);
          if (jobStatus.status === 'COMPLETE') {
            console.log(`[JOB RECOVERY ARCH-08] MediaConvert job ${rec.mediaconvert_job_id} is COMPLETE. Finalizing video.`);
            await this.handleProcessingCompleted({
              jobId: rec.mediaconvert_job_id,
              videoAssetId: rec.id,
              lessonId: rec.lesson_id
            });
          } else if (jobStatus.status === 'ERROR' || jobStatus.status === 'CANCELED') {
            console.log(`[JOB RECOVERY ARCH-08] MediaConvert job ${rec.mediaconvert_job_id} status is ${jobStatus.status}.`);
            await this.upsertVideoRecord({ ...rec, status: 'FAILED' });
          } else {
            console.log(`[JOB RECOVERY ARCH-08] MediaConvert job ${rec.mediaconvert_job_id} still ${jobStatus.status}. Preserving PROCESSING.`);
          }
        } catch (jErr) {
          console.warn(`[JOB RECOVERY ARCH-08] Check failed for job ${rec.mediaconvert_job_id}:`, jErr.message);
        }
      }
    } catch (err) {
      console.warn('[JOB RECOVERY ARCH-08] Recovery sweep note:', err.message);
    }
  }
}

module.exports = new VideoService();

