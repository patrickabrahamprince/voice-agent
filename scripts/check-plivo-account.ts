import 'dotenv/config';
import { plivoClient } from '../src/pipeline/transfer.js';

async function checkAccount() {
  if (!plivoClient) return;
  const acc: any = await plivoClient.accounts.get();
  console.log('Plivo Account Info:', {
    authId: acc.authId,
    name: acc.name,
    cashCredits: acc.cashCredits,
    accountType: acc.accountType,
    autoRecharge: acc.autoRecharge,
  });
}

checkAccount().catch(console.error);
