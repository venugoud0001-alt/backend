/**
 * AWS MediaConvert Service for HLS Adaptive Transcoding (720p & 1080p only)
 * 100% Production AWS SDK - No Mock Mode
 */

const { MediaConvertClient, CreateJobCommand, GetJobCommand, CancelJobCommand } = require('@aws-sdk/client-mediaconvert');
const env = require('../../config/env');
const { HLS_OUTPUT_SETTINGS, COMPRESSION_SETTINGS } = require('./video.constants');

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
   * Generates MediaConvert job parameters for 720p & 1080p HLS output
   */
  buildJobSettings({ sourceBucket, sourceKey, outputPrefix }) {
    const baseDest = `s3://${this.outputBucket}/${outputPrefix}`;
    const destination = baseDest.endsWith('/') ? `${baseDest}master` : `${baseDest}/master`;

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
          Outputs: [
            // 720p HLS
            {
              ContainerSettings: {
                Container: 'M3U8'
              },
              NameModifier: '_720p',
              VideoDescription: {
                Width: 1280,
                Height: 720,
                ScalingBehavior: 'DEFAULT',
                CodecSettings: {
                  Codec: 'H_264',
                  H264Settings: {
                    RateControlMode: 'QVBR',
                    QvbrSettings: {
                      QvbrQualityLevel: 7
                    },
                    QualityTuningLevel: COMPRESSION_SETTINGS?.QUALITY_TUNING_LEVEL || 'SINGLE_PASS',
                    MaxBitrate: 1400000,
                    CodecProfile: 'MAIN',
                    CodecLevel: 'AUTO',
                    InterlaceMode: 'PROGRESSIVE',
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
                      Bitrate: 96000,
                      CodingMode: 'CODING_MODE_2_0',
                      SampleRate: 48000
                    }
                  }
                }
              ]
            },
            // 1080p HLS
            {
              ContainerSettings: {
                Container: 'M3U8'
              },
              NameModifier: '_1080p',
              VideoDescription: {
                Width: 1920,
                Height: 1080,
                ScalingBehavior: 'DEFAULT',
                CodecSettings: {
                  Codec: 'H_264',
                  H264Settings: {
                    RateControlMode: 'QVBR',
                    QualityTuningLevel: COMPRESSION_SETTINGS?.QUALITY_TUNING_LEVEL || 'SINGLE_PASS',
                    MaxBitrate: 2600000,
                    QvbrQualityLevel: 8,
                    CodecProfile: 'HIGH',
                    CodecLevel: 'AUTO',
                    InterlaceMode: 'PROGRESSIVE',
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
                      Bitrate: 128000,
                      CodingMode: 'CODING_MODE_2_0',
                      SampleRate: 48000
                    }
                  }
                }
              ]
            }
          ]
        }
      ]
    };
  }

  /**
   * Submits an adaptive quality-preserving MediaConvert job (Progressive FastStart MP4)
   */
  async submitAdaptiveJob({ sourceBucket, sourceKey, outputPrefix, analysis, userMetadata = {} }) {
    const videoCompressor = require('./video.compressor');
    const jobSettings = videoCompressor.buildMediaConvertJobSettings({
      sourceBucket,
      sourceKey,
      outputBucket: this.outputBucket,
      outputKeyPrefix: outputPrefix,
      analysis: analysis || { targetResolution: '1080p' }
    });

    const command = new CreateJobCommand({
      Role: this.roleArn,
      Settings: jobSettings,
      AccelerationSettings: {
        Mode: 'PREFERRED'
      },
      UserMetadata: userMetadata
    });

    const response = await this.client.send(command);
    return {
      jobId: response.Job.Id,
      status: response.Job.Status,
      createdAt: response.Job.CreatedAt
    };
  }

  /**
   * Submits a standard MediaConvert transcoding job
   */
  async submitTranscodeJob({ sourceBucket, sourceKey, outputPrefix, userMetadata = {} }) {
    const jobSettings = this.buildJobSettings({ sourceBucket, sourceKey, outputPrefix });
    const command = new CreateJobCommand({
      Role: this.roleArn,
      Settings: jobSettings,
      AccelerationSettings: {
        Mode: 'PREFERRED'
      },
      UserMetadata: userMetadata
    });

    const response = await this.client.send(command);
    return {
      jobId: response.Job.Id,
      status: response.Job.Status,
      createdAt: response.Job.CreatedAt
    };
  }

  /**
   * Helper: Formats seconds to MediaConvert canonical timecode (HH:MM:SS:FF)
   */
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

  /**
   * Helper: Parses timecode string or number to seconds
   */
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
   * Generates MediaConvert job parameters using InputClippings for Topic splitting
   */
  buildTopicClippingJobSettings({ sourceBucket, sourceKey, outputPrefix, startTimecode, endTimecode, fps = 30, sourceHeight = 1080, sourceWidth = 1920 }) {
    const baseDest = `s3://${this.outputBucket}/${outputPrefix}`.replace(/\/+$/, '');
    const destination = `${baseDest}/master`;

    const inputClippings = [];
    if (startTimecode && endTimecode) {
      inputClippings.push({
        StartTimecode: startTimecode,
        EndTimecode: endTimecode
      });
    }

    // Source Resolution Awareness & Anti-Upscale Gate:
    // CASE 1: Source is <= 720p (e.g. 1280x720) -> Generate 720p ONLY (NO 1080p upscale)
    // CASE 2: Source is >= 1080p (e.g. 1920x1080 or 4K) -> Generate 720p + 1080p (Max 1080p, no 4K)
    const effectiveHeight = Number(sourceHeight) || 1080;
    const include1080p = effectiveHeight > 720;

    const outputs = [
      // 720p HLS Rendition (Always included as baseline)
      {
        ContainerSettings: { Container: 'M3U8' },
        NameModifier: '_720p',
        VideoDescription: {
          Width: 1280,
          Height: 720,
          ScalingBehavior: 'DEFAULT',
          CodecSettings: {
            Codec: 'H_264',
            H264Settings: {
              RateControlMode: 'QVBR',
              QvbrSettings: { QvbrQualityLevel: COMPRESSION_SETTINGS?.QUALITY_720P_QVBR || 7 },
              QualityTuningLevel: COMPRESSION_SETTINGS?.QUALITY_TUNING_LEVEL || 'SINGLE_PASS',
              MaxBitrate: COMPRESSION_SETTINGS?.MAX_BITRATE_720P || 1400000,
              CodecProfile: 'MAIN',
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
                Bitrate: COMPRESSION_SETTINGS?.AUDIO_BITRATE_720P || 96000,
                CodingMode: 'CODING_MODE_2_0',
                SampleRate: 48000
              }
            }
          }
        ]
      }
    ];

    if (include1080p) {
      outputs.push({
        // 1080p HLS Rendition
        ContainerSettings: { Container: 'M3U8' },
        NameModifier: '_1080p',
        VideoDescription: {
          Width: 1920,
          Height: 1080,
          ScalingBehavior: 'DEFAULT',
          CodecSettings: {
            Codec: 'H_264',
            H264Settings: {
              RateControlMode: 'QVBR',
              QualityTuningLevel: COMPRESSION_SETTINGS?.QUALITY_TUNING_LEVEL || 'SINGLE_PASS',
              MaxBitrate: COMPRESSION_SETTINGS?.MAX_BITRATE_1080P || 2800000,
              QvbrSettings: { QvbrQualityLevel: COMPRESSION_SETTINGS?.QUALITY_1080P_QVBR || 8 },
              CodecProfile: 'HIGH',
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
                Bitrate: COMPRESSION_SETTINGS?.AUDIO_BITRATE_1080P || 128000,
                CodingMode: 'CODING_MODE_2_0',
                SampleRate: 48000
              }
            }
          }
        ]
      });
    }

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
          Outputs: outputs
        }
      ]
    };
  }

  /**
   * Submits a topic-level MediaConvert job with InputClippings
   */
  async submitTopicClippingJob({
    sourceBucket,
    sourceKey,
    outputPrefix,
    startTimeSeconds,
    endTimeSeconds,
    startTimecode,
    endTimecode,
    fps = 30,
    sourceHeight = 1080,
    sourceWidth = 1920,
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
      sourceWidth
    });

    const command = new CreateJobCommand({
      Role: this.roleArn,
      Settings: jobSettings,
      AccelerationSettings: {
        Mode: COMPRESSION_SETTINGS.ACCELERATION_MODE || 'PREFERRED'
      },
      UserMetadata: {
        ...userMetadata,
        startTimecode: String(finalStartTc),
        endTimecode: String(finalEndTc)
      }
    });

    const response = await this.client.send(command);
    return {
      jobId: response.Job.Id,
      status: response.Job.Status,
      startTimecode: finalStartTc,
      endTimecode: finalEndTc,
      sourceHeight,
      sourceWidth,
      createdAt: response.Job.CreatedAt
    };
  }

  /**
   * Fetches the current job status directly from MediaConvert API
   */
  async getJobStatus(jobId) {
    try {
      const command = new GetJobCommand({ Id: jobId });
      const response = await this.client.send(command);
      return {
        status: response.Job.Status, // 'SUBMITTED' | 'PROGRESSING' | 'COMPLETE' | 'CANCELED' | 'ERROR'
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

  /**
   * Cancels an active MediaConvert job (SUBMITTED or PROGRESSING)
   * Safely handles race conditions if the job is already COMPLETE, ERROR, or CANCELED
   */
  async cancelJob(jobId) {
    if (!jobId) {
      return { canceled: false, reason: 'NO_JOB_ID' };
    }

    try {
      // 1. Check current job status
      const jobStatus = await this.getJobStatus(jobId);
      if (['COMPLETE', 'ERROR', 'CANCELED'].includes(jobStatus.status)) {
        console.log(`ℹ️ [AWS MediaConvert] Job ${jobId} is already in terminal state '${jobStatus.status}'. Cancellation skipped.`);
        return {
          canceled: false,
          alreadyTerminal: true,
          status: jobStatus.status
        };
      }

      // 2. Invoke CancelJobCommand
      const command = new CancelJobCommand({ Id: jobId });
      await this.client.send(command);
      console.log(`🛑 [AWS MediaConvert] Successfully cancelled job ${jobId}`);
      return {
        canceled: true,
        jobId,
        previousStatus: jobStatus.status
      };
    } catch (err) {
      // Handle race condition where job finished/errored right as cancel command arrived
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

