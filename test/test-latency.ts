import { synthesizeNeuralSpeech } from '../src/pipeline/tts.js';

async function benchmark() {
  const text = 'Thank you so much for the information! Mittal Palms is spread across 3.2 acres in Jakkur, offering ready-to-move 2 and 3 BHK residences with a clubhouse and landscaped gardens. I’ll share the complete floor plans with you on WhatsApp so you can take a look. Could we connect tomorrow to discuss this further? Please let me know a suitable time for you.';

  console.time('TTS Lookup');
  const res = await synthesizeNeuralSpeech(text, 'dylan_dsouza');
  console.timeEnd('TTS Lookup');
  console.log('Buffer bytes:', res.buffer.length, 'ContentType:', res.contentType);
}

benchmark();
