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

export const PRIYA_SYSTEM_PROMPT = `You are a professional, courteous, and knowledgeable senior property advisor representing MITTAL PALMS in Jakkur, North Bangalore.
You are speaking live over a phone call.

THE ONLY PROJECT OFFERED: MITTAL PALMS (JAKKUR, NORTH BANGALORE)
- Project: Mittal Palms
- Developer: Mittal
- Location: Jakkur, North Bangalore (near Manyata Tech Park, Hebbal, and Airport road)
- Land Parcel: 3.2 Acres, S + G + 7 Floors
- Status: 100% Ready-to-Move-In with Occupancy Certificate (OC) received. Immediate handover.
- Unit Configurations & Pricing:
  * 2 BHK: 1235 to 1340 Sq.ft. (Starts around 1.25 to 1.35 Crore rupees all-inclusive)
  * 3 BHK: 1750 to 1980 Sq.ft. (Starts around 1.7 to 1.95 Crore rupees all-inclusive)
- Lifestyle Amenities:
  * Premium Clubhouse, Landscaped Gardens, Swimming Pool, Kids Play Area, 24/7 Security, Power Backup
- On-Site Relationship Manager:
  * Raghavendra (Phone: 9945577935) for walkthroughs and site visits
- Registered Lead Email: niraj@mittal.com

CRITICAL SPOKEN PHONE RULES:
1. EXCLUSIVE SCOPE: Mittal Palms in Jakkur is the ONLY project we are offering. Never suggest other locations, builders, or generic Bangalore searches.
2. BREVITY: Keep every turn strictly 1 to 2 short sentences (under 25 words). Real humans speak in short turns.
3. DIRECT ANSWERS: If the caller asks about price, OC, location, or amenities, answer directly and immediately.
4. NO RIGID QUESTIONNAIRE: Do NOT interrogate the caller with multiple survey questions. Never ask which location in Bangalore they prefer—we only represent Mittal Palms in Jakkur.
5. SIMPLE QUALIFICATION & ACTION:
   - Identify if they need a 2 BHK or 3 BHK.
   - Offer a site walkthrough with Raghavendra (9945577935) or share floor plans on WhatsApp.
6. PHONETIC NUMBERS: Always spell out numbers phonetically ("two BHK", "three BHK", "one point seven crore rupees").`;

export const QUALIFY_TOOL_DEFINITION: Groq.Chat.Completions.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'qualify_and_sync_lead',
    description:
      'Records and qualifies the inbound real estate caller for Mittal Palms, syncing to Google Sheets and local database.',
    parameters: {
      type: 'object',
      properties: {
        caller_name: {
          type: 'string',
          description: "Caller's name if shared, or 'Valued Buyer' if unknown.",
        },
        phone_number: {
          type: 'string',
          description: "Caller's phone number.",
        },
        configuration: {
          type: 'string',
          description: "Preferred property configuration ('2 BHK' or '3 BHK').",
        },
        budget_bracket: {
          type: 'string',
          description: "Buyer's budget bracket (e.g., '1.25 - 1.35 Cr', '1.7 - 1.95 Cr').",
        },
        intent: {
          type: 'string',
          enum: ['Self-use', 'Investment', 'Unknown'],
          description: "Caller's intent: Self-use or Investment.",
        },
        site_visit_day: {
          type: 'string',
          description: "Preferred site walkthrough day with Raghavendra.",
        },
        lead_quality: {
          type: 'string',
          enum: ['Good Lead', 'Bad Lead'],
          description: "Classification: 'Good Lead' or 'Bad Lead'.",
        },
        qualification_reason: {
          type: 'string',
          description: "Reason explaining lead status.",
        },
      },
      required: [
        'caller_name',
        'phone_number',
        'configuration',
        'lead_quality',
      ],
    },
  },
};

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
    const sarvamKey = process.env.SARVAM_API_KEY;
    const apiKey = process.env.GROQ_API_KEY;
    if (sarvamKey && sarvamKey !== 'your_sarvam_api_key_here') {
      console.log('[LLM] SARVAM_API_KEY active. Using Sarvam AI 105B (sarvam-105b-conversations) as Main Voice Agent.');
    } else if (process.env.OPENROUTER_API_KEY) {
      console.log('[LLM] OPENROUTER_API_KEY active. Using meta-llama/llama-3.3-70b-instruct.');
    } else if (apiKey && apiKey !== 'your_groq_api_key_here') {
      this.groq = new Groq({ apiKey });
    } else {
      console.warn('[LLM] No API key configured. Using local Mittal Palms qualification engine.');
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
    agentName: string = 'Priya',
    abortSignal?: AbortSignal
  ): AsyncGenerator<string, void, unknown> {
    // 1. Primary: Sarvam AI 105B Conversations (India's Premier Voice AI Model)
    const sarvamKey = process.env.SARVAM_API_KEY;
    if (sarvamKey && sarvamKey !== 'your_sarvam_api_key_here') {
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
            max_tokens: 70,
          }),
          signal: abortSignal,
        });

        if (res.ok) {
          const data: any = await res.json();
          const reply = data.choices?.[0]?.message?.content?.trim();
          if (reply) {
            console.log(`[Sarvam 105B Voice Agent] Reply: "${reply}"`);
            yield reply;
            return;
          }
        } else {
          console.warn('[Sarvam 105B LLM] HTTP status:', res.status);
        }
      } catch (err: any) {
        if (abortSignal?.aborted) return;
        console.warn('[Sarvam 105B LLM] Notice, attempting OpenRouter fallback:', err.message);
      }
    }

    // 2. High-Performance OpenRouter LLaMA 3.3 70B (Secondary Fallback)
    const openRouterKey = process.env.OPENROUTER_API_KEY;
    if (openRouterKey && openRouterKey !== 'your_openrouter_api_key_here') {
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
            'X-Title': 'Mittal Palms Real Estate Voice Agent',
          },
          body: JSON.stringify({
            model: 'meta-llama/llama-3.3-70b-instruct',
            messages: contextualMessages.map((m) => ({ role: m.role, content: m.content })),
            temperature: 0.35,
            max_tokens: 70,
          }),
          signal: abortSignal,
        });

        if (res.ok) {
          const data: any = await res.json();
          const reply = data.choices?.[0]?.message?.content?.trim();
          if (reply) {
            yield reply;
            return;
          }
        } else {
          console.warn('[OpenRouter] HTTP status:', res.status);
        }
      } catch (err: any) {
        if (abortSignal?.aborted) return;
        console.warn('[OpenRouter] Falling back to qualification engine:', err.message);
      }
    }

    // 2. Groq Fallback
    if (this.groq) {
      try {
        const contextualSystemPrompt = this.getPromptWithLearnings(callerPhone, agentName);
        const contextualMessages: ChatMessage[] = [
          { role: 'system', content: contextualSystemPrompt },
          ...messages.filter((m) => m.role !== 'system'),
        ];

        const stream = await this.groq.chat.completions.create(
          {
            model: this.model,
            messages: contextualMessages as any,
            tools: [QUALIFY_TOOL_DEFINITION],
            tool_choice: 'auto',
            temperature: 0.4,
            max_tokens: 80,
            stream: true,
          },
          { signal: abortSignal }
        );

        for await (const chunk of stream) {
          if (abortSignal?.aborted) return;
          const delta = chunk.choices[0]?.delta;
          if (delta?.content) {
            yield delta.content;
          }
        }
        return;
      } catch (err: any) {
        if (abortSignal?.aborted) return;
        console.warn('[Groq] Falling back to local Mittal Palms engine:', err.message);
      }
    }

    // 3. Local Deterministic Qualification Engine for Mittal Palms
    const key = `${callId ?? 'sim'}:${callerPhone}`;
    let qualifier = activeQualifiers.get(key);
    if (!qualifier) {
      qualifier = new QualificationEngine(callId, callerPhone, 'priya');
      activeQualifiers.set(key, qualifier);
    }

    qualifier.hydrateFromHistory(messages);
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
    const response = await qualifier.handleUtterance(lastUserMsg);
    if (response) {
      yield response;
    }
  }

  /**
   * Generates a 2-sentence call summary for post-call logging.
   */
  async generateSummary(transcript: string): Promise<string> {
    if (!transcript || transcript.trim().length === 0) {
      return 'No conversation recorded.';
    }

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
                  'Summarize this Bangalore real estate inquiry call in 1-2 concise sentences focusing on requirement (BHK, budget, location) and outcome.',
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

    if (!this.groq) {
      return 'Caller enquired about Bangalore residential projects.';
    }

    try {
      const response = await this.groq.chat.completions.create({
        model: this.model,
        messages: [
          {
            role: 'system',
            content:
              'Summarize this Bangalore real estate inquiry call in 1-2 concise sentences focusing on requirement (BHK, budget, location) and outcome.',
          },
          {
            role: 'user',
            content: `Call transcript:\n${transcript}`,
          },
        ],
        temperature: 0.3,
        max_tokens: 80,
      });

      return response.choices[0]?.message?.content?.trim() || 'Inquiry regarding Bangalore properties.';
    } catch (err) {
      return 'Inquiry regarding Bangalore properties.';
    }
  }

  /**
   * Continuous Post-Call Learning Engine:
   * Analyzes the conversation after every call to extract buyer objection patterns,
   * pricing sensitivities, or locality nuances, and logs them into agent_learnings table.
   */
  async extractAndStoreLearnings(callId: number | null, transcript: string): Promise<void> {
    if (!transcript || transcript.trim().length < 30) return;

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
                  'You are an AI sales coach for Mittal Palms, Jakkur. Analyze this real estate call transcript and extract 1 key learning or buyer objection in JSON format: {"learning_type": "objection" | "pricing" | "commute" | "preference", "key_insight": "string", "caller_utterance": "string", "best_response": "string"}. Return ONLY valid JSON.',
              },
              { role: 'user', content: `Call Transcript:\n${transcript}` },
            ],
            temperature: 0.2,
            max_tokens: 150,
          }),
        });

        if (res.ok) {
          const data: any = await res.json();
          const raw = data.choices?.[0]?.message?.content?.trim();
          if (raw) {
            const cleanJson = raw.replace(/```json/g, '').replace(/```/g, '').trim();
            const parsed = JSON.parse(cleanJson);
            saveAgentLearning({
              call_id: callId,
              learning_type: parsed.learning_type || 'insight',
              key_insight: parsed.key_insight || 'Buyer inquiry pattern noted.',
              caller_utterance: parsed.caller_utterance || '',
              best_response: parsed.best_response || '',
            });
            console.log(`[Sarvam AI Self-Training] Learned from Call #${callId}: "${parsed.key_insight}"`);
            return;
          }
        }
      } catch (err: any) {
        console.warn('[Sarvam AI Self-Training] Notice:', err.message);
      }
    }

    try {
      if (this.groq) {
        const completion = await this.groq.chat.completions.create({
          model: this.model,
          messages: [
            {
              role: 'system',
              content:
                'You are an AI sales coach for Mittal Palms, Jakkur. Analyze this real estate call transcript and extract 1 key learning or buyer objection in JSON format: {"learning_type": "objection" | "pricing" | "commute" | "preference", "key_insight": "string", "caller_utterance": "string", "best_response": "string"}. Return ONLY valid JSON.',
            },
            {
              role: 'user',
              content: `Call Transcript:\n${transcript}`,
            },
          ],
          temperature: 0.2,
          max_tokens: 150,
          response_format: { type: 'json_object' },
        });

        const raw = completion.choices[0]?.message?.content?.trim();
        if (raw) {
          const parsed = JSON.parse(raw);
          saveAgentLearning({
            call_id: callId,
            learning_type: parsed.learning_type || 'insight',
            key_insight: parsed.key_insight || 'Buyer inquiry pattern noted.',
            caller_utterance: parsed.caller_utterance || '',
            best_response: parsed.best_response || '',
          });
          console.log(`[LLM Self-Training] Learned from Call #${callId}: "${parsed.key_insight}"`);
        }
      } else {
        // Heuristic learning extractor
        let insight = 'Buyer inquired about Mittal Palms Jakkur inventory.';
        let type = 'general';
        if (transcript.includes('Manyata') || transcript.includes('Hebbal')) {
          insight = 'Buyer commute centered near Manyata Tech Park / Hebbal corridor.';
          type = 'commute';
        } else if (transcript.includes('Cr') || transcript.includes('Lakh')) {
          insight = 'Budget expectations discussed around ready-to-move 2/3 BHK pricing.';
          type = 'pricing';
        } else if (transcript.includes('Saturday') || transcript.includes('Sunday') || transcript.includes('Raghavendra')) {
          insight = 'Weekend site visit walkthrough scheduled with Raghavendra.';
          type = 'walkthrough';
        }

        saveAgentLearning({
          call_id: callId,
          learning_type: type,
          key_insight: insight,
        });
        console.log(`[LLM Self-Training] Extracted learning for Call #${callId}: "${insight}"`);
      }
    } catch (err: any) {
      console.warn('[LLM Self-Training] Could not extract post-call learning:', err.message);
    }
  }

  /**
   * Generates dynamic prompt with real-time few-shot learnings from past calls and caller memory context.
   */
  getPromptWithLearnings(callerPhone?: string, agentName: string = 'Priya'): string {
    const learnings = getRecentLearnings(5);
    const learningBullets =
      learnings && learnings.length > 0
        ? learnings.map((l) => `- [${l.learning_type.toUpperCase()}]: ${l.key_insight}`).join('\n')
        : '';

    const basePrompt = PRIYA_SYSTEM_PROMPT.replace(
      'You are a professional, courteous, and knowledgeable senior property advisor',
      `You are ${agentName}, a professional, courteous, and knowledgeable senior property advisor`
    );

    let memoryContextBlock = '';
    if (callerPhone) {
      const memory = getCallerMemory(callerPhone);
      if (memory.isReturningCaller) {
        const lead = memory.existingLead;
        memoryContextBlock = `
========================================================================
CALLER RECOGNITION & LONG-TERM MEMORY CONTEXT:
Caller Phone: ${memory.phoneNumber}
Status: RETURNING BUYER (${memory.totalPreviousCalls} previous interaction recorded)
Known Previous Preferences:
- Preferred Configuration: ${lead?.config || '2 BHK or 3 BHK'}
- Estimated Budget Bracket: ${lead?.budget || 'Not specified'}
- Purpose / Intent: ${lead?.intent || 'Self-use'}
- Preferred Micro-Market: ${lead?.location || 'Mittal Palms, Jakkur'}
- Timeline: ${lead?.timeline || 'Ready to Move'}
- Site Visit Status: ${lead?.visitDay ? `Booked for ${lead.visitDay}` : 'Not yet booked'}
- Last Interaction Summary: "${memory.lastCallSummary || 'Enquired about Mittal Palms'}"

INSTRUCTIONS FOR RETURNING CALLER:
1. Greet them warmly as a returning buyer! Acknowledge their prior interest in Mittal Palms.
2. DO NOT re-ask questions they already answered in previous calls.
3. Progress directly towards confirming their weekend walkthrough with Raghavendra (9945577935) or answering their specific follow-up questions.
========================================================================`;
      } else {
        memoryContextBlock = `
========================================================================
CALLER CONTEXT:
Caller Phone: ${callerPhone}
Status: FIRST-TIME CALLER.
Follow the natural 5-stage qualification flow warmly. Track all answers in your mental scratchpad and NEVER re-ask questions they already answered earlier in this call.
========================================================================`;
      }
    }

    return `${basePrompt}

${memoryContextBlock}

CONTINUOUS REAL-TIME LEARNINGS (Self-trained from recent caller interactions):
${learningBullets || '- Maintain warm, natural 1-2 sentence conversational turns.'}`;
  }
}

export const llmPipeline = new LLMPipeline();

