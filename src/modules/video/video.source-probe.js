/**
 * Lightweight source probe for resolution/duration before MediaConvert.
 * Uses stored metadata first; optionally ffprobe if installed on the host.
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

class VideoSourceProbe {
  /**
   * Resolve best-known source dimensions from record + optional probe.
   */
  async resolveSourceMetrics(record = {}, { localFilePath = null } = {}) {
    let width = Number(record.source_width || record.width) || 0;
    let height = Number(record.source_height || record.height) || 0;
    let fps = Number(record.source_fps || record.fps) || 0;
    let durationSeconds = Number(record.duration_seconds || record.source_duration_seconds) || 0;
    let videoCodec = record.source_video_codec || record.video_codec || null;

    if ((!width || !height) && localFilePath) {
      const probed = await this.ffprobeFile(localFilePath).catch(() => null);
      if (probed) {
        width = width || probed.width;
        height = height || probed.height;
        fps = fps || probed.fps;
        durationSeconds = durationSeconds || probed.durationSeconds;
        videoCodec = videoCodec || probed.videoCodec;
      }
    }

    return {
      width: width || null,
      height: height || null,
      fps: fps || null,
      durationSeconds: durationSeconds || null,
      videoCodec,
      probed: Boolean(width && height)
    };
  }

  async ffprobeFile(filePath) {
    try {
      const { stdout } = await execFileAsync('ffprobe', [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_streams',
        '-show_format',
        filePath
      ], { timeout: 15000 });

      const data = JSON.parse(stdout || '{}');
      const videoStream = (data.streams || []).find(s => s.codec_type === 'video') || {};
      let fps = 0;
      if (videoStream.avg_frame_rate && videoStream.avg_frame_rate.includes('/')) {
        const [a, b] = videoStream.avg_frame_rate.split('/').map(Number);
        if (b) fps = a / b;
      }
      return {
        width: Number(videoStream.width) || 0,
        height: Number(videoStream.height) || 0,
        fps: fps || 0,
        durationSeconds: Number(data.format?.duration || videoStream.duration) || 0,
        videoCodec: videoStream.codec_name || null
      };
    } catch (e) {
      return null;
    }
  }
}

module.exports = new VideoSourceProbe();
