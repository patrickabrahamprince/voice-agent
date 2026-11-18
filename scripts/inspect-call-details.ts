import 'dotenv/config';
import { plivoClient } from '../src/pipeline/transfer.js';

async function inspectCallDetails() {
  if (!plivoClient) return;
  const uuids = [
    '0d5b7a6c-e13b-4ac9-8e27-cfd8fc22749b',
    '201d967b-65f8-499e-bbd6-27bf293edc20',
    '0037cce2-dfd7-4531-902d-894e40870fcc',
    '501cc83a-9ea7-45b4-97e8-6892633ec9be',
    '1d67e973-e739-442d-bf7a-cf0196f8e939'
  ];

  for (const u of uuids) {
    const c: any = await plivoClient.calls.get(u);
    console.log(`\n--- Call UUID: ${u} ---`);
    console.log(`From: ${c.fromNumber} -> To: ${c.toNumber}`);
    console.log(`Duration: ${c.callDuration}s | Total: ${c.totalDuration}s`);
    console.log(`Status: ${c.callStatus} | HangupCause: ${c.hangupCause} (${c.hangupCauseCode})`);
    console.log(`HangupSource: ${c.hangupSource}`);
    console.log(`Init: ${c.initiationTime} | Answer: ${c.answerTime} | End: ${c.endTime}`);
  }
}

inspectCallDetails().catch(console.error);
