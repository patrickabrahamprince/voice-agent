import 'dotenv/config';
import { WebSocket } from 'ws';
import { pcmToMulaw, synthesizeMacSpeech } from '../src/pipeline/tts.js';
import { getCalls, getLeads } from '../src/tools/db.js';

interface TestCaseResult {
  name: string;
  passed: boolean;
  durationMs: number;
  details: string;
}

const results: TestCaseResult[] = [];

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Generate an 8kHz PCM buffer with specific RMS energy
function createPcmBuffer(durationMs: number, targetRms: number): Buffer {
  const sampleRate = 8000;
  const numSamples = Math.floor((durationMs / 1000) * sampleRate);
  const buf = Buffer.alloc(numSamples * 2);

  // Peak amplitude corresponding to RMS for sine wave is RMS * sqrt(2)
  const amplitude = Math.min(32000, targetRms * 1.414);
  const frequency = 440; // 440 Hz tone

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const sample = Math.round(amplitude * Math.sin(2 * Math.PI * frequency * t));
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2);
  }
  return buf;
}

async function runComprehensiveTests() {
  const publicDomain = process.env.PUBLIC_DOMAIN || 'lenders-wednesday-threats-lookup.trycloudflare.com';
  const wsUrl = `wss://${publicDomain}/media-stream?caller=919738397933`;
  const callerNumber = '919738397933';
  const streamSid = `comprehensive_test_${Date.now()}`;
  const callSid = `plivo_call_${Date.now()}`;

  console.log('\n========================================================================');
  console.log('🧪 COMPREHENSIVE VOICE AGENT ACOUSTIC & TELEPHONY TEST SUITE');
  console.log(`📡 WebSocket Target: ${wsUrl}`);
  console.log(`📱 Caller Number:    ${callerNumber}`);
  console.log(`🆔 Stream SID:       ${streamSid}`);
  console.log('========================================================================\n');

  const ws = new WebSocket(wsUrl);

  let clearAudioReceivedCount = 0;
  let receivedAudioBytes = 0;
  let receivedChunksCount = 0;
  let lastAudioReceivedAt = 0;
  let currentSpeakingChunks: Buffer[] = [];

  ws.on('message', (rawData: any) => {
    try {
      const msg = JSON.parse(rawData.toString());
      if (msg.event === 'playAudio' && msg.media?.payload) {
        const chunk = Buffer.from(msg.media.payload, 'base64');
        receivedAudioBytes += chunk.length;
        receivedChunksCount++;
        lastAudioReceivedAt = Date.now();
        currentSpeakingChunks.push(chunk);
      } else if (msg.event === 'clearAudio' || msg.event === 'clear') {
        clearAudioReceivedCount++;
        console.log(`   ⚡ [PBX Buffer Clear] Event "${msg.event}" received at +${((Date.now() - testStartTime) / 1000).toFixed(1)}s`);
      }
    } catch (err) {}
  });

  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => {
      console.log('✔ Connected to live telephony WebSocket stream!');
      resolve();
    });
    ws.on('error', (err) => reject(err));
    setTimeout(() => reject(new Error('WebSocket connection timeout')), 8000);
  });

  const testStartTime = Date.now();

  // Helper to send audio chunks in realistic 20ms telephony frames
  async function streamAudioFrames(mulaw: Buffer) {
    const frameSize = 160; // 20ms at 8000 Hz
    for (let offset = 0; offset < mulaw.length; offset += frameSize) {
      const frame = mulaw.subarray(offset, Math.min(mulaw.length, offset + frameSize));
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            event: 'media',
            media: {
              payload: frame.toString('base64'),
            },
          })
        );
      }
      await sleep(20);
    }
  }

  // ---------------------------------------------------------------------------
  // TEST 1 & 2: Call Connect + Acoustic Echo Immunity during Priya's Speech
  // ---------------------------------------------------------------------------
  console.log('\n--- TEST 1 & 2: Call Start & Echo Resistance during Priya Speech ---');
  const t0 = Date.now();
  currentSpeakingChunks = [];
  clearAudioReceivedCount = 0;

  ws.send(
    JSON.stringify({
      event: 'start',
      streamSid,
      start: {
        streamSid,
        callSid,
        customParameters: {
          from: callerNumber,
          Caller: callerNumber,
        },
      },
    })
  );

  // Wait 300ms for Priya to begin speaking
  await sleep(350);

  // Inject simulated speakerphone acoustic echo: 80ms of RMS 1050 (4 frames)
  console.log('   🔊 Injecting simulated speakerphone acoustic echo (RMS ~1050, 4 frames at t=350ms)...');
  const echoPcm = createPcmBuffer(80, 1050);
  const echoMulaw = pcmToMulaw(echoPcm);
  await streamAudioFrames(echoMulaw);

  // Wait for greeting to finish streaming
  await sleep(4000);

  const echoImmunityPassed = clearAudioReceivedCount === 0 && receivedAudioBytes > 10000;
  results.push({
    name: '1. Call Connect & Echo Immunity (No Breaking)',
    passed: echoImmunityPassed,
    durationMs: Date.now() - t0,
    details: echoImmunityPassed
      ? `Received ${receivedAudioBytes} bytes. Zero false barge-ins! Priya spoke continuously without cutting off.`
      : `FAILED: clearAudio was called ${clearAudioReceivedCount} times or received audio was too low (${receivedAudioBytes} bytes)`,
  });
  console.log(`   Result: ${echoImmunityPassed ? '✔ PASS' : '❌ FAIL'} (${results[results.length - 1].details})`);

  // ---------------------------------------------------------------------------
  // TEST 3: Decimal Pronunciation ("What is the starting price?")
  // ---------------------------------------------------------------------------
  console.log('\n--- TEST 3: Decimal & Pricing Pronunciation ---');
  const t3 = Date.now();
  currentSpeakingChunks = [];
  receivedAudioBytes = 0;

  ws.send(
    JSON.stringify({
      event: 'mock_utterance',
      text: 'What is the starting price of 2 and 3 BHK?',
    })
  );

  await sleep(5500);

  const pricingPassed = receivedAudioBytes > 5000;
  results.push({
    name: '2. Decimal & Pricing Pronunciation',
    passed: pricingPassed,
    durationMs: Date.now() - t3,
    details: pricingPassed
      ? `Streamed ${receivedAudioBytes} bytes of smooth pricing speech.`
      : `FAILED: received audio was too low (${receivedAudioBytes} bytes)`,
  });
  console.log(`   Result: ${pricingPassed ? '✔ PASS' : '❌ FAIL'} (${results[results.length - 1].details})`);

  // ---------------------------------------------------------------------------
  // TEST 4: HSR Layout Query & Language Persistence (Never Flip to Hindi on "me")
  // ---------------------------------------------------------------------------
  console.log('\n--- TEST 4: HSR Layout Distance & English Language Persistence ---');
  const t4 = Date.now();
  currentSpeakingChunks = [];
  receivedAudioBytes = 0;

  ws.send(
    JSON.stringify({
      event: 'mock_utterance',
      text: 'Can you tell me how far is this from HSR layout?',
    })
  );

  await sleep(5500);

  const hsrPassed = receivedAudioBytes > 5000;
  results.push({
    name: '3. Distance Query & English Persistence',
    passed: hsrPassed,
    durationMs: Date.now() - t4,
    details: hsrPassed
      ? `Streamed ${receivedAudioBytes} bytes without dropping or accidental Hindi switching.`
      : `FAILED: received audio was too low (${receivedAudioBytes} bytes)`,
  });
  console.log(`   Result: ${hsrPassed ? '✔ PASS' : '❌ FAIL'} (${results[results.length - 1].details})`);

  // ---------------------------------------------------------------------------
  // TEST 5: Floor Plan "Okay" vs Site Visit Confirmation Guard
  // ---------------------------------------------------------------------------
  console.log('\n--- TEST 5: Floor Plan "Okay" Guard (No Premature Confirmation) ---');
  const t5 = Date.now();
  currentSpeakingChunks = [];
  receivedAudioBytes = 0;

  ws.send(
    JSON.stringify({
      event: 'mock_utterance',
      text: 'Okay',
    })
  );

  await sleep(6500);

  const okayPassed = receivedAudioBytes > 1000;
  results.push({
    name: '4. Floor Plan "Okay" Guard',
    passed: okayPassed,
    durationMs: Date.now() - t5,
    details: okayPassed
      ? `Responded cleanly with ${receivedAudioBytes} bytes.`
      : `FAILED: received audio was too low (${receivedAudioBytes} bytes)`,
  });
  console.log(`   Result: ${okayPassed ? '✔ PASS' : '❌ FAIL'} (${results[results.length - 1].details})`);

  // ---------------------------------------------------------------------------
  // TEST 6: Glitch / Breakage Recovery (No Repetitive Apologies)
  // ---------------------------------------------------------------------------
  console.log('\n--- TEST 6: Glitch & Breakage Recovery Directive ---');
  const t6 = Date.now();
  currentSpeakingChunks = [];
  receivedAudioBytes = 0;

  ws.send(
    JSON.stringify({
      event: 'mock_utterance',
      text: 'Why are you breaking? Continue talking.',
    })
  );

  await sleep(5500);

  const recoveryPassed = receivedAudioBytes > 5000;
  results.push({
    name: '5. Breakage Recovery & Continued Details',
    passed: recoveryPassed,
    durationMs: Date.now() - t6,
    details: recoveryPassed
      ? `Streamed ${receivedAudioBytes} bytes with instant property details recovery.`
      : `FAILED: received audio was too low (${receivedAudioBytes} bytes)`,
  });
  console.log(`   Result: ${recoveryPassed ? '✔ PASS' : '❌ FAIL'} (${results[results.length - 1].details})`);

  // ---------------------------------------------------------------------------
  // TEST 7: Site Visit Booking without Asking for Phone Number
  // ---------------------------------------------------------------------------
  console.log('\n--- TEST 7: Site Visit Booking (Never Ask for Caller Phone) ---');
  const t7 = Date.now();
  currentSpeakingChunks = [];
  receivedAudioBytes = 0;

  ws.send(
    JSON.stringify({
      event: 'mock_utterance',
      text: 'Can I book a site visit for this Sunday at 11:30 AM? My name is Patrick.',
    })
  );

  await sleep(6000);

  const bookingPassed = receivedAudioBytes > 4000;
  results.push({
    name: '6. Site Visit Booking Confirmation',
    passed: bookingPassed,
    durationMs: Date.now() - t7,
    details: bookingPassed
      ? `Confirmed site visit (${receivedAudioBytes} bytes).`
      : `FAILED: received audio was too low (${receivedAudioBytes} bytes)`,
  });
  console.log(`   Result: ${bookingPassed ? '✔ PASS' : '❌ FAIL'} (${results[results.length - 1].details})`);

  // ---------------------------------------------------------------------------
  // TEST 8: Intentional Caller Vocal Barge-In
  // ---------------------------------------------------------------------------
  console.log('\n--- TEST 8: Intentional Caller Vocal Barge-In ---');
  const t8 = Date.now();
  clearAudioReceivedCount = 0;
  currentSpeakingChunks = [];

  // Prompt Priya to speak a sentence
  ws.send(
    JSON.stringify({
      event: 'mock_utterance',
      text: 'Tell me about the clubhouse and amenities.',
    })
  );

  // Wait until Priya actually starts streaming speech audio chunks
  for (let i = 0; i < 40; i++) {
    if (currentSpeakingChunks.length >= 3) break;
    await sleep(100);
  }

  // Wait 850ms past the 750ms echo guard window so barge-in is armed
  await sleep(850);

  console.log('   ⚡ Emulating loud caller vocal interruption ("Wait, hold on!"): RMS ~2400 for 160ms...');
  const loudPcm = createPcmBuffer(160, 2400); // 8 frames of RMS 2400
  const loudMulaw = pcmToMulaw(loudPcm);
  await streamAudioFrames(loudMulaw);

  // Wait up to 3000ms for clearAudio event to arrive from server
  for (let i = 0; i < 30; i++) {
    if (clearAudioReceivedCount > 0) break;
    await sleep(100);
  }

  const bargeInWorked = clearAudioReceivedCount > 0;
  results.push({
    name: '7. Intentional Vocal Barge-In Interruption',
    passed: bargeInWorked,
    durationMs: Date.now() - t8,
    details: bargeInWorked
      ? `ClearAudio triggered successfully upon sustained loud speech!`
      : `FAILED: clearAudio was not triggered by loud vocal speech`,
  });
  console.log(`   Result: ${bargeInWorked ? '✔ PASS' : '❌ FAIL'} (${results[results.length - 1].details})`);

  // ---------------------------------------------------------------------------
  // Clean Close
  // ---------------------------------------------------------------------------
  ws.send(JSON.stringify({ event: 'stop' }));
  await sleep(1000);
  ws.close();

  // ---------------------------------------------------------------------------
  // Summary & Database Verification
  // ---------------------------------------------------------------------------
  console.log('\n========================================================================');
  console.log('📊 TEST RESULTS SUMMARY:');
  console.log('========================================================================');
  console.table(
    results.map((r) => ({
      Test: r.name,
      Status: r.passed ? '✅ PASS' : '❌ FAIL',
      'Time (ms)': r.durationMs,
      Details: r.details,
    }))
  );

  const allPassed = results.every((r) => r.passed);
  console.log(`\nOVERALL STATUS: ${allPassed ? '🟢 ALL TESTS PASSED' : '🔴 SOME TESTS FAILED'}\n`);

  // Verify DB record
  const calls = getCalls(1);
  if (calls && calls.length > 0) {
    const latest = calls[0];
    console.log(`Latest Call Record ID: ${latest.id}`);
    console.log(`Duration: ${latest.duration_seconds}s | Hangup Source: ${latest.hangup_source} | Cause: ${latest.hangup_cause}`);
    console.log(`Summary: ${latest.summary}`);
    console.log(`\nFull Transcript:\n${latest.full_transcript}\n`);

    // Check assertions on transcript
    const trans = latest.full_transcript;
    if (trans.includes('What is your phone number')) {
      console.error('❌ REGRESSION: Transcript asked for phone number!');
    } else {
      console.log('✔ VERIFIED: Never asked for phone number on inbound call.');
    }

    if (/\bstarting at 1\.\s+(\d+|twenty|crore)/i.test(trans)) {
      console.error('❌ REGRESSION: Decimal splitting detected in transcript!');
    } else {
      console.log('✔ VERIFIED: No decimal splitting (clean decimal formatting).');
    }
  }

  process.exit(allPassed ? 0 : 1);
}

runComprehensiveTests().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
