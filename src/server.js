/**
 * InternNetra Express Backend HTTP Server
 */

const app = require('./app');
const env = require('./config/env');

const PORT = env.PORT || 5000;

const HOST = '0.0.0.0';

const server = app.listen(PORT, HOST, () => {
  console.log(`🚀 InternNetra NLS Modular Backend running on http://${HOST}:${PORT}`);
  
  try {
    // Start Automatic Video Storage Cleanup Scheduler (Non-blocking background worker)
    const videoCleanupService = require('./modules/video/video.cleanup.service');
    const { CLEANUP_SETTINGS } = require('./modules/video/video.constants');
    videoCleanupService.startScheduledMaintenance({
      intervalHours: CLEANUP_SETTINGS.INTERVAL_HOURS || 6
    });

    // ARCH-08: Recover active transcoding jobs on backend startup
    const videoService = require('./modules/video/video.service');
    videoService.recoverActiveTranscodeJobs().catch(rErr => {
      console.warn('⚠️ [Transcode Job Recovery Notice]:', rErr.message);
    });

    // Start Installment Payment & Course Access Control Scheduler
    const installmentService = require('./services/installment.service');
    installmentService.startScheduledMaintenance({
      intervalMinutes: 30
    });
  } catch (err) {
    console.warn('⚠️ [Video / Installment Scheduler Startup Notice]:', err.message);
  }
});

module.exports = server;
