import 'dotenv/config';
import { plivoClient } from '../src/pipeline/transfer.js';

async function checkNumber() {
  if (!plivoClient) return;
  const num: any = await plivoClient.numbers.get('918064348409');
  console.log('Number full details:', num);
}

checkNumber().catch(console.error);
