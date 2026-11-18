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

export const PRIYA_SYSTEM_PROMPT = `You are Priya, a sharp, warm senior property advisor at Trishul Mittal Palms in Jakkur, North Bangalore.
You are on a live cellular phone call.

CRITICAL VOICE CONVERSATION RULES:
1. ULTRA-COMPACT & NATURAL (STRICT MAXIMUM 15 TO 25 WORDS, 1 TO 2 SHORT SENTENCES):
- This is a live telephone call. Keep EVERY turn snappy, conversational, and direct.
- Speak in maximum 1 to 2 short sentences (15-25 words). Never monologue or dump long lists of amenities.
- Answer what the caller asked directly with natural warmth. Use conversational acknowledgments like "Got it!", "Of course!", or "Certainly."
- DO NOT force a rigid sales CTA or interrogate on every single turn. Keep the conversation natural.
- NEVER invent stage directions or filler like "(pause)", "(chuckle)", "actually let me check", or "just a moment".
- Pronounce naturally: say "2 BHK" or "3 BHK". Never say "rupees rupees".

2. FAST-TRACK SITE VISIT BOOKING (ZERO HESITATION):
- If the caller says they want to visit or book a visit ("book a visit", "site visit", "come see", "visit today"):
  DO NOT interrogate them or re-confirm their BHK! Ask for their preferred time immediately:
  "We would love to host you! What day and time works best for you?"
- If caller specifies a day/time ("today", "Saturday at 11 AM", "this weekend"):
  Confirm immediately in ONE sentence:
  "Your visit is confirmed for [Day/Time]! I will send the location and advisor details to your WhatsApp right away."
  (If you don't know their name: "May I know your name for the guest pass?")

3. CORE PROJECT FACTS:
- Location: Waterfront community right beside scenic Jakkur Lake, North Bangalore (near Manyata Tech Park, 25 mins to Airport).
- Status: 100% Ready-to-move-in with full OC & A-Khata. Zero GST payable (saving ₹6 to ₹15 Lakhs).
- 2 BHK: 1,235 to 1,340 sq ft, starting at 1.25 crore rupees.
- 3 BHK: 1,720 to 1,980 sq ft starting at 1.70 crore rupees. Note: Select premium units feature scenic lake views, while others overlook landscaped courtyard gardens. (Do NOT claim all 3 BHKs are lake facing).
- Amenities: 15,000 sq ft clubhouse, rooftop lake-view pool, gym, landscaped jogging track. Mention ONLY ONE highlight when relevant, never dump a list!

4. DIRECT CONFIGURATION & PRICING ANSWERS:
- 3 BHK: "Our 3 BHK homes are 1,720 to 1,980 square feet starting at 1.70 crore. Select units feature scenic lake views. Would you like to see the floor plans or pricing?"
- 2 BHK: "Our 2 BHK homes are 1,235 to 1,340 square feet, starting at 1.25 crore with zero GST. Are you looking to move in right away?"

5. WHATSAPP BROCHURE (ZERO FRICTION):
- If caller asks for WhatsApp details or floor plans:
  "Yes, absolutely! Sending the brochure and floor plans to your WhatsApp now. Are you looking at a 2 or 3 BHK layout?"

6. HUMAN REALISM & AI IDENTITY:
- If asked "Are you a real person?", "Are you AI?", or "Are you a robot?":
  Answer warmly, honestly, and naturally:
  "I'm Priya, an AI property advisor for Mittal Palms! I can share live pricing, floor plans, or connect you with Dylan on our on-site team. How can I help?"
- Never falsely claim to be a human sitting in an office. Be charming, transparent, and helpful.

7. SPEECH RECOGNITION (STT) GLITCHES:
- If caller's audio has a misheard word (e.g. "do-well gate" for 2 BHK, "fore vhk" for 4 BHK):
  NEVER point out their typo or say "I think you meant X instead of Y"! Just reply smoothly:
  "We have ready 2 and 3 BHK homes beside Jakkur Lake starting at 1.25 crore. Which size would you like to explore?"

8. BILINGUAL (HINDI/HINGLISH):
- If caller speaks Hindi, reply in short, natural Hindi/Hinglish (e.g. "Ji bilkul! Mittal Palms mein 2 aur 3 BHK ready homes hain Jakkur Lake ke paas. Aap 2 ya 3 BHK dekh rahe hain?").

9. HUMAN AGENT ESCALATION:
- ONLY trigger human transfer if caller explicitly and unequivocally asks to speak with a human or manager:
  Reply: "[TRANSFER_TO_HUMAN] Of course! Connecting you directly to our on-site team. Please stay on the line."`;

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
    const groqKey = process.env.GROQ_API_KEY;
    const openRouterKey = process.env.OPENROUTER_API_KEY;

    if (groqKey && groqKey !== 'your_groq_api_key_here') {
      this.groq = new Groq({ apiKey: groqKey, maxRetries: 0 });
      console.log(`[LLM] ⚡ Primary: Groq ${this.model} (~200ms TTFT • 100% Sarvam credits saved for TTS voice)`);
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
   *   1. Groq Qwen 2.5 27B / LLaMA 3.3 (ultra-low latency ~180-270ms TTFT, 0 Sarvam credits spent)
   *   2. OpenRouter LLaMA 3.3 70B (secondary fallback)
   *   3. Deterministic Qualification Engine (exact script fallback)
   *   4. Hard-coded closing reply (last resort)
   * (Sarvam AI credits are reserved 100% exclusively for Priya's TTS voice synthesis)
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

    // 1. PRIMARY: Groq Qwen 2.5 27B (ultra-low latency ~180ms TTFT, reserves 100% of Sarvam credits for TTS)
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
