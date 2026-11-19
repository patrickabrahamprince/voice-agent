import 'dotenv/config';

interface SimulatorCallResponse {
  success: boolean;
  streamSid: string;
  callerNumber: string;
  callId: number;
  greetingText: string;
  greetingAudioBase64?: string;
  audioContentType?: string;
  agentName: string;
  voice: string;
}

interface SimulatorUtteranceResponse {
  success: boolean;
  replyText: string;
  audioBase64?: string;
  audioContentType?: string;
  transcript?: string;
}

async function runLiveTest() {
  const RENDER_BASE = 'https://mittal-palms-voice-agent.onrender.com';
  const ADMIN_TOKEN = 'mittal_palms_secret_2026';

  console.log('========================================================================');
  console.log('🚀 INITIATING LIVE PRODUCTION TEST ON RENDER (080 6434 8409)');
  console.log(`📡 Production Target: ${RENDER_BASE}`);
  console.log('========================================================================\n');

  // Step 1: Start Call
  const startRes = await fetch(`${RENDER_BASE}/api/simulator/call`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-token': ADMIN_TOKEN,
    },
    body: JSON.stringify({
      callerNumber: '+919035738310',
      voice: 'ishita',
      enableSarvam: true,
    }),
  });

  const callData = (await startRes.json()) as SimulatorCallResponse;
  if (!callData.success) {
    throw new Error('Failed to start call: ' + JSON.stringify(callData));
  }

  const streamSid = callData.streamSid;
  const t0 = Date.now();

  const transcriptEntries: { time: string; speaker: string; text: string; audioBytes?: number; latencyMs?: number }[] = [];

  const initialTime = '+0.0s';
  const greetingAudioLen = callData.greetingAudioBase64 ? Buffer.from(callData.greetingAudioBase64, 'base64').length : 0;
  transcriptEntries.push({
    time: initialTime,
    speaker: callData.agentName || 'Nisha Prasad',
    text: callData.greetingText,
    audioBytes: greetingAudioLen,
  });

  console.log(`[${initialTime}] 📞 Call Connected • Line 080 6434 8409 • Eric Dsouza (+919035738310)`);
  console.log(`[${initialTime}] 👩 ${callData.agentName}: "${callData.greetingText}" (${greetingAudioLen} bytes audio synthesized)\n`);

  // Test Dialogue Turns
  const turns = [
    { text: 'Yes', label: 'Identity Confirmation' },
    { text: 'yes, I am looking', label: 'Interest Check' },
    { text: 'I am looking for an apartment', label: 'Q1: Property Type' },
    { text: '3 bedrooms', label: 'Q2: Bedrooms' },
    { text: 'Around 1500 to 1800 sq ft', label: 'Q3: Size' },
    { text: 'It is for self use', label: 'Q4: Purpose' },
    { text: 'My budget is around 1.5 to 2 crore', label: 'Q5: Budget' },
    { text: 'I prefer North Bangalore, near Hebbal or Jakkur', label: 'Q6: Location' },
    { text: 'Ready to move in', label: 'Q7: Construction Status' },
    { text: 'Within the next 2 to 3 weeks', label: 'Q8: Booking Timeline' },
    { text: 'Tomorrow afternoon between 3 and 4 PM', label: 'Best Time to Reach' },
  ];

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    const elapsedCaller = `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

    transcriptEntries.push({
      time: elapsedCaller,
      speaker: 'Eric Dsouza (Client)',
      text: turn.text,
    });
    console.log(`[${elapsedCaller}] 👤 Eric Dsouza: "${turn.text}"  [${turn.label}]`);

    const turnStart = Date.now();
    const uttRes = await fetch(`${RENDER_BASE}/api/simulator/utterance`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-token': ADMIN_TOKEN,
      },
      body: JSON.stringify({
        streamSid,
        text: turn.text,
        voice: 'ishita',
        includeAudio: true,
        enableSarvam: true,
      }),
    });

    const uttData = (await uttRes.json()) as SimulatorUtteranceResponse;
    const latency = Date.now() - turnStart;
    const elapsedAgent = `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
    const audioLen = uttData.audioBase64 ? Buffer.from(uttData.audioBase64, 'base64').length : 0;

    transcriptEntries.push({
      time: elapsedAgent,
      speaker: 'Nisha Prasad (Agent)',
      text: uttData.replyText,
      audioBytes: audioLen,
      latencyMs: latency,
    });

    console.log(`[${elapsedAgent}] 👩 Nisha Prasad: "${uttData.replyText}" (${latency}ms TTFT, ${audioLen} bytes audio)\n`);

    // Natural 800ms pacing between dialogue turns
    await new Promise((r) => setTimeout(r, 800));
  }

  const totalDuration = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('========================================================================');
  console.log(`🏁 LIVE TEST COMPLETED IN ${totalDuration}s`);
  console.log('========================================================================\n');

  // Print Formatted Transcript
  console.log('### CLIENT-READY TRANSCRIPT:\n');
  console.log('| Time | Speaker | Spoken Utterance | Audio Synthesis |');
  console.log('| :--- | :--- | :--- | :--- |');
  for (const entry of transcriptEntries) {
    const audioInfo = entry.audioBytes ? `✅ Sarvam Bulbul (${entry.audioBytes.toLocaleString()} bytes • ${entry.latencyMs ? entry.latencyMs + 'ms' : 'Cached'})` : '-';
    console.log(`| \`${entry.time}\` | **${entry.speaker}** | ${entry.text} | ${audioInfo} |`);
  }
}

runLiveTest().catch(console.error);
