/**
 * Ready-made scene templates: a brief written the way the Director follows best (one "Scene N:" per
 * shot, given VO lines, a Sound line) plus the settings that suit it (format, length, music, motion).
 * `{who}` becomes the user's @character when they pick one, otherwise a generic description, so the
 * same template works with or without a library.
 */
export interface SceneTemplate {
  id: string;
  name: string;
  emoji: string;
  /** One line shown under the name. */
  hint: string;
  /** Used when the user has no character picked. */
  defaultWho: string;
  brief: string;
  format: '9:16' | '16:9' | '1:1';
  targetS: number;
  /** Built-in music id (see the API's stock-music.ts) or 'auto'. */
  music: string;
  /** Suggested motion (only applied when the AI video models are installed). */
  motion: 'still' | 'hero' | 'ai';
}

export const SCENE_TEMPLATES: readonly SceneTemplate[] = [
  {
    id: 'dance-reel',
    name: 'Dance reel',
    emoji: '💃',
    hint: 'Beat-cut dance, neon night, hero shots move',
    defaultWho: 'a young woman in a flowing red dress',
    brief:
      'English voice-over. Energetic dance reel.\n' +
      'Scene 1: {who} dancing on a rooftop at night, city lights behind. VO: Tonight, the city is my stage.\n' +
      'Scene 2: {who} spins under neon lights, hair flying. VO: Every beat, a heartbeat.\n' +
      'Scene 3: {who} jumps with arms up, confetti in the air. VO: Dance like nobody is watching.\n' +
      'Scene 4: {who} smiles at the camera, breathing hard, city glowing. VO: This is my night.\n' +
      'Sound: city at night.',
    format: '9:16',
    targetS: 16,
    music: 'pulse',
    motion: 'hero',
  },
  {
    id: 'travel-vlog',
    name: 'Travel vlog',
    emoji: '🏝️',
    hint: 'Sunny beach day, upbeat pop',
    defaultWho: 'a young traveller with a backpack',
    brief:
      'English voice-over. Happy travel vlog in Goa.\n' +
      'Scene 1: {who} walks onto a golden beach in the morning, palm trees. VO: Day one in Goa.\n' +
      'Scene 2: {who} drinks fresh coconut water at a beach shack. VO: First stop, coconut water.\n' +
      'Scene 3: {who} rides a scooter along a coastal road. VO: Then the coast road, wind in my hair.\n' +
      'Scene 4: {who} watches the sunset over the sea. VO: And a sunset I will never forget.\n' +
      'Sound: ocean waves.',
    format: '9:16',
    targetS: 20,
    music: 'sunny',
    motion: 'still',
  },
  {
    id: 'chai-moment',
    name: 'Chai moment',
    emoji: '☕',
    hint: 'Cozy Hinglish monsoon, lo-fi',
    defaultWho: 'a young man in a grey hoodie',
    brief:
      'Hinglish voice-over. Cozy monsoon evening.\n' +
      'Scene 1: {who} sits at a roadside tea stall in Mumbai rain. VO: Baarish aur chai, bas yahi chahiye.\n' +
      'Scene 2: close-up of steaming tea in a small glass. VO: Garam garam cutting chai.\n' +
      'Scene 3: {who} watches the rain fall on the street, smiling. VO: Kuch pal sirf apne liye.\n' +
      'Sound: rain.',
    format: '9:16',
    targetS: 14,
    music: 'lofi',
    motion: 'still',
  },
  {
    id: 'motivation',
    name: 'Motivation',
    emoji: '🔥',
    hint: 'Dramatic sunrise run, cinematic',
    defaultWho: 'a determined young athlete',
    brief:
      'English voice-over. Motivational, dramatic.\n' +
      'Scene 1: {who} wakes up before dawn, dark room, alarm glowing. VO: While the world sleeps, I begin.\n' +
      'Scene 2: {who} runs up mountain steps in the fog. VO: Every step is a choice.\n' +
      'Scene 3: {who} falls, then gets up again, determined face. VO: I fall. I rise.\n' +
      'Scene 4: {who} reaches the top at sunrise, arms raised. VO: And the top is mine.\n' +
      'Sound: wind.',
    format: '9:16',
    targetS: 20,
    music: 'cinematic',
    motion: 'hero',
  },
  {
    id: 'product',
    name: 'Product showcase',
    emoji: '🛍️',
    hint: 'Clean square ad, upbeat',
    defaultWho: 'a stylish model',
    brief:
      'English voice-over. Clean product ad for handmade leather bags.\n' +
      'Scene 1: a brown leather bag on a marble table in soft morning light. VO: Made by hand.\n' +
      'Scene 2: close-up of stitching and leather texture. VO: Every stitch, with care.\n' +
      'Scene 3: {who} carries the bag through a bright city street. VO: Made to go everywhere with you.\n' +
      'Scene 4: the bag on the table with flowers. VO: Yours, for years.',
    format: '1:1',
    targetS: 16,
    music: 'sunny',
    motion: 'still',
  },
];

/** The template's brief with `{who}` filled: an @handle, or the template's generic person. Pure. */
export function fillTemplate(t: SceneTemplate, handle?: string): string {
  return t.brief.replaceAll('{who}', handle ? `@${handle}` : t.defaultWho);
}
