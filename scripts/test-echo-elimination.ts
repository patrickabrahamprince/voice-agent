import 'dotenv/config';
import WebSocket from 'ws';

function generateMulawChunk(durationMs: number = 20, rms: number = 3200): Buffer {
  const samples = Math.round(durationMs * 8);
  const buf = Buffer.alloc(samples);
  for (let i = 0; i < samples; i++) {
    buf[i] = (i % 2 === 0) ? 0x05 : 0x85;
  }
  return buf;
}

async function runFullTurnTest() {
  console.log('========================================================================');
  console.log('🧪 VERIFYING FULL CALL FLOW: ECHO SUPPRESSION + NATURAL TURN PROGRESSION');
  console.log('========================================================================\n');

  const wsUrl = 'ws://127.0.0.1:3001/media-stream?caller=919738397933';
  const ws = new WebSocket(wsUrl);

  const streamSid = `full_turn_test_${Date.now()}`;
  let audioBytesReceived = 0;
  let clearEventReceived = false;
  let responseToUserReceived = false;

  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  console.log('✔ Connected to telephony WebSocket stream!');

  ws.on('message', (data: any) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.event === 'playAudio' && msg.media?.payload) {
        const chunk = Buffer.from(msg.media.payload, 'base64');
        audioBytesReceived += chunk.length;
      } else if (msg.event === 'clear' || msg.event === 'clearAudio') {
        clearEventReceived = true;
        console.log('❌ RECEIVED CLEAR EVENT');
      }
    } catch {}
  });

  // Step 1: Start Call
  console.log('--- Step 1: Call Start & Greeting ---');
  ws.send(
    JSON.stringify({
      event: 'start',
      streamSid,
      start: {
        streamSid,
        callId: `test_call_${Date.now()}`,
        customParameters: { Caller: '+919738397933' },
      },
    })
  );

  // Wait 400ms then inject echo
  await new Promise((r) => setTimeout(r, 400));
  console.log('--- Step 2: Injecting Carrier Acoustic Echo during Agent Speech ---');
  const echoChunk = generateMulawChunk(20, 3200);
  for (let i = 0; i < 20; i++) {
    ws.send(
      JSON.stringify({
        event: 'media',
        streamSid,
        media: { payload: echoChunk.toString('base64') },
      })
    );
    await new Promise((r) => setTimeout(r, 20));
  }

  // Wait until Priya finishes greeting
  console.log('Waiting for Priya to finish speaking...');
  await new Promise((r) => setTimeout(r, 6500));

  const initialAudioBytes = audioBytesReceived;
  console.log(`Priya greeting finished. Total bytes received: ${initialAudioBytes}`);
  console.log(`False barge-in received during speech: ${clearEventReceived}`);

  // Step 3: Now caller speaks naturally
  console.log('\n--- Step 3: Caller Speaks: "How far is this from HSR layout?" ---');
  ws.send(
    JSON.stringify({
      event: 'user_utterance',
      streamSid,
      text: 'How far is this from HSR layout?',
    })
  );

  // Wait for Priya to answer
  await new Promise((r) => setTimeout(r, 5000));

  const followUpBytes = audioBytesReceived - initialAudioBytes;
  console.log(`Priya follow-up speech bytes received: ${followUpBytes}`);

  if (!clearEventReceived && initialAudioBytes > 20000 && followUpBytes > 20000) {
    console.log('\n🎉 PASS: Full flow verified! Zero echo breaking, and Priya answered caller smoothly!');
  } else {
    console.log('\n❌ FAIL: Full turn test failed.');
    process.exit(1);
  }

  ws.close();
}

runFullTurnTest().catch((e) => {
  console.error('Test error:', e);
  process.exit(1);
  ws.close();
});
