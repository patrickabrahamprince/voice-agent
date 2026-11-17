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
    id: 'price_high',
    category: 'Pricing & Valuation',
    title: 'Price is too high / ₹12,000 per sqft is expensive',
    customerObjection: 'Your price of 12,000 per sq ft is too expensive compared to other Jakkur projects.',
    underlyingConcern: 'Price-value justification, fear of overpaying compared to under-construction projects.',
    idealResponse: 'Since Mittal Palms has full Occupancy Certificate, there is zero GST, saving you 6 to 15 lakhs immediately, plus uninterrupted lake views and a 15,000 square foot clubhouse. Would you like to know more about the layouts or amenities?',
    strategicPrinciple: 'Offset price resistance with 0% GST savings, zero construction risk, ready OC, and lakefront lifestyle. Do NOT push for a site visit prematurely.',
    keywords: ['price', 'expensive', 'costly', 'too high', 'rate is high', '12000', '12,000', 'cheaper', 'high price', 'quote is high'],
  },
  {
    id: 'budget_low',
    category: 'Budget Fit',
    title: 'Budget is lower (e.g. Under 1 Crore / 80-90 Lakhs)',
    customerObjection: 'My budget is only 80 to 90 Lakhs, do you have anything in that range?',
    underlyingConcern: 'Hard budget boundary and fear of being pushed into unaffordable options.',
    idealResponse: 'Our 2 BHK starts at one point two five crore rupees due to the spacious 1,235 square feet layout and ready OC. If you are open to bank loan options, would you like to review the floor plans?',
    strategicPrinciple: 'Acknowledge budget politely without demeaning, state realistic starting point, and offer floor plans with loan guidance.',
    keywords: ['under 1 crore', 'under 1 cr', '80 lakh', '90 lakh', '50 lakh', '60 lakh', '70 lakh', 'low budget', 'budget is less', 'affordable'],
  },
  {
    id: 'location_commute',
    category: 'Location & Commute',
    title: 'Jakkur is too far from Whitefield / South Bangalore',
    customerObjection: 'Jakkur is too far from my office in Whitefield or South Bangalore.',
    underlyingConcern: 'Daily commute anxiety, traffic exhaustion, and distance from major tech corridors.',
    idealResponse: 'Manyata Tech Park is just six point five kilometers away, with direct airport expressway access and upcoming Metro. Is your primary focus office commute or a peaceful lakefront home?',
    strategicPrinciple: 'Reframe location around rapid connectivity corridors (Manyata, Airport road, Metro) and tranquil lakefront lifestyle.',
    keywords: ['too far', 'far away', 'whitefield', 'electronic city', 'south bangalore', 'commute', 'distance', 'traffic', 'travel time'],
  },
  {
    id: 'water_monsoon',
    category: 'Infrastructure & Utilities',
    title: 'Water supply & monsoon water logging concerns',
    customerObjection: 'Is there Cauvery water, or will there be water shortages and monsoon flooding near the lake?',
    underlyingConcern: 'Living distress from water scarcity, heavy tanker dependence, or monsoon waterlogging.',
    idealResponse: 'We have 24/7 dual water supply with dedicated borewells recharged by Jakkur Lake alongside Cauvery pipeline infrastructure, with zero water logging due to elevated topography. Would you like to know more about our eco-friendly lakefront features?',
    strategicPrinciple: 'Turn lake proximity into a groundwater recharge asset while confirming Cauvery supply and elevated drainage.',
    keywords: ['cauvery', 'water problem', 'water shortage', 'flooding', 'water logging', 'tanker', 'monsoon', 'drainage', 'borewell'],
  },
  {
    id: 'legal_oc',
    category: 'Legal & Approvals',
    title: 'Occupancy Certificate (OC) & Khata verification',
    customerObjection: 'Is the Occupancy Certificate actually approved? Are there any pending legal or title issues?',
    underlyingConcern: 'Fear of legal traps, delayed handover, unapproved deviations, or demolition notices.',
    idealResponse: 'Yes, 100 percent clear title with full Occupancy Certificate and A-Khata already received. I can share all original government approvals directly with you or during your visit.',
    strategicPrinciple: 'State 100% OC and A-Khata with absolute clarity and offer verification of physical documents on-site.',
    keywords: ['oc received', 'occupancy certificate', 'a-khata', 'a khata', 'legal issue', 'litigation', 'bbmp approved', 'bda approved', 'clear title', 'approvals'],
  },
  {
    id: 'timeline_future',
    category: 'Timeline & Readiness',
    title: 'Not buying now / planning after 6 months to a year',
    customerObjection: 'I am not buying right now, just casually exploring for next year.',
    underlyingConcern: 'Resistance to aggressive sales pressure when not in an immediate buying window.',
    idealResponse: 'That is completely fine! Since ready OC resale homes in North Bangalore are appreciating fast, visiting now gives you a great benchmark. Would you like to drop by this Saturday for a casual walkthrough?',
    strategicPrinciple: 'Remove pressure while positioning a preview visit as valuable market intelligence before prices rise.',
    keywords: ['not buying now', 'next year', 'after 6 months', 'casual', 'just browsing', 'just looking', 'not in a hurry', 'later stage'],
  },
  {
    id: 'family_consult',
    category: 'Decision Authority',
    title: 'Need to discuss with family / spouse first',
    customerObjection: 'I need to discuss with my husband and family before making any decision.',
    underlyingConcern: 'Shared financial commitment requiring household buy-in and consensus.',
    idealResponse: 'Home buying is definitely a family decision! Why don\'t you bring your family along for a relaxed visit this weekend so everyone can experience the lake view together?',
    strategicPrinciple: 'Validate family involvement warmly and pivot the visit to an enjoyable weekend family experience.',
    keywords: ['discuss with my wife', 'discuss with my husband', 'ask my family', 'ask my parents', 'need to talk to family', 'spouse', 'partner'],
  },
  {
    id: 'whatsapp_request',
    category: 'Channel Preference',
    title: 'Send on WhatsApp / Share Brochure & Floor Plans Request',
    customerObjection: 'Can you send details/brochure on WhatsApp?',
    underlyingConcern: 'Wants to inspect visual floor plans, layouts, and pricing on their phone without immediate pressure.',
    idealResponse: 'Yes, absolutely! I will send the complete brochure, floor plans, and pricing directly to this number on WhatsApp right away. Are you interested in the 2 BHK or 3 BHK layout?',
    strategicPrinciple: 'Confirm WhatsApp delivery immediately and enthusiastically to their caller ID number without asking for their phone number, then qualify configuration.',
    keywords: [
      'whatsapp',
      'whats app',
      'send on whatsapp',
      'send it on whatsapp',
      'share on whatsapp',
      'brochure on whatsapp',
      'bhej do',
      'send brochure',
      'share brochure',
      'send floor plans',
      'share floor plans',
      'send details',
      'share details',
      'send photos',
      'send images',
      'whatsapp pe'
    ],
  },
  {
    id: 'more_info_first',
    category: 'Information & Amenities Focus',
    title: 'Wants property details & amenities before considering a visit',
    customerObjection: 'I need to know more details and amenities about the property before I book a visit.',
    underlyingConcern: 'Reluctance to commit to a site visit without knowing if the amenities, lakefront location, and project features justify the trip.',
    idealResponse: 'Mittal Palms sits right beside Jakkur Lake with ready OC, featuring a 15,000 square foot clubhouse, rooftop swimming pool, gym, and lakefront gardens. All homes have 100 percent OC so you save 0 percent GST. Which amenities are most important for your family?',
    strategicPrinciple: 'Never push for a visit when caller asks for details first. Build excitement around Jakkur Lakefront living, 15,000 sq ft clubhouse, pool, gym, landscaped gardens, and ready OC possession.',
    keywords: [
      'more info',
      'more information',
      'tell me more',
      'more details',
      'details about the property',
      'what amenities',
      'what are the amenities',
      'tell me about amenities',
      'what do you have',
      'before i book',
      'before booking',
      'before visiting',
      'before i visit',
      'repeat that again',
      'know more details',
      'know more information'
    ],
  },
  {
    id: 'resale_vs_builder',
    category: 'Property Status',
    title: 'Is this resale or direct from developer?',
    customerObjection: 'Is this unit directly from the builder or a resale property?',
    underlyingConcern: 'Clarity on transfer process, condition of flat, and price transparency.',
    idealResponse: 'These are exclusive ready-to-move units with immediate possession, meaning you get a brand-new ready home with no construction delays and zero GST. Would you like me to share the floor plans and layout options?',
    strategicPrinciple: 'Highlight the dual financial and peace-of-mind benefits of ready resale: zero GST and immediate possession.',
    keywords: ['resale', 'builder', 'developer', 'first owner', 'secondary sale', 'is this resale', 'from builder'],
  },
  {
    id: 'negation_correction',
    category: 'Correction & Assumption Handling',
    title: 'Denial of assumed budget or preference ("I never said that")',
    customerObjection: 'I never told you that my budget is 2.25 crores or that I wanted a 3 BHK.',
    underlyingConcern: 'Frustration with presumptuous agents who do not listen or impose fabricated details.',
    idealResponse: 'My sincere apologies for the confusion! What budget range or configuration do you have in mind?',
    strategicPrinciple: 'Zero defensiveness, immediately drop the disputed number, apologize in 1 sentence, and ask their actual preference.',
    keywords: ['never said', 'never told you', 'not my budget', "didn't say", 'did not say', 'wrong budget', 'wrong number', 'wrong info'],
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
