import { WebSocket } from 'ws';
import crypto from 'crypto';
import { normalizeRealEstateText, isNaturalSentenceBoundary } from './normalizer.js';
import { llmPipeline, ChatMessage, activeQualifiers } from './llm.js';
import { synthesizeNeuralSpeech, synthesizeTelephonyMulaw, mulawToWav, transcribeAudioTelephony } from './tts.js';
import { createCall, updateCall, getCallerMemory, updateLeadRecording } from '../tools/db.js';
import { callEventsBroadcaster } from './events.js';
import { CallAudioRecorder } from './recorder.js';
import { semanticTurnDetector, STANDALONE_VALID_ANSWERS } from './turn_detector.js';
import { isTransferIntent, transferCallToHuman, plivoClient } from './transfer.js';

function repairTelephonyTranscript(rawText: string): string {
  if (!rawText) return '';
  let text = rawText;

  // 4 BHK misrecognitions (e.g., "FORE VHK", "for vhk", "poor wage", "four wage")
  text = text.replace(/\b(fore|for|poor|pour|foor)\s*(vhk|vhks|wage|wages|bhk|bhks|phk)\b/gi, '4 BHK');

  // 3 BHK misrecognitions
  text = text.replace(/\b(tree|free)\s*(vhk|bhk|phk)\b/gi, '3 BHK');

  // 2 BHK misrecognitions
  text = text.replace(/\b(tool with you|tool with u|to bhk|too bhk|two vhk)\b/gi, '2 BHK');

  return text;
}

export class VoiceSession {
  private telephonyWs: WebSocket;
  private streamSid: string = '';
  private callSid: string = '';
  private callUuid: string = '';
  private callerNumber: string = '+91-XXXXXXXXXX';
  private callId: number | null = null;
  private startTime: number = Date.now();

  private hangupSource: string = 'Caller';
  private hangupCause: string = 'Normal Hangup';
  private hangupCauseCode: string = '4000';

  private getElapsedSeconds(): number {
    return Math.max(0, Math.round((Date.now() - this.startTime) / 100) / 10);
  }

  private getElapsedSecStr(): string {
    return `+${this.getElapsedSeconds().toFixed(1)}s`;
  }

  private agentSpeakingStartedAt: number = 0;
  private agentSpeakingUntil: number = 0;
  private postSpeechCooldownUntil: number = 0;
  private isSynthesizingSpeech: boolean = false;

  private get isAgentSpeaking(): boolean {
    return Date.now() < this.agentSpeakingUntil || this.isSynthesizingSpeech;
  }

  private currentContextId: string = '';
  private activeAbortController: AbortController | null = null;
  private agentName: string = 'Priya';
  private agentVoice: string = 'ishita';
  private recorder: CallAudioRecorder | null = null;

  private deepgramWs: WebSocket | null = null;
  private inboundMulawChunks: Buffer[] = [];
  private speechFramesCount: number = 0;
  private pendingSpeechChunks: Buffer[] = [];
  private interruptFramesCount: number = 0;
  private interruptChunks: Buffer[] = [];
  private silenceTimer: NodeJS.Timeout | null = null;
  private deadAirTimer: NodeJS.Timeout | null = null;
  private deadAirPromptCount: number = 0;
  private stagedTranscript: string = '';
  private fallbackUtteranceTimer: NodeJS.Timeout | null = null;
  private isProcessingSTT: boolean = false;
  private isProcessingUtterance: boolean = false;
  private currentLanguage: 'en' | 'hi' = 'en';

  private conversationHistory: ChatMessage[] = [];
  private fullTranscriptLines: string[] = [];
  private isClosed: boolean = false;

  constructor(telephonyWs: WebSocket, callerNumber?: string, callUuid?: string) {
    this.telephonyWs = telephonyWs;
    if (callerNumber) {
      this.callerNumber = callerNumber;
    }
    if (callUuid) {
      this.callUuid = callUuid;
    }
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

    this.telephonyWs.on('close', (code: number, reason: Buffer) => {
      console.log(`[Session] Telephony WebSocket closed. Code: ${code}, Reason: "${reason?.toString() || 'none'}"`);
      this.closeSession('Caller Pressed End Call / WebSocket Closed', 'Caller', String(code || '4000'));
    });

    this.telephonyWs.on('error', (err: any) => {
      console.error('[Session] Telephony WebSocket error:', err);
      this.closeSession('WebSocket Network Error', 'Carrier', '500');
    });
  }

  private async handleTelephonyMessage(msg: any): Promise<void> {
    switch (msg.event) {
      case 'start': {
        this.streamSid = msg.start?.streamId || msg.start?.streamSid || msg.streamId || msg.streamSid || '';
        this.callSid = msg.start?.callId || msg.start?.callSid || msg.callId || '';
        if (!this.callerNumber || this.callerNumber === '+91-9880012345') {
          this.callerNumber =
            msg.start?.customParameters?.from ||
            msg.start?.customParameters?.Caller ||
            msg.start?.from ||
            this.callerNumber ||
            '+91-9880012345';
        }

        console.log(`[Session] Call started. StreamSid: ${this.streamSid}, Caller: ${this.callerNumber}`);

        // Register in local SQLite database
        this.callId = createCall(this.streamSid, this.callerNumber, this.callUuid);

        // Start full-duplex call audio recording
        this.recorder = new CallAudioRecorder(this.callId, this.startTime);

        // Trigger Plivo carrier-grade call recording as permanent backup
        if (this.callUuid && !this.callUuid.startsWith('sim_') && !this.callUuid.startsWith('test_') && plivoClient) {
          const publicDomain = process.env.PUBLIC_DOMAIN || 'mittal-palms-voice-agent.onrender.com';
          plivoClient.calls.record(this.callUuid, {
            fileFormat: 'mp3',
            callbackUrl: `https://${publicDomain}/recording-callback`,
            callbackMethod: 'POST',
          }).catch((err: any) => {
            console.warn('[Plivo Carrier Record] Initiation notice:', err.message);
          });
        }

        // Preload memory context into conversation system prompt
        this.conversationHistory = [
          {
            role: 'system',
            content: llmPipeline.getPromptWithLearnings(this.callerNumber, this.agentName),
          },
        ];

        // Initialize STT socket asynchronously in background
        this.initDeepgram().catch((e) => console.warn('[Session] Deepgram init notice:', e.message));

        // Priya greeting for Trishul Mittal Palms
        const greeting = this.getInitialGreeting();

        this.conversationHistory.push({ role: 'assistant', content: greeting });
        this.fullTranscriptLines.push(`[+0.0s] ${this.agentName}: ${greeting}`);

        callEventsBroadcaster.broadcast({
          type: 'call_started',
          streamSid: this.streamSid,
          callerNumber: this.callerNumber,
          timestamp: new Date().toISOString(),
          data: {
            agentName: this.agentName,
            greeting,
            callSid: this.callSid,
            elapsedSeconds: 0.0,
            elapsedSecStr: '+0.0s',
          },
        });

        await this.speakText(greeting);
        this.armDeadAirTimer();
        break;
      }

      case 'media': {
        if (!msg.media?.payload) return;
        const audioBuffer = Buffer.from(msg.media.payload, 'base64');

        // Capture incoming caller audio in call recorder
        if (this.recorder) {
          this.recorder.recordInboundChunk(audioBuffer);
        }

        // 1. If Deepgram is connected, stream 8kHz G.711 mulaw directly
        if (this.deepgramWs && this.deepgramWs.readyState === WebSocket.OPEN) {
          this.deepgramWs.send(audioBuffer);
        }

        // 2. Vocal Activity Detection, Vocal Barge-In, and Local Telephony STT
        this.handleInboundTelephonyAudio(audioBuffer);
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

      case 'dtmf': {
        const digit = msg.digit || msg.dtmf;
        console.log(`[Session] DTMF digit received: ${digit}. Triggering clean keypad barge-in.`);
        this.handleBargeIn(true, false);
        break;
      }

      case 'mark': {
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
      console.warn('[Deepgram] Missing DEEPGRAM_API_KEY. Using local telephony STT.');
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
    // If agent is speaking or in post-speech cooldown, ignore to prevent echo loops
    if (this.isAgentSpeaking || this.isSynthesizingSpeech || Date.now() < this.postSpeechCooldownUntil) {
      return;
    }

    const transcript = event.channel?.alternatives?.[0]?.transcript?.trim();
    if (!transcript) return;

    // Process final user utterance
    if (event.speech_final || (event.is_final && transcript.length > 0)) {
      console.log(`[STT Final] Caller: "${transcript}"`);
      this.processCallerUtterance(transcript);
    }
  }

  /**
   * Executes ultra-low latency barge-in interruption (<50ms).
   * @param broadcastEvent whether to broadcast barge_in event to UI SSE listeners
   * @param preserveSpeech whether to keep inbound caller speech chunks (true during vocal barge-in)
   */
  public handleBargeIn(broadcastEvent: boolean = true, preserveSpeech: boolean = false): void {
    if (!this.isAgentSpeaking && !this.activeAbortController && !this.isProcessingUtterance) return;

    console.log(`[Barge-In] Clearing PBX buffer on StreamSid: ${this.streamSid} (preserveSpeech=${preserveSpeech})`);

    this.agentSpeakingStartedAt = 0;
    this.agentSpeakingUntil = 0;
    this.postSpeechCooldownUntil = 0;
    this.isSynthesizingSpeech = false;
    this.isProcessingUtterance = false;
    this.interruptFramesCount = 0;
    this.interruptChunks = [];

    if (broadcastEvent) {
      this.fullTranscriptLines.push(`[${this.getElapsedSecStr()}] ⚡ [Barge-In] Customer interrupted agent speech`);
      callEventsBroadcaster.broadcast({
        type: 'barge_in',
        streamSid: this.streamSid,
        callerNumber: this.callerNumber,
        timestamp: new Date().toISOString(),
        data: {
          agentName: this.agentName,
          elapsedSeconds: this.getElapsedSeconds(),
          elapsedSecStr: this.getElapsedSecStr(),
        },
      });
    }

    if (!preserveSpeech) {
      this.inboundMulawChunks = [];
      this.pendingSpeechChunks = [];
      this.speechFramesCount = 0;
      if (this.silenceTimer) {
        clearTimeout(this.silenceTimer);
        this.silenceTimer = null;
      }
      if (this.fallbackUtteranceTimer) {
        clearTimeout(this.fallbackUtteranceTimer);
        this.fallbackUtteranceTimer = null;
      }
      this.stagedTranscript = '';
    }

    if (this.telephonyWs && this.telephonyWs.readyState === WebSocket.OPEN) {
      this.telephonyWs.send(JSON.stringify({ event: 'clearAudio' }));
      if (this.streamSid) {
        this.telephonyWs.send(
          JSON.stringify({
            event: 'clear',
            streamSid: this.streamSid,
          })
        );
      }
    }

    if (this.activeAbortController) {
      this.activeAbortController.abort();
      this.activeAbortController = null;
    }

    this.currentContextId = '';
  }

  /**
   * Calculates true 16-bit linear PCM RMS energy from 8kHz G.711 mulaw frame.
   */
  private getMulawRms(chunk: Buffer): number {
    let sumSquares = 0;
    for (let i = 0; i < chunk.length; i++) {
      const u = ~chunk[i] & 0xff;
      const t = ((u & 0x0f) << 3) + 0x84;
      const seg = (u & 0x70) >> 4;
      const s = (t << seg) - 0x84;
      const sample = (u & 0x80) !== 0 ? -s : s;
      sumSquares += sample * sample;
    }
    return Math.sqrt(sumSquares / chunk.length);
  }

  /**
   * Tracks and updates conversation language state between English and Hindi/Hinglish.
   */
  private updateLanguageFromCaller(text: string): void {
    if (!text) return;
    const lower = text.toLowerCase().trim();

    if (
      lower.includes('english please') ||
      lower.includes('in english') ||
      lower.includes('speak in english') ||
      lower.includes('talk in english') ||
      lower.includes('angrezi') ||
      lower.includes('angreji')
    ) {
      this.currentLanguage = 'en';
      return;
    }

    // Explicit request to speak Hindi
    if (
      lower.includes('hindi mein') ||
      lower.includes('in hindi') ||
      lower.includes('speak in hindi') ||
      lower.includes('talk in hindi') ||
      lower.includes('hindi please') ||
      lower === 'hindi'
    ) {
      this.currentLanguage = 'hi';
      return;
    }

    // Explicit Devanagari script
    if (/[\u0900-\u097F]/.test(text)) {
      this.currentLanguage = 'hi';
      return;
    }

    // Unambiguous conversational Hindi words (NO ambiguous words like 'me', 'ho', 'bhi', 'kuch', 'dono', 'sahi')
    const unambiguousHindi = [
      'bataiye', 'batao', 'boliye', 'bolo', 'kaunsa', 'kitna', 'kitne',
      'chahiye', 'namaste', 'namaskar', 'dhanyawad', 'shukriya', 'hanji',
      'haanji', 'accha', 'achha', 'acha', 'mujhe', 'humko', 'humein', 'aapka',
      'kahan', 'kidhar', 'nahin', 'nahi'
    ];

    const words = lower.split(/[^a-z0-9]+/);
    const matchedCount = words.filter((w) => unambiguousHindi.includes(w)).length;
    // Require at least 2 distinct unambiguous Hindi words before switching
    if (matchedCount >= 2) {
      this.currentLanguage = 'hi';
    }
  }

  /**
   * Finalizes accumulated caller speech frames into an audio utterance, runs STT and semantic turn evaluation.
   */
  private async finalizeCallerSpeech(): Promise<void> {
    if (this.isProcessingSTT || this.inboundMulawChunks.length === 0) {
      return;
    }

    const fullAudio = Buffer.concat(this.inboundMulawChunks);
    this.inboundMulawChunks = [];
    this.pendingSpeechChunks = [];
    this.speechFramesCount = 0;

    // Discard noises under 0.25s
    const durationSec = fullAudio.length / 8000;
    if (durationSec < 0.25) {
      this.armDeadAirTimer();
      return;
    }

    this.isProcessingSTT = true;
    try {
      const wav = mulawToWav(fullAudio);
      const rawTranscript = await transcribeAudioTelephony(wav);
      const transcript = (rawTranscript || '').trim();

      if (!transcript || transcript.length < 2) {
        this.armDeadAirTimer();
        return;
      }

      this.updateLanguageFromCaller(transcript);

      // Stitch with any staged incomplete fragment
      const combined = this.stagedTranscript
        ? `${this.stagedTranscript.trim()} ${transcript}`
        : transcript;

      const turnDecision = semanticTurnDetector.evaluateTurn(combined, durationSec);
      console.log(`[TurnDetector] Evaluated: "${combined}" -> complete=${turnDecision.isLikelyComplete} (${turnDecision.reason})`);

      if (turnDecision.shouldIgnore) {
        console.log(`[TurnDetector] Ignoring non-turn sound/hallucination: "${combined}"`);
        this.armDeadAirTimer();
        return;
      }

      if (!turnDecision.isLikelyComplete) {
        this.stagedTranscript = combined;
        console.log(`[TurnDetector] Incomplete thought staged: "${this.stagedTranscript}". Waiting for caller continuation...`);

        if (this.fallbackUtteranceTimer) {
          clearTimeout(this.fallbackUtteranceTimer);
        }
        this.fallbackUtteranceTimer = setTimeout(async () => {
          if (this.stagedTranscript.trim() && !this.isProcessingUtterance && !this.isAgentSpeaking && Date.now() >= this.postSpeechCooldownUntil) {
            const utterance = this.stagedTranscript.trim();
            this.stagedTranscript = '';

            // Drop isolated random single-word noise artifacts (e.g. "signal", "they've") that are not valid standalone responses
            const words = utterance.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
            if (words.length <= 1 && !STANDALONE_VALID_ANSWERS.has(words[0]) && !words[0]?.includes('bhk') && !/^\d+$/.test(words[0])) {
              console.log(`[TurnDetector Safety Timer] Dropping isolated noise artifact: "${utterance}"`);
              this.armDeadAirTimer();
              return;
            }

            console.log(`[TurnDetector Safety Timer] Processing stalled utterance: "${utterance}"`);
            await this.processCallerUtterance(utterance);
          }
        }, 550);

        return;
      }

      if (this.fallbackUtteranceTimer) {
        clearTimeout(this.fallbackUtteranceTimer);
        this.fallbackUtteranceTimer = null;
      }

      this.stagedTranscript = '';
      await this.processCallerUtterance(combined);
    } catch (err: any) {
      console.warn('[Session] STT processing notice:', err.message);
    } finally {
      this.isProcessingSTT = false;
      if (!this.isProcessingUtterance && !this.isAgentSpeaking && !this.deadAirTimer) {
        this.armDeadAirTimer();
      }
    }
  }

  /**
   * Handles inbound telephony audio frames with energy VAD, vocal barge-in interruption, and echo protection.
   */
  private handleInboundTelephonyAudio(chunk: Buffer): void {
    const now = Date.now();
    const rms = this.getMulawRms(chunk);

    // 1. Vocal Barge-In: Allows the caller to interrupt Priya when they speak into their phone
    if (this.isAgentSpeaking) {
      // Echo onset guard: First 600ms of agent speech is protected against transmission echo bursts
      if (now - this.agentSpeakingStartedAt < 600) {
        this.interruptFramesCount = 0;
        this.interruptChunks = [];
        return;
      }

      // Sustained caller speech into the phone microphone (RMS > 1400 for 140ms = 7 consecutive frames)
      if (rms > 1400) {
        this.interruptFramesCount++;
        this.interruptChunks.push(chunk);

        if (this.interruptFramesCount >= 7) {
          console.log(
            `[Barge-In] Caller interrupted Priya (RMS: ${Math.round(rms)}, sustained: ${this.interruptFramesCount} frames). Halting speech immediately.`
          );

          // Stop PBX playback immediately and cancel active synthesis so Priya is silent
          this.handleBargeIn(true, true);
          this.clearDeadAirTimer();
          this.deadAirPromptCount = 0;

          // Seed the inbound speech buffer with the interrupt chunks so opening words are preserved
          this.inboundMulawChunks = [...this.interruptChunks];
          this.speechFramesCount = this.interruptFramesCount;
          this.interruptChunks = [];
          this.interruptFramesCount = 0;

          if (this.silenceTimer) {
            clearTimeout(this.silenceTimer);
          }
          this.silenceTimer = setTimeout(async () => {
            await this.finalizeCallerSpeech();
          }, 450);
        }
      } else {
        // Drop brief noise transient or unvoiced gap
        if (this.interruptFramesCount > 0) {
          this.interruptFramesCount = Math.max(0, this.interruptFramesCount - 1);
        }
      }
      return;
    }

    // 2. Post-speech cooldown: Agent finished speaking, suppress 250ms residual echo tail
    if (now < this.postSpeechCooldownUntil && this.speechFramesCount === 0) {
      return;
    }

    // 3. Normal Speech Accumulation when agent is NOT speaking
    const isSpeech = rms > 750;

    if (isSpeech) {
      this.clearDeadAirTimer();
      this.deadAirPromptCount = 0;
      this.speechFramesCount++;
      this.pendingSpeechChunks.push(chunk);

      // Accumulate audio once real speech persists for >80ms (4 frames)
      if (this.speechFramesCount >= 4) {
        if (this.pendingSpeechChunks.length > 0) {
          this.inboundMulawChunks.push(...this.pendingSpeechChunks);
          this.pendingSpeechChunks = [];
        }
        this.inboundMulawChunks.push(chunk);
      }

      if (this.silenceTimer) {
        clearTimeout(this.silenceTimer);
        this.silenceTimer = null;
      }

      // Conversational silence debounce: 280-340ms for responsive snappy turn-taking
      const currentSpeechDuration = this.inboundMulawChunks.length / 8000;
      const debounceMs = currentSpeechDuration > 0.8 ? 280 : 340;

      this.silenceTimer = setTimeout(async () => {
        if (this.isAgentSpeaking || this.isSynthesizingSpeech) {
          // If agent is still actively speaking on PBX, wait until playback finishes
          const remainingMs = Math.max(0, this.agentSpeakingUntil - Date.now());
          if (remainingMs > 50) {
            this.silenceTimer = setTimeout(async () => {
              await this.finalizeCallerSpeech();
            }, remainingMs + 50);
            return;
          }
        }
        await this.finalizeCallerSpeech();
      }, debounceMs);
    } else {
      if (this.inboundMulawChunks.length > 0) {
        this.inboundMulawChunks.push(chunk);
      } else {
        this.speechFramesCount = 0;
        this.pendingSpeechChunks = [];
        if (!this.deadAirTimer && !this.isAgentSpeaking && !this.isProcessingUtterance && !this.isProcessingSTT) {
          this.armDeadAirTimer();
        }
      }
    }
  }

  /**
   * Streams text to telephony audio using Sarvam AI Bulbul 8kHz G.711 mulaw.
   */
  private async speakText(rawText: string): Promise<void> {
    const normalized = normalizeRealEstateText(rawText);
    if (!normalized.trim()) return;

    this.currentContextId = crypto.randomUUID();
    this.isSynthesizingSpeech = true;
    this.agentSpeakingStartedAt = Date.now();
    this.agentSpeakingUntil = Math.max(this.agentSpeakingUntil, Date.now() + 600);
    this.postSpeechCooldownUntil = this.agentSpeakingUntil + 450;

    // Flush any pending audio chunks
    this.inboundMulawChunks = [];
    this.pendingSpeechChunks = [];
    this.speechFramesCount = 0;
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
    if (this.fallbackUtteranceTimer) {
      clearTimeout(this.fallbackUtteranceTimer);
      this.fallbackUtteranceTimer = null;
    }
    this.stagedTranscript = '';

    console.log(`[Telephony Audio Out] Speaking: "${normalized}"`);

    callEventsBroadcaster.broadcast({
      type: 'agent_speaking',
      streamSid: this.streamSid,
      callerNumber: this.callerNumber,
      timestamp: new Date().toISOString(),
      data: {
        text: normalized,
        agentName: this.agentName,
        elapsedSeconds: this.getElapsedSeconds(),
        elapsedSecStr: this.getElapsedSecStr(),
      },
    });

    try {
      let firstChunkDispatched = false;
      const onAudioChunk = (chunk: Buffer) => {
        if (!chunk || chunk.length === 0) return;
        if (!this.telephonyWs || this.telephonyWs.readyState !== WebSocket.OPEN) return;
        if (this.activeAbortController?.signal.aborted) return;

        if (!firstChunkDispatched) {
          firstChunkDispatched = true;
          this.agentSpeakingStartedAt = Date.now();
        }

        const chunkDurationMs = chunk.length / 8;
        const now = Date.now();
        const currentEnd = Math.max(now, this.agentSpeakingUntil);
        this.agentSpeakingUntil = currentEnd + chunkDurationMs;
        this.postSpeechCooldownUntil = this.agentSpeakingUntil + 450; // 450ms echo cooldown allowing carrier buffer to flush cleanly

        this.inboundMulawChunks = [];
        this.pendingSpeechChunks = [];
        this.speechFramesCount = 0;
        if (this.silenceTimer) {
          clearTimeout(this.silenceTimer);
          this.silenceTimer = null;
        }

        if (this.recorder) {
          this.recorder.recordOutboundChunk(chunk);
        }

        this.telephonyWs.send(
          JSON.stringify({
            event: 'playAudio',
            media: {
              contentType: 'audio/x-mulaw',
              sampleRate: 8000,
              payload: chunk.toString('base64'),
            },
          })
        );
      };

      const mulawBuffer = await synthesizeTelephonyMulaw(normalized, this.agentVoice, onAudioChunk);

      if (this.activeAbortController?.signal.aborted) return;

      if (!firstChunkDispatched && mulawBuffer && mulawBuffer.length > 0 && this.telephonyWs && this.telephonyWs.readyState === WebSocket.OPEN) {
        if (this.recorder) {
          this.recorder.recordOutboundChunk(mulawBuffer);
        }
        const durationMs = mulawBuffer.length / 8;
        const now = Date.now();
        const currentEnd = Math.max(now, this.agentSpeakingUntil);
        this.agentSpeakingStartedAt = now;
        this.agentSpeakingUntil = currentEnd + durationMs;
        this.postSpeechCooldownUntil = this.agentSpeakingUntil + 450; // 450ms echo cooldown allowing carrier buffer to flush cleanly

        this.telephonyWs.send(
          JSON.stringify({
            event: 'playAudio',
            media: {
              contentType: 'audio/x-mulaw',
              sampleRate: 8000,
              payload: mulawBuffer.toString('base64'),
            },
          })
        );
      }
    } catch (err: any) {
      console.warn('[Session] Telephony speech dispatch notice:', err.message);
    } finally {
      this.isSynthesizingSpeech = false;
    }
  }

  /**
   * Handles user dialogue turn, executing strict script progression.
   * Completely avoids wandering, enforces unskippable questions, and updates lead intelligence.
   */
  public async processCallerUtterance(callerText: string): Promise<string> {
    if (!callerText || !callerText.trim()) return '';

    if (this.isProcessingUtterance) {
      console.log(`[Session] Waiting for prior utterance to complete before processing: "${callerText.slice(0, 40)}"`);
      return '';
    }
    this.isProcessingUtterance = true;

    const cleanedText = repairTelephonyTranscript(callerText);

    callEventsBroadcaster.broadcast({
      type: 'caller_speech',
      streamSid: this.streamSid,
      callerNumber: this.callerNumber,
      timestamp: new Date().toISOString(),
      data: {
        transcript: cleanedText,
        callerNumber: this.callerNumber,
        elapsedSeconds: this.getElapsedSeconds(),
        elapsedSecStr: this.getElapsedSecStr(),
      },
    });

    this.updateLanguageFromCaller(cleanedText);
    const callDuration = Math.round((Date.now() - this.startTime) / 1000);
    const lower = cleanedText.toLowerCase().trim();

    // 0. Hostile / Abusive caller filter
    const isAbusive = /\b(fuck|bitch|bastard|asshole|idiot|dumb fuck|chutiya|madarchod|bhosdike|harami|gaand)\b/i.test(lower);
    if (isAbusive) {
      console.log(`[Session] Abusive language detected from caller: "${cleanedText}". Concluding call professionally.`);
      const exitMsg = this.currentLanguage === 'hi'
        ? "Kripya shant rahein. Hum keval Mittal Palms property ke baare mein baat kar sakte hain. Aapka din shubh rahe. Alvida."
        : "I appreciate your time, but we maintain professional standards. Have a wonderful day ahead. Goodbye.";
      this.conversationHistory.push({ role: 'user', content: cleanedText });
      this.fullTranscriptLines.push(`[${this.getElapsedSecStr()}] Caller: ${cleanedText}`);
      await this.speakText(exitMsg);
      this.conversationHistory.push({ role: 'assistant', content: exitMsg });
      this.fullTranscriptLines.push(`[${this.getElapsedSecStr()}] ${this.agentName}: ${exitMsg}`);
      this.isProcessingUtterance = false;
      const waitMs = Math.max(1000, this.agentSpeakingUntil - Date.now() + 400);
      setTimeout(async () => {
        await this.closeSession('Abusive Language / Hostile Caller', 'Agent', 'ABUSIVE_CALLER');
      }, waitMs);
      return exitMsg;
    }

    // 1. Caller rejection / Opt-out filter (active throughout entire call)
    const isDncOrNotInterested = (
      lower.includes("don't call") ||
      lower.includes("dont call") ||
      lower.includes("never call") ||
      lower.includes("stop calling") ||
      lower.includes("not interested") ||
      lower.includes("wrong number") ||
      lower.includes("remove my number") ||
      lower.includes("dont ever call") ||
      lower.includes("don't ever call") ||
      lower.includes("no need") ||
      lower.includes("not looking") ||
      lower.includes("nahin chahiye") ||
      lower.includes("nahi chahiye") ||
      lower.includes("nahi dekh") ||
      lower.includes("mat call karo") ||
      lower.includes("phone mat karo")
    );

    if (isDncOrNotInterested) {
      console.log(`[Session] Caller requested opt-out / DNC at ${callDuration}s: "${cleanedText}". Ending call politely.`);
      const politeExit = this.currentLanguage === 'hi'
        ? "Ji bilkul, main samajh sakti hoon. Aapke samay ke liye dhanyawad, aapka din shubh rahe. Alvida!"
        : "I completely understand. Thank you for your time, have a wonderful day ahead. Goodbye!";
      this.conversationHistory.push({ role: 'user', content: cleanedText });
      this.fullTranscriptLines.push(`[${this.getElapsedSecStr()}] Caller: ${cleanedText}`);
      await this.speakText(politeExit);
      this.conversationHistory.push({ role: 'assistant', content: politeExit });
      this.fullTranscriptLines.push(`[${this.getElapsedSecStr()}] ${this.agentName}: ${politeExit}`);
      this.isProcessingUtterance = false;
      const waitMs = Math.max(1000, this.agentSpeakingUntil - Date.now() + 400);
      setTimeout(async () => {
        await this.closeSession('Caller Opt-Out (Not Interested / DNC)', 'Caller', 'OPTOUT');
      }, waitMs);
      return politeExit;
    }

    // 2. Check if caller requested live human transfer
    if (isTransferIntent(cleanedText)) {
      console.log(`[Session] Caller requested human escalation: "${cleanedText}". Initiating transfer...`);
      const transferMsg = "Sure, let me connect your call to our on-site property advisor team right away. Please stay on the line.";
      this.conversationHistory.push({ role: 'assistant', content: transferMsg });
      this.fullTranscriptLines.push(`[${this.getElapsedSecStr()}] ${this.agentName}: ${transferMsg}`);
      await this.speakText(transferMsg);
      await transferCallToHuman({
        callUuid: this.callUuid || this.callSid,
        streamSid: this.streamSid,
        callerNumber: this.callerNumber,
        reason: cleanedText,
      });
      this.isProcessingUtterance = false;
      await this.closeSession('Transferred to Human Property Advisor', 'Agent', 'TRANSFER');
      return transferMsg;
    }

    this.conversationHistory.push({ role: 'user', content: cleanedText });
    this.fullTranscriptLines.push(`[${this.getElapsedSecStr()}] Caller: ${cleanedText}`);

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
        abortSignal,
        this.currentLanguage
      );

      for await (const token of tokenStream) {
        if (abortSignal.aborted) break;

        const tokenToAdd = (fullResponse && !fullResponse.endsWith(' ') && !/^[\s,.:;?!]/.test(token))
          ? ` ${token}`
          : token;
        sentenceBuffer += tokenToAdd;
        fullResponse += tokenToAdd;

        // Check for natural sentence boundaries (. ? ! or newline) protecting decimals like 1.25
        if (isNaturalSentenceBoundary(sentenceBuffer)) {
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
        this.fullTranscriptLines.push(`[${this.getElapsedSecStr()}] ${this.agentName}: ${fullResponse.trim()}`);
      }

      // Broadcast dynamic lead updates extracted so far from QualificationEngine
      const qualifierKey = `${this.callId ?? 'sim'}:${this.callerNumber}`;
      const qualifier = activeQualifiers.get(qualifierKey);
      if (qualifier) {
        const state = qualifier.getState();
        callEventsBroadcaster.broadcast({
          type: 'lead_update',
          streamSid: this.streamSid,
          callerNumber: this.callerNumber,
          timestamp: new Date().toISOString(),
          data: {
            config: state.config,
            budget: state.budget,
            intent: state.intent,
            location: state.preferredLocation,
            callerName: state.callerName,
            isQualified: state.isQualified,
            leadQuality: state.leadQuality,
          },
        });
      }

      if (!abortSignal.aborted && fullResponse.trim()) {
        this.armDeadAirTimer();
      }

      return fullResponse.trim();
    } catch (err: any) {
      if (!abortSignal.aborted) {
        console.error('[Session] Error during dialogue turn:', err);
      }
      return '';
    } finally {
      this.activeAbortController = null;
      this.isProcessingUtterance = false;
    }
  }

  /**
   * Arms a dead-air re-engagement timer to prevent awkward silence or abandoned calls.
   * Prompts the caller if they remain silent for >5 seconds after agent finishes speaking.
   */
  private armDeadAirTimer(): void {
    this.clearDeadAirTimer();
    if (this.isClosed) return;

    // Calculate when the agent will actually finish speaking on the PBX
    const timeUntilAgentDone = Math.max(0, this.agentSpeakingUntil - Date.now());
    const silenceTimeoutMs = timeUntilAgentDone + 5000; // 5.0 seconds after agent finishes speaking

    this.deadAirTimer = setTimeout(async () => {
      if (
        this.isClosed ||
        this.isAgentSpeaking ||
        this.isProcessingUtterance ||
        this.isProcessingSTT ||
        this.inboundMulawChunks.length > 0 ||
        this.speechFramesCount > 0
      ) {
        if (!this.isClosed && !this.isAgentSpeaking && !this.isProcessingUtterance) {
          this.armDeadAirTimer();
        }
        return;
      }

      this.deadAirPromptCount++;
      console.log(`[DeadAir Timer] Silence detected. Triggering prompt #${this.deadAirPromptCount}...`);

      if (this.deadAirPromptCount === 1) {
        const prompt =
          this.currentLanguage === 'hi'
            ? 'नमस्ते, क्या आप सुन पा रहे हैं? अगर आप फ्लोर प्लान या प्राइसिंग जानना चाहते हैं तो बेझिझक पूछें।'
            : "Hello, are you still with me? Feel free to ask if you'd like pricing details, floor plans, or site visit timings!";

        this.conversationHistory.push({ role: 'assistant', content: prompt });
        this.fullTranscriptLines.push(`${this.agentName}: ${prompt}`);
        await this.speakText(prompt);
        this.armDeadAirTimer();
      } else if (this.deadAirPromptCount >= 2) {
        const farewell =
          this.currentLanguage === 'hi'
            ? 'लगता है आपकी आवाज़ नहीं आ पा रही है। आप हमें कभी भी दोबारा कॉल कर सकते हैं या हमारी वेबसाइट mittalpalms.com देख सकते हैं। धन्यवाद!'
            : 'I seem to be having trouble hearing you. Please feel free to call us back anytime or visit mittalpalms.com. Have a wonderful day!';

        this.conversationHistory.push({ role: 'assistant', content: farewell });
        this.fullTranscriptLines.push(`${this.agentName}: ${farewell}`);
        await this.speakText(farewell);

        const waitMs = Math.max(1200, this.agentSpeakingUntil - Date.now() + 500);
        setTimeout(async () => {
          await this.closeSession('Dead Air (Caller silent for >15s)', 'Timeout', 'TIMEOUT');
        }, waitMs);
      }
    }, silenceTimeoutMs);
  }

  /**
   * Cancels any pending dead-air re-engagement timer.
   */
  private clearDeadAirTimer(): void {
    if (this.deadAirTimer) {
      clearTimeout(this.deadAirTimer);
      this.deadAirTimer = null;
    }
  }

  /**
   * Concludes the call, generates post-call summary, updates SQLite audit record,
   * inserts finalized lead via qualifier, and cleanly closes all sockets.
   */
  public async closeSession(
    reason: string = 'Normal Hangup',
    source: string = 'Caller',
    causeCode: string = '4000'
  ): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;

    this.hangupSource = source;
    this.hangupCause = reason;
    this.hangupCauseCode = causeCode;

    const durationSeconds = Math.round((Date.now() - this.startTime) / 1000);
    this.fullTranscriptLines.push(
      `[${this.getElapsedSecStr()}] 🏁 Call Concluded • Duration: ${durationSeconds}s • Dropped by: ${this.hangupSource} (${this.hangupCause})`
    );
    const fullTranscript = this.fullTranscriptLines.join('\n');

    console.log(
      `[Session] Call finished. Duration: ${durationSeconds}s. Dropped by: ${this.hangupSource} (${this.hangupCause}). Finalizing audit record...`
    );

    this.handleBargeIn(false);
    this.clearDeadAirTimer();
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
    this.inboundMulawChunks = [];

    // Sync lead with QualificationEngine before releasing
    const qualifierKey = `${this.callId ?? 'sim'}:${this.callerNumber}`;
    const qualifier = activeQualifiers.get(qualifierKey);
    if (qualifier) {
      try {
        await qualifier.syncLeadRecord();
      } catch (err) {
        console.warn('[Session] QualificationEngine sync notice:', err);
      }
    }
    activeQualifiers.delete(qualifierKey);

    if (this.deepgramWs && this.deepgramWs.readyState === WebSocket.OPEN) {
      try {
        this.deepgramWs.send(JSON.stringify({ type: 'CloseStream' }));
        this.deepgramWs.close();
      } catch {}
    }

    // Finalize audio recording
    let recordingUrl = '';
    if (this.recorder && this.callId) {
      try {
        const recording = await this.recorder.finalize();
        recordingUrl = recording.url;
        updateLeadRecording(this.callId, recordingUrl);
        console.log(`[Session] Call #${this.callId} audio recording finalized -> ${recordingUrl}`);
      } catch (err: any) {
        console.warn('[Session] Finalizing recording notice:', err.message);
      }
    }

    // Generate call summary and update SQLite
    let finalSummary = 'Call ended.';
    if (this.callId) {
      try {
        finalSummary = await llmPipeline.generateSummary(fullTranscript);
        updateCall(
          this.callId,
          durationSeconds,
          fullTranscript,
          finalSummary,
          recordingUrl,
          this.hangupSource,
          this.hangupCause,
          this.hangupCauseCode
        );
        console.log(`[Database] Call record #${this.callId} updated with summary: "${finalSummary}"`);
        await llmPipeline.extractAndStoreLearnings(this.callId, fullTranscript);

        // Sync lead with recording and full turn-by-turn transcript to Google Sheets
        const qualifierKey = `${this.callId ?? 'sim'}:${this.callerNumber}`;
        const qualifier = activeQualifiers.get(qualifierKey);
        if (qualifier) {
          qualifier.syncLeadRecord(recordingUrl, fullTranscript).catch((e: any) => {
            console.warn('[Session] Post-call lead sync notice:', e.message);
          });
        }
      } catch (err) {
        console.error('[Session] Error finalizing call audit record:', err);
      }
    }

    callEventsBroadcaster.broadcast({
      type: 'call_ended',
      streamSid: this.streamSid,
      callerNumber: this.callerNumber,
      timestamp: new Date().toISOString(),
      data: {
        durationSeconds,
        summary: finalSummary,
        recordingUrl,
        callId: this.callId,
        agentName: this.agentName,
        hangupSource: this.hangupSource,
        hangupCause: this.hangupCause,
        hangupCauseCode: this.hangupCauseCode,
        droppedBy: this.hangupSource,
        elapsedSeconds: durationSeconds,
        elapsedSecStr: `+${durationSeconds}s`,
      },
    });

    // Terminate live Plivo telephony carrier call leg if active
    if (this.callUuid && !this.callUuid.startsWith('sim_') && !this.callUuid.startsWith('test_')) {
      if (plivoClient) {
        plivoClient.calls.hangup(this.callUuid).catch((err: any) => {
          console.warn('[Session] Plivo carrier hangup notice:', err.message);
        });
      }
    }

    // Close the telephony WebSocket connection to free the audio socket
    if (this.telephonyWs && this.telephonyWs.readyState === WebSocket.OPEN) {
      try {
        this.telephonyWs.close();
      } catch {}
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
    const systemPrompt = llmPipeline.getPromptWithLearnings(this.callerNumber, this.agentName);
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

  public setAgentVoice(voice: string): void {
    this.agentVoice = voice;
  }

  public getAgentVoice(): string {
    return this.agentVoice;
  }

  public getInitialGreeting(): string {
    const memory = getCallerMemory(this.callerNumber);
    return (memory.isReturningCaller && memory.existingLead?.callerName && memory.existingLead.callerName !== 'Valued Buyer' && memory.existingLead.callerName !== 'there')
      ? `Hello! Welcome back to Mittal Palms. This is Priya. Are you looking for a 2 BHK or a 3 BHK for your family?`
      : `Hello! This is Priya from Trishul Mittal Palms in Jakkur. Are you looking for a 2 BHK or a 3 BHK for your family?`;
  }
}
