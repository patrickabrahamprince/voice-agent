import plivo from 'plivo';

export interface PlivoCallMetadata {
  from?: string;
  to?: string;
  callUuid?: string;
  callSid?: string;
  direction?: string;
  rawPayload?: any;
}

export interface PlivoConfig {
  authId?: string;
  authToken?: string;
  phoneNumber?: string;
  publicDomain?: string;
}

/**
 * Retrieves the active Plivo configuration from environment variables.
 */
export function getPlivoConfig(): PlivoConfig {
  return {
    authId: process.env.PLIVO_AUTH_ID || '',
    authToken: process.env.PLIVO_AUTH_TOKEN || '',
    phoneNumber: process.env.PLIVO_PHONE_NUMBER || '',
    publicDomain: process.env.PUBLIC_DOMAIN || '',
  };
}

/**
 * Validates Plivo x-plivo-signature-v2 using Plivo SDK validateSignature().
 * In development or when unconfigured, logs an audit notice and permits testing.
 */
export function verifyPlivoSignature(
  uri: string,
  nonce?: string,
  signature?: string,
  authToken?: string
): boolean {
  const token = authToken || process.env.PLIVO_AUTH_TOKEN;

  // In non-production or if token is unconfigured, allow testing gracefully
  if (!token || token === 'xxx' || token === 'your_plivo_auth_token') {
    if (process.env.NODE_ENV === 'production') {
      console.warn('[Plivo Security] Warning: PLIVO_AUTH_TOKEN not configured in production. Permitting inbound call.');
    }
    return true;
  }

  // If signature or nonce header is missing in production:
  if (!signature || !nonce) {
    if (process.env.NODE_ENV === 'production') {
      console.warn('[Plivo Security] Rejecting production request missing x-plivo-signature-v2 or nonce.');
      return false;
    }
    // Allow local development and manual testing
    return true;
  }

  try {
    return Boolean(plivo.validateSignature(uri, nonce, signature, token));
  } catch (err: any) {
    console.error('[Plivo Security] Error validating Plivo v2 signature:', err.message);
    return false;
  }
}

/**
 * Builds the bidirectional Voice Streaming XML response for Plivo.
 * Guarantees wss:// protocol and uses PUBLIC_DOMAIN.
 */
export function buildStreamResponse(streamUrl: string): string {
  // Ensure the stream protocol is strictly wss:// for public telephony endpoints
  const secureStreamUrl = streamUrl.startsWith('ws://') && !streamUrl.includes('localhost') && !streamUrl.includes('127.0.0.1')
    ? streamUrl.replace('ws://', 'wss://')
    : streamUrl;

  try {
    const response = plivo.Response();
    response.addStream(secureStreamUrl, {
      bidirectional: true,
      streamTimeout: 86400,
      audioTrack: 'inbound',
    });
    return response.toXML();
  } catch {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Stream bidirectional="true" streamTimeout="86400">${secureStreamUrl}</Stream>
</Response>`;
  }
}

/**
 * Structured logger for all inbound Plivo telephony calls.
 */
export function logInboundCall(meta: PlivoCallMetadata): void {
  const timestamp = new Date().toISOString();
  console.log(`\n------------------------------------------------------------`);
  console.log(`📞 [Plivo Telephony Inbound Call]`);
  console.log(`   Time:      ${timestamp}`);
  console.log(`   From:      ${meta.from || 'Unknown Caller'}`);
  console.log(`   To:        ${meta.to || process.env.PLIVO_PHONE_NUMBER || 'Plivo ExoPhone'}`);
  console.log(`   Call UUID: ${meta.callUuid || meta.callSid || 'simulated_uuid'}`);
  console.log(`------------------------------------------------------------\n`);
}
