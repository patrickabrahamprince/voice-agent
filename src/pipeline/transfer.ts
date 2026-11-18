import plivo from 'plivo';
import { callEventsBroadcaster } from './events.js';

function getPlivoClient() {
  const authId = process.env.PLIVO_AUTH_ID;
  const authToken = process.env.PLIVO_AUTH_TOKEN;
  if (!authId || !authToken) return null;
  const ClientClass = (plivo as any)?.Client || (plivo as any)?.default?.Client || plivo;
  try {
    return typeof ClientClass === 'function' ? new ClientClass(authId, authToken) : null;
  } catch {
    return null;
  }
}

export const plivoClient = getPlivoClient();

/**
 * Checks whether user speech expresses intent to speak with a real human agent.
 * Excludes callback requests so that Priya can schedule a callback instead of an immediate transfer.
 */
export function isTransferIntent(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase().trim();

  // Explicit callback requests are handled as callbacks, not immediate live carrier transfers
  const isCallbackRequest = /\b(call( me)? back|phone( me)? back|callback|call later|phone later|ask (dylan|him|her|someone) to call|have (dylan|him|her|someone) call)\b/i.test(lower);
  if (isCallbackRequest) {
    return false;
  }

  return (
    lower.includes('[transfer_to_human]') ||
    /\b(talk to (a |the )?(human|real human|person|real person|manager|executive|dylan)|speak (to|with) (a |the )?(human|real human|person|real person|manager|executive|dylan)|connect me (to|with) (a |the )?(human|person|manager|executive|dylan)|transfer (the call|this call|me|to human|to person|to dylan)|put me through to (a |the )?(human|executive|manager|dylan)|human se baat|executive se baat|dylan se baat)\b/i.test(lower)
  );
}

export interface TransferOptions {
  callUuid?: string;
  streamSid?: string;
  callerNumber?: string;
  reason?: string;
  targetPhone?: string;
}

/**
 * Transfers an active Plivo telephony call to the on-site property advisor team (Dylan Dsouza).
 */
export async function transferCallToHuman(options: TransferOptions): Promise<{ success: boolean; message: string }> {
  // Check if caller is Dylan himself testing from +919035738310
  const callerDigits = (options.callerNumber || '').replace(/\D/g, '');
  const isDylanCalling = callerDigits.endsWith('9035738310');

  // If Dylan is calling from his phone, route to team backup (+919738397933) to prevent busy self-dial collision.
  // Otherwise, route to Dylan (+919035738310).
  const defaultTarget = isDylanCalling
    ? (process.env.HUMAN_ADVISOR_PHONE || '+919738397933')
    : (process.env.DYLAN_PHONE || '+919035738310');

  const targetPhone = options.targetPhone || defaultTarget;
  const callUuid = options.callUuid;

  console.log(`[CallTransfer] Initiating transfer for CallUUID="${callUuid}", caller="${options.callerNumber}" -> target="${targetPhone}"`);

  // Broadcast to Live Dashboard SSE Feed
  callEventsBroadcaster.broadcast({
    type: 'call_transferred',
    streamSid: options.streamSid || 'unknown',
    callerNumber: options.callerNumber || 'Unknown',
    timestamp: new Date().toISOString(),
    data: {
      callUuid,
      targetPhone,
      advisorName: isDylanCalling ? 'Property Advisor Team Backup' : 'Dylan Dsouza (Sales Manager)',
      reason: options.reason || 'Customer requested live human property advisor',
    },
  });

  if (!callUuid || callUuid.startsWith('sim_') || callUuid.startsWith('test_')) {
    console.log(`[CallTransfer] Simulated transfer complete for ${callUuid}`);
    return { success: true, message: `Simulated call transfer to Property Advisor Team (${targetPhone})` };
  }

  if (!plivoClient) {
    console.warn('[CallTransfer] Plivo client not configured; skipping carrier API call');
    return { success: false, message: 'Plivo client credentials not configured' };
  }

  try {
    const publicDomain = process.env.PUBLIC_DOMAIN || process.env.RENDER_EXTERNAL_HOSTNAME || 'mittal-palms-voice-agent.onrender.com';
    const alegUrl = `https://${publicDomain}/transfer-to-human?target=${encodeURIComponent(targetPhone)}&caller=${encodeURIComponent(options.callerNumber || 'Unknown')}`;

    console.log(`[CallTransfer] Executing Plivo transfer API with aleg_url: ${alegUrl}`);
    const res = await plivoClient.calls.transfer(callUuid, {
      aleg_url: alegUrl,
      aleg_method: 'POST',
      legs: 'aleg',
    });

    console.log('[CallTransfer] Plivo API response:', res);
    return { success: true, message: `Plivo call transferred to ${targetPhone}` };
  } catch (err: any) {
    console.error('[CallTransfer] Failed to execute Plivo transfer:', err.message);
    return { success: false, message: err.message };
  }
}
