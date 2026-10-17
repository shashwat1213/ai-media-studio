import { describe, expect, it } from 'vitest';
import { CAPTION_Y, CAPTION_Y_LOW, TITLE_Y, faceInFrame, parseFaces, placeCaptions, placeTitle, titleBand } from './placement.js';

const PIC = { w: 512, h: 768 };
// Real YuNet boxes from scene shots (16-17 Oct): a typical close-up, and a face low in the frame.
const CLOSE_UP = [{ x: 0.4782, y: 0.0941, w: 0.2447, h: 0.2208 }];
const LOW_FACE = [{ x: 0.4204, y: 0.3372, w: 0.1544, h: 0.1355 }];

describe('title placement (pure)', () => {
  it('no faces (or no detector) keeps the old top spot', () => {
    expect(placeTitle(undefined, 'Hello', '9:16', PIC)).toBe(TITLE_Y);
    expect(placeTitle([], 'Hello', '9:16', PIC)).toBe(TITLE_Y);
  });

  it('a face in the top third pushes the title below the face, above the captions', () => {
    const y = placeTitle(CLOSE_UP, 'Rain dance on the rooftop', '9:16', PIC);
    const face = faceInFrame(CLOSE_UP[0]!, '9:16', PIC);
    const band = titleBand('Rain dance on the rooftop', '9:16');
    expect(y - band.up).toBeGreaterThanOrEqual(face.y + face.h);
    expect(y + band.down).toBeLessThan(CAPTION_Y);
  });

  it('a face low in the frame leaves the title at the top', () => {
    expect(placeTitle(LOW_FACE, 'Mumbai monsoon', '9:16', PIC)).toBe(TITLE_Y);
  });

  it('a face filling the frame falls back to the least-covering spot, still on screen', () => {
    const y = placeTitle([{ x: 0.05, y: 0.02, w: 0.9, h: 0.9 }], 'Big face', '9:16', PIC);
    expect(y).toBeGreaterThan(0.05);
    expect(y).toBeLessThanOrEqual(0.6);
  });

  it('a face off to the side does not move a short title', () => {
    expect(placeTitle([{ x: 0.0, y: 0.08, w: 0.12, h: 0.1 }], 'Hi', '9:16', PIC)).toBe(TITLE_Y);
  });

  it('maps a cover-cropped 16:9 picture into the frame', () => {
    // 768x448 picture into 1920x1080: cropped a little top and bottom.
    const f = faceInFrame({ x: 0.4, y: 0.2, w: 0.2, h: 0.3 }, '16:9', { w: 768, h: 448 });
    expect(f.y).toBeLessThan(0.2);
    expect(f.y + f.h).toBeGreaterThan(0.5);
    expect(placeTitle([{ x: 0.4, y: 0.05, w: 0.2, h: 0.3 }], 'Goa trip', '16:9', { w: 768, h: 448 })).toBeGreaterThan(TITLE_Y);
  });

  it('longer titles wrap to more lines (taller band)', () => {
    expect(titleBand('A very long on screen title that wraps onto lines', '9:16').up).toBeGreaterThan(titleBand('Short', '9:16').up);
  });
});

describe('caption placement (pure)', () => {
  it('stays at 0.74 unless faces sit on that line in most shots', () => {
    expect(placeCaptions([CLOSE_UP, LOW_FACE, undefined], '9:16', PIC)).toBe(CAPTION_Y);
    const onLine = [{ x: 0.35, y: 0.68, w: 0.3, h: 0.08 }];
    expect(placeCaptions([onLine, onLine, CLOSE_UP], '9:16', PIC)).toBe(CAPTION_Y_LOW);
  });
});

describe('parseFaces', () => {
  it('keeps valid 0..1 boxes only, at most 5, clipped to the picture', () => {
    expect(parseFaces('nope')).toEqual([]);
    expect(parseFaces([{ x: 0.9, y: 0.9, w: 0.5, h: 0.5, score: 0.9 }, { x: -1, y: 0, w: 1, h: 1 }, { x: 0.1, y: 0.1, w: 0, h: 0.2 }, null, { x: '1' }]))
      .toEqual([{ x: 0.9, y: 0.9, w: expect.closeTo(0.1), h: expect.closeTo(0.1), score: 0.9 }]);
    expect(parseFaces(Array.from({ length: 9 }, () => ({ x: 0.1, y: 0.1, w: 0.1, h: 0.1 })))).toHaveLength(5);
  });
});
