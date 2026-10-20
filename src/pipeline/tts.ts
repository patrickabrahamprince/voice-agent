import 'dotenv/config';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { normalizeRealEstateText } from './normalizer.js';

import fs from 'fs';
import path from 'path';

export interface TTSVoiceInfo {
  id: string;
  name: string;
  gender: 'Female' | 'Male';
  accent: string;
  isDefault?: boolean;
  provider: 'sarvam';
}

// Curated Top Sarvam AI Bulbul Voices for Real Estate
export const AVAILABLE_VOICES: TTSVoiceInfo[] = [
  {
    id: 'dylan_dsouza',
    name: '👨 Dylan Dsouza (Sarvam AI Bulbul • Shubh • Default)',
    gender: 'Male',
    accent: 'Bangalore Indian English (Property Advisor)',
    provider: 'sarvam',
    isDefault: true,
  },
  {
    id: 'kavya',
    name: '👩 Priya — Kavya (Sarvam AI Bulbul)',
    gender: 'Female',
    accent: 'Indian English (Warm, Expressive & Conversational)',
    provider: 'sarvam',
    isDefault: false,
  },
  {
    id: 'priya',
    name: '👩 Priya — Priya (Sarvam AI Bulbul • Classic)',
    gender: 'Female',
    accent: 'Indian English (Friendly & Natural)',
    provider: 'sarvam',
    isDefault: false,
  },
  {
    id: 'roopa_en_conversational',
    name: '👩 Priya — Roopa (Sarvam AI Bulbul Flash)',
    gender: 'Female',
    accent: 'Indian English (Natural & Friendly)',
    provider: 'sarvam',
    isDefault: false,
  },
  {
    id: 'simran_en_sales',
    name: '👩 Priya — Simran (Sarvam AI Bulbul Flash)',
    gender: 'Female',
    accent: 'Indian English (Energetic Sales Specialist)',
    provider: 'sarvam',
    isDefault: false,
  },
  {
    id: 'shubh',
    name: '👨 Raghavendra — Shubh (Sarvam AI Bulbul)',
    gender: 'Male',
    accent: 'Indian English (Deep, Confident & Professional)',
    provider: 'sarvam',
    isDefault: false,
  },
  {
    id: 'aditya',
    name: '👨 Raghavendra — Aditya (Sarvam AI Bulbul)',
    gender: 'Male',
    accent: 'Indian English (Authoritative Real Estate Advisor)',
    provider: 'sarvam',
    isDefault: false,
  },
];

// Backwards compatibility alias
export const AVAILABLE_FEMALE_VOICES = AVAILABLE_VOICES;

// In-memory cache for instant playback
const audioCache = new Map<string, { buffer: Buffer; contentType: string }>();

// Preload local Dylan studio WAV files for instant 0ms latency playback
function preloadDylanStudioAudio(): void {
  const mappings: [string, string[]][] = [
    ['dylan_1_greeting.wav', ['Hi, good morning — am I speaking with Rahul?']],
    ['dylan_2_intro.wav', [
      'Hi, I’m Dylan Dsouza, a property advisor. I just wanted to check if you are exploring properties in Bangalore?',
      'Hi, I’m Dylan Dsouza, a property advisor from Bangalore.'
    ]],
    ['dylan_3_permission.wav', [
      'I just need to ask a few quick questions to better understand your requirements — would that be alright?',
      'Great! I just need to ask a few quick questions to better understand your requirements — would that be alright?',
      'Great! May I know your requirements?'
    ]],
    ['dylan_4_config.wav', [
      'Are you looking for a 2 or 3 BHK?'
    ]],
    ['dylan_location.wav', [
      'Understood. And may I know which location in Bangalore you are most interested in?',
      'Mittal Palms is located in Jakkur, North Bangalore, very close to Manyata Tech Park and Hebbal. At the moment, this is our exclusive project. Would that North Bangalore commute work for you?'
    ]],
    ['dylan_intent.wav', [
      'Makes complete sense! Is it for self-use or an investment?'
    ]],
    ['dylan_budget.wav', [
      'And may I know your budget?'
    ]],
    ['dylan_repeat_bhk.wav', [
      'Got it, 3 BHK! We have prime options in North Bangalore near Jakkur and Hebbal. Which area do you prefer?'
    ]],
    ['dylan_repeat_2bhk.wav', [
      'Got it, 2 BHK! We have prime options in North Bangalore near Jakkur and Hebbal. Which area do you prefer?',
      'Got it, 2 BHK! My apologies. For our ready 2 BHKs at Mittal Palms, we have 1235 to 1340 square feet starting around 1.25 Crore. Could we connect tomorrow for a walkthrough?'
    ]],
    ['dylan_5_pitch.wav', [
      'Thank you so much for the information! Mittal Palms is spread across 3.2 acres in Jakkur, offering ready-to-move 2 and 3 BHK residences with a clubhouse and landscaped gardens. I’ll share the complete floor plans with you on WhatsApp so you can take a look. Could we connect tomorrow to discuss this further? Please let me know a suitable time for you.',
      'Mittal Palms is spread across 3.2 acres in Jakkur, offering ready-to-move 2 and 3 BHK residences with a clubhouse and landscaped gardens.',
      'The project is spread across 5 acres with 75% lush open green spaces, offering premium 2 and 3 BHK residences with a clubhouse and sports amenities.',
      'Thank you so much for the information! The project is spread across 5 acres with 75% lush open green spaces, offering premium 2 and 3 BHK residences with a clubhouse and sports amenities. I’ll share the complete floor plans with you on WhatsApp so you can take a look. Could we connect tomorrow to discuss this further? Please let me know a suitable time for you.'
    ]],
    ['dylan_6_callback.wav', [
      'I’ll share the complete details with you on WhatsApp so you can take a look at the floor plans. Could we connect tomorrow to discuss this further? Please let me know a suitable time for you.',
      'I’ll share the complete details with you on WhatsApp so you can take a look at the floor plans. Could we connect tomorrow to discuss this further?',
      'Got it, 2 BHK! My apologies. For our ready 2 BHKs at Mittal Palms, we have 1235 to 1340 square feet starting around 1.25 Crore. Could we connect tomorrow for a walkthrough?',
      'Got it, 3 BHK! For our ready 3 BHKs at Mittal Palms, we have 1750 to 1980 square feet starting around 1.7 Crore. Could we connect tomorrow for a walkthrough?',
      "Understood! I'll share the complete brochure and pricing details on WhatsApp right away. When would be a good time tomorrow for Raghavendra to assist you?"
    ]],
    ['dylan_7_goodbye.wav', [
      'Thank you for your time. Have an amazing day. Goodbye!',
      'Understood, that time is noted! I’ll send the floor plans over WhatsApp right away. Thank you for your time. Have an amazing day. Goodbye!',
      'Thank you so much for your time! Have an amazing day ahead. Goodbye!'
    ]],
    ['dylan_obj_busy.wav', [
      'Completely understand! When would be a convenient time for me to give you a quick callback later today?'
    ]],
    ['dylan_obj_whatsapp.wav', [
      'Absolutely! I will share the brochure on WhatsApp right away. Just to send the right floor plan, are you considering a 2 or 3 BHK?',
      'Got it! I am sending over the floor plans and brochure to your WhatsApp right now. When would be a good time tomorrow for a quick review?'
    ]],
    ['dylan_obj_budget.wav', [
      'Understood! At Mittal Palms, our ready-to-move 2 and 3 BHK residences start from 1.25 Crore onwards. If your budget expands in the future, we\'d be delighted to assist.',
      'Understood! At Mittal Palms, our ready-to-move 2 and 3 BHK residences start from 1.25 Crore onwards. What budget range were you ideally targeting?',
      'Understood! We also have flexible layouts and upcoming phases with convenient payment plans. What budget range were you ideally targeting?',
      'Understood! Our luxury 2 and 3 BHK developments typically begin around 1.25 Crore, but we also partner with quality projects starting closer to 85 Lakhs. Would you like me to share those options on WhatsApp?'
    ]],
    ['dylan_obj_not_interested.wav', [
      'Understood, thank you for letting me know! Are you planning to explore something in the next 6 to 12 months, or should I take this off for now?'
    ]],
    ['dylan_obj_dnc.wav', [
      'I truly apologize for any disturbance. I will mark your number on our Do Not Call list right away. Have a good day.'
    ]],
  ];

  let loadedCount = 0;
  for (const [file, texts] of mappings) {
    const fullPath = path.resolve(process.cwd(), file);
    if (fs.existsSync(fullPath)) {
      try {
        const buffer = fs.readFileSync(fullPath);
        for (const text of texts) {
          const normalized = normalizeRealEstateText(text);
          const item = { buffer, contentType: 'audio/wav' };
          audioCache.set(`sarvam:bulbul:v3:shubh:${normalized}`, item);
          audioCache.set(`sarvam:bulbul:v3:dylan_dsouza:${normalized}`, item);
          audioCache.set(`sarvam:bulbul:v4-flash:dylan_dsouza:${normalized}`, item);
          audioCache.set(`sarvam:bulbul:v4-flash:shubh:${normalized}`, item);
        }
        loadedCount++;
      } catch (err) {}
    }
  }
  console.log(`[Audio Studio] Preloaded ${loadedCount} studio WAV clips into memory cache for instant playback.`);
}
preloadDylanStudioAudio();

// Bulbul v3 speaker set
const BULBUL_V3_SPEAKERS = new Set([
  'kavya',
  'priya',
  'shubh',
  'aditya',
  'ritu',
  'neha',
  'rahul',
  'pooja',
  'rohan',
  'simran',
  'amit',
  'dev',
  'ishita',
  'shreya',
  'ratan',
  'varun',
  'manan',
  'sumit',
  'roopa',
  'kabir',
  'aayan',
  'advait',
  'anand',
  'tanya',
  'tarun',
  'sunny',
  'mani',
  'gokul',
  'vijay',
  'shruti',
  'suhani',
  'mohit',
  'kavitha',
  'rehan',
  'soham',
  'rupali',
]);

/**
 * Synthesizes text into authentic Indian English speech using Sarvam AI Bulbul.
 */
export async function synthesizeNeuralSpeech(
  rawText: string,
  voiceId: string = 'dylan_dsouza'
): Promise<{ buffer: Buffer; contentType: string }> {
  const normalizedText = normalizeRealEstateText(rawText);

  // Map generic legacy IDs to signature Sarvam Bulbul speakers
  let speaker = voiceId;
  if (!speaker || speaker === 'female-priya' || speaker === 'default') speaker = 'kavya';
  if (speaker === 'male-raghavendra' || speaker === 'dylan_dsouza') speaker = 'shubh';
  if (speaker === 'roopa_en_conversational') speaker = 'roopa';

  // Determine model based on speaker
  const model = BULBUL_V3_SPEAKERS.has(speaker) ? 'bulbul:v3' : 'bulbul:v4-flash';
  const isMale = speaker === 'shubh' || speaker === 'aditya' || speaker.includes('deven') || speaker.includes('sarang');
  const cacheKey = `sarvam:${model}:${speaker}:${normalizedText}`;

  if (audioCache.has(cacheKey)) {
    return audioCache.get(cacheKey)!;
  }

  // 1. Sarvam AI Bulbul (Primary Neural TTS)
  const sarvamKey = process.env.SARVAM_API_KEY;
  if (sarvamKey && sarvamKey !== 'your_sarvam_api_key_here') {
    try {
      console.log(`[Sarvam AI] Synthesizing speech (${model} / ${speaker}): "${normalizedText.slice(0, 50)}..."`);

      const res = await fetch('https://api.sarvam.ai/text-to-speech', {
        method: 'POST',
        headers: {
          'api-subscription-key': sarvamKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: normalizedText,
          language_code: 'en-IN',
          speaker,
          model,
          speech_sample_rate: 24000,
          pace: 1.0,
        }),
        signal: AbortSignal.timeout(1500),
      });

      if (res.ok) {
        const data = await res.json();
        const base64Audio = data.audio || data.audios?.[0];
        if (base64Audio) {
          const buf = Buffer.from(base64Audio, 'base64');
          const item = { buffer: buf, contentType: 'audio/wav' };
          audioCache.set(cacheKey, item);
          return item;
        }
      } else {
        const errText = await res.text();
        console.warn(`[Sarvam AI] Speaker ${speaker} (${model}) error:`, errText);
      }
    } catch (err: any) {
      console.warn('[Sarvam AI] Request error, falling back:', err.message);
    }
  }

  // 2. Azure Neural Fallback with +20% brisk speech rate
  try {
    const azureVoice = isMale ? 'en-IN-PrabhatNeural' : 'en-IN-NeerjaNeural';
    const tts = new MsEdgeTTS();
    await tts.setMetadata(azureVoice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);

    const { audioStream } = tts.toStream(normalizedText, {
      rate: '+20%',
      pitch: '+0Hz',
    });

    return await new Promise<{ buffer: Buffer; contentType: string }>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const timer = setTimeout(() => {
        reject(new Error('Edge TTS timed out'));
      }, 1200);

      audioStream.on('data', (chunk: Buffer) => chunks.push(chunk));
      audioStream.on('end', () => {
        clearTimeout(timer);
        const fullBuffer = Buffer.concat(chunks);
        const item = { buffer: fullBuffer, contentType: 'audio/mpeg' };
        if (fullBuffer.length < 500000) {
          audioCache.set(cacheKey, item);
        }
        resolve(item);
      });
      audioStream.on('error', (err: any) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  } catch (err: any) {
    console.warn('[Edge TTS] Fallback failed:', err.message);
    // Return empty audio buffer so response never hangs
    return { buffer: Buffer.alloc(0), contentType: 'audio/wav' };
  }
}

// Pre-warm cache for the initial greeting so the call starts with 0ms audio lag
const DEFAULT_GREETING =
  'Hello! This is Priya from Mittal Palms in Jakkur. Thanks for calling! We have ready-to-move 2 and 3 BHK homes here. Are you looking for a 2 BHK or a 3 BHK for your family?';
synthesizeNeuralSpeech(DEFAULT_GREETING, 'roopa_en_conversational').catch(() => {});
synthesizeNeuralSpeech(DEFAULT_GREETING, 'kavya').catch(() => {});

