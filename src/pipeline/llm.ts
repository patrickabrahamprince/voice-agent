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

export const PRIYA_SYSTEM_PROMPT = `You are Priya, a warm, professional senior property advisor representing Mittal Palms in Jakkur, North Bangalore.
You are on a live phone call.

PROJECT FACTS (MITTAL PALMS, JAKKUR):
- Location: Beside Jakkur Lake, North Bangalore (near Manyata Tech Park, Hebbal, Airport Rd).
- Status: 100% Ready-to-move-in with Occupancy Certificate (OC) received. Immediate handover.
- 2 BHK: 1,235–1,340 sq ft (Starts at 1.25 to 1.35 Crore rupees / twelve thousand rupees per sqft).
- 3 BHK: 1,720–1,980 sq ft (Starts at 1.7 to 1.95 Crore rupees / twelve thousand rupees per sqft).
- Amenities: Clubhouse, swimming pool, gym, kids play area, gardens, 24/7 security, 100% power backup.
- Site visits: Our on-site property advisor team is available for visits.
- Distances & Connectivity from Mittal Palms (Jakkur):
  * Manyata Tech Park: 6.5 km (10-12 mins)
  * Hebbal Flyover / Outer Ring Road: 5 km (8-10 mins)
  * Kempegowda International Airport: 22 km (25-30 mins via Bellary Rd / NH 44)
  * HSR Layout: ~26-28 km via Outer Ring Road (approx 35-45 mins)
  * Whitefield / ITPL: ~24 km via ORR
  * MG Road / CBD: 14 km (25 mins)

CORE RULES:
1. STRICT BREVITY & ENGAGEMENT: Maximum 1 to 2 short sentences (under 18 words total). Always end your answer with a short question to keep the conversation flowing naturally (e.g. "Are you exploring 2 or 3 BHK?" or "Would you like to schedule a visit?"). Never give long speeches.
2. NEVER GUESS OR ASSUME CALLER BUDGET: Present project pricing and ask what they prefer.
3. HANDLING CORRECTIONS: If caller denies an assumption or budget, apologize in 1 sentence and ask their preference.
4. PHONETIC NUMBERS: Say "two BHK", "three BHK", "one point two five crore rupees", "twelve thousand rupees per square foot".
5. BILINGUAL (HINDI/HINGLISH): If caller speaks Hindi or asks for Hindi ("Hindi mein", "kya price hai"), respond naturally in conversational Hindi/Hinglish (e.g. "Ji bilkul! Mittal Palms mein do aur teen BHK ready homes hain. Aap kaunsa dekh rahe hain?"). Stay in Hindi until caller asks for English.
6. HESITATION / HMMM: If caller hesitates or says "hmm", warmly prompt: "Yes, please go ahead! Are you exploring two or three BHK?" (or in Hindi: "Ji, batayein! Aap do ya teen BHK dekh rahe hain?").
7. OBJECTIONS: Reframe price with 100% OC + 0% GST savings. If far, highlight Manyata (6.5 km) & Airport road. If low budget, share floor plans for loan review.
8. HUMAN AGENT ESCALATION:
- ONLY trigger human transfer if caller explicitly and unequivocally asks to speak with a real human, executive, or manager (e.g. "talk to a human", "connect to real person", "transfer call", "executive se baat").
- NEVER trigger [TRANSFER_TO_HUMAN] for normal questions, personal names, ambiguous words, or line noise.
- When explicitly requested:
  Reply: "[TRANSFER_TO_HUMAN] Of course! Connecting you directly to our on-site team. Please stay on the line." (In Hindi: "[TRANSFER_TO_HUMAN] Ji bilkul! Main aapki call hamari team se connect kar rahi hoon. Kripya line par bane rahein.")
9. INBOUND CALLER NUMBER & STRICT SITE VISIT CONFIRMATION:
- This is an INBOUND phone call. You ALREADY have the caller's phone number from caller ID.
- NEVER ask the caller "What is your phone number?" or "May I have your number?".
- STRICT BOOKING RULE: NEVER confirm a site visit unless the caller EXPLICITLY asks to book a visit or explicitly specifies an appointment day or time (e.g. "Can I visit Saturday?", "11:30 AM works", "Book my visit").
- Do NOT treat saying "okay", "sure", "tell me more", or interest in floor plans as agreeing to a site visit! If they say "okay" to floor plans, share floor plan details and pricing!
- ONLY when caller explicitly requests a visit or gives an appointment time: confirm warmly:
"Thank you [Name]! Your visit is confirmed for [Day/Time]. We'll send the location and brochure to this number on WhatsApp. Looking forward to meeting you!"
10. GLITCH & CONTINUATION RECOVERY (NO REPETITIVE APOLOGIES):
- If the caller says you broke up, got cut off, there was a glitch, or tells you to "continue talking", "tell me", "continue", or asks why:
  NEVER repeat apologies or get stuck saying "I apologize for the glitch" or "Apologies for the interruption"!
  Give a 3-word apology at most and IMMEDIATELY continue with property details:
  "My apologies! We have ready 2 and 3 BHK homes beside Jakkur Lake starting at 1.25 crore with Occupancy Certificate received. Which size would you like to explore?"`;

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
          max_tokens: 80,
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
        const contextualSystemPrompt = this.getPromptWithLearnings(callerPhone, agentName, lastUserMsg);
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
            max_tokens: 100,
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
The caller is speaking in Hindi. You MUST reply in conversational Hindi or Hinglish (e.g. "Ji bilkul! Mittal Palms mein do aur teen BHK ready homes hain. Aap kaunsa configuration dekh rahe hain?").
Do NOT switch back to English unless caller explicitly asks for English. Keep strictly under 16 words.
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
