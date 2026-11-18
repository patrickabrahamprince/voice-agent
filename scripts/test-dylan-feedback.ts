import 'dotenv/config';
import { llmPipeline, ChatMessage } from '../src/pipeline/llm.js';

async function testDylanFeedback() {
  console.log('====================================================');
  console.log('Testing Priya: AI Persona & 3 BHK Lake-View Accuracy');
  console.log('====================================================\n');

  const cases = [
    {
      title: 'Caller asks if Priya is real',
      text: 'Are you a real person, Priya?',
    },
    {
      title: 'Dylan asks about 3 BHK sizes, pricing, and lake view',
      text: "What are the sizes and what's the current pricing going on for 3 BHK? Do all of them face the lake?",
    },
    {
      title: 'Caller wants to visit today',
      text: 'I just want to visit today at 4 PM',
    },
  ];

  for (const c of cases) {
    console.log(`\n--- Test: ${c.title} ---`);
    console.log(`Caller: "${c.text}"`);

    const history: ChatMessage[] = [
      {
        role: 'assistant',
        content: 'Hello! This is Priya from Trishul Mittal Palms in Jakkur. Are you looking for a 2 BHK or a 3 BHK for your family?',
      },
      {
        role: 'user',
        content: c.text,
      },
    ];

    let fullReply = '';
    const stream = llmPipeline.streamResponse(history, 888, '+919035738310', 'Priya');
    for await (const chunk of stream) {
      fullReply += (fullReply ? ' ' : '') + chunk;
    }

    console.log(`Priya: "${fullReply}"`);
  }
}

testDylanFeedback();
