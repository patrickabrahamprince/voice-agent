import 'dotenv/config';
import { LLMPipeline, ChatMessage } from '../src/pipeline/llm.js';
import { isTransferIntent } from '../src/pipeline/transfer.js';

async function testDialogue() {
  const llm = new LLMPipeline();

  console.log('\n--- 1. Testing Intent Detection ---');
  const testPhrases = [
    'Can Dylan call me back?',
    'Ask Dylan to call me back please',
    'I want a call back by Dylan',
    'Connect me to Dylan',
    'Talk to Dylan',
    'Transfer me to Dylan right now',
  ];

  for (const phrase of testPhrases) {
    console.log(`Intent check: "${phrase}" => isTransferIntent: ${isTransferIntent(phrase)}`);
  }

  console.log('\n--- 2. Testing LLM Response for Callback Request ---');
  const messages: ChatMessage[] = [
    {
      role: 'assistant',
      content: 'Hello! This is Priya from Trishul Mittal Palms in Jakkur. Are you looking for a 2 BHK or a 3 BHK?'
    },
    {
      role: 'user',
      content: 'Can Dylan call me back?'
    }
  ];

  let fullReply = '';
  for await (const chunk of llm.streamResponse(messages, 9999, '+919876543210', 'Priya')) {
    fullReply += chunk;
  }
  console.log(`LLM Reply to "Can Dylan call me back?":\n"${fullReply.trim()}"`);

  console.log('\n--- 3. Testing LLM Response for Follow-up with Name ---');
  messages.push({ role: 'assistant', content: fullReply.trim() });
  messages.push({ role: 'user', content: 'My name is Sarah' });

  let nameReply = '';
  for await (const chunk of llm.streamResponse(messages, 9999, '+919876543210', 'Priya')) {
    nameReply += chunk;
  }
  console.log(`LLM Reply to "My name is Sarah":\n"${nameReply.trim()}"`);
}

testDialogue().catch(console.error);
