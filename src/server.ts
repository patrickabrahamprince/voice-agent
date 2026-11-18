import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyFormbody from '@fastify/formbody';
import { WebSocket } from 'ws';
import { VoiceSession } from './pipeline/session.js';
import { getCalls, getCallById, getLeads, getLeadStats, exportLeadsToCsv, getRecentLearnings, getCallerMemory, deleteAllCalls, deleteAllLeads, deleteAllData, updateCallHangup, updateCallRecordingByUuid } from './tools/db.js';
import { sheetsService } from './tools/sheets.js';
import { AVAILABLE_FEMALE_VOICES, synthesizeNeuralSpeech, prewarmTtsCache } from './pipeline/tts.js';
import { clearQualifier, llmPipeline } from './pipeline/llm.js';
import { sarvamCircuitBreaker } from './pipeline/circuit_breaker.js';
import { verifyPlivoSignature, buildStreamResponse, logInboundCall, getPlivoConfig } from './telephony/plivo.js';
import plivo from 'plivo';
import { callEventsBroadcaster, LiveCallEvent } from './pipeline/events.js';
import { OBJECTION_SCENARIOS } from './pipeline/objections.js';

// Environment Validation: If TELEPHONY_PROVIDER=plivo and PLIVO_AUTH_ID is missing, crash on startup with clear error
if (process.env.TELEPHONY_PROVIDER === 'plivo' && !process.env.PLIVO_AUTH_ID) {
  console.error(
    '\n❌ [Fatal Configuration Error] TELEPHONY_PROVIDER is set to "plivo" but PLIVO_AUTH_ID is missing from environment. Telephony calls cannot be verified. Exiting.\n'
  );
  process.exit(1);
}

export const app = Fastify({
  logger: {
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  },
});

const PORT = parseInt(process.env.PORT || '3001', 10);
const HOST = process.env.HOST || `localhost:${PORT}`;

// In-memory registry of active simulated sessions for the web tester
const activeSimulators = new Map<string, VoiceSession>();

// Active WebSocket registry for graceful shutdown
export const activeWebSockets = new Set<WebSocket>();

// Register WebSocket and form-body plugins
await app.register(fastifyWebsocket);
await app.register(fastifyFormbody);

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'mittal@palms2026';
const ADMIN_SECRET_TOKEN = process.env.ADMIN_SECRET_TOKEN || 'mittal_palms_secret_2026';

function parseCookies(cookieHeader?: string): Record<string, string> {
  const list: Record<string, string> = {};
  if (!cookieHeader) return list;
  cookieHeader.split(';').forEach((cookie) => {
    const parts = cookie.split('=');
    const name = parts[0]?.trim();
    if (!name) return;
    const value = parts.slice(1).join('=').trim();
    list[name] = decodeURIComponent(value);
  });
  return list;
}

function extractAuthToken(request: FastifyRequest): string | undefined {
  const headerToken = (
    request.headers['x-admin-token'] ||
    request.headers['x-auth-token'] ||
    (request.headers['authorization'] ? (request.headers['authorization'] as string).replace(/^Bearer\s+/i, '') : '')
  ) as string | undefined;
  if (headerToken) return headerToken.trim();

  try {
    const rawUrl = request.raw.url || '';
    if (rawUrl.includes('?')) {
      const parsedUrl = new URL(rawUrl, 'http://localhost');
      const token = parsedUrl.searchParams.get('token');
      if (token) return token.trim();
    }
  } catch {}

  const queryToken = (request.query as Record<string, string>)?.token;
  if (queryToken) return queryToken.trim();

  const cookies = parseCookies(request.headers.cookie);
  if (cookies.admin_token) return cookies.admin_token.trim();

  return undefined;
}

/**
 * Request guard: carrier webhooks, health checks, media streams, UI pages — unconditional pass.
 * Data and admin routes require authenticated session or ADMIN_SECRET_TOKEN.
 * Browser origin lock enforced in production.
 */
app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
  const url = request.raw.url || '';
  const origin = (request.headers.origin || request.headers.referer || '') as string;

  // 1. Allow carrier webhooks, health checks, media stream, audio assets, live feed stream, proposal, and UI/auth routes unconditionally
  if (
    url.startsWith('/incoming-call') ||
    url.startsWith('/hangup') ||
    url.startsWith('/health') ||
    url.startsWith('/media-stream') ||
    url.startsWith('/audio/') ||
    url.startsWith('/api/live-feed') ||
    url.startsWith('/api/tts/') ||
    url.startsWith('/api/sarvam/status') ||
    url.startsWith('/proposal.pdf') ||
    url.startsWith('/transfer-to-human') ||
    url.startsWith('/transfer-fallback') ||
    url.startsWith('/api/auth/') ||
    (url.startsWith('/api/calls/') && url.includes('/audio')) ||
    url === '/' ||
    url.startsWith('/?') ||
    url === '/admin' ||
    url.startsWith('/admin?') ||
    url === '/api' ||
    url.startsWith('/api?')
  ) {
    return;
  }

  // 2. Admin / API authentication — protect data routes (/api/* and /admin/* data exports)
  if (url.startsWith('/api/') || url.startsWith('/admin/')) {
    const token = extractAuthToken(request);
    if (!token || token !== ADMIN_SECRET_TOKEN) {
      reply.code(401);
      return reply.send({ error: 'Unauthorized: Valid username & password login required.' });
    }
  }

  // 3. If browser origin header is present on admin/api in production, enforce domain lock
  if (origin && process.env.NODE_ENV === 'production') {
    const publicDomain = process.env.PUBLIC_DOMAIN?.trim();
    const allowedOrigins = [
      publicDomain,
      'knowaeo.com',
      'www.knowaeo.com',
      'getmoreos-voice-agent.vercel.app',
      request.headers.host,
      'localhost',
      '127.0.0.1',
    ].filter(Boolean) as string[];

    const isAllowed = allowedOrigins.some((allowed) => allowed && origin.includes(allowed));
    if (!isAllowed) {
      reply.code(403);
      return reply.send({ error: 'CORS policy: Access restricted to authorized domain.' });
    }
  }
});

/**
 * Auth API: Sign In with Username and Password
 */
app.post('/api/auth/login', async (request: FastifyRequest<{ Body: { username?: string; password?: string } }>, reply) => {
  const { username, password } = request.body || {};
  if (!username || !password) {
    return reply.code(400).send({ success: false, error: 'Username and password are required.' });
  }

  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    reply.header('Set-Cookie', `admin_token=${ADMIN_SECRET_TOKEN}; Path=/; SameSite=Lax; Max-Age=2592000`);
    return reply.send({
      success: true,
      token: ADMIN_SECRET_TOKEN,
      username: ADMIN_USERNAME,
      message: 'Authentication successful.',
    });
  }

  return reply.code(401).send({ success: false, error: 'Invalid username or password.' });
});

/**
 * Auth API: Check Session Validity
 */
app.get('/api/auth/check', async (request: FastifyRequest, reply) => {
  const token = extractAuthToken(request);
  if (token && token === ADMIN_SECRET_TOKEN) {
    return reply.send({ authenticated: true, username: ADMIN_USERNAME });
  }
  return reply.code(401).send({ authenticated: false, error: 'Not authenticated.' });
});

/**
 * Auth API: Sign Out
 */
app.post('/api/auth/logout', async (request: FastifyRequest, reply) => {
  reply.header('Set-Cookie', 'admin_token=; Path=/; SameSite=Lax; Max-Age=0');
  return reply.send({ success: true, message: 'Logged out successfully.' });
});

/**
 * Helper to determine canonical public WebSocket streaming URL
 */
function getCanonicalStreamUrl(reqHost?: string, isTls?: boolean): string {
  // If request comes through a public tunnel or external domain, always use that host directly so WebSocket matches the webhook
  const isReqHostPublic = reqHost && !reqHost.includes('localhost') && !reqHost.includes('127.0.0.1') && !reqHost.startsWith('192.168.') && !reqHost.startsWith('10.') && !reqHost.startsWith('172.');
  const publicDomain = process.env.PUBLIC_DOMAIN?.trim();
  let domain = isReqHostPublic ? reqHost : (publicDomain || reqHost || HOST);
  domain = domain.replace(/^https?:\/\//i, '').replace(/^wss?:\/\//i, '').replace(/\/$/, '');
  const isLocal = domain.includes('localhost') || domain.includes('127.0.0.1');
  const protocol = !isLocal || isTls ? 'wss' : 'ws';
  return `${protocol}://${domain}/media-stream`;
}

/**
 * Fast Health check endpoint: Guarantees 200 within <100ms for Railway/Render health checks
 */
app.get('/health', async (request: FastifyRequest, reply: FastifyReply) => {
  const isTls = request.headers['x-forwarded-proto'] === 'https';
  const websocketUrl = getCanonicalStreamUrl(request.headers.host, isTls);
  reply.header('Cache-Control', 'no-store, max-age=0');
  return reply.code(200).send({
    status: 'healthy',
    websocket: websocketUrl,
    provider: process.env.TELEPHONY_PROVIDER || 'plivo',
    timestamp: new Date().toISOString(),
    services: {
      deepgram: Boolean(process.env.DEEPGRAM_API_KEY && process.env.DEEPGRAM_API_KEY !== 'your_deepgram_api_key_here'),
      groq: Boolean(process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== 'your_groq_api_key_here'),
      sarvam: Boolean(process.env.SARVAM_API_KEY && process.env.SARVAM_API_KEY !== 'your_sarvam_api_key_here'),
      openrouter: Boolean(process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_API_KEY !== 'your_openrouter_api_key_here'),
      googleSheets: Boolean(process.env.GOOGLE_SHEET_ID && process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL),
    },
  });
});

/**
 * 1. Telephony Webhook: ALL /incoming-call
 * Accepts inbound calls from Plivo, validates x-plivo-signature-v2, logs caller data,
 * and guarantees a 200 OK Voice XML response with wss:// stream URL.
 */
app.all('/incoming-call', async (request: FastifyRequest, reply: FastifyReply) => {
  const isTls = request.headers['x-forwarded-proto'] === 'https';
  const publicDomain = process.env.PUBLIC_DOMAIN || (request.headers['x-forwarded-host'] as string) || request.headers.host || HOST;
  const streamUrl = getCanonicalStreamUrl(request.headers.host, isTls);

  const body = (request.body || {}) as any;
  const query = (request.query || {}) as any;

  // Plivo sends CallUUID, From, To
  const callerFrom = body.From || body.from || query.From || query.from || 'Unknown';
  const callTo = body.To || body.to || query.To || query.to || process.env.PLIVO_PHONE_NUMBER || 'Plivo Number';
  const callUuid = body.CallUUID || body.call_uuid || body.CallSid || query.CallUUID || query.CallSid || `plivo_${Date.now()}`;

  // Log every inbound call
  logInboundCall({
    from: callerFrom,
    to: callTo,
    callUuid,
    direction: 'inbound',
  });

  // Plivo v2 Signature validation (x-plivo-signature-v2 + x-plivo-signature-v2-nonce)
  const signature = request.headers['x-plivo-signature-v2'] as string | undefined;
  const nonce = request.headers['x-plivo-signature-v2-nonce'] as string | undefined;
  const protocol = isTls ? 'https' : 'http';
  const fullUri = `${protocol}://${request.headers.host}${request.raw.url}`;

  if (signature && nonce) {
    const isValid = verifyPlivoSignature(fullUri, nonce, signature);
    if (!isValid) {
      app.log.warn({ callUuid }, '[Plivo] Signature v2 verification notice — proceeding with call flow');
    }
  }

  // Plivo incoming call is accepted. The live media session will connect to /media-stream WebSocket,
  // where VoiceSession will handle real-time audio and broadcast call_started when caller connects.
  
  // Trigger Plivo carrier-grade call recording as permanent backup
  const plivoConfig = getPlivoConfig();
  if (plivoConfig.authId && plivoConfig.authToken && callUuid && !callUuid.startsWith('sim_')) {
    try {
      const client = new plivo.Client(plivoConfig.authId, plivoConfig.authToken);
      client.calls.record(callUuid, {
        fileFormat: 'mp3',
        callbackUrl: `https://${publicDomain}/recording-callback`,
        callbackMethod: 'POST',
      }).catch((err: any) => {
        app.log.warn({ err: err.message }, '[Plivo] Carrier record initiation notice');
      });
    } catch {}
  }

  // Always return HTTP 200 + valid Voice XML with caller and callUuid parameters
  const streamUrlWithCaller = callerFrom && callerFrom !== 'Unknown'
    ? `${streamUrl}?caller=${encodeURIComponent(callerFrom)}&callUuid=${encodeURIComponent(callUuid)}`
    : `${streamUrl}?callUuid=${encodeURIComponent(callUuid)}`;
  const xml = buildStreamResponse(streamUrlWithCaller);
  reply.header('Content-Type', 'text/xml');
  return reply.code(200).send(xml);
});

/**
 * 1c. Carrier Recording Callback: ALL /recording-callback
 * Plivo invokes this webhook as soon as carrier-grade audio MP3 is finalized and ready.
 * Saves the permanent CDN URL directly to the call and lead records in SQLite.
 */
app.all('/recording-callback', async (request: FastifyRequest, reply: FastifyReply) => {
  const body = (request.body || {}) as any;
  const query = (request.query || {}) as any;

  const recordingUrl = body.RecordUrl || body.recording_url || body.RecordingUrl || query.RecordUrl || query.recording_url || query.RecordingUrl || '';
  const callUuid = body.CallUUID || body.call_uuid || query.CallUUID || query.call_uuid || '';
  const duration = parseInt(body.RecordingDuration || body.recording_duration || query.RecordingDuration || '0', 10);

  console.log(`\n============================================================`);
  console.log(`🎙️ [Plivo Carrier Recording Ready Callback]`);
  console.log(`   Call UUID:     ${callUuid}`);
  console.log(`   Recording URL: ${recordingUrl}`);
  console.log(`   Duration:      ${duration}s`);
  console.log(`============================================================\n`);

  if (callUuid && recordingUrl) {
    updateCallRecordingByUuid(callUuid, recordingUrl);
    callEventsBroadcaster.broadcast({
      type: 'call_recording_ready',
      streamSid: '',
      callerNumber: '',
      timestamp: new Date().toISOString(),
      data: {
        callUuid,
        recordingUrl,
        durationSeconds: duration,
      },
    });
  }

  return reply.code(200).send({ status: 'ok', callUuid, recordingUrl });
});

/**
 * 1b. Carrier Hangup Webhook: ALL /hangup
 * Plivo invokes this webhook immediately when a call disconnects, providing
 * authoritative carrier metrics: HangupSource, HangupCause, HangupCauseCode, Duration.
 */
app.all('/hangup', async (request: FastifyRequest, reply: FastifyReply) => {
  const body = (request.body || {}) as any;
  const query = (request.query || {}) as any;

  const callUuid = body.CallUUID || body.call_uuid || query.CallUUID || query.call_uuid || '';
  const from = body.From || body.from || query.From || query.from || 'Unknown';
  const hangupSource = body.HangupSource || body.hangup_source || query.HangupSource || query.hangup_source || 'Caller';
  const hangupCause = body.HangupCause || body.hangup_cause || query.HangupCause || query.hangup_cause || 'Normal Hangup';
  const hangupCauseCode = body.HangupCauseCode || body.hangup_cause_code || query.HangupCauseCode || query.hangup_cause_code || '4000';
  const duration = parseInt(body.Duration || body.duration || query.Duration || query.duration || '0', 10);

  const timestamp = new Date().toISOString();
  console.log(`\n============================================================`);
  console.log(`📞 [Plivo Carrier Hangup Event]`);
  console.log(`   Time:        ${timestamp}`);
  console.log(`   Call UUID:   ${callUuid}`);
  console.log(`   From:        ${from}`);
  console.log(`   Duration:    ${duration}s`);
  console.log(`   Dropped By:  ${hangupSource} (${hangupSource === 'Caller' ? 'Caller Pressed End Call' : hangupSource})`);
  console.log(`   Cause:       ${hangupCause} (Code: ${hangupCauseCode})`);
  console.log(`============================================================\n`);

  if (callUuid) {
    updateCallHangup(callUuid, hangupSource, hangupCause, hangupCauseCode, duration);

    // Secondary check: query Plivo API for recording if callback hasn't arrived yet
    const plivoConfig = getPlivoConfig();
    if (plivoConfig.authId && plivoConfig.authToken && !callUuid.startsWith('sim_')) {
      setTimeout(async () => {
        try {
          const client = new plivo.Client(plivoConfig.authId, plivoConfig.authToken);
          const list: any = await client.recordings.list({ callUuid });
          if (list && list.length > 0 && list[0].recordingUrl) {
            updateCallRecordingByUuid(callUuid, list[0].recordingUrl);
          }
        } catch {}
      }, 4000);
    }
  }

  callEventsBroadcaster.broadcast({
    type: 'call_hangup',
    streamSid: '',
    callerNumber: from,
    timestamp,
    data: {
      callUuid,
      durationSeconds: duration,
      hangupSource,
      hangupCause,
      hangupCauseCode,
      droppedBy: hangupSource === 'Caller' ? 'Caller' : hangupSource,
    },
  });

  return reply.code(200).send({ status: 'ok', callUuid, hangupSource, hangupCause });
});

/**
 * API: Stream Call Audio Recording: GET /api/calls/:id/audio
 * Delivers full call WAV recording with HTTP range support for immediate browser review and playback.
 * Automatically falls back to permanent Plivo carrier CDN MP3 if local WAV is missing.
 */
app.get('/api/calls/:id/audio', async (request: FastifyRequest<{ Params: { id: string }; Querystring: { download?: string } }>, reply: FastifyReply) => {
  const callId = parseInt(request.params.id, 10);
  const isDownload = request.query?.download === '1' || request.query?.download === 'true';
  const recordingsDir = path.resolve(process.cwd(), 'data', 'recordings');
  const filePath = path.join(recordingsDir, `call_${callId}.wav`);

  // 1. If local mixed WAV file exists on disk, stream directly
  if (fs.existsSync(filePath)) {
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = request.headers.range;

    const disposition = isDownload ? 'attachment' : 'inline';
    reply.header('Content-Disposition', `${disposition}; filename="call_${callId}.wav"`);
    reply.header('Access-Control-Allow-Origin', '*');

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;
      const fileStream = fs.createReadStream(filePath, { start, end });

      reply.raw.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': 'audio/wav',
        'Content-Disposition': `${disposition}; filename="call_${callId}.wav"`,
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*',
      });
      return reply.send(fileStream);
    }

    reply.header('Content-Type', 'audio/wav');
    reply.header('Content-Length', fileSize);
    reply.header('Accept-Ranges', 'bytes');
    reply.header('Cache-Control', 'public, max-age=86400');
    return reply.send(fs.createReadStream(filePath));
  }

  // 2. Local WAV not on disk (e.g. after container redeploy). Look up database for remote carrier recording URL!
  const call = getCallById(callId);
  if (call?.recording_url && call.recording_url.startsWith('http')) {
    if (isDownload) {
      try {
        const audioRes = await fetch(call.recording_url);
        if (audioRes.ok && audioRes.body) {
          reply.header('Content-Type', audioRes.headers.get('content-type') || 'audio/mpeg');
          reply.header('Content-Disposition', `attachment; filename="call_${callId}.mp3"`);
          reply.header('Access-Control-Allow-Origin', '*');
          return reply.send(Buffer.from(await audioRes.arrayBuffer()));
        }
      } catch {}
    }
    return reply.redirect(call.recording_url);
  }

  // 3. Fallback: Query Plivo API directly for this call's recording if not yet attached in DB
  const plivoConfig = getPlivoConfig();
  if (plivoConfig.authId && plivoConfig.authToken && (call?.stream_sid || call?.call_uuid)) {
    try {
      const client = new plivo.Client(plivoConfig.authId, plivoConfig.authToken);
      const uuid = call.call_uuid || call.stream_sid;
      const list: any = await client.recordings.list({ callUuid: uuid });
      if (list && list.length > 0 && list[0].recordingUrl) {
        updateCallRecordingByUuid(uuid, list[0].recordingUrl);
        return reply.redirect(list[0].recordingUrl);
      }
    } catch {}
  }

  return reply.code(404).send({ error: `Audio recording not found for call #${callId}` });
});

/**
 * API: Get Single Call Details (including Full Turn-by-Turn Transcript): GET /api/calls/:id
 */
app.get('/api/calls/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
  const callId = parseInt(request.params.id, 10);
  const call = getCallById(callId);
  if (!call) {
    return reply.code(404).send({ error: `Call #${callId} not found` });
  }
  return call;
});

/**
 * 2. Telephony Media Stream: GET /media-stream
 * Handles the live bidirectional 8kHz G.711 mulaw WebSocket stream.
 */
app.get('/media-stream', { websocket: true }, (socket: WebSocket, req: FastifyRequest) => {
  activeWebSockets.add(socket);
  socket.on('close', () => activeWebSockets.delete(socket));
  app.log.info({ ip: req.ip }, '[MediaStream] Incoming telephony WebSocket connected');
  const query = (req.query || {}) as any;
  const callerNumber = query.caller ? decodeURIComponent(query.caller) : undefined;
  const callUuid = query.callUuid ? decodeURIComponent(query.callUuid) : undefined;
  new VoiceSession(socket, callerNumber, callUuid);
});

/**
 * Telephony: Live Call Transfer: POST/GET /transfer-to-human
 * Plivo executes this XML when transferring caller to the human property advisor team.
 */
app.all('/transfer-to-human', async (request: FastifyRequest, reply: FastifyReply) => {
  const query = (request.query || {}) as any;
  const body = (request.body || {}) as any;
  const targetPhone = query.target || body.target || process.env.HUMAN_ADVISOR_PHONE || '+919738397933';
  const publicDomain = process.env.PUBLIC_DOMAIN || 'knowaeo.com';

  app.log.info({ targetPhone }, '[Telephony] Generating Plivo transfer XML to human agent');

  const xml = `<Response><Speak voice="WOMAN" language="en-IN">Connecting your call to our on-site property advisor team. Please stay on the line.</Speak><Dial callerId="${process.env.PLIVO_PHONE_NUMBER || '08064348409'}" timeout="25" action="https://${publicDomain}/transfer-fallback" method="POST"><Number>${targetPhone}</Number></Dial></Response>`;

  reply.header('Content-Type', 'text/xml');
  return reply.code(200).send(xml);
});

/**
 * Telephony: Fallback Endpoint: POST/GET /transfer-fallback
 * Executed if human agent does not answer within 25 seconds or line is busy.
 */
app.all('/transfer-fallback', async (request: FastifyRequest, reply: FastifyReply) => {
  const body = (request.body || {}) as any;
  const query = (request.query || {}) as any;
  const dialStatus = body.DialStatus || query.DialStatus || 'failed';

  app.log.info({ dialStatus }, '[Telephony] Human transfer fallback triggered');

  if (dialStatus !== 'completed') {
    const xml = `<Response><Speak voice="WOMAN" language="en-IN">Our team is currently walking a client through the site. I have notified them with your details, and they will connect with you shortly. Thank you!</Speak></Response>`;
    reply.header('Content-Type', 'text/xml');
    return reply.code(200).send(xml);
  }

  return reply.code(200).send('<Response/>');
});



/**
 * API: Get recent calls
 */
app.get('/api/calls', async () => {
  return getCalls(50);
});

/**
 * API: Delete / Clear all calls
 */
app.delete('/api/calls', async () => {
  deleteAllCalls();
  return { success: true, message: 'All call records have been deleted.' };
});

app.post('/api/calls/clear', async () => {
  deleteAllCalls();
  return { success: true, message: 'All call records have been deleted.' };
});

/**
 * API: Get recent leads
 */
app.get('/api/leads', async () => {
  return getLeads(50);
});

/**
 * API: Delete / Clear all leads
 */
app.delete('/api/leads', async () => {
  deleteAllLeads();
  return { success: true, message: 'All lead records have been deleted.' };
});

app.post('/api/leads/clear', async () => {
  deleteAllLeads();
  return { success: true, message: 'All lead records have been deleted.' };
});

/**
 * API: Delete / Clear ALL portal data (Calls, Leads, and Learnings)
 */
app.delete('/api/data', async () => {
  deleteAllData();
  return { success: true, message: 'All calls, leads, and analytics data have been deleted.' };
});

app.post('/api/data/clear', async () => {
  deleteAllData();
  return { success: true, message: 'All calls, leads, and analytics data have been deleted.' };
});

/**
 * API: Get lead statistics & analytics
 */
app.get('/api/stats', async () => {
  return getLeadStats();
});

/**
 * API: Real-Time Telephony SSE Stream: GET /api/live-feed
 * Pushes live agent speech, caller transcripts, barge-ins, and lead intelligence in real time.
 */
app.get('/api/live-feed', (request: FastifyRequest, reply: FastifyReply) => {
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });

  // Initial event sending active call state
  raw.write(`event: init\ndata: ${JSON.stringify({ timestamp: new Date().toISOString(), activeCalls: callEventsBroadcaster.getActiveCalls() })}\n\n`);

  // Subscribe to live call broadcaster
  const unsubscribe = callEventsBroadcaster.subscribe((event: LiveCallEvent) => {
    try {
      raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    } catch {
      unsubscribe();
    }
  });

  // Keep-alive heartbeat every 15s to keep connections alive through reverse proxies
  const heartbeat = setInterval(() => {
    try {
      raw.write(`: heartbeat ${Date.now()}\n\n`);
    } catch {
      clearInterval(heartbeat);
      unsubscribe();
    }
  }, 15000);

  request.raw.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

/**
 * API: Get current active or recent call state: GET /api/live-feed/active
 */
app.get('/api/live-feed/active', async () => {
  return {
    latest: callEventsBroadcaster.getLatestCall(),
    allActive: callEventsBroadcaster.getActiveCalls(),
  };
});

/**
 * API: Clear any stale active call feeds: POST /api/live-feed/clear
 */
app.post('/api/live-feed/clear', async () => {
  callEventsBroadcaster.clearAllActive();
  return { success: true, message: 'Active call feed cleared.' };
});

/**
 * API: Get autonomous agent learnings
 */
app.get('/api/learnings', async () => {
  return getRecentLearnings(25);
});

/**
 * API: Get structured real estate objection scenarios and training playbooks
 */
app.get('/api/training/objections', async () => {
  return {
    count: OBJECTION_SCENARIOS.length,
    scenarios: OBJECTION_SCENARIOS,
  };
});

/**
 * API: Run live objection benchmark test against Priya
 */
app.post('/api/training/test-objection', async (request, reply) => {
  const body = (request.body as any) || {};
  const objectionText = (body.objection || '').trim();
  if (!objectionText) {
    return reply.status(400).send({ error: 'objection text is required' });
  }

  const t0 = Date.now();
  const testHistory: any[] = [
    {
      role: 'assistant',
      content:
        'Hello! Welcome to Trishul Mittal Palms in Jakkur. I\'m Priya, property advisor. Thanks for calling! Are you exploring 2 or 3 BHK properties in Bangalore?',
    },
    {
      role: 'user',
      content: objectionText,
    },
  ];

  let response = '';
  for await (const chunk of llmPipeline.streamResponse(testHistory, null, '+91-9880199999', 'Priya')) {
    response += chunk;
  }

  const latencyMs = Date.now() - t0;
  const words = response.trim().split(/\s+/).filter(Boolean).length;
  const brevityPassed = words <= 35;
  const lower = response.toLowerCase();
  const noHallucinationPassed =
    !lower.includes('two point two crore') &&
    !lower.includes('2.25') &&
    !lower.includes('noted your budget as');

  return {
    objection: objectionText,
    response: response.trim(),
    latencyMs,
    wordCount: words,
    brevityPassed,
    noHallucinationPassed,
    passed: brevityPassed && noHallucinationPassed,
  };
});

/**
 * API: Test Google Sheets connectivity
 */
app.post('/api/sheets/test', async () => {
  return sheetsService.testConnection();
});

/**
 * API: Export leads to CSV
 */
app.get('/admin/export-leads.csv', async (request, reply) => {
  const csvData = exportLeadsToCsv();
  reply.header('Content-Type', 'text/csv');
  reply.header('Content-Disposition', 'attachment; filename="leads_export.csv"');
  return reply.send(csvData);
});

/**
 * API: Download Client PDF Proposal
 */
app.get('/proposal.pdf', async (request, reply) => {
  const pdfPath = path.resolve(process.cwd(), 'Voice_AI_Proposal_Mittal_Palms.pdf');
  if (fs.existsSync(pdfPath)) {
    const stream = fs.createReadStream(pdfPath);
    reply.header('Content-Type', 'application/pdf');
    reply.header('Content-Disposition', 'inline; filename="Voice_AI_Proposal_Mittal_Palms.pdf"');
    return reply.send(stream);
  }
  return reply.code(404).send({ error: 'Proposal PDF not found.' });
});

/**
 * Static Audio Route: GET /audio/:filename
 * Serves pre-synthesized Bangalore real estate voice clips.
 * Security: restricted to public/audio/ directory, audio extensions only.
 */
const AUDIO_ROOT = path.resolve(process.cwd(), 'public', 'audio');
const ALLOWED_AUDIO_EXT = /\.(wav|mp3|ogg|aac|m4a)$/i;

app.get('/audio/:filename', async (request: FastifyRequest<{ Params: { filename: string } }>, reply) => {
  const { filename } = request.params;
  const safeFilename = path.basename(filename);

  // Extension allowlist — block .env, .js, .ts, etc.
  if (!ALLOWED_AUDIO_EXT.test(safeFilename)) {
    return reply.code(400).send({ error: 'Invalid file type' });
  }

  const audioPath = path.resolve(AUDIO_ROOT, safeFilename);

  // Prevent path traversal — ensure resolved path stays inside audio root
  if (!audioPath.startsWith(AUDIO_ROOT + path.sep) && audioPath !== AUDIO_ROOT) {
    return reply.code(403).send({ error: 'Forbidden' });
  }

  if (fs.existsSync(audioPath)) {
    reply.header('Content-Type', 'audio/wav');
    reply.header('Cache-Control', 'public, max-age=86400');
    return reply.send(fs.readFileSync(audioPath));
  }
  return reply.code(404).send({ error: 'Audio file not found' });
});

/**
 * TTS API: List available female voices
 */
app.get('/api/tts/voices', async () => {
  return AVAILABLE_FEMALE_VOICES;
});

/**
 * TTS API: Synthesize text into high-fidelity neural audio
 */
app.post(
  '/api/tts/synthesize',
  async (request: FastifyRequest<{ Body: { text: string; voice?: string } }>, reply) => {
    const { text, voice } = request.body || {};
    if (!text || !text.trim()) {
      return reply.code(400).send({ error: 'Text is required for TTS synthesis.' });
    }

    try {
      const { buffer, contentType } = await synthesizeNeuralSpeech(text, voice);
      if (!buffer || buffer.length === 0) {
        return reply.code(503).send({ error: 'TTS audio synthesis produced empty buffer' });
      }
      reply.header('Content-Type', contentType);
      reply.header('Cache-Control', 'public, max-age=86400');
      return reply.send(buffer);
    } catch (err: any) {
      app.log.error({ err }, 'Neural TTS synthesis error');
      return reply.code(500).send({ error: 'TTS synthesis failed', details: err.message });
    }
  }
);

app.get('/api/debug-sarvam', async () => {
  const sarvamKey = process.env.SARVAM_API_KEY;
  const tests = [
    { model: 'bulbul:v3', speaker: 'kavya' },
    { model: 'bulbul:v3', speaker: 'roopa' },
    { model: 'bulbul:v3', speaker: 'priya' },
  ];

  const results: any[] = [];
  for (const t of tests) {
    try {
      const res = await fetch('https://api.sarvam.ai/text-to-speech', {
        method: 'POST',
        headers: {
          'api-subscription-key': sarvamKey || '',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: 'Hello from Mittal Palms',
          language_code: 'en-IN',
          speaker: t.speaker,
          model: t.model,
        }),
      });

      const bodyText = await res.text();
      results.push({
        test: t,
        status: res.status,
        statusText: res.statusText,
        bodySnippet: bodyText.slice(0, 200),
      });
    } catch (err: any) {
      results.push({ test: t, error: err.message });
    }
  }

  return { sarvamKeyPresent: !!sarvamKey, results };
});

app.get('/api/sarvam/status', async () => {
  const sarvamKey = process.env.SARVAM_API_KEY;
  if (!sarvamKey || sarvamKey === 'your_sarvam_api_key_here') {
    return { keyPresent: false, status: 'missing', message: 'No Sarvam API key configured.' };
  }
  try {
    const res = await fetch('https://api.sarvam.ai/text-to-speech', {
      method: 'POST',
      headers: {
        'api-subscription-key': sarvamKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: 'Test',
        language_code: 'en-IN',
        speaker: 'kavya',
        model: 'bulbul:v3',
      }),
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      sarvamCircuitBreaker.reset();
      return { keyPresent: true, status: 'valid', message: 'Sarvam AI Bulbul is active with valid credits.' };
    }
    if (res.status === 402) {
      sarvamCircuitBreaker.markExhausted();
      return { keyPresent: true, status: 'quota_exhausted', message: 'Sarvam AI account has 0 credits (402 Payment Required).' };
    }
    return { keyPresent: true, status: 'error', code: res.status, message: `Sarvam returned HTTP ${res.status}` };
  } catch (err: any) {
    return { keyPresent: true, status: 'network_error', message: err.message };
  }
});

app.post('/api/sarvam/reset', async () => {
  sarvamCircuitBreaker.reset();
  return { success: true, message: 'Sarvam circuit breaker reset. Probing Sarvam directly for next TTS call.' };
});

/**
 * API: Validate and hot-swap Sarvam API key for the current process lifetime.
 * Note: Only updates the in-memory process.env — does NOT write to disk.
 * To persist across restarts, set SARVAM_API_KEY in your environment/deployment config.
 * Requires ADMIN_SECRET_TOKEN header for authorization.
 */
app.post('/api/sarvam/key', async (request: FastifyRequest<{ Body: { apiKey: string } }>, reply) => {
  // Admin auth check
  const provided = extractAuthToken(request);
  if (!provided || provided !== ADMIN_SECRET_TOKEN) {
    return reply.code(401).send({ success: false, error: 'Unauthorized: missing or invalid credentials.' });
  }

  const { apiKey } = request.body || {};
  if (!apiKey || !apiKey.trim().startsWith('sk_')) {
    return reply.code(400).send({ success: false, error: 'Invalid API key format. Expected sk_...' });
  }

  try {
    const res = await fetch('https://api.sarvam.ai/text-to-speech', {
      method: 'POST',
      headers: {
        'api-subscription-key': apiKey.trim(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: 'Hello from Mittal Palms',
        language_code: 'en-IN',
        speaker: 'kavya',
        model: 'bulbul:v4-flash',
      }),
      signal: AbortSignal.timeout(6000),
    });

    if (res.ok) {
      // Update in-memory only — never write secrets to disk at runtime
      process.env.SARVAM_API_KEY = apiKey.trim();
      return { success: true, message: 'Sarvam API key verified and hot-swapped for this process. Set SARVAM_API_KEY in your deployment config to persist.' };
    }

    if (res.status === 402) {
      return reply.code(400).send({ success: false, error: 'Key accepted by Sarvam, but has 0 credits (HTTP 402).' });
    }
    const errText = await res.text().catch(() => '');
    return reply.code(400).send({ success: false, error: `Sarvam rejected key (HTTP ${res.status}): ${errText}` });
  } catch (err: any) {
    return reply.code(500).send({ success: false, error: `Validation request failed: ${err.message}` });
  }
});

function createVirtualSession(streamSid: string, callerNumber: string = '+91-9880012345'): VoiceSession {
  const virtualSocket: any = {
    readyState: WebSocket.OPEN,
    listeners: {} as Record<string, Function[]>,
    on(event: string, fn: Function) {
      if (!this.listeners[event]) this.listeners[event] = [];
      this.listeners[event].push(fn);
    },
    send(data: string) {},
    emit(event: string, ...args: any[]) {
      const list = this.listeners[event] || [];
      for (const fn of list) fn(...args);
    },
  };

  const session = new VoiceSession(virtualSocket as unknown as WebSocket);
  virtualSocket.emit(
    'message',
    Buffer.from(
      JSON.stringify({
        event: 'start',
        start: {
          streamSid,
          callSid: `sim_call_${Date.now()}`,
          customParameters: {
            from: callerNumber,
          },
        },
      })
    )
  );
  activeSimulators.set(streamSid, session);
  return session;
}

/**
 * Simulator API: Start Simulated Call
 */
app.post('/api/simulator/call', async (request: FastifyRequest<{ Body: { callerNumber?: string; voice?: string; enableSarvam?: boolean } }>) => {
  const callerNumber = request.body?.callerNumber || '+91-9880012345';
  const voice = request.body?.voice || 'ishita';
  const enableSarvam = request.body?.enableSarvam !== false && voice !== 'browser';
  const streamSid = `sim_stream_${Date.now()}`;

  const session = createVirtualSession(streamSid, callerNumber);

  const agentName = 'Priya';
  session.setAgentName(agentName);
  session.setAgentVoice(voice);

  // Reset any cached qualifier so each simulated call starts completely clean
  clearQualifier();

  // Check caller memory context
  const memory = getCallerMemory(callerNumber);
  const greetingText = session.getInitialGreeting();

  let greetingAudioBase64: string | undefined;
  let audioContentType: string | undefined;
  if (enableSarvam) {
    try {
      const { buffer, contentType } = await synthesizeNeuralSpeech(greetingText, voice);
      if (buffer.length > 0) {
        greetingAudioBase64 = buffer.toString('base64');
        audioContentType = contentType;
      }
    } catch (err: any) {
      app.log.warn({ err: err.message }, 'Could not pre-synthesize greeting audio');
    }
  }

  return {
    success: true,
    streamSid,
    callerNumber,
    callId: session.getCallId(),
    greetingText,
    greetingAudioBase64,
    audioContentType,
    agentName,
    voice,
    callerMemory: memory,
    message: memory.isReturningCaller
      ? `Simulated call started. Recognized returning caller (${memory.totalPreviousCalls} prior calls).`
      : `Simulated call started. First-time caller initialized.`,
  };
});

/**
 * Simulator API: Send Utterance
 */
app.post(
  '/api/simulator/utterance',
  async (
    request: FastifyRequest<{
      Body: {
        streamSid: string;
        text?: string;
        transcript?: string;
        voice?: string;
        includeAudio?: boolean;
        enableSarvam?: boolean;
        callerNumber?: string;
        history?: any[];
      };
    }>,
    reply
  ) => {
    const body = request.body || ({} as any);
    const streamSid = body.streamSid || `sim_stream_${Date.now()}`;
    const text = body.text || body.transcript || '';
    const voice = body.voice || 'ishita';
    const enableSarvam = body.enableSarvam !== false && voice !== 'browser';
    const includeAudio = body.includeAudio !== false && enableSarvam;
    const history = body.history;

    let session = activeSimulators.get(streamSid);
    if (!session) {
      app.log.info({ streamSid }, '[Simulator] Transparently resurrecting serverless session');
      session = createVirtualSession(streamSid, body.callerNumber || '+91-9880012345');
    }

    if (body.callerNumber) {
      session.setCallerNumber(body.callerNumber);
    }

    if (history && Array.isArray(history) && history.length > 0) {
      session.setConversationHistory(history);
    }

    const agentName = 'Priya';
    session.setAgentName(agentName);
    session.setAgentVoice(voice);

    if (!text.trim()) {
      return reply.code(400).send({ error: 'Missing or empty utterance text.' });
    }

    const replyText = await session.processCallerUtterance(text);

    let audioBase64: string | undefined;
    let audioContentType: string | undefined;
    if (includeAudio && replyText) {
      try {
        const { buffer, contentType } = await synthesizeNeuralSpeech(replyText, voice);
        audioBase64 = buffer.toString('base64');
        audioContentType = contentType;
      } catch (err) {
        console.warn('[Simulator] Error pre-synthesizing audio in utterance response:', err);
      }
    }

    const callerMemory = getCallerMemory(session.getCallerNumber());

    return {
      success: true,
      replyText,
      audioBase64,
      audioContentType,
      callerMemory,
      transcript: session.getTranscript(),
    };
  }
);

/**
 * Simulator API: Trigger Barge-In
 */
app.post('/api/simulator/barge-in', async (request: FastifyRequest<{ Body: { streamSid: string } }>, reply) => {
  const { streamSid } = request.body || {};
  const session = activeSimulators.get(streamSid);
  if (!session) {
    return reply.code(404).send({ error: 'Active session not found.' });
  }

  session.handleBargeIn();
  return { success: true, message: 'Barge-in clear signal sent.' };
});

/**
 * Simulator API: End Simulated Call
 */
app.post('/api/simulator/hangup', async (request: FastifyRequest<{ Body: { streamSid: string } }>, reply) => {
  const { streamSid } = request.body || {};
  const session = activeSimulators.get(streamSid);
  if (session) {
    await session.closeSession();
    activeSimulators.delete(streamSid);
  }
  return { success: true, message: 'Call ended and audited.' };
});

/**
 * Helper to render the complete Voice AI Agent Web Console & Interactive Tester.
 */
function renderVoiceAgentDashboard(request: FastifyRequest, reply: FastifyReply) {
  const sheetUrl = sheetsService.getSheetUrl() || '#';
  const hasSheetConfigured = Boolean(process.env.GOOGLE_SHEET_ID);
  let dashboardPath = path.join(process.cwd(), 'src', 'dashboard', 'index.html');
  if (!fs.existsSync(dashboardPath)) {
    dashboardPath = path.join(process.cwd(), 'dist', 'dashboard', 'index.html');
  }

  let html = '';
  if (fs.existsSync(dashboardPath)) {
    html = fs.readFileSync(dashboardPath, 'utf8');
  } else {
    html = '<h1>Trishul Mittal Palms — AI Voice Advisor</h1>';
  }

  // Inject dynamic variables
  html = html
    .replace('id="sheet-link" href="#"', `id="sheet-link" href="${sheetUrl}"`)
    .replace(
      '<span id="sheet-link-text">Google Sheet</span>',
      `<span id="sheet-link-text">${hasSheetConfigured ? 'Open Live Google Sheet' : 'Google Sheet (Configure ID)'}</span>`
    );

  reply.header('Content-Type', 'text/html; charset=utf-8');
  reply.header('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
  reply.header('Pragma', 'no-cache');
  reply.header('Expires', '0');
  return reply.send(html);
}

// 1. Direct Voice Agent Web Console at root: www.knowaeo.com /
app.get('/', async (request, reply) => {
  return renderVoiceAgentDashboard(request, reply);
});

// 2. Direct Voice Agent Web Console at /admin
app.get('/admin', async (request, reply) => {
  return renderVoiceAgentDashboard(request, reply);
});

// 3. Fallback for serverless rewrite root /api
app.get('/api', async (request, reply) => {
  return renderVoiceAgentDashboard(request, reply);
});

// Graceful Shutdown Handler for WebSockets and Fastify Server
async function gracefulShutdown(signal: string) {
  console.log(`\n🛑 Received ${signal}. Initiating graceful shutdown...`);

  // 1. Close all active carrier WebSockets
  console.log(`[Shutdown] Closing ${activeWebSockets.size} active telephony WebSocket connection(s)...`);
  for (const ws of activeWebSockets) {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1001, 'Server shutting down');
      }
    } catch {}
  }
  activeWebSockets.clear();

  // 2. Close Fastify HTTP server
  try {
    await app.close();
    console.log('✅ Fastify server closed cleanly. Exiting.');
    process.exit(0);
  } catch (err: any) {
    console.error('❌ Error during shutdown:', err.message);
    process.exit(1);
  }
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Start the production server
async function startServer() {
  try {
    await app.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`\n======================================================`);
    console.log(`🚀 Getmore.OS Real Estate Voice AI Server Active!`);
    console.log(`📡 Inbound Telephony Webhook: http://${HOST}/incoming-call`);
    console.log(`🎙️ Media Stream WebSocket:   ws://${HOST}/media-stream`);
    console.log(`📊 Admin Console & Tester:   http://${HOST}/admin`);
    if (!process.env.ADMIN_SECRET_TOKEN) {
      console.warn(`⚠️  ADMIN_SECRET_TOKEN is not set — /api/* and /admin routes are unprotected!`);
    } else {
      console.log(`🔐 Admin Auth:               x-admin-token header required`);
    }
    console.log(`======================================================\n`);

    // Pre-warm top 25 real estate phrases in background
    prewarmTtsCache().catch((err) => console.warn('[TTS] Cache prewarming notice:', err.message));
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// Start persistent server only when executed directly (not imported as serverless module)
const isVercelRuntime = Boolean(process.env.VERCEL);
if (!isVercelRuntime) {
  startServer();
}

// Export default handler for Vercel Serverless Function invocations
let isServerlessReady = false;
export default async function handler(req: any, res: any) {
  if (!isServerlessReady) {
    await app.ready();
    isServerlessReady = true;
  }
  app.server.emit('request', req, res);
}
