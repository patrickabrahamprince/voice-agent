import { QualificationEngine } from '../src/pipeline/qualifier.js';

async function testFlow() {
  const q = new QualificationEngine(1, '+919988776655');
  console.log('Turn 1 (Greeting):', q.getGreeting());
  
  let r = await q.handleUtterance('Yes speaking, who is this?');
  console.log('Turn 2 (Intro):', r);

  r = await q.handleUtterance('Yes, I am exploring properties in Bangalore');
  console.log('Turn 3 (Permission):', r);

  r = await q.handleUtterance('Sure go ahead');
  console.log('Turn 4 (Config):', r);

  r = await q.handleUtterance('I am looking for a 3 BHK');
  console.log('Turn 5 (Must NOT ask for multiple locations):', r);

  r = await q.handleUtterance('It is for self use with family');
  console.log('Turn 6 (Budget):', r);

  r = await q.handleUtterance('My budget is around 1.8 to 2 Crore');
  console.log('Turn 7 (Pitch):', r);

  r = await q.handleUtterance('Tomorrow 4 PM works');
  console.log('Turn 8 (Confirmation & Goodbye):', r);

  console.log('\nFinal State:', JSON.stringify(q.getState(), null, 2));
}

testFlow();
