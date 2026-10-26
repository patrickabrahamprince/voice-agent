import Groq from 'groq-sdk';
import { sheetsService, QualifyLeadParams } from '../tools/sheets.js';
import { QualificationEngine } from './qualifier.js';
import { saveAgentLearning, getRecentLearnings, getCallerMemory, CallerMemoryContext } from '../tools/db.js';

export const activeQualifiers = new Map<string, QualificationEngine>();

export function clearQualifier(key?: string): void {
  if (key) {
    activeQualifiers.delete(key);
  } else {
    activeQualifiers.clear();
  }
}

export const DYLAN_SYSTEM_PROMPT = `You are Dylan Dsouza, a professional and courteous property advisor representing Trishul Mittal Palms in Jakkur, Bangalore.
You are speaking live over a phone call with a prospective property buyer.

YOUR EXACT TALKING SCRIPT FLOW (STRICT SEQUENCE):
1. Greeting & Name Check:
   "Hi, good morning — am I speaking with [Name]?"
   (Wait for response)
2. Introduction & Exploration Check:
   "Hi, I’m Dylan Dsouza, a property advisor. I just wanted to check if you are exploring properties in Bangalore?"
   (Wait for response. If not interested, politely close: "Understood! Thank you for your time. Have an amazing day. Goodbye!")
3. Requirements Request:
   "Great! May I know your requirements?"
   (Wait for response)
4. Permission to Ask Questions:
   "I just need to ask a few quick questions to better understand your requirements — would that be alright?"
   (Wait for response)
5. Requirement Questions (ask naturally one-by-one):
   - "Are you looking for a 2 or 3 BHK?"
   - "Any particular size in mind?"
   - "And may I know which location you are most interested in?" (or: "Which location do you prefer?")
   - "Is it for self-use or an investment?"
   - "May I know your budget?"
6. Thank You & Walkthrough:
   "Thank you so much for the information, sir. I'll quickly walk you through the project details:
   This is an exclusive resale opportunity at Trishul Mittal Palms in Jakkur, Bangalore.
   • Setting: Built right beside tranquil Jakkur Lake with uninterrupted lake views, and directly behind the Jakkur Flying Club aerodrome in a gated community with massive open spaces and landscaped gardens.
   • Units & Sizes: 2 BHK ranging from 1,235 to 1,340 square feet and 3 BHK from 1,720 to 1,980 square feet, featuring up to 3 large balconies and an open utility area.
   • Clubhouse & Amenities: Fully equipped clubhouse, swimming pool, gymnasium, kids play area, sports area, 24/7 security, and 100% power backup.
   • Pricing: Exclusive resale rate of twelve thousand rupees per square foot.
   • Connectivity: Right next to Knowledge Habitat School and The HDFC School, 6.5 km to Manyata Tech Park, and direct signal-free access to Kempegowda International Airport."
7. WhatsApp Sharing & Follow-up Connection:
   "I’ll share the complete details with you on WhatsApp so you can take a look at the floor plans. Could we connect tomorrow to discuss this further? Please let me know a suitable time for you."
   (Wait for caller to specify a time)
8. Confirmation & Goodbye:
   "Thank you for your time. Have an amazing day. Goodbye!"

CRITICAL RULES:
1. ONLY SCRIPT: Follow Dylan Dsouza's conversation script step-by-step.
2. BREVITY: Keep responses crisp and conversational (1 to 2 short sentences).
3. PROPERTY ACCURACY: Project is Trishul Mittal Palms, Jakkur. Rate is ₹12,000 per sqft. 2 BHK (1,235–1,340 sqft), 3 BHK (1,720–1,980 sqft).
4. PHONETIC NUMBERS: Spell out numbers phonetically ("twelve thousand rupees per square foot", "two BHK", "three BHK").
5. POLITE CLOSING: Always close with: "Thank you for your time. Have an amazing day. Goodbye!"`;

// Compatibility export
export const PRIYA_SYSTEM_PROMPT = DYLAN_SYSTEM_PROMPT;

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
  private model: string = 'llama-3.3-70b-versatile';

  constructor() {
    const groqKey = process.env.GROQ_API_KEY;
    const sarvamKey = process.env.SARVAM_API_KEY;
    const openRouterKey = process.env.OPENROUTER_API_KEY;

    if (groqKey && groqKey !== 'your_groq_api_key_here') {
      this.groq = new Groq({ apiKey: groqKey });
      console.log('[LLM] ✅ Primary: Groq llama-3.3-70b-versatile (free tier, ultra-low latency, 131k context)');
    } else if (sarvamKey && sarvamKey !== 'your_sarvam_api_key_here') {
      console.log('[LLM] SARVAM_API_KEY active. Using Sarvam AI 105B (sarvam-105b-conversations) as fallback LLM.');
    } else if (openRouterKey && openRouterKey !== 'your_openrouter_api_key_here') {
      console.log('[LLM] OPENROUTER_API_KEY active. Using meta-llama/llama-3.3-70b-instruct as fallback LLM.');
    } else {
      console.warn('[LLM] No API key configured. Using local Trishul Mittal Palms qualification engine.');
    }
  }

  /**
   * Streams LLM response tokens, triggers function calling if requested,
   * and yields text pieces to be voiced.
   *
   * Priority order:
   *   1. Deterministic Qualification Engine (exact script, no hallucinations)
   *   2. Groq LLaMA 3.3 70B Versatile (free tier, primary LLM)
   *   3. Sarvam AI 105B (secondary fallback, if quota available)
   *   4. OpenRouter LLaMA 3.3 70B (tertiary fallback)
   *   5. Hard-coded closing reply (last resort)
   */
  async *streamResponse(
    messages: ChatMessage[],
    callId: number | null,
    callerPhone: string,
    agentName: string = 'Dylan Dsouza',
    abortSignal?: AbortSignal
  ): AsyncGenerator<string, void, unknown> {
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user')?.content?.trim() || '';

    // 1. DETERMINISTIC QUALIFICATION ENGINE:
    // Ensures Dylan Dsouza's exact 8-step script executes faithfully without hallucination.
    const key = `${callId ?? 'sim'}:${callerPhone}`;
    let qualifier = activeQualifiers.get(key);
    if (!qualifier) {
      qualifier = new QualificationEngine(callId, callerPhone, 'dylan');
      activeQualifiers.set(key, qualifier);
    }

    qualifier.hydrateFromHistory(messages);
    const deterministicReply = await qualifier.handleUtterance(lastUserMsg);
    if (deterministicReply) {
      yield deterministicReply;
      return;
    }

    // 2. PRIMARY: Groq LLaMA 3.3 70B Versatile (free tier — no quota issues)
    const groqKey = process.env.GROQ_API_KEY;
    if (groqKey && groqKey !== 'your_groq_api_key_here' && !abortSignal?.aborted) {
      try {
        // Ensure Groq client is initialized (lazy init if env was set after startup)
        if (!this.groq) {
          this.groq = new Groq({ apiKey: groqKey });
        }

        const contextualSystemPrompt = this.getPromptWithLearnings(callerPhone, agentName);
        const groqMessages = [
          { role: 'system' as const, content: contextualSystemPrompt },
          ...messages
            .filter((m) => m.role !== 'system')
            .map((m) => ({
              role: m.role as 'user' | 'assistant',
              content: m.content || '',
            })),
        ];

        const stream = await this.groq.chat.completions.create({
          model: this.model,
          messages: groqMessages,
          temperature: 0.3,
          max_tokens: 120,
          stream: true,
        });

        // Stream tokens and yield at sentence boundaries for low-latency TTS
        let sentenceBuffer = '';
        let fullReply = '';

        for await (const chunk of stream) {
          if (abortSignal?.aborted) break;
          const token = chunk.choices[0]?.delta?.content || '';
          if (token) {
            sentenceBuffer += token;
            fullReply += token;

            // Yield at natural sentence boundaries
            if (/[.!?\n]\s*$/.test(sentenceBuffer) && sentenceBuffer.trim().length > 8) {
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
          console.log(`[Groq llama-3.3-70b] Dylan reply: "${fullReply.trim().slice(0, 80)}${fullReply.length > 80 ? '…' : ''}"`);
          return;
        }
      } catch (err: any) {
        if (abortSignal?.aborted) return;
        // If it's a rate-limit (429) or quota error, log clearly and fall through
        const status = err?.status || err?.statusCode;
        if (status === 429) {
          console.warn('[Groq] Rate limit hit (429). Falling back to Sarvam/OpenRouter.');
        } else {
          console.warn('[Groq LLM] Notice:', err.message);
        }
      }
    }

    // 3. FALLBACK A: Sarvam AI 105B Conversations
    const sarvamKey = process.env.SARVAM_API_KEY;
    if (sarvamKey && sarvamKey !== 'your_sarvam_api_key_here' && !abortSignal?.aborted) {
      try {
        const contextualSystemPrompt = this.getPromptWithLearnings(callerPhone, agentName);
        const contextualMessages = [
          { role: 'system', content: contextualSystemPrompt },
          ...messages.filter((m) => m.role !== 'system'),
        ];

        const res = await fetch('https://api.sarvam.ai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'api-subscription-key': sarvamKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'sarvam-105b-conversations',
            messages: contextualMessages.map((m) => ({ role: m.role, content: m.content })),
            temperature: 0.25,
            max_tokens: 100,
          }),
          signal: abortSignal,
        });

        if (res.ok) {
          const data: any = await res.json();
          const reply = data.choices?.[0]?.message?.content?.trim();
          if (reply) {
            console.log(`[Sarvam 105B Fallback] Dylan Dsouza reply: "${reply.slice(0, 80)}${reply.length > 80 ? '…' : ''}"`);
            yield reply;
            return;
          }
        } else if (res.status === 402 || res.status === 429) {
          console.warn(`[Sarvam LLM] Quota/rate-limit (HTTP ${res.status}). Falling back to OpenRouter.`);
        }
      } catch (err: any) {
        if (abortSignal?.aborted) return;
        console.warn('[Sarvam 105B LLM] Notice:', err.message);
      }
    }

    // 4. FALLBACK B: OpenRouter LLaMA 3.3 70B
    const openRouterKey = process.env.OPENROUTER_API_KEY;
    if (openRouterKey && openRouterKey !== 'your_openrouter_api_key_here' && !abortSignal?.aborted) {
      try {
        const contextualSystemPrompt = this.getPromptWithLearnings(callerPhone, agentName);
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
            'X-Title': 'Trishul Mittal Palms Dylan Dsouza Voice Agent',
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
            console.log(`[OpenRouter Fallback] Dylan Dsouza reply: "${reply.slice(0, 80)}${reply.length > 80 ? '…' : ''}"`);
            yield reply;
            return;
          }
        }
      } catch (err: any) {
        if (abortSignal?.aborted) return;
        console.warn('[OpenRouter LLM] Notice:', err.message);
      }
    }

    // 5. LAST RESORT: Hard-coded closing reply
    yield "I'll share the complete details and floor plans on WhatsApp. Could we connect tomorrow to discuss this further? Please let me know a suitable time for you.";
  }

  /**
   * Generates a 2-sentence call summary for post-call logging.
   * Priority: Groq → Sarvam → static fallback.
   */
  async generateSummary(transcript: string): Promise<string> {
    if (!transcript || transcript.trim().length === 0) {
      return 'No conversation recorded.';
    }

    // 1. Groq LLaMA 3.3 70B (primary)
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
                'Summarize this property inquiry call with advisor Dylan Dsouza for Trishul Mittal Palms in 1-2 concise sentences focusing on requirement (BHK, size, budget, location) and scheduled follow-up time.',
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

    // 2. Sarvam AI 105B (fallback)
    const sarvamKey = process.env.SARVAM_API_KEY;
    if (sarvamKey && sarvamKey !== 'your_sarvam_api_key_here') {
      try {
        const res = await fetch('https://api.sarvam.ai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'api-subscription-key': sarvamKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'sarvam-105b-conversations',
            messages: [
              {
                role: 'system',
                content:
                  'Summarize this property inquiry call with advisor Dylan Dsouza for Trishul Mittal Palms in 1-2 concise sentences focusing on requirement (BHK, size, budget, location) and scheduled follow-up time.',
              },
              { role: 'user', content: `Call transcript:\n${transcript}` },
            ],
            temperature: 0.2,
            max_tokens: 80,
          }),
        });

        if (res.ok) {
          const data: any = await res.json();
          const summary = data.choices?.[0]?.message?.content?.trim();
          if (summary) return summary;
        }
      } catch (err: any) {
        console.warn('[Sarvam Summary] Notice:', err.message);
      }
    }

    return 'Inquiry regarding Trishul Mittal Palms in Jakkur, Bangalore with advisor Dylan Dsouza.';
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
    } else if (transcript.includes('tomorrow') || transcript.includes('time') || transcript.includes('connect')) {
      insight = 'Follow-up call connection requested for tomorrow via WhatsApp details.';
      type = 'followup';
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
  getPromptWithLearnings(callerPhone?: string, agentName: string = 'Dylan Dsouza'): string {
    const learnings = getRecentLearnings(5);
    const learningBullets =
      learnings && learnings.length > 0
        ? learnings.map((l) => `- [${l.learning_type.toUpperCase()}]: ${l.key_insight}`).join('\n')
        : '';

    let memoryContextBlock = '';
    if (callerPhone) {
      const memory = getCallerMemory(callerPhone);
      if (memory.isReturningCaller) {
        const lead = memory.existingLead;
        memoryContextBlock = `
========================================================================
CALLER RECOGNITION CONTEXT:
Caller Phone: ${memory.phoneNumber}
Returning Caller (${memory.totalPreviousCalls} previous interaction recorded)
Known Preferences:
- Configuration: ${lead?.config || '2 BHK or 3 BHK'}
- Budget: ${lead?.budget || 'Not specified'}
- Purpose: ${lead?.intent || 'Self-use'}
========================================================================`;
      }
    }

    return `${DYLAN_SYSTEM_PROMPT}

${memoryContextBlock}

CONTINUOUS REAL-TIME LEARNINGS:
${learningBullets || '- Follow Dylan Dsouza talking script precisely step-by-step.'}`;
  }
}

export const llmPipeline = new LLMPipeline();
