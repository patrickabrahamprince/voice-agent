import { QualificationEngine } from '../src/pipeline/qualifier.js';

async function testPostPitchCorrection() {
  const q = new QualificationEngine(10, '+919111222333');
  
  // Advance through qualification
  await q.handleUtterance('Yes speaking');
  await q.handleUtterance('Yes exploring properties');
  await q.handleUtterance('Sure go ahead');
  await q.handleUtterance('I am looking for a 3 BHK');
  await q.handleUtterance('Self-use');
  const pitch = await q.handleUtterance('1.8 to 2 Crore');
  console.log('Pitch Turn:\n', pitch);

  // User correction: "but I asked you for a 2BHK"
  const correction = await q.handleUtterance('but I asked you for a 2BHK');
  console.log('\nUser Correction Turn:\n', correction);
  if (correction.includes('Thank you so much for the information! Mittal Palms is spread across 3.2 acres')) {
    console.error('FAILED: Repeated pitch on 2 BHK correction!');
    process.exit(1);
  }

  // User agreement: "okay"
  const agreement = await q.handleUtterance('okay');
  console.log('\nUser Agreement Turn:\n', agreement);
  if (agreement.includes('Thank you so much for the information! Mittal Palms is spread across 3.2 acres')) {
    console.error('FAILED: Repeated pitch on okay!');
    process.exit(1);
  }

  const finalState = q.getState();
  console.log('\nFinal State:', JSON.stringify(finalState, null, 2));

  if (finalState.config !== '2 BHK') {
    console.error('FAILED: Config was not updated to 2 BHK!');
    process.exit(1);
  }

  if (!finalState.isQualified || finalState.leadQuality !== 'Good Lead') {
    console.error('FAILED: Lead was not marked Good Lead on agreement!');
    process.exit(1);
  }

  console.log('\n✓ Post-pitch correction and agreement test PASSED flawlessly!');
}

testPostPitchCorrection();
