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
 * Health check and configuration status
 */
app.get('/health', async () => {
  return {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    services: {
      deepgram: Boolean(process.env.DEEPGRAM_API_KEY && process.env.DEEPGRAM_API_KEY !== 'your_deepgram_api_key_here'),
      groq: Boolean(process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== 'your_groq_api_key_here'),
      cartesia: Boolean(process.env.CARTESIA_API_KEY && process.env.CARTESIA_API_KEY !== 'your_cartesia_api_key_here'),
      googleSheets: Boolean(process.env.GOOGLE_SHEET_ID && process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL),
    },
  };
});

/**
 * 1. Telephony Webhook: POST /incoming-call
 * Returns TwiML / Voice XML compatible with Twilio and Exotel.
 */
app.all('/incoming-call', async (request: FastifyRequest, reply: FastifyReply) => {
  const reqHost = request.headers.host || HOST;
  const protocol = request.headers['x-forwarded-proto'] === 'https' ? 'wss' : 'ws';
  const streamUrl = `${protocol}://${reqHost}/media-stream`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}"/>
  </Connect>
</Response>`;

  reply.header('Content-Type', 'text/xml');
  return reply.send(twiml);
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
    { model: 'bulbul:v3', speaker: 'priya' },
    { model: 'bulbul:v4-flash', speaker: 'shubh_enhi_ads' },
    { model: 'bulbul:v4-flash', speaker: 'simran_en_sales' },
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
app.post('/api/simulator/call', async (request: FastifyRequest<{ Body: { callerNumber?: string; voice?: string } }>) => {
  const callerNumber = request.body?.callerNumber || '+91-9880012345';
  const voice = request.body?.voice || 'dylan_dsouza';
  const streamSid = `sim_stream_${Date.now()}`;

  const session = createVirtualSession(streamSid, callerNumber);

  const isDylan = voice === 'dylan_dsouza';
  const isMale = isDylan || voice === 'shubh' || voice === 'aditya' || voice.includes('deven') || voice.includes('male');
  const agentName = isDylan ? 'Dylan Dsouza' : (isMale ? 'Raghavendra' : 'Priya');
  session.setAgentName(agentName);

  // Reset any cached qualifier so each simulated call starts completely clean
  clearQualifier();

  // Check caller memory context
  const memory = getCallerMemory(callerNumber);
  let greetingText: string;
  if (isDylan) {
    greetingText = "Hi, good morning — am I speaking with Rahul?";
  } else {
    greetingText = memory.isReturningCaller
      ? `Hello! Welcome back to Mittal Palms. This is ${agentName}. Wonderful to connect with you again! Are you looking to schedule your site walkthrough with Raghavendra, or did you have more questions about our homes?`
      : `Hello! This is ${agentName} from Mittal Palms in Jakkur. Thanks for calling! We have ready-to-move 2 and 3 BHK homes here. Are you looking for a 2 BHK or a 3 BHK for your family?`;
  }

  let greetingAudioBase64: string | undefined;
  let audioContentType: string | undefined;
  try {
    const { buffer, contentType } = await synthesizeNeuralSpeech(greetingText, voice);
    if (buffer.length > 0) {
      greetingAudioBase64 = buffer.toString('base64');
      audioContentType = contentType;
    }
  } catch (err: any) {
    app.log.warn({ err: err.message }, 'Could not pre-synthesize greeting audio');
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
        callerNumber?: string;
        history?: any[];
      };
    }>,
    reply
  ) => {
    const body = request.body || ({} as any);
    const streamSid = body.streamSid || `sim_stream_${Date.now()}`;
    const text = body.text || body.transcript || '';
    const voice = body.voice || 'dylan_dsouza';
    const includeAudio = body.includeAudio !== false;
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

    const isDylan = voice === 'dylan_dsouza';
    const isMale = isDylan || voice === 'shubh' || voice === 'aditya' || voice.includes('deven') || voice.includes('male');
    const agentName = isDylan ? 'Dylan Dsouza' : (isMale ? 'Raghavendra' : 'Priya');
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

  reply.header('Content-Type', 'text/html');
  return reply.send(html);
});

// Redirect root to /admin for intuitive developer experience
app.get('/', async (request, reply) => {
  return reply.redirect('/admin');
});

// Start the server
async function startServer() {
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
if (!isServerless) {
  startServer();
}

export default async function handler(req: any, res: any) {
  await app.ready();
  app.server.emit('request', req, res);
}
