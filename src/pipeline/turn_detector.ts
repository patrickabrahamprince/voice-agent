/**
 * Semantic End-of-Turn (EoT) & Voice Activity Detector
 * Inspired by LiveKit's TurnDetector and audio-linguistic completion models.
 *
 * Prevents premature cutoffs:
 * - When a user pauses to think ("I am looking for... uh..."), wait for them to finish.
 * - When a user says a filler sound ("Hmm", "Um", "Uh"), DO NOT interrupt them.
 * - When a user says an isolated word ("Need", "College"), wait for them to finish their sentence.
 * - When a user finishes a crisp sentence ("What is the price?"), respond with natural latency.
 */

export interface TurnDecision {
  isLikelyComplete: boolean;
  shouldIgnore: boolean; // True if filler or dangling fragment that should not be responded to
  recommendedSilenceMs: number;
  hesitationDetected: boolean;
  reason: string;
}

// Standalone filler/hesitation tokens that should NEVER trigger an agent response
export const PURE_FILLERS = new Set([
  'hmm',
  'hm',
  'mhm',
  'uh',
  'um',
  'umm',
  'uhh',
  'ah',
  'er',
  'erm',
  'like',
  'so',
  'oh',
  'wait',
  'actually',
  'basically',
]);

// Single-word answers that are legitimately complete on their own
export const STANDALONE_VALID_ANSWERS = new Set([
  'yes',
  'no',
  'yep',
  'nope',
  'sure',
  '2bhk',
  '3bhk',
  'two',
  'three',
  'resale',
  'saturday',
  'sunday',
  'weekend',
  'bye',
  'goodbye',
  'confirmed',
  'correct',
  'exactly',
]);

// Linguistic indicators that a speaker is still thinking / hesitating mid-sentence
export const HESITATION_SUFFIXES = [
  'uh',
  'uhh',
  'um',
  'umm',
  'er',
  'erm',
  'like',
  'and',
  'so',
  'but',
  'or',
  'because',
  'actually',
  'basically',
  'i mean',
  'you know',
  'mean',
  'that',
  'which',
  'where',
  'when',
  'if',
  'though',
  'although',
  'to',
  'for',
  'in',
  'at',
  'on',
  'with',
  'about',
  'the',
  'a',
  'an',
  'need',
  'want',
  'looking',
];

// Natural conversational completions indicating the speaker yielded their turn
const COMPLETION_PUNCTUATION = /[.?!]$/;

export class SemanticTurnDetector {
  private baseSilenceMs: number = 850;
  private hesitationSilenceMs: number = 1400;
  private fastTurnSilenceMs: number = 650;

  /**
   * Checks if an utterance is purely a backchannel / hesitation sound.
   */
  public isFillerOnly(text: string): boolean {
    const cleaned = text.trim().toLowerCase().replace(/[^a-z]/g, '');
    return PURE_FILLERS.has(cleaned);
  }

  /**
   * Evaluates audio duration and partial speech text to determine if the speaker has
   * concluded their turn, is hesitating, or was cut off mid-thought.
   */
  public evaluateTurn(partialTranscript: string, audioDurationSec: number): TurnDecision {
    const raw = (partialTranscript || '').trim().toLowerCase();
    const cleanAlpha = raw.replace(/[^a-z0-9\s]/g, ' ').trim();
    const words = cleanAlpha.split(/\s+/).filter(Boolean);

    // 1. Audio too brief or empty
    if (audioDurationSec < 0.35 || words.length === 0) {
      return {
        isLikelyComplete: false,
        shouldIgnore: true,
        recommendedSilenceMs: this.hesitationSilenceMs,
        hesitationDetected: true,
        reason: 'Audio too brief or sub-word transcript',
      };
    }

    // 2. Pure filler sound ("Hmm", "Um", "Uh", "Like") -> IGNORE completely!
    if (words.length === 1 && PURE_FILLERS.has(words[0])) {
      return {
        isLikelyComplete: false,
        shouldIgnore: true,
        recommendedSilenceMs: this.hesitationSilenceMs,
        hesitationDetected: true,
        reason: `Pure hesitation filler ("${words[0]}") — waiting for caller's real thought`,
      };
    }

    // 3. Single isolated dangling word ("Need", "College", "Flat", "Looking") -> INCOMPLETE
    if (words.length === 1) {
      const singleWord = words[0];
      if (STANDALONE_VALID_ANSWERS.has(singleWord) || singleWord.includes('bhk')) {
        return {
          isLikelyComplete: true,
          shouldIgnore: false,
          recommendedSilenceMs: this.fastTurnSilenceMs,
          hesitationDetected: false,
          reason: `Decisive 1-word answer ("${singleWord}")`,
        };
      }
      return {
        isLikelyComplete: false,
        shouldIgnore: false, // Don't discard, but stage and wait for caller to finish
        recommendedSilenceMs: this.hesitationSilenceMs,
        hesitationDetected: true,
        reason: `Dangling 1-word fragment ("${singleWord}") — waiting for complete sentence`,
      };
    }

    const lastWord = words[words.length - 1];

    // 4. Trailing hesitation or conjunction ("I want to... and...")
    if (HESITATION_SUFFIXES.includes(lastWord)) {
      return {
        isLikelyComplete: false,
        shouldIgnore: false,
        recommendedSilenceMs: this.hesitationSilenceMs,
        hesitationDetected: true,
        reason: `Trailing hesitation marker ("${lastWord}") — extending silence window to ${this.hesitationSilenceMs}ms`,
      };
    }

    // 5. Complete syntactic question ("What is the price?", "Is OC received?")
    const isQuestion =
      raw.endsWith('?') ||
      /^(what|how|where|when|which|who|can|could|will|would|is|are|do|does)\b/i.test(raw);

    if (isQuestion && words.length >= 3) {
      return {
        isLikelyComplete: true,
        shouldIgnore: false,
        recommendedSilenceMs: this.fastTurnSilenceMs,
        hesitationDetected: false,
        reason: 'Complete question query detected',
      };
    }

    // 6. Complete multi-word clause (>= 3 words)
    if (words.length >= 3) {
      return {
        isLikelyComplete: true,
        shouldIgnore: false,
        recommendedSilenceMs: this.baseSilenceMs,
        hesitationDetected: false,
        reason: 'Substantive multi-word utterance',
      };
    }

    // Default: 2 words (e.g. "2 BHK", "lake view")
    return {
      isLikelyComplete: true,
      shouldIgnore: false,
      recommendedSilenceMs: this.baseSilenceMs,
      hesitationDetected: false,
      reason: 'Standard conversational phrase',
    };
  }
}

export const semanticTurnDetector = new SemanticTurnDetector();
