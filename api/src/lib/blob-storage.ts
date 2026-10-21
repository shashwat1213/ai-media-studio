import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { del, get, head, issueSignedToken, presignUrl, put } from '@vercel/blob';
import type { Storage, UploadTarget } from './storage.js';

/**
 * Object storage on Vercel Blob (PRIVATE store), for the serverless deployment.
 * Same contract as the S3/MinIO storage:
 *  - objects are private; the browser only ever gets short-lived presigned URLs
 *  - browser uploads go straight to the store with a presigned PUT that is locked to ONE pathname,
 *    ONE content type and a max size (the store enforces all three; verified 21 Oct 2026)
 * The store token comes from BLOB_READ_WRITE_TOKEN (set by Vercel when the store is connected).
 */
export interface BlobStorageConfig {
  token: string;
  signedUrlTtlSeconds: number;
  /** Injectable for tests. */
  sdk?: BlobSdk;
}

export interface BlobSdk {
  put: typeof put;
  get: typeof get;
  head: typeof head;
  del: typeof del;
  issueSignedToken: typeof issueSignedToken;
  presignUrl: typeof presignUrl;
}

const realSdk: BlobSdk = { put, get, head, del, issueSignedToken, presignUrl };

const isNotFound = (err: unknown) => /does not exist|not.?found/i.test((err as Error)?.message ?? '') || (err as Error)?.name === 'BlobNotFoundError';

export function createBlobStorage(cfg: BlobStorageConfig): Storage {
  const sdk = cfg.sdk ?? realSdk;
  const token = cfg.token;

  async function presignGet(key: string, ttlSeconds: number) {
    const validUntil = Date.now() + ttlSeconds * 1000;
    const t = await sdk.issueSignedToken({ token, pathname: key, operations: ['get'], validUntil });
    return (await sdk.presignUrl(t, { access: 'private', operation: 'get', pathname: key, validUntil })).presignedUrl;
  }

  async function read(key: string) {
    const r = await sdk.get(key, { access: 'private', token, useCache: false });
    if (!r || r.statusCode !== 200 || !r.stream) throw new Error(`blob not found: ${key}`);
    return r.stream;
  }

  return {
    bucket: 'vercel-blob',

    async put(key, body, contentType) {
      await sdk.put(key, body, { access: 'private', token, contentType, addRandomSuffix: false, allowOverwrite: true });
    },

    async get(key) {
      return Buffer.from(await new Response(await read(key)).arrayBuffer());
    },

    async download(key, filePath) {
      await pipeline(Readable.fromWeb((await read(key)) as never), createWriteStream(filePath));
    },

    async head(key) {
      try {
        const h = await sdk.head(key, { token });
        return { bytes: h.size, contentType: h.contentType };
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },

    async presignUpload(key, contentType, maxBytes, expiresSeconds = 600): Promise<UploadTarget> {
      const validUntil = Date.now() + expiresSeconds * 1000;
      const scope = { allowedContentTypes: [contentType], maximumSizeInBytes: maxBytes };
      const t = await sdk.issueSignedToken({ token, pathname: key, operations: ['put'], validUntil, ...scope });
      const { presignedUrl } = await sdk.presignUrl(t, { access: 'private', operation: 'put', pathname: key, validUntil, addRandomSuffix: false, allowOverwrite: false, ...scope });
      return { url: presignedUrl, fields: {}, method: 'PUT', headers: { 'x-content-type': contentType } };
    },

    internalUrl(key, expiresIn = 300) {
      return presignGet(key, expiresIn);
    },

    async remove(key) {
      await sdk.del(key, { token });
    },

    signedUrl(key) {
      return presignGet(key, cfg.signedUrlTtlSeconds);
    },

    async ensureBucket() {
      // The store is created by `vercel blob create-store`; nothing to do at runtime.
    },

    async ping() {
      try {
        await sdk.head('__ping__', { token });
        return true;
      } catch (err) {
        return isNotFound(err);
      }
    },

    destroy() {},
  };
}
