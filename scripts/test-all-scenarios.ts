import 'dotenv/config';
import { ScriptEngine, getScriptGreeting, ScriptStep } from '../src/pipeline/script_engine.js';
import { semanticTurnDetector } from '../src/pipeline/turn_detector.js';
import { synthesizeTelephonyMulaw } from '../src/pipeline/tts.js';

interface TestResult {
  suite: string;
  test: string;
  passed: boolean;
  details: string;
}

const allResults: TestResult[] = [];

function assert(suite: string, test: string, condition: boolean, details: string) {
  allResults.push({ suite, test, passed: condition, details });
  const icon = condition ? '✅' : '❌';
  console.log(`  ${icon} [${test}] ${details}`);
}

async function runAllTests() {
  console.log('\n========================================================================');
  console.log('🧪 RUNNING COMPLETE VERIFICATION SUITE — REAL ESTATE VOICE AGENT');
  console.log('========================================================================\n');

  // =========================================================================
  // SUITE 1: SCRIPT ENGINE LOGIC & CONVERSATIONAL ACKNOWLEDGMENTS
  // =========================================================================
  console.log('--- [SUITE 1] Conversational Qualification Scenarios ---');

  // 1A: Apartment Happy Path
  {
    const engine = new ScriptEngine('Eric Dsouza');
    const turns = [
      { in: 'Yes', check: (r: string) => r.includes('Great to connect with you, Eric!'), desc: 'Greeting acknowledgement' },
      { in: 'yes, I am looking', check: (r: string) => r.includes("That's wonderful! Are you looking for an apartment, plot or villas?"), desc: 'Interest acknowledgement + Q1' },
      { in: 'apartment', check: (r: string) => r.includes('An apartment, excellent! How many bedrooms'), desc: 'Apartment ack + Q2' },
      { in: '3 bedrooms', check: (r: string) => r.includes('3 bedrooms, perfect! Any particular size'), desc: 'Bedrooms ack + Q3' },
      { in: '1600 sq ft', check: (r: string) => r.includes('Noted on the size! Is it for self use'), desc: 'Size ack + Q4' },
      { in: 'self use', check: (r: string) => r.includes('Self use, wonderful! May I know your budget?'), desc: 'Purpose ack + Q5' },
      { in: '1.75 crore', check: (r: string) => r.includes('Got it, noted on the budget! Which location'), desc: 'Budget ack + Q6' },
      { in: 'North Bangalore', check: (r: string) => r.includes('Great location! Are you looking for ready to move in'), desc: 'Location ack + Q7' },
      { in: 'ready to move in', check: (r: string) => r.includes('Ready to move in, excellent! How soon'), desc: 'Status ack + Q8' },
      { in: 'within a month', check: (r: string) => r.includes('Noted on the timeline! Thank you so much for the information'), desc: 'Timeline ack + Wrap-up Q' },
      { in: 'tomorrow afternoon', check: (r: string) => r.includes('Perfect, Eric! We will reach out to you then'), desc: 'Best time ack + Close' },
    ];

    let allPass = true;
    for (const t of turns) {
      const res = engine.getNextScriptLine(t.in);
      if (!t.check(res.response)) {
        allPass = false;
        console.error(`    Mismatch on "${t.in}": got "${res.response}"`);
      }
    }
    assert('Script Engine', 'Apartment Standard Flow', allPass, 'All 11 turns acknowledged and progressed correctly');
    assert('Script Engine', 'Apartment Data Extracted', engine.getData().isLooking === true && engine.getData().bedrooms === '3 bedrooms', 'Data properly captured in engine state');
  }

  // 1B: Villa Flow
  {
    const engine = new ScriptEngine('Eric Dsouza');
    engine.getNextScriptLine('Yes');
    engine.getNextScriptLine('yes');
    const r1 = engine.getNextScriptLine('we are looking for a villa');
    assert('Script Engine', 'Villa Acknowledgment', r1.response.includes('A villa, wonderful choice! How many bedrooms'), `Villa ack verified: "${r1.response}"`);

    const r2 = engine.getNextScriptLine('4 bedrooms');
    assert('Script Engine', '4-Bedrooms Acknowledgment', r2.response.includes('4 bedrooms, spacious! Any particular size'), `4-bed ack verified: "${r2.response}"`);

    const r3 = engine.getNextScriptLine('investment');
    // should skip to budget
    const r4 = engine.getNextScriptLine('purely for investment');
    assert('Script Engine', 'Investment Purpose Ack', r4.response.includes('Investment, great! May I know your budget?'), `Investment ack verified`);
  }

  // 1C: Plot Flow (Should intelligently skip bedrooms!)
  {
    const engine = new ScriptEngine('Eric Dsouza');
    engine.getNextScriptLine('Yes');
    engine.getNextScriptLine('yes, looking');
    const rPlot = engine.getNextScriptLine('looking for a plot');
    assert('Script Engine', 'Plot skips bedrooms to size', rPlot.response.includes('A plot, great investment option! Any particular size in mind?'), `Directly asked size for plot: "${rPlot.response}"`);
  }

  // 1D: Repeat Requests
  {
    const engine = new ScriptEngine('Eric Dsouza');
    engine.getNextScriptLine('Yes');
    engine.getNextScriptLine('yes');
    engine.getNextScriptLine('apartment');
    const rRepeat = engine.getNextScriptLine('can you repeat that please?');
    assert('Script Engine', 'Repeat Query Handling', rRepeat.response.startsWith('Sure! How many bedrooms are you looking for?'), `Cleanly repeated question: "${rRepeat.response}"`);
  }

  // 1E: Presence Checks ("Yes", "I'm here") at information turns
  {
    const engine = new ScriptEngine('Eric Dsouza');
    engine.getNextScriptLine('Yes');
    engine.getNextScriptLine('yes');
    engine.getNextScriptLine('apartment');
    engine.getNextScriptLine('3 bhk');
    engine.getNextScriptLine('1500 sq ft');
    engine.getNextScriptLine('self use');
    // Now on Q5: Budget
    const rYesOnBudget = engine.getNextScriptLine('yes');
    assert('Script Engine', 'Presence Check on Budget', rYesOnBudget.response.includes('Could you share your approximate budget range?'), `Did not skip budget when user said 'yes': "${rYesOnBudget.response}"`);
    assert('Script Engine', 'Preserved Step on Presence', engine.getStep() === ScriptStep.Q5_BUDGET, 'Step remained on Q5_BUDGET');
  }

  // 1F: Opt-Out / Not Interested
  {
    const engine = new ScriptEngine('Eric Dsouza');
    engine.getNextScriptLine('Yes');
    const rOptOut = engine.getNextScriptLine('not interested please don’t call');
    assert('Script Engine', 'Opt-out Detection', rOptOut.shouldClose === true && rOptOut.response.includes('I completely understand. Thank you for your time'), `Polite opt-out verified: "${rOptOut.response}"`);
  }

  // =========================================================================
  // SUITE 2: SEMANTIC TURN DETECTOR & VAD HESITATION GUARDS
  // =========================================================================
  console.log('\n--- [SUITE 2] Semantic Turn Detector & Hesitation Guards ---');

  {
    // Filler sound should be ignored
    const d1 = semanticTurnDetector.evaluateTurn('umm', 0.8);
    assert('Turn Detector', 'Ignore pure filler "umm"', d1.shouldIgnore === true, `Filler correctly flagged to ignore`);

    // Trailing hesitation suffix ("looking for...") should NOT complete turn prematurely
    const d2 = semanticTurnDetector.evaluateTurn('I am looking for', 1.0);
    assert('Turn Detector', 'Incomplete thought with trailing preposition', d2.isLikelyComplete === false, `Flagged as incomplete thought: "${d2.reason}"`);

    // 1-word answer ("Apartment") should complete turn
    const d3 = semanticTurnDetector.evaluateTurn('apartment', 0.6);
    assert('Turn Detector', 'Valid 1-word answer completion', d3.isLikelyComplete === true, `Accepted as valid response`);

    // Multi-word answer ("around 1.5 crore") should complete turn
    const d4 = semanticTurnDetector.evaluateTurn('around 1.5 crore', 1.2);
    assert('Turn Detector', 'Substantive answer completion', d4.isLikelyComplete === true, `Utterance accepted as complete turn`);
  }

  // =========================================================================
  // SUITE 3: AUDIO SYNTHESIS & TTS PRE-WARM ENGINE (Sarvam AI Bulbul)
  // =========================================================================
  console.log('\n--- [SUITE 3] TTS Synthesis & Telephony G.711 Audio ---');

  {
    const testPhrase = 'An apartment, excellent! How many bedrooms are you looking for?';
    const t0 = Date.now();
    let chunkCount = 0;
    let totalBytes = 0;

    const mulaw = await synthesizeTelephonyMulaw(testPhrase, 'ishita', (chunk) => {
      chunkCount++;
      totalBytes += chunk.length;
    });

    const elapsedMs = Date.now() - t0;
    const isValidAudio = (mulaw && mulaw.length > 5000) || totalBytes > 5000;
    assert('TTS Engine', 'Sarvam Bulbul Synthesis', isValidAudio, `Synthesized ${totalBytes || mulaw.length} bytes in ${elapsedMs}ms across ${chunkCount} chunks`);
  }

  // =========================================================================
  // SUITE 4: LIVE PRODUCTION SERVER END-TO-END CALL (Render)
  // =========================================================================
  console.log('\n--- [SUITE 4] Live Production Telephony Call Simulation ---');

  const RENDER_BASE = 'https://mittal-palms-voice-agent.onrender.com';
  const ADMIN_TOKEN = 'mittal_palms_secret_2026';

  try {
    // Check health
    const healthRes = await fetch(`${RENDER_BASE}/health`);
    const health = await healthRes.json();
    assert('Production Server', 'Health Endpoint Active', health.status === 'healthy', `Status: ${health.status}, WebSocket: ${health.websocket}`);

    // Initiate Call
    const callRes = await fetch(`${RENDER_BASE}/api/simulator/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': ADMIN_TOKEN },
      body: JSON.stringify({ callerNumber: '+919035738310', voice: 'ishita' }),
    });
    const callData = await callRes.json();
    assert('Production Server', 'Call Initiation', callData.success === true, `StreamSid: ${callData.streamSid}, Agent: ${callData.agentName}`);

    // Utterance 1: Confirm Identity
    const u1Res = await fetch(`${RENDER_BASE}/api/simulator/utterance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': ADMIN_TOKEN },
      body: JSON.stringify({ streamSid: callData.streamSid, text: 'Yes' }),
    });
    const u1 = await u1Res.json();
    assert('Production Server', 'Turn 1: Identity Confirmation', u1.replyText.includes('Great to connect with you, Eric!'), `Reply: "${u1.replyText}"`);

    // Utterance 2: Confirm Looking
    const u2Res = await fetch(`${RENDER_BASE}/api/simulator/utterance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': ADMIN_TOKEN },
      body: JSON.stringify({ streamSid: callData.streamSid, text: 'yes, I am looking' }),
    });
    const u2 = await u2Res.json();
    assert('Production Server', 'Turn 2: Interest Check', u2.replyText.includes("That's wonderful! Are you looking for an apartment, plot or villas?"), `Reply: "${u2.replyText}"`);

    // Utterance 3: Property Type
    const u3Res = await fetch(`${RENDER_BASE}/api/simulator/utterance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': ADMIN_TOKEN },
      body: JSON.stringify({ streamSid: callData.streamSid, text: 'apartment' }),
    });
    const u3 = await u3Res.json();
    assert('Production Server', 'Turn 3: Property Type Ack', u3.replyText.includes('An apartment, excellent! How many bedrooms are you looking for?'), `Reply: "${u3.replyText}"`);

    // Utterance 4: Close Call
    const uEndRes = await fetch(`${RENDER_BASE}/api/simulator/hangup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': ADMIN_TOKEN },
      body: JSON.stringify({ streamSid: callData.streamSid }),
    });
    const uEnd = await uEndRes.json();
    assert('Production Server', 'Call Teardown & Save', uEnd.success === true, `Session ended and saved to DB cleanly`);

    // Give Render a moment to finish async DB write
    await new Promise((r) => setTimeout(r, 1000));

    // Verify DB Call Record
    const dbCallsRes = await fetch(`${RENDER_BASE}/api/calls?token=${ADMIN_TOKEN}`);
    const dbCalls = await dbCallsRes.json();
    const latestCall = dbCalls && dbCalls[0];
    const hasTranscript = latestCall && latestCall.full_transcript && latestCall.full_transcript.length > 50;
    assert('Production Server', 'Database Persistence & Transcript', hasTranscript, `Latest Call ID #${latestCall?.id} logged with ${latestCall?.full_transcript?.length} chars of transcript`);

  } catch (err: any) {
    assert('Production Server', 'Live Production Tests', false, `Error: ${err.message}`);
  }

  // =========================================================================
  // SUMMARY
  // =========================================================================
  console.log('\n========================================================================');
  const passedCount = allResults.filter((r) => r.passed).length;
  const totalCount = allResults.length;
  console.log(`🏁 TEST RESULTS: ${passedCount}/${totalCount} TESTS PASSED`);
  console.log('========================================================================\n');

  if (passedCount === totalCount) {
    console.log('🎉 ALL SYSTEMS 100% OPERATIONAL & VERIFIED ON PRODUCTION.\n');
  } else {
    console.error('⚠️ SOME TESTS FAILED. CHECK LOGS ABOVE.\n');
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error('Fatal error during test run:', err);
  process.exit(1);
});
