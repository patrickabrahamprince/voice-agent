import 'dotenv/config';
import Groq from 'groq-sdk';
import { sheetsService, QualifyLeadParams } from '../tools/sheets.js';
import { QualificationEngine } from './qualifier.js';
import { saveAgentLearning, getRecentLearnings, getCallerMemory, CallerMemoryContext } from '../tools/db.js';
import { getObjectionPlaybookPrompt, detectObjectionHint, seedObjectionLearnings } from './objections.js';
import { sarvamCircuitBreaker } from './circuit_breaker.js';
import { isNaturalSentenceBoundary } from './normalizer.js';

export const activeQualifiers = new Map<string, QualificationEngine>();

export function clearQualifier(key?: string): void {
  if (key) {
    activeQualifiers.delete(key);
  } else {
    activeQualifiers.clear();
  }
}

export const PRIYA_SYSTEM_PROMPT = `You are Priya, a friendly property advisor for Trishul Mittal Palms in Jakkur, North Bangalore.
You are on a live telephone call.

CORE GOAL:
Your primary objective is to FIX AN APPOINTMENT WITH OUR SALES MANAGER, DYLAN.
Do NOT get bogged down in technicalities, exact square footages, or specific balcony directions.
Keep all project details GENERIC, HIGH-LEVEL, and BRIEF.

CRITICAL VOICE CONVERSATION RULES:
1. ULTRA-SNAPPY & NATURAL (STRICT MAXIMUM 10 TO 20 WORDS, 1 TO 2 SHORT SENTENCES):
- This is a telephone call. Keep EVERY turn fast, conversational, and direct (10-20 words).
- Speak naturally like a friendly property advisor. Never monologue or recite long technical specifications.
- Use warm, natural acknowledgments like "Got it!", "Of course!", or "Certainly."

2. GENERIC HIGH-LEVEL FACTS (NEVER RECITE SPECIFIC SPECS):
- We have premium ready-to-move 2 and 3 BHK waterfront apartments right beside Jakkur Lake.
- Starting price is 1.25 crore rupees with immediate OC and zero GST.
- 15,000 sq ft clubhouse with rooftop pool and lake views.
- Do NOT quote exact square feet or unit-specific balcony facings over the phone.

3. FIX AN APPOINTMENT WITH SALES MANAGER (DYLAN):
- Position Dylan, our on-site Sales Manager, as the person to meet for unit views, pricing breakdowns, and layouts:
  "The best way to explore is a quick walkthrough with our sales manager, Dylan. Would Saturday or Sunday suit you?"
- When caller asks about 2 BHK or 3 BHK pricing / details:
  "Our homes start from 1.25 crore. Dylan, our sales manager, can walk you through the available units and lake views. Shall I fix a time for you this week?"
- When caller agrees or specifies a day/time ("today", "Saturday at 11 AM", "this weekend"):
  "Your appointment with Dylan is confirmed for [Day/Time]! May I have your name for the guest pass?"
- If caller asks for WhatsApp brochure:
  "I'm sending the brochure to your WhatsApp now! Would you also like me to reserve a slot with Dylan to see the property?"

4. HUMAN REALISM & AI IDENTITY:
- If asked "Are you a real person?", "Are you AI?", or "Are you a robot?":
  Answer warmly and naturally:
  "I'm Priya, an AI property advisor for Mittal Palms! I can answer quick questions or book you in with Dylan, our sales manager. How can I help?"
- Never falsely claim to be a human in an office. Be charming, transparent, and helpful.

5. SPEECH RECOGNITION (STT) GLITCHES:
- If caller's audio has a misheard word (e.g. "do-well gate" for 2 BHK, "fore vhk" for 4 BHK):
  NEVER point out their typo or say "I think you meant X instead of Y"! Just reply smoothly:
  "We have ready 2 and 3 BHK homes beside Jakkur Lake starting at 1.25 crore. Which size would you like to explore with Dylan?"

6. BILINGUAL (HINDI/HINGLISH):
- If caller speaks Hindi, reply in short, natural Hindi/Hinglish (e.g. "Mittal Palms mein ready 2 aur 3 BHK lake-facing homes hain 1.25 crore se. Kya aap hamare sales manager Dylan ke saath ek visit plan karna chahenge?").

7. HUMAN AGENT ESCALATION:
- ONLY trigger human transfer if caller explicitly and unequivocally asks to speak with a human or manager right now on the call:
  Reply: "[TRANSFER_TO_HUMAN] Of course! Connecting you directly to Dylan and our on-site team. Please stay on the line."`;

/**
 * NOTE: qualify_and_sync_lead is handled by QualificationEngine.syncLeadRecord(),
 * not by LLM function-calling. This definition is kept for reference only.
 */
// export const QUALIFY_TOOL_DEFINITION = { ... }; // removed — not passed to Groq API

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
}

export class LLMPipeline {
  private groq: Groq | null = null;
  private model: string = 'qwen/qwen3.8-27b';

  constructor() {
    const sarvamKey = process.env.SARVAM_API_KEY;
    const groqKey = process.env.GROQ_API_KEY;
    const openRouterKey = process.env.OPENROUTER_API_KEY;

    if (sarvamKey && sarvamKey !== 'your_sarvam_api_key_here') {
      console.log('[LLM] ⚡ Primary: Sarvam AI sarvam-105b-conversations (~200ms TTFT • Native Indian dialogue engine)');
    }
    if (groqKey && groqKey !== 'your_groq_api_key_here') {
      this.groq = new Groq({ apiKey: groqKey, maxRetries: 0 });
      console.log(`[LLM] ⚡ Secondary Fallback: Groq ${this.model}`);
    } else if (openRouterKey && openRouterKey !== 'your_openrouter_api_key_here') {
      console.log('[LLM] ⚡ Fallback: OpenRouter meta-llama/llama-3.3-70b-instruct');
    } else {
      console.warn('[LLM] Using local Trishul Mittal Palms qualification engine.');
    }

    // Auto-seed objection handling learnings into knowledge base
    seedObjectionLearnings();
  }

  /**
   * Streams LLM response tokens, triggers function calling if requested,
   * and yields text pieces to be voiced.
   *
   * Priority order:
   *   1. Sarvam AI sarvam-105b-conversations (ultra-low latency ~200ms TTFT, native Indian real estate dialogue)
   *   2. Groq Qwen 2.5 27B (ultra-low latency ~180-270ms TTFT fallback)
   *   3. OpenRouter LLaMA 3.3 70B (tertiary fallback)
   *   4. Deterministic Qualification Engine (exact script fallback)
   *   5. Hard-coded closing reply (last resort)
   */
  async *streamResponse(
    messages: ChatMessage[],
    callId: number | null,
    callerPhone: string,
    agentName: string = 'Priya',
    abortSignal?: AbortSignal,
    currentLanguage: 'en' | 'hi' = 'en'
  ): AsyncGenerator<string, void, unknown> {
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user')?.content?.trim() || '';

    // Maintain lead qualification state and entity extraction in background
    const key = `${callId ?? 'sim'}:${callerPhone}`;
    let qualifier = activeQualifiers.get(key);
    if (!qualifier) {
      qualifier = new QualificationEngine(callId, callerPhone, 'priya');
      activeQualifiers.set(key, qualifier);
    }
    qualifier.hydrateFromHistory(messages);

    // 1. PRIMARY: Sarvam AI sarvam-105b-conversations (native Indian voice dialogue, ~200ms TTFT)
    const sarvamKey = process.env.SARVAM_API_KEY;
    if (!sarvamCircuitBreaker.isExhausted && sarvamKey && sarvamKey !== 'your_sarvam_api_key_here' && !abortSignal?.aborted) {
      try {
        const contextualSystemPrompt = this.getPromptWithLearnings(callerPhone, agentName, lastUserMsg, currentLanguage);
        const nonSystemMessages = messages
          .filter((m) => m.role !== 'system')
          .slice(-6); // Keep last 6 dialogue messages (3 turns)
        const sarvamMessages = [
          { role: 'system', content: contextualSystemPrompt },
          ...nonSystemMessages.map((m) => ({
            role: m.role,
            content: m.content || '',
          })),
        ];

        const res = await fetch('https://api.sarvam.ai/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${sarvamKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'sarvam-105b-conversations',
            messages: sarvamMessages,
            temperature: 0.3,
            max_tokens: 50,
            stream: true,
          }),
          signal: abortSignal,
        });

        if (res.ok && res.body) {
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let sentenceBuffer = '';
          let fullReply = '';
          let lineBuffer = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (abortSignal?.aborted) break;

            lineBuffer += decoder.decode(value, { stream: true });
            const lines = lineBuffer.split('\n');
            lineBuffer = lines.pop() || '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith('data: ')) continue;
              const dataStr = trimmed.slice(6).trim();
              if (dataStr === '[DONE]') continue;

              try {
                const json = JSON.parse(dataStr);
                const delta = json.choices?.[0]?.delta?.content || '';
                if (delta) {
                  sentenceBuffer += delta;
                  fullReply += delta;

                  if (isNaturalSentenceBoundary(sentenceBuffer)) {
                    yield sentenceBuffer.trim();
                    sentenceBuffer = '';
                  }
                }
              } catch {}
            }
          }

          if (sentenceBuffer.trim() && !abortSignal?.aborted) {
            yield sentenceBuffer.trim();
          }

          if (fullReply.trim()) {
            console.log(`[Sarvam 105b-conversations Primary] ${agentName} reply: "${fullReply.trim()}"`);
            return;
          }
        }
      } catch (err: any) {
        if (abortSignal?.aborted) return;
        console.warn('[Sarvam 105b LLM] Notice, falling back to Groq:', err.message);
      }
    }

    // 2. SECONDARY: Groq Qwen 2.5 27B Fallback (ultra-low latency ~180ms TTFT)
    const groqKey = process.env.GROQ_API_KEY;
    if (groqKey && groqKey !== 'your_groq_api_key_here' && !abortSignal?.aborted) {
      try {
        if (!this.groq) {
          this.groq = new Groq({ apiKey: groqKey, maxRetries: 0 });
        }

        const contextualSystemPrompt = this.getPromptWithLearnings(callerPhone, agentName, lastUserMsg, currentLanguage);
        const nonSystemMessages = messages
          .filter((m) => m.role !== 'system')
          .slice(-6); // Keep last 6 dialogue messages (3 turns) to minimize tokens and prevent 429 ITPM limits
        const groqMessages = [
          { role: 'system' as const, content: contextualSystemPrompt },
          ...nonSystemMessages.map((m) => ({
            role: m.role as 'user' | 'assistant',
            content: m.content || '',
          })),
        ];

        const stream = await this.groq.chat.completions.create({
          model: this.model,
          messages: groqMessages,
          temperature: 0.3,
          max_tokens: 65,
          stream: true,
        });

        // Stream tokens and yield at natural sentence boundaries for low-latency TTS
        let sentenceBuffer = '';
        let fullReply = '';

        for await (const chunk of stream) {
          if (abortSignal?.aborted) break;
          const token = chunk.choices[0]?.delta?.content || '';
          if (token) {
            sentenceBuffer += token;
            fullReply += token;

            // Yield at natural sentence boundaries (protecting decimals like 1.25 and abbreviations)
            if (isNaturalSentenceBoundary(sentenceBuffer)) {
              yield sentenceBuffer.trim();
              sentenceBuffer = '';
            }
          }
        }

        // Flush any remaining partial sentence
        if (sentenceBuffer.trim() && !abortSignal?.aborted) {
          yield sentenceBuffer.trim();
        }

        if (fullReply.trim()) {
          console.log(`[Groq ${this.model} Primary] ${agentName} reply: "${fullReply.trim()}"`);
          return;
        }
      } catch (err: any) {
        if (abortSignal?.aborted) return;
        console.warn(`[Groq ${this.model}] Notice, falling back:`, err.message);
      }
    }

    // 2. FALLBACK A: OpenRouter LLaMA 3.3 70B (free / budget LLM fallback)
    const openRouterKey = process.env.OPENROUTER_API_KEY;
    if (openRouterKey && openRouterKey !== 'your_openrouter_api_key_here' && !abortSignal?.aborted) {
      try {
        const contextualSystemPrompt = this.getPromptWithLearnings(callerPhone, agentName, lastUserMsg, currentLanguage);
        const contextualMessages = [
          { role: 'system', content: contextualSystemPrompt },
          ...messages.filter((m) => m.role !== 'system'),
        ];

        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${openRouterKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://getmoreos.com',
            'X-Title': 'Trishul Mittal Palms Priya Voice Agent',
          },
          body: JSON.stringify({
            model: 'meta-llama/llama-3.3-70b-instruct',
            messages: contextualMessages.map((m) => ({ role: m.role, content: m.content })),
            temperature: 0.35,
            max_tokens: 65,
          }),
          signal: abortSignal,
        });

        if (res.ok) {
          const data: any = await res.json();
          const reply = data.choices?.[0]?.message?.content?.trim();
          if (reply) {
            console.log(`[OpenRouter Fallback] ${agentName} reply: "${reply.slice(0, 80)}${reply.length > 80 ? '…' : ''}"`);
            yield reply;
            return;
          }
        }
      } catch (err: any) {
        if (abortSignal?.aborted) return;
        console.warn('[OpenRouter LLM] Notice:', err.message);
      }
    }

    // 3. LAST RESORT FALLBACK: Conversational reply from Priya
    yield "Trishul Mittal Palms offers ready-to-move 2 and 3 BHK homes right beside Jakkur Lake. Are you looking for a 2 BHK or a 3 BHK for your family?";
  }

  /**
   * Generates a 2-sentence call summary for post-call logging.
   * Handled by Groq Qwen/LLaMA (0 Sarvam credits spent).
   */
  async generateSummary(transcript: string): Promise<string> {
    if (!transcript || transcript.trim().length === 0) {
      return 'No conversation recorded.';
    }

    // Primary: Groq Qwen (ultra-fast, 0 Sarvam credits spent)
    const groqKey = process.env.GROQ_API_KEY;
    if (groqKey && groqKey !== 'your_groq_api_key_here') {
      try {
        if (!this.groq) {
          this.groq = new Groq({ apiKey: groqKey });
        }
        const completion = await this.groq.chat.completions.create({
          model: this.model,
          messages: [
            {
              role: 'system',
              content:
                'Summarize this property inquiry call with advisor Priya for Trishul Mittal Palms in 1-2 concise sentences. Focus ONLY on confirmed requirements explicitly stated by the caller. If the caller denied or corrected an assumed budget (e.g. stating they never specified a budget), do NOT record that denied number as their budget. Note any scheduled site visit or follow-up.',
            },
            { role: 'user', content: `Call transcript:\n${transcript}` },
          ],
          temperature: 0.2,
          max_tokens: 80,
        });
        const summary = completion.choices[0]?.message?.content?.trim();
        if (summary) return summary;
      } catch (err: any) {
        console.warn('[Groq Summary] Notice:', err.message);
      }
    }

    return 'Inquiry regarding Trishul Mittal Palms in Jakkur, Bangalore with advisor Priya.';
  }

  /**
   * Continuous Post-Call Learning Engine:
   * Analyzes the conversation after every call.
   */
  async extractAndStoreLearnings(callId: number | null, transcript: string): Promise<void> {
    if (!transcript || transcript.trim().length < 30) return;

    let insight = 'Buyer explored Trishul Mittal Palms resale opportunity in Jakkur.';
    let type = 'general';
    if (transcript.includes('3 bhk') || transcript.includes('3bhk')) {
      insight = 'Buyer interested in 3 BHK (1,720 to 1,980 sq.ft) with lake view.';
      type = 'preference';
    } else if (transcript.includes('2 bhk') || transcript.includes('2bhk')) {
      insight = 'Buyer interested in 2 BHK (1,235 to 1,340 sq.ft) layout.';
      type = 'preference';
    } else if (transcript.includes('visit') || transcript.includes('weekend') || transcript.includes('saturday')) {
      insight = 'Site visit discussion initiated for upcoming weekend.';
      type = 'visit';
    }

    saveAgentLearning({
      call_id: callId,
      learning_type: type,
      key_insight: insight,
    });
  }

  /**
   * Generates dynamic prompt with real-time few-shot learnings and caller memory context.
   */
  getPromptWithLearnings(callerPhone?: string, agentName: string = 'Priya', lastUserMsg?: string, currentLanguage: 'en' | 'hi' = 'en'): string {
    const learnings = getRecentLearnings(8);
    // Deduplicate learnings to avoid repeating identical bullets
    const uniqueLearnings = Array.from(new Set((learnings || []).map((l) => l.key_insight)))
      .slice(0, 4)
      .map((insight) => `- ${insight}`)
      .join('\n');

    let memoryContextBlock = '';
    if (callerPhone) {
      const memory = getCallerMemory(callerPhone);
      const callerNameLine = memory.isReturningCaller && memory.existingLead?.callerName && memory.existingLead.callerName !== 'Valued Buyer' && memory.existingLead.callerName !== 'there'
        ? `- Known Contact Name: ${memory.existingLead.callerName}\n- STRICT RULE: Do NOT assume a site visit is booked or confirmed until the caller explicitly asks to book one in THIS call. Do NOT assume budget or configuration.`
        : `- Known Contact Name: None yet. Only ask for their name if they explicitly ask to book a site visit.`;

      memoryContextBlock = `
========================================================================
BACKGROUND REFERENCE CONTEXT (INTERNAL ADVISOR NOTES ONLY - NEVER ASSUME OR DECLARE TO CALLER):
- Caller Phone: ${memory.phoneNumber || callerPhone} (Inbound caller ID ALREADY captured. NEVER ask the caller for their phone number.)
${callerNameLine}
========================================================================`;
    }

    let coachingDirectiveBlock = '';
    if (lastUserMsg) {
      const hint = detectObjectionHint(lastUserMsg);
      if (hint) {
        coachingDirectiveBlock = `
========================================================================
REAL-TIME COACHING DIRECTIVE FOR THIS TURN:
${hint}
========================================================================`;
      }
    }

    let languageDirectiveBlock = '';
    if (currentLanguage === 'hi') {
      languageDirectiveBlock = `
========================================================================
ACTIVE CONVERSATION LANGUAGE: HINDI / HINGLISH
The caller is speaking in Hindi. You MUST reply in conversational Hindi or Hinglish (e.g. "Ji bilkul! Mittal Palms mein do aur teen BHK ready homes hain Jakkur Lake ke paas. 15,000 square feet ka clubhouse aur rooftop pool hai. Aap 2 ya 3 BHK dekh rahe hain?").
Do NOT switch back to English unless caller explicitly asks for English. Keep responses natural, warm, and concise (2 short sentences).
========================================================================`;
    }

    const basePrompt = PRIYA_SYSTEM_PROMPT;

    return `${basePrompt}

${memoryContextBlock}

${coachingDirectiveBlock}

${languageDirectiveBlock}

CONTINUOUS REAL-TIME LEARNINGS:
${uniqueLearnings || '- Maintain crisp 1-2 sentence conversational turns.'}`;
  }
}

export const llmPipeline = new LLMPipeline();
