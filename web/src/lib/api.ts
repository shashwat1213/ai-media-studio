/**
 * Tiny fetch wrapper. All API calls go through here so cookies, base URL and
 * error handling live in ONE place.
 * VITE_API_URL is baked in at build time; in dev it's '/api' (Vite proxy).
 */
const BASE = import.meta.env.VITE_API_URL ?? '/api';

export class ApiError extends Error {
  readonly status: number;
  readonly details?: Record<string, string[] | undefined>;
  constructor(status: number, message: string, details?: Record<string, string[] | undefined>) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    credentials: 'include', // send the httpOnly JWT cookie
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error ?? res.statusText, body.details);
  return body as T;
}

// ---- API types (mirror the backend's response shapes) ----

export interface User {
  id: string;
  email: string;
  credits: number;
  createdAt: string;
}

export type CreditReason = 'SIGNUP_BONUS' | 'PURCHASE' | 'GENERATION' | 'REFUND';

export interface CreditTransaction {
  id: string;
  delta: number;
  reason: CreditReason;
  balanceAfter: number;
  refId: string | null;
  createdAt: string;
}

export interface CreditSummary {
  balance: number;
  transactions: CreditTransaction[];
}

export interface Health {
  status: 'ok' | 'degraded';
  db: 'up' | 'down';
}

// ---- Phase 2: generation ----

export type JobStatus = 'QUEUED' | 'PROCESSING' | 'DONE' | 'FAILED';
export type JobKind = 'IMAGE' | 'MOTION' | 'EDIT';

export interface ModelOption {
  id: string;
  name: string;
  description: string;
  credits: number;
  /** Ratios this model supports (some only output squares). Older APIs omit it = all. */
  aspectRatios?: string[];
}

export interface ModelCatalog {
  mode: 'stub' | 'openrouter' | 'cloudflare';
  models: ModelOption[];
  aspectRatios: string[];
}

export interface Asset {
  id: string;
  jobId: string;
  url: string; // presigned, short-lived
  downloadUrl: string;
  mimeType: string;
  bytes: number;
  width: number | null;
  height: number | null;
  /** Videos only. */
  durationMs: number | null;
  kind: 'image' | 'video';
  createdAt: string;
  prompt?: string;
  model?: string;
  aspectRatio?: string;
}

export interface Job {
  id: string;
  kind: JobKind;
  prompt: string;
  model: string;
  aspectRatio: string;
  status: JobStatus;
  creditsCost: number;
  attempts: number;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  asset: Asset | null;
  motion: { preset: string; durationS: number; sourceAssetId: string | null } | null;
  /** EDIT only (older APIs omit it). */
  edit?: { totalS: number; format: string; clips: { uploadId: string; kind: 'image' | 'video'; lengthS: number }[] } | null;
}

export interface MotionPreset {
  id: string;
  name: string;
  description: string;
}

export interface MotionCatalog {
  /** 'camera' = a camera move over a still image (not AI video). */
  engine: 'camera';
  presets: MotionPreset[];
  durations: { seconds: number; credits: number }[];
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

// ---- Editor: uploads + edit jobs ----

export interface TranscriptWord {
  w: string;
  s: number;
  e: number;
}

export interface Upload {
  id: string;
  status: 'PENDING' | 'READY';
  fileName: string;
  mimeType: string;
  kind: 'image' | 'video' | 'audio';
  hasAudio: boolean;
  source: 'UPLOAD' | 'RECORDING' | 'TTS' | 'AI_IMAGE' | 'AI_VIDEO' | 'MUSIC';
  script: string | null;
  voice: string | null;
  transcriptStatus: 'NONE' | 'PENDING' | 'DONE' | 'FAILED';
  transcriptError: string | null;
  transcript: { language: string; text: string; words: TranscriptWord[] } | null;
  bytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  /** Presigned, short-lived. Null until READY. */
  url: string | null;
  createdAt: string;
}

export type EditFormat = '16:9' | '9:16' | '1:1';
export type TextSize = 's' | 'm' | 'l' | 'xl';
export type TextStyle = 'box' | 'outline' | 'plain';

export interface EditorConfig {
  formats: { id: EditFormat; w: number; h: number }[];
  limits: {
    clips: number;
    texts: number;
    boxes: number;
    maxTotalS: number;
    minClipS: number;
    maxImageClipS: number;
    textChars: number;
    textLines: number;
    imageBytes: number;
    videoBytes: number;
    audioBytes: number;
    audio: number;
    maxVideoS: number;
  };
  uploadTypes: string[];
  secondsPerCredit: number;
  transitions: Transition[];
  motions: ImageMotion[];
  templates: EditTemplate[];
}

export type Transition = 'none' | 'fade' | 'fadeblack' | 'dissolve' | 'slideleft' | 'slideup' | 'smoothleft' | 'wipeleft' | 'zoomin' | 'circleopen';
export type ImageMotion = 'none' | 'zoom-in' | 'zoom-out' | 'pan-left' | 'pan-right' | 'pan-up' | 'pan-down';
export type TextAnim = 'none' | 'fade' | 'slide';

export interface EditTemplate {
  id: string;
  name: string;
  description: string;
  format: EditFormat;
  transition: Transition;
  imageS: number;
  motion: ImageMotion | 'auto';
  intro: { bg: string; bg2?: string; color: string; durationS: number } | null;
  outro: { title: string; subtitle?: string; bg: string; bg2?: string; color: string; durationS: number } | null;
}

export interface EditCard {
  title: string;
  subtitle: string;
  bg: string;
  bg2?: string;
  color: string;
}

export interface EditText {
  text: string;
  startS: number;
  endS: number;
  x: number;
  y: number;
  size: TextSize;
  color: string;
  style: TextStyle;
  anim: TextAnim;
}

export interface EditBox {
  x: number;
  y: number;
  w: number;
  h: number;
  startS: number;
  endS: number;
  color: string;
}

export type EditClipRequest =
  | { uploadId: string; durationS?: number; trimStartS?: number; trimEndS?: number; fit: 'contain' | 'cover'; motion?: ImageMotion | 'auto'; volume?: number }
  | { card: EditCard; durationS: number };

export interface EditRequest {
  title?: string;
  format: EditFormat;
  background: string;
  transition: Transition;
  clips: EditClipRequest[];
  texts: EditText[];
  boxes: EditBox[];
  audio?: EditAudio[];
  autoCaptions?: AutoCaptions | null;
}

export interface EditAudio {
  uploadId: string;
  atS: number;
  trimStartS: number;
  trimEndS?: number;
  volume: number;
  duck: boolean;
}

export interface AutoCaptions {
  uploadId: string;
  y: number;
  size: TextSize;
  color: string;
  highlight: string;
  style: 'box' | 'outline';
  maxWords: number;
}

export interface Voice {
  id: string;
  name: string;
  style: string;
  gender: 'female' | 'male';
}

export interface AudioConfig {
  provider: string;
  voices: Voice[];
  tts: { maxChars: number; charsPerCredit: number };
  stt: { secondsPerCredit: number };
}
