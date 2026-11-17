import 'dotenv/config';
import WebSocket from 'ws';

async function testRenderLiveVoice() {
  console.log('Testing live Render cloud deployment...');
  const wsUrl = 'wss://mittal-palms-voice-agent.onrender.com/media-stream?caller=919738397933';
  const ws = new WebSocket(wsUrl);

  const streamSid = `render_test_${Date.now()}`;
  let audioBytesReceived = 0;

  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  console.log('✔ Connected to wss://mittal-palms-voice-agent.onrender.com/media-stream!');

  ws.on('message', (data: any) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.event === 'playAudio' && msg.media?.payload) {
        const chunk = Buffer.from(msg.media.payload, 'base64');
        audioBytesReceived += chunk.length;
      }
    } catch {}
  });

  ws.send(
    JSON.stringify({
      event: 'start',
      streamSid,
      start: {
        streamSid,
        callId: `render_call_${Date.now()}`,
        customParameters: { Caller: '+919738397933' },
      },
    })
  );

  // Wait 4 seconds for Priya greeting
  await new Promise((r) => setTimeout(r, 4000));
  console.log(`Audio bytes received from Render: ${audioBytesReceived}`);

  if (audioBytesReceived > 10000) {
    console.log('🎉 SUCCESS: Render is streaming Priya live audio in the cloud!');
  } else {
    console.log('⚠️ Warning: Low audio bytes received.');
  }

  ws.close();
}

testRenderLiveVoice().catch(console.error);
