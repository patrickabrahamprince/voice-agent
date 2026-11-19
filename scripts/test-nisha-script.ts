import 'dotenv/config';
import { ScriptEngine, getScriptGreeting } from '../src/pipeline/script_engine.js';
import { LLMPipeline, ChatMessage } from '../src/pipeline/llm.js';

async function runTest() {
  console.log('\n======================================================');
  console.log('🧪 TESTING NISHA PRASAD QUALIFICATION SCRIPT ENGINE');
  console.log('======================================================\n');

  const greeting = getScriptGreeting('Eric Dsouza');
  console.log(`[Call Start] Nisha Spoke:\n"${greeting}"\n`);

  const engine = new ScriptEngine('Eric Dsouza');
  const dialogueTurns = [
    { caller: 'Yes', label: '1. Confirm Identity' },
    { caller: 'yes, I am looking', label: '2. Confirm Looking' },
    { caller: 'apartment', label: '3. Property Type' },
    { caller: '3 bedrooms', label: '4. Bedrooms' },
    { caller: 'around 1500 sq ft', label: '5. Size' },
    { caller: 'self use', label: '6. Purpose' },
    { caller: '1.5 crore', label: '7. Budget' },
    { caller: 'North Bangalore', label: '8. Location' },
    { caller: 'ready to move in', label: '9. Construction Status' },
    { caller: 'in a month', label: '10. Booking Timeline' },
    { caller: 'tomorrow at 4pm', label: '11. Best Time to Reach' },
  ];

  for (const turn of dialogueTurns) {
    console.log(`[Caller] Eric: "${turn.caller}" (${turn.label})`);
    const result = engine.getNextScriptLine(turn.caller);
    console.log(`[Agent]  Nisha: "${result.response}" (Step: ${result.step}, ShouldClose: ${result.shouldClose || false})\n`);
  }

  console.log('======================================================');
  console.log('🧪 TESTING NISHA PRASAD LLM FALLBACK RESPONSE');
  console.log('======================================================\n');

  const llm = new LLMPipeline();
  const testMessages: ChatMessage[] = [
    {
      role: 'assistant',
      content: greeting,
    },
    {
      role: 'user',
      content: 'Who is this and where are you calling from?',
    },
  ];

  let llmReply = '';
  for await (const chunk of llm.streamResponse(testMessages, 8888, '+919035738310', 'Nisha Prasad')) {
    llmReply += chunk;
  }
  console.log(`[LLM Fallback to "Who is this?"] Nisha reply:\n"${llmReply.trim()}"\n`);

  // Verify no Mittal Palms in LLM reply
  const hasMittal = /mittal|palms|jakkur/i.test(llmReply);
  console.log(`Verify zero Mittal Palms in LLM reply: ${!hasMittal ? '✅ PASSED' : '❌ FAILED'}`);
}

runTest().catch(console.error);
