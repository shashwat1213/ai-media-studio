import type { SceneLanguage } from './api';

/**
 * Mirror of the API's detectLanguage() (api/src/modules/director/director.ts), used only to show
 * "Auto: English" while typing. The API makes the real decision when the scene is created.
 */
const HINGLISH_WORDS = new Set(
  ('hai hain ka ki ke mein me pe par aur nahi nahin kya ko se tha thi the raha rahi rahe hoon hun hu ho gaya gayi gaye wala wali ' +
    'bhi yaar apna apni mera meri mere uska uski unka jab tab kuch sab bahut accha acha phir fir kar karta karti kiya liye ' +
    'woh wo yeh ye abhi kabhi sirf bas toh to hum tum aap')
    .split(' '),
);
const LANG_WORDS: Record<SceneLanguage, RegExp> = {
  hinglish: /\bhinglish\b/i,
  en: /\b(english|angrezi|angreji)\b|अंग्रेज़ी|अंग्रेजी|इंग्लिश/i,
  hi: /\bhindi\b|हिंदी|हिन्दी/i,
};
const VOICE_WORDS = '(voice[- ]?over|voice|vo|narration|narrator|narrate|audio|dialogues?|speech|bolo|bole|awaaz|awaz|language|bhasha)';
const ORDER = ['hinglish', 'en', 'hi'] as const;

export function detectLanguage(prompt: string): { language: SceneLanguage; reason: 'asked' | 'written' } {
  const t = prompt.toLowerCase();
  const near = (lang: SceneLanguage) => {
    const w = LANG_WORDS[lang].source;
    return new RegExp(`(${w})\\W{0,3}(\\w+\\W{0,3}){0,2}${VOICE_WORDS}|${VOICE_WORDS}\\W{0,3}(\\w+\\W{0,3}){0,2}(${w})`, 'i').test(t);
  };
  const asked = ORDER.filter((l) => near(l));
  if (asked.length === 1) return { language: asked[0]!, reason: 'asked' };
  const alone = ORDER.filter((l) => new RegExp(`\\b(in|into|language\\W*)\\s*(${LANG_WORDS[l].source})|(${LANG_WORDS[l].source})\\s*(mein|me)\\b`, 'i').test(t));
  if (asked.length === 0 && alone.length === 1) return { language: alone[0]!, reason: 'asked' };
  const deva = (prompt.match(/[\u0900-\u097F]/g) ?? []).length;
  const latin = (prompt.match(/[A-Za-z]/g) ?? []).length;
  if (deva > 0 && deva >= latin * 0.5) return { language: 'hi', reason: 'written' };
  const words = t.replace(/@[a-z0-9_]+/g, ' ').match(/[a-z]+/g) ?? [];
  const hindi = words.filter((w) => HINGLISH_WORDS.has(w)).length;
  if (hindi >= 2 && hindi / Math.max(1, words.length) >= 0.12) return { language: 'hinglish', reason: 'written' };
  return { language: 'en', reason: 'written' };
}
