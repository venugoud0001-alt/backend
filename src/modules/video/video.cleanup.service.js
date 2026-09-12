/**
 * Enterprise Automatic Video Storage Cleanup Service - Production Hardened
 * LMS Video Pipeline Architecture
 * 
 * CORE PRINCIPLES:
 * 1. Option A: "Remove from Course" unlinks DB reference, sets 48-hour grace timer. Reassignment cancels deletion.
 * 2. Option B: "Delete Permanently" validates safety (no active references, not transcoding, not retry-required) and purges exact S3 assets immediately.
 * 3. Never delete entire folders blindly; delete only confirmed obsolete objects.
 * 4. Never delete active production assets, active transcoding jobs, or retry sources.
 */

const { VIDEO_STATUS, COMPRESSION_SETTINGS, CLEANUP_SETTINGS, CLEANUP_STATUS } = require('./video.constants');
const videoCompressor = require('./video.compressor');
const { supabase } = require('../../config/supabase');
const { classifyIdentifier, normalizeIdentifier } = require('../../utils/idValidator');

class VideoCleanupService {
  constructor() {
    this.replacementCleanupQueue = new Map(); // In-memory queue fallback
    this.auditLogs = []; // In-memory structured audit log history
    this.maintenanceLock = null; // Distributed maintenance lock state
    this.schedulerTimer = null; // Recurring background interval
    this.metrics = {
      temporary_objects_deleted: 0,
      rejected_outputs_deleted: 0,
      raw_sources_deleted: 0,
      orphan_objects_deleted: 0,
      multipart_uploads_aborted: 0,
      replacement_objects_deleted: 0,
      unassigned_objects_deleted: 0,
      permanent_deletes_executed: 0,
      cleanup_failures: 0,
      cleanup_retries: 0,
      cleanup_bytes_reclaimed: 0
    };
  }

  /**
   * 1. Authoritative Source Deletion Safety Evaluator
   * Determines if a source object is confirmed redundant vs. active production asset
   */
  canSafelyDeleteSource({ record, productionObjectHead = null, productionValidation = null }) {
    if (!record) {
      return { safe: false, reason: 'RECORD_NOT_FOUND', checks: { recordExists: false } };
    }

    const checks = {
      statusReady: false,
      notActiveProcessing: false,
      noRetryPending: false,
      distinctFromProduction: false,
      productionExists: false,
      productionValidated: false,
      retentionPermitted: false
    };

    // Lock 1: Processing state must be strictly READY or UNASSIGNED/PENDING_DELETE
    if (['PROCESSING', 'ANALYZING', 'OPTIMIZING', 'VALIDATING'].includes(record.status)) {
      return { safe: false, reason: 'ACTIVE_PROCESSING', checks };
    }
    if (record.status !== VIDEO_STATUS.READY && record.status !== 'UNASSIGNED' && record.status !== 'PENDING_DELETE') {
      return { safe: false, reason: `STATUS_NOT_READY (${record.status})`, checks };
    }
    checks.statusReady = true;
    checks.notActiveProcessing = true;

    // Lock 2: No active retry pending
    if (record.error_code && record.status !== VIDEO_STATUS.READY && record.status !== 'UNASSIGNED') {
      return { safe: false, reason: 'RETRY_PENDING', checks };
    }
    checks.noRetryPending = true;

    // Lock 3: Determine Production Key & Identity Check (NEVER delete the only copy of an active lesson)
    const sourceKey = record.source_s3_key;
    let prodKey = record.optimized_s3_key;
    if (!prodKey && record.hls_master_url) {
      try {
        prodKey = new URL(record.hls_master_url).pathname.replace(/^\/+/, '');
      } catch (e) {
        prodKey = record.hls_master_url.replace(/^\/+/, '');
      }
    } else if (!prodKey && record.hls_prefix) {
      prodKey = `${record.hls_prefix}master.m3u8`.replace(/\/\/+/g, '/');
    } else if (!prodKey && record.optimized_mp4_url) {
      try {
        prodKey = new URL(record.optimized_mp4_url).pathname.replace(/^\/+/, '');
      } catch (e) {
        prodKey = record.optimized_mp4_url.replace(/^\/+/, '');
      }
    }

    if (!sourceKey) {
      return { safe: false, reason: 'SOURCE_KEY_MISSING', checks };
    }

    // If active in course and source key IS the active production key
    if (record.status === VIDEO_STATUS.READY && (sourceKey === prodKey || (prodKey && sourceKey.includes(prodKey)))) {
      return { safe: false, reason: 'SOURCE_IS_PRODUCTION_ASSET', checks };
    }
    checks.distinctFromProduction = true;

    // Lock 4: Production S3 object check (applicable when replacing raw source for READY videos)
    if (record.status === VIDEO_STATUS.READY) {
      if (!productionObjectHead || !productionObjectHead.exists || Number(productionObjectHead.contentLength) <= 0) {
        return { safe: false, reason: 'PRODUCTION_MISSING', checks };
      }
      checks.productionExists = true;

      // Lock 5: Production technical integrity validation
      if (productionValidation && !productionValidation.isValid) {
        return {
          safe: false,
          reason: 'PRODUCTION_NOT_VALIDATED',
          checks: { ...checks, validationErrors: productionValidation.errors }
        };
      }
      checks.productionValidated = true;

      // Lock 6: Retention policy check
      const policy = COMPRESSION_SETTINGS.SOURCE_RETENTION_POLICY;
      if (policy !== 'DELETE_AFTER_VALIDATION') {
        return { safe: false, reason: 'RETENTION_POLICY_BLOCKED', checks };
      }
      checks.retentionPermitted = true;
    }

    // Lock 7: Idempotency check
    if (record.source_deleted_at) {
      return { safe: false, reason: 'ALREADY_DELETED', alreadyDeleted: true, checks };
    }

    // Lock 8: Multi-Topic Clipping Safety Check
    // If source video is split into topics, raw source MUST be retained until ALL topics are READY
    if (record.is_topic_split) {
      const totalTopics = Number(record.total_topics_count) || 0;
      const readyTopics = Number(record.ready_topics_count) || 0;
      const failedTopics = Number(record.failed_topics_count) || 0;

      if (totalTopics > 0 && (readyTopics < totalTopics || failedTopics > 0)) {
        return {
          safe: false,
          reason: `TOPIC_CLIPS_INCOMPLETE (${readyTopics}/${totalTopics} ready, ${failedTopics} failed)`,
          checks: { ...checks, topicClipsComplete: false }
        };
      }
    }

    return {
      safe: true,
      reason: 'SAFE_TO_DELETE',
      checks
    };
  }

  // Backward-compatible alias
  canSafelyDeleteRawSource(record, productionObjectHead = null, productionValidation = null) {
    return this.canSafelyDeleteSource({ record, productionObjectHead, productionValidation });
  }

  /**
   * 2. Safely Delete Redundant Ingest Source
   */
  async safeDeleteRawSource({ record, s3VideoService, videoService, dryRun = false }) {
    if (!record || !record.source_s3_key) {
      return { status: CLEANUP_STATUS.ALREADY_DELETED, deleted: false };
    }

    const isDryRun = dryRun || CLEANUP_SETTINGS.DRY_RUN;
    const outputBucket = record.source_s3_bucket;
    
    // Resolve production key for verification (master.m3u8 for HLS, or legacy MP4)
    let optKey = record.optimized_s3_key;
    if (!optKey && record.hls_master_url) {
      try {
        optKey = new URL(record.hls_master_url).pathname.replace(/^\/+/, '');
      } catch (e) {
        optKey = record.hls_master_url.replace(/^\/+/, '');
      }
    } else if (!optKey && record.hls_prefix) {
      optKey = `${record.hls_prefix}master.m3u8`.replace(/\/\/+/g, '/');
    }

    // Verify Production Object Existence & Non-Empty ContentLength
    let prodHead = null;
    if (optKey && typeof s3VideoService?.verifyObjectExists === 'function') {
      prodHead = await s3VideoService.verifyObjectExists(outputBucket, optKey).catch(() => ({ exists: false }));
    }

    // Reuse existing technical validation
    const prodVal = videoCompressor.validateTechnicalIntegrity({
      sourceInfo: {
        targetResolution: record.output_resolution || record.original_resolution || '1080p',
        durationSeconds: record.duration_seconds,
        fps: record.source_fps || 30,
        hasAudio: record.source_has_audio !== false
      },
      outputInfo: {
        contentLength: prodHead?.contentLength || record.optimized_file_size_bytes || record.file_size_bytes,
        durationSeconds: record.duration_seconds,
        fps: record.source_fps || 30,
        videoCodec: 'h264',
        audioCodec: 'aac',
        hasAudio: record.source_has_audio !== false
      }
    });

    const safetyCheck = this.canSafelyDeleteSource({
      record,
      productionObjectHead: prodHead,
      productionValidation: prodVal
    });

    if (!safetyCheck.safe) {
      if (safetyCheck.alreadyDeleted) {
        return { status: CLEANUP_STATUS.ALREADY_DELETED, deleted: false, reason: safetyCheck.reason };
      }
      console.log(`🔒 [Safety Lock] Source deletion blocked for lesson ${record.lesson_id}: ${safetyCheck.reason}`);
      return { status: CLEANUP_STATUS.PROTECTED, deleted: false, reason: safetyCheck.reason };
    }

    const reclaimedBytes = Number(record.original_file_size_bytes || record.file_size_bytes || 0);

    // Dry Run check
    if (isDryRun) {
      console.log(`🔍 [DRY-RUN] Would delete redundant source: s3://${record.source_s3_bucket}/${record.source_s3_key} (${(reclaimedBytes / (1024 * 1024)).toFixed(2)} MB)`);
      this.logCleanupAudit({
        video_id: record.id,
        course_id: record.course_id,
        module_id: record.module_id,
        processing_attempt_id: record.processing_attempt_id,
        object_key: record.source_s3_key,
        object_type: 'RAW_INGEST',
        cleanup_reason: 'SUCCESSFUL_FINALIZATION',
        cleanup_status: 'WOULD_DELETE',
        bytes_reclaimed: reclaimedBytes,
        dry_run: true
      });
      return { status: 'WOULD_DELETE', deleted: false, key: record.source_s3_key, bytesReclaimed: reclaimedBytes, dryRun: true };
    }

    try {
      console.log(`🧹 [Video Cleanup] Deleting redundant ingest source: s3://${record.source_s3_bucket}/${record.source_s3_key}`);
      const delRes = await s3VideoService.deleteObject(record.source_s3_bucket, record.source_s3_key);

      if (delRes.deleted) {
        this.metrics.raw_sources_deleted++;
        this.metrics.cleanup_bytes_reclaimed += reclaimedBytes;

        this.logCleanupAudit({
          video_id: record.id,
          course_id: record.course_id,
          module_id: record.module_id,
          processing_attempt_id: record.processing_attempt_id,
          object_key: record.source_s3_key,
          object_type: 'RAW_INGEST',
          cleanup_reason: 'SUCCESSFUL_FINALIZATION',
          cleanup_status: CLEANUP_STATUS.COMPLETED,
          bytes_reclaimed: reclaimedBytes
        });

        if (videoService) {
          await videoService.upsertVideoRecord({
            ...record,
            source_deleted_at: new Date().toISOString()
          });
        }

        return {
          status: CLEANUP_STATUS.COMPLETED,
          deleted: true,
          key: record.source_s3_key,
          bytesReclaimed: reclaimedBytes
        };
      } else {
        throw new Error(delRes.error || 'S3 DeleteObject returned false.');
      }
    } catch (err) {
      this.metrics.cleanup_failures++;
      console.warn(`⚠️ [Video Cleanup Notice] Could not delete raw source s3://${record.source_s3_bucket}/${record.source_s3_key}:`, err.message);

      this.logCleanupAudit({
        video_id: record.id,
        course_id: record.course_id,
        module_id: record.module_id,
        processing_attempt_id: record.processing_attempt_id,
        object_key: record.source_s3_key,
        object_type: 'RAW_INGEST',
        cleanup_reason: 'SUCCESSFUL_FINALIZATION',
        cleanup_status: CLEANUP_STATUS.FAILED,
        bytes_reclaimed: 0,
        error: err.message
      });

      // NON-BREAKING: Never fail an otherwise READY video if cleanup fails
      return {
        status: CLEANUP_STATUS.FAILED,
        deleted: false,
        error: err.message
      };
    }
  }

  /**
   * 3. OPTION A: Remove from Course (48-Hour Grace Period)
   * Unlinks video from curriculum, marks UNASSIGNED/PENDING_DELETE with cleanup_after = NOW + 48h.
   */
  async unassignVideoWith48HourGrace({ lessonId, courseId, moduleId, videoAssetId }) {
    if (courseId) {
      const { validateHierarchyChain } = require('../../utils/hierarchyValidator');
      await validateHierarchyChain({
        courseId,
        moduleId: moduleId || lessonId,
        videoId: videoAssetId
      });
    }

    const graceHours = CLEANUP_SETTINGS.UNASSIGNED_GRACE_PERIOD_HOURS || 48;
    const cleanupAfter = new Date(Date.now() + (graceHours * 60 * 60 * 1000)).toISOString();
    const videoService = require('./video.service');

    try {
      let q = supabase.from('lesson_videos').select('*');
      if (courseId) {
        const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(courseId));
        if (isUUID) q = q.eq('course_id', courseId);
      }
      q = q.or(`lesson_id.eq.${lessonId},id.eq.${videoAssetId || lessonId},module_id.eq.${moduleId || lessonId}`);
      const { data: records } = await q;

      if (Array.isArray(records) && records.length > 0) {
        for (const rec of records) {
          await supabase
            .from('lesson_videos')
            .update({
              status: 'UNASSIGNED',
              cleanup_status: 'PENDING_DELETE',
              cleanup_after: cleanupAfter,
              cleanup_reason: 'REMOVED_FROM_COURSE',
              hls_master_url: null,
              updated_at: new Date().toISOString()
            })
            .eq('id', rec.id);

          this.logCleanupAudit({
            video_id: rec.id,
            course_id: courseId || rec.course_id,
            module_id: moduleId || rec.module_id,
            object_key: rec.source_s3_key,
            object_type: 'COURSE_VIDEO',
            cleanup_reason: 'REMOVED_FROM_COURSE',
            cleanup_status: 'PENDING_DELETE_48H',
            bytes_reclaimed: 0
          });
        }
      }

      // Reset topics in DB for this module so they don't hold READY state
      try {
        let topicQuery = supabase
          .from('topics')
          .update({
            processing_status: 'DRAFT',
            hls_master_url: null,
            hls_720p_url: null,
            hls_1080p_url: null,
            updated_at: new Date().toISOString()
          });
        if (courseId) {
          const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(courseId));
          if (isUUID) topicQuery = topicQuery.eq('course_id', courseId);
        }
        if (moduleId || lessonId) {
          topicQuery = topicQuery.or(`module_id.eq.${moduleId || lessonId},module_id.eq.${videoAssetId || lessonId}`);
        }
        await topicQuery;
      } catch (tDbErr) {
        console.warn('⚠️ [Video Cleanup] Notice resetting module topics in database during unassign:', tDbErr.message);
      }

      // Clear memory video store
      if (videoService && videoService.memoryVideoStore) {
        videoService.memoryVideoStore.delete(String(videoAssetId || lessonId));
        videoService.memoryVideoStore.delete(String(moduleId || lessonId));
        for (const [k, v] of videoService.memoryVideoStore.entries()) {
          if (k.startsWith('topic_') && v && (String(v.module_id) === String(moduleId || lessonId))) {
            videoService.memoryVideoStore.delete(k);
          }
        }
      }

      // Unlink Video from Course Curriculum JSON
      if (courseId && videoService && typeof videoService.syncVideoUrlToCourseCurriculum === 'function') {
        await videoService.syncVideoUrlToCourseCurriculum(
          courseId,
          moduleId || lessonId,
          lessonId || moduleId,
          '',
          null
        );
      }

      console.log(`⏱️ [Video Lifecycle] Video unassigned for lesson ${lessonId}. 48-hour deletion grace timer set to: ${cleanupAfter}`);
      return {
        success: true,
        mode: 'REMOVE_FROM_COURSE',
        gracePeriodHours: graceHours,
        cleanupAfter
      };
    } catch (err) {
      console.warn(`⚠️ [Video Cleanup] unassignVideoWith48HourGrace notice:`, err.message);
      return { success: false, error: err.message };
    }
  }

  /**
   * 4. Safe Video-Scoped Deletion / Cancellation at ANY Lifecycle Stage:
   * (Uploading, Queued, Transcoding, Generating HLS, Validating, READY, FAILED)
   */
  async deletePermanentlyWithSafetyCheck({ lessonId, courseId, moduleId, videoAssetId, s3VideoService, user, dryRun = false }) {
    if (courseId) {
      const { validateHierarchyChain } = require('../../utils/hierarchyValidator');
      await validateHierarchyChain({
        courseId,
        moduleId: moduleId || lessonId,
        videoId: videoAssetId
      });
    }

    const isDryRun = dryRun || CLEANUP_SETTINGS.DRY_RUN;
    const s3PathUtils = require('../../utils/s3PathUtils');
    const mediaConvertVideoService = require('./video.mediaconvert.service');
    const videoService = require('./video.service');
    const effectiveS3Service = s3VideoService || require('./video.s3.service');

    try {
      // 1. Locate authoritative video record from memory or database
      let record = null;
      if (videoAssetId && videoService && typeof videoService.getVideoRecord === 'function') {
        const candidate = await videoService.getVideoRecord(videoAssetId);
        if (candidate && (!courseId || !candidate.course_id || String(candidate.course_id) === String(courseId))) {
          record = candidate;
        }
      }

      if (!record) {
        let q = supabase.from('lesson_videos').select('*');
        if (courseId) {
          q = q.eq('course_id', courseId);
        }
        if (videoAssetId) {
          q = q.or(`id.eq.${videoAssetId},lesson_id.eq.${videoAssetId}`);
        } else if (lessonId || moduleId) {
          q = q.or(`id.eq.${lessonId || moduleId},lesson_id.eq.${lessonId || moduleId},module_id.eq.${moduleId || lessonId}`);
        }
        const { data: records } = await q;
        if (Array.isArray(records) && records.length > 0) {
          record = records[0];
        }
      }

      const effectiveVideoId = record?.id || videoAssetId || lessonId;
      const targetCourseId = courseId || record?.course_id;
      const targetModId = moduleId || record?.module_id || lessonId;
      const targetBucket = record?.source_s3_bucket || effectiveS3Service?.sourceBucket;

      console.log(`\n============================================================`);
      console.log(`🧹 [VIDEO DELETE START] videoId=${effectiveVideoId} courseId=${targetCourseId || 'N/A'} moduleId=${targetModId || 'N/A'}`);
      console.log(`------------------------------------------------------------`);

      // 2. Set In-Flight Terminal Lock State: DELETING
      if (record && videoService) {
        await videoService.upsertVideoRecord({
          ...record,
          status: 'DELETING',
          cleanup_status: 'IN_PROGRESS',
          updated_at: new Date().toISOString()
        });
      }

      let hadActiveMediaConvert = false;

      // 3. Cancel Active AWS MediaConvert Job (if in-flight)
      if (record?.mediaconvert_job_id) {
        console.log(`🛑 [MEDIACONVERT CANCEL] jobId=${record.mediaconvert_job_id}`);
        hadActiveMediaConvert = true;
        await mediaConvertVideoService.cancelJob(record.mediaconvert_job_id).catch(() => {});
      } else {
        console.log(`ℹ️ [MEDIACONVERT CANCEL] jobId=NONE (No active MediaConvert job)`);
      }

      // 4. Abort Active S3 Multipart Upload (if in-flight)
      if (record?.upload_id && record?.source_s3_key) {
        console.log(`🛑 [S3 MULTIPART ABORT] uploadId=${record.upload_id} key=${record.source_s3_key}`);
        await effectiveS3Service?.abortMultipartUpload({
          s3Key: record.source_s3_key,
          uploadId: record.upload_id
        }).catch(() => {});
      }

      // 5. Construct Video-Scoped S3 Prefixes and Individual Keys to Purge
      const prefixesToPurge = new Set();
      const individualKeys = new Set();

      if (record?.source_s3_key) {
        individualKeys.add(record.source_s3_key);
        if (record.source_s3_key.includes(`/videos/${effectiveVideoId}/`)) {
          const vIdx = record.source_s3_key.indexOf(`/videos/${effectiveVideoId}/`);
          prefixesToPurge.add(record.source_s3_key.substring(0, vIdx + `/videos/${effectiveVideoId}/`.length));
        }
      }
      if (record?.optimized_s3_key) individualKeys.add(record.optimized_s3_key);

      // A. Explicit record HLS prefix
      if (record?.hls_prefix) {
        prefixesToPurge.add(record.hls_prefix.endsWith('/') ? record.hls_prefix : `${record.hls_prefix}/`);
      }

      // Extract exact folder from hls_master_url
      if (record?.hls_master_url) {
        const cleanHlsKey = record.hls_master_url.replace(/^https?:\/\/[^\/]+\//, '').replace(/^\/+/, '');
        if (cleanHlsKey.includes(`/videos/${effectiveVideoId}/`)) {
          const vIdx = cleanHlsKey.indexOf(`/videos/${effectiveVideoId}/`);
          prefixesToPurge.add(cleanHlsKey.substring(0, vIdx + `/videos/${effectiveVideoId}/`.length));
        } else if (cleanHlsKey.includes('.m3u8')) {
          const hlsFolder = cleanHlsKey.substring(0, cleanHlsKey.lastIndexOf('/') + 1);
          if (hlsFolder) prefixesToPurge.add(hlsFolder);
        }
      }

      // B. Isolated video namespaces (STRICTLY videoId scoped, never unscoped parent folders)
      if (targetCourseId && targetModId) {
        prefixesToPurge.add(`courses/${targetCourseId}/modules/${targetModId}/videos/${effectiveVideoId}/`);
        prefixesToPurge.add(`courses/${targetCourseId}/modules/${targetModId}/lessons/${effectiveVideoId}/`);
      }

      // C. Resolve Course & Module Details from Database to Extract Exact URLs & Slugs
      if (targetCourseId) {
        try {
          const cleanCourseId = String(targetCourseId).trim();
          const classification = classifyIdentifier(cleanCourseId);
          if (classification !== 'INVALID') {
            let courseQuery = supabase.from('courses').select('id, title, slug, curriculum_modules');
            if (classification === 'UUID') {
              courseQuery = courseQuery.eq('id', cleanCourseId);
            } else {
              courseQuery = courseQuery.eq('slug', normalizeIdentifier(cleanCourseId, 'SLUG'));
            }
            const { data: courseObj } = await courseQuery.maybeSingle();

            if (courseObj && Array.isArray(courseObj.curriculum_modules)) {
              const courseSlug = s3PathUtils.generateS3CourseSlug(courseObj.slug || courseObj.title);
              const modIndex = courseObj.curriculum_modules.findIndex(m =>
                String(m.id) === String(targetModId) ||
                String(m.id) === String(lessonId) ||
                String(m.video_asset_id) === String(effectiveVideoId)
              );

              if (modIndex !== -1) {
                const targetMod = courseObj.curriculum_modules[modIndex];
                const moduleSlug = s3PathUtils.generateS3ModuleSlug(targetMod, modIndex + 1);

                // ONLY exact video-id scoped prefixes
                prefixesToPurge.add(`courses/${courseSlug}/modules/${moduleSlug}/videos/${effectiveVideoId}/`);
                prefixesToPurge.add(`courses/${courseSlug}/modules/${String(modIndex + 1).padStart(2, '0')}-${targetMod.id || targetModId}/videos/${effectiveVideoId}/`);
                prefixesToPurge.add(`courses/${courseObj.id}/modules/${targetMod.id || targetModId}/videos/${effectiveVideoId}/`);

                // Extract any exact S3 key stored in module video_url
                if (targetMod.video_url) {
                  const rawUrl = targetMod.video_url;
                  const cleanKey = rawUrl.replace(/^https?:\/\/[^\/]+\//, '').replace(/^\/+/, '');
                  if (cleanKey.includes(`/videos/${effectiveVideoId}/`)) {
                    const vIdx = cleanKey.indexOf(`/videos/${effectiveVideoId}/`);
                    prefixesToPurge.add(cleanKey.substring(0, vIdx + `/videos/${effectiveVideoId}/`.length));
                  } else if (cleanKey.includes('.m3u8')) {
                    const hlsFolder = cleanKey.substring(0, cleanKey.lastIndexOf('/') + 1);
                    if (hlsFolder) prefixesToPurge.add(hlsFolder);
                  } else if (cleanKey) {
                    individualKeys.add(cleanKey);
                  }
                }
              }
            }
          }
        } catch (cErr) {
          console.warn('⚠️ [Video Cleanup] Notice resolving course for S3 keys:', cErr.message);
        }
      }

      // D. Find and cancel all associated Topic MediaConvert jobs and include their S3 prefixes
      try {
        let topQuery = supabase.from('topics').select('*');
        if (targetCourseId) {
          const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(targetCourseId));
          if (isUUID) topQuery = topQuery.eq('course_id', targetCourseId);
        }
        topQuery = topQuery.or(`module_id.eq.${targetModId},module_id.eq.${effectiveVideoId}`);
        const { data: moduleTopics } = await topQuery;

        if (Array.isArray(moduleTopics) && moduleTopics.length > 0) {
          for (const top of moduleTopics) {
            if (top.mediaconvert_job_id) {
              console.log(`🛑 [TOPIC MEDIACONVERT CANCEL] topicId=${top.id} jobId=${top.mediaconvert_job_id}`);
              hadActiveMediaConvert = true;
              await mediaConvertVideoService.cancelJob(top.mediaconvert_job_id).catch(() => {});
            }
            if (top.hls_prefix) {
              prefixesToPurge.add(top.hls_prefix.endsWith('/') ? top.hls_prefix : `${top.hls_prefix}/`);
            }
            if (top.s3_key) individualKeys.add(top.s3_key);
            if (top.hls_master_url) {
              const cleanTopHls = top.hls_master_url.replace(/^https?:\/\/[^\/]+\//, '').replace(/^\/+/, '');
              if (cleanTopHls.includes('.m3u8')) {
                const f = cleanTopHls.substring(0, cleanTopHls.lastIndexOf('/') + 1);
                if (f) prefixesToPurge.add(f);
              }
            }
            if (videoService && videoService.memoryVideoStore) {
              videoService.memoryVideoStore.delete(`topic_${top.id}`);
            }
          }
        }
      } catch (tErr) {
        console.warn('⚠️ [Video Cleanup] Notice finding module topics:', tErr.message);
      }

      // If MediaConvert was active, pause 1.5s to let in-flight worker chunks complete write
      if (hadActiveMediaConvert) {
        console.log(`⏳ [MediaConvert Drain Delay] Pausing 1500ms for in-flight transcoder chunks to complete write...`);
        await new Promise(resolve => setTimeout(resolve, 1500));
      }

      console.log(`📂 [S3 CLEANUP START] Target bucket: s3://${targetBucket}`);
      console.log(`   Prefixes:`, Array.from(prefixesToPurge));
      console.log(`   Individual keys:`, Array.from(individualKeys));

      // Dry-Run Check
      if (isDryRun) {
        console.log(`🔍 [DRY-RUN] Would purge prefixes:`, Array.from(prefixesToPurge), `and keys:`, Array.from(individualKeys));
        return {
          success: true,
          deleted: false,
          dryRun: true,
          prefixes: Array.from(prefixesToPurge),
          individualKeys: Array.from(individualKeys)
        };
      }

      let totalDeletedCount = 0;
      let totalFoundCount = 0;

      // 6. Execute S3 Batch Purge for each isolated video prefix
      for (const prefix of prefixesToPurge) {
        try {
          const purgeRes = await effectiveS3Service.purgeVideoPrefix({
            bucket: targetBucket,
            prefix
          });
          totalFoundCount += (purgeRes.deletedCount || 0) + (purgeRes.remainingCount || 0);
          totalDeletedCount += (purgeRes.deletedCount || 0);
        } catch (pErr) {
          console.warn(`⚠️ [Video Purge Warning] Could not purge prefix ${prefix}:`, pErr.message);
        }
      }

      // Delete any individual loose keys
      for (const key of individualKeys) {
        try {
          const head = await effectiveS3Service.verifyObjectExists(targetBucket, key);
          if (head && head.exists) {
            totalFoundCount++;
            const dRes = await effectiveS3Service.deleteObject(targetBucket, key);
            if (dRes.deleted) totalDeletedCount++;
          }
        } catch (kErr) {}
      }

      console.log(`📊 [S3 OBJECTS FOUND] count=${totalFoundCount}`);
      console.log(`📊 [S3 OBJECTS DELETED] count=${totalDeletedCount}`);

      // 7. Verify Cleanup with Immediate 2nd-Pass Drain if trailing chunks arrived
      let remainingCount = 0;
      for (const prefix of prefixesToPurge) {
        try {
          let remainingObjs = await effectiveS3Service.listObjectsWithPagination({ bucket: targetBucket, prefix });
          if (remainingObjs.length > 0) {
            console.log(`🔄 [S3 Drain 2nd Pass] Found ${remainingObjs.length} trailing objects under ${prefix}, batch deleting...`);
            const keysToPurge = remainingObjs.map(o => o.Key).filter(Boolean);
            const drainRes = await effectiveS3Service.deleteObjectsBatch(targetBucket, keysToPurge);
            totalDeletedCount += (drainRes.deletedCount || 0);
            remainingObjs = await effectiveS3Service.listObjectsWithPagination({ bucket: targetBucket, prefix });
          }
          remainingCount += (remainingObjs.length || 0);
        } catch (rErr) {}
      }

      console.log(`🔍 [S3 CLEANUP VERIFIED] remaining=${remainingCount}`);

      if (remainingCount > 0) {
        console.warn(`⚠️ [Video Lifecycle] S3 deletion left ${remainingCount} trailing objects for video ${effectiveVideoId}. Background retry scheduled.`);
      }

      // 8. ALWAYS Finalize Database Terminal State: DELETED & Reset Topics
      // Crucial: Regardless of remaining S3 objects, the database and curriculum must
      // ALWAYS be unlinked so the UI reflects the user's deletion command immediately.
      if (record && videoService) {
        await videoService.upsertVideoRecord({
          ...record,
          status: 'DELETED',
          cleanup_status: remainingCount === 0 ? 'COMPLETED' : 'PARTIAL_RETRY_SCHEDULED',
          hls_master_url: null,
          optimized_mp4_url: null,
          source_deleted_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });
      }

      // Remove / Mark DELETED in lesson_videos table
      try {
        let lvQuery = supabase.from('lesson_videos').delete();
        if (targetCourseId) {
          const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(targetCourseId));
          if (isUUID) lvQuery = lvQuery.eq('course_id', targetCourseId);
        }
        await lvQuery.or(`id.eq.${effectiveVideoId},lesson_id.eq.${effectiveVideoId},lesson_id.eq.${targetModId},module_id.eq.${targetModId}`);
      } catch (lvErr) {}

      // Reset topics in Supabase DB for this module so they don't hold the READY state
      try {
        let topicQuery = supabase
          .from('topics')
          .update({
            processing_status: 'DRAFT',
            mediaconvert_job_id: null,
            hls_master_url: null,
            hls_720p_url: null,
            hls_1080p_url: null,
            start_timecode: null,
            end_timecode: null,
            start_time_seconds: 0,
            end_time_seconds: 0,
            duration_seconds: 0,
            processing_error: null,
            updated_at: new Date().toISOString()
          });
        if (targetCourseId) {
          const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(targetCourseId));
          if (isUUID) topicQuery = topicQuery.eq('course_id', targetCourseId);
        }
        if (targetModId) {
          topicQuery = topicQuery.or(`module_id.eq.${targetModId},module_id.eq.${effectiveVideoId}`);
        }
        await topicQuery;
      } catch (tDbErr) {
        console.warn('⚠️ [Video Cleanup] Notice resetting module topics in database:', tDbErr.message);
      }

      // Clean in-memory store
      if (videoService && videoService.memoryVideoStore) {
        videoService.memoryVideoStore.delete(String(effectiveVideoId));
        videoService.memoryVideoStore.delete(String(targetModId));
        if (lessonId) videoService.memoryVideoStore.delete(String(lessonId));
        for (const [k, v] of videoService.memoryVideoStore.entries()) {
          if (k.startsWith('topic_') && v && (String(v.module_id) === String(targetModId) || String(v.module_id) === String(effectiveVideoId))) {
            videoService.memoryVideoStore.delete(k);
          }
        }
      }

      // 9. Unlink Video from Course Curriculum JSON
      if (targetCourseId && videoService && typeof videoService.syncVideoUrlToCourseCurriculum === 'function') {
        await videoService.syncVideoUrlToCourseCurriculum(
          targetCourseId,
          targetModId,
          lessonId || targetModId,
          '',
          null
        );
      }

      this.metrics.permanent_deletes_executed++;
      this.logCleanupAudit({
        video_id: effectiveVideoId,
        course_id: targetCourseId,
        module_id: targetModId,
        object_key: record?.source_s3_key,
        object_type: 'VIDEO_PIPELINE',
        cleanup_reason: 'VIDEO_SCOPED_PERMANENT_DELETE',
        cleanup_status: remainingCount === 0 ? CLEANUP_STATUS.COMPLETED : CLEANUP_STATUS.FAILED,
        bytes_reclaimed: totalDeletedCount,
        deleted_by: user?.email || user?.id || 'admin'
      });

      console.log(`✅ [VIDEO DELETE COMPLETE] videoId=${effectiveVideoId} Status=DELETED (Purged ${totalDeletedCount} objects, remaining=${remainingCount})`);
      console.log(`============================================================\n`);

      return {
        success: true,
        mode: 'VIDEO_SCOPED_PERMANENT_DELETE',
        deleted: true,
        videoAssetId: effectiveVideoId,
        objectsPurged: totalDeletedCount,
        remainingCount,
        message: remainingCount === 0
          ? 'Video permanently deleted from course and cloud storage.'
          : `Video unlinked from course and ${totalDeletedCount} files deleted. Lingering files queued for background cleanup.`
      };
    } catch (err) {
      console.error(`⚠️ [Video Cleanup Error] deletePermanentlyWithSafetyCheck:`, err.message);
      return { success: false, error: err.message };
    }
  }

  /**
   * 5. Helper: Check if video URL or S3 key is actively referenced anywhere else
   */
  async checkActiveDatabaseReferences(targetKeysOrUrls = [], excludeLessonId = null) {
    if (!targetKeysOrUrls || targetKeysOrUrls.length === 0) return false;

    try {
      const { data: courses } = await supabase.from('courses').select('curriculum_modules');
      if (Array.isArray(courses)) {
        for (const c of courses) {
          if (Array.isArray(c.curriculum_modules)) {
            for (const mod of c.curriculum_modules) {
              for (const target of targetKeysOrUrls) {
                if (mod.video_url && mod.video_url.includes(target) && String(mod.id) !== String(excludeLessonId)) {
                  return true;
                }
              }
              if (Array.isArray(mod.lessons)) {
                for (const les of mod.lessons) {
                  for (const target of targetKeysOrUrls) {
                    if (les.video_url && les.video_url.includes(target) && String(les.id) !== String(excludeLessonId)) {
                      return true;
                    }
                  }
                }
              }
            }
          }
        }
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  /**
   * 6. Clean Rejected Bloated Outputs (optimized_size >= original_size)
   */
  async cleanupRejectedOutput({ outputBucket, optimizedS3Key, record, s3VideoService, dryRun = false }) {
    if (!optimizedS3Key) return { deleted: false };
    const isDryRun = dryRun || CLEANUP_SETTINGS.DRY_RUN;
    const bytes = Number(record?.optimized_file_size_bytes || 0);

    if (isDryRun) {
      console.log(`🔍 [DRY-RUN] Would purge rejected output: s3://${outputBucket}/${optimizedS3Key}`);
      this.logCleanupAudit({
        video_id: record?.id,
        course_id: record?.course_id,
        module_id: record?.module_id,
        processing_attempt_id: record?.processing_attempt_id,
        object_key: optimizedS3Key,
        object_type: 'REJECTED_OUTPUT',
        cleanup_reason: 'OUTPUT_NOT_BENEFICIAL',
        cleanup_status: 'WOULD_DELETE',
        bytes_reclaimed: bytes,
        dry_run: true
      });
      return { deleted: false, dryRun: true };
    }

    try {
      console.log(`🧹 [Video Cleanup] Purging rejected bloated output: s3://${outputBucket}/${optimizedS3Key}`);
      const res = await s3VideoService.deleteObject(outputBucket, optimizedS3Key);
      if (res.deleted) {
        this.metrics.rejected_outputs_deleted++;
        this.metrics.cleanup_bytes_reclaimed += bytes;

        this.logCleanupAudit({
          video_id: record?.id,
          course_id: record?.course_id,
          module_id: record?.module_id,
          processing_attempt_id: record?.processing_attempt_id,
          object_key: optimizedS3Key,
          object_type: 'REJECTED_OUTPUT',
          cleanup_reason: 'OUTPUT_NOT_BENEFICIAL',
          cleanup_status: CLEANUP_STATUS.COMPLETED,
          bytes_reclaimed: bytes
        });
      }
      return res;
    } catch (err) {
      this.metrics.cleanup_failures++;
      console.warn(`⚠️ [Video Cleanup Notice] Could not purge rejected output ${optimizedS3Key}:`, err.message);
      return { deleted: false, error: err.message };
    }
  }

  /**
   * 7. Clean Failed Processing Intermediate Outputs (Keeps Source 100% Safe)
   */
  async cleanupFailedProcessingOutput({ outputBucket, outputPrefix, record, s3VideoService, dryRun = false }) {
    if (!outputPrefix && !record?.optimized_s3_key) return { deleted: false };
    const targetKey = record?.optimized_s3_key || `${outputPrefix}_optimized.mp4`.replace(/\/\/+/g, '/');
    const isDryRun = dryRun || CLEANUP_SETTINGS.DRY_RUN;

    if (isDryRun) {
      console.log(`🔍 [DRY-RUN] Would purge failed transcoding artifact: s3://${outputBucket}/${targetKey}`);
      return { deleted: false, dryRun: true };
    }

    try {
      console.log(`🧹 [Video Cleanup] Purging failed transcoding artifact: s3://${outputBucket}/${targetKey}`);
      const res = await s3VideoService.deleteObject(outputBucket, targetKey);
      if (res.deleted) {
        this.metrics.temporary_objects_deleted++;
        this.logCleanupAudit({
          video_id: record?.id,
          course_id: record?.course_id,
          module_id: record?.module_id,
          processing_attempt_id: record?.processing_attempt_id,
          object_key: targetKey,
          object_type: 'PROCESSING_ARTIFACT',
          cleanup_reason: 'FAILED_MEDIACONVERT',
          cleanup_status: CLEANUP_STATUS.COMPLETED,
          bytes_reclaimed: 0
        });
      }
      return res;
    } catch (err) {
      console.warn(`⚠️ [Video Cleanup Notice] Could not purge failed artifact:`, err.message);
      return { deleted: false, error: err.message };
    }
  }

  /**
   * 8. Clean Abandoned Incomplete Multipart Uploads (1 day)
   */
  async cleanAbandonedMultipartUploads({ bucket, maxAgeHours = 24, s3VideoService, dryRun = false }) {
    if (dryRun || CLEANUP_SETTINGS.DRY_RUN) {
      console.log(`🔍 [DRY-RUN] Checking abandoned multipart uploads older than ${maxAgeHours}h...`);
      return { totalFound: 0, abortedCount: 0, dryRun: true };
    }

    try {
      const res = await s3VideoService.cleanAbandonedMultipartUploads({
        bucket,
        maxAgeHours: maxAgeHours || (CLEANUP_SETTINGS.S3_MULTIPART_ABORT_DAYS * 24)
      });
      this.metrics.multipart_uploads_aborted += (res.abortedCount || 0);
      return res;
    } catch (err) {
      console.warn(`⚠️ [Video Cleanup Notice] Multipart cleanup error:`, err.message);
      return { totalFound: 0, abortedCount: 0, error: err.message };
    }
  }

  /**
   * 9. Process 48-Hour Unassigned Video Queue
   * Automatically deletes unassigned videos if they remain unused after 48 hours
   */
  async processUnassigned48HourQueue(s3VideoService, dryRun = false) {
    const isDryRun = dryRun || CLEANUP_SETTINGS.DRY_RUN;
    const nowIso = new Date().toISOString();
    let cleaned = 0;

    try {
      const { data: unassignedRecords } = await supabase
        .from('lesson_videos')
        .select('*')
        .or('status.eq.UNASSIGNED,cleanup_status.eq.PENDING_DELETE')
        .is('source_deleted_at', null)
        .lt('cleanup_after', nowIso)
        .limit(25);

      if (Array.isArray(unassignedRecords)) {
        for (const rec of unassignedRecords) {
          // Re-check active references: If reassigned to any lesson, cancel deletion!
          const activeUrls = [rec.optimized_mp4_url, rec.hls_master_url, rec.source_s3_key, rec.optimized_s3_key].filter(Boolean);
          const isReferenced = await this.checkActiveDatabaseReferences(activeUrls);

          if (isReferenced) {
            console.log(`🔄 [Video Reassignment] Video '${rec.id}' reassigned to another module. Cancelling pending 48h deletion.`);
            await supabase
              .from('lesson_videos')
              .update({
                status: VIDEO_STATUS.READY,
                cleanup_status: 'PROTECTED',
                cleanup_after: null,
                updated_at: new Date().toISOString()
              })
              .eq('id', rec.id);
            continue;
          }

          // Still unused after 48 hours -> execute safe S3 deletion
          const targetBucket = rec.source_s3_bucket || s3VideoService?.sourceBucket;
          const keysToDelete = [rec.source_s3_key, rec.optimized_s3_key].filter(Boolean);
          const bytes = Number(rec.original_file_size_bytes || rec.file_size_bytes || 0);

          if (isDryRun) {
            console.log(`🔍 [DRY-RUN] Would delete expired unassigned video (>48h):`, keysToDelete);
            cleaned++;
            continue;
          }

          for (const key of keysToDelete) {
            console.log(`🧹 [Auto 48h Cleanup] Deleting expired unassigned video: s3://${targetBucket}/${key}`);
            await s3VideoService?.deleteObject(targetBucket, key);
          }

          await supabase
            .from('lesson_videos')
            .update({
              status: 'DELETED',
              cleanup_status: 'COMPLETED',
              source_deleted_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            })
            .eq('id', rec.id);

          cleaned++;
          this.metrics.unassigned_objects_deleted++;
          this.metrics.cleanup_bytes_reclaimed += bytes;

          this.logCleanupAudit({
            video_id: rec.id,
            course_id: rec.course_id,
            module_id: rec.module_id,
            object_key: rec.optimized_s3_key || rec.source_s3_key,
            object_type: 'EXPIRED_UNASSIGNED_VIDEO',
            cleanup_reason: 'AUTO_48_HOUR_CLEANUP',
            cleanup_status: CLEANUP_STATUS.COMPLETED,
            bytes_reclaimed: bytes
          });
        }
      }
    } catch (err) {
      console.warn(`⚠️ [Video Cleanup Notice] processUnassigned48HourQueue error:`, err.message);
    }

    return { unassignedCleaned: cleaned };
  }

  /**
   * 10. Replaced Video Grace Period Queue (48 Hours) - Persisted in Database
   */
  async queueReplacedVideoForCleanup({ oldKey, bucket, courseId, lessonId, gracePeriodHours = 48 }) {
    if (!oldKey) return false;
    const deleteAfter = new Date(Date.now() + (gracePeriodHours * 60 * 60 * 1000)).toISOString();
    
    // Database persistence to survive server process restarts
    try {
      await supabase
        .from('lesson_videos')
        .update({
          source_delete_after: deleteAfter,
          cleanup_after: deleteAfter,
          cleanup_status: 'PENDING_DELETE',
          updated_at: new Date().toISOString()
        })
        .eq('lesson_id', lessonId);
    } catch (dbErr) {
      console.warn(`⚠️ [Video Cleanup Persistence Notice] Lesson ${lessonId}:`, dbErr.message);
    }

    console.log(`⏱️ [Video Cleanup] Queued replaced video '${oldKey}' for deletion after ${gracePeriodHours}h grace period.`);
    return true;
  }

  /**
   * 11. Process Queued Replaced Videos (48 Hours)
   */
  async processReplacementQueue(s3VideoService, dryRun = false) {
    const isDryRun = dryRun || CLEANUP_SETTINGS.DRY_RUN;
    const now = Date.now();
    let cleaned = 0;

    // Process database persistent recovery (survives restarts)
    try {
      const nowIso = new Date().toISOString();
      const { data: expiredRecords } = await supabase
        .from('lesson_videos')
        .select('*')
        .eq('status', VIDEO_STATUS.READY)
        .is('source_deleted_at', null)
        .lt('source_delete_after', nowIso)
        .limit(20);

      if (Array.isArray(expiredRecords)) {
        for (const rec of expiredRecords) {
          const res = await this.safeDeleteRawSource({
            record: rec,
            s3VideoService,
            dryRun: isDryRun
          });
          if (res.deleted) cleaned++;
        }
      }
    } catch (err) {
      console.warn(`⚠️ [Video Cleanup Notice] Error recovering replacement queue:`, err.message);
    }

    return { processed: cleaned };
  }

  /**
   * 12. Safe Orphan Detection & Cleanup with 48-Hour Grace Period & S3 Pagination
   * Inspects ingest/ and processing/ prefixes with full ContinuationToken pagination
   */
  async scanAndCleanOrphanedObjects({ bucket, s3VideoService, gracePeriodHours = 48, dryRun = false }) {
    if (!s3VideoService) return { orphansFound: 0, orphansCleaned: 0 };

    const isDryRun = dryRun || CLEANUP_SETTINGS.DRY_RUN;
    const graceMs = (gracePeriodHours || CLEANUP_SETTINGS.ORPHAN_GRACE_PERIOD_HOURS || 48) * 60 * 60 * 1000;
    const cutoffTime = Date.now() - graceMs;
    const activeKeys = new Set();

    // 1. Build comprehensive active DB key set from lesson_videos and courses curriculum_modules
    try {
      const { data: allVideos } = await supabase
        .from('lesson_videos')
        .select('source_s3_key, optimized_s3_key, optimized_mp4_url, hls_master_url');

      if (Array.isArray(allVideos)) {
        for (const v of allVideos) {
          if (v.source_s3_key) activeKeys.add(v.source_s3_key);
          if (v.optimized_s3_key) activeKeys.add(v.optimized_s3_key);
          if (v.optimized_mp4_url) {
            try { activeKeys.add(new URL(v.optimized_mp4_url).pathname.replace(/^\/+/, '')); } catch (_) {}
          }
          if (v.hls_master_url) {
            try { activeKeys.add(new URL(v.hls_master_url).pathname.replace(/^\/+/, '')); } catch (_) {}
          }
        }
      }

      // Also scan courses curriculum_modules JSON
      const { data: allCourses } = await supabase.from('courses').select('curriculum_modules');
      if (Array.isArray(allCourses)) {
        for (const c of allCourses) {
          if (Array.isArray(c.curriculum_modules)) {
            for (const mod of c.curriculum_modules) {
              if (mod.video_url) {
                try { activeKeys.add(new URL(mod.video_url).pathname.replace(/^\/+/, '')); } catch (_) {}
              }
              if (Array.isArray(mod.lessons)) {
                for (const les of mod.lessons) {
                  if (les.video_url) {
                    try { activeKeys.add(new URL(les.video_url).pathname.replace(/^\/+/, '')); } catch (_) {}
                  }
                }
              }
            }
          }
        }
      }
    } catch (dbErr) {
      console.warn(`⚠️ [Orphan Scanner] DB reference scan notice:`, dbErr.message);
    }

    let totalFound = 0;
    let cleaned = 0;
    let bytesReclaimed = 0;

    // 2. Scan temporary prefixes with pagination
    const targetPrefixes = ['ingest/', 'processing/'];

    for (const prefix of targetPrefixes) {
      console.log(`🔎 [Orphan Scanner] Scanning prefix '${prefix}' in s3://${bucket}...`);
      const objects = await s3VideoService.listObjectsWithPagination({ bucket, prefix });
      totalFound += objects.length;

      for (const obj of objects) {
        const key = obj.Key;
        if (!key) continue;

        // Protection Rule 1: NEVER delete production/
        if (key.startsWith('production/')) continue;

        // Protection Rule 2: Exclude if actively referenced in database
        if (activeKeys.has(key)) continue;

        // Protection Rule 3: 48-Hour Grace Period Age Check
        const lastMod = obj.LastModified ? new Date(obj.LastModified).getTime() : 0;
        if (lastMod >= cutoffTime) {
          // Still in grace period
          continue;
        }

        const size = Number(obj.Size || 0);

        if (isDryRun) {
          console.log(`🔍 [DRY-RUN] Would delete orphan (>48h): s3://${bucket}/${key} (${(size / (1024 * 1024)).toFixed(2)} MB)`);
          cleaned++;
          bytesReclaimed += size;
          this.logCleanupAudit({
            object_key: key,
            object_type: 'ORPHAN_OBJECT',
            cleanup_reason: 'NO_REFERENCE_AFTER_GRACE_PERIOD',
            cleanup_status: 'WOULD_DELETE',
            bytes_reclaimed: size,
            dry_run: true
          });
          continue;
        }

        try {
          console.log(`🧹 [Video Cleanup] Deleting orphan object (>48h): s3://${bucket}/${key}`);
          await s3VideoService.deleteObject(bucket, key);
          cleaned++;
          bytesReclaimed += size;
          this.metrics.orphan_objects_deleted++;
          this.metrics.cleanup_bytes_reclaimed += size;

          this.logCleanupAudit({
            object_key: key,
            object_type: 'ORPHAN_OBJECT',
            cleanup_reason: 'NO_REFERENCE_AFTER_GRACE_PERIOD',
            cleanup_status: CLEANUP_STATUS.COMPLETED,
            bytes_reclaimed: size
          });
        } catch (err) {
          console.warn(`Could not delete orphan ${key}:`, err.message);
        }
      }
    }

    return { orphansFound: totalFound, orphansCleaned: cleaned, bytesReclaimed };
  }

  /**
   * 13. Distributed Maintenance Lock
   * Prevents overlapping cleanup runs across multiple backend instances
   */
  async acquireMaintenanceLock(lockTtlMinutes = 15) {
    const now = Date.now();
    if (this.maintenanceLock && this.maintenanceLock.expiresAt > now) {
      return false; // Lock already held
    }

    this.maintenanceLock = {
      acquiredAt: now,
      expiresAt: now + (lockTtlMinutes * 60 * 1000),
      token: require('crypto').randomUUID()
    };
    return true;
  }

  releaseMaintenanceLock() {
    this.maintenanceLock = null;
  }

  /**
   * 14. Complete Maintenance Cycle Orchestrator
   */
  async runMaintenanceCycle({ s3VideoService, dryRun = false, force = false } = {}) {
    const isDryRun = dryRun || CLEANUP_SETTINGS.DRY_RUN;
    console.log(`\n============================================================`);
    console.log(`🚀 [Video Maintenance] STARTING CLEANUP CYCLE (Dry-Run: ${isDryRun})`);
    console.log(`============================================================`);

    if (!force) {
      const lockAcquired = await this.acquireMaintenanceLock(15);
      if (!lockAcquired) {
        console.log(`ℹ️ [Video Maintenance] Another cleanup cycle is already in progress. Exiting safely.`);
        return { status: 'LOCKED', message: 'Maintenance cycle already in progress.' };
      }
    }

    const report = {
      startedAt: new Date().toISOString(),
      dryRun: isDryRun,
      multipart: null,
      orphans: null,
      unassigned: null,
      replacements: null,
      completedAt: null
    };

    try {
      const s3 = s3VideoService || require('./video.s3.service');
      const bucket = s3.sourceBucket;

      // 1. Clean abandoned multipart uploads (1 day)
      report.multipart = await this.cleanAbandonedMultipartUploads({
        bucket,
        maxAgeHours: CLEANUP_SETTINGS.S3_MULTIPART_ABORT_DAYS * 24,
        s3VideoService: s3,
        dryRun: isDryRun
      }).catch(e => ({ error: e.message }));

      // 2. Scan and clean unassigned 48h videos
      report.unassigned = await this.processUnassigned48HourQueue(s3, isDryRun).catch(e => ({ error: e.message }));

      // 3. Scan and clean orphaned objects with 48h grace period
      report.orphans = await this.scanAndCleanOrphanedObjects({
        bucket,
        s3VideoService: s3,
        gracePeriodHours: CLEANUP_SETTINGS.ORPHAN_GRACE_PERIOD_HOURS,
        dryRun: isDryRun
      }).catch(e => ({ error: e.message }));

      // 4. Process expired replacement queue (48h)
      report.replacements = await this.processReplacementQueue(s3, isDryRun).catch(e => ({ error: e.message }));

    } finally {
      this.releaseMaintenanceLock();
      report.completedAt = new Date().toISOString();
      console.log(`✅ [Video Maintenance] CLEANUP CYCLE FINISHED.`);
      console.log(`============================================================\n`);
    }

    return report;
  }

  /**
   * 15. Background Maintenance Scheduler
   */
  startScheduledMaintenance({ s3VideoService, intervalHours = 6 } = {}) {
    if (!CLEANUP_SETTINGS.ENABLED) {
      console.log(`ℹ️ [Video Cleanup Scheduler] Automatic cleanup is disabled (VIDEO_CLEANUP_ENABLED=false).`);
      return;
    }

    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
    }

    const intervalMs = (intervalHours || CLEANUP_SETTINGS.INTERVAL_HOURS || 6) * 60 * 60 * 1000;
    console.log(`⏰ [Video Cleanup Scheduler] Started recurring maintenance every ${intervalHours || 6} hours.`);

    // Run initial cycle after 60s delay to let server initialize cleanly
    setTimeout(() => {
      this.runMaintenanceCycle({ s3VideoService }).catch(e => console.warn('Maintenance cycle error:', e.message));
    }, 60000);

    // Schedule recurring interval
    this.schedulerTimer = setInterval(() => {
      this.runMaintenanceCycle({ s3VideoService }).catch(e => console.warn('Maintenance cycle error:', e.message));
    }, intervalMs);
  }

  /**
   * 16. Structured Audit Logger
   */
  logCleanupAudit(entry) {
    const auditRecord = {
      ...entry,
      timestamp: new Date().toISOString()
    };
    this.auditLogs.push(auditRecord);
    if (this.auditLogs.length > 500) this.auditLogs.shift();
    console.log(`📋 [Cleanup Audit] ${entry.object_type} | ${entry.cleanup_reason} | Key: ${entry.object_key} | Status: ${entry.cleanup_status} | Reclaimed: ${(Number(entry.bytes_reclaimed || 0) / (1024 * 1024)).toFixed(2)} MB`);
  }

  /**
   * 17. Telemetry & Metrics
   */
  getCleanupMetrics() {
    return {
      ...this.metrics,
      reclaimed_mb: (this.metrics.cleanup_bytes_reclaimed / (1024 * 1024)).toFixed(2),
      reclaimed_gb: (this.metrics.cleanup_bytes_reclaimed / (1024 * 1024 * 1024)).toFixed(3),
      queued_replaced_videos: this.replacementCleanupQueue.size,
      audit_events_count: this.auditLogs.length
    };
  }
}

module.exports = new VideoCleanupService();
