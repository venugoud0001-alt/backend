/**
 * Video Playback Session Manager
 * Level 2 Security: Controls concurrent device playback, heartbeats, and session lifecycles.
 * Production AWS/LMS Video Architecture - Zero Mock Code
 */

const crypto = require('crypto');
const env = require('../../config/env');
const supabase = require('../../config/supabase');

class VideoSessionService {
  constructor() {
    this.maxConcurrentSessions = env.MAX_CONCURRENT_VIDEO_SESSIONS || 2;
    this.sessionTtlSeconds = env.VIDEO_ACCESS_TTL_SECONDS || 900;
    this.heartbeatTimeoutSeconds = 90; // 90s grace period without heartbeat before marked inactive
    
    // Resilient in-memory session registry (indexed by sessionId and userId)
    this.activeSessions = new Map(); // sessionId -> sessionData
    this.userSessions = new Map();   // userId -> Set<sessionId>

    // Periodic reaper for inactive/expired sessions every 60 seconds
    setInterval(() => this.cleanupStaleSessions(), 60000).unref();
  }

  /**
   * Helper to generate a collision-resistant cryptographic session ID
   */
  generateSessionId() {
    return crypto.randomUUID();
  }

  /**
   * Generates a safe SHA-256 hash of IP/User-Agent for device fingerprinting
   */
  hashClientIdentity(ip, userAgent) {
    if (!ip && !userAgent) return 'unknown_device';
    return crypto.createHash('sha256').update(`${ip || ''}_${userAgent || ''}`).digest('hex').slice(0, 16);
  }

  /**
   * Creates or activates a playback session for an authorized user
   */
  async createSession({ userId, courseId, lessonId, clientIp, userAgent, deviceId }) {
    if (!userId || !courseId || !lessonId) {
      throw { statusCode: 400, message: 'Invalid session parameters.' };
    }

    const cleanUserId = String(userId).trim();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.sessionTtlSeconds * 1000);
    const clientFingerprint = deviceId || this.hashClientIdentity(clientIp, userAgent);

    // 1. Clean up any stale sessions for this user first
    this.cleanupUserStaleSessions(cleanUserId);

    // 2. Check active concurrent sessions for this user
    const existingSessionIds = this.userSessions.get(cleanUserId) || new Set();
    const activeSessionsList = Array.from(existingSessionIds)
      .map(id => this.activeSessions.get(id))
      .filter(s => s && s.status === 'ACTIVE' && new Date(s.expiresAt) > now);

    // Check if the user is already playing on the SAME device & lesson (re-use / refresh existing session)
    const sameDeviceSession = activeSessionsList.find(
      s => s.deviceId === clientFingerprint && String(s.lessonId) === String(lessonId)
    );

    if (sameDeviceSession) {
      sameDeviceSession.lastHeartbeat = now.toISOString();
      sameDeviceSession.expiresAt = expiresAt.toISOString();
      this.logSecurityEvent('VIDEO_SESSION_REFRESHED', {
        sessionId: sameDeviceSession.sessionId,
        userId: cleanUserId,
        courseId,
        lessonId
      });
      return sameDeviceSession;
    }

    // If max concurrent limit reached across different devices, terminate the oldest session
    if (activeSessionsList.length >= this.maxConcurrentSessions) {
      // Sort oldest by lastHeartbeat
      activeSessionsList.sort((a, b) => new Date(a.lastHeartbeat) - new Date(b.lastHeartbeat));
      const oldestSession = activeSessionsList[0];
      
      this.terminateSession(oldestSession.sessionId, 'MAX_CONCURRENT_EXCEEDED');
      this.logSecurityEvent('VIDEO_SESSION_LIMIT_REACHED', {
        userId: cleanUserId,
        terminatedSessionId: oldestSession.sessionId,
        maxAllowed: this.maxConcurrentSessions
      });
    }

    // 3. Register New Playback Session
    const sessionId = this.generateSessionId();
    const sessionData = {
      sessionId,
      userId: cleanUserId,
      courseId: String(courseId),
      lessonId: String(lessonId),
      deviceId: clientFingerprint,
      status: 'ACTIVE',
      createdAt: now.toISOString(),
      lastHeartbeat: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      endedAt: null
    };

    this.activeSessions.set(sessionId, sessionData);
    if (!this.userSessions.has(cleanUserId)) {
      this.userSessions.set(cleanUserId, new Set());
    }
    this.userSessions.get(cleanUserId).add(sessionId);

    // Asynchronously log to DB if video_playback_sessions table is available
    this.persistSessionToDb(sessionData).catch(() => {});

    this.logSecurityEvent('VIDEO_SESSION_STARTED', {
      sessionId,
      userId: cleanUserId,
      courseId,
      lessonId,
      expiresAt: sessionData.expiresAt
    });

    return sessionData;
  }

  /**
   * Heartbeats an active playback session
   */
  async heartbeatSession(sessionId, userId) {
    if (!sessionId || !userId) return false;
    const cleanUserId = String(userId).trim();
    const session = this.activeSessions.get(sessionId);

    if (!session || session.userId !== cleanUserId || session.status !== 'ACTIVE') {
      return false;
    }

    const now = new Date();
    // Check if session exceeded TTL
    if (new Date(session.expiresAt) <= now) {
      this.terminateSession(sessionId, 'SESSION_TTL_EXPIRED');
      return false;
    }

    session.lastHeartbeat = now.toISOString();
    return true;
  }

  /**
   * Validates whether a playback session is active and authorized
   */
  validateSession(sessionId, userId, courseId, lessonId) {
    if (!sessionId || !userId) return false;
    const cleanUserId = String(userId).trim();
    const session = this.activeSessions.get(sessionId);

    if (!session || session.userId !== cleanUserId || session.status !== 'ACTIVE') {
      return false;
    }

    const now = new Date();
    // Verify not expired and heartbeat within grace threshold
    if (new Date(session.expiresAt) <= now) {
      this.terminateSession(sessionId, 'SESSION_TTL_EXPIRED');
      return false;
    }

    const lastBeat = new Date(session.lastHeartbeat).getTime();
    if (now.getTime() - lastBeat > this.heartbeatTimeoutSeconds * 1000 * 2) {
      this.terminateSession(sessionId, 'HEARTBEAT_TIMEOUT');
      return false;
    }

    if (courseId && session.courseId !== String(courseId)) return false;
    if (lessonId && session.lessonId !== String(lessonId)) return false;

    return true;
  }

  /**
   * Explicitly ends/stops a playback session (e.g., on pause, navigation, or logout)
   */
  async endSession(sessionId, userId) {
    if (!sessionId) return false;
    const cleanUserId = userId ? String(userId).trim() : null;
    const session = this.activeSessions.get(sessionId);

    if (!session) return false;
    if (cleanUserId && session.userId !== cleanUserId) return false;

    return this.terminateSession(sessionId, 'USER_STOPPED');
  }

  /**
   * Terminates all active sessions for a user (e.g. on application logout)
   */
  async terminateAllUserSessions(userId) {
    if (!userId) return;
    const cleanUserId = String(userId).trim();
    const sessionIds = this.userSessions.get(cleanUserId);
    if (sessionIds) {
      for (const sid of sessionIds) {
        this.terminateSession(sid, 'USER_LOGOUT');
      }
      this.userSessions.delete(cleanUserId);
    }
  }

  /**
   * Internal terminator helper
   */
  terminateSession(sessionId, reason = 'TERMINATED') {
    const session = this.activeSessions.get(sessionId);
    if (!session) return false;

    session.status = 'TERMINATED';
    session.endedAt = new Date().toISOString();
    session.terminationReason = reason;

    // Remove from in-memory index
    this.activeSessions.delete(sessionId);
    const uSessions = this.userSessions.get(session.userId);
    if (uSessions) {
      uSessions.delete(sessionId);
      if (uSessions.size === 0) this.userSessions.delete(session.userId);
    }

    this.logSecurityEvent('VIDEO_SESSION_STOPPED', {
      sessionId,
      userId: session.userId,
      courseId: session.courseId,
      lessonId: session.lessonId,
      reason
    });

    return true;
  }

  /**
   * Cleans up inactive or expired sessions for a specific user
   */
  cleanupUserStaleSessions(userId) {
    const sessionIds = this.userSessions.get(userId);
    if (!sessionIds) return;
    const now = Date.now();

    for (const sid of Array.from(sessionIds)) {
      const session = this.activeSessions.get(sid);
      if (!session) {
        sessionIds.delete(sid);
        continue;
      }
      const lastBeat = new Date(session.lastHeartbeat).getTime();
      const expiresAt = new Date(session.expiresAt).getTime();

      if (now > expiresAt || (now - lastBeat > this.heartbeatTimeoutSeconds * 1000)) {
        this.terminateSession(sid, 'STALE_CLEANUP');
      }
    }
  }

  /**
   * Periodic global garbage collector
   */
  cleanupStaleSessions() {
    const now = Date.now();
    for (const [sid, session] of this.activeSessions.entries()) {
      const lastBeat = new Date(session.lastHeartbeat).getTime();
      const expiresAt = new Date(session.expiresAt).getTime();

      if (now > expiresAt || (now - lastBeat > this.heartbeatTimeoutSeconds * 1000)) {
        this.terminateSession(sid, 'PERIODIC_REAPER');
      }
    }
  }

  /**
   * Persists session state to Supabase table video_playback_sessions if available
   */
  async persistSessionToDb(sessionData) {
    try {
      await supabase.from('video_playback_sessions').insert([{
        session_id: sessionData.sessionId,
        user_id: sessionData.userId,
        course_id: sessionData.courseId,
        lesson_id: sessionData.lessonId,
        device_id: sessionData.deviceId,
        status: sessionData.status,
        created_at: sessionData.createdAt,
        last_heartbeat: sessionData.lastHeartbeat,
        expires_at: sessionData.expiresAt
      }]);
    } catch (e) {
      // Gracefully continue with in-memory session management if table not created
    }
  }

  /**
   * Structured Security Event Logger
   */
  logSecurityEvent(event, data) {
    const timestamp = new Date().toISOString();
    console.log(`🔒 [SECURITY_EVENT:${event}] ${timestamp} | Data:`, JSON.stringify(data));
  }
}

module.exports = new VideoSessionService();
