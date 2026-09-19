/**
 * Centralized MediaConvert job idempotency, atomic claims, cost guards, and audit.
 * ALL CreateJob submissions must go through acquireProcessingClaim → createJob → attachJobId.
 */

const crypto = require('crypto');
const { supabase } = require('../../config/supabase');
const env = require('../../config/env');
const {
  PROCESSING_PROFILES,
  PROCESSING_VERSION,
  TRIGGER_SOURCES,
  COST_GUARD_SETTINGS,
  COMPRESSION_SETTINGS
} = require('./video.constants');

/** In-process mutex for same-instance races before DB commit */
const localClaims = new Map();

class MediaConvertJobGuardService {
  getEnvironment() {
    const explicit = String(process.env.VIDEO_COST_GUARD_ENV || '').toLowerCase();
    if (explicit) return explicit;
    const nodeEnv = String(env.NODE_ENV || process.env.NODE_ENV || 'development').toLowerCase();
    return nodeEnv;
  }

  isDevLikeEnvironment() {
    const e = this.getEnvironment();
    return e === 'development' || e === 'staging' || e === 'test' || e === 'dev';
  }

  buildProcessingIdentity({
    processingProfile,
    videoId = null,
    uploadId = null,
    topicId = null,
    sourceKey = null,
    processingVersion = PROCESSING_VERSION
  }) {
    const profile = String(processingProfile || '').trim();
    if (!Object.values(PROCESSING_PROFILES).includes(profile)) {
      throw new Error(`Invalid processing profile: ${profile}`);
    }

    const parts = [profile, `v${processingVersion || PROCESSING_VERSION}`];

    if (profile === PROCESSING_PROFILES.FULL_MODULE_HLS) {
      parts.push(`video:${videoId || 'unknown'}`);
      parts.push(`upload:${uploadId || sourceKey || 'none'}`);
    } else if (profile === PROCESSING_PROFILES.DIRECT_TOPIC_HLS) {
      parts.push(`topic:${topicId || 'unknown'}`);
      parts.push(`video:${videoId || 'unknown'}`);
      parts.push(`upload:${uploadId || sourceKey || 'none'}`);
    } else if (profile === PROCESSING_PROFILES.TOPIC_CLIPPING) {
      parts.push(`topic:${topicId || 'unknown'}`);
      parts.push(`source:${videoId || 'unknown'}`);
      parts.push(`upload:${uploadId || sourceKey || 'none'}`);
    }

    return parts.join('|');
  }

  /**
   * Resolve requested HLS outputs from source dimensions (never upscale).
   * >=1080p → 720p+1080p; >=720p & <1080p → 720p; <720p → 480p (no upscale)
   */
  resolveRequestedOutputs({ sourceWidth, sourceHeight, forceDevProfile = false }) {
    if (forceDevProfile || (this.isDevLikeEnvironment() && COST_GUARD_SETTINGS.DEV_720P_ONLY)) {
      return ['720p'];
    }

    const h = Number(sourceHeight) || 0;
    const w = Number(sourceWidth) || 0;
    const maxDim = Math.max(h, w);

    if (h >= 1080 || (h === 0 && w >= 1920) || maxDim >= 1920 && h >= 1080) {
      return ['720p', '1080p'];
    }
    if (h >= 720 || w >= 1280) {
      return ['720p'];
    }
    if (h > 0 || w > 0) {
      return ['480p'];
    }
    // Unknown dimensions: prefer single HD ladder rung to avoid accidental dual-output spend,
    // but do not invent 1080p (would risk upscale). Callers should probe when possible.
    return ['720p'];
  }

  /**
   * DEV/STAGING hard guards: duration, daily job count, daily minutes.
   */
  async enforceCostGuards({
    sourceDurationSeconds,
    requestedOutputs,
    adminOverride = false,
    triggerSource
  }) {
    if (!this.isDevLikeEnvironment()) {
      return { allowed: true };
    }

    if (adminOverride === true || adminOverride === 'true') {
      console.warn(`⚠️ [COST_GUARD] Admin override accepted for DEV MediaConvert (trigger=${triggerSource})`);
      return { allowed: true, overridden: true };
    }

    const duration = Number(sourceDurationSeconds) || 0;
    const maxDevSeconds = COST_GUARD_SETTINGS.DEV_MAX_DURATION_SECONDS;

    if (duration > maxDevSeconds) {
      const minutes = (duration / 60).toFixed(1);
      const err = {
        statusCode: 400,
        code: 'DEV_DURATION_LIMIT',
        message: `DEV/STAGING MediaConvert blocked: source duration ${minutes} min exceeds ${maxDevSeconds / 60} min limit. Pass adminOverride=true for an explicit one-off.`
      };
      await this.logAudit({
        eventType: 'DEV_DURATION_BLOCKED',
        triggerSource,
        sourceDurationSeconds: duration,
        requestedOutputs,
        details: { maxDevSeconds }
      });
      throw err;
    }

    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    try {
      const { count: jobCount } = await supabase
        .from('mediaconvert_job_audit')
        .select('id', { count: 'exact', head: true })
        .eq('event_type', 'MEDIACONVERT_CREATEJOB')
        .eq('environment', this.getEnvironment())
        .gte('created_at', todayStart.toISOString());

      if (COST_GUARD_SETTINGS.DEV_DAILY_JOB_LIMIT > 0 && (jobCount || 0) >= COST_GUARD_SETTINGS.DEV_DAILY_JOB_LIMIT) {
        throw {
          statusCode: 429,
          code: 'DEV_DAILY_JOB_LIMIT',
          message: `DEV daily MediaConvert job limit (${COST_GUARD_SETTINGS.DEV_DAILY_JOB_LIMIT}) reached.`
        };
      }

      const { data: minuteRows } = await supabase
        .from('mediaconvert_job_audit')
        .select('source_duration_seconds, requested_outputs')
        .eq('event_type', 'MEDIACONVERT_CREATEJOB')
        .eq('environment', this.getEnvironment())
        .gte('created_at', todayStart.toISOString());

      let usedMinutes = 0;
      for (const row of minuteRows || []) {
        const outs = Array.isArray(row.requested_outputs) ? row.requested_outputs.length : 1;
        usedMinutes += ((Number(row.source_duration_seconds) || 0) / 60) * outs;
      }
      const nextMinutes = usedMinutes + ((duration / 60) * (requestedOutputs?.length || 1));
      if (COST_GUARD_SETTINGS.DEV_DAILY_MINUTE_LIMIT > 0 && nextMinutes > COST_GUARD_SETTINGS.DEV_DAILY_MINUTE_LIMIT) {
        throw {
          statusCode: 429,
          code: 'DEV_DAILY_MINUTE_LIMIT',
          message: `DEV daily MediaConvert minute limit (${COST_GUARD_SETTINGS.DEV_DAILY_MINUTE_LIMIT}) would be exceeded.`
        };
      }
    } catch (e) {
      if (e.code === 'DEV_DAILY_JOB_LIMIT' || e.code === 'DEV_DAILY_MINUTE_LIMIT' || e.statusCode) throw e;
      // Audit table may not exist yet — do not block production-like runs on schema lag
      console.warn(`⚠️ [COST_GUARD] Daily limit check skipped: ${e.message}`);
    }

    return { allowed: true };
  }

  async logAudit(payload) {
    const row = {
      event_type: payload.eventType,
      video_id: payload.videoId || null,
      upload_id: payload.uploadId ? String(payload.uploadId) : null,
      course_id: payload.courseId || null,
      module_id: payload.moduleId ? String(payload.moduleId) : null,
      topic_id: payload.topicId ? String(payload.topicId) : null,
      processing_identity: payload.processingIdentity || null,
      processing_profile: payload.processingProfile || null,
      processing_version: payload.processingVersion || PROCESSING_VERSION,
      source_duration_seconds: payload.sourceDurationSeconds ?? null,
      source_width: payload.sourceWidth ?? null,
      source_height: payload.sourceHeight ?? null,
      requested_outputs: payload.requestedOutputs || [],
      environment: payload.environment || this.getEnvironment(),
      trigger_source: payload.triggerSource || TRIGGER_SOURCES.OTHER,
      mediaconvert_job_id: payload.mediaconvertJobId || null,
      existing_job_id: payload.existingJobId || null,
      claim_id: payload.claimId || null,
      details: payload.details || {},
      created_at: new Date().toISOString()
    };

    console.log(`📋 [${row.event_type}] identity=${row.processing_identity || 'n/a'} job=${row.mediaconvert_job_id || row.existing_job_id || 'n/a'} trigger=${row.trigger_source}`);

    try {
      await supabase.from('mediaconvert_job_audit').insert(row);
    } catch (e) {
      console.warn(`⚠️ [JOB_GUARD] Audit insert failed: ${e.message}`);
    }
  }

  /**
   * Validate existing READY HLS outputs under prefix (DB READY + master + renditions + segments).
   */
  async validateExistingHlsOutput({
    status,
    hlsMasterUrl,
    hlsPrefix,
    requestedOutputs = ['720p'],
    s3VideoService,
    outputBucket
  }) {
    if (status !== 'READY' || !hlsMasterUrl) {
      return { valid: false, reason: 'NOT_READY' };
    }
    if (!s3VideoService || !hlsPrefix) {
      return { valid: Boolean(hlsMasterUrl), reason: hlsMasterUrl ? 'DB_READY_URL_ONLY' : 'NO_PREFIX' };
    }

    const bucket = outputBucket || env.AWS_S3_BUCKET_OUTPUT;
    const prefix = String(hlsPrefix).replace(/\/+$/, '') + '/';
    const masterKey = `${prefix}master.m3u8`.replace(/\/\/+/g, '/');
    const master = await s3VideoService.verifyObjectExists(bucket, masterKey).catch(() => ({ exists: false }));
    if (!master.exists) {
      return { valid: false, reason: 'MISSING_MASTER' };
    }

    for (const rendition of requestedOutputs) {
      const candidates = [
        `${prefix}master_${rendition}.m3u8`,
        `${prefix}_${rendition}.m3u8`
      ].map(k => k.replace(/\/\/+/g, '/'));
      let found = false;
      for (const key of candidates) {
        const check = await s3VideoService.verifyObjectExists(bucket, key).catch(() => ({ exists: false }));
        if (check.exists) {
          found = true;
          break;
        }
      }
      if (!found) {
        return { valid: false, reason: `MISSING_${rendition.toUpperCase()}` };
      }
    }

    const segments = await s3VideoService.countHlsSegments({ bucket, prefix }).catch(() => ({ segmentCount: 0 }));
    if (!segments || (segments.segmentCount || 0) <= 0) {
      return { valid: false, reason: 'MISSING_SEGMENTS' };
    }

    return { valid: true, reason: 'VALID_HLS' };
  }

  _localTryClaim(processingIdentity, token) {
    const existing = localClaims.get(processingIdentity);
    if (existing && existing.expiresAt > Date.now()) {
      return { acquired: false, existing };
    }
    const entry = { token, expiresAt: Date.now() + COST_GUARD_SETTINGS.CLAIM_TTL_MS };
    localClaims.set(processingIdentity, entry);
    return { acquired: true, existing: entry };
  }

  _localRelease(processingIdentity, token) {
    const existing = localClaims.get(processingIdentity);
    if (existing && existing.token === token) {
      localClaims.delete(processingIdentity);
    }
  }

  /**
   * Atomically claim the right to call MediaConvert CreateJob for a processing identity.
   * Returns { shouldCreateJob, claim, reuse } — only claim owner may CreateJob.
   */
  async acquireProcessingClaim({
    processingProfile,
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
    s3VideoService = null,
    isRetry = false
  }) {
    const processingVersion = PROCESSING_VERSION;
    const processingIdentity = this.buildProcessingIdentity({
      processingProfile,
      videoId,
      uploadId,
      topicId,
      sourceKey,
      processingVersion
    });

    const forceDevProfile = this.isDevLikeEnvironment() && COST_GUARD_SETTINGS.DEV_720P_ONLY;
    const requestedOutputs = this.resolveRequestedOutputs({
      sourceWidth,
      sourceHeight,
      forceDevProfile
    });

    // READY + valid output → reuse (unless explicit confirmed reprocess)
    const status = existingTopic?.processing_status || existingRecord?.status;
    const hlsMasterUrl = existingTopic?.hls_master_url || existingRecord?.hls_master_url;
    const hlsPrefix = existingTopic?.hls_prefix || existingRecord?.hls_prefix;
    const existingJobId = existingTopic?.mediaconvert_job_id || existingRecord?.mediaconvert_job_id;

    if (status === 'READY' && !forceReprocess) {
      const validation = await this.validateExistingHlsOutput({
        status: 'READY',
        hlsMasterUrl,
        hlsPrefix,
        requestedOutputs,
        s3VideoService,
        outputBucket: env.AWS_S3_BUCKET_OUTPUT
      });
      if (validation.valid) {
        await this.logAudit({
          eventType: 'DUPLICATE_MEDIACONVERT_JOB_BLOCKED',
          videoId,
          uploadId,
          courseId,
          moduleId,
          topicId,
          processingIdentity,
          processingProfile,
          processingVersion,
          sourceDurationSeconds,
          sourceWidth,
          sourceHeight,
          requestedOutputs,
          triggerSource,
          existingJobId,
          details: { reason: 'READY_OUTPUT_REUSED', validation }
        });
        return {
          shouldCreateJob: false,
          reuse: true,
          reason: 'READY_OUTPUT_REUSED',
          existingJobId,
          processingIdentity,
          processingProfile,
          requestedOutputs,
          hlsMasterUrl
        };
      }
    }

    if (status === 'READY' && forceReprocess && !confirmReprocess) {
      throw {
        statusCode: 400,
        code: 'REPROCESS_CONFIRMATION_REQUIRED',
        message: 'Manual reprocess of READY video requires confirmReprocess=true.'
      };
    }

    // Active PROCESSING / QUEUED with job → reuse
    const activeStatuses = ['PROCESSING', 'QUEUED', 'CLAIMED', 'SUBMITTED'];
    if (!isRetry && !forceReprocess && existingJobId && activeStatuses.includes(status)) {
      const startedAt = existingTopic?.processing_started_at || existingRecord?.processing_started_at;
      const startedMs = startedAt ? new Date(startedAt).getTime() : Date.now();
      const elapsedMin = (Date.now() - startedMs) / 60000;
      if (elapsedMin < (COMPRESSION_SETTINGS.JOB_TIMEOUT_MINUTES || 60)) {
        await this.logAudit({
          eventType: 'DUPLICATE_MEDIACONVERT_JOB_BLOCKED',
          videoId,
          uploadId,
          courseId,
          moduleId,
          topicId,
          processingIdentity,
          processingProfile,
          processingVersion,
          sourceDurationSeconds,
          sourceWidth,
          sourceHeight,
          requestedOutputs,
          triggerSource,
          existingJobId,
          details: { reason: 'ACTIVE_JOB_REUSED', status, elapsedMin }
        });
        return {
          shouldCreateJob: false,
          reuse: true,
          reason: 'ACTIVE_JOB_REUSED',
          existingJobId,
          processingIdentity,
          processingProfile,
          requestedOutputs
        };
      }
    }

    await this.enforceCostGuards({
      sourceDurationSeconds,
      requestedOutputs,
      adminOverride,
      triggerSource
    });

    const claimOwnerToken = crypto.randomUUID();
    const local = this._localTryClaim(processingIdentity, claimOwnerToken);
    if (!local.acquired) {
      await this.logAudit({
        eventType: 'DUPLICATE_MEDIACONVERT_JOB_BLOCKED',
        videoId,
        uploadId,
        courseId,
        moduleId,
        topicId,
        processingIdentity,
        processingProfile,
        processingVersion,
        sourceDurationSeconds,
        sourceWidth,
        sourceHeight,
        requestedOutputs,
        triggerSource,
        existingJobId: existingJobId || null,
        details: { reason: 'LOCAL_MUTEX_HELD' }
      });
      return {
        shouldCreateJob: false,
        reuse: true,
        reason: 'LOCAL_MUTEX_HELD',
        existingJobId,
        processingIdentity,
        processingProfile,
        requestedOutputs
      };
    }

    // Retry path: release prior FAILED claim for this identity so a new active claim can insert
    if (isRetry || forceReprocess || status === 'FAILED') {
      try {
        await supabase
          .from('mediaconvert_job_claims')
          .update({
            claim_status: 'RELEASED',
            updated_at: new Date().toISOString()
          })
          .eq('processing_identity', processingIdentity)
          .in('claim_status', ['FAILED', 'CLAIMED', 'SUBMITTED']);
      } catch (e) {
        console.warn(`⚠️ [JOB_GUARD] Failed claim release before retry: ${e.message}`);
      }
      // For retries, also clear local mutex held by stale token after release intent
    }

    const claimRow = {
      processing_identity: processingIdentity,
      processing_profile: processingProfile,
      processing_version: processingVersion,
      claim_status: 'CLAIMED',
      claim_owner_token: claimOwnerToken,
      video_id: videoId || null,
      upload_id: uploadId ? String(uploadId) : null,
      course_id: courseId || null,
      module_id: moduleId ? String(moduleId) : null,
      topic_id: topicId ? String(topicId) : null,
      source_key: sourceKey || null,
      trigger_source: triggerSource,
      environment: this.getEnvironment(),
      source_duration_seconds: sourceDurationSeconds,
      source_width: sourceWidth,
      source_height: sourceHeight,
      requested_outputs: requestedOutputs,
      claimed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    let claimId = null;
    try {
      const { data, error } = await supabase
        .from('mediaconvert_job_claims')
        .insert(claimRow)
        .select('id, claim_owner_token, processing_identity, mediaconvert_job_id, claim_status')
        .maybeSingle();

      if (error) {
        // Unique partial index collision → another worker owns the claim
        if (String(error.code) === '23505' || /duplicate|unique/i.test(error.message || '')) {
          const { data: existingClaim } = await supabase
            .from('mediaconvert_job_claims')
            .select('*')
            .eq('processing_identity', processingIdentity)
            .in('claim_status', ['CLAIMED', 'SUBMITTED'])
            .order('claimed_at', { ascending: false })
            .limit(1)
            .maybeSingle();

          this._localRelease(processingIdentity, claimOwnerToken);

          await this.logAudit({
            eventType: 'DUPLICATE_MEDIACONVERT_JOB_BLOCKED',
            videoId,
            uploadId,
            courseId,
            moduleId,
            topicId,
            processingIdentity,
            processingProfile,
            processingVersion,
            sourceDurationSeconds,
            sourceWidth,
            sourceHeight,
            requestedOutputs,
            triggerSource,
            existingJobId: existingClaim?.mediaconvert_job_id || existingJobId,
            details: { reason: 'DB_CLAIM_CONFLICT', existingClaimStatus: existingClaim?.claim_status }
          });

          return {
            shouldCreateJob: false,
            reuse: true,
            reason: 'DB_CLAIM_CONFLICT',
            existingJobId: existingClaim?.mediaconvert_job_id || existingJobId,
            processingIdentity,
            processingProfile,
            requestedOutputs,
            claim: existingClaim
          };
        }
        console.warn(`⚠️ [JOB_GUARD] Claim insert failed (continuing with local claim): ${error.message}`);
      } else {
        claimId = data?.id || null;
      }
    } catch (e) {
      console.warn(`⚠️ [JOB_GUARD] Claim table unavailable (local claim only): ${e.message}`);
    }

    // Atomic topic row claim (queue race)
    if (topicId && processingProfile === PROCESSING_PROFILES.TOPIC_CLIPPING) {
      const topicClaimed = await this.atomicClaimTopicRow({
        topicId,
        claimOwnerToken,
        processingIdentity,
        processingProfile,
        processingVersion,
        isRetry
      });
      if (!topicClaimed.acquired) {
        this._localRelease(processingIdentity, claimOwnerToken);
        if (claimId) {
          await this.releaseClaim({ claimId, claimOwnerToken, processingIdentity, errorMessage: 'TOPIC_ROW_CLAIM_LOST' });
        }
        await this.logAudit({
          eventType: 'DUPLICATE_MEDIACONVERT_JOB_BLOCKED',
          videoId,
          topicId,
          courseId,
          moduleId,
          processingIdentity,
          processingProfile,
          processingVersion,
          triggerSource,
          existingJobId: topicClaimed.existingJobId || existingJobId,
          details: { reason: 'TOPIC_ROW_CLAIM_LOST', status: topicClaimed.status }
        });
        return {
          shouldCreateJob: false,
          reuse: true,
          reason: 'TOPIC_ROW_CLAIM_LOST',
          existingJobId: topicClaimed.existingJobId || existingJobId,
          processingIdentity,
          processingProfile,
          requestedOutputs
        };
      }
    }

    // Atomic lesson_videos row claim for full-module / direct-topic
    if (videoId && processingProfile !== PROCESSING_PROFILES.TOPIC_CLIPPING) {
      await this.atomicClaimVideoRow({
        videoId,
        claimOwnerToken,
        processingIdentity,
        processingProfile,
        processingVersion,
        isRetry,
        forceReprocess
      });
    }

    return {
      shouldCreateJob: true,
      reuse: false,
      claim: {
        id: claimId,
        claimOwnerToken,
        processingIdentity,
        processingProfile,
        processingVersion,
        requestedOutputs,
        videoId,
        uploadId,
        courseId,
        moduleId,
        topicId,
        sourceDurationSeconds,
        sourceWidth,
        sourceHeight,
        triggerSource,
        environment: this.getEnvironment()
      },
      processingIdentity,
      processingProfile,
      requestedOutputs
    };
  }

  /**
   * Atomically move topic QUEUED/FAILED → PROCESSING only if we win the claim.
   */
  async atomicClaimTopicRow({
    topicId,
    claimOwnerToken,
    processingIdentity,
    processingProfile,
    processingVersion,
    isRetry = false
  }) {
    try {
      // Read current
      const { data: current } = await supabase
        .from('topics')
        .select('id, processing_status, mediaconvert_job_id, processing_claim_token')
        .eq('id', topicId)
        .maybeSingle();

      if (!current) {
        return { acquired: true }; // memory-only topics still allowed
      }

      if (current.processing_status === 'PROCESSING' && current.mediaconvert_job_id && !isRetry) {
        return {
          acquired: false,
          status: current.processing_status,
          existingJobId: current.mediaconvert_job_id
        };
      }

      if (current.processing_status === 'READY' && !isRetry) {
        return {
          acquired: false,
          status: 'READY',
          existingJobId: current.mediaconvert_job_id
        };
      }

      const allowedFrom = isRetry
        ? ['FAILED', 'QUEUED', 'PROCESSING', 'DRAFT']
        : ['QUEUED', 'FAILED', 'DRAFT'];

      if (!allowedFrom.includes(current.processing_status)) {
        return {
          acquired: false,
          status: current.processing_status,
          existingJobId: current.mediaconvert_job_id
        };
      }

      const { data: updated, error } = await supabase
        .from('topics')
        .update({
          processing_status: 'PROCESSING',
          processing_claim_token: claimOwnerToken,
          processing_identity: processingIdentity,
          processing_profile: processingProfile,
          processing_version: processingVersion,
          processing_started_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('id', topicId)
        .eq('processing_status', current.processing_status)
        .select('id, processing_status, mediaconvert_job_id')
        .maybeSingle();

      if (error || !updated) {
        const { data: again } = await supabase
          .from('topics')
          .select('processing_status, mediaconvert_job_id')
          .eq('id', topicId)
          .maybeSingle();
        return {
          acquired: false,
          status: again?.processing_status,
          existingJobId: again?.mediaconvert_job_id
        };
      }

      return { acquired: true, status: 'PROCESSING' };
    } catch (e) {
      console.warn(`⚠️ [JOB_GUARD] Topic atomic claim fallback: ${e.message}`);
      return { acquired: true };
    }
  }

  async atomicClaimVideoRow({
    videoId,
    claimOwnerToken,
    processingIdentity,
    processingProfile,
    processingVersion,
    isRetry = false,
    forceReprocess = false
  }) {
    try {
      const { data: current } = await supabase
        .from('lesson_videos')
        .select('id, status, mediaconvert_job_id')
        .eq('id', videoId)
        .maybeSingle();

      if (!current) return { acquired: true };

      if (current.status === 'PROCESSING' && current.mediaconvert_job_id && !isRetry && !forceReprocess) {
        return { acquired: false, existingJobId: current.mediaconvert_job_id };
      }

      await supabase
        .from('lesson_videos')
        .update({
          status: 'PROCESSING',
          processing_claim_token: claimOwnerToken,
          processing_identity: processingIdentity,
          processing_profile: processingProfile,
          processing_version: processingVersion,
          processing_started_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('id', videoId);

      return { acquired: true };
    } catch (e) {
      console.warn(`⚠️ [JOB_GUARD] Video atomic claim fallback: ${e.message}`);
      return { acquired: true };
    }
  }

  async attachJobId(claim, mediaconvertJobId) {
    if (!claim) return;

    await this.logAudit({
      eventType: 'MEDIACONVERT_CREATEJOB',
      videoId: claim.videoId,
      uploadId: claim.uploadId,
      courseId: claim.courseId,
      moduleId: claim.moduleId,
      topicId: claim.topicId,
      processingIdentity: claim.processingIdentity,
      processingProfile: claim.processingProfile,
      processingVersion: claim.processingVersion,
      sourceDurationSeconds: claim.sourceDurationSeconds,
      sourceWidth: claim.sourceWidth,
      sourceHeight: claim.sourceHeight,
      requestedOutputs: claim.requestedOutputs,
      environment: claim.environment,
      triggerSource: claim.triggerSource,
      mediaconvertJobId,
      claimId: claim.id,
      details: {
        accelerationMode: COST_GUARD_SETTINGS.ACCELERATION_MODE,
        qualityTuningLevel: COMPRESSION_SETTINGS.QUALITY_TUNING_LEVEL,
        pricingTierExpected: 'BASIC'
      }
    });

    if (claim.id) {
      try {
        await supabase
          .from('mediaconvert_job_claims')
          .update({
            claim_status: 'SUBMITTED',
            mediaconvert_job_id: mediaconvertJobId,
            submitted_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          })
          .eq('id', claim.id)
          .eq('claim_owner_token', claim.claimOwnerToken);
      } catch (e) {
        console.warn(`⚠️ [JOB_GUARD] attachJobId claim update failed: ${e.message}`);
      }
    }
  }

  async releaseClaim({ claimId, claimOwnerToken, processingIdentity, errorMessage }) {
    if (processingIdentity && claimOwnerToken) {
      this._localRelease(processingIdentity, claimOwnerToken);
    }
    if (!claimId) return;
    try {
      await supabase
        .from('mediaconvert_job_claims')
        .update({
          claim_status: 'FAILED',
          error_message: errorMessage || 'CreateJob failed',
          updated_at: new Date().toISOString()
        })
        .eq('id', claimId)
        .eq('claim_owner_token', claimOwnerToken);
    } catch (e) {
      console.warn(`⚠️ [JOB_GUARD] releaseClaim failed: ${e.message}`);
    }
  }

  async markClaimReady({ processingIdentity, mediaconvertJobId }) {
    if (!processingIdentity && !mediaconvertJobId) return;
    try {
      let q = supabase.from('mediaconvert_job_claims').update({
        claim_status: 'READY',
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
      if (mediaconvertJobId) q = q.eq('mediaconvert_job_id', mediaconvertJobId);
      else q = q.eq('processing_identity', processingIdentity).in('claim_status', ['CLAIMED', 'SUBMITTED']);
      await q;
    } catch (e) {
      console.warn(`⚠️ [JOB_GUARD] markClaimReady failed: ${e.message}`);
    }
  }

  async markClaimFailed({ mediaconvertJobId, errorMessage }) {
    if (!mediaconvertJobId) return;
    try {
      await supabase
        .from('mediaconvert_job_claims')
        .update({
          claim_status: 'FAILED',
          error_message: errorMessage || 'Job failed',
          updated_at: new Date().toISOString()
        })
        .eq('mediaconvert_job_id', mediaconvertJobId);
    } catch (e) {
      console.warn(`⚠️ [JOB_GUARD] markClaimFailed failed: ${e.message}`);
    }
  }
}

module.exports = new MediaConvertJobGuardService();
