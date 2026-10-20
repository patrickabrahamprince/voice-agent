import { WebSocket } from 'ws';
import crypto from 'crypto';
import { normalizeRealEstateText } from './normalizer.js';
import { llmPipeline, ChatMessage, PRIYA_SYSTEM_PROMPT } from './llm.js';
import { createCall, updateCall, getCallerMemory } from '../tools/db.js';

// Cartesia Indian Lady (Female) Voice ID: 3b554273-4299-48b9-9aaf-eefd438e3941
const CARTESIA_VOICE_ID = process.env.CARTESIA_VOICE_ID || '3b554273-4299-48b9-9aaf-eefd438e3941';
const CARTESIA_MODEL_ID = 'sonic-multilingual';

export class VoiceSession {
  private telephonyWs: WebSocket;
  private streamSid: string = '';
  private callSid: string = '';
  private callerNumber: string = '+91-XXXXXXXXXX';
  private callId: number | null = null;
  private startTime: number = Date.now();

  private isAgentSpeaking: boolean = false;
  private currentContextId: string = '';
  private activeAbortController: AbortController | null = null;
  private agentName: string = 'Dylan Dsouza';

  private deepgramWs: WebSocket | null = null;
  private cartesiaWs: WebSocket | null = null;

  private conversationHistory: ChatMessage[] = [
    { role: 'system', content: llmPipeline.getPromptWithLearnings() },
  ];
  private fullTranscriptLines: string[] = [];
  private isClosed: boolean = false;

  constructor(telephonyWs: WebSocket) {
    this.telephonyWs = telephonyWs;
    this.setupTelephonyListeners();
  }

  private setupTelephonyListeners(): void {
    this.telephonyWs.on('message', async (data: any) => {
      try {
        const msg = JSON.parse(data.toString());
        await this.handleTelephonyMessage(msg);
      } catch (err) {
        console.error('[Session] Error parsing telephony payload:', err);
      }
    });

    this.telephonyWs.on('close', () => {
      this.closeSession();
    });

    this.telephonyWs.on('error', (err) => {
      console.error('[Session] Telephony WebSocket error:', err);
      this.closeSession();
    });
  }

  private async handleTelephonyMessage(msg: any): Promise<void> {
    switch (msg.event) {
      case 'start': {
        this.streamSid = msg.start?.streamSid || msg.streamSid || '';
        this.callSid = msg.start?.callSid || '';
        this.callerNumber =
          msg.start?.customParameters?.from ||
          msg.start?.customParameters?.Caller ||
          msg.start?.from ||
          '+91-9880012345';

        console.log(`[Session] Call started. StreamSid: ${this.streamSid}, Caller: ${this.callerNumber}`);

        // Register in local SQLite database
        this.callId = createCall(this.streamSid, this.callerNumber);

        // Initialize STT & TTS sockets
        await this.initDeepgram();
        await this.initCartesia();

        // Preload memory context into conversation system prompt
        this.conversationHistory[0] = {
          role: 'system',
          content: llmPipeline.getPromptWithLearnings(this.callerNumber),
        };

        // Trigger context-aware greeting
        const memory = getCallerMemory(this.callerNumber);
        const greeting = memory.isReturningCaller
          ? 'Hello! Welcome back to Mittal Palms. This is Priya. Wonderful to connect with you again! Are you looking to schedule your site walkthrough with Raghavendra, or did you have more questions about our homes?'
          : 'Hello! This is Priya from Mittal Palms in Jakkur. Thanks for calling! We have ready-to-move 2 and 3 BHK homes here. Are you looking for a 2 BHK or a 3 BHK for your family?';

        this.conversationHistory.push({ role: 'assistant', content: greeting });
        this.fullTranscriptLines.push(`Priya: ${greeting}`);

        await this.speakText(greeting);
        break;
      }

      case 'media': {
        if (!msg.media?.payload) return;

        // Stream 8kHz G.711 mulaw audio directly into Deepgram STT
        if (this.deepgramWs && this.deepgramWs.readyState === WebSocket.OPEN) {
          const audioBuffer = Buffer.from(msg.media.payload, 'base64');
          this.deepgramWs.send(audioBuffer);
        }
        break;
      }

      case 'stop': {
        console.log(`[Session] Stop received for StreamSid: ${this.streamSid}`);
        this.closeSession();
        break;
      }

      case 'mock_utterance':
      case 'user_utterance': {
        if (msg.text) {
          console.log(`[Session] Mock utterance received: "${msg.text}"`);
          await this.processCallerUtterance(msg.text);
        }
        break;
      }

      case 'barge_in':
      case 'clear': {
        this.handleBargeIn();
        break;
      }

      case 'mark': {
        // Telephony playback mark completed
        break;
      }
    }
  }

  /**
   * Initializes live Deepgram Nova-2 WebSocket connection.
   */
  private async initDeepgram(): Promise<void> {
    const apiKey = process.env.DEEPGRAM_API_KEY;
    if (!apiKey || apiKey === 'your_deepgram_api_key_here') {
      console.warn('[Deepgram] Missing DEEPGRAM_API_KEY. Live voice STT disabled (audio passthrough only).');
      return;
    }

    const dgUrl =
      'wss://api.deepgram.com/v1/listen?model=nova-2&language=en-IN&encoding=mulaw&sample_rate=8000&endpointing=300&interim_results=true&utterance_end_ms=1000&vad_events=true';

    try {
      this.deepgramWs = new WebSocket(dgUrl, {
        headers: {
          Authorization: `Token ${apiKey}`,
        },
      });

      this.deepgramWs.on('open', () => {
        console.log('[Deepgram] WebSocket connected.');
      });

      this.deepgramWs.on('message', (data: any) => {
        try {
          const response = JSON.parse(data.toString());
          this.handleDeepgramEvent(response);
        } catch (err) {
          console.error('[Deepgram] Parse error:', err);
        }
      });

      this.deepgramWs.on('error', (err) => {
        console.error('[Deepgram] WebSocket error:', err.message);
      });

      this.deepgramWs.on('close', () => {
        console.log('[Deepgram] WebSocket closed.');
      });
    } catch (err: any) {
      console.error('[Deepgram] Connection initialization failed:', err.message);
    }
  }

  /**
   * Handles Deepgram live transcriptions and VAD events.
   */
  private handleDeepgramEvent(event: any): void {
    // 1. Barge-in detection: VAD SpeechStarted or interim transcript
    if (event.type === 'SpeechStarted') {
      if (this.isAgentSpeaking) {
        console.log('[Barge-In] SpeechStarted detected! Triggering interruption flush.');
        this.handleBargeIn();
      }
      return;
    }

    const transcript = event.channel?.alternatives?.[0]?.transcript?.trim();
    if (!transcript) return;

    // Caller started speaking while agent was speaking -> Barge-in!
    if (this.isAgentSpeaking && transcript.length > 2) {
      console.log(`[Barge-In] Caller speech detected during agent speech: "${transcript}"`);
      this.handleBargeIn();
    }

    // Process final user utterance
    if (event.speech_final || (event.is_final && transcript.length > 0)) {
      console.log(`[STT Final] Caller: "${transcript}"`);
      this.processCallerUtterance(transcript);
    }
  }

  /**
   * Executes ultra-low latency barge-in interruption (<50ms).
   */
  public handleBargeIn(): void {
    if (!this.isAgentSpeaking && !this.activeAbortController) return;

    console.log(`[Barge-In] Clearing PBX buffer on StreamSid: ${this.streamSid}`);

    // 1. Instantly clear PBX audio buffer over telephony WebSocket
    if (this.telephonyWs && this.telephonyWs.readyState === WebSocket.OPEN && this.streamSid) {
      this.telephonyWs.send(
        JSON.stringify({
          event: 'clear',
          streamSid: this.streamSid,
        })
      );
    }

    // 2. Abort ongoing LLM generation
    if (this.activeAbortController) {
      this.activeAbortController.abort();
      this.activeAbortController = null;
    }

    // 3. Cancel active Cartesia context
    if (this.cartesiaWs && this.cartesiaWs.readyState === WebSocket.OPEN && this.currentContextId) {
      this.cartesiaWs.send(
        JSON.stringify({
          context_id: this.currentContextId,
          cancel: true,
        })
      );
    }

    this.isAgentSpeaking = false;
    this.currentContextId = '';
  }

  /**
   * Initializes Cartesia TTS WebSocket connection.
   */
  private async initCartesia(): Promise<void> {
    const apiKey = process.env.CARTESIA_API_KEY;
    if (!apiKey || apiKey === 'your_cartesia_api_key_here') {
      console.warn('[Cartesia] Missing CARTESIA_API_KEY. TTS audio streaming disabled.');
      return;
    }

    const cartesiaUrl = `wss://api.cartesia.ai/tts/websocket?api_key=${apiKey}&cartesia_version=2024-06-10`;

    try {
      this.cartesiaWs = new WebSocket(cartesiaUrl);

      this.cartesiaWs.on('open', () => {
        console.log('[Cartesia] WebSocket connected.');
      });

      this.cartesiaWs.on('message', (data: any) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.context_id !== this.currentContextId) {
            // Ignore stale chunks from cancelled contexts
            return;
          }

          if (msg.type === 'chunk' && msg.data) {
            // Forward raw 8kHz G.711 mulaw base64 audio directly to telephony WebSocket
            if (this.telephonyWs && this.telephonyWs.readyState === WebSocket.OPEN) {
              this.telephonyWs.send(
                JSON.stringify({
                  event: 'media',
                  streamSid: this.streamSid,
                  media: {
                    payload: msg.data,
                  },
                })
              );
            }
          } else if (msg.type === 'done') {
            this.isAgentSpeaking = false;
          }
        } catch (err) {
          console.error('[Cartesia] Message processing error:', err);
        }
      });

      this.cartesiaWs.on('error', (err) => {
        console.error('[Cartesia] WebSocket error:', err.message);
      });

      this.cartesiaWs.on('close', () => {
        console.log('[Cartesia] WebSocket closed.');
      });
    } catch (err: any) {
      console.error('[Cartesia] Initialization failed:', err.message);
    }
  }

  /**
   * Streams text to Cartesia TTS with normalization.
   */
  private async speakText(rawText: string): Promise<void> {
    const normalized = normalizeRealEstateText(rawText);
    if (!normalized.trim()) return;

    this.isAgentSpeaking = true;
    this.currentContextId = crypto.randomUUID();

    console.log(`[TTS] Speaking: "${normalized}" (Context: ${this.currentContextId})`);

    if (this.cartesiaWs && this.cartesiaWs.readyState === WebSocket.OPEN) {
      const payload = {
        context_id: this.currentContextId,
        model_id: CARTESIA_MODEL_ID,
        transcript: normalized,
        voice: {
          mode: 'id',
          id: CARTESIA_VOICE_ID,
        },
        output_format: {
          container: 'raw',
          encoding: 'pcm_mulaw',
          sample_rate: 8000,
        },
        continue: false,
      };

      this.cartesiaWs.send(JSON.stringify(payload));
    } else {
      // Offline / testing fallback: emit real 8kHz G.711 mulaw audio frames to telephony WebSocket
      if (this.telephonyWs && this.telephonyWs.readyState === WebSocket.OPEN) {
        const frameCount = Math.max(1, Math.min(8, Math.ceil(normalized.length / 20)));
        const mulawChunk = Buffer.alloc(160, 0x7f); // 20ms of 8kHz mulaw audio (160 bytes)
        const payload = mulawChunk.toString('base64');
        for (let i = 0; i < frameCount; i++) {
          if (!this.isAgentSpeaking) break; // Check for barge-in clear
          this.telephonyWs.send(
            JSON.stringify({
              event: 'media',
              streamSid: this.streamSid,
              media: { payload },
            })
          );
        }
      }
      setTimeout(() => {
        this.isAgentSpeaking = false;
      }, 250);
    }
  }

  /**
   * Handles user dialogue turn, invokes LLM with streaming and function calling,
   * and dispatches TTS chunks at sentence boundaries.
   */
  public async processCallerUtterance(callerText: string): Promise<string> {
    if (!callerText || !callerText.trim()) return '';

    this.conversationHistory.push({ role: 'user', content: callerText });
    this.fullTranscriptLines.push(`Caller: ${callerText}`);

    // Create AbortController for interruption support
    this.activeAbortController = new AbortController();
    const abortSignal = this.activeAbortController.signal;

    let sentenceBuffer = '';
    let fullResponse = '';

    try {
      const tokenStream = llmPipeline.streamResponse(
        this.conversationHistory,
        this.callId,
        this.callerNumber,
        this.agentName,
        abortSignal
      );

      for await (const token of tokenStream) {
        if (abortSignal.aborted) break;

        sentenceBuffer += token;
        fullResponse += token;

        // Check for natural sentence boundaries (. ? ! or newline)
        if (/[.!?\n]\s*$/.test(sentenceBuffer) && sentenceBuffer.trim().length > 10) {
          await this.speakText(sentenceBuffer.trim());
          sentenceBuffer = '';
        }
      }

      // Flush any remaining text in buffer
      if (sentenceBuffer.trim().length > 0 && !abortSignal.aborted) {
        await this.speakText(sentenceBuffer.trim());
      }

      if (fullResponse.trim()) {
        this.conversationHistory.push({ role: 'assistant', content: fullResponse.trim() });
        this.fullTranscriptLines.push(`${this.agentName}: ${fullResponse.trim()}`);
      }
    } catch (err: any) {
      if (!abortSignal.aborted) {
        console.error('[Session] Error during dialogue turn:', err);
      }
    } finally {
      this.activeAbortController = null;
    }

    return fullResponse.trim();
  }

  /**
   * Concludes the call, generates post-call summary, updates SQLite audit record,
   * and cleanly closes all sockets.
   */
  public async closeSession(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;

    const durationSeconds = Math.round((Date.now() - this.startTime) / 1000);
    const fullTranscript = this.fullTranscriptLines.join('\n');

    console.log(`[Session] Call finished. Duration: ${durationSeconds}s. Generating summary...`);

    // Clean up active streams
    this.handleBargeIn();

    if (this.deepgramWs && this.deepgramWs.readyState === WebSocket.OPEN) {
      try {
        this.deepgramWs.send(JSON.stringify({ type: 'CloseStream' }));
        this.deepgramWs.close();
      } catch {}
    }

    if (this.cartesiaWs && this.cartesiaWs.readyState === WebSocket.OPEN) {
      try {
        this.cartesiaWs.close();
      } catch {}
    }

    // Generate call summary and update SQLite in background
    if (this.callId) {
      try {
        const summary = await llmPipeline.generateSummary(fullTranscript);
        updateCall(this.callId, durationSeconds, fullTranscript, summary);
        console.log(`[Database] Call record #${this.callId} updated with summary: "${summary}"`);

        // Train LLM after every call by extracting learnings and objection patterns
        await llmPipeline.extractAndStoreLearnings(this.callId, fullTranscript);
      } catch (err) {
        console.error('[Session] Error finalizing call audit record:', err);
      }
    }
  }

  public getCallId(): number | null {
    return this.callId;
  }

  public getStreamSid(): string {
    return this.streamSid;
  }

  public getTranscript(): string {
    return this.fullTranscriptLines.join('\n');
  }

  public setCallerNumber(callerNumber: string): void {
    this.callerNumber = callerNumber;
  }

  public getCallerNumber(): string {
    return this.callerNumber;
  }

  public setConversationHistory(history: ChatMessage[]): void {
    const systemPrompt = llmPipeline.getPromptWithLearnings(this.callerNumber);
    this.conversationHistory = [
      { role: 'system', content: systemPrompt },
      ...history.filter((m) => m.role !== 'system'),
    ];
  }

  public getConversationHistory(): ChatMessage[] {
    return this.conversationHistory;
  }

  public setTranscriptLines(lines: string[]): void {
    this.fullTranscriptLines = lines;
  }

  public setAgentName(name: string): void {
    this.agentName = name;
  }

  public getAgentName(): string {
    return this.agentName;
  }
}
