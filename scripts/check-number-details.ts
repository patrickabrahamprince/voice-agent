import 'dotenv/config';
import { plivoClient } from '../src/pipeline/transfer.js';

async function checkNumberDetails() {
  if (!plivoClient) return;
  const numbers: any = await plivoClient.numbers.list();
  console.log('Number full object:', JSON.stringify(numbers[0], null, 2));
}

checkNumberDetails().catch(console.error);
