/**
 * Indian Real Estate Voice Text Normalizer
 * Optimizes text cadence and pronunciation for Cartesia TTS over 8kHz telephony.
 */

const NUMBER_WORDS: Record<number, string> = {
  0: 'zero',
  1: 'one',
  2: 'two',
  3: 'three',
  4: 'four',
  5: 'five',
  6: 'six',
  7: 'seven',
  8: 'eight',
  9: 'nine',
  10: 'ten',
  11: 'eleven',
  12: 'twelve',
  13: 'thirteen',
  14: 'fourteen',
  15: 'fifteen',
  16: 'sixteen',
  17: 'seventeen',
  18: 'eighteen',
  19: 'nineteen',
  20: 'twenty',
  30: 'thirty',
  40: 'forty',
  50: 'fifty',
  60: 'sixty',
  70: 'seventy',
  80: 'eighty',
  90: 'ninety',
};

/**
 * Converts integers 0-99 to spoken English words.
 */
function numberToWords(n: number): string {
  if (n < 0 || n > 999) return String(n);
  if (n in NUMBER_WORDS) return NUMBER_WORDS[n];
  if (n < 100) {
    const tens = Math.floor(n / 10) * 10;
    const units = n % 10;
    return `${NUMBER_WORDS[tens]}-${NUMBER_WORDS[units]}`;
  }
  const hundreds = Math.floor(n / 100);
  const remainder = n % 100;
  if (remainder === 0) return `${NUMBER_WORDS[hundreds]} hundred`;
  return `${NUMBER_WORDS[hundreds]} hundred and ${numberToWords(remainder)}`;
}

/**
 * Converts decimal numbers like 1.5 to "one point five" or 2.75 to "two point seven five".
 */
export function formatDecimalOrNumber(numStr: string): string {
  const parts = numStr.split('.');
  const whole = parseInt(parts[0], 10);
  const wholeWords = !isNaN(whole) && whole <= 100 ? numberToWords(whole) : parts[0];

  if (parts.length > 1 && parts[1]) {
    const decimalDigits = parts[1]
      .split('')
      .map((d) => NUMBER_WORDS[parseInt(d, 10)] || d)
      .join(' ');
    return `${wholeWords} point ${decimalDigits}`;
  }

  return wholeWords;
}

/**
 * Normalizes text for Bangalore real estate voice conversations.
 */
export function normalizeRealEstateText(text: string): string {
  if (!text) return '';

  let normalized = text;

  // 1. Remove Markdown characters and formatting
  normalized = normalized
    .replace(/\*\*(.*?)\*\*/g, '$1') // bold
    .replace(/\*(.*?)\*/g, '$1')     // italic
    .replace(/__(.*?)__/g, '$1')     // underline
    .replace(/~~(.*?)~~/g, '$1')     // strikethrough
    .replace(/#+\s+/g, '')           // headings
    .replace(/^\s*[-*•]\s+/gm, '')   // bullet points
    .replace(/`/g, '')               // backticks
    .replace(/\[(.*?)\]\(.*?\)/g, '$1'); // markdown links

  // 2. Normalize Currency Symbols
  normalized = normalized
    .replace(/₹\s*/g, '')
    .replace(/\bRs\.?\s*/gi, '')
    .replace(/\bINR\s*/gi, '');

  // 3. Indian Crores Normalization: (e.g., "1.5 Cr", "2 Crores", "3cr")
  // -> "one point five crore rupees"
  normalized = normalized.replace(
    /\b(\d+(\.\d+)?)\s*(?:cr|crore|crores)\b/gi,
    (_, num) => {
      const spokenNum = formatDecimalOrNumber(num);
      return `${spokenNum} crore rupees`;
    }
  );

  // 4. Indian Lakhs Normalization: (e.g., "85L", "75 Lakhs", "90 lacs")
  // -> "eighty-five lakh rupees"
  normalized = normalized.replace(
    /\b(\d+(\.\d+)?)\s*(?:l|lakh|lakhs|lac|lacs)\b/gi,
    (_, num) => {
      const spokenNum = formatDecimalOrNumber(num);
      return `${spokenNum} lakh rupees`;
    }
  );

  // 5. BHK Normalization: (e.g., "2 bhk", "3BHK", "4 BHKs")
  // -> "2 B H K"
  normalized = normalized.replace(/\b(\d+)\s*bhk(?:s)?\b/gi, '$1 B H K');

  // 6. Square Feet Normalization: (e.g., "1500 sq ft", "1200 sqft")
  // -> "1500 square feet"
  normalized = normalized.replace(/\b(\d+)\s*(?:sq\.?\s*ft\.?|sqft)\b/gi, '$1 square feet');

  // 7. Time Normalization: (e.g., "11 AM", "4 PM") -> "11 A M", "4 P M"
  normalized = normalized
    .replace(/\b(\d+)\s*AM\b/gi, '$1 A M')
    .replace(/\b(\d+)\s*PM\b/gi, '$1 P M');

  // 8. Clean trailing symbols and multiple punctuations for natural voice cadence
  normalized = normalized
    .replace(/[;:]+/g, ',')
    .replace(/\.{2,}/g, '.')
    .replace(/!{2,}/g, '!')
    .replace(/\?{2,}/g, '?')
    .replace(/[-_]{2,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return normalized;
}
