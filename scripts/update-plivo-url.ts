import 'dotenv/config';
import plivo from 'plivo';

async function updatePlivo() {
  const authId = process.env.PLIVO_AUTH_ID;
  const authToken = process.env.PLIVO_AUTH_TOKEN;
  const appId = process.env.PLIVO_APP_ID || '17370092272385353';
  const publicDomain = process.env.PUBLIC_DOMAIN || 'someone-argued-buy-protect.trycloudflare.com';
  const answerUrl = `https://${publicDomain}/incoming-call`;
  const hangupUrl = `https://${publicDomain}/hangup`;

  console.log(`Updating Plivo App ID ${appId}:\n  answer_url: ${answerUrl}\n  hangup_url: ${hangupUrl}`);
  const client = new plivo.Client(authId, authToken);

  try {
    const res = await client.applications.update(appId, {
      answer_url: answerUrl,
      answer_method: 'POST',
      fallback_answer_url: answerUrl,
      fallback_method: 'POST',
      hangup_url: hangupUrl,
      hangup_method: 'POST',
    });
    console.log('✓ Successfully updated Plivo Application:', res);
  } catch (err: any) {
    console.error('Failed to update Plivo:', err.message);
  }
}

updatePlivo();

