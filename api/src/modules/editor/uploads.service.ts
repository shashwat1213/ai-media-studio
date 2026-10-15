import { randomUUID } from 'node:crypto';
import type { PrismaClient, Upload } from '@prisma/client';
import { HttpError, notFound, tooManyRequests } from '../../lib/errors.js';
import type { Storage } from '../../lib/storage.js';
import { ProbeError, UPLOAD_LIMITS, UPLOAD_TYPES, probeMedia, type ProbeResult, type UploadMime } from './probe.js';

export interface PublicUpload {
  id: string;
  status: 'PENDING' | 'READY';
  fileName: string;
  mimeType: string;
  kind: 'image' | 'video' | 'audio';
  bytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  hasAudio: boolean;
  source: 'UPLOAD' | 'RECORDING' | 'TTS' | 'AI_IMAGE';
  /** TTS: what was said, and the voice. */
  script: string | null;
  voice: string | null;
  transcriptStatus: 'NONE' | 'PENDING' | 'DONE' | 'FAILED';
  transcriptError: string | null;
  /** Full transcript (text + word timings) once DONE. */
  transcript: { language: string; text: string; words: { w: string; s: number; e: number }[] } | null;
  url: string | null;
  createdAt: Date;
}

export interface UploadServiceDeps {
  prisma: PrismaClient;
  storage: Storage;
  /** Injectable for tests; defaults to running ffprobe on a short-lived storage URL. */
  probe?: (url: string, declared: UploadMime) => Promise<ProbeResult>;
  maxUploadsPerUser?: number;
}

export const maxBytesFor = (mime: UploadMime) =>
  mime.startsWith('image/') ? UPLOAD_LIMITS.imageBytes : mime.startsWith('audio/') ? UPLOAD_LIMITS.audioBytes : UPLOAD_LIMITS.videoBytes;
export const kindOf = (mime: string): 'image' | 'video' | 'audio' => (mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'image');

/**
 * The user's source material for the Editor: screenshots and screen recordings.
 *
 * Flow (the file never passes through the API):
 *  1. POST /uploads          -> PENDING row + a presigned POST (S3 enforces size + type)
 *  2. browser POSTs the file straight to S3/MinIO
 *  3. POST /uploads/:id/complete -> we check the object really exists, its size, and that
 *     ffprobe can decode it as the declared kind; then READY + metadata. Anything else: deleted.
 */
export function createUploadService({ prisma, storage, probe, maxUploadsPerUser = 200 }: UploadServiceDeps) {
  async function toPublic(u: Upload): Promise<PublicUpload> {
    return {
      id: u.id,
      status: u.status,
      fileName: u.fileName,
      mimeType: u.mimeType,
      kind: kindOf(u.mimeType),
      bytes: u.bytes,
      width: u.width,
      height: u.height,
      durationMs: u.durationMs,
      hasAudio: u.hasAudio,
      source: u.source,
      script: u.script,
      voice: u.voice,
      transcriptStatus: u.transcriptStatus,
      transcriptError: u.transcriptError,
      transcript: u.transcriptStatus === 'DONE' ? (u.transcript as PublicUpload['transcript']) : null,
      url: u.status === 'READY' ? await storage.signedUrl(u.storageKey) : null,
      createdAt: u.createdAt,
    };
  }

  async function runProbe(key: string, declared: UploadMime): Promise<ProbeResult> {
    const url = await storage.internalUrl(key);
    return (probe ?? probeMedia)(url, declared);
  }

  return {
    async create(userId: string, input: { fileName: string; mimeType: UploadMime; bytes: number; source?: 'UPLOAD' | 'RECORDING' }) {
      const max = maxBytesFor(input.mimeType);
      if (input.bytes > max) throw new HttpError(413, `File is too large (max ${Math.round(max / 1024 / 1024)} MB)`);
      const count = await prisma.upload.count({ where: { userId } });
      if (count >= maxUploadsPerUser) throw tooManyRequests(`You have ${count} files. Delete some before uploading more.`);

      const id = randomUUID();
      const storageKey = `uploads/${userId}/${id}.${UPLOAD_TYPES[input.mimeType]}`;
      const upload = await prisma.upload.create({
        data: { id, userId, storageKey, fileName: input.fileName, mimeType: input.mimeType, bytes: input.bytes, source: input.source ?? 'UPLOAD' },
      });
      // Exactly the declared type, at most the type's limit. S3 rejects anything else.
      const post = await storage.presignUpload(storageKey, input.mimeType, max);
      return { upload: await toPublic(upload), post };
    },

    /** Verify the uploaded object and mark it READY. Idempotent: completing twice returns the same row. */
    async complete(userId: string, id: string) {
      const u = await prisma.upload.findFirst({ where: { id, userId } });
      if (!u) throw notFound('Upload not found');
      if (u.status === 'READY') return toPublic(u);

      const head = await storage.head(u.storageKey);
      if (!head) throw new HttpError(409, 'The file has not been uploaded yet');

      const reject = async (message: string) => {
        await prisma.upload.delete({ where: { id: u.id } }).catch(() => undefined);
        await storage.remove(u.storageKey).catch(() => undefined);
        return new HttpError(400, message);
      };
      if (head.bytes > maxBytesFor(u.mimeType as UploadMime)) throw await reject('File is too large');

      let info: ProbeResult;
      try {
        info = await runProbe(u.storageKey, u.mimeType as UploadMime);
      } catch (err) {
        if (err instanceof ProbeError) throw await reject(err.message);
        throw err;
      }
      // Guarded: a parallel complete() may have won; both then return the READY row.
      await prisma.upload.updateMany({
        where: { id: u.id, status: 'PENDING' },
        data: {
          status: 'READY',
          bytes: head.bytes,
          width: info.width || null,
          height: info.height || null,
          durationMs: info.durationMs,
          hasAudio: info.hasAudio,
        },
      });
      return toPublic(await prisma.upload.findUniqueOrThrow({ where: { id: u.id } }));
    },

    async get(userId: string, id: string) {
      const u = await prisma.upload.findFirst({ where: { id, userId } });
      if (!u) throw notFound('Upload not found');
      return toPublic(u);
    },

    async list(userId: string, opts: { limit: number; cursor?: string; type?: 'image' | 'video' | 'audio' }) {
      const rows = await prisma.upload.findMany({
        where: { userId, status: 'READY', ...(opts.type ? { mimeType: { startsWith: `${opts.type}/` } } : {}) },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: opts.limit + 1,
        ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      });
      const page = rows.slice(0, opts.limit);
      return { items: await Promise.all(page.map(toPublic)), nextCursor: rows.length > opts.limit ? page[page.length - 1]!.id : null };
    },

    async remove(userId: string, id: string, onOrphan?: (key: string, err: unknown) => void) {
      const u = await prisma.upload.findFirst({ where: { id, userId }, select: { id: true, storageKey: true } });
      if (!u) throw notFound('Upload not found');
      await prisma.upload.delete({ where: { id: u.id } });
      try {
        await storage.remove(u.storageKey);
      } catch (err) {
        onOrphan?.(u.storageKey, err);
      }
    },
  };
}

export type UploadService = ReturnType<typeof createUploadService>;

/**
 * Uploads that were started but never completed (tab closed mid-upload): delete the row and any
 * partial object. Run by the worker's sweeper.
 */
export async function sweepStaleUploads(prisma: PrismaClient, storage: Storage, olderThanMinutes = 60, now = new Date()) {
  const cutoff = new Date(now.getTime() - olderThanMinutes * 60_000);
  const stale = await prisma.upload.findMany({ where: { status: 'PENDING', createdAt: { lt: cutoff } }, select: { id: true, storageKey: true }, take: 100 });
  for (const u of stale) {
    await storage.remove(u.storageKey).catch(() => undefined);
    await prisma.upload.deleteMany({ where: { id: u.id, status: 'PENDING' } });
  }
  return stale.length;
}
