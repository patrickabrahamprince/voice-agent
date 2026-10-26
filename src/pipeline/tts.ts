import 'dotenv/config';
import { normalizeRealEstateText } from './normalizer.js';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import os from 'os';
import crypto from 'crypto';
import Groq, { toFile } from 'groq-sdk';

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
    name: '👩 Priya — Property Advisor (Sarvam AI Bulbul • Kavya)',
    gender: 'Female',
    accent: 'Bangalore Indian English',
    provider: 'sarvam',
    isDefault: true,
  },
  {
    id: 'roopa',
    name: '👩 Roopa — Sarvam AI Bulbul (Crisp & Direct)',
    gender: 'Female',
    accent: 'Bangalore Indian English',
    provider: 'sarvam',
    isDefault: false,
  },
  {
    id: 'shubh',
    name: '👨 Dylan Dsouza — Property Advisor (Sarvam AI Bulbul • Shubh)',
    gender: 'Male',
    accent: 'Bangalore Indian English',
    provider: 'sarvam',
    isDefault: false,
  },
];

export const AVAILABLE_FEMALE_VOICES = AVAILABLE_VOICES;

// ---------------------------------------------------------------------------
// Bounded LRU cache for WAV audio responses — max 200 entries
// Prevents unbounded memory growth from unique utterances.
// ---------------------------------------------------------------------------
class WavLruCache {
  private cache = new Map<string, { buffer: Buffer; contentType: string }>();
  private readonly maxEntries: number;

  constructor(maxEntries: number = 200) {
    this.maxEntries = maxEntries;
  }

  public get(key: string): { buffer: Buffer; contentType: string } | undefined {
    const val = this.cache.get(key);
    if (val) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, val);
      return val;
    }
    return undefined;
  }

  public set(key: string, value: { buffer: Buffer; contentType: string }): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    this.cache.set(key, value);
  }

  public has(key: string): boolean {
    return this.cache.has(key);
  }
}

const audioCache = new WavLruCache(200);

// ---------------------------------------------------------------------------
// Native macOS High-Quality Indian English Voice Synthesis (Tara / Rishi)
// ---------------------------------------------------------------------------
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

/**
 * Synthesizes speech using Sarvam AI Bulbul as primary engine.
 * Falls back to macOS Tara/Rishi if Sarvam key is missing or exhausted.
 */
export async function synthesizeNeuralSpeech(
  rawText: string,
  voiceId: string = 'kavya'
): Promise<{ buffer: Buffer; contentType: string }> {
  const normalizedText = normalizeRealEstateText(rawText);
  if (!normalizedText.trim()) {
    return { buffer: Buffer.alloc(0), contentType: 'audio/wav' };
  }

  const v4Speaker = (voiceId === 'shubh') ? 'shubh_en_narration' : ((voiceId === 'roopa') ? 'roopa_en_conversational' : 'kavya_hi_conversational');
  const isMale = voiceId === 'shubh' || voiceId === 'aditya' || voiceId === 'dev';
  const model = 'bulbul:v4-flash';
  const cacheKey = `sarvam:${model}:${voiceId}:${normalizedText}`;

  const cached = audioCache.get(cacheKey);
  if (cached) return cached;

  const cachedAny = audioCache.get(`any:${normalizedText}`);
  if (cachedAny) return cachedAny;

  // 1. Primary: Try Sarvam AI Bulbul (v4-flash)
  const sarvamKey = process.env.SARVAM_API_KEY;
  if (sarvamKey && sarvamKey !== 'your_sarvam_api_key_here') {
    try {
      console.log(`[TTS] model=v4-flash chars=${normalizedText.length} speaker=${voiceId}`);

      const res = await fetch('https://api.sarvam.ai/text-to-speech', {
        method: 'POST',
        headers: {
          'api-subscription-key': sarvamKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: normalizedText,
          language_code: 'en-IN',
          speaker: v4Speaker,
          model: 'bulbul:v4-flash',
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
 * Finds the offset of the PCM data within a WAV buffer by scanning for the 'data' chunk header.
 * WAV files can have variable-length headers (fmt extra data, LIST chunks, etc.).
 * Avoids the common bug of hardcoding offset 44 which breaks on non-minimal WAV headers.
 */
function findWavDataOffset(wavBuf: Buffer): number {
  // WAV structure: RIFF(4) + size(4) + WAVE(4), then sub-chunks
  if (wavBuf.length < 12) return 44;
  let offset = 12; // skip RIFF/WAVE header
  while (offset + 8 <= wavBuf.length) {
    const chunkId = wavBuf.toString('ascii', offset, offset + 4);
    const chunkSize = wavBuf.readUInt32LE(offset + 4);
    offset += 8;
    if (chunkId === 'data') {
      return offset; // PCM data starts immediately after this
    }
    // Advance past this chunk's payload, aligned to 2-byte boundary
    offset += chunkSize + (chunkSize % 2);
  }
  return 44; // safe fallback for minimal headers
}

/**
 * Converts 16-bit linear PCM audio buffer to 8kHz G.711 mulaw for telephony PBX.
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
    const mantissa = (sample >> (exponent + 3)) & 0x0f;
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
    const u = ~mulawBuffer[i] & 0xff;
    const t = ((u & 0x0f) << 3) + 0x84;
    const seg = (u & 0x70) >> 4;
    const s = (t << seg) - 0x84;
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

/**
 * 500-Item LRU Cache for 8kHz G.711 mulaw telephony audio.
 */
class MulawLruCache {
  private cache = new Map<string, Buffer>();
  private readonly maxEntries: number;
  private hits = 0;
  private misses = 0;

  constructor(maxEntries: number = 500) {
    this.maxEntries = maxEntries;
  }

  public normalizeKey(text: string): string {
    const clean = text.toLowerCase().trim().replace(/\s+/g, ' ');
    return crypto.createHash('md5').update(clean).digest('hex');
  }

  public get(key: string): Buffer | undefined {
    const val = this.cache.get(key);
    if (val) {
      this.hits++;
      this.cache.delete(key);
      this.cache.set(key, val);
      this.logStats();
      return val;
    }
    this.misses++;
    this.logStats();
    return undefined;
  }

  public set(key: string, buffer: Buffer): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }
    this.cache.set(key, buffer);
  }

  public has(key: string): boolean {
    return this.cache.has(key);
  }

  private logStats(): void {
    const total = this.hits + this.misses;
    const rate = total > 0 ? ((this.hits / total) * 100).toFixed(1) : '0.0';
    console.log(`[TTS CACHE] hit=${this.hits} miss=${this.misses} hitRate=${rate}%`);
  }
}

export const telephonyLruCache = new MulawLruCache(500);

export const TOP_25_PHRASES = [
  "Welcome to Mittal Palms",
  "Pricing starts at one point seven crore rupees all inclusive",
  "Three BHK at Mittal Palms",
  "Jakkur Bangalore",
  "Site walkthrough this Saturday at eleven AM with Raghavendra",
  "Would you like to confirm your site visit",
  "Hello! This is Priya from Mittal Palms in Jakkur. We have ready-to-move two and three BHK homes with Occupancy Certificate received. Are you looking for a two BHK or a three BHK for your family?",
  "Hello! Welcome back to Mittal Palms. Wonderful to connect with you again!",
  "Two BHK pricing starts from one point two five crore rupees all inclusive.",
  "Three BHK pricing starts from one point seven crore rupees all inclusive.",
  "Mittal Palms is located in Jakkur, North Bangalore, very close to Manyata Tech Park and Hebbal.",
  "Full Occupancy Certificate is received, so zero GST and immediate possession.",
  "Our project head Raghavendra at 9945577935 can coordinate directly.",
  "Would Saturday or Sunday suit you best for a site visit?",
  "Thank you for your time. Have an amazing day. Goodbye!",
  "Yes, we have amenities like swimming pool, clubhouse, gymnasium, and landscaped gardens.",
  "The carpet area for two BHK is around twelve hundred square feet.",
  "The carpet area for three BHK is around sixteen hundred square feet.",
  "Raghavendra will call you back with all details.",
  "Sure, what is your preferred time for the walkthrough?",
  "Is Saturday eleven AM good for you?",
  "Is Sunday eleven AM good for you?",
  "May I know your good name please?",
  "Thank you. I have noted your details.",
  "Have a great day ahead!"
];

export async function prewarmTtsCache(): Promise<void> {
  console.log(`[TTS] Pre-warming cache with ${TOP_25_PHRASES.length} top Mittal Palms phrases in background...`);
  for (const phrase of TOP_25_PHRASES) {
    try {
      await synthesizeTelephonyMulaw(phrase, 'kavya');
    } catch (e: any) {
      console.warn(`[TTS Prewarm] Failed for "${phrase.slice(0, 30)}":`, e.message);
    }
  }
  console.log(`[TTS] Cache pre-warming complete. Telephony phrases primed.`);
}

/**
 * Synthesizes speech directly into 8kHz G.711 mulaw format required by Plivo / Telephony PBX.
 * Uses Bulbul v4-flash with Kavya voice. WAV headers are properly parsed before PCM extraction.
 */
export async function synthesizeTelephonyMulaw(
  rawText: string,
  voiceId: string = 'kavya'
): Promise<Buffer> {
  const normalizedText = normalizeRealEstateText(rawText);
  if (!normalizedText.trim()) return Buffer.alloc(0);

  const cacheKey = telephonyLruCache.normalizeKey(normalizedText);
  const cached = telephonyLruCache.get(cacheKey);
  if (cached) return cached;

  console.log(`[TTS] model=v4-flash chars=${normalizedText.length}`);

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
          speaker: (voiceId === 'roopa') ? 'roopa_en_conversational' : ((voiceId === 'shubh') ? 'shubh_en_narration' : 'kavya_hi_conversational'),
          model: 'bulbul:v4-flash',
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
          // Properly parse WAV header — do not assume fixed 44-byte offset
          const dataOffset = findWavDataOffset(wavBuf);
          const pcmBytes = wavBuf.length > dataOffset ? wavBuf.subarray(dataOffset) : wavBuf;
          const mulawBuf = pcmToMulaw(pcmBytes);
          telephonyLruCache.set(cacheKey, mulawBuf);
          return mulawBuf;
        }
      }
    } catch (err: any) {
      console.warn('[Telephony Mulaw] Sarvam 8k synthesis notice:', err.message);
    }
  }

  // Fallback to standard neural speech converted to mulaw
  const { buffer } = await synthesizeNeuralSpeech(normalizedText, voiceId);
  if (buffer && buffer.length > 12) {
    const dataOffset = findWavDataOffset(buffer);
    if (buffer.length > dataOffset) {
      const pcmBytes = buffer.subarray(dataOffset);
      const mulawBuf = pcmToMulaw(pcmBytes);
      telephonyLruCache.set(cacheKey, mulawBuf);
      return mulawBuf;
    }
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

let groqSTTClient: Groq | null = null;

const WHISPER_ARTIFACTS = new Set([
  'thank you.',
  'thank you',
  'thanks for watching.',
  'thanks for watching',
  'bye.',
  'bye',
  'you',
  '.',
  'subtitles by the amara.org community',
]);

/**
 * Ultra-low latency Telephony STT:
 * 1. Primary: Sarvam Saaras v3 STT (~450ms, India's premier Speech-to-Text model)
 * 2. Fallback: Groq whisper-large-v3-turbo (~400ms)
 */
export async function transcribeAudioTelephony(wavBuffer: Buffer): Promise<string> {
  const sarvamKey = process.env.SARVAM_API_KEY;
  if (sarvamKey && sarvamKey !== 'your_sarvam_api_key_here') {
    try {
      const t0 = Date.now();
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(wavBuffer)], { type: 'audio/wav' }), 'telephony.wav');
      form.append('model', 'saaras:v3');
      form.append('language_code', 'en-IN');

      const res = await fetch('https://api.sarvam.ai/speech-to-text', {
        method: 'POST',
        headers: {
          'api-subscription-key': sarvamKey,
        },
        body: form,
        signal: AbortSignal.timeout(3000),
      });

      if (res.ok) {
        const data: any = await res.json();
        const transcript = (data.transcript || '').trim();
        if (transcript.length > 0) {
          console.log(`[Sarvam STT Saaras v3] Transcribed in ${Date.now() - t0}ms: "${transcript}"`);
          return transcript;
        }
      }
    } catch (err: any) {
      console.warn('[Sarvam STT] Notice, falling back to Groq Whisper:', err.message);
    }
  }

  // Fallback: Groq Whisper Large V3 Turbo
  const groqKey = process.env.GROQ_API_KEY;
  if (groqKey && groqKey !== 'your_groq_api_key_here') {
    try {
      if (!groqSTTClient) {
        groqSTTClient = new Groq({ apiKey: groqKey });
      }
      const file = await toFile(wavBuffer, 'telephony.wav', { type: 'audio/wav' });
      const t0 = Date.now();
      const res = await groqSTTClient.audio.transcriptions.create({
        file,
        model: 'whisper-large-v3-turbo',
        language: 'en',
      });
      const transcript = (res.text || '').trim();
      if (transcript.length > 0 && !WHISPER_ARTIFACTS.has(transcript.toLowerCase())) {
        console.log(`[Groq Whisper STT Fallback] Transcribed in ${Date.now() - t0}ms: "${transcript}"`);
        return transcript;
      }
    } catch (err: any) {
      console.warn('[Groq Whisper STT] Notice:', err.message);
    }
  }

  return '';
}

