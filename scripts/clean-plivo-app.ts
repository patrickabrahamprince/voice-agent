import 'dotenv/config';
import { plivoClient } from '../src/pipeline/transfer.js';

async function updateApp() {
  if (!plivoClient) return;
  const appId = process.env.PLIVO_APP_ID || '17370092272385353';
  const res = await plivoClient.applications.update(appId, {
    answer_url: 'https://mittal-palms-voice-agent.onrender.com/incoming-call',
    answer_method: 'POST',
    fallback_answer_url: 'https://mittal-palms-voice-agent.onrender.com/incoming-call',
    fallback_method: 'POST',
    hangup_url: 'https://mittal-palms-voice-agent.onrender.com/hangup',
    hangup_method: 'POST',
  });
  console.log('Updated Plivo App successfully:', res);
}

updateApp().catch(console.error);
