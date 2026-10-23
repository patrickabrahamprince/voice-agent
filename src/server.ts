import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { WebSocket } from 'ws';
import { VoiceSession } from './pipeline/session.js';
import { getCalls, getLeads, getLeadStats, exportLeadsToCsv, getRecentLearnings, getCallerMemory } from './tools/db.js';
import { sheetsService } from './tools/sheets.js';
import { AVAILABLE_FEMALE_VOICES, synthesizeNeuralSpeech } from './pipeline/tts.js';
import { clearQualifier } from './pipeline/llm.js';
import { verifyExotelSignature, buildStreamResponse, logInboundCall } from './telephony/exotel.js';

export const app = Fastify({
  logger: {
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  },
});

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || `localhost:${PORT}`;

// In-memory registry of active simulated sessions for the web tester
const activeSimulators = new Map<string, VoiceSession>();

// Register WebSocket plugin
await app.register(fastifyWebsocket);

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
 * Health check and configuration status (compatible with Exotel dashboard testing)
 */
app.get('/health', async (request: FastifyRequest) => {
  const isTls = request.headers['x-forwarded-proto'] === 'https';
  const websocketUrl = getCanonicalStreamUrl(request.headers.host, isTls);
  return {
    status: 'ok',
    websocket: websocketUrl,
    timestamp: new Date().toISOString(),
    provider: process.env.TELEPHONY_PROVIDER || 'exotel',
    services: {
      deepgram: Boolean(process.env.DEEPGRAM_API_KEY && process.env.DEEPGRAM_API_KEY !== 'your_deepgram_api_key_here'),
      openrouter: Boolean(process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_API_KEY !== 'your_openrouter_api_key_here'),
      sarvam: Boolean(process.env.SARVAM_API_KEY && process.env.SARVAM_API_KEY !== 'your_sarvam_api_key_here'),
      googleSheets: Boolean(process.env.GOOGLE_SHEET_ID && process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL),
    },
  };
});

/**
 * 1. Telephony Webhook: ALL /incoming-call
 * Accepts inbound calls from Exotel & Twilio, validates signature, logs caller data,
 * and guarantees a 200 OK Voice XML / TwiML response.
 */
app.all('/incoming-call', async (request: FastifyRequest, reply: FastifyReply) => {
  const isTls = request.headers['x-forwarded-proto'] === 'https';
  const streamUrl = getCanonicalStreamUrl(request.headers.host, isTls);

  // Extract carrier signature and metadata
  const exotelSig = (request.headers['x-exotel-signature'] || request.headers['x-twilio-signature']) as string | undefined;
  const body = (request.body || {}) as any;
  const query = (request.query || {}) as any;

  const callerFrom = body.From || body.from || body.CallFrom || query.From || query.from || query.CallFrom || 'Unknown';
  const callTo = body.To || body.to || body.CallTo || query.To || query.to || query.CallTo || process.env.EXOTEL_PHONE_NUMBER || 'ExoPhone';
  const callSid = body.CallSid || body.call_sid || body.Sid || query.CallSid || query.call_sid || `call_${Date.now()}`;

  // Log every inbound call
  logInboundCall({
    from: callerFrom,
    to: callTo,
    callSid,
    direction: 'inbound',
  });

  // Verify signature if provided or in production
  if (exotelSig) {
    const isValid = verifyExotelSignature(exotelSig, body);
    if (!isValid && process.env.NODE_ENV === 'production') {
      app.log.warn({ callSid }, '[Exotel] Signature verification failed in production');
      reply.code(401);
      return reply.send('Unauthorized: Invalid Exotel Signature');
    }
  }

  // Always return HTTP 200 + valid XML
  const twiml = buildStreamResponse(streamUrl);
  reply.header('Content-Type', 'text/xml');
  return reply.code(200).send(twiml);
});

/**
 * 2. Telephony Media Stream: GET /media-stream
 * Handles the live bidirectional 8kHz G.711 mulaw WebSocket stream.
 */
app.get('/media-stream', { websocket: true }, (socket: WebSocket, req: FastifyRequest) => {
  app.log.info({ ip: req.ip }, '[MediaStream] Incoming telephony WebSocket connected');
  new VoiceSession(socket);
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
 */
app.get('/audio/:filename', async (request: FastifyRequest<{ Params: { filename: string } }>, reply) => {
  const { filename } = request.params;
  const safeFilename = path.basename(filename);
  let audioPath = path.resolve(process.cwd(), 'public', 'audio', safeFilename);
  if (!fs.existsSync(audioPath)) {
    audioPath = path.resolve(process.cwd(), safeFilename);
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

app.post('/api/sarvam/key', async (request: FastifyRequest<{ Body: { apiKey: string } }>, reply) => {
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
        model: 'bulbul:v3',
      }),
      signal: AbortSignal.timeout(6000),
    });

    if (res.ok) {
      process.env.SARVAM_API_KEY = apiKey.trim();
      const envPath = path.resolve(process.cwd(), '.env');
      if (fs.existsSync(envPath)) {
        let content = fs.readFileSync(envPath, 'utf8');
        if (content.includes('SARVAM_API_KEY=')) {
          content = content.replace(/SARVAM_API_KEY=.*/, `SARVAM_API_KEY=${apiKey.trim()}`);
        } else {
          content += `\nSARVAM_API_KEY=${apiKey.trim()}\n`;
        }
        fs.writeFileSync(envPath, content, 'utf8');
      }
      return { success: true, message: 'Sarvam API key verified and updated successfully!' };
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

  const agentName = 'Priya';
  session.setAgentName('Priya');

  // Reset any cached qualifier so each simulated call starts completely clean
  clearQualifier();

  // Check caller memory context
  const memory = getCallerMemory(callerNumber);
  const greetingText = memory.isReturningCaller
    ? `Hello! Welcome back to Mittal Palms. This is ${agentName}. Wonderful to connect with you again! Are you looking to schedule your site walkthrough with Raghavendra, or did you have more questions about our ready homes?`
    : `Hello! This is ${agentName} from Mittal Palms in Jakkur. Thanks for calling! We have ready-to-move 2 and 3 BHK homes here with Occupancy Certificate received. Are you looking for a 2 BHK or a 3 BHK for your family?`;

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

    const agentName = 'Priya';
    session.setAgentName('Priya');

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

  reply.header('Content-Type', 'text/html');
  return reply.send(html);
});

// Redirect root to /admin for intuitive developer experience
app.get('/', async (request, reply) => {
  return reply.redirect('/admin');
});

// Start the server
async function startServer() {
  if (process.env.VERCEL) {
    console.warn(
      '\n⚠️  [TELEPHONY WARNING] Vercel does not support persistent WebSockets. Use Railway/Render or cloudflared tunnel. Telephony will fail.\n'
    );
  }

  try {
    await app.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`\n======================================================`);
    console.log(`🚀 Getmore.OS Real Estate Voice AI Server Active!`);
    console.log(`📡 Inbound Telephony Webhook: http://${HOST}/incoming-call`);
    console.log(`🎙️ Media Stream WebSocket:   ws://${HOST}/media-stream`);
    console.log(`📊 Admin Console & Tester:   http://${HOST}/admin`);
    console.log(`======================================================\n`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
if (process.env.VERCEL) {
  console.warn(
    '\n⚠️  [TELEPHONY WARNING] Vercel does not support persistent WebSockets. Use Railway/Render or cloudflared tunnel. Telephony will fail.\n'
  );
}

if (!isServerless) {
  startServer();
}

export default async function handler(req: any, res: any) {
  await app.ready();
  app.server.emit('request', req, res);
}
