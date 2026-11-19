import { saveAgentLearning, getRecentLearnings } from '../tools/db.js';

export interface ObjectionScenario {
  id: string;
  category: string;
  title: string;
  customerObjection: string;
  underlyingConcern: string;
  idealResponse: string;
  strategicPrinciple: string;
  keywords: string[];
}

export const OBJECTION_SCENARIOS: ObjectionScenario[] = [
  {
    id: 'who_is_this',
    category: 'Identity & Purpose',
    title: 'Who is this / Where are you calling from?',
    customerObjection: 'Who is this and where are you calling from?',
    underlyingConcern: 'Wants to verify who is calling before answering questions.',
    idealResponse: 'I am Nisha Prasad, just wanted to know are you currently looking for any investment options in Real Estate?',
    strategicPrinciple: 'State identity as Nisha Prasad clearly and ask if they are looking for real estate investment.',
    keywords: ['who is this', 'who are you', 'which company', 'where are you calling from', 'who speaking', 'koun bol raha hai'],
  },
  {
    id: 'whatsapp_request',
    category: 'Channel Preference',
    title: 'Send details on WhatsApp',
    customerObjection: 'Can you send details on WhatsApp?',
    underlyingConcern: 'Prefers receiving information on mobile.',
    idealResponse: 'Certainly, we will share details on WhatsApp! Just to help send relevant options, are you looking for an apartment, plot or villas?',
    strategicPrinciple: 'Acknowledge WhatsApp delivery warmly and continue qualifying with the next script question.',
    keywords: ['whatsapp', 'whats app', 'send on whatsapp', 'share on whatsapp', 'bhej do', 'send details'],
  },
  {
    id: 'not_interested',
    category: 'Opt Out',
    title: 'Not interested / Not looking',
    customerObjection: 'I am not interested, please do not call.',
    underlyingConcern: 'Does not want real estate options at this time.',
    idealResponse: 'I completely understand. Thank you for your time Eric, have a wonderful day ahead. Goodbye!',
    strategicPrinciple: 'Polite, immediate opt-out with no pressure.',
    keywords: ['not interested', "don't call", 'dont call', 'not looking', 'no need', 'wrong number', 'nahi chahiye'],
  },
  {
    id: 'negation_correction',
    category: 'Correction & Assumption Handling',
    title: 'Denial of assumed preference ("I never said that")',
    customerObjection: 'I never said that or that was not what I wanted.',
    underlyingConcern: 'Frustration with incorrect assumptions.',
    idealResponse: 'My sincere apologies for the confusion! What options do you have in mind?',
    strategicPrinciple: 'Zero defensiveness, apologize in 1 sentence, and ask their actual preference.',
    keywords: ['never said', 'never told you', "didn't say", 'did not say', 'wrong info'],
  },
];

/**
 * Detects if a caller utterance matches a known objection pattern
 * and returns targeted directive guidance for the LLM.
 */
export function detectObjectionHint(utterance: string): string | null {
  if (!utterance || utterance.trim().length === 0) return null;
  const lower = utterance.toLowerCase();

  // 1. Negation / Correction handling takes absolute highest priority
  if (
    lower.includes('never said') ||
    lower.includes('never told you') ||
    lower.includes('not my budget') ||
    lower.includes("didn't say") ||
    lower.includes('did not say') ||
    lower.includes('wrong budget')
  ) {
    return 'CRITICAL DIRECTIVE: The caller is correcting an incorrect assumption. Apologize in ONE short sentence, DO NOT repeat the disputed figure, and simply ask: "My sincere apologies for the confusion! What budget range do you have in mind?"';
  }

  // 2. Scan remaining objection scenarios
  for (const scenario of OBJECTION_SCENARIOS) {
    if (scenario.id === 'negation_correction') continue;
    const matched = scenario.keywords.some((kw) => lower.includes(kw));
    if (matched) {
      return `OBJECTION DETECTED (${scenario.title}): Follow principle: "${scenario.strategicPrinciple}". Model answer style: "${scenario.idealResponse}". Deliver a warm, helpful response in 2-3 natural sentences (~25-40 words).`;
    }
  }

  return null;
}

/**
 * Formats the full objection playbook for inclusion in the system prompt.
 */
export function getObjectionPlaybookPrompt(): string {
  const lines = OBJECTION_SCENARIOS.map(
    (s, i) => `${i + 1}. ${s.title}:
   - Customer pushback: "${s.customerObjection}"
   - Ideal response: "${s.idealResponse}"`
  );

  return `FIELD-TESTED REAL ESTATE OBJECTION PLAYBOOK (STRICT 1-2 SENTENCE BREVITY):
${lines.join('\n\n')}`;
}

/**
 * Seeds the objection handling scenarios into SQLite agent_learnings table.
 */
export function seedObjectionLearnings(): void {
  try {
    const recent = getRecentLearnings(50);
    const existingInsights = new Set(recent.map((r) => r.key_insight));

    for (const scenario of OBJECTION_SCENARIOS) {
      if (!existingInsights.has(scenario.strategicPrinciple)) {
        saveAgentLearning({
          call_id: null,
          learning_type: 'objection_handling',
          key_insight: scenario.strategicPrinciple,
          caller_utterance: scenario.customerObjection,
          best_response: scenario.idealResponse,
        });
      }
    }
  } catch (err: any) {
    console.warn('[Objections] Notice: Could not seed objection learnings:', err.message);
  }
}
