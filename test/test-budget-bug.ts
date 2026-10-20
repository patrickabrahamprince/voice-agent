import { QualificationEngine } from '../src/pipeline/qualifier.js';

async function testBudgetBug() {
  const q = new QualificationEngine(1, '+919988776655');
  
  await q.handleUtterance('Yes speaking');
  await q.handleUtterance('Yes looking for property');
  await q.handleUtterance('Sure');
  
  // User says 2 BHK
  const r1 = await q.handleUtterance('2 BHK');
  console.log('After "2 BHK":', r1);
  console.log('State after "2 BHK":', {
    config: q.getState().config,
    budget: q.getState().budget,
    intent: q.getState().intent
  });

  // User says self used
  const r2 = await q.handleUtterance('self used');
  console.log('\nAfter "self used":', r2);
  console.log('State after "self used":', {
    config: q.getState().config,
    budget: q.getState().budget,
    intent: q.getState().intent
  });
}

testBudgetBug();
