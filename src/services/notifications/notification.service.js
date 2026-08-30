/**
 * Notification Service Placeholder
 */

class NotificationService {
  async sendNotification({ userId, title, message, channel = 'IN_APP' }) {
    console.log(`[NotificationService] Dispatching ${channel} notification to user ${userId}: "${title}"`);
    return { success: true, timestamp: new Date().toISOString() };
  }
}

module.exports = new NotificationService();
