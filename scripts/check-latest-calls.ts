import 'dotenv/config';
import { plivoClient } from '../src/pipeline/transfer.js';

async function checkRecentCalls() {
  if (!plivoClient) {
    console.error('plivoClient is null');
    return;
  }
  const calls: any = await plivoClient.calls.list({ limit: 15 });
  console.log('Total calls found:', calls.length);
  for (const c of calls) {
    console.log(`UUID: ${c.callUuid} | From: ${c.fromNumber} | Duration: ${c.callDuration}s | Status: ${c.callStatus} | HangupCause: ${c.hangupCause} | Answer: ${c.answerTime} | Init: ${c.initiationTime}`);
  }
}

checkRecentCalls().catch(console.error);
