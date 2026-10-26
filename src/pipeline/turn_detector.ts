/**
 * Semantic End-of-Turn (EoT) & Voice Activity Detector
 * Inspired by LiveKit's TurnDetector and audio-linguistic completion models.
 *
 * Solves the classic voice agent dilemma:
 * - When a user pauses to think ("I am looking for... uh..."), DON'T cut them off.
 * - When a user finishes a crisp sentence ("What is the price?"), respond with low latency (<250ms).
 */

export interface TurnDecision {
  isLikelyComplete: boolean;
  recommendedSilenceMs: number;
  hesitationDetected: boolean;
  reason: string;
}

// Linguistic indicators that a speaker is still thinking / hesitating mid-sentence
const HESITATION_SUFFIXES = [
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
];

// Natural conversational completions indicating the speaker yielded their turn
const COMPLETION_PUNCTUATION = /[.?!]$/;

export class SemanticTurnDetector {
  private baseSilenceMs: number = 420;
  private hesitationSilenceMs: number = 950;
  private fastTurnSilenceMs: number = 260;

  /**
   * Evaluates audio duration and partial speech text to determine if the speaker has
   * concluded their turn or is simply hesitating.
   */
  public evaluateTurn(partialTranscript: string, audioDurationSec: number): TurnDecision {
    const text = (partialTranscript || '').trim().toLowerCase();

    // 1. If audio is extremely brief (<0.4s) or transcript is 1 letter, treat as incomplete/noise
    if (audioDurationSec < 0.4 || text.length <= 1) {
      return {
        isLikelyComplete: false,
        recommendedSilenceMs: this.hesitationSilenceMs,
        hesitationDetected: true,
        reason: 'Audio too brief or sub-word transcript',
      };
    }

    // 2. Tokenize into words
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      return {
        isLikelyComplete: false,
        recommendedSilenceMs: this.baseSilenceMs,
        hesitationDetected: false,
        reason: 'Empty text buffer',
      };
    }

    const lastWord = words[words.length - 1].replace(/[^a-z]/g, '');

    // 3. Check for hesitation or trailing conjunctions/prepositions
    const hasHesitation = HESITATION_SUFFIXES.includes(lastWord);
    if (hasHesitation) {
      return {
        isLikelyComplete: false,
        recommendedSilenceMs: this.hesitationSilenceMs,
        hesitationDetected: true,
        reason: `Hesitation / trailing marker detected ("${lastWord}") — extending silence window to ${this.hesitationSilenceMs}ms`,
      };
    }

    // 4. Check for explicit question words indicating a finished query
    const isQuestion =
      text.endsWith('?') ||
      /^(what|how|where|when|which|who|can|could|will|would|is|are|do|does)\b/i.test(text);

    if (isQuestion && words.length >= 3) {
      return {
        isLikelyComplete: true,
        recommendedSilenceMs: this.fastTurnSilenceMs,
        hesitationDetected: false,
        reason: 'Syntactically complete question detected — triggering fast turnaround',
      };
    }

    // 5. Short decisive utterances ("Yes", "No", "Sure", "Tomorrow 5 PM", "2 BHK", "Resale")
    if (words.length <= 4 && (text.includes('bhk') || text.includes('yes') || text.includes('no') || text.includes('sure') || text.includes('weekend') || text.includes('saturday'))) {
      return {
        isLikelyComplete: true,
        recommendedSilenceMs: this.fastTurnSilenceMs + 40,
        hesitationDetected: false,
        reason: 'Concise decisive answer detected',
      };
    }

    // 6. Sentence with terminal punctuation
    if (COMPLETION_PUNCTUATION.test(partialTranscript.trim())) {
      return {
        isLikelyComplete: true,
        recommendedSilenceMs: this.fastTurnSilenceMs,
        hesitationDetected: false,
        reason: 'Terminal punctuation detected',
      };
    }

    // Default: balanced conversational silence window
    return {
      isLikelyComplete: true,
      recommendedSilenceMs: this.baseSilenceMs,
      hesitationDetected: false,
      reason: 'Standard conversational clause',
    };
  }
}

export const semanticTurnDetector = new SemanticTurnDetector();
