import crypto from 'crypto';

export interface ExotelCallMetadata {
  from?: string;
  to?: string;
  callSid?: string;
  direction?: string;
  callerName?: string;
  rawPayload?: any;
}

export interface ExotelConfig {
  sid?: string;
  apiKey?: string;
  apiToken?: string;
  phoneNumber?: string;
  publicDomain?: string;
}

/**
 * Retrieves the active Exotel configuration from environment variables.
 */
export function getExotelConfig(): ExotelConfig {
  return {
    sid: process.env.EXOTEL_SID || '',
    apiKey: process.env.EXOTEL_API_KEY || '',
    apiToken: process.env.EXOTEL_API_TOKEN || '',
    phoneNumber: process.env.EXOTEL_PHONE_NUMBER || '',
    publicDomain: process.env.PUBLIC_DOMAIN || '',
  };
}

/**
 * Verifies Exotel's webhook signature using HMAC-SHA256.
 * In development or when unconfigured, gracefully falls through while logging an audit notice.
 */
export function verifyExotelSignature(
  signature?: string,
  rawPayload: string | Record<string, any> = '',
  webhookUrl?: string
): boolean {
  const token = process.env.EXOTEL_API_TOKEN;

  // In non-production or if no token is configured yet, allow call to proceed
  if (!token || token === 'xxx' || token === 'your_exotel_api_token') {
    if (process.env.NODE_ENV === 'production') {
      console.warn('[Exotel Security] Warning: EXOTEL_API_TOKEN not configured in production. Permitting inbound call.');
    }
    return true;
  }

  // If signature header is missing:
  if (!signature) {
    if (process.env.NODE_ENV === 'production') {
      console.warn('[Exotel Security] Rejecting production request missing x-exotel-signature header.');
      return false;
    }
    // Allow local development and manual testing
    return true;
  }

  try {
    const dataToSign = typeof rawPayload === 'string' ? rawPayload : JSON.stringify(rawPayload);
    const expectedSignature = crypto
      .createHmac('sha256', token)
      .update(dataToSign)
      .digest('hex');

    const expectedBuf = Buffer.from(expectedSignature, 'utf8');
    const actualBuf = Buffer.from(signature, 'utf8');

    if (expectedBuf.length !== actualBuf.length) {
      // Also check base64 digest variant if hex does not match length
      const expectedBase64 = crypto
        .createHmac('sha256', token)
        .update(dataToSign)
        .digest('base64');
      const b64Buf = Buffer.from(expectedBase64, 'utf8');
      if (b64Buf.length === actualBuf.length && crypto.timingSafeEqual(b64Buf, actualBuf)) {
        return true;
      }
      return false;
    }

    return crypto.timingSafeEqual(expectedBuf, actualBuf);
  } catch (err: any) {
    console.error('[Exotel Security] Error verifying signature:', err.message);
    return false;
  }
}

/**
 * Builds the bidirectional Voice Streaming TwiML/VoiceXML response for Exotel & Twilio.
 * Exotel Voice Stream Applet connects directly to the wss:// Stream URL.
 */
export function buildStreamResponse(streamUrl: string): string {
  // Ensure the stream protocol is strictly wss:// for public telephony endpoints
  const secureStreamUrl = streamUrl.startsWith('ws://') && !streamUrl.includes('localhost') && !streamUrl.includes('127.0.0.1')
    ? streamUrl.replace('ws://', 'wss://')
    : streamUrl;

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${secureStreamUrl}"/>
  </Connect>
</Response>`;
}

/**
 * Structured logger for all inbound telephony calls.
 */
export function logInboundCall(meta: ExotelCallMetadata): void {
  const timestamp = new Date().toISOString();
  console.log(`\n------------------------------------------------------------`);
  console.log(`📞 [Exotel Telephony Inbound Call]`);
  console.log(`   Time:     ${timestamp}`);
  console.log(`   From:     ${meta.from || 'Unknown Caller'}`);
  console.log(`   To:       ${meta.to || process.env.EXOTEL_PHONE_NUMBER || 'ExoPhone'}`);
  console.log(`   CallSid:  ${meta.callSid || 'simulated_sid'}`);
  console.log(`------------------------------------------------------------\n`);
}
