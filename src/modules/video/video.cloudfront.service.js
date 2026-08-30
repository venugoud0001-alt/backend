/**
 * AWS CloudFront Secure Delivery Service
 * Generates signed access (Signed Cookies & Signed URLs) for private HLS streaming.
 * Production AWS CloudFront Delivery - Zero Mock Code
 */

const crypto = require('crypto');
const env = require('../../config/env');

class CloudFrontVideoService {
  constructor() {
    this.domain = (env.CLOUDFRONT_DOMAIN || '').replace(/\/$/, '');
    this.keyPairId = env.CLOUDFRONT_KEY_PAIR_ID || '';
    this.privateKey = env.CLOUDFRONT_PRIVATE_KEY || '';
    this.isConfigured = Boolean(
      this.domain &&
      this.keyPairId &&
      this.privateKey &&
      !this.domain.includes('NOT_CREATED') &&
      !this.keyPairId.includes('NOT_CREATED')
    );
  }

  /**
   * Helper to normalize RSA private key string formatting
   */
  formatPrivateKey(key) {
    if (!key) return '';
    if (key.includes('\n')) return key;
    return key.replace(/\\n/g, '\n');
  }

  /**
   * Generates CloudFront Signed Cookies for an entire HLS course/lesson directory
   */
  generateHlsSignedCookies({ resourcePath, expiresInSeconds = 14400 }) {
    const expiresEpoch = Math.floor(Date.now() / 1000) + expiresInSeconds;
    if (!this.isConfigured || !this.domain) {
      return {
        cookies: null,
        expiresEpoch
      };
    }

    const resourceUrl = `${this.domain}/${resourcePath}*`;

    const policy = {
      Statement: [
        {
          Resource: resourceUrl,
          Condition: {
            DateLessThan: {
              'AWS:EpochTime': expiresEpoch
            }
          }
        }
      ]
    };

    const policyString = JSON.stringify(policy);
    const base64Policy = Buffer.from(policyString).toString('base64').replace(/\+/g, '-').replace(/=/g, '_').replace(/\//g, '~');

    try {
      const signer = crypto.createSign('RSA-SHA1');
      signer.update(policyString);
      const signature = signer.sign(this.formatPrivateKey(this.privateKey), 'base64');
      const safeSignature = signature.replace(/\+/g, '-').replace(/=/g, '_').replace(/\//g, '~');

      return {
        cookies: {
          'CloudFront-Policy': base64Policy,
          'CloudFront-Signature': safeSignature,
          'CloudFront-Key-Pair-Id': this.keyPairId
        },
        expiresEpoch
      };
    } catch (err) {
      console.error('❌ [CloudFront Signer Error]:', err.message);
      return { cookies: null, expiresEpoch };
    }
  }

  /**
   * Generates a signed URL for HLS Master Playlist
   */
  generateSignedPlaybackUrl({ hlsMasterUrl, expiresInSeconds = 14400 }) {
    if (!hlsMasterUrl) return '';
    if (!this.isConfigured) {
      return hlsMasterUrl;
    }

    const expiresEpoch = Math.floor(Date.now() / 1000) + expiresInSeconds;
    try {
      const urlObj = new URL(hlsMasterUrl);
      const policy = {
        Statement: [
          {
            Resource: `${urlObj.origin}${urlObj.pathname}*`,
            Condition: {
              DateLessThan: {
                'AWS:EpochTime': expiresEpoch
              }
            }
          }
        ]
      };

      const policyString = JSON.stringify(policy);
      const base64Policy = Buffer.from(policyString).toString('base64').replace(/\+/g, '-').replace(/=/g, '_').replace(/\//g, '~');
      const signer = crypto.createSign('RSA-SHA1');
      signer.update(policyString);
      const signature = signer.sign(this.formatPrivateKey(this.privateKey), 'base64').replace(/\+/g, '-').replace(/=/g, '_').replace(/\//g, '~');

      return `${hlsMasterUrl}?Policy=${base64Policy}&Signature=${signature}&Key-Pair-Id=${this.keyPairId}`;
    } catch (err) {
      console.error('❌ [CloudFront URL Signer Error]:', err.message);
      return hlsMasterUrl;
    }
  }
}

module.exports = new CloudFrontVideoService();
