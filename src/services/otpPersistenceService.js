/**
 * Persistent OTP Storage Service (ARCH-03 Fix)
 * Provides robust multi-instance and restart-safe OTP persistence.
 * Dual-layer: Supabase PostgreSQL (primary) + Atomic Local Storage (persistent fallback).
 */

const fs = require('fs');
const path = require('path');
const { supabase } = require('../config/supabase');

const DATA_DIR = path.join(__dirname, '../../data');
const OTP_FILE_PATH = path.join(DATA_DIR, 'otp_store.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {
    console.warn('⚠️ Could not create data directory for OTP persistence:', e.message);
  }
}

class OtpPersistenceService {
  constructor() {
    this._memoryCache = new Map();
    this._loadFromDisk();
  }

  /**
   * Load existing persistent state from disk into memory cache
   */
  _loadFromDisk() {
    try {
      if (fs.existsSync(OTP_FILE_PATH)) {
        const raw = fs.readFileSync(OTP_FILE_PATH, 'utf8');
        const data = JSON.parse(raw);
        const now = Date.now();
        if (data && typeof data === 'object') {
          for (const [key, record] of Object.entries(data)) {
            // Only keep non-expired records
            if (record && record.expiresAt && record.expiresAt > now) {
              this._memoryCache.set(key, record);
            }
          }
        }
      }
    } catch (err) {
      console.warn('⚠️ [OTP Persistence] Notice loading disk cache:', err.message);
    }
  }

  /**
   * Atomically save in-memory cache to disk
   */
  _saveToDisk() {
    try {
      const exportObj = {};
      const now = Date.now();
      for (const [key, record] of this._memoryCache.entries()) {
        if (record && record.expiresAt && record.expiresAt > now) {
          exportObj[key] = record;
        }
      }
      const tempPath = `${OTP_FILE_PATH}.${Date.now()}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(exportObj, null, 2), 'utf8');
      fs.renameSync(tempPath, OTP_FILE_PATH);
    } catch (err) {
      console.warn('⚠️ [OTP Persistence] Notice saving disk cache:', err.message);
    }
  }

  /**
   * Store a new OTP challenge
   */
  async setOtp(email, { otpHash, expiresAt, fullName = 'Student', maxAttempts = 5 }) {
    const key = String(email).toLowerCase().trim();
    const record = {
      email: key,
      otpHash,
      expiresAt: Number(expiresAt),
      attempts: 0,
      maxAttempts: Number(maxAttempts) || 5,
      fullName,
      used: false,
      createdAt: Date.now()
    };

    // 1. Save to local persistent memory + disk
    this._memoryCache.set(key, record);
    this._saveToDisk();

    // 2. Persist to Supabase if otp_verifications table exists
    try {
      await supabase.from('otp_verifications').upsert({
        email: key,
        otp_hash: otpHash,
        expires_at: new Date(expiresAt).toISOString(),
        attempts: 0,
        max_attempts: maxAttempts,
        used: false,
        full_name: fullName,
        created_at: new Date().toISOString()
      }, { onConflict: 'email' });
    } catch (dbErr) {
      // Handled by disk persistence
    }

    return record;
  }

  /**
   * Retrieve active OTP record for an email
   */
  async getOtp(email) {
    const key = String(email).toLowerCase().trim();

    // 1. Check Supabase table first for multi-instance sync
    try {
      const { data, error } = await supabase
        .from('otp_verifications')
        .select('*')
        .eq('email', key)
        .maybeSingle();

      if (!error && data) {
        const expiresAt = new Date(data.expires_at).getTime();
        const record = {
          email: data.email,
          otpHash: data.otp_hash,
          expiresAt,
          attempts: Number(data.attempts) || 0,
          maxAttempts: Number(data.max_attempts) || 5,
          fullName: data.full_name,
          used: Boolean(data.used),
          createdAt: new Date(data.created_at).getTime()
        };
        // Update local memory cache with DB truth
        this._memoryCache.set(key, record);
        return record;
      }
    } catch (dbErr) {
      // Fallback to local cache
    }

    // 2. Fallback to local cache & disk
    const cached = this._memoryCache.get(key);
    if (!cached) {
      this._loadFromDisk();
      return this._memoryCache.get(key) || null;
    }

    return cached;
  }

  /**
   * Record a failed verification attempt
   */
  async incrementAttempts(email) {
    const key = String(email).toLowerCase().trim();
    const record = await this.getOtp(key);
    if (!record) return 0;

    record.attempts = (record.attempts || 0) + 1;
    this._memoryCache.set(key, record);
    this._saveToDisk();

    try {
      await supabase
        .from('otp_verifications')
        .update({ attempts: record.attempts, updated_at: new Date().toISOString() })
        .eq('email', key);
    } catch (dbErr) {}

    return record.attempts;
  }

  /**
   * Mark OTP as consumed / single-use burn
   */
  async burnOtp(email) {
    const key = String(email).toLowerCase().trim();
    const existing = this._memoryCache.get(key);
    if (existing) {
      existing.used = true;
      this._memoryCache.set(key, existing);
    }
    this._saveToDisk();

    try {
      await supabase
        .from('otp_verifications')
        .update({ used: true, updated_at: new Date().toISOString() })
        .eq('email', key);
    } catch (dbErr) {}
  }

  /**
   * Single-use reset token tracking
   */
  async storeResetToken(token, { email, expiresAt }) {
    const record = {
      token,
      email: String(email).toLowerCase().trim(),
      used: false,
      expiresAt: Number(expiresAt)
    };
    this._memoryCache.set(`reset_${token}`, record);
    this._saveToDisk();
    return record;
  }

  async verifyAndConsumeResetToken(token) {
    const cached = this._memoryCache.get(`reset_${token}`);
    if (!cached || cached.used || Date.now() > cached.expiresAt) {
      return false;
    }
    cached.used = true;
    this._memoryCache.set(`reset_${token}`, cached);
    this._saveToDisk();
    return true;
  }
}

module.exports = new OtpPersistenceService();
