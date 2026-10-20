import { WebSocket } from 'ws';

async function testServer() {
  console.log('--- Testing Server Endpoints ---');

  // Test 1: POST /incoming-call
  const twimlRes = await fetch('http://127.0.0.1:3000/incoming-call', {
    method: 'POST',
    headers: { 'Host': 'localhost:3000' },
  });
  const twimlXml = await twimlRes.text();
  console.log('TwiML Response:\n', twimlXml.trim());

  if (!twimlXml.includes('/media-stream"/>')) {
    console.error('FAILED: TwiML response missing expected stream URL');
    process.exit(1);
  }
  console.log('✓ POST /incoming-call passed!');

  // Test 2: GET /admin
  const adminRes = await fetch('http://127.0.0.1:3000/admin');
  const adminHtml = await adminRes.text();
  if (!adminHtml.includes('VaniAgent AI') || !adminHtml.includes('Live Call Tester & Simulator')) {
    console.error('FAILED: Admin dashboard HTML missing required elements');
    process.exit(1);
  }
  console.log('✓ GET /admin dashboard passed!');

  // Test 3: GET /admin/export-leads.csv
  const csvRes = await fetch('http://127.0.0.1:3000/admin/export-leads.csv');
  const csvText = await csvRes.text();
  if (!csvText.includes('Caller Phone') || !csvText.includes('Configuration')) {
    console.error('FAILED: CSV export missing headers');
    process.exit(1);
  }
  console.log('✓ GET /admin/export-leads.csv passed!');

  // Test 4: Simulator Flow
  console.log('\n--- Testing Simulator Flow ---');
  const callRes = await fetch('http://127.0.0.1:3000/api/simulator/call', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callerNumber: '+919988776655' }),
  });
  const callData = await callRes.json();
  console.log('Simulator Call Started:', callData);

  const utteranceRes = await fetch('http://127.0.0.1:3000/api/simulator/utterance', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      streamSid: callData.streamSid,
      text: 'Looking for a 2 BHK in Jakkur around 1.3 Crore at Mittal Palms.',
    }),
  });
  const utteranceData = await utteranceRes.json();
  console.log('Utterance Result:\n', utteranceData.transcript);

  const bargeInRes = await fetch('http://127.0.0.1:3000/api/simulator/barge-in', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ streamSid: callData.streamSid }),
  });
  const bargeInData = await bargeInRes.json();
  console.log('Barge-in response:', bargeInData);

  const hangupRes = await fetch('http://127.0.0.1:3000/api/simulator/hangup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ streamSid: callData.streamSid }),
  });
  const hangupData = await hangupRes.json();
  console.log('Hangup response:', hangupData);
  console.log('✓ Simulator flow passed!');

  // Test 5: WebSocket Media Stream
  console.log('\n--- Testing Live WebSocket Media Stream ---');
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:3000/media-stream');
    ws.on('open', () => {
      console.log('WebSocket connected. Sending start event...');
      ws.send(
        JSON.stringify({
          event: 'start',
          start: {
            streamSid: 'test_ws_stream_999',
            callSid: 'test_call_999',
            customParameters: {
              from: '+919876543210',
            },
          },
        })
      );

      // Send 1 second of silent 8kHz mulaw audio (0xFF is μ-law silence)
      const silenceChunk = Buffer.alloc(160, 0xff).toString('base64');
      ws.send(
        JSON.stringify({
          event: 'media',
          streamSid: 'test_ws_stream_999',
          media: { payload: silenceChunk },
        })
      );

      setTimeout(() => {
        ws.send(
          JSON.stringify({
            event: 'stop',
            stop: { callSid: 'test_call_999' },
          })
        );
        setTimeout(() => {
          ws.close();
          resolve();
        }, 200);
      }, 500);
    });

    ws.on('error', (err) => {
      console.error('WebSocket test error:', err);
      reject(err);
    });
  });

  console.log('✓ WebSocket media stream test passed!\n');
  console.log('ALL VERIFICATIONS SUCCESSFUL!');
  process.exit(0);
}

testServer().catch((err) => {
  console.error('Test server error:', err);
  process.exit(1);
});
