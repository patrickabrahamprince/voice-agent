import 'dotenv/config';
import { llmPipeline, ChatMessage } from '../src/pipeline/llm.js';

async function testConsultativeDialogue() {
  console.log('====================================================');
  console.log('Testing Priya Consultative Value-First Sales Flow');
  console.log('====================================================\n');

  const callerPhone = '+919738397933';
  const history: ChatMessage[] = [
    {
      role: 'assistant',
      content: 'Hello! Welcome back to Mittal Palms. This is Priya. Are you looking for a 2 BHK or a 3 BHK for your family?',
    },
  ];

  const userTurns = [
    'I am looking for a 2 BHK bro',
    'repeat that again. Can you tell me more details about the property?',
    'Yeah, can you send it on WhatsApp?',
    'I need to know more information about the property before I book a visit.',
  ];

  for (let i = 0; i < userTurns.length; i++) {
    const userUtterance = userTurns[i];
    console.log(`\n--- Turn ${i + 1} ---`);
    console.log(`Caller: "${userUtterance}"`);

    history.push({ role: 'user', content: userUtterance });

    let fullReply = '';
    const stream = llmPipeline.streamResponse(
      history,
      1234,
      callerPhone,
      'Priya'
    );

    for await (const chunk of stream) {
      fullReply += (fullReply ? ' ' : '') + chunk;
    }

    console.log(`Priya: "${fullReply}"`);
    history.push({ role: 'assistant', content: fullReply });

    // Assertions
    if (i === 0) {
      // Turn 1 should NOT aggressively push site visit
      const hasPrematureVisit = /would you like to schedule a (site )?visit/i.test(fullReply);
      console.log(`  [Check Turn 1] Does not prematurely push site visit: ${!hasPrematureVisit ? 'PASS ✅' : 'FAIL ❌'}`);
    }
    if (i === 1) {
      // Turn 2 should mention amenities or property details
      const mentionsDetails = /(lake|clubhouse|pool|gym|garden|amenities|oc|sq\s*ft)/i.test(fullReply);
      console.log(`  [Check Turn 2] Mentions property amenities/details: ${mentionsDetails ? 'PASS ✅' : 'FAIL ❌'}`);
    }
    if (i === 2) {
      // Turn 3 must fulfill WhatsApp without refusing or saying "visit our site"
      const fulfillsWhatsApp = /(whatsapp|send|brochure|floor plan)/i.test(fullReply) && !/visit our site/i.test(fullReply);
      console.log(`  [Check Turn 3] Fulfills WhatsApp enthusiastically: ${fulfillsWhatsApp ? 'PASS ✅' : 'FAIL ❌'}`);
    }
    if (i === 3) {
      // Turn 4 should NOT push site visit when user said they need more info first
      const respectsBoundary = !/would you like to (schedule|book) a (site )?visit/i.test(fullReply);
      console.log(`  [Check Turn 4] Respects info-first boundary (no visit push): ${respectsBoundary ? 'PASS ✅' : 'FAIL ❌'}`);
    }
  }

  console.log('\n====================================================');
  console.log('Dialogue Test Complete!');
  console.log('====================================================');
}

testConsultativeDialogue().catch(console.error);
