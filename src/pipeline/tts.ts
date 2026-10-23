import 'dotenv/config';
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

// Exclusive Voice Provider: Sarvam AI Bulbul (India's Premier Voice AI)
export const AVAILABLE_VOICES: TTSVoiceInfo[] = [
  {
    id: 'kavya',
    name: '👩 Priya — Sarvam AI Bulbul (Kavya • Warm & Conversational)',
    gender: 'Female',
    accent: 'Bangalore Indian English',
    provider: 'sarvam',
    isDefault: true,
  },
  {
    id: 'roopa',
    name: '👩 Priya — Sarvam AI Bulbul (Roopa • Crisp & Direct)',
    gender: 'Female',
    accent: 'Bangalore Indian English',
    provider: 'sarvam',
    isDefault: false,
  },
  {
    id: 'priya',
    name: '👩 Priya — Sarvam AI Bulbul (Priya • Classic)',
    gender: 'Female',
    accent: 'Indian English',
    provider: 'sarvam',
    isDefault: false,
  },
];

export const AVAILABLE_FEMALE_VOICES = AVAILABLE_VOICES;

import { spawn } from 'child_process';
import os from 'os';
import crypto from 'crypto';

// In-memory cache for instant playback
const audioCache = new Map<string, { buffer: Buffer; contentType: string }>();

// Native macOS High-Quality Indian English Voice Synthesis (Tara / Rishi)
function synthesizeMacSpeech(text: string, voiceName: 'Tara' | 'Rishi'): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'darwin') {
      return reject(new Error('Mac say synthesis only available on darwin platform'));
    }
    const id = crypto.randomBytes(8).toString('hex');
    const aiffPath = path.join(os.tmpdir(), `tts_${id}.aiff`);
    const wavPath = path.join(os.tmpdir(), `tts_${id}.wav`);
    const cleanText = text.replace(/["`$]/g, '').trim();

    const say = spawn('say', ['-v', voiceName, cleanText, '-o', aiffPath]);
    say.on('close', (sayCode) => {
      if (sayCode !== 0) return reject(new Error(`say failed with code ${sayCode}`));
      const af = spawn('afconvert', ['-f', 'WAVE', '-d', 'LEI16@24000', aiffPath, wavPath]);
      af.on('close', (afCode) => {
        try { if (fs.existsSync(aiffPath)) fs.unlinkSync(aiffPath); } catch {}
        if (afCode !== 0) return reject(new Error(`afconvert failed with code ${afCode}`));
        try {
          const buf = fs.readFileSync(wavPath);
          try { if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath); } catch {}
          resolve(buf);
        } catch (e) {
          reject(e);
        }
      });
      af.on('error', reject);
    });
    say.on('error', reject);
  });
}

// Preload local studio clips for instant 0ms latency playback
function preloadStudioAudio(): void {
  const mappings: [string, string[], 'kavya'][] = [
    [
      'mittal_greeting_priya.wav',
      [
        'Hello! This is Priya from Mittal Palms in Jakkur. We have ready-to-move 2 and 3 BHK homes with Occupancy Certificate received. Are you looking for a 2 BHK or a 3 BHK for your family?',
        'Hello! This is Priya from Mittal Palms in Jakkur. Thanks for calling! We have ready-to-move 2 and 3 BHK homes here with Occupancy Certificate received. Are you looking for a 2 BHK or a 3 BHK for your family?'
      ],
      'kavya'
    ],
    [
      'mittal_location_priya.wav',
      ['Mittal Palms is located in Jakkur, North Bangalore, very close to Manyata Tech Park and Hebbal. This is our only project. Does that commute work for you?'],
      'kavya'
    ],
    [
      'mittal_pricing_priya.wav',
      ['Our 2 BHKs range from 1.25 to 1.35 Crores, and 3 BHKs range from 1.7 to 1.95 Crores all-inclusive. Full Occupancy Certificate is received, so zero GST and immediate possession.'],
      'kavya'
    ],
    [
      'mittal_visit_priya.wav',
      ['I would love to arrange a private walkthrough for you this weekend. Our project head Raghavendra at 9945577935 can coordinate directly. Would Saturday or Sunday suit you best?'],
      'kavya'
    ],
    [
      'mittal_goodbye_priya.wav',
      ['Thank you for your time. Have an amazing day. Goodbye!'],
      'kavya'
    ]
  ];

  for (const [file, texts, voiceKey] of mappings) {
    let fullPath = path.resolve(process.cwd(), 'public', 'audio', file);
    if (!fs.existsSync(fullPath)) {
      fullPath = path.resolve(process.cwd(), file);
    }
    if (fs.existsSync(fullPath)) {
      try {
        const buffer = fs.readFileSync(fullPath);
        for (const text of texts) {
          const normalized = normalizeRealEstateText(text);
          const item = { buffer, contentType: 'audio/wav' };
          audioCache.set(`sarvam:bulbul:v3:${voiceKey}:${normalized}`, item);
          audioCache.set(`local:${voiceKey}:${normalized}`, item);
          audioCache.set(`any:${normalized}`, item);
        }
      } catch {}
    }
  }
}

preloadStudioAudio();

const BULBUL_V3_SPEAKERS = new Set([
  'kavya',
  'priya',
  'shubh',
  'aditya',
  'roopa',
  'simran',
  'ritu',
  'neha',
  'rahul',
  'pooja',
  'rohan',
  'amit',
  'dev',
  'ishita',
  'shreya',
  'ratan',
  'varun',
  'manan',
  'sumit',
  'kabir',
  'aayan',
  'advait',
  'anand',
  'tanya',
  'tarun',
  'sunny',
]);

/**
 * Synthesizes speech using Sarvam AI Bulbul as primary engine.
 * If Sarvam API key has exhausted credits (HTTP 402) or errors,
 * it seamlessly generates natural Indian English audio via macOS Tara / Rishi.
 */
export async function synthesizeNeuralSpeech(
  rawText: string,
  voiceId: string = 'kavya'
): Promise<{ buffer: Buffer; contentType: string }> {
  const normalizedText = normalizeRealEstateText(rawText);
  if (!normalizedText.trim()) {
    return { buffer: Buffer.alloc(0), contentType: 'audio/wav' };
  }

  // Exclusive Sarvam Bulbul speaker for Priya
  let speaker = 'kavya';
  if (voiceId === 'roopa' || voiceId === 'priya') speaker = voiceId;

  const isMale = false;
  const model = 'bulbul:v3';
  const cacheKey = `sarvam:${model}:${speaker}:${normalizedText}`;

  if (audioCache.has(cacheKey)) {
    return audioCache.get(cacheKey)!;
  }
  if (audioCache.has(`any:${normalizedText}`)) {
    return audioCache.get(`any:${normalizedText}`)!;
  }

  // 1. Primary: Try Sarvam AI Bulbul
  const sarvamKey = process.env.SARVAM_API_KEY;
  if (sarvamKey && sarvamKey !== 'your_sarvam_api_key_here') {
    try {
      console.log(`[Sarvam AI Bulbul] Synthesizing speech (${model} / ${speaker}): "${normalizedText.slice(0, 50)}..."`);

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
        signal: AbortSignal.timeout(8000),
      });

      if (res.ok) {
        const data: any = await res.json();
        const base64Audio = data.audio || data.audios?.[0];
        if (base64Audio) {
          const buf = Buffer.from(base64Audio, 'base64');
          const item = { buffer: buf, contentType: 'audio/wav' };
          audioCache.set(cacheKey, item);
          return item;
        }
      } else {
        const errText = await res.text().catch(() => '');
        console.warn(`[Sarvam AI Bulbul] API Notice (${res.status}): ${errText.slice(0, 120)}`);
      }
    } catch (err: any) {
      console.warn('[Sarvam AI Bulbul] Request notice:', err.message);
    }
  }

  // 2. Fallback: High-Quality macOS Indian English Neural Synthesis (Tara / Rishi)
  if (process.platform === 'darwin') {
    try {
      const macVoice = isMale ? 'Rishi' : 'Tara';
      console.log(`[Neural TTS Fallback] Synthesizing via macOS Indian English Voice (${macVoice}): "${normalizedText.slice(0, 45)}..."`);
      const buffer = await synthesizeMacSpeech(normalizedText, macVoice);
      if (buffer && buffer.length > 0) {
        const item = { buffer, contentType: 'audio/wav' };
        audioCache.set(cacheKey, item);
        return item;
      }
    } catch (macErr: any) {
      console.warn('[Neural TTS Fallback] macOS voice error:', macErr.message);
    }
  }

  return { buffer: Buffer.alloc(0), contentType: 'audio/wav' };
}

/**
 * Converts 16-bit linear PCM audio buffer to 8kHz G.711 mulaw for telephony PBX (Twilio / Exotel).
 */
export function pcmToMulaw(pcm16Buffer: Buffer): Buffer {
  const sampleCount = Math.floor(pcm16Buffer.length / 2);
  const mulaw = Buffer.alloc(sampleCount);
  const BIAS = 0x84;
  for (let i = 0; i < sampleCount; i++) {
    let sample = pcm16Buffer.readInt16LE(i * 2);
    let sign = (sample >> 8) & 0x80;
    if (sign !== 0) sample = -sample;
    if (sample > 32635) sample = 32635;
    sample += BIAS;
    let exponent = 7;
    for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
      exponent--;
    }
    let mantissa = (sample >> (exponent + 3)) & 0x0f;
    mulaw[i] = ~(sign | (exponent << 4) | mantissa) & 0xff;
  }
  return mulaw;
}

/**
 * Converts 8kHz G.711 mulaw telephony audio buffer to standard 16-bit PCM WAV.
 */
export function mulawToWav(mulawBuffer: Buffer): Buffer {
  const pcm = new Int16Array(mulawBuffer.length);
  for (let i = 0; i < mulawBuffer.length; i++) {
    let u = ~mulawBuffer[i] & 0xff;
    let t = ((u & 0x0f) << 3) + 0x84;
    let seg = (u & 0x70) >> 4;
    let s = (t << seg) - 0x84;
    pcm[i] = (u & 0x80) !== 0 ? -s : s;
  }
  const wavHeader = Buffer.alloc(44);
  const dataSize = pcm.byteLength;
  wavHeader.write('RIFF', 0);
  wavHeader.writeUInt32LE(36 + dataSize, 4);
  wavHeader.write('WAVE', 8);
  wavHeader.write('fmt ', 12);
  wavHeader.writeUInt32LE(16, 16);
  wavHeader.writeUInt16LE(1, 20); // PCM format
  wavHeader.writeUInt16LE(1, 22); // mono
  wavHeader.writeUInt32LE(8000, 24); // 8000 Hz sample rate
  wavHeader.writeUInt32LE(16000, 28); // byte rate (8000 * 2)
  wavHeader.writeUInt16LE(2, 32); // block align
  wavHeader.writeUInt16LE(16, 34); // 16-bit
  wavHeader.write('data', 36);
  wavHeader.writeUInt32LE(dataSize, 40);
  return Buffer.concat([wavHeader, Buffer.from(pcm.buffer)]);
}

// In-memory cache for telephony mulaw audio
const telephonyMulawCache = new Map<string, Buffer>();

/**
 * Synthesizes speech directly into 8kHz G.711 mulaw format required by Twilio / Exotel.
 */
export async function synthesizeTelephonyMulaw(
  rawText: string,
  voiceId: string = 'kavya'
): Promise<Buffer> {
  const normalizedText = normalizeRealEstateText(rawText);
  if (!normalizedText.trim()) return Buffer.alloc(0);

  const cacheKey = `mulaw:8k:${voiceId}:${normalizedText}`;
  if (telephonyMulawCache.has(cacheKey)) {
    return telephonyMulawCache.get(cacheKey)!;
  }

  const sarvamKey = process.env.SARVAM_API_KEY;
  if (sarvamKey && sarvamKey !== 'your_sarvam_api_key_here') {
    try {
      const res = await fetch('https://api.sarvam.ai/text-to-speech', {
        method: 'POST',
        headers: {
          'api-subscription-key': sarvamKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: normalizedText,
          language_code: 'en-IN',
          speaker: 'kavya',
          model: 'bulbul:v3',
          speech_sample_rate: 8000,
          pace: 1.0,
        }),
        signal: AbortSignal.timeout(8000),
      });

      if (res.ok) {
        const data: any = await res.json();
        const base64Audio = data.audio || data.audios?.[0];
        if (base64Audio) {
          const wavBuf = Buffer.from(base64Audio, 'base64');
          // WAV data starts at byte 44
          const pcmBytes = wavBuf.length > 44 ? wavBuf.subarray(44) : wavBuf;
          const mulawBuf = pcmToMulaw(pcmBytes);
          telephonyMulawCache.set(cacheKey, mulawBuf);
          return mulawBuf;
        }
      }
    } catch (err: any) {
      console.warn('[Telephony Mulaw] Sarvam 8k synthesis notice:', err.message);
    }
  }

  // Fallback to standard neural speech converted to mulaw
  const { buffer } = await synthesizeNeuralSpeech(normalizedText, voiceId);
  if (buffer && buffer.length > 44) {
    const pcmBytes = buffer.subarray(44);
    const mulawBuf = pcmToMulaw(pcmBytes);
    telephonyMulawCache.set(cacheKey, mulawBuf);
    return mulawBuf;
  }

  return Buffer.alloc(0);
}

/**
 * Transcribes audio buffer using Sarvam AI Saaras v3 STT.
 */
export async function transcribeAudioSarvam(wavBuffer: Buffer): Promise<string> {
  const sarvamKey = process.env.SARVAM_API_KEY;
  if (!sarvamKey || sarvamKey === 'your_sarvam_api_key_here') return '';
  try {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(wavBuffer)], { type: 'audio/wav' }), 'telephony.wav');
    form.append('model', 'saaras:v3');

    const res = await fetch('https://api.sarvam.ai/speech-to-text', {
      method: 'POST',
      headers: {
        'api-subscription-key': sarvamKey,
      },
      body: form,
      signal: AbortSignal.timeout(6000),
    });

    if (res.ok) {
      const data: any = await res.json();
      return (data.transcript || '').trim();
    }
  } catch (err: any) {
    console.warn('[Sarvam STT] Transcription error:', err.message);
  }
  return '';
}

