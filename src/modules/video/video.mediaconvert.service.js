/**
 * AWS MediaConvert Service for HLS Adaptive Transcoding
 * Cost-optimized: H.264 + QVBR + SINGLE_PASS + no acceleration (Basic tier)
 * Resolution-aware: never upscale; never exceed configured production max (1080p)
 */

const { MediaConvertClient, CreateJobCommand, GetJobCommand, CancelJobCommand } = require('@aws-sdk/client-mediaconvert');
const env = require('../../config/env');
const { HLS_OUTPUT_SETTINGS, COMPRESSION_SETTINGS, COST_GUARD_SETTINGS } = require('./video.constants');

class MediaConvertVideoService {
  constructor() {
    this.region = env.AWS_REGION || 'ap-south-1';
    this.endpoint = env.AWS_MEDIACONVERT_ENDPOINT || 'https://mediaconvert.ap-south-1.amazonaws.com';
    this.roleArn = env.AWS_MEDIACONVERT_ROLE_ARN || 'arn:aws:iam::365957110532:role/internnetra-lms-video-backend-role';
    this.outputBucket = env.AWS_S3_BUCKET_OUTPUT || 'internnetra-lms-videos-prod-365957110532-ap-south-1-an';

    this.client = new MediaConvertClient({
      region: this.region,
      endpoint: this.endpoint,
      credentials: {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY
      }
    });
  }

  /**
   * Acceleration PREFERRED/ENABLED forces Professional-tier billing.
   * Only attach AccelerationSettings when explicitly enabled via env.
   */
  buildAccelerationSettings() {
    const mode = String(
      COST_GUARD_SETTINGS.ACCELERATION_MODE ||
      COMPRESSION_SETTINGS.ACCELERATION_MODE ||
      'DISABLED'
    ).toUpperCase();

    if (mode === 'DISABLED' || mode === 'OFF' || mode === 'NONE') {
      return null;
    }

    if (mode === 'PREFERRED' || mode === 'ENABLED') {
      console.warn(
        `⚠️ [MediaConvert] AccelerationMode=${mode} forces PROFESSIONAL tier billing. ` +
        `Set VIDEO_ACCELERATION_MODE=DISABLED for Basic-tier H.264 HLS.`
      );
      return { Mode: mode === 'ENABLED' ? 'ENABLED' : 'PREFERRED' };
    }

    return null;
  }

  /**
   * Resolve renditions from source dimensions. Never upscale. Cap at max height (1080).
   */
  resolveRenditions({ sourceHeight, sourceWidth, requestedOutputs }) {
    if (Array.isArray(requestedOutputs) && requestedOutputs.length > 0) {
      return requestedOutputs;
    }

    const h = Number(sourceHeight) || 0;
    const w = Number(sourceWidth) || 0;
    const maxOut = COST_GUARD_SETTINGS.MAX_OUTPUT_HEIGHT || 1080;

    if (h >= 1080 || (h === 0 && w >= 1920)) {
      return maxOut >= 1080 ? ['720p', '1080p'] : ['720p'];
    }
    if (h >= 720 || w >= 1280) {
      return ['720p'];
    }
    if (h > 0 || w > 0) {
      return ['480p'];
    }
    return ['720p'];
  }

  buildH264Output({ nameModifier, width, height, maxBitrate, qvbrLevel, audioBitrate, codecProfile = 'MAIN' }) {
    return {
      ContainerSettings: { Container: 'M3U8' },
      NameModifier: nameModifier,
      VideoDescription: {
        Width: width,
        Height: height,
        ScalingBehavior: 'DEFAULT',
        CodecSettings: {
          Codec: 'H_264',
          H264Settings: {
            RateControlMode: 'QVBR',
            QvbrSettings: { QvbrQualityLevel: qvbrLevel },
            QualityTuningLevel: COMPRESSION_SETTINGS?.QUALITY_TUNING_LEVEL || 'SINGLE_PASS',
            MaxBitrate: maxBitrate,
            CodecProfile: codecProfile,
            CodecLevel: 'AUTO',
            InterlaceMode: 'PROGRESSIVE',
            FramerateControl: 'INITIALIZE_FROM_SOURCE',
            GopSize: 60,
            GopSizeUnits: 'FRAMES',
            GopClosedCadence: 1,
            NumberBFramesBetweenReferenceFrames: 2,
            SceneChangeDetect: 'TRANSITION_DETECTION'
          }
        }
      },
      AudioDescriptions: [
        {
          CodecSettings: {
            Codec: 'AAC',
            AacSettings: {
              Bitrate: audioBitrate,
              CodingMode: 'CODING_MODE_2_0',
              SampleRate: 48000
            }
          }
        }
      ]
    };
  }

  buildOutputsForRenditions(renditions) {
    const outputs = [];
    for (const r of renditions) {
      if (r === '480p') {
        outputs.push(this.buildH264Output({
          nameModifier: '_480p',
          width: 854,
          height: 480,
          maxBitrate: COMPRESSION_SETTINGS?.MAX_BITRATE_480P || 800000,
          qvbrLevel: COMPRESSION_SETTINGS?.QUALITY_480P_QVBR || 7,
          audioBitrate: COMPRESSION_SETTINGS?.AUDIO_BITRATE_480P || 64000,
          codecProfile: 'MAIN'
        }));
      } else if (r === '720p') {
        outputs.push(this.buildH264Output({
          nameModifier: '_720p',
          width: 1280,
          height: 720,
          maxBitrate: COMPRESSION_SETTINGS?.MAX_BITRATE_720P || 1400000,
          qvbrLevel: COMPRESSION_SETTINGS?.QUALITY_720P_QVBR || 7,
          audioBitrate: COMPRESSION_SETTINGS?.AUDIO_BITRATE_720P || 96000,
          codecProfile: 'MAIN'
        }));
      } else if (r === '1080p') {
        outputs.push(this.buildH264Output({
          nameModifier: '_1080p',
          width: 1920,
          height: 1080,
          maxBitrate: COMPRESSION_SETTINGS?.MAX_BITRATE_1080P || 2800000,
          qvbrLevel: COMPRESSION_SETTINGS?.QUALITY_1080P_QVBR || 8,
          audioBitrate: COMPRESSION_SETTINGS?.AUDIO_BITRATE_1080P || 128000,
          codecProfile: 'HIGH'
        }));
      }
    }
    if (outputs.length === 0) {
      outputs.push(this.buildH264Output({
        nameModifier: '_720p',
        width: 1280,
        height: 720,
        maxBitrate: COMPRESSION_SETTINGS?.MAX_BITRATE_720P || 1400000,
        qvbrLevel: COMPRESSION_SETTINGS?.QUALITY_720P_QVBR || 7,
        audioBitrate: COMPRESSION_SETTINGS?.AUDIO_BITRATE_720P || 96000
      }));
    }
    return outputs;
  }

  /**
   * Generates MediaConvert job parameters for resolution-aware HLS output
   */
  buildJobSettings({ sourceBucket, sourceKey, outputPrefix, sourceHeight, sourceWidth, requestedOutputs }) {
    const baseDest = `s3://${this.outputBucket}/${outputPrefix}`;
    const destination = baseDest.endsWith('/') ? `${baseDest}master` : `${baseDest}/master`;
    const renditions = this.resolveRenditions({ sourceHeight, sourceWidth, requestedOutputs });

    return {
      TimecodeConfig: { Source: 'ZEROBASED' },
      Inputs: [
        {
          FileInput: `s3://${sourceBucket}/${sourceKey}`,
          AudioSelectors: {
            'Audio Selector 1': { DefaultSelection: 'DEFAULT' }
          },
          VideoSelector: {
            ColorSpace: 'FOLLOW',
            Rotate: 'AUTO'
          }
        }
      ],
      OutputGroups: [
        {
          Name: 'HLS Group',
          OutputGroupSettings: {
            Type: 'HLS_GROUP_SETTINGS',
            HlsGroupSettings: {
              SegmentLength: HLS_OUTPUT_SETTINGS.SEGMENT_LENGTH_SECONDS,
              MinSegmentLength: 0,
              Destination: destination,
              DirectoryStructure: 'SINGLE_DIRECTORY',
              SegmentControl: 'SEGMENTED_FILES',
              OutputSelection: 'MANIFESTS_AND_SEGMENTS'
            }
          },
          Outputs: this.buildOutputsForRenditions(renditions)
        }
      ]
    };
  }

  async _sendCreateJob({ jobSettings, userMetadata = {} }) {
    const acceleration = this.buildAccelerationSettings();
    const params = {
      Role: this.roleArn,
      Settings: jobSettings,
      UserMetadata: userMetadata
    };
    if (acceleration) {
      params.AccelerationSettings = acceleration;
    }

    const command = new CreateJobCommand(params);
    const response = await this.client.send(command);
    return {
      jobId: response.Job.Id,
      status: response.Job.Status,
      createdAt: response.Job.CreatedAt,
      accelerationMode: acceleration ? acceleration.Mode : 'DISABLED',
      pricingTierExpected: acceleration ? 'PROFESSIONAL' : 'BASIC'
    };
  }

  /**
   * Submits an adaptive quality-preserving MediaConvert job (HLS ladder)
   */
  async submitAdaptiveJob({
    sourceBucket,
    sourceKey,
    outputPrefix,
    analysis,
    userMetadata = {},
    requestedOutputs,
    sourceHeight,
    sourceWidth
  }) {
    const videoCompressor = require('./video.compressor');
    const height = sourceHeight || analysis?.targetHeight || analysis?.height;
    const width = sourceWidth || analysis?.targetWidth || analysis?.width;
    const outs = requestedOutputs || (analysis?.targetResolution === '1080p'
      ? ['720p', '1080p']
      : analysis?.targetResolution === '480p'
        ? ['480p']
        : analysis?.targetResolution === '720p'
          ? ['720p']
          : undefined);

    const jobSettings = videoCompressor.buildMediaConvertJobSettings({
      sourceBucket,
      sourceKey,
      outputBucket: this.outputBucket,
      outputKeyPrefix: outputPrefix,
      analysis: {
        ...(analysis || {}),
        targetResolution: analysis?.targetResolution || (
          (outs || []).includes('1080p') ? '1080p' : (outs || []).includes('480p') ? '480p' : '720p'
        ),
        // Never enable deinterlace unless explicitly detected — advanced preprocessors are Professional
        isInterlaced: Boolean(analysis?.isInterlaced),
        scanType: analysis?.scanType
      }
    });

    // If compressor produced outputs, still allow explicit requestedOutputs override via rebuild
    if (outs && outs.length > 0) {
      const rebuilt = this.buildJobSettings({
        sourceBucket,
        sourceKey,
        outputPrefix,
        sourceHeight: height,
        sourceWidth: width,
        requestedOutputs: outs
      });
      return this._sendCreateJob({ jobSettings: rebuilt, userMetadata });
    }

    return this._sendCreateJob({ jobSettings, userMetadata });
  }

  /**
   * Submits a standard MediaConvert transcoding job (Mode 2 direct topic)
   */
  async submitTranscodeJob({
    sourceBucket,
    sourceKey,
    outputPrefix,
    userMetadata = {},
    sourceHeight,
    sourceWidth,
    requestedOutputs,
    analysis
  }) {
    const outs = requestedOutputs || this.resolveRenditions({
      sourceHeight: sourceHeight || analysis?.targetHeight,
      sourceWidth: sourceWidth || analysis?.targetWidth,
      requestedOutputs
    });

    const jobSettings = this.buildJobSettings({
      sourceBucket,
      sourceKey,
      outputPrefix,
      sourceHeight,
      sourceWidth,
      requestedOutputs: outs
    });

    return this._sendCreateJob({ jobSettings, userMetadata });
  }

  secondsToTimecode(seconds, fps = 30) {
    const totalSec = Math.max(0, Number(seconds) || 0);
    const hrs = Math.floor(totalSec / 3600);
    const remSec = totalSec % 3600;
    const mins = Math.floor(remSec / 60);
    const secs = Math.floor(remSec % 60);
    const fractional = totalSec - Math.floor(totalSec);
    const frameRate = Math.max(1, Math.round(fps || 30));
    const frames = Math.min(Math.floor(fractional * frameRate), frameRate - 1);

    const pad = (n, w = 2) => String(Math.floor(n)).padStart(w, '0');
    return `${pad(hrs)}:${pad(mins)}:${pad(secs)}:${pad(frames)}`;
  }

  timecodeToSeconds(tc, fps = 30) {
    if (typeof tc === 'number') return Math.max(0, tc);
    if (!tc || typeof tc !== 'string') return 0;
    const clean = tc.trim();
    const parts = clean.split(/[:;.]/);
    const frameRate = Math.max(1, Math.round(fps || 30));
    if (parts.length === 4) {
      const hrs = parseInt(parts[0], 10) || 0;
      const mins = parseInt(parts[1], 10) || 0;
      const secs = parseInt(parts[2], 10) || 0;
      const frames = parseInt(parts[3], 10) || 0;
      return hrs * 3600 + mins * 60 + secs + (frames / frameRate);
    } else if (parts.length === 3) {
      const hrs = parseInt(parts[0], 10) || 0;
      const mins = parseInt(parts[1], 10) || 0;
      const secs = parseFloat(parts[2]) || 0;
      return hrs * 3600 + mins * 60 + secs;
    } else if (parts.length === 2) {
      const mins = parseInt(parts[0], 10) || 0;
      const secs = parseFloat(parts[1]) || 0;
      return mins * 60 + secs;
    }
    return parseFloat(clean) || 0;
  }

  /**
   * Topic clipping settings — resolution-aware, never upscale, max 1080p
   */
  buildTopicClippingJobSettings({
    sourceBucket,
    sourceKey,
    outputPrefix,
    startTimecode,
    endTimecode,
    fps = 30,
    sourceHeight,
    sourceWidth,
    requestedOutputs
  }) {
    const baseDest = `s3://${this.outputBucket}/${outputPrefix}`.replace(/\/+$/, '');
    const destination = `${baseDest}/master`;

    const inputClippings = [];
    if (startTimecode && endTimecode) {
      inputClippings.push({
        StartTimecode: startTimecode,
        EndTimecode: endTimecode
      });
    }

    const renditions = this.resolveRenditions({ sourceHeight, sourceWidth, requestedOutputs });

    return {
      TimecodeConfig: { Source: 'ZEROBASED' },
      Inputs: [
        {
          FileInput: `s3://${sourceBucket}/${sourceKey}`,
          ...(inputClippings.length > 0 ? { InputClippings: inputClippings } : {}),
          TimecodeSource: 'ZEROBASED',
          AudioSelectors: {
            'Audio Selector 1': { DefaultSelection: 'DEFAULT' }
          },
          VideoSelector: {
            ColorSpace: 'FOLLOW',
            Rotate: 'AUTO'
          }
        }
      ],
      OutputGroups: [
        {
          Name: 'HLS Group',
          OutputGroupSettings: {
            Type: 'HLS_GROUP_SETTINGS',
            HlsGroupSettings: {
              SegmentLength: HLS_OUTPUT_SETTINGS.SEGMENT_LENGTH_SECONDS || 6,
              MinSegmentLength: 0,
              Destination: destination,
              DirectoryStructure: 'SINGLE_DIRECTORY',
              SegmentControl: 'SEGMENTED_FILES',
              OutputSelection: 'MANIFESTS_AND_SEGMENTS'
            }
          },
          Outputs: this.buildOutputsForRenditions(renditions)
        }
      ]
    };
  }

  async submitTopicClippingJob({
    sourceBucket,
    sourceKey,
    outputPrefix,
    startTimeSeconds,
    endTimeSeconds,
    startTimecode,
    endTimecode,
    fps = 30,
    sourceHeight,
    sourceWidth,
    requestedOutputs,
    userMetadata = {}
  }) {
    const finalStartTc = startTimecode || this.secondsToTimecode(startTimeSeconds, fps);
    const finalEndTc = endTimecode || this.secondsToTimecode(endTimeSeconds, fps);

    const jobSettings = this.buildTopicClippingJobSettings({
      sourceBucket,
      sourceKey,
      outputPrefix,
      startTimecode: finalStartTc,
      endTimecode: finalEndTc,
      fps,
      sourceHeight,
      sourceWidth,
      requestedOutputs
    });

    const result = await this._sendCreateJob({
      jobSettings,
      userMetadata: {
        ...userMetadata,
        startTimecode: String(finalStartTc),
        endTimecode: String(finalEndTc)
      }
    });

    return {
      ...result,
      startTimecode: finalStartTc,
      endTimecode: finalEndTc,
      sourceHeight: Number(sourceHeight) || null,
      sourceWidth: Number(sourceWidth) || null,
      requestedOutputs: this.resolveRenditions({ sourceHeight, sourceWidth, requestedOutputs })
    };
  }

  async getJobStatus(jobId) {
    try {
      const command = new GetJobCommand({ Id: jobId });
      const response = await this.client.send(command);
      return {
        status: response.Job.Status,
        jobPercentComplete: response.Job.JobPercentComplete ?? (response.Job.Status === 'COMPLETE' ? 100 : 0),
        currentPhase: response.Job.CurrentPhase || 'TRANSCODING',
        errorMessage: response.Job.ErrorMessage || null
      };
    } catch (err) {
      console.error(`[AWS MediaConvert Error] getJobStatus failed for ${jobId}:`, err.message);
      return {
        status: 'UNKNOWN',
        jobPercentComplete: 0,
        errorMessage: err.message
      };
    }
  }

  async cancelJob(jobId) {
    if (!jobId) {
      return { canceled: false, reason: 'NO_JOB_ID' };
    }

    try {
      const jobStatus = await this.getJobStatus(jobId);
      if (['COMPLETE', 'ERROR', 'CANCELED'].includes(jobStatus.status)) {
        console.log(`ℹ️ [AWS MediaConvert] Job ${jobId} is already in terminal state '${jobStatus.status}'. Cancellation skipped.`);
        return {
          canceled: false,
          alreadyTerminal: true,
          status: jobStatus.status
        };
      }

      const command = new CancelJobCommand({ Id: jobId });
      await this.client.send(command);
      console.log(`🛑 [AWS MediaConvert] Successfully cancelled job ${jobId}`);
      return {
        canceled: true,
        jobId,
        previousStatus: jobStatus.status
      };
    } catch (err) {
      const msg = err.message || '';
      if (msg.includes('Job is in COMPLETE state') || msg.includes('Job is in ERROR state') || msg.includes('Job is in CANCELED state')) {
        console.log(`ℹ️ [AWS MediaConvert] Job ${jobId} reached terminal state during cancel request: ${msg}`);
        return { canceled: false, alreadyTerminal: true, error: msg };
      }

      console.warn(`⚠️ [AWS MediaConvert Cancel Notice] Could not cancel job ${jobId}:`, msg);
      return { canceled: false, error: msg };
    }
  }
}

module.exports = new MediaConvertVideoService();
