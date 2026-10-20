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
You are speaking live over a cellular phone call.

THE ONLY PROJECT OFFERED: MITTAL PALMS (JAKKUR, NORTH BANGALORE)
- Project Headline: Stop dreaming, start living. Why wait years for your dream home when you can move in today?
- Developer: Mittal
- Land: Spread across 3.2 Acres of thoughtfully planned development, offering spacious 2 & 3 BHK residences designed for families who value comfort, convenience, and a premium lifestyle.
- Elevation: S + G + 7 Floors (Stilt + Ground + 7 Floors)
- Status: 100% Ready-to-Move-In Homes with Occupancy Certificate (OC) received. Immediate handover.
- Unit Configurations & Floor Plans:
  * 2 BHK: 1235 to 1340 Sq.ft. (Starts around 1.25 to 1.35 Crore rupees all-inclusive)
  * 3 BHK: 1750 to 1980 Sq.ft. (Starts around 1.7 to 1.95 Crore rupees all-inclusive)
- Lifestyle Amenities:
  * Premium Clubhouse
  * Landscaped Gardens & Swimming Pool
  * Children's Play Area
  * Ample Parking
  * 24/7 Security
  * Power Backup
- Prime Location – Jakkur, North Bangalore:
  * Excellent connectivity to Hebbal & Yelahanka
  * Close to Manyata Tech Park
  * Easy access to Kempegowda International Airport
  * Near leading schools, hospitals & shopping centres
- Value Proposition:
  * Ready-to-Move-In Homes (No waiting, zero construction risk)
  * Spacious floor plans
  * Premium lifestyle amenities
  * Ideal for End Use & Investment
- On-Site Relationship Manager for Walkthroughs & Exclusive Offers:
  * Raghavendra (Phone: 9945577935)
  * Limited units available – book your visit today!
- Registered Lead Email: niraj@mittal.com

CRITICAL SPOKEN PHONE RULES:
1. EXCLUSIVE SCOPE: Mittal Palms in Jakkur is the ONLY project we are offering. Do NOT offer, mention, or suggest any other project, builder, or micro-market. Keep the conversation 100% focused on Mittal Palms.
2. BREVITY: Keep every spoken turn strictly 1 to 2 short sentences (under 25 words). Real humans speak in short turns, never long paragraphs.
3. NATURAL LISTENING: Acknowledge what the caller says with natural active listening markers: "Got it!", "Understood!", "Makes complete sense!", "Wonderful!".
4. DYNAMIC CORRECTION: If the caller changes their mind, corrects you, or clarifies (e.g. "I told you 2 BHK" or "looking for 2 BHK"), immediately acknowledge warmly without any argument: "Got it, 2 BHK! My apologies. For our ready 2 BHKs at Mittal Palms, we have 1235 to 1340 square feet...".
5. PHONETIC NUMBERS: Always spell out numbers phonetically ("two BHK", "three BHK", "one point three crore rupees", "twelve hundred square feet").
6. PROGRESSIVE QUALIFICATION FLOW:
   - 1. Configuration: Are you looking for a 2 or 3 BHK?
   - 2. Location Fit: Mittal Palms is in Jakkur, right near Manyata Tech Park and Hebbal. Does that North Bangalore commute work for you?
   - 3. Living Purpose: Moving in with family (self-use) or investment?
   - 4. Budget: 2 BHK (~1.25 to 1.35 Cr) or 3 BHK (~1.7 to 1.95 Cr)?
   - 5. Walkthrough & WhatsApp: Share floor plans on WhatsApp and book a walkthrough with Raghavendra (9945577935) this weekend.`;

export const QUALIFY_TOOL_DEFINITION: Groq.Chat.Completions.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'qualify_and_sync_lead',
    description:
      'Records and qualifies the inbound real estate caller as a Good Lead or Bad Lead based on the 5-question framework for Mittal Palms, and automatically syncs to Google Sheets and local database.',
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
          description: "Preferred property configuration (e.g., '2 BHK', '3 BHK', 'Unknown').",
        },
        location_preference: {
          type: 'string',
          description: "Preferred location or commute alignment with Jakkur / Manyata.",
        },
        budget_bracket: {
          type: 'string',
          description: "Buyer's budget bracket (e.g., '1.25 - 1.35 Cr', '1.7 - 1.95 Cr', 'Under 50L').",
        },
        intent: {
          type: 'string',
          enum: ['Self-use', 'Investment', 'Casual / Rental / Unknown'],
          description: "Caller's intent: Self-use or Investment.",
        },
        possession_timeline: {
          type: 'string',
          description: "Possession timeline (e.g., 'Ready to move', 'Immediate').",
        },
        site_visit_day: {
          type: 'string',
          description: "Preferred site walkthrough day with Raghavendra (e.g., 'Saturday 11 AM', 'Sunday 4 PM', 'Pending').",
        },
        lead_quality: {
          type: 'string',
          enum: ['Good Lead', 'Bad Lead'],
          description: "Classification: 'Good Lead' (Qualified buyer) or 'Bad Lead' (Disqualified / Low intent).",
        },
        lead_status: {
          type: 'string',
          enum: [
            'Good Lead - Hot (Visit Booked)',
            'Good Lead - Warm (Qualified)',
            'Bad Lead - Unqualified (Budget Mismatch)',
            'Bad Lead - Cold (Low Intent)',
          ],
          description: "Classification of lead quality and status.",
        },
        qualification_reason: {
          type: 'string',
          description: "1-sentence reason explaining why this caller is a Good Lead or Bad Lead.",
        },
      },
      required: [
        'caller_name',
        'phone_number',
        'configuration',
        'location_preference',
        'budget_bracket',
        'intent',
        'possession_timeline',
        'site_visit_day',
        'lead_quality',
        'lead_status',
        'qualification_reason',
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
    const apiKey = process.env.GROQ_API_KEY;
    if (apiKey && apiKey !== 'your_groq_api_key_here') {
      this.groq = new Groq({ apiKey });
    } else if (process.env.OPENROUTER_API_KEY) {
      console.log('[LLM] OPENROUTER_API_KEY active. Using meta-llama/llama-3.3-70b-instruct.');
    } else {
      console.warn('[LLM] No API key configured. Using local Mittal Palms qualification engine.');
    }
  }

  /**
   * Streams LLM response tokens, triggers function calling if requested,
   * and yields text pieces to be voiced by Cartesia/Sarvam TTS.
   */
  async *streamResponse(
    messages: ChatMessage[],
    callId: number | null,
    callerPhone: string,
    agentName: string = 'Dylan Dsouza',
    abortSignal?: AbortSignal
  ): AsyncGenerator<string, void, unknown> {
    const isDylan = agentName === 'Dylan Dsouza';

    // Prioritize the QualificationEngine for Dylan Dsouza to guarantee instant 0ms studio audio
    if (isDylan) {
      const key = `${callId ?? 'sim'}:${callerPhone}`;
      let qualifier = activeQualifiers.get(key);
      if (!qualifier) {
        qualifier = new QualificationEngine(callId, callerPhone, 'dylan');
        activeQualifiers.set(key, qualifier);
      }

      qualifier.hydrateFromHistory(messages);
      const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
      const response = await qualifier.handleUtterance(lastUserMsg);
      if (response) {
        yield response;
        return;
      }
    }

    // 1. High-Performance OpenRouter LLaMA 3.3 70B
    const openRouterKey = process.env.OPENROUTER_API_KEY;
    if (openRouterKey) {
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
            temperature: 0.4,
            max_tokens: 80,
          }),
          signal: abortSignal,
        });

        if (res.ok) {
          const data = await res.json();
          const reply = data.choices?.[0]?.message?.content?.trim();
          if (reply) {
            yield reply;
            return;
          }
        }
      } catch (err: any) {
        if (abortSignal?.aborted) return;
        console.warn('[OpenRouter] Falling back to qualification engine:', err.message);
      }
    }

    // 2. Groq Fallback
    if (this.groq) {
      try {
        const contextualSystemPrompt = this.getPromptWithLearnings(callerPhone);
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
            temperature: 0.5,
            max_tokens: 110,
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
        console.warn('[Groq] Falling back to qualification engine:', err.message);
      }
    }

    // 3. Local Autonomous Qualification Engine for Mittal Palms
    const key = `${callId ?? 'sim'}:${callerPhone}`;
    let qualifier = activeQualifiers.get(key);
    if (!qualifier) {
      qualifier = new QualificationEngine(callId, callerPhone);
      activeQualifiers.set(key, qualifier);
    }

    qualifier.hydrateFromHistory(messages);
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
    const response = await qualifier.handleUtterance(lastUserMsg);
    yield response;

    if (this.groq) {
      try {
        // Ensure system prompt contains the caller's memory context
        const contextualSystemPrompt = this.getPromptWithLearnings(callerPhone);
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
            temperature: 0.5,
            max_tokens: 110,
            stream: true,
          },
          { signal: abortSignal }
        );

      let accumulatedContent = '';
      const toolCallsMap: Record<number, { id: string; name: string; arguments: string }> = {};

      for await (const chunk of stream) {
        if (abortSignal?.aborted) {
          return;
        }

        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        // Collect text content
        if (delta.content) {
          accumulatedContent += delta.content;
          yield delta.content;
        }

        // Collect tool calls
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const index = tc.index ?? 0;
            if (!toolCallsMap[index]) {
              toolCallsMap[index] = {
                id: tc.id || '',
                name: tc.function?.name || '',
                arguments: '',
              };
            }
            if (tc.id) toolCallsMap[index].id = tc.id;
            if (tc.function?.name) toolCallsMap[index].name = tc.function.name;
            if (tc.function?.arguments) toolCallsMap[index].arguments += tc.function.arguments;
          }
        }
      }

      // Check if any tool calls were constructed
      const toolCalls = Object.values(toolCallsMap);
      if (toolCalls.length > 0) {
        for (const tc of toolCalls) {
          if (tc.name === 'qualify_and_sync_lead') {
            try {
              const args: QualifyLeadParams = JSON.parse(tc.arguments || '{}');
              args.call_id = callId;
              if (!args.phone_number || args.phone_number === 'unknown') {
                args.phone_number = callerPhone;
              }

              console.log('[LLM] Executing qualify_and_sync_lead with arguments:', args);
              const result = await sheetsService.qualifyAndSyncLead(args);

              // Append assistant tool call and tool response into dialogue history
              messages.push({
                role: 'assistant',
                tool_calls: [
                  {
                    id: tc.id,
                    type: 'function',
                    function: {
                      name: tc.name,
                      arguments: tc.arguments,
                    },
                  },
                ],
              });

              messages.push({
                role: 'tool',
                tool_call_id: tc.id,
                name: tc.name,
                content: JSON.stringify({
                  status: 'success',
                  synced: result.syncedToSheets,
                  lead_id: result.leadId,
                  message:
                    args.lead_quality === 'Bad Lead'
                      ? `Lead categorized as a Bad Lead (${args.qualification_reason || args.lead_status}). Acknowledge and close call politely.`
                      : `Lead successfully qualified as a Good Lead. Site visit: ${args.site_visit_day}. Location pin queued for dispatch.`,
                }),
              });

              // Stream follow-up confirmation from Priya
              const followUpStream = await this.groq.chat.completions.create(
                {
                  model: this.model,
                  messages: messages as any,
                  temperature: 0.6,
                  max_tokens: 100,
                  stream: true,
                },
                { signal: abortSignal }
              );

              for await (const chunk of followUpStream) {
                if (abortSignal?.aborted) return;
                const content = chunk.choices[0]?.delta?.content;
                if (content) {
                  yield content;
                }
              }
            } catch (err: any) {
              console.error('[LLM] Tool execution failed:', err?.message || err);
            }
          }
        }
      }
    } catch (err: any) {
      if (abortSignal?.aborted) {
        // Interruption cancellation - clean exit
        return;
      }
      console.error('[LLM] Streaming error:', err?.message || err);
      yield "I'm right here with you. Could you share your preferred location or budget?";
    }
  }
}

  /**
   * Generates a 2-sentence call summary for post-call logging.
   */
  async generateSummary(transcript: string): Promise<string> {
    if (!transcript || transcript.trim().length === 0) {
      return 'No conversation recorded.';
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
  getPromptWithLearnings(callerPhone?: string, agentName: string = 'Dylan Dsouza'): string {
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

