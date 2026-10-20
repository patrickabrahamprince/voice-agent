import 'dotenv/config';

async function testSarvam() {
  const sarvamKey = process.env.SARVAM_API_KEY || 'sk_xfksrfbc_xi1Vadmo7UhdzQWmVlttfw06';
  console.log('Using Key:', sarvamKey.slice(0, 8) + '...');

  const payloads = [
    {
      name: 'v4-flash with simran_en_sales',
      body: {
        text: 'Hello, this is Priya from Mittal Palms.',
        language_code: 'en-IN',
        speaker: 'simran_en_sales',
        model: 'bulbul:v4-flash',
      }
    },
    {
      name: 'v4-flash with pace 1.2',
      body: {
        text: 'Hello, this is Priya from Mittal Palms.',
        language_code: 'en-IN',
        speaker: 'simran_en_sales',
        model: 'bulbul:v4-flash',
        pace: 1.2
      }
    },
    {
      name: 'v3 default with kavya',
      body: {
        text: 'Hello, this is Priya from Mittal Palms.',
        language_code: 'en-IN',
        speaker: 'kavya',
        model: 'bulbul:v3',
      }
    },
    {
      name: 'v1/v2 default without model',
      body: {
        text: 'Hello, this is Priya from Mittal Palms.',
        language_code: 'en-IN',
      }
    }
  ];

  for (const p of payloads) {
    console.log(`\n--- Testing ${p.name} ---`);
    try {
      const res = await fetch('https://api.sarvam.ai/text-to-speech', {
        method: 'POST',
        headers: {
          'api-subscription-key': sarvamKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(p.body),
        signal: AbortSignal.timeout(6000),
      });

      console.log('HTTP Status:', res.status, res.statusText);
      const text = await res.text();
      try {
        const json = JSON.parse(text);
        if (json.audios) {
          console.log('SUCCESS! audios array length:', json.audios.length, 'first item length:', json.audios[0]?.length);
        } else if (json.audio) {
          console.log('SUCCESS! audio length:', json.audio.length);
        } else {
          console.log('JSON Response:', JSON.stringify(json).slice(0, 300));
        }
      } catch {
        console.log('Raw text:', text.slice(0, 300));
      }
    } catch (err: any) {
      console.error('Fetch error:', err.message);
    }
  }
}

testSarvam();
