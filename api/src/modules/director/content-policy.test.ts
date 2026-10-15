import { describe, expect, it } from 'vitest';
import { checkContent } from './content-policy.js';

describe('content policy (pure)', () => {
  it('refuses sexual / nude requests in English, Hinglish and Hindi', () => {
    for (const t of ['a girl showing tits', 'NUDE woman on a beach', 'make her naked', 'sexy hot girls dancing', 'kapde utaar ke dance', 'नंगी लड़की', 'lingerie photoshoot', 'topless selfie']) {
      const r = checkContent(t);
      expect(r.ok, t).toBe(false);
      expect(r.reason).toMatch(/sexual|not allowed/);
    }
  });

  it('sexual + minors gets a flat refusal without guidance', () => {
    expect(checkContent('nude teen').reason).toBe('This request is not allowed.');
  });

  it('allows normal briefs, including words that merely contain a blocked word', () => {
    for (const t of [
      '@riya dances on the beach at sunset', 'Middlesex cricket ground', 'a sextant on an old ship', 'Essex countryside walk',
      'English voice-over. A family walks in Goa.', 'baarish mein chai, cozy', 'a strip of land by the sea', 'children play cricket in the park',
    ]) {
      expect(checkContent(t), t).toEqual({ ok: true });
    }
  });
});
