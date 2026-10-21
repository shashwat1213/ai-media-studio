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

describe('content policy: violence (pure)', () => {
  it('refuses graphic violence in English, Hinglish and Hindi', () => {
    for (const t of ['a man stabbed in the street, covered in blood', 'he murdered his wife', 'torture scene in a basement', 'beheading video',
      'usne uska khoon kar diya', 'gala kaat diya', 'laash pe rote hue', 'हत्या का दृश्य', 'acid attack on a girl', 'shoots him in the head']) {
      const r = checkContent(t);
      expect(r.ok, t).toBe(false);
      expect(r.reason, t).toMatch(/graphic violence/);
    }
  });

  it('refuses self-harm with a helpline pointer', () => {
    for (const t of ['a girl commits suicide on a bridge', 'he tries to kill himself', 'aatmahatya ka scene']) {
      const r = checkContent(t);
      expect(r.ok, t).toBe(false);
      expect(r.reason, t).toMatch(/helpline/);
    }
  });

  it('allows mild, non-graphic action between adults', () => {
    for (const t of ['a girl slapped by a man in a soap-opera scene', 'woman slaps the villain', 'two friends argue then hug', 'police chase at night',
      'usne thappad maara, dramatic', 'boxers punch in the ring', 'stylised kung fu fight on a rooftop']) {
      expect(checkContent(t).ok, t).toBe(true);
    }
  });

  it('refuses any violence towards a child, without guidance', () => {
    for (const t of ['a man slaps a child', 'kid beaten by his father', 'bachche ki pitai']) {
      expect(checkContent(t), t).toEqual({ ok: false, reason: 'This request is not allowed.' });
    }
  });

  it('does not trip on everyday words', () => {
    for (const t of ['she is killing it on the dance floor', 'blood orange smoothie at a cafe', 'flawless execution of the dance', 'long eyelashes close-up',
      'kids hit a ball and dance to the beat', 'children push a swing, pillow fight', 'a hit song plays', 'dressed to kill at a wedding', 'Marta walks in Goa']) {
      expect(checkContent(t).ok, t).toBe(true);
    }
  });
});
