import type { Word } from '../audio/speech.js';

/**
 * Text on video, rendered by libass (ffmpeg's `ass` filter) instead of drawtext:
 *  - real text shaping (HarfBuzz): Hindi/Devanagari conjuncts render correctly, drawtext's don't
 *  - automatic line wrapping inside the margins
 *  - per-character font fallback (Latin from Geist, Devanagari from Noto) in one caption
 *  - fade / move / karaoke (\k) animation built in
 *
 * Everything here is a PURE function from data to an .ass file's text, so it is unit-tested
 * without ffmpeg. User text is escaped: '{' '}' (override blocks) and '\' (escapes like \N) are
 * neutralised, so a caption can never inject styling or break out of its line.
 */

export interface AssCaption {
  text: string;
  startS: number;
  endS: number;
  x: number;
  y: number;
  /** Font size in output pixels. */
  size: number;
  /** #RRGGBB */
  color: string;
  style: 'box' | 'outline' | 'plain';
  anim: 'none' | 'fade' | 'slide';
}

export interface AssKaraoke {
  /** Lines (groups of words) to show one after another. */
  lines: { startS: number; endS: number; words: Word[] }[];
  y: number;
  size: number;
  color: string;
  /** The colour a word turns while/after it's spoken. */
  highlight: string;
  style: 'box' | 'outline';
}

/** A title/end card's text (the card's background is drawn by ffmpeg; the words by libass). */
export interface AssCard {
  startS: number;
  endS: number;
  title: string;
  subtitle: string;
  color: string;
  titleSize: number;
  subtitleSize: number;
}

export const ASS_FONT = 'Geist SemiBold';
const ANIM_MS = 350;

/** #RRGGBB + alpha (0 = opaque, 255 = transparent) -> ASS &HAABBGGRR. */
export function assColor(hex: string, alpha = 0): string {
  const r = hex.slice(1, 3);
  const g = hex.slice(3, 5);
  const b = hex.slice(5, 7);
  return `&H${alpha.toString(16).padStart(2, '0')}${b}${g}${r}`.toUpperCase();
}

/** H:MM:SS.cc (centiseconds). */
export function assTime(s: number): string {
  const cs = Math.max(0, Math.round(s * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const sec = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

/** User text -> safe ASS dialogue text. Newlines become \N (the only escape we emit ourselves). */
export function assEscape(text: string): string {
  return text
    .replace(/\\/g, '\\\u2060') // a backslash followed by WORD JOINER can't start an escape
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r?\n/g, '\\N');
}

function style(name: string, size: number, primary: string, s: 'box' | 'outline' | 'plain', marginH: number): string {
  // BorderStyle 3 = opaque box behind the text (Outline = box padding); 1 = outline + shadow.
  const box = s === 'box';
  const outline = box ? Math.round(size * 0.35) : s === 'outline' ? Math.max(2, Math.round(size * 0.08)) : 0;
  const shadow = s === 'plain' ? 2 : 0;
  const back = box ? assColor('#000000', 0x4d) : assColor('#000000', 0x66);
  return [
    `Style: ${name}`, ASS_FONT, size, primary, primary, box ? back : assColor('#000000'), back,
    0, 0, 0, 0, 100, 100, 0, 0, box ? 3 : 1, outline, shadow, 5, marginH, marginH, 0, 1,
  ].join(',');
}

export function buildAss(w: number, h: number, captions: AssCaption[], karaoke: AssKaraoke | null, cards: AssCard[] = []): string {
  const margin = Math.round(Math.min(w, h) * 0.06);
  const styles: string[] = [];
  const events: string[] = [];

  cards.forEach((c, i) => {
    const name = `T${i}`;
    // Outline style with zero outline/shadow: cards sit on clean colour.
    styles.push(style(name, c.titleSize, assColor(c.color), 'outline', margin).replace(/,1,\d+,0,5,/, ',1,0,0,5,'));
    const x = Math.round(w / 2);
    const y = Math.round(h / 2);
    // Title and subtitle in ONE event: sizes switch inline, libass stacks and centres the lines.
    const sub = c.subtitle ? `\\N{\\fs${c.subtitleSize}\\alpha&H26&}${assEscape(c.subtitle)}` : '';
    events.push(
      `Dialogue: 0,${assTime(c.startS)},${assTime(c.endS)},${name},,0,0,0,,{\\an5\\move(${x},${y + Math.round(h * 0.03)},${x},${y},100,600)\\fad(500,0)}${assEscape(c.title)}${sub}`,
    );
  });

  captions.forEach((c, i) => {
    const name = `C${i}`;
    styles.push(style(name, c.size, assColor(c.color), c.style, margin));
    const x = Math.round(c.x * w);
    const y = Math.round(c.y * h);
    const tags = ['\\an5'];
    if (c.anim === 'slide') tags.push(`\\move(${x},${y + Math.round(h * 0.04)},${x},${y},0,${ANIM_MS})`);
    else tags.push(`\\pos(${x},${y})`);
    if (c.anim !== 'none') tags.push(`\\fad(${ANIM_MS},${ANIM_MS})`);
    events.push(`Dialogue: 0,${assTime(c.startS)},${assTime(c.endS)},${name},,0,0,0,,{${tags.join('')}}${assEscape(c.text)}`);
  });

  if (karaoke && karaoke.lines.length) {
    // \k colours words from Secondary to Primary as they're spoken: Secondary = not yet, Primary = said.
    const name = 'K';
    const base = style(name, karaoke.size, assColor(karaoke.highlight), karaoke.style, margin).split(',');
    base[4] = assColor(karaoke.color); // SecondaryColour
    styles.push(base.join(','));
    const x = Math.round(w / 2);
    const y = Math.round(karaoke.y * h);
    for (const line of karaoke.lines) {
      let t = line.startS;
      const parts = line.words.map((wd, i) => {
        // Each word's \k covers any gap before it plus its own length, so the sweep stays in sync.
        const end = i === line.words.length - 1 ? Math.max(wd.e, line.endS) : line.words[i + 1]!.s;
        const cs = Math.max(1, Math.round((end - t) * 100));
        t = end;
        return `{\\k${cs}}${assEscape(wd.w)}${i < line.words.length - 1 ? ' ' : ''}`;
      });
      events.push(`Dialogue: 1,${assTime(line.startS)},${assTime(line.endS)},${name},,0,0,0,,{\\an5\\pos(${x},${y})}${parts.join('')}`);
    }
  }

  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${w}`,
    `PlayResY: ${h}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    ...styles,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n');
}

/**
 * Words -> short caption lines for reels: at most `maxWords` words and `maxChars` characters per
 * line, and a new line after a sentence end or a pause longer than `gapS`.
 */
export function groupWords(words: Word[], opts: { maxWords?: number; maxChars?: number; gapS?: number } = {}) {
  const maxWords = opts.maxWords ?? 4;
  const maxChars = opts.maxChars ?? 24;
  const gapS = opts.gapS ?? 0.6;
  const lines: { startS: number; endS: number; words: Word[] }[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (cur.length) lines.push({ startS: cur[0]!.s, endS: cur.at(-1)!.e, words: cur });
    cur = [];
  };
  for (const w of words) {
    const prev = cur.at(-1);
    const chars = cur.reduce((n, x) => n + x.w.length + 1, 0) + w.w.length;
    if (prev && (cur.length >= maxWords || chars > maxChars || w.s - prev.e > gapS || /[.!?।]$/.test(prev.w))) flush();
    cur.push(w);
  }
  flush();
  // Keep each line on screen until the next one starts (small gaps), so captions don't flicker.
  for (let i = 0; i < lines.length - 1; i++) {
    const next = lines[i + 1]!;
    if (next.startS - lines[i]!.endS < 0.8) lines[i]!.endS = next.startS;
  }
  return lines;
}
