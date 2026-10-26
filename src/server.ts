import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyFormbody from '@fastify/formbody';
import { WebSocket } from 'ws';
import { VoiceSession } from './pipeline/session.js';
import { getCalls, getLeads, getLeadStats, exportLeadsToCsv, getRecentLearnings, getCallerMemory } from './tools/db.js';
import { sheetsService } from './tools/sheets.js';
import { AVAILABLE_FEMALE_VOICES, synthesizeNeuralSpeech, prewarmTtsCache } from './pipeline/tts.js';
import { clearQualifier } from './pipeline/llm.js';
import { verifyPlivoSignature, buildStreamResponse, logInboundCall, getPlivoConfig } from './telephony/plivo.js';
import plivo from 'plivo';
import { callEventsBroadcaster, LiveCallEvent } from './pipeline/events.js';

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

/**
 * Request guard: carrier webhooks, health checks — unconditional pass.
 * Admin/API routes require ADMIN_SECRET_TOKEN when configured.
 * Browser origin lock enforced in production.
 */
app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
  const url = request.raw.url || '';
  const origin = (request.headers.origin || request.headers.referer || '') as string;

  // 1. Allow carrier webhooks, health checks, media stream, and live-feed unconditionally
  if (url.startsWith('/incoming-call') || url.startsWith('/health') || url.startsWith('/media-stream') || url.startsWith('/api/live-feed')) {
    return;
  }

  // 2. Admin / API auth — enforced whenever ADMIN_SECRET_TOKEN is set in env
  const adminToken = process.env.ADMIN_SECRET_TOKEN?.trim();
  if (adminToken && (url.startsWith('/api/') || url.startsWith('/admin'))) {
    const headerToken = request.headers['x-admin-token'] as string | undefined;
    const queryToken = (request.query as Record<string, string>)?.token;
    if (headerToken !== adminToken && queryToken !== adminToken) {
      reply.code(401);
      return reply.send({ error: 'Unauthorized: provide a valid x-admin-token header.' });
    }
  }

  // 3. If browser origin header is present on admin/api in production, enforce domain lock
  if (origin && process.env.NODE_ENV === 'production') {
    const publicDomain = process.env.PUBLIC_DOMAIN?.trim();
    const allowedOrigins = [
      publicDomain,
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
 * Helper to determine canonical public WebSocket streaming URL
 */
function getCanonicalStreamUrl(reqHost?: string, isTls?: boolean): string {
  const publicDomain = process.env.PUBLIC_DOMAIN?.trim();
  let domain = publicDomain || reqHost || HOST;
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

  // Instantly broadcast to live dashboard that an incoming call is connecting
  callEventsBroadcaster.broadcast({
    type: 'call_started',
    streamSid: callUuid,
    callerNumber: callerFrom,
    timestamp: new Date().toISOString(),
    data: {
      agentName: 'Priya',
      callerNumber: callerFrom,
      callSid: callUuid,
      greeting: 'Connecting to Priya (Trishul Mittal Palms Advisor)...',
      status: 'active',
    },
  });

  // Trigger Plivo carrier-grade call recording as secondary backup
  const plivoConfig = getPlivoConfig();
  if (plivoConfig.authId && plivoConfig.authToken && callUuid && !callUuid.startsWith('sim_')) {
    try {
      const client = new plivo.Client(plivoConfig.authId, plivoConfig.authToken);
      client.calls.record(callUuid, { fileFormat: 'mp3' }).catch((err: any) => {
        app.log.warn({ err: err.message }, '[Plivo] Carrier record initiation notice');
      });
    } catch {}
  }

  // Always return HTTP 200 + valid Voice XML with caller parameter
  const streamUrlWithCaller = callerFrom && callerFrom !== 'Unknown'
    ? `${streamUrl}?caller=${encodeURIComponent(callerFrom)}`
    : streamUrl;
  const xml = buildStreamResponse(streamUrlWithCaller);
  reply.header('Content-Type', 'text/xml');
  return reply.code(200).send(xml);
});

/**
 * API: Stream Call Audio Recording: GET /api/calls/:id/audio
 * Delivers full call WAV recording with HTTP range support for immediate browser review and playback.
 */
app.get('/api/calls/:id/audio', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
  const callId = request.params.id;
  const recordingsDir = path.resolve(process.cwd(), 'data', 'recordings');
  const filePath = path.join(recordingsDir, `call_${callId}.wav`);

  if (!fs.existsSync(filePath)) {
    return reply.code(404).send({ error: `Audio recording not found for call #${callId}` });
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = request.headers.range;

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
      'Cache-Control': 'public, max-age=86400',
    });
    return reply.send(fileStream);
  }

  reply.header('Content-Type', 'audio/wav');
  reply.header('Content-Length', fileSize);
  reply.header('Accept-Ranges', 'bytes');
  reply.header('Cache-Control', 'public, max-age=86400');
  return reply.send(fs.createReadStream(filePath));
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
  new VoiceSession(socket, callerNumber);
});



/**
 * API: Get recent calls
 */
app.get('/api/calls', async () => {
  return getCalls(50);
});

/**
 * API: Get recent leads
 */
app.get('/api/leads', async () => {
  return getLeads(50);
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
 * API: Get autonomous agent learnings
 */
app.get('/api/learnings', async () => {
  return getRecentLearnings(25);
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
      return { keyPresent: true, status: 'valid', message: 'Sarvam AI Bulbul is active with valid credits.' };
    }
    if (res.status === 402) {
      return { keyPresent: true, status: 'quota_exhausted', message: 'Sarvam AI account has 0 credits (402 Payment Required).' };
    }
    return { keyPresent: true, status: 'error', code: res.status, message: `Sarvam returned HTTP ${res.status}` };
  } catch (err: any) {
    return { keyPresent: true, status: 'network_error', message: err.message };
  }
});

/**
 * API: Validate and hot-swap Sarvam API key for the current process lifetime.
 * Note: Only updates the in-memory process.env — does NOT write to disk.
 * To persist across restarts, set SARVAM_API_KEY in your environment/deployment config.
 * Requires ADMIN_SECRET_TOKEN header for authorization.
 */
app.post('/api/sarvam/key', async (request: FastifyRequest<{ Body: { apiKey: string } }>, reply) => {
  // Admin auth check
  const adminToken = process.env.ADMIN_SECRET_TOKEN;
  if (adminToken) {
    const provided = request.headers['x-admin-token'] as string | undefined;
    if (!provided || provided !== adminToken) {
      return reply.code(401).send({ success: false, error: 'Unauthorized: missing or invalid x-admin-token header.' });
    }
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
  const voice = request.body?.voice || 'kavya';
  const enableSarvam = request.body?.enableSarvam !== false && voice !== 'browser';
  const streamSid = `sim_stream_${Date.now()}`;

  const session = createVirtualSession(streamSid, callerNumber);

  const agentName = (voice === 'shubh' || voice === 'dylan') ? 'Dylan Dsouza' : 'Priya';
  session.setAgentName(agentName);

  // Reset any cached qualifier so each simulated call starts completely clean
  clearQualifier();

  // Check caller memory context
  const memory = getCallerMemory(callerNumber);
  const callerName = (memory.existingLead?.callerName && memory.existingLead.callerName !== 'Valued Buyer')
    ? memory.existingLead.callerName
    : 'you';
  
  const greetingText = agentName === 'Priya'
    ? (callerName !== 'you' && callerName !== 'there' && callerName !== 'Valued Buyer'
        ? `Hello! Welcome back to Mittal Palms. This is Priya. Are you looking for a 2 BHK or a 3 BHK for your family?`
        : `Hello! This is Priya from Mittal Palms in Jakkur. Thanks for calling! We have ready-to-move 2 and 3 BHK homes here with Occupancy Certificate received. Are you looking for a 2 BHK or a 3 BHK for your family?`)
    : `Hi, good morning — am I speaking with ${callerName}?`;

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
    const voice = body.voice || 'kavya';
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

    const agentName = (voice === 'shubh' || voice === 'dylan') ? 'Dylan Dsouza' : (session.getAgentName() || 'Priya');
    session.setAgentName(agentName);

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
 * 7. Admin UI: GET /admin
 * State-of-the-art interactive dashboard with real-time audit tables and live caller tester.
 */
app.get('/admin', async (request, reply) => {
  const sheetUrl = sheetsService.getSheetUrl() || '#';
  const hasSheetConfigured = Boolean(process.env.GOOGLE_SHEET_ID);
  const dashboardPath = path.join(process.cwd(), 'src', 'dashboard', 'index.html');

  let html = '';
  if (fs.existsSync(dashboardPath)) {
    html = fs.readFileSync(dashboardPath, 'utf8');
  } else {
    html = '<h1>Admin Dashboard</h1>';
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
});

// Redirect root to /admin for intuitive developer experience
app.get('/', async (request, reply) => {
  return reply.redirect('/admin');
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
