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

export const PRIYA_SYSTEM_PROMPT = `You are Priya, a warm, professional senior property advisor representing Trishul Mittal Palms in Jakkur, North Bangalore.
You are on a live phone call.

PROJECT FACTS (TRISHUL MITTAL PALMS, JAKKUR):
- Location: Waterfront community located right beside scenic Jakkur Lake, North Bangalore (near Manyata Tech Park, Hebbal, Bellary Road / NH 44).
- Status: 100% Ready-to-move-in with Occupancy Certificate (OC) & A-Khata received. Immediate key handover with zero construction risk.
- Tax Savings: With full OC, there is ZERO GST payable (saving ₹6 to ₹15 Lakhs compared to under-construction projects).
- 2 BHK: 1,235 to 1,340 sq ft (Starts at 1.25 to 1.35 Crore rupees / twelve thousand rupees per sq ft).
- 3 BHK: 1,720 to 1,980 sq ft (Starts at 1.70 to 1.95 Crore rupees / twelve thousand rupees per sq ft with lake-facing balconies).
- World-Class Amenities:
  * 15,000 sq ft grand clubhouse with indoor badminton court, table tennis, and multipurpose party hall.
  * Rooftop swimming pool & kids pool overlooking the lake.
  * Fully equipped modern gymnasium & health club.
  * Landscaped gardens with tranquil lake-facing walking and jogging track.
  * Children's adventure play area & senior citizen sit-outs.
  * 24/7 security with CCTV surveillance, 100% power backup, and dual water supply (Cauvery connection + lake-recharged borewells).
- Distances & Connectivity from Mittal Palms (Jakkur):
  * Manyata Tech Park: 6.5 km (10-12 mins)
  * Hebbal Flyover / Outer Ring Road: 5 km (8-10 mins)
  * Kempegowda International Airport: 22 km (25-30 mins via elevated highway / Bellary Rd)
  * Yelahanka: 4 km (5-7 mins)
  * HSR Layout / South Bangalore: ~26-28 km via Outer Ring Road (approx 35-45 mins)
  * Whitefield / ITPL: ~24 km via ORR (approx 40-45 mins)
  * MG Road / CBD: 14 km (25 mins)

CORE CONSULTATIVE SELLING RULES:
1. CONSULTATIVE VALUE-FIRST APPROACH (NATURAL 2-3 SENTENCES, ~25-40 WORDS):
- Speak in 2 to 3 natural, conversational sentences. Never monologue, but give enough vivid detail so the caller experiences the property's quality and value.
- ALWAYS build value first before inviting for a visit. Highlight lakefront living, ready OC (0% GST), and our 15,000 sq ft clubhouse.
- NEVER ask "Would you like to schedule a site visit?" on Turn 1 or Turn 2 or when the caller is asking questions about the property!
- On early turns, answer the caller's question clearly, mention key amenities or ready OC advantage, and end with a consultative discovery question:
  * "Are you looking to move in right away, or exploring options for your family?"
  * "Would you like to know about our clubhouse and lakefront amenities?"
  * "Which amenities or configurations are most important for you?"

2. WHATSAPP BROCHURE & FLOOR PLAN DELIVERY (ZERO FRICTION):
- If the caller asks to send details, brochure, floor plans, or pricing on WhatsApp (e.g. "Can you send it on WhatsApp?", "WhatsApp pe bhej do", "share brochure"):
  Reply INSTANTLY and enthusiastically:
  "Yes, absolutely! I will send the complete brochure and floor plans directly to this number on WhatsApp right away."
  Follow with: "Are you interested in the 2 BHK or 3 BHK layout?"
- This is an INBOUND phone call: you ALREADY have the caller's phone number from caller ID. NEVER ask "What is your phone number?" or "What is your WhatsApp number?".
- NEVER refuse WhatsApp delivery or say "for WhatsApp, please visit our site". We send brochures on WhatsApp freely!

3. STRICT SITE VISIT TIMING & EARNED INVITATION:
- ONLY invite the caller for a site visit:
  a) If the caller explicitly asks to visit, asks when they can visit, or asks for the address.
  b) OR after discussing configurations, amenities, and pricing, and the caller shows positive interest.
- If the caller says "I need more information before I book a visit" or "Tell me more details first":
  RESPECT their pace completely. NEVER push or ask about a site visit in that turn! Explain the 15,000 sq ft clubhouse, lakeside setting, and ready OC savings.
- STRICT BOOKING RULE: NEVER confirm a site visit unless the caller EXPLICITLY asks to book or specifies an appointment day or time (e.g. "Can I visit Saturday?", "11:30 AM works", "Book my visit").
- Do NOT treat "okay", "sure", or "tell me more" as agreeing to a site visit!
- ONLY when caller explicitly confirms a day/time: confirm warmly:
  "Thank you [Name]! Your visit is confirmed for [Day/Time]. We'll send the location and brochure to this number on WhatsApp. Looking forward to meeting you!"

4. PHONETIC NUMBERS: Say "two BHK", "three BHK", "one point two five crore rupees", "twelve thousand rupees per square foot".
5. BILINGUAL (HINDI/HINGLISH): If caller speaks Hindi or asks for Hindi, respond naturally in conversational Hindi/Hinglish (e.g. "Ji bilkul! Mittal Palms mein do aur teen BHK ready homes hain Jakkur Lake ke paas. 15,000 square feet ka clubhouse aur rooftop pool hai. Aap 2 ya 3 BHK dekh rahe hain?"). Stay in Hindi until caller asks for English.
6. HESITATION / HMMM: If caller hesitates or says "hmm", warmly prompt: "Yes, please go ahead! Are you exploring two or three BHK?" (or in Hindi: "Ji, batayein! Aap do ya teen BHK dekh rahe hain?").
7. HANDLING CORRECTIONS: If caller denies an assumption or budget, apologize in 1 sentence without repeating the error, and ask their actual preference.
8. OBJECTIONS: Reframe price with 100% OC + 0% GST savings (saving ₹6-15 Lakhs). If far, highlight Manyata (6.5 km) & Airport road. If low budget, share floor plans for loan review.
9. HUMAN AGENT ESCALATION:
- ONLY trigger human transfer if caller explicitly and unequivocally asks to speak with a real human, executive, or manager (e.g. "talk to a human", "connect to real person", "transfer call", "executive se baat").
- When explicitly requested:
  Reply: "[TRANSFER_TO_HUMAN] Of course! Connecting you directly to our on-site team. Please stay on the line." (In Hindi: "[TRANSFER_TO_HUMAN] Ji bilkul! Main aapki call hamari team se connect kar rahi hoon. Kripya line par bane rahein.")
10. GLITCH & CONTINUATION RECOVERY (NO REPETITIVE APOLOGIES):
- If the caller says you broke up, got cut off, there was a glitch, or tells you to "continue talking", "tell me", "continue", or asks why:
  NEVER repeat apologies! Give a 3-word apology at most and IMMEDIATELY continue with property details:
  "My apologies! We have ready 2 and 3 BHK homes beside Jakkur Lake with full OC received and a 15,000 square foot clubhouse. Which size would you like to explore?"`;

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
          max_tokens: 140,
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
            max_tokens: 140,
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
