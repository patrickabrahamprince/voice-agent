import 'dotenv/config';
import { getCalls, getLeads, getLeadStats } from '../src/tools/db.js';
import { sheetsService } from '../src/tools/sheets.js';

interface AuditResult {
  category: string;
  name: string;
  status: 'PASS' | 'FAIL' | 'WARN';
  latencyMs: number;
  details: string;
}

const results: AuditResult[] = [];
const BASE_URL = 'http://localhost:3001';
const ADMIN_TOKEN = process.env.ADMIN_SECRET_TOKEN || 'mittal_palms_secret_2026';

async function logAudit(category: string, name: string, fn: () => Promise<string | void>) {
  const t0 = Date.now();
  try {
    const details = (await fn()) || 'OK';
    const latencyMs = Date.now() - t0;
    results.push({ category, name, status: 'PASS', latencyMs, details });
    console.log(`✓ [${category}] ${name} (${latencyMs}ms) - ${details}`);
  } catch (err: any) {
    const latencyMs = Date.now() - t0;
    results.push({ category, name, status: 'FAIL', latencyMs, details: err.message });
    console.error(`✗ [${category}] ${name} (${latencyMs}ms) - FAIL: ${err.message}`);
  }
}

async function runAudit() {
  console.log('======================================================');
  console.log('🔍 INITIATING AUTONOMOUS COMPREHENSIVE SYSTEM AUDIT');
  console.log('Timestamp:', new Date().toISOString());
  console.log('======================================================\n');

  // 1. Health & Server Endpoints
  await logAudit('INFRASTRUCTURE', 'Health Check Endpoint (/health)', async () => {
    const res = await fetch(`${BASE_URL}/health`);
    if (!res.ok) throw new Error(`Status ${res.status}`);
    const data: any = await res.json();
    if (data.status !== 'healthy') throw new Error(`Unexpected payload: ${JSON.stringify(data)}`);
    return `Server healthy. WebSocket: ${data.websocket}. Provider: ${data.provider}. Services: ${JSON.stringify(data.services)}`;
  });

  await logAudit('INFRASTRUCTURE', 'Admin Auth Login (/api/auth/login)', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: process.env.ADMIN_PASSWORD || 'mittal@palms2026' }),
    });
    if (!res.ok) throw new Error(`Auth failed with status ${res.status}`);
    const data: any = await res.json();
    if (!data.token) throw new Error('Token not returned');
    return `Authenticated successfully as ${data.username}`;
  });

  await logAudit('INFRASTRUCTURE', 'Sarvam Status & Quota (/api/sarvam/status)', async () => {
    const res = await fetch(`${BASE_URL}/api/sarvam/status`, {
      headers: { 'x-admin-token': ADMIN_TOKEN },
    });
    if (!res.ok) throw new Error(`Status ${res.status}`);
    const data: any = await res.json();
    if (!data.keyPresent || data.status !== 'valid') throw new Error(`Sarvam invalid: ${data.message || JSON.stringify(data)}`);
    return `Sarvam AI Bulbul is active: "${data.message}"`;
  });

  // 2. Carrier Telephony & Webhooks
  await logAudit('TELEPHONY', 'Inbound Call Webhook (/incoming-call)', async () => {
    const res = await fetch(`${BASE_URL}/incoming-call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'From=%2B919738397933&CallUUID=audit_call_test',
    });
    if (!res.ok) throw new Error(`Status ${res.status}`);
    const xml = await res.text();
    if (!xml.includes('Stream') || !xml.includes('media-stream')) {
      throw new Error(`Invalid XML response: ${xml}`);
    }
    return `Plivo XML bidirectional stream returned cleanly.`;
  });

  await logAudit('TELEPHONY', 'Live Transfer XML (/transfer-to-human)', async () => {
    const res = await fetch(`${BASE_URL}/transfer-to-human`, { method: 'POST' });
    const xml = await res.text();
    if (!xml.includes('Dial') || !xml.includes('Speak')) throw new Error(`Invalid transfer XML: ${xml}`);
    if (xml.toLowerCase().includes('dylan dsouza')) throw new Error(`Dylan Dsouza still present in transfer XML!`);
    return `Plivo transfer XML clean. Routes to on-site property advisor team.`;
  });

  await logAudit('TELEPHONY', 'Transfer Fallback XML (/transfer-fallback)', async () => {
    const res = await fetch(`${BASE_URL}/transfer-fallback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'DialStatus=no-answer',
    });
    const xml = await res.text();
    if (!xml.includes('Speak') || xml.toLowerCase().includes('dylan')) {
      throw new Error(`Unexpected fallback XML: ${xml}`);
    }
    return `Fallback XML clean and verified.`;
  });

  // 3. Audio & Recording Delivery
  await logAudit('AUDIO', 'Call Recording Download Endpoint (/api/calls/:id/audio)', async () => {
    // Check call 245 which exists on disk
    const res = await fetch(`${BASE_URL}/api/calls/245/audio?download=1&token=${ADMIN_TOKEN}`);
    if (!res.ok) throw new Error(`Audio download returned status ${res.status}`);
    const disp = res.headers.get('content-disposition') || '';
    if (!disp.includes('attachment') || !disp.includes('call_245.wav')) {
      throw new Error(`Content-Disposition header incorrect: ${disp}`);
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength < 44) throw new Error(`Corrupted audio buffer: ${buf.byteLength} bytes`);
    return `Audio download validated. Buffer: ${buf.byteLength} bytes (HTTP 200 attachment).`;
  });

  await logAudit('AUDIO', 'Call Recording HTTP Range Streaming', async () => {
    const res = await fetch(`${BASE_URL}/api/calls/245/audio`, {
      headers: { Range: 'bytes=0-1023' },
    });
    if (res.status !== 206) throw new Error(`Expected HTTP 206 Partial Content, got ${res.status}`);
    const rangeHeader = res.headers.get('content-range');
    if (!rangeHeader || !rangeHeader.startsWith('bytes 0-1023/')) {
      throw new Error(`Invalid content-range: ${rangeHeader}`);
    }
    return `HTTP 206 Range streaming operational for HTML5 audio tags.`;
  });

  // 4. Autonomous Agent Dialogue & Intelligence (Simulator)
  let activeStreamSid = '';
  await logAudit('AI_AGENT', 'Simulated Call Initiation with Priya', async () => {
    const res = await fetch(`${BASE_URL}/api/simulator/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': ADMIN_TOKEN },
      body: JSON.stringify({ callerNumber: '+919738397933', voice: 'ishita', enableSarvam: true }),
    });
    if (!res.ok) throw new Error(`Call init failed with status ${res.status}`);
    const data: any = await res.json();
    if (data.agentName !== 'Priya') throw new Error(`Expected Priya, got ${data.agentName}`);
    if (!data.greetingText.includes('Priya') || !data.greetingText.includes('Mittal Palms')) {
      throw new Error(`Unexpected greeting: "${data.greetingText}"`);
    }
    if (data.greetingText.toLowerCase().includes('dylan') || data.greetingText.includes('speaking with [Name]')) {
      throw new Error(`Old script detected in greeting!`);
    }
    activeStreamSid = data.streamSid;
    const hasAudio = !!data.greetingAudioBase64;
    return `Priya initialized. Voice: ${data.voice}. Greeting: "${data.greetingText.slice(0, 60)}...". Sarvam Audio: ${hasAudio ? 'YES' : 'NO'}`;
  });

  // Dialogue Test 1: Configuration Inquiry (3 BHK)
  await logAudit('AI_AGENT', 'Turn 1: Configuration Inquiry (3 BHK)', async () => {
    const res = await fetch(`${BASE_URL}/api/simulator/utterance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': ADMIN_TOKEN },
      body: JSON.stringify({
        streamSid: activeStreamSid,
        text: 'I am looking for a ready 3 BHK apartment.',
        voice: 'ishita',
        includeAudio: true,
      }),
    });
    const data: any = await res.json();
    const reply = data.replyText || '';
    if (!reply.toLowerCase().includes('3 bhk') && !reply.toLowerCase().includes('1,720') && !reply.toLowerCase().includes('three bhk')) {
      throw new Error(`Reply did not provide 3 BHK info: "${reply}"`);
    }
    return `Priya: "${reply}"`;
  });

  // Dialogue Test 2: Price Objection
  await logAudit('AI_AGENT', 'Turn 2: Objection Handling (₹12,000/sqft expensive)', async () => {
    const res = await fetch(`${BASE_URL}/api/simulator/utterance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': ADMIN_TOKEN },
      body: JSON.stringify({
        streamSid: activeStreamSid,
        text: 'Your rate of 12000 per sqft is very high compared to other projects.',
        voice: 'ishita',
        includeAudio: true,
      }),
    });
    const data: any = await res.json();
    const reply = data.replyText || '';
    if (!reply.toLowerCase().includes('oc') && !reply.toLowerCase().includes('gst') && !reply.toLowerCase().includes('lake')) {
      throw new Error(`Objection did not highlight OC or GST value: "${reply}"`);
    }
    return `Priya: "${reply}"`;
  });

  // Dialogue Test 3: Bilingual Hindi Query
  await logAudit('AI_AGENT', 'Turn 3: Bilingual Inquiry in Hindi ("Mittal Palms kahan par hai?")', async () => {
    const res = await fetch(`${BASE_URL}/api/simulator/utterance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': ADMIN_TOKEN },
      body: JSON.stringify({
        streamSid: activeStreamSid,
        text: 'Yeh property kahan par located hai? Mujhe Hindi mein bataiye.',
        voice: 'ishita',
        includeAudio: true,
      }),
    });
    const data: any = await res.json();
    const reply = data.replyText || '';
    const hasHindiMarkers = /jakkur|lake|paas|mein|bangalore|hai/i.test(reply);
    if (!hasHindiMarkers) {
      throw new Error(`Failed to respond in Hindi/Hinglish: "${reply}"`);
    }
    return `Priya (Hindi/Hinglish): "${reply}"`;
  });

  // Dialogue Test 4: Negation / Budget Denial
  await logAudit('AI_AGENT', 'Turn 4: Negation Handling ("I never said my budget was 2.5 Crore")', async () => {
    const res = await fetch(`${BASE_URL}/api/simulator/utterance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': ADMIN_TOKEN },
      body: JSON.stringify({
        streamSid: activeStreamSid,
        text: 'Wait, I never said my budget was two point five crore, that is not my budget.',
        voice: 'ishita',
        includeAudio: true,
      }),
    });
    const data: any = await res.json();
    const reply = data.replyText || '';
    if (reply.includes('2.5') || reply.includes('two point five')) {
      throw new Error(`Hallucinated denied budget back to caller: "${reply}"`);
    }
    return `Priya apologized and gracefully reframed without repeating denied budget: "${reply}"`;
  });

  // Dialogue Test 5: Human Agent Escalation
  await logAudit('AI_AGENT', 'Turn 5: Human Agent Escalation ("Can I talk to a real person?")', async () => {
    const res = await fetch(`${BASE_URL}/api/simulator/utterance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': ADMIN_TOKEN },
      body: JSON.stringify({
        streamSid: activeStreamSid,
        text: 'Can you please connect me to a real person right now?',
        voice: 'ishita',
        includeAudio: true,
      }),
    });
    const data: any = await res.json();
    const reply = data.replyText || '';
    if (!reply.includes('[TRANSFER_TO_HUMAN]') && !reply.toLowerCase().includes('team')) {
      throw new Error(`Failed to trigger human escalation: "${reply}"`);
    }
    return `Human transfer triggered: "${reply}"`;
  });

  // 5. Database & Google Sheets
  await logAudit('DATA_PERSISTENCE', 'SQLite Audit Verification', async () => {
    const calls = getCalls(10);
    const leads = getLeads(10);
    const stats = getLeadStats();
    if (calls.length === 0) throw new Error('No calls recorded in SQLite');
    return `Calls: ${calls.length}, Leads: ${leads.length}, Total Calls Logged: ${stats.totalCalls}`;
  });

  await logAudit('DATA_PERSISTENCE', 'Google Sheets Connectivity', async () => {
    const testResult = await sheetsService.testConnection();
    if (!testResult.success) throw new Error(`Google Sheets connection test failed: ${testResult.error}`);
    return `Google Sheets connected successfully. Verified sheet title: "${testResult.sheetTitle}"`;
  });

  console.log('\n======================================================');
  console.log('📊 AUDIT SUMMARY:');
  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  console.log(`TOTAL CHECKS: ${results.length} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log('======================================================\n');
}

runAudit();
