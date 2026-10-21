import { runProcess } from '../../lib/run-process.js';

export interface ProbeResult {
  kind: 'image' | 'video' | 'audio';
  /** 0 for audio. */
  width: number;
  height: number;
  /** Videos and audio. */
  durationMs: number | null;
  codec: string;
  /** Has a decodable sound track (always true for audio). */
  hasAudio: boolean;
}

/** Upload limits (also enforced by S3 via the presigned POST policy). */
export const UPLOAD_TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/mp4': 'm4a',
  'audio/webm': 'weba',
  'audio/ogg': 'ogg',
} as const;
export type UploadMime = keyof typeof UPLOAD_TYPES;

export const UPLOAD_LIMITS = {
  imageBytes: 15 * 1024 * 1024,
  videoBytes: 200 * 1024 * 1024,
  audioBytes: 50 * 1024 * 1024,
  maxVideoS: 600,
  maxSide: 8192,
} as const;

const IMAGE_CODECS = new Set(['png', 'mjpeg', 'webp']);
const VIDEO_CODECS = new Set(['h264', 'hevc', 'vp8', 'vp9', 'av1', 'prores', 'mpeg4']);
const AUDIO_CODECS = new Set(['mp3', 'aac', 'opus', 'vorbis', 'flac', 'alac', 'pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le', 'pcm_u8']);

/** A file that is not what it claims to be, or is out of bounds (-> 400 for the user). */
export class ProbeError extends Error {}

/**
 * Parse ffprobe's JSON for one file. Pure, so it's unit-tested with canned output.
 * We trust the CONTENT (what ffprobe decoded), never the file name or the browser's MIME type:
 * a renamed .exe is "not a recognised image or video", whatever its extension says.
 */
export function interpretProbe(json: string, declared: UploadMime, durationOverrideMs?: number): ProbeResult {
  let data: { streams?: Array<Record<string, unknown>>; format?: { duration?: string; format_name?: string } };
  try {
    data = JSON.parse(json);
  } catch {
    throw new ProbeError('Not a recognised image or video file');
  }
  const a = data.streams?.find((s) => s.codec_type === 'audio' && AUDIO_CODECS.has(String(s.codec_name ?? '')));
  const durOf = (st: Record<string, unknown> | undefined) =>
    durationOverrideMs !== undefined ? durationOverrideMs / 1000 : Number(st?.duration ?? data.format?.duration);

  if (declared.startsWith('audio/')) {
    if (!a) throw new ProbeError('Not a recognised audio file');
    const dur = durOf(a);
    if (!(dur > 0)) throw new ProbeError('Could not read the audio length. Try exporting it as MP3.');
    if (dur > UPLOAD_LIMITS.maxVideoS) throw new ProbeError(`Audio is too long (max ${UPLOAD_LIMITS.maxVideoS / 60} minutes)`);
    return { kind: 'audio', width: 0, height: 0, durationMs: Math.round(dur * 1000), codec: String(a.codec_name), hasAudio: true };
  }

  const v = data.streams?.find((s) => s.codec_type === 'video');
  if (!v) throw new ProbeError('Not a recognised image or video file');
  const codec = String(v.codec_name ?? '');
  const width = Number(v.width);
  const height = Number(v.height);
  if (!(width > 0 && height > 0)) throw new ProbeError('Could not read the picture size');
  if (width > UPLOAD_LIMITS.maxSide || height > UPLOAD_LIMITS.maxSide) {
    throw new ProbeError(`Picture is too large (max ${UPLOAD_LIMITS.maxSide}px per side)`);
  }

  const wantsImage = declared.startsWith('image/');
  if (wantsImage) {
    if (!IMAGE_CODECS.has(codec)) throw new ProbeError('Not a PNG, JPEG or WebP image');
    return { kind: 'image', width, height, durationMs: null, codec, hasAudio: false };
  }
  if (!VIDEO_CODECS.has(codec)) throw new ProbeError(`Unsupported video codec (${codec || 'unknown'})`);
  // WebM from MediaRecorder often has no duration in the header; the stream/format may still know.
  const dur = durOf(v);
  if (!(dur > 0)) throw new ProbeError('Could not read the video length. Try exporting it as MP4.');
  if (dur > UPLOAD_LIMITS.maxVideoS) throw new ProbeError(`Video is too long (max ${UPLOAD_LIMITS.maxVideoS / 60} minutes)`);
  return { kind: 'video', width, height, durationMs: Math.round(dur * 1000), codec, hasAudio: Boolean(a) };
}

const PROTOCOLS = ['-protocol_whitelist', 'file,http,https,tcp,tls'];

/**
 * Run ffprobe on a file path or URL. The protocol whitelist stops a crafted file from making
 * ffprobe open other files or URLs (playlist / concat tricks).
 */
export async function probeMedia(input: string, declared: UploadMime, opts: { ffprobePath?: string; timeoutMs?: number } = {}): Promise<ProbeResult> {
  const bin = opts.ffprobePath ?? process.env.FFPROBE_PATH ?? 'ffprobe';
  const { stdout } = await runProcess(
    bin,
    ['-v', 'error', ...PROTOCOLS, '-show_entries', 'stream=codec_type,codec_name,width,height,duration:format=duration,format_name', '-of', 'json', input],
    { timeoutMs: opts.timeoutMs ?? 20_000 },
  ).catch(notMedia);
  try {
    return interpretProbe(stdout, declared);
  } catch (err) {
    // Browser screen recordings (MediaRecorder WebM) usually have NO duration in the header.
    // Measure it the slow way (last packet timestamp), then re-check every rule with it.
    if (err instanceof ProbeError && /(video|audio) length/.test(err.message)) {
      const durationMs = await durationByPackets(bin, input, declared, opts.timeoutMs ?? 60_000);
      if (durationMs) return interpretProbe(stdout, declared, durationMs);
    }
    throw err;
  }
}

function notMedia(err: Error): never {
  if (err.name === 'ProviderError') throw err; // ffprobe missing: an ops problem, not the user's
  throw new ProbeError('Not a recognised image or video file');
}

async function durationByPackets(bin: string, input: string, declared: UploadMime, timeoutMs: number): Promise<number | null> {
  const { stdout } = await runProcess(
    bin,
    ['-v', 'error', ...PROTOCOLS, '-select_streams', declared.startsWith('audio/') ? 'a:0' : 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', input],
    // ~10 bytes per packet: a 10-minute 60 fps recording is ~360 KB of text.
    { timeoutMs, maxOutput: 2 * 1024 * 1024 },
  ).catch(notMedia);
  let max = 0;
  for (const line of stdout.split('\n')) {
    const t = Number(line.trim().replace(/,$/, ''));
    if (t > max) max = t;
  }
  return max > 0 ? Math.round(max * 1000) : null;
}
