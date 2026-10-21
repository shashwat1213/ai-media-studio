/**
 * Built-in music beds and ambience, synthesised by ffmpeg (aevalsrc / anoisesrc). No files to ship,
 * no licence to track, nothing downloaded: every track is a recipe rendered to the exact length of
 * the scene (with fades). The Scene Director uses these when the user's library has no matching
 * SOUND, and cuts the shots on the music's beat.
 *
 * Recipes are deterministic (fixed random seeds), so the same scene always sounds the same.
 */

export type StockRole = 'music' | 'ambience';

export interface StockTrack {
  id: string;
  name: string;
  role: StockRole;
  /** Music only: tempo, used to cut shots on the beat. */
  bpm?: number;
  /** Words matched against the director's mood + sound descriptions (and the brief). */
  tags: string[];
  /** Mix level in the scene (music is also ducked under the voice). */
  volume: number;
}

export const STOCK_TRACKS: readonly StockTrack[] = [
  { id: 'pulse', name: 'Dance Pulse', role: 'music', bpm: 120, volume: 0.5, tags: ['dance', 'dancing', 'party', 'club', 'energetic', 'upbeat', 'groove', 'celebration', 'festival', 'reel', 'fashion', 'workout', 'fitness', 'night', 'neon'] },
  { id: 'sunny', name: 'Sunny Pop', role: 'music', bpm: 104, volume: 0.45, tags: ['happy', 'cheerful', 'bright', 'travel', 'vlog', 'summer', 'beach', 'fun', 'playful', 'joyful', 'holiday', 'food', 'product', 'morning'] },
  { id: 'lofi', name: 'Lo-fi Chill', role: 'music', bpm: 84, volume: 0.45, tags: ['calm', 'chill', 'cozy', 'relaxed', 'lofi', 'study', 'coffee', 'tea', 'chai', 'nostalgic', 'peaceful', 'evening', 'quiet', 'romantic', 'gentle'] },
  { id: 'cinematic', name: 'Cinematic Rise', role: 'music', bpm: 70, volume: 0.5, tags: ['epic', 'dramatic', 'emotional', 'inspiring', 'motivational', 'cinematic', 'sad', 'hope', 'mysterious', 'documentary', 'story', 'heroic', 'majestic', 'mountain', 'angry', 'anger', 'rage', 'shouting', 'tense', 'tension', 'intense', 'fight', 'action', 'thriller', 'dark', 'serious', 'crying', 'grief', 'war'] },
  { id: 'rain', name: 'Rain', role: 'ambience', volume: 0.35, tags: ['rain', 'raining', 'rainy', 'monsoon', 'drizzle', 'storm', 'downpour', 'baarish', 'wet'] },
  { id: 'ocean', name: 'Ocean waves', role: 'ambience', volume: 0.35, tags: ['ocean', 'sea', 'waves', 'wave', 'beach', 'shore', 'surf', 'coast', 'tide'] },
  { id: 'wind', name: 'Wind', role: 'ambience', volume: 0.3, tags: ['wind', 'windy', 'breeze', 'mountain', 'mountains', 'hill', 'hills', 'snow', 'fog', 'mist', 'desert', 'valley'] },
  { id: 'city', name: 'City street', role: 'ambience', volume: 0.3, tags: ['city', 'street', 'traffic', 'market', 'bazaar', 'crowd', 'horns', 'horn', 'cars', 'road', 'busy', 'urban'] },
  { id: 'night', name: 'Night crickets', role: 'ambience', volume: 0.3, tags: ['crickets', 'cricket', 'night', 'village', 'countryside', 'insects', 'forest', 'field', 'farm'] },
];

export const STOCK_IDS = STOCK_TRACKS.map((t) => t.id) as [string, ...string[]];
export const MUSIC_IDS = STOCK_TRACKS.filter((t) => t.role === 'music').map((t) => t.id);
export const stockTrack = (id: string) => STOCK_TRACKS.find((t) => t.id === id) ?? null;

const words = (text: string) => new Set(text.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2));

/** Best stock track of a role for some text (most tag hits). Null when nothing matches. Pure. */
export function matchStock(text: string, role: StockRole): StockTrack | null {
  const w = words(text);
  let best: { t: StockTrack; hits: number } | null = null;
  for (const t of STOCK_TRACKS) {
    if (t.role !== role) continue;
    const hits = t.tags.filter((tag) => w.has(tag)).length;
    if (hits > 0 && (!best || hits > best.hits)) best = { t, hits };
  }
  return best?.t ?? null;
}

/**
 * Beat-sync unit: shots are lengthened so every cut lands on the beat (one beat for slow music,
 * two beats = half a bar for fast music, so cuts don't feel frantic). Seconds. Pure.
 */
export const beatUnitS = (bpm: number) => Math.round(((60 / bpm) * (bpm >= 100 ? 2 : 1)) * 1000) / 1000;

/**
 * Round a clip length UP so that the step to the next clip (length minus the crossfade overlap)
 * is a whole number of beat units: then every clip starts exactly on a beat. Pure.
 */
export function snapToBeat(lengthS: number, unitS: number, overlapS: number): number {
  const step = Math.max(unitS, Math.ceil((lengthS - overlapS) / unitS - 1e-6) * unitS);
  return Math.round((step + overlapS) * 1000) / 1000;
}

// ---------------------------------------------------------------------------------------------
// Synthesis. Everything below builds ffmpeg expressions; t = seconds.

const SR = 44100;
const f = (n: number) => n.toFixed(4);

/** Phase within a repeating period, shifted by `off` seconds (always >= 0). */
const ph = (period: number, off = 0) => `mod(t+${f(period - (off % period))},${f(period)})`;

/** Pick a value per chord: index = which chord we're in (each `chordS` long, cycling). */
function seq(values: number[], chordS: number) {
  const idx = `mod(floor(t/${f(chordS)}),${values.length})`;
  return '(' + values.map((v, i) => `${f(v)}*eq(${idx},${i})`).join('+') + ')';
}

/** Kick drum every `period`, starting at `off`: falling sine with a fast decay. */
const kick = (period: number, off: number, gain: number, base = 50) => {
  const m = ph(period, off);
  return `${f(gain)}*sin(2*PI*(${base}*${m}+4*(1-exp(-25*${m}))))*exp(-7*${m})`;
};
/** Noise hit (hat/snare/clap) every `period` from `off`, decay `k`. random(n) = deterministic per-seed noise. */
const noiseHit = (period: number, off: number, gain: number, k: number, slot: number) => `${f(gain)}*(2*random(${slot})-1)*exp(-${k}*${ph(period, off)})`;

/** Soft chord pad: three sine voices per chord, slightly detuned, with a per-chord swell. */
function pad(chords: number[][], chordS: number, gain: number, attack = 0.25) {
  const env = `(1-exp(-${f(1 / attack)}*${ph(chordS)}))`;
  const voices = [0, 1, 2].map((v) => {
    const fr = seq(chords.map((c) => c[v]!), chordS);
    return `sin(2*PI*${fr}*t)+0.5*sin(2*PI*${fr}*1.003*t)`;
  });
  return `${f(gain)}*${env}*(${voices.join('+')})`;
}

/** Plucked arpeggio: chord tones in turn every `stepS`, each a decaying sine (+ octave). */
function arp(chords: number[][], chordS: number, stepS: number, gain: number) {
  const tone = `mod(floor(t/${f(stepS)}),3)`;
  const fr = '(' + [0, 1, 2].map((v) => `${seq(chords.map((c) => c[v]! * 2), chordS)}*eq(${tone},${v})`).join('+') + ')';
  return `${f(gain)}*exp(-9*${ph(stepS)})*(sin(2*PI*${fr}*t)+0.3*sin(4*PI*${fr}*t))`;
}

/** Bass: chord root, re-struck every `period` from `off`. */
const bass = (roots: number[], chordS: number, period: number, off: number, gain: number) => {
  const fr = seq(roots, chordS);
  const m = ph(period, off);
  return `${f(gain)}*(1-exp(-60*${m}))*exp(-2.5*${m})*(sin(2*PI*${fr}*t)+0.35*sin(4*PI*${fr}*t))`;
};

// Chords (Hz): A minor, F, C, G and friends.
const Am = [220, 261.63, 329.63];
const F = [174.61, 220, 261.63];
const C = [261.63, 329.63, 392];
const G = [196, 246.94, 293.66];
const Dm7 = [146.83, 174.61, 261.63];
const G7 = [196, 246.94, 349.23];
const Cmaj7 = [261.63, 329.63, 493.88];
const Am7 = [220, 261.63, 392];

interface Layer {
  /** aevalsrc expression, or a noise source. */
  expr?: string;
  noise?: 'white' | 'pink' | 'brown';
  /** Extra filters for this layer (EQ, echo, tremolo). */
  fx?: string;
}

function recipe(id: string): Layer[] {
  switch (id) {
    case 'pulse': {
      const b = 0.5, chordS = 2; // 120 bpm, a chord per bar
      return [
        { expr: kick(b, 0, 0.9) },
        { expr: noiseHit(b, b / 2, 0.35, 55, 0), fx: 'highpass=f=7000' },
        { expr: noiseHit(2 * b, b, 0.45, 16, 1), fx: 'bandpass=f=1500:w=1200' },
        { expr: bass([110, 87.31, 130.81, 98], chordS, b, b / 2, 0.4), fx: 'lowpass=f=600' },
        { expr: `(0.6+0.4*gt(${ph(b, b / 2)},0.05))*${pad([Am, F, C, G], chordS, 0.07, 0.05)}`, fx: 'lowpass=f=2200,aecho=0.8:0.5:375:0.25' },
      ];
    }
    case 'sunny': {
      const b = 60 / 104, chordS = 4 * b;
      return [
        { expr: kick(b, 0, 0.7, 60) },
        { expr: noiseHit(2 * b, b, 0.4, 20, 1), fx: 'bandpass=f=1800:w=1500' },
        { expr: noiseHit(b / 2, 0, 0.15, 70, 0), fx: 'highpass=f=6000' },
        { expr: bass([130.81, 98, 110, 87.31], chordS, b, 0, 0.3), fx: 'lowpass=f=700' },
        { expr: arp([C, G, Am, F], chordS, b / 2, 0.22), fx: 'aecho=0.8:0.4:280:0.2' },
        { expr: pad([C, G, Am, F], chordS, 0.035) },
      ];
    }
    case 'lofi': {
      const b = 60 / 84, chordS = 4 * b;
      return [
        { expr: `${kick(4 * b, 0, 0.75)}+${kick(4 * b, 2.5 * b, 0.6)}` },
        { expr: noiseHit(2 * b, b, 0.35, 14, 1), fx: 'bandpass=f=1100:w=900,lowpass=f=3000' },
        { expr: noiseHit(b / 2, 0, 0.08, 60, 0), fx: 'highpass=f=5000' },
        { expr: `(0.85+0.15*sin(2*PI*5*t))*${pad([Dm7, G7, Cmaj7, Am7], chordS, 0.09, 0.08)}`, fx: 'lowpass=f=1800' },
        { expr: bass([73.42, 98, 65.41, 110], chordS, 2 * b, 0, 0.3), fx: 'lowpass=f=400' },
        // vinyl crackle
        { expr: '0.25*gt(random(2),0.9993)*(2*random(3)-1)', fx: 'highpass=f=1500' },
      ];
    }
    case 'cinematic': {
      const b = 60 / 70, chordS = 8 * b; // a chord every two bars
      return [
        { expr: `(0.55+0.45*sin(2*PI*t/${f(chordS)}-PI/2))*${pad([Am, F, C, G], chordS, 0.08, 1.2)}`, fx: 'lowpass=f=2500,aecho=0.8:0.6:600:0.35' },
        { expr: pad([Am.map((x) => x / 2), F.map((x) => x / 2), C.map((x) => x / 2), G.map((x) => x / 2)], chordS, 0.06, 1.5), fx: 'lowpass=f=500' },
        { expr: kick(4 * b, 0, 0.8, 38) },
        { expr: `${arp([Am, F, C, G], chordS, b / 2, 0.06)}`, fx: 'highpass=f=500,aecho=0.8:0.7:430:0.4' },
      ];
    }
    case 'rain':
      return [
        { noise: 'pink', fx: 'highpass=f=400,lowpass=f=5000,volume=0.5' },
        { expr: '0.6*gt(random(0),0.9985)*(2*random(1)-1)', fx: 'bandpass=f=3000:w=2500' },
        { noise: 'brown', fx: 'lowpass=f=200,volume=0.6' },
      ];
    case 'ocean':
      return [{ noise: 'pink', fx: "lowpass=f=900,volume='0.15+0.85*pow(0.5+0.5*sin(2*PI*t/7.5),2)':eval=frame" }, { noise: 'brown', fx: 'lowpass=f=300,volume=0.4' }];
    case 'wind':
      return [{ noise: 'pink', fx: "bandpass=f=500:w=500,volume='0.35+0.3*sin(2*PI*t/6.3)+0.2*sin(2*PI*t/2.7)':eval=frame" }, { noise: 'brown', fx: 'lowpass=f=250,volume=0.5' }];
    case 'city':
      return [
        { noise: 'brown', fx: 'lowpass=f=500,volume=0.8' },
        { noise: 'pink', fx: 'bandpass=f=1200:w=1500,volume=0.12' },
        // a couple of distant horns
        { expr: `0.12*(lt(${ph(9.3, 3)},0.35)*sin(2*PI*415*t)+lt(${ph(13.7, 8)},0.25)*sin(2*PI*523*t))`, fx: 'lowpass=f=1500,aecho=0.8:0.5:120:0.3' },
      ];
    case 'night':
      return [
        { expr: `0.12*gt(sin(2*PI*28*t),0.2)*lt(${ph(1.3)},0.45)*sin(2*PI*4600*t)` },
        { expr: `0.08*gt(sin(2*PI*31*t),0.2)*lt(${ph(1.7, 0.6)},0.4)*sin(2*PI*5100*t)` },
        { noise: 'brown', fx: 'lowpass=f=300,volume=0.35' },
      ];
    default:
      throw new Error(`unknown stock track ${id}`);
  }
}

const GAIN: Record<string, number> = { lofi: 1.4, cinematic: 2, rain: 3.5, ocean: 3.5, wind: 4, city: 3, night: 3.5 };

/**
 * ffmpeg arguments that render a stock track to `out` (MP3), exactly `seconds` long, with a
 * fade in/out. Pure: the exact command is unit-tested.
 */
export function stockArgs(id: string, seconds: number, out: string): string[] {
  const track = stockTrack(id);
  if (!track) throw new Error(`unknown stock track ${id}`);
  const d = Math.max(1, Math.round(seconds * 1000) / 1000);
  const layers = recipe(id);
  const inputs = layers.flatMap((l, i) =>
    l.noise
      ? ['-f', 'lavfi', '-i', `anoisesrc=c=${l.noise}:a=0.5:r=${SR}:d=${d}:seed=${101 + i}`]
      : ['-f', 'lavfi', '-i', `aevalsrc='${l.expr}':s=${SR}:d=${d}`],
  );
  const chains = layers.map((l, i) => `[${i}:a]${l.fx ? `${l.fx},` : ''}aformat=channel_layouts=mono[l${i}]`);
  const fadeOut = Math.min(2, d / 4);
  // Measured mean levels (20 s renders): music -15..-23 dB, ambience about -30 dB. Lift the quiet
  // ones so every bed lands near -15..-20 dB before the scene's own mix volume.
  const gain = GAIN[id] ?? 1;
  const master =
    `${layers.map((_, i) => `[l${i}]`).join('')}amix=inputs=${layers.length}:normalize=0,highpass=f=30,volume=${gain},` +
    `alimiter=limit=0.9:level=disabled,afade=t=in:d=${f(Math.min(0.6, d / 4))},afade=t=out:st=${f(d - fadeOut)}:d=${f(fadeOut)},` +
    `aformat=sample_rates=${SR}:channel_layouts=stereo[out]`;
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...inputs, '-filter_complex', [...chains, master].join(';'), '-map', '[out]', '-t', String(d), '-c:a', 'libmp3lame', '-b:a', '160k', out];
}
