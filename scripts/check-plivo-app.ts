import 'dotenv/config';
import { plivoClient } from '../src/pipeline/transfer.js';

async function checkPlivoApp() {
  if (!plivoClient) return;
  const appId = process.env.PLIVO_APP_ID || '17370092272385353';
  const app: any = await plivoClient.applications.get(appId);
  console.log('Plivo App:', {
    appId: app.appId,
    appName: app.appName,
    answerUrl: app.answerUrl,
    answerMethod: app.answerMethod,
    hangupUrl: app.hangupUrl,
    hangupMethod: app.hangupMethod,
    fallbackAnswerUrl: app.fallbackAnswerUrl
  });

  const numbers: any = await plivoClient.numbers.list();
  console.log('Plivo Numbers count:', numbers?.length);
  for (const n of numbers) {
    console.log(`Number: ${n.number} | AppID: ${n.appId} | Carrier: ${n.carrier} | Alias: ${n.alias}`);
  }
}

checkPlivoApp().catch(console.error);
