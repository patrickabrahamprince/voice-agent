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

const plivoClient = getPlivoClient();

/**
 * Checks whether user speech expresses intent to speak with a real human agent.
 */
export function isTransferIntent(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase().trim();
  return (
    lower.includes('[transfer_to_human]') ||
    /\b(talk to (a |the )?(human|real human|person|real person|manager|executive)|speak (to|with) (a |the )?(human|real human|person|real person|manager|executive)|connect me (to|with) (a |the )?(human|person|manager|executive)|transfer (the call|this call|to human|to person)|put me through to (a |the )?(human|executive|manager)|human se baat|executive se baat)\b/i.test(lower)
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
 * Transfers an active Plivo telephony call to the on-site property advisor team.
 */
export async function transferCallToHuman(options: TransferOptions): Promise<{ success: boolean; message: string }> {
  const targetPhone = options.targetPhone || process.env.HUMAN_ADVISOR_PHONE || '+919738397933';
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
      advisorName: 'Property Advisor Team',
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
    const publicDomain = process.env.PUBLIC_DOMAIN || 'knowaeo.com';
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
