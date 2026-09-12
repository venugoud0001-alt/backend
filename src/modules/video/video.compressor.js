/**
 * Adaptive, Quality-Preserving Video Compression Engine
 * Production Quality-First Architecture for LMS
 * 
 * Rules:
 * 1. Never compress to a fixed target file size.
 * 2. Never downgrade primary resolution (1080p -> 1080p, 720p -> 720p).
 * 3. Preserve native aspect ratio, frame rate, fine slide text, and audio fidelity.
 * 4. Authoritative size comparison: If optimized >= original, retain original and discard output.
 */

const { COMPRESSION_SETTINGS } = require('./video.constants');

class VideoCompressor {
  /**
   * 1. Multi-Signal Source Analyzer
   * Evaluates if source is a reasonable candidate for adaptive encoding
   */
  analyzeVideoSource({ fileSizeBytes, durationSeconds, width, height, videoCodec, audioCodec, fps, bitrateKbps, fileName }) {
    const size = Number(fileSizeBytes) || 0;
    const duration = Number(durationSeconds) || 0;
    
    // Determine resolution tier (Resolution-aware: <720p -> 480p, 720p -> 720p, >=1080p -> 1080p)
    let targetResolution = '1080p';
    let targetWidth = 1920;
    let targetHeight = 1080;

    const sourceHeight = Number(height) || 1080;
    const sourceWidth = Number(width) || 1920;

    if (sourceHeight <= 480 || sourceWidth <= 854) {
      targetResolution = '480p';
      targetWidth = 854;
      targetHeight = 480;
    } else if (sourceHeight <= 720 || sourceWidth <= 1280) {
      targetResolution = '720p';
      targetWidth = 1280;
      targetHeight = 720;
    } else {
      targetResolution = '1080p';
      targetWidth = 1920;
      targetHeight = 1080;
    }

    // Estimate bitrate if missing from metadata
    let effectiveBitrateKbps = Number(bitrateKbps) || 0;
    if (!effectiveBitrateKbps && size > 0 && duration > 0) {
      effectiveBitrateKbps = Math.round((size * 8) / (duration * 1000));
    }

    const cleanCodec = String(videoCodec || '').toLowerCase();
    const isH264 = cleanCodec.includes('h264') || cleanCodec.includes('avc') || cleanCodec.includes('mp4');
    
    // Multi-signal analysis: Identify obviously efficient sources that should NOT be re-encoded
    let isAlreadyEfficient = false;
    let reason = 'Source candidate for adaptive quality-based optimization.';

    if (isH264 && effectiveBitrateKbps > 0) {
      if (targetResolution === '1080p' && effectiveBitrateKbps <= 1600) {
        isAlreadyEfficient = true;
        reason = `Source is already highly efficient 1080p H.264 (~${effectiveBitrateKbps} kbps). Re-encoding skipped to preserve master quality.`;
      } else if (targetResolution === '720p' && effectiveBitrateKbps <= 800) {
        isAlreadyEfficient = true;
        reason = `Source is already highly efficient 720p H.264 (~${effectiveBitrateKbps} kbps). Re-encoding skipped to preserve master quality.`;
      } else if (targetResolution === '480p' && effectiveBitrateKbps <= 500) {
        isAlreadyEfficient = true;
        reason = `Source is already highly efficient 480p H.264 (~${effectiveBitrateKbps} kbps). Re-encoding skipped to preserve master quality.`;
      }
    }

    // Check if compression feature is enabled
    if (!COMPRESSION_SETTINGS.ENABLED) {
      return {
        action: 'SKIP_COMPRESSION',
        targetResolution,
        targetWidth,
        targetHeight,
        effectiveBitrateKbps,
        reason: 'Video compression is globally disabled in configuration.'
      };
    }

    if (isAlreadyEfficient) {
      return {
        action: 'SKIP_COMPRESSION',
        targetResolution,
        targetWidth,
        targetHeight,
        effectiveBitrateKbps,
        reason
      };
    }

    return {
      action: 'ADAPTIVE_COMPRESSION',
      targetResolution,
      targetWidth,
      targetHeight,
      effectiveBitrateKbps,
      reason: `Eligible for resolution-aware adaptive QVBR encoding at ${targetResolution}.`
    };
  }

  /**
   * 2. Build MediaConvert Job Settings for HLS Adaptive Ladder
   * Strictly avoids upscaling:
   * - < 720p: 480p only
   * - = 720p: 720p only
   * - >= 1080p: 720p + 1080p
   */
  buildMediaConvertJobSettings({ sourceBucket, sourceKey, outputBucket, outputKeyPrefix, analysis }) {
    const is1080p = analysis.targetResolution === '1080p';
    const is480p = analysis.targetResolution === '480p';

    const baseDest = `s3://${outputBucket}/${outputKeyPrefix}`.replace(/\/+$/, '');
    const destination = `${baseDest}/master`;

    const isInterlaced = Boolean(analysis && (analysis.isInterlaced || analysis.scanType === 'interlaced'));
    const videoPreprocessors = isInterlaced ? {
      Deinterlacer: {
        Algorithm: 'INTERPOLATE',
        Mode: 'DEINTERLACE',
        Control: 'NORMAL'
      }
    } : undefined;

    const outputs = [];

    // CASE 1: Low-resolution source (< 720p) -> Generate 480p native rendition only
    if (is480p) {
      outputs.push({
        ContainerSettings: {
          Container: 'M3U8'
        },
        NameModifier: '_480p',
        VideoDescription: {
          Width: 854,
          Height: 480,
          ScalingBehavior: 'DEFAULT',
          ...(videoPreprocessors ? { VideoPreprocessors: videoPreprocessors } : {}),
          CodecSettings: {
            Codec: 'H_264',
            H264Settings: {
              RateControlMode: 'QVBR',
              QvbrSettings: {
                QvbrQualityLevel: COMPRESSION_SETTINGS.QUALITY_480P_QVBR || 7
              },
              QualityTuningLevel: COMPRESSION_SETTINGS.QUALITY_TUNING_LEVEL || 'SINGLE_PASS',
              MaxBitrate: COMPRESSION_SETTINGS.MAX_BITRATE_480P || 800000,
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
                Bitrate: COMPRESSION_SETTINGS.AUDIO_BITRATE_480P || 64000,
                CodingMode: 'CODING_MODE_2_0',
                SampleRate: 48000,
                Specification: 'MPEG4'
              }
            }
          }
        ]
      });
    } else {
      // CASE 2: 720p or 1080p source -> Always include 720p base rendition
      outputs.push({
        ContainerSettings: {
          Container: 'M3U8'
        },
        NameModifier: '_720p',
        VideoDescription: {
          Width: 1280,
          Height: 720,
          ScalingBehavior: 'DEFAULT',
          ...(videoPreprocessors ? { VideoPreprocessors: videoPreprocessors } : {}),
          CodecSettings: {
            Codec: 'H_264',
            H264Settings: {
              RateControlMode: 'QVBR',
              QvbrSettings: {
                QvbrQualityLevel: COMPRESSION_SETTINGS.QUALITY_720P_QVBR || 7
              },
              QualityTuningLevel: COMPRESSION_SETTINGS.QUALITY_TUNING_LEVEL || 'SINGLE_PASS',
              MaxBitrate: COMPRESSION_SETTINGS.MAX_BITRATE_720P || 1400000,
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
                Bitrate: COMPRESSION_SETTINGS.AUDIO_BITRATE_720P || 96000,
                CodingMode: 'CODING_MODE_2_0',
                SampleRate: 48000,
                Specification: 'MPEG4'
              }
            }
          }
        ]
      });

      // CASE 3: 1080p+ source -> Add 1080p full HD rendition
      if (is1080p) {
        outputs.push({
          ContainerSettings: {
            Container: 'M3U8'
          },
          NameModifier: '_1080p',
          VideoDescription: {
            Width: 1920,
            Height: 1080,
            ScalingBehavior: 'DEFAULT',
            ...(videoPreprocessors ? { VideoPreprocessors: videoPreprocessors } : {}),
            CodecSettings: {
              Codec: 'H_264',
              H264Settings: {
                RateControlMode: 'QVBR',
                QvbrSettings: {
                  QvbrQualityLevel: COMPRESSION_SETTINGS.QUALITY_1080P_QVBR || 8
                },
                QualityTuningLevel: COMPRESSION_SETTINGS.QUALITY_TUNING_LEVEL || 'SINGLE_PASS',
                MaxBitrate: COMPRESSION_SETTINGS.MAX_BITRATE_1080P || 2800000,
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
                  Bitrate: COMPRESSION_SETTINGS.AUDIO_BITRATE_1080P || 128000,
                  CodingMode: 'CODING_MODE_2_0',
                  SampleRate: 48000,
                  Specification: 'MPEG4'
                }
              }
            }
          ]
        });
      }
    }

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
              SegmentLength: 6,
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
   * 3. Authoritative Post-Encoding Size & Benefit Evaluator
   * If optimized output is larger than or equal to source, discards output and keeps source
   */
  evaluateCompressionResult({ originalSizeBytes, optimizedSizeBytes, minAcceptableSavingsPercent }) {
    const orig = Number(originalSizeBytes) || 0;
    const opt = Number(optimizedSizeBytes) || 0;
    const minSavings = Number(minAcceptableSavingsPercent) || COMPRESSION_SETTINGS.MIN_ACCEPTABLE_SAVINGS_PERCENT || 0;

    if (orig <= 0 || opt <= 0) {
      return {
        result: 'COMPRESSION_FAILED',
        compressionPercentage: 0,
        isBeneficial: false,
        useOptimized: false,
        reason: 'Invalid file size metrics recorded.'
      };
    }

    // CASE 2: Output is larger than or equal to original
    if (opt >= orig) {
      return {
        result: 'COMPRESSION_NOT_BENEFICIAL',
        compressionPercentage: 0,
        isBeneficial: false,
        useOptimized: false,
        reason: `Optimized file (${(opt / (1024 * 1024)).toFixed(1)} MB) was larger or equal to original (${(orig / (1024 * 1024)).toFixed(1)} MB). Original retained.`
      };
    }

    const savingsPercent = Math.round(((orig - opt) / orig) * 1000) / 10;

    // Check against post-encoding minimum savings threshold
    if (minSavings > 0 && savingsPercent < minSavings) {
      return {
        result: 'COMPRESSION_NOT_BENEFICIAL',
        compressionPercentage: savingsPercent,
        isBeneficial: false,
        useOptimized: false,
        reason: `Savings (${savingsPercent}%) was below minimum configured threshold (${minSavings}%). Original retained.`
      };
    }

    // CASE 1: Successful beneficial compression
    return {
      result: 'COMPRESSION_APPLIED',
      compressionPercentage: savingsPercent,
      isBeneficial: true,
      useOptimized: true,
      reason: `Successfully optimized with ${savingsPercent}% storage reduction.`
    };
  }

  /**
   * 4. Comprehensive Technical Output Validation Checks
   * Verifies: S3 existence, resolution match, FPS preservation, aspect ratio preservation,
   * video/audio codecs, audio presence, and duration tolerance.
   */
  validateTechnicalIntegrity({ sourceInfo = {}, outputInfo = {}, durationToleranceSeconds = 2.0, fpsTolerance = 0.5, aspectTolerance = 0.03 }) {
    const errors = [];

    // 1. S3 existence & non-empty content
    if (!outputInfo || !outputInfo.contentLength || outputInfo.contentLength <= 0) {
      errors.push('Output S3 object is empty or does not exist.');
    }

    // 2. Resolution check (Strict preservation: 1080p -> 1080p, 720p -> 720p)
    const outHeight = Number(outputInfo.height) || 0;
    const outWidth = Number(outputInfo.width) || 0;

    if (sourceInfo.targetResolution === '1080p' && outHeight > 0 && outHeight < 1000) {
      errors.push(`Resolution downgrade detected: Expected 1080p but output height is ${outHeight}px.`);
    }
    if (sourceInfo.targetResolution === '720p' && outHeight > 0 && outHeight < 700) {
      errors.push(`Resolution downgrade detected: Expected 720p but output height is ${outHeight}px.`);
    }

    // 3. Aspect Ratio Validation (Strict aspect preservation)
    const srcWidth = Number(sourceInfo.width) || (sourceInfo.targetResolution === '1080p' ? 1920 : 1280);
    const srcHeight = Number(sourceInfo.height) || (sourceInfo.targetResolution === '1080p' ? 1080 : 720);

    if (srcWidth > 0 && srcHeight > 0 && outWidth > 0 && outHeight > 0) {
      const srcRatio = srcWidth / srcHeight;
      const outRatio = outWidth / outHeight;
      const ratioDiff = Math.abs(srcRatio - outRatio);

      if (ratioDiff > aspectTolerance) {
        errors.push(`Aspect ratio mismatch: Source ratio was ${srcRatio.toFixed(3)} (${srcWidth}x${srcHeight}) but output is ${outRatio.toFixed(3)} (${outWidth}x${outHeight}).`);
      }
    }

    // 4. Frame Rate (FPS) Validation (Strict FPS preservation with fractional tolerance)
    const srcFps = Number(sourceInfo.fps) || 0;
    const outFps = Number(outputInfo.fps) || 0;

    if (srcFps > 0 && outFps > 0) {
      // Normalize common fractional frame rates (29.97 -> 30, 23.976 -> 24, 59.94 -> 60)
      const fpsDiff = Math.abs(srcFps - outFps);
      if (fpsDiff > fpsTolerance) {
        errors.push(`Frame rate mismatch: Source FPS was ${srcFps} but output FPS is ${outFps} (Deviation ${fpsDiff.toFixed(2)} exceeds ${fpsTolerance}).`);
      }
    }

    // 5. Codec & Container Validation
    if (outputInfo.videoCodec) {
      const vCodec = String(outputInfo.videoCodec).toLowerCase();
      const isValidH264 = vCodec.includes('h264') || vCodec.includes('avc') || vCodec.includes('mp4');
      if (!isValidH264) {
        errors.push(`Invalid video codec: Expected H.264 but found '${outputInfo.videoCodec}'.`);
      }
    }

    // 6. Audio Stream Validation
    const srcHasAudio = sourceInfo.hasAudio !== false && sourceInfo.audioCodec !== 'none';
    if (srcHasAudio && outputInfo.hasAudio === false) {
      errors.push('Audio stream missing: Source contains audio but output has no audio stream.');
    }

    if (outputInfo.audioCodec && outputInfo.audioCodec !== 'none') {
      const aCodec = String(outputInfo.audioCodec).toLowerCase();
      const isValidAac = aCodec.includes('aac') || aCodec.includes('mp4a');
      if (!isValidAac) {
        errors.push(`Invalid audio codec: Expected AAC but found '${outputInfo.audioCodec}'.`);
      }
    }

    // 7. Duration tolerance check
    const srcDur = Number(sourceInfo.durationSeconds) || 0;
    const outDur = Number(outputInfo.durationSeconds) || 0;

    if (srcDur > 0 && outDur > 0) {
      const diff = Math.abs(srcDur - outDur);
      if (diff > durationToleranceSeconds) {
        errors.push(`Duration deviation (${diff.toFixed(2)}s) exceeds tolerance limit (${durationToleranceSeconds}s).`);
      }
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }

  /**
   * 5. Duplicate Job Protection
   * Checks if video record already has an active, non-timed-out MediaConvert job
   */
  isJobAlreadyActive(record, timeoutMinutes = 60) {
    if (!record || record.status !== 'PROCESSING' || !record.mediaconvert_job_id) {
      return false;
    }

    const startedAt = record.processing_started_at ? new Date(record.processing_started_at).getTime() : 0;
    const elapsedMinutes = (Date.now() - startedAt) / (1000 * 60);

    // If active and within timeout window, prevent duplicate submission
    return elapsedMinutes < timeoutMinutes;
  }
}

module.exports = new VideoCompressor();
