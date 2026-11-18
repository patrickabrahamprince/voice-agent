import { isTransferIntent } from '../src/pipeline/transfer.js';

const phrases = [
  'Can Dylan call me back?',
  'Ask Dylan to call me',
  'I want a callback from Dylan',
  'Can you have someone call me back?',
  'Connect me to Dylan',
  'Talk to Dylan',
  'I want to speak with a human',
  'Connect me to a manager',
  'Transfer me to Dylan right now',
  'Please transfer this call'
];

for (const p of phrases) {
  console.log(`"${p}" -> isTransfer: ${isTransferIntent(p)}`);
}
