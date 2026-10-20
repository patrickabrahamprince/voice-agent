import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { synthesizeNeuralSpeech } from '../src/pipeline/tts.js';

async function synthesizeDylanAudio() {
  console.log('--- Synthesizing Dylan Dsouza Voice Audio via Sarvam AI ---');

  const turns = [
    {
      filename: 'dylan_1_greeting.wav',
      text: 'Hi, good morning — am I speaking with Rahul?',
      voice: 'shubh',
      label: 'Stage 1: Greeting & Verification',
    },
    {
      filename: 'dylan_2_intro.wav',
      text: 'Hi Rahul, I’m Dylan Dsouza, a property advisor. I just wanted to check if you are exploring properties in Bangalore?',
      voice: 'shubh',
      label: 'Stage 2: Intro & Hook',
    },
    {
      filename: 'dylan_3_permission.wav',
      text: 'I just need to ask a few quick questions to better understand your requirements — would that be alright?',
      voice: 'shubh',
      label: 'Stage 3: Permission',
    },
    {
      filename: 'dylan_4_config.wav',
      text: 'Are you looking for a 2 or 3 BHK?',
      voice: 'shubh',
      label: 'Stage 4: Q1 Configuration',
    },
    {
      filename: 'dylan_5_pitch.wav',
      text: 'The project is spread across 5 acres with 75% lush open green spaces, offering premium 2 and 3 BHK residences with a clubhouse and sports amenities.',
      voice: 'shubh',
      label: 'Stage 5: Project Pitch',
    },
    {
      filename: 'dylan_6_callback.wav',
      text: 'I’ll share the complete details with you on WhatsApp so you can take a look at the floor plans. Could we connect tomorrow to discuss this further? Please let me know a suitable time for you.',
      voice: 'shubh',
      label: 'Stage 6: WhatsApp & Callback',
    },
    {
      filename: 'dylan_7_goodbye.wav',
      text: 'Thank you for your time. Have an amazing day. Goodbye!',
      voice: 'shubh',
      label: 'Stage 6: Goodbye',
    },
    // Objections
    {
      filename: 'dylan_obj_busy.wav',
      text: 'Completely understand! When would be a convenient time for me to give you a quick callback later today?',
      voice: 'shubh',
      label: 'Objection: Busy / Bad Time',
    },
    {
      filename: 'dylan_obj_whatsapp.wav',
      text: 'Absolutely! I will share the brochure on WhatsApp right away. Just to send the right floor plan, are you considering a 2 or 3 BHK?',
      voice: 'shubh',
      label: 'Objection: Send on WhatsApp Only',
    },
    {
      filename: 'dylan_obj_budget.wav',
      text: 'Understood! We also have flexible layouts and upcoming phases with convenient payment plans. What budget range were you ideally targeting?',
      voice: 'shubh',
      label: 'Objection: Budget Out of Range',
    },
    {
      filename: 'dylan_obj_not_interested.wav',
      text: 'Understood, thank you for letting me know! Are you planning to explore something in the next 6 to 12 months, or should I take this off for now?',
      voice: 'shubh',
      label: 'Objection: Not Interested',
    },
    {
      filename: 'dylan_obj_dnc.wav',
      text: 'I truly apologize for any disturbance. I will mark your number on our Do Not Call list right away. Have a good day.',
      voice: 'shubh',
      label: 'Objection: Hard Rejection / DNC',
    },
  ];

  for (const turn of turns) {
    try {
      console.log(`Synthesizing: "${turn.text}" (Voice: ${turn.voice})...`);
      const result = await synthesizeNeuralSpeech(turn.text, turn.voice);
      const outPath = path.resolve(process.cwd(), turn.filename);
      fs.writeFileSync(outPath, result.buffer);
      console.log(`Saved ${turn.filename} (${result.buffer.length} bytes, ${result.contentType})`);
    } catch (err: any) {
      console.error(`Failed to synthesize ${turn.filename}:`, err.message);
    }
  }

  console.log('\n--- All voice samples successfully synthesized! ---');
}

synthesizeDylanAudio();
