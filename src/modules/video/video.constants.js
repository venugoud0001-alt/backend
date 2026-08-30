/**
 * Video Pipeline Constants & Status Definitions
 */

const VIDEO_STATUS = {
  UPLOADING: 'UPLOADING',
  UPLOADED: 'UPLOADED',
  PROCESSING: 'PROCESSING',
  READY: 'READY',
  FAILED: 'FAILED'
};

const ALLOWED_VIDEO_MIME_TYPES = [
  'video/mp4',
  'video/quicktime', // .mov
  'video/x-m4v',
  'video/webm'
];

const MAX_VIDEO_FILE_SIZE_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB max upload

const HLS_OUTPUT_SETTINGS = {
  SEGMENT_LENGTH_SECONDS: 6,
  RENDITIONS: [
    {
      name: '720p',
      width: 1280,
      height: 720,
      videoBitrate: 1200000, // 1.2 Mbps
      maxBitrate: 1400000,
      qvbrQualityLevel: 7,
      audioBitrate: 96000 // 96 kbps
    },
    {
      name: '1080p',
      width: 1920,
      height: 1080,
      videoBitrate: 2400000, // 2.4 Mbps
      maxBitrate: 2600000,
      qvbrQualityLevel: 8,
      audioBitrate: 128000 // 128 kbps
    }
  ]
};

module.exports = {
  VIDEO_STATUS,
  ALLOWED_VIDEO_MIME_TYPES,
  MAX_VIDEO_FILE_SIZE_BYTES,
  HLS_OUTPUT_SETTINGS
};
