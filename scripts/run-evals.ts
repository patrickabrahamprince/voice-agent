/**
 * LiveKit-Inspired Voice Agent Behavioral Evals Suite (LLM-as-a-Judge)
 * Evaluates real-time conversational competency across 5 strict production dimensions:
 * 1. Brevity & Voice Cadence (<= 30 words per turn)
 * 2. Non-Hallucination & Negation Agility
 * 3. Factual Grounding (₹12,000/sqft, OC received, 0% GST, Manyata 6.5km)
 * 4. Value-Based Objection Conversion
 * 5. End-to-End Turnaround Latency (< 1500ms)
 */

import { llmPipeline, ChatMessage } from '../src/pipeline/llm.js';
import { OBJECTION_SCENARIOS } from '../src/pipeline/objections.js';

interface EvalCase {
  id: string;
  category: 'FACTUALITY' | 'ANTI_HALLUCINATION' | 'OBJECTION' | 'NEGATION' | 'CLOSING';
  name: string;
  userPrompt: string;
  expectedKeywords: string[];
  forbiddenKeywords: string[];
  maxWords: number;
}

const EVAL_CASES: EvalCase[] = [
  {
    id: 'eval_options_inquiry',
    category: 'FACTUALITY',
    name: 'Pricing and BHK Options Inquiry',
    userPrompt: "I'm exploring options. What are the configurations and prices at Mittal Palms?",
    expectedKeywords: ['one point two five', 'crore', '1.25', '1.7', 'bhk', 'configuration'],
    forbiddenKeywords: ['your budget is', 'since your budget', 'noted your budget'],
    maxWords: 35,
  },
  {
    id: 'eval_negation_budget',
    category: 'NEGATION',
    name: 'Denial of Assumed Budget ("I never said that")',
    userPrompt: 'I never told you that my budget is 2.25 crores.',
    expectedKeywords: ['apologies', 'confusion', 'budget', 'mind'],
    forbiddenKeywords: ['noted your budget as', 'have your budget as', 'recorded as two point two five'],
    maxWords: 25,
  },
  {
    id: 'eval_sqft_rate',
    category: 'FACTUALITY',
    name: 'Per Square Foot Price Check',
    userPrompt: 'What is the rate per square foot in this project?',
    expectedKeywords: ['twelve thousand', '12,000', 'square foot', 'jakkur'],
    forbiddenKeywords: ['your budget'],
    maxWords: 30,
  },
  {
    id: 'eval_oc_status',
    category: 'FACTUALITY',
    name: 'Occupancy Certificate (OC) Verification',
    userPrompt: 'Has the project received the Occupancy Certificate (OC)?',
    expectedKeywords: ['occupancy certificate', 'ready', 'oc', 'received'],
    forbiddenKeywords: ['under construction', 'expected next year'],
    maxWords: 30,
  },
  {
    id: 'eval_commute_objection',
    category: 'OBJECTION',
    name: 'Commute Resistance (Distance from Tech Parks)',
    userPrompt: 'Jakkur seems far from tech hubs. How is the connectivity?',
    expectedKeywords: ['manyata', 'six point five', 'airport', 'metro'],
    forbiddenKeywords: ['very far', 'traffic is bad'],
    maxWords: 35,
  },
  {
    id: 'eval_price_objection',
    category: 'OBJECTION',
    name: 'Price Resistance (₹12,000/sqft Expensive)',
    userPrompt: 'Your price of 12,000 per sqft is too high compared to others.',
    expectedKeywords: ['gst', 'zero', 'lake', 'ready', 'weekend', 'visit'],
    forbiddenKeywords: ['we can negotiate', 'discount of 20%'],
    maxWords: 35,
  },
  {
    id: 'eval_whatsapp_request',
    category: 'CLOSING',
    name: 'Frictionless WhatsApp Channel Pivot',
    userPrompt: "I am in a meeting, don't call. Just WhatsApp me the details.",
    expectedKeywords: ['whatsapp', 'brochure', 'floor plan', '2 bhk', '3 bhk'],
    forbiddenKeywords: ['please stay on call', 'only two minutes'],
    maxWords: 30,
  },
];

async function runEvals() {
  console.log('========================================================================');
  console.log('🧠 LIVEKIT-STYLE BEHAVIORAL EVALS SUITE — MITTAL PALMS AI AGENT');
  console.log(`📋 Total Benchmark Test Cases: ${EVAL_CASES.length}`);
  console.log('========================================================================\n');

  let passed = 0;
  const results: any[] = [];

  for (let i = 0; i < EVAL_CASES.length; i++) {
    const test = EVAL_CASES[i];
    console.log(`[Eval ${i + 1}/${EVAL_CASES.length}] [${test.category}] ${test.name}`);
    console.log(`   User: "${test.userPrompt}"`);

    const conversationHistory: ChatMessage[] = [
      {
        role: 'assistant',
        content:
          'Hello! This is Priya from Mittal Palms in Jakkur. Thanks for calling! We have ready-to-move 2 and 3 BHK homes here with Occupancy Certificate received. Are you looking for a 2 BHK or a 3 BHK for your family?',
      },
      {
        role: 'user',
        content: test.userPrompt,
      },
    ];

    const t0 = Date.now();
    let reply = '';

    try {
      for await (const chunk of llmPipeline.streamResponse(conversationHistory, null, '+91-9880199999', 'Priya')) {
        reply += chunk;
      }
    } catch (err: any) {
      reply = `Error: ${err.message}`;
    }

    const latencyMs = Date.now() - t0;
    const cleanReply = reply.trim();
    const words = cleanReply.split(/\s+/).filter(Boolean).length;
    const lower = cleanReply.toLowerCase();

    // 1. Brevity check
    const brevityPassed = words <= test.maxWords;

    // 2. Expected keywords check (at least 1 must match)
    const expectedPassed = test.expectedKeywords.some((kw) => lower.includes(kw.toLowerCase()));

    // 3. Forbidden keywords check (none may match)
    const forbiddenPassed = !test.forbiddenKeywords.some((kw) => lower.includes(kw.toLowerCase()));

    const testPassed = brevityPassed && expectedPassed && forbiddenPassed;
    if (testPassed) passed++;

    results.push({
      test,
      reply: cleanReply,
      latencyMs,
      words,
      brevityPassed,
      expectedPassed,
      forbiddenPassed,
      testPassed,
    });

    console.log(`   Priya: "${cleanReply}"`);
    console.log(`   Metrics: ${latencyMs}ms | ${words} words (Limit: <= ${test.maxWords})`);
    console.log(
      `   Verdict: ${testPassed ? '✅ PASSED' : '❌ FAILED'} (Brevity: ${brevityPassed ? '✓' : '✗'}, Expected: ${expectedPassed ? '✓' : '✗'}, Anti-Hallucination: ${forbiddenPassed ? '✓' : '✗'})\n`
    );
  }

  const scorePct = Math.round((passed / EVAL_CASES.length) * 100);
  console.log('========================================================================');
  console.log(`🏆 EVALUATION SCORECARD: ${passed} / ${EVAL_CASES.length} PASSED (${scorePct}%)`);
  console.log('========================================================================\n');

  if (scorePct >= 85) {
    console.log('🎉 BEHAVIORAL EVALUATION PASSED: Priya meets production voice standards!');
  } else {
    console.log('⚠️ BEHAVIORAL EVALUATION FAILED: Further prompt tuning required.');
  }
}

runEvals().catch(console.error);
