import fs from 'fs';
import path from 'path';

/**
 * Fast lookup / bit-manipulation table to convert 8-bit G.711 mulaw sample to 16-bit linear PCM.
 */
function mulawSampleToInt16(uByte: number): number {
  const u = ~uByte & 0xff;
  const t = ((u & 0x0f) << 3) + 0x84;
  const seg = (u & 0x70) >> 4;
  const s = (t << seg) - 0x84;
  return (u & 0x80) !== 0 ? -s : s;
}

/**
 * Converts a buffer of G.711 mulaw bytes into an Int16Array of PCM samples.
 */
function mulawBufferToInt16(buf: Buffer): Int16Array {
  const pcm = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    pcm[i] = mulawSampleToInt16(buf[i]);
  }
  return pcm;
}

/**
 * Builds standard 44-byte RIFF/WAVE header for 8000Hz 16-bit mono PCM.
 */
function buildWavHeader(dataByteLength: number, sampleRate: number = 8000): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataByteLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
  header.writeUInt16LE(1, 20); // AudioFormat (1 = PCM)
  header.writeUInt16LE(1, 22); // NumChannels (1 = Mono)
  header.writeUInt32LE(sampleRate, 24); // SampleRate (8000)
  header.writeUInt32LE(sampleRate * 2, 28); // ByteRate (8000 * 1 * 16/8 = 16000)
  header.writeUInt16LE(2, 32); // BlockAlign (1 * 16/8 = 2)
  header.writeUInt16LE(16, 34); // BitsPerSample (16)
  header.write('data', 36);
  header.writeUInt32LE(dataByteLength, 40);
  return header;
}

interface AudioChunk {
  offsetSamples: number;
  pcm: Int16Array;
}

const RECORDINGS_DIR = path.resolve(process.cwd(), 'data', 'recordings');
if (!fs.existsSync(RECORDINGS_DIR)) {
  try {
    fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  } catch (err) {
    console.warn('[CallAudioRecorder] Could not create recordings directory:', err);
  }
}

/**
 * High-fidelity linear audio recorder for live telephony calls.
 * Records both caller stream and Priya agent speech, accurately mixing them
 * onto an 8000Hz PCM timeline with saturation guards and outputs standard WAV.
 */
export class CallAudioRecorder {
  private callId: number;
  private startTime: number;
  private chunks: AudioChunk[] = [];
  private sampleRate: number = 8000;
  private isFinalized: boolean = false;

  constructor(callId: number, startTime: number = Date.now()) {
    this.callId = callId;
    this.startTime = startTime;
  }

  /**
   * Records an inbound audio packet from the caller (8kHz G.711 mulaw).
   */
  public recordInboundChunk(mulawBuf: Buffer, timestamp: number = Date.now()): void {
    if (this.isFinalized || !mulawBuf || mulawBuf.length === 0) return;
    const elapsedMs = Math.max(0, timestamp - this.startTime);
    const offsetSamples = Math.floor(elapsedMs * (this.sampleRate / 1000));
    const pcm = mulawBufferToInt16(mulawBuf);
    this.chunks.push({ offsetSamples, pcm });
  }

  /**
   * Records an outbound audio packet from Priya (8kHz G.711 mulaw).
   */
  public recordOutboundChunk(mulawBuf: Buffer, timestamp: number = Date.now()): void {
    if (this.isFinalized || !mulawBuf || mulawBuf.length === 0) return;
    const elapsedMs = Math.max(0, timestamp - this.startTime);
    const offsetSamples = Math.floor(elapsedMs * (this.sampleRate / 1000));
    const pcm = mulawBufferToInt16(mulawBuf);
    this.chunks.push({ offsetSamples, pcm });
  }

  /**
   * Finalizes the recording, mixes timeline audio, writes the WAV file to disk,
   * and returns the public playback URL and file path.
   */
  public async finalize(): Promise<{ filePath: string; url: string; durationSeconds: number }> {
    if (this.isFinalized) {
      const fileName = `call_${this.callId}.wav`;
      const filePath = path.join(RECORDINGS_DIR, fileName);
      return {
        filePath,
        url: `/api/calls/${this.callId}/audio`,
        durationSeconds: Math.max(1, Math.round((Date.now() - this.startTime) / 1000)),
      };
    }
    this.isFinalized = true;

    const durationMs = Math.max(1000, Date.now() - this.startTime);
    const durationSeconds = Math.round(durationMs / 1000);

    // Calculate maximum sample needed
    let maxSampleIdx = Math.ceil(durationMs * (this.sampleRate / 1000));
    for (const chunk of this.chunks) {
      const endIdx = chunk.offsetSamples + chunk.pcm.length;
      if (endIdx > maxSampleIdx) {
        maxSampleIdx = endIdx;
      }
    }

    // Allocate continuous PCM buffer (filled with 0 = silence)
    const masterPcm = new Int16Array(maxSampleIdx);

    // Mix chunks with saturation
    for (const chunk of this.chunks) {
      const offset = chunk.offsetSamples;
      const pcm = chunk.pcm;
      for (let i = 0; i < pcm.length; i++) {
        const target = offset + i;
        if (target < maxSampleIdx) {
          const mixed = masterPcm[target] + pcm[i];
          masterPcm[target] = mixed > 32767 ? 32767 : (mixed < -32768 ? -32768 : mixed);
        }
      }
    }

    const dataByteLength = masterPcm.byteLength;
    const header = buildWavHeader(dataByteLength, this.sampleRate);
    const wavBuffer = Buffer.concat([header, Buffer.from(masterPcm.buffer, masterPcm.byteOffset, masterPcm.byteLength)]);

    const fileName = `call_${this.callId}.wav`;
    const filePath = path.join(RECORDINGS_DIR, fileName);

    try {
      if (!fs.existsSync(RECORDINGS_DIR)) {
        fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
      }
      fs.writeFileSync(filePath, wavBuffer);
      console.log(`[CallAudioRecorder] Call #${this.callId} audio saved (${wavBuffer.length} bytes, ${durationSeconds}s) -> ${filePath}`);
    } catch (err: any) {
      console.error(`[CallAudioRecorder] Failed to write WAV file for call #${this.callId}:`, err.message);
    }

    return {
      filePath,
      url: `/api/calls/${this.callId}/audio`,
      durationSeconds,
    };
  }
}
