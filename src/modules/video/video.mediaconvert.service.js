/**
 * AWS MediaConvert Service for HLS Adaptive Transcoding (720p & 1080p only)
 * 100% Production AWS SDK - No Mock Mode
 */

const { MediaConvertClient, CreateJobCommand, GetJobCommand } = require('@aws-sdk/client-mediaconvert');
const env = require('../../config/env');
const { HLS_OUTPUT_SETTINGS } = require('./video.constants');

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
    const destination = `s3://${this.outputBucket}/${outputPrefix}`;

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
                    MaxBitrate: 1400000,
                    QvbrQualityLevel: 7,
                    CodecProfile: 'MAIN',
                    CodecLevel: 'AUTO',
                    InterlaceMode: 'PROGRESSIVE'
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
                    MaxBitrate: 2600000,
                    QvbrQualityLevel: 8,
                    CodecProfile: 'HIGH',
                    CodecLevel: 'AUTO',
                    InterlaceMode: 'PROGRESSIVE'
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
   * Submits a real MediaConvert transcoding job
   */
  async submitTranscodeJob({ sourceBucket, sourceKey, outputPrefix, userMetadata = {} }) {
    const jobSettings = this.buildJobSettings({ sourceBucket, sourceKey, outputPrefix });
    const command = new CreateJobCommand({
      Role: this.roleArn,
      Settings: jobSettings,
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
   * Fetches the current job status directly from MediaConvert API
   */
  async getJobStatus(jobId) {
    try {
      const command = new GetJobCommand({ Id: jobId });
      const response = await this.client.send(command);
      return {
        status: response.Job.Status, // 'SUBMITTED' | 'PROGRESSING' | 'COMPLETE' | 'CANCELED' | 'ERROR'
        errorMessage: response.Job.ErrorMessage || null
      };
    } catch (err) {
      console.error(`[AWS MediaConvert Error] getJobStatus failed for ${jobId}:`, err.message);
      return {
        status: 'ERROR',
        errorMessage: err.message
      };
    }
  }
}

module.exports = new MediaConvertVideoService();
