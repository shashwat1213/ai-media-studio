/**
 * Content policy for AI-generated media. This studio makes people-centred videos (often with a real
 * person's consented face), so sexual / nude content and sexualised minors are refused BEFORE any
 * credits are charged or GPU time is spent. The image/video models are also negative-prompted
 * against nudity (gateway), so this is the first of two layers, not the only one.
 *
 * Violence: GRAPHIC violence (blood, gore, killing, torture, mutilation) and self-harm are refused;
 * mild, non-graphic action that films and soaps show all the time (a slap, a push, an argument, a
 * chase, a stylised fight) is allowed. Any violence towards a child is refused, mild or not.
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
const MINORS = ['child', 'children', 'kid', 'kids', 'minor', 'underage', 'teen', 'teenage', 'schoolgirl', 'schoolboy', 'loli', 'baby', 'bachchi', 'bachcha', 'bachche', 'bacche', 'baccha', 'बच्ची', 'बच्चा', 'बच्चे'];

// Phrases, not bare words, where a word has an everyday meaning ("killing it on the dance floor",
// "blood orange", "flawless execution", "eyelash").
const GRAPHIC_VIOLENCE = [
  // English
  'covered in blood', 'pool of blood', 'blood everywhere', 'blood splatter', 'blood spatter', 'bleeding', 'bloodbath', 'bloodshed',
  'gore', 'gory', 'gruesome', 'kill him', 'kill her', 'kill them', 'kills him', 'kills her', 'killing him', 'killing her', 'killing people',
  'killed', 'murder', 'murders', 'murdered', 'murdering', 'stab', 'stabs', 'stabbed', 'stabbing', 'behead', 'beheaded', 'beheading',
  'decapitate', 'decapitated', 'dismember', 'dismembered', 'mutilate', 'mutilated', 'mutilation', 'torture', 'tortured', 'torturing',
  'massacre', 'slaughter', 'slaughtered', 'corpse', 'corpses', 'dead body', 'dead bodies', 'shot dead', 'shoots him', 'shoots her',
  'shooting him', 'shooting her', 'lynch', 'lynched', 'lynching', 'acid attack', 'burned alive', 'burnt alive', 'slit throat',
  'slits her throat', 'slits his throat', 'cut her throat', 'cut his throat', 'rape', 'raped', 'raping',
  // Hinglish (Roman)
  'khoon', 'khoon kharaba', 'qatl', 'katl', 'hatya', 'maar dala', 'maar daala', 'jaan se maar', 'gala kaat', 'gala kat', 'laash',
  'balatkar',
  // Hindi
  'खून', 'ख़ून', 'हत्या', 'क़त्ल', 'कत्ल', 'लाश', 'मार डाला', 'गला काट', 'बलात्कार',
];
const SELF_HARM = [
  'suicide', 'suicidal', 'kill herself', 'kill himself', 'kill myself', 'kills herself', 'kills himself', 'self harm', 'self-harm',
  'cutting her wrists', 'cutting his wrists', 'slit her wrists', 'slit his wrists', 'hangs herself', 'hangs himself', 'hanging herself',
  'hanging himself', 'khudkushi', 'aatmahatya', 'atmahatya', 'आत्महत्या', 'ख़ुदकुशी', 'खुदकुशी',
];
/** Mild action: allowed for adults, refused when a child is the target. */
// No "hit"/"beat"/"push"/"fight": kids hit a ball, dance to the beat, push a swing, have a pillow fight.
const MILD_VIOLENCE = [
  'slap', 'slaps', 'slapped', 'slapping', 'beaten', 'beat up', 'beats up', 'beating up', 'punch', 'punches', 'punched', 'punching',
  'kick him', 'kick her', 'kicks him', 'kicks her', 'kicked him', 'kicked her', 'hits him', 'hits her', 'hit him', 'hit her',
  'abuse', 'abused', 'abusing', 'thappad', 'chanta', 'chaanta', 'maar', 'maara', 'maarta', 'pitai', 'peeta', 'peetna',
  'थप्पड़', 'मारा', 'मारता', 'पिटाई', 'पीटा',
];

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const words = (list: string[]) => new RegExp(`(^|[^\\p{L}\\p{N}])(${list.map(esc).join('|')})(?=$|[^\\p{L}\\p{N}])`, 'iu');
const SEXUAL_RE = words(SEXUAL);
const MINORS_RE = words(MINORS);
const GRAPHIC_RE = words(GRAPHIC_VIOLENCE);
const SELF_HARM_RE = words(SELF_HARM);
const MILD_RE = words(MILD_VIOLENCE);

export interface PolicyResult {
  ok: boolean;
  reason?: string;
}

/**
 * Pure. Returns ok=false with a user-facing reason for sexual content (and anything sexual + minors),
 * graphic violence, self-harm, and any violence towards a child.
 */
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
  const minors = MINORS_RE.test(t);
  if (SELF_HARM_RE.test(t)) {
    return {
      ok: false,
      reason: 'This studio does not make videos about suicide or self-harm. If you are going through a hard time, please talk to someone you trust or call a helpline (India: Tele-MANAS 14416).',
    };
  }
  if (GRAPHIC_RE.test(t) || (minors && MILD_RE.test(t))) {
    return {
      ok: false,
      reason: minors
        ? 'This request is not allowed.'
        : 'This studio does not make graphic violence (blood, killing, torture). Mild, non-graphic action like an argument, a slap or a chase is fine.',
    };
  }
  return { ok: true };
}
