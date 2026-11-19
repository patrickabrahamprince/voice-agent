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

export const NISHA_SYSTEM_PROMPT = `You are Nisha Prasad, a professional, polite, and articulate real estate executive calling Eric Dsouza.
You are on a live telephone call.

CORE SCRIPT DIRECTIVE (STRICT: REMOVE ALL OTHER SCRIPTS):
You must speak ONLY according to this exact qualification script.
Do NOT mention Trishul Mittal Palms, Jakkur Lake, 1.25 Crore pricing, Dylan, clubhouse, OC, or any other project details.
This is a general real estate investment qualification call.

SCRIPT CONVERSATION FLOW:
1. GREETING (Handled automatically on call start):
   "Hi, am I speaking with Eric Dsouza? Good Morning/Afternoon/Evening, Eric."

2. AFTER ERIC CONFIRMS IDENTITY ("Yes" / "Speaking" / "Yeah"):
   Reply: "I am Nisha Prasad, just wanted to know are you currently looking for any investment options in Real Estate?"

3. AFTER ERIC CONFIRMS INTEREST ("Yes" / "I am looking" / "Yes, I am looking"):
   Proceed with the 8 qualification questions ONE BY ONE in strict order:
   Question 1: "Are you looking for an apartment, plot or villas?"
   Question 2: "How many bedrooms are you looking for?"
   Question 3: "Any particular size in mind?"
   Question 4: "Is it for self use or investment?"
   Question 5: "May I know your budget?"
   Question 6: "Which location do you prefer?"
   Question 7: "Are you looking for ready to move in or under construction?"
   Question 8: "How soon are you looking to book?"

4. AFTER ALL 8 QUESTIONS ARE ANSWERED:
   Reply: "Thank you so much for the information. May I know what is the best time for us to reach you at?"

5. AFTER ERIC GIVES THE BEST TIME:
   Reply: "Thank you so much, Eric! We will reach out to you then. Have a wonderful day! Goodbye."

CRITICAL VOICE TELEPHONY RULES:
- STRICT BREVITY: Ask ONLY ONE question at a time. Maximum 10 to 18 words per turn.
- NATURAL ACKNOWLEDGMENTS: When Eric answers a question, acknowledge briefly ("Got it!", "Understood.", "Noted.") and ask the NEXT question immediately.
- SMART ENTITY SKIP: If Eric already provided the answer to an upcoming question (e.g. "I am looking for a 3 BHK apartment in Whitefield"), acknowledge and SKIP the questions already answered. Ask the next unanswered question.
- IF ERIC ASKS WHO THIS IS OR WHICH COMPANY:
  Reply in 1 short sentence: "I am Nisha Prasad calling regarding real estate investment options. Are you currently looking for any properties?"
- IF ERIC IS NOT INTERESTED / OPT-OUT:
  Reply: "I completely understand. Thank you for your time Eric, have a wonderful day ahead. Goodbye!"
- NEVER MONOLOGUE. NEVER RECITE MULTIPLE QUESTIONS AT ONCE. NEVER SPEAK ABOUT ANY OTHER BUILDER OR PROPERTY.`;

// Alias for backwards compatibility
export const PRIYA_SYSTEM_PROMPT = NISHA_SYSTEM_PROMPT;

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
      console.warn('[LLM] Using local real estate qualification engine.');
    }
  }

  /**
   * Streams LLM response tokens, triggers function calling if requested,
   * and yields text pieces to be voiced.
   */
  async *streamResponse(
    messages: ChatMessage[],
    callId: number | null,
    callerPhone: string,
    agentName: string = 'Nisha Prasad',
    abortSignal?: AbortSignal,
    currentLanguage: 'en' | 'hi' = 'en'
  ): AsyncGenerator<string, void, unknown> {
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user')?.content?.trim() || '';

    // Maintain lead qualification state and entity extraction in background
    const key = `${callId ?? 'sim'}:${callerPhone}`;
    let qualifier = activeQualifiers.get(key);
    if (!qualifier) {
      qualifier = new QualificationEngine(callId, callerPhone, 'nisha');
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

        // Strict 1200ms timeout on Sarvam network calls to guarantee Priya never lags or freezes
        const timeoutSignal = AbortSignal.timeout(1200);
        const combinedSignal = abortSignal ? AbortSignal.any([abortSignal, timeoutSignal]) : timeoutSignal;

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
          signal: combinedSignal,
        });

        if (res.status === 402 || res.status === 429) {
          sarvamCircuitBreaker.markExhausted();
          console.warn(`[Sarvam 105b LLM] Quota exhausted (HTTP ${res.status}). Tripping circuit breaker: instant Groq fallback active.`);
        } else if (res.ok && res.body) {
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

    // 3. LAST RESORT FALLBACK: Conversational reply from Nisha Prasad
    yield "I am Nisha Prasad, just wanted to know are you currently looking for any investment options in Real Estate?";
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
                'Summarize this real estate qualification call with executive Nisha Prasad for client Eric Dsouza in 1-2 concise sentences. Focus on property type (apartment/plot/villa), bedrooms, size, purpose, budget, location, construction status, timeline, and best time to reach.',
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

    return 'Real estate investment inquiry with executive Nisha Prasad for Eric Dsouza.';
  }

  /**
   * Continuous Post-Call Learning Engine:
   * Analyzes the conversation after every call.
   */
  async extractAndStoreLearnings(callId: number | null, transcript: string): Promise<void> {
    if (!transcript || transcript.trim().length < 30) return;

    let insight = 'Buyer shared real estate investment preferences.';
    let type = 'general';
    const lower = transcript.toLowerCase();
    if (lower.includes('apartment') || lower.includes('flat')) {
      insight = 'Client interested in apartment configuration.';
      type = 'preference';
    } else if (lower.includes('plot') || lower.includes('land')) {
      insight = 'Client interested in plot / land investment.';
      type = 'preference';
    } else if (lower.includes('villa')) {
      insight = 'Client interested in villas.';
      type = 'preference';
    } else if (lower.includes('ready to move') || lower.includes('ready-to-move')) {
      insight = 'Client prefers ready to move in properties.';
      type = 'status';
    } else if (lower.includes('under construction')) {
      insight = 'Client open to under construction properties.';
      type = 'status';
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
  getPromptWithLearnings(callerPhone?: string, agentName: string = 'Nisha Prasad', lastUserMsg?: string, currentLanguage: 'en' | 'hi' = 'en'): string {
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
        ? `- Known Contact Name: ${memory.existingLead.callerName}`
        : `- Known Contact Name: Eric Dsouza`;

      memoryContextBlock = `
========================================================================
BACKGROUND REFERENCE CONTEXT:
- Caller Phone: ${memory.phoneNumber || callerPhone}
${callerNameLine}
========================================================================`;
    }

    let coachingDirectiveBlock = '';
    if (lastUserMsg) {
      const hint = detectObjectionHint(lastUserMsg);
      if (hint) {
        coachingDirectiveBlock = `
========================================================================
REAL-TIME COACHING DIRECTIVE:
${hint}
========================================================================`;
      }
    }

    const basePrompt = NISHA_SYSTEM_PROMPT;

    return `${basePrompt}

${memoryContextBlock}

${coachingDirectiveBlock}

CONTINUOUS REAL-TIME LEARNINGS:
${uniqueLearnings || '- Follow the exact Nisha Prasad qualification script in sequence.'}`;
  }
}

export const llmPipeline = new LLMPipeline();
