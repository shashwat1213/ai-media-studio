/**
 * Content policy for AI-generated media. This studio makes people-centred videos (often with a real
 * person's consented face), so sexual / nude content and sexualised minors are refused BEFORE any
 * credits are charged or GPU time is spent. The image/video models are also negative-prompted
 * against nudity (gateway), so this is the first of two layers, not the only one.
 *
 * Deliberately simple and explainable: whole-word matches on explicit terms in English, Hinglish
 * (Roman) and Hindi (Devanagari). It is not a classifier; it stops the obvious requests.
 */
const SEXUAL = [
  // English
  'nude', 'nudes', 'naked', 'topless', 'bottomless', 'nsfw', 'porn', 'porno', 'pornographic', 'xxx', 'sex', 'sexy', 'sexual',
  'tits', 'titties', 'boobs', 'boobies', 'breasts', 'nipples', 'nipple', 'cleavage', 'pussy', 'vagina', 'penis', 'dick', 'cock',
  'genitals', 'butt naked', 'stripping', 'striptease', 'lingerie', 'undress', 'undressed', 'undressing', 'erotic',
  'orgasm', 'horny', 'onlyfans', 'fetish', 'seductive', 'seducing', 'hot girl', 'hot girls', 'hottie',
  // Hinglish (Roman)
  'nangi', 'nanga', 'chudai', 'chut', 'lund', 'boobs dikha', 'kapde utaar', 'kapde utar', 'sexy ladki',
  // Hindi
  'नंगी', 'नंगा', 'नग्न', 'सेक्स', 'सेक्सी', 'चुदाई',
];
const MINORS = ['child', 'children', 'kid', 'kids', 'minor', 'underage', 'teen', 'teenage', 'schoolgirl', 'schoolboy', 'loli', 'baby', 'bachchi', 'bachcha', 'बच्ची', 'बच्चा'];

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const words = (list: string[]) => new RegExp(`(^|[^\\p{L}\\p{N}])(${list.map(esc).join('|')})(?=$|[^\\p{L}\\p{N}])`, 'iu');
const SEXUAL_RE = words(SEXUAL);
const MINORS_RE = words(MINORS);

export interface PolicyResult {
  ok: boolean;
  reason?: string;
}

/** Pure. Returns ok=false with a user-facing reason for sexual content (and anything sexual + minors). */
export function checkContent(text: string): PolicyResult {
  const t = text.normalize('NFKC');
  if (SEXUAL_RE.test(t)) {
    return {
      ok: false,
      reason: MINORS_RE.test(t)
        ? 'This request is not allowed.'
        : 'This studio does not make sexual or nude content. Describe the scene without it (people dancing, walking, talking, travelling all work).',
    };
  }
  return { ok: true };
}
