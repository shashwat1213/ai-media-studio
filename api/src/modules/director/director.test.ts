import { describe, expect, it } from 'vitest';
import { ProviderError } from '../generation/providers/types.js';
import type { PublicItem } from '../library/library.js';
import { addDevanagari, createLocalDirector, createStubDirector, direct, extractJson, normaliseScript, systemPrompt, translitOk, transliterate, userPrompt, type DirectorModel } from './director.js';

const item = (handle: string, kind: PublicItem['kind'], description: string): PublicItem => ({
  id: handle, kind, handle, name: handle, description, settings: {}, imageUploadId: null, createdAt: new Date(0), updatedAt: new Date(0),
});
const lib = [item('riya', 'CHARACTER', '25 year old woman, curly hair, yellow kurta'), item('goa', 'PLACE', 'Goa beach at sunset, palm trees')];
const req = { prompt: '@riya at @goa', language: 'hi' as const, format: '9:16' as const, targetS: 16, library: lib };

describe('director prompts', () => {
  it('system prompt: JSON, English visuals; spoken-Hindi rules + examples for hi/hinglish; on-screen script per mode', () => {
    expect(systemPrompt('hi')).toMatch(/SPOKEN Hinglish, written in ROMAN letters/); // Devanagari comes from transliterate()
    expect(systemPrompt('hi')).toMatch(/NEVER copy them/); // few-shot style examples on unrelated topics
    expect(systemPrompt('hinglish')).toMatch(/"onScreen": at most 5 words in Hinglish \(Roman letters\)/);
    expect(systemPrompt('en')).toMatch(/natural spoken English/);
    expect(systemPrompt('en')).not.toMatch(/Hinglish/);
    expect(systemPrompt('en')).toMatch(/ONE JSON object only/);
  });
  it('user prompt carries the library descriptions and a shot count from the length', () => {
    const u = userPrompt(req);
    expect(u).toContain('@riya (character, "riya"): 25 year old woman, curly hair, yellow kurta');
    expect(u).toContain('about 4 shots');
    expect(u).toContain('vertical 9:16 reel');
  });
});

describe('extractJson', () => {
  it('finds the first balanced object inside prose / code fences, braces in strings are fine', () => {
    expect(extractJson('Sure!\n```json\n{"a": {"b": "x}y"}, "c": 1}\n``` done')).toEqual({ a: { b: 'x}y' }, c: 1 });
  });
  it('no JSON / broken JSON -> retryable ProviderError', () => {
    expect(() => extractJson('nothing here')).toThrow(ProviderError);
    expect(() => extractJson('{"a": ')).toThrow(/broken JSON/);
  });
});

describe('normaliseScript', () => {
  const shot = (o: object = {}) => ({ visual: 'a beach', camera: 'panleft', durationS: 4, narration: '', sound: 'waves', onScreen: '', uses: [], ...o });

  it('keeps good shots, drops bad ones, coerces bad fields, filters unknown @handles', () => {
    const s = normaliseScript(
      {
        title: 'Goa',
        mood: 'Upbeat',
        shots: [shot({ uses: ['@riya', 'ghost', 'GOA'] }), { visual: '' }, 'junk', shot({ camera: 'dolly', narration: 42 })],
      },
      req,
    );
    expect(s.shots).toHaveLength(2);
    expect(s.shots[0]!.uses).toEqual(['riya', 'goa']);
    expect(s.shots[1]).toMatchObject({ camera: 'zoomin', narration: '', roman: '' }); // invalid values -> safe defaults
    expect(s).toMatchObject({ title: 'Goa', mood: 'upbeat', language: 'hi', format: '9:16' });
  });

  it('paces to the target length, clamps 2..8 s, and gives long narration enough time', () => {
    const s = normaliseScript({ shots: [shot({ durationS: 1 }), shot({ durationS: 100 }), shot({ durationS: 'x' })] }, { ...req, targetS: 12 });
    for (const x of s.shots) expect(x.durationS).toBeGreaterThanOrEqual(2);
    for (const x of s.shots) expect(x.durationS).toBeLessThanOrEqual(8);
    const talky = normaliseScript({ shots: [shot({ durationS: 2, narration: Array(15).fill('शब्द').join(' ') })] }, { ...req, targetS: 2 });
    expect(talky.shots[0]!.durationS).toBeGreaterThan(5); // 15 words need ~6 s
  });

  it('at most 12 shots; no usable shots -> retryable error', () => {
    expect(normaliseScript({ shots: Array(20).fill(shot()) }, { ...req, targetS: 90 }).shots).toHaveLength(12);
    expect(() => normaliseScript({ shots: [{ visual: '' }] }, req)).toThrow(/no usable shots/);
    expect(() => normaliseScript({ title: 'x' }, req)).toThrow(ProviderError);
  });
});

describe('direct()', () => {
  it('retries once on a malformed answer, then succeeds', async () => {
    let n = 0;
    const flaky: DirectorModel = { name: 'f', complete: async () => (n++ === 0 ? 'oops' : JSON.stringify({ shots: [{ visual: 'a cat', durationS: 4 }] })) };
    const s = await direct(flaky, req);
    expect(n).toBe(2);
    expect(s.shots[0]!.visual).toBe('a cat');
  });
  it('two bad answers -> error; non-retryable errors are not retried', async () => {
    let n = 0;
    await expect(direct({ name: 'b', complete: async () => (n++, 'nope') }, req)).rejects.toThrow(ProviderError);
    expect(n).toBe(2);
    n = 0;
    await expect(direct({ name: 'x', complete: async () => (n++, Promise.reject(new Error('boom'))) }, req)).rejects.toThrow('boom');
    expect(n).toBe(1);
  });
  it('the stub director is deterministic and uses the mentioned handles', async () => {
    const s = await direct(createStubDirector(), { ...req, language: 'en', prompt: 'Riya walks. She smiles. Sunset.' });
    expect(s.shots).toHaveLength(3);
    expect(s.shots[0]!.uses).toEqual(['riya', 'goa']);
  });
});

describe('local director (llama.cpp HTTP)', () => {
  it('posts an OpenAI-style chat with JSON mode; maps errors', async () => {
    let body: Record<string, unknown> = {};
    const ok = createLocalDirector({
      baseUrl: 'http://llm:8081/',
      fetchImpl: (async (_u: unknown, init?: RequestInit) => {
        body = JSON.parse(String(init!.body));
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"shots":[]}' } }] }));
      }) as typeof fetch,
    });
    expect(await ok.complete('sys', 'usr')).toBe('{"shots":[]}');
    expect(body).toMatchObject({ response_format: { type: 'json_object' }, messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'usr' }] });

    const down = createLocalDirector({ baseUrl: 'http://llm', fetchImpl: (() => Promise.reject(new Error('ECONNREFUSED'))) as typeof fetch });
    await expect(down.complete('s', 'u')).rejects.toMatchObject({ retryable: true, userMessage: expect.stringMatching(/not running/) });
    const bad = createLocalDirector({ baseUrl: 'http://llm', fetchImpl: (async () => new Response('', { status: 400 })) as typeof fetch });
    await expect(bad.complete('s', 'u')).rejects.toMatchObject({ retryable: false });
  });
});

// -------------------------------------------------------------------------------------------
/** A fake model that transliterates via a lookup table (or misbehaves on purpose). */
const table: Record<string, string> = {
  'Subah ghat pe chai': 'सुबह घाट पे चाय',
  'Ganga ke kinare baith gaya': 'गंगा के किनारे बैठ गया',
  'Nayi shuruaat': 'नई शुरुआत',
};
const translitModel = (bad: (l: string) => string | undefined = () => undefined): DirectorModel & { calls: number } => {
  const m = {
    name: 'fake',
    calls: 0,
    async complete(system: string, user: string) {
      m.calls++;
      const { lines } = JSON.parse(user) as { lines: string[] };
      return JSON.stringify({ lines: lines.map((l) => bad(l) ?? table[l] ?? l) });
    },
  };
  return m;
};

describe('Hinglish -> Devanagari', () => {
  it('translitOk: Devanagari, no Latin left, no dropped words', () => {
    expect(translitOk('Nayi shuruaat', 'नई शुरुआत')).toBe(true);
    expect(translitOk('Nayi shuruaat', 'Nayi शुरुआत')).toBe(false); // Latin left
    expect(translitOk('Mummy ne poocha, khana khaya? Maine jhooth bol diya', 'मम्मी ने पूछा, खाना खाया?')).toBe(false); // half dropped
    expect(translitOk('a b', undefined)).toBe(false);
  });

  it('transliterate: one batch call; bad lines retried alone; still-bad lines -> null; blanks skipped', async () => {
    let first = true;
    const m = translitModel((l) => (l === 'Nayi shuruaat' && first ? ((first = false), 'Nayi shuruaat') : undefined));
    expect(await transliterate(m, ['Subah ghat pe chai', '', 'Nayi shuruaat'])).toEqual(['सुबह घाट पे चाय', null, 'नई शुरुआत']);
    expect(m.calls).toBe(2); // batch + one retry
    const never = translitModel(() => 'still roman');
    expect(await transliterate(never, ['Subah ghat pe chai'])).toEqual([null]);
  });

  it('addDevanagari: narration = Devanagari (voice), roman = Hinglish (captions); hi also converts on-screen text', async () => {
    const base = { title: 't', mood: 'calm', format: '9:16' as const };
    const shots = [
      { visual: 'v', camera: 'zoomin' as const, durationS: 4, narration: 'Subah ghat pe chai', roman: '', sound: '', onScreen: 'Nayi shuruaat', uses: [] },
      { visual: 'v', camera: 'zoomin' as const, durationS: 4, narration: 'unconvertible', roman: '', sound: '', onScreen: '', uses: [] },
    ];
    const hinglish = await addDevanagari(translitModel((l) => (l === 'unconvertible' ? 'nope' : undefined)), { ...base, language: 'hinglish', shots });
    expect(hinglish.shots[0]).toMatchObject({ narration: 'सुबह घाट पे चाय', roman: 'Subah ghat pe chai', onScreen: 'Nayi shuruaat' });
    expect(hinglish.shots[1]).toMatchObject({ narration: '', roman: 'unconvertible' }); // no bad voice; caption kept
    const hi = await addDevanagari(translitModel(), { ...base, language: 'hi', shots: [shots[0]!] });
    expect(hi.shots[0]!.onScreen).toBe('नई शुरुआत');
    const en = { ...base, language: 'en' as const, shots };
    expect(await addDevanagari(translitModel(), en)).toBe(en);
    await expect(addDevanagari(translitModel(() => 'x'), { ...base, language: 'hi', shots: [shots[0]!] })).rejects.toMatchObject({ retryable: true, userMessage: expect.stringMatching(/Hindi voice-over/) });
  });

  it('direct(): Hinglish script in, voice-ready script out (narration Devanagari, roman kept)', async () => {
    const m: DirectorModel = {
      name: 'm',
      async complete(system, user) {
        if (system.startsWith('Convert each Hinglish')) return translitModel().complete(system, user);
        return JSON.stringify({ title: 'Ghat', shots: [{ visual: 'ghat', narration: 'Subah ghat pe chai', durationS: 4 }] });
      },
    };
    const s = await direct(m, { ...req, language: 'hinglish' });
    expect(s.shots[0]).toMatchObject({ narration: 'सुबह घाट पे चाय', roman: 'Subah ghat pe chai' });
  });
});
