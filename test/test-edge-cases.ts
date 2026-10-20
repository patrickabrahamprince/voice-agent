import { QualificationEngine } from '../src/pipeline/qualifier.js';

async function testEdgeCases() {
  const q = new QualificationEngine(2, '+919888877777');
  
  console.log('Test "can you hear me":');
  console.log('->', await q.handleUtterance('can you hear me?'));

  console.log('\nTest "wait for me to answer":');
  console.log('->', await q.handleUtterance('wait for me to answer my question'));

  console.log('\nTest "where is this property located":');
  console.log('->', await q.handleUtterance('where is this property located?'));

  console.log('\nTest "I am looking for a 3 BHK":');
  console.log('->', await q.handleUtterance('I am looking for a 3 BHK'));
}

testEdgeCases();
