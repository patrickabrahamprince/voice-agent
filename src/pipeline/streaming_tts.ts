import { WebSocket } from 'ws';
import { pcmToMulaw } from './tts.js';
import { normalizeRealEstateText } from './normalizer.js';

export interface StreamingTTSOptions {
  speaker?: string;
  languageCode?: string;
  sampleRate?: number;
}

/**
 * High-performance WebSocket Streaming TTS client for Sarvam AI Bulbul v4-flash.
 * Delivers Time-To-First-Audio (TTFA) in ~250ms (3x faster than REST API).
 */
export class SarvamStreamingTTS {
  private ws: WebSocket | null = null;
  private isConnected: boolean = false;
  private isConfigured: boolean = false;
  private apiKey: string;
  private speaker: string = 'kavya_hi_conversational';
  private languageCode: string = 'en-IN';
  private sampleRate: number = 8000;
  private pendingResolvers: Array<{
    resolve: (buffer: Buffer) => void;
    reject: (err: any) => void;
    chunks: Buffer[];
  }> = [];

  constructor(apiKey?: string, options?: StreamingTTSOptions) {
    this.apiKey = apiKey || process.env.SARVAM_API_KEY || '';
    if (options?.speaker) this.speaker = options.speaker;
    if (options?.languageCode) this.languageCode = options.languageCode;
    if (options?.sampleRate) this.sampleRate = options.sampleRate;
  }

  /**
   * Connects to Sarvam WebSocket TTS endpoint and primes the connection.
   */
  public async connect(): Promise<boolean> {
    if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      return true;
    }

    if (!this.apiKey || this.apiKey === 'your_sarvam_api_key_here') {
      return false;
    }

    const url = 'wss://api.sarvam.ai/text-to-speech/ws?model=bulbul:v4-flash';

    return new Promise((resolve) => {
      try {
        this.ws = new WebSocket(url, {
          headers: {
            'Api-Subscription-Key': this.apiKey,
          },
        });

        const connectTimeout = setTimeout(() => {
          if (!this.isConnected) {
            console.warn('[StreamingTTS] WebSocket connection timeout (3s)');
            resolve(false);
          }
        }, 3000);

        this.ws.on('open', () => {
          clearTimeout(connectTimeout);
          this.isConnected = true;
          this.sendConfig();
          resolve(true);
        });

        this.ws.on('message', (data: any) => {
          try {
            const msg = JSON.parse(data.toString());
            this.handleMessage(msg);
          } catch (err: any) {
            console.warn('[StreamingTTS] Parse error:', err.message);
          }
        });

        this.ws.on('error', (err: any) => {
          console.warn('[StreamingTTS] WebSocket error:', err.message);
          this.isConnected = false;
          this.isConfigured = false;
        });

        this.ws.on('close', () => {
          this.isConnected = false;
          this.isConfigured = false;
        });
      } catch (err: any) {
        console.warn('[StreamingTTS] Init failed:', err.message);
        resolve(false);
      }
    });
  }

  private sendConfig(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        type: 'config',
        data: {
          language_code: this.languageCode,
          speaker: this.speaker,
          output_audio_codec: 'linear16',
          speech_sample_rate: this.sampleRate,
        },
      })
    );
    this.isConfigured = true;
  }

  private chunkDebounceTimer: NodeJS.Timeout | null = null;

  private handleMessage(msg: any): void {
    if (msg.type === 'audio' && msg.data?.audio) {
      const pcm16Buf = Buffer.from(msg.data.audio, 'base64');
      const mulawBuf = pcmToMulaw(pcm16Buf);

      const current = this.pendingResolvers[0];
      if (current) {
        current.chunks.push(mulawBuf);

        // Reset debounce timer on every received chunk
        if (this.chunkDebounceTimer) {
          clearTimeout(this.chunkDebounceTimer);
        }
        this.chunkDebounceTimer = setTimeout(() => {
          const completed = this.pendingResolvers.shift();
          if (completed) {
            const fullMulaw = Buffer.concat(completed.chunks);
            completed.resolve(fullMulaw);
          }
        }, 160);
      }
    } else if (msg.type === 'error') {
      console.warn('[StreamingTTS] Server error:', msg.data?.message || msg.message);
      const current = this.pendingResolvers.shift();
      if (current) {
        const fullMulaw = Buffer.concat(current.chunks);
        current.resolve(fullMulaw);
      }
    }
  }

  /**
   * Synthesizes text directly into 8kHz G.711 mulaw using the persistent WebSocket.
   * Resolves in ~250-400ms for conversational sentences.
   */
  public async synthesizeMulaw(rawText: string, speaker?: string): Promise<Buffer> {
    const text = normalizeRealEstateText(rawText).trim();
    if (!text) return Buffer.alloc(0);

    // Ensure connection is active
    if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      const connected = await this.connect();
      if (!connected) {
        throw new Error('StreamingTTS connection unavailable');
      }
    }

    if (speaker && speaker !== this.speaker) {
      this.speaker = speaker;
      this.sendConfig();
    }

    return new Promise((resolve, reject) => {
      const resolverItem = {
        resolve,
        reject,
        chunks: [] as Buffer[],
      };
      this.pendingResolvers.push(resolverItem);

      // Safety fallback timeout (5s)
      const timeout = setTimeout(() => {
        const idx = this.pendingResolvers.indexOf(resolverItem);
        if (idx !== -1) {
          this.pendingResolvers.splice(idx, 1);
          if (resolverItem.chunks.length > 0) {
            resolve(Buffer.concat(resolverItem.chunks));
          } else {
            reject(new Error('StreamingTTS timeout'));
          }
        }
      }, 5000);

      // Wrap resolve to clear timeout
      const origResolve = resolverItem.resolve;
      resolverItem.resolve = (val: any) => {
        clearTimeout(timeout);
        origResolve(val);
      };

      try {
        this.ws!.send(
          JSON.stringify({
            type: 'text',
            data: { text },
          })
        );
        this.ws!.send(JSON.stringify({ type: 'flush' }));
      } catch (err: any) {
        clearTimeout(timeout);
        const idx = this.pendingResolvers.indexOf(resolverItem);
        if (idx !== -1) this.pendingResolvers.splice(idx, 1);
        reject(err);
      }
    });
  }

  public close(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    this.isConnected = false;
    this.isConfigured = false;
  }
}

export const globalStreamingTTS = new SarvamStreamingTTS();
