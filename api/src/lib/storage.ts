import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';

export interface StorageConfig {
  bucket: string;
  region: string;
  /** Where THIS process reaches S3/MinIO (inside Docker: http://minio:9000). Unset = real AWS S3. */
  endpoint?: string;
  /** Where the BROWSER reaches it (http://localhost:9000). Presigned URLs are signed for this host. */
  publicEndpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle: boolean;
  signedUrlTtlSeconds: number;
}

/**
 * Thin wrapper over the AWS SDK v3 S3 client. The SAME code talks to MinIO/Silo locally
 * and to AWS S3 in production: only the endpoint + credentials change (12-factor).
 *
 * Objects are PRIVATE. The browser never gets bucket credentials; it gets a presigned
 * GET URL: a normal https link with a signature + expiry baked into the query string.
 */
/** A browser upload target: S3 presigned POST (form fields) or Vercel Blob presigned PUT (headers). */
export interface UploadTarget {
  url: string;
  /** POST: send these as multipart form fields, file LAST. */
  fields: Record<string, string>;
  /** Default POST. PUT = send the raw file as the body with `headers`. */
  method?: 'POST' | 'PUT';
  headers?: Record<string, string>;
}

/** What the app needs from object storage. Implemented by S3/MinIO (below) and Vercel Blob (blob-storage.ts). */
export interface Storage {
  readonly bucket: string;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  download(key: string, filePath: string): Promise<void>;
  head(key: string): Promise<{ bytes: number; contentType?: string } | null>;
  presignUpload(key: string, contentType: string, maxBytes: number, expiresSeconds?: number): Promise<UploadTarget>;
  internalUrl(key: string, expiresIn?: number): Promise<string>;
  remove(key: string): Promise<void>;
  signedUrl(key: string, downloadName?: string): Promise<string>;
  ensureBucket(): Promise<void>;
  ping(): Promise<boolean>;
  destroy(): void;
}

export function createStorage(cfg: StorageConfig): Storage {
  const base: S3ClientConfig = {
    region: cfg.region,
    forcePathStyle: cfg.forcePathStyle,
    // No keys configured (prod on ECS) -> the SDK's default chain uses the task's IAM role.
    credentials:
      cfg.accessKeyId && cfg.secretAccessKey
        ? { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey }
        : undefined,
  };
  const internal = new S3Client({ ...base, endpoint: cfg.endpoint });
  // Signing is a local computation (no network call). The signature covers the Host header,
  // so we must sign with the host the browser will actually use.
  const publicClient = new S3Client({ ...base, endpoint: cfg.publicEndpoint ?? cfg.endpoint });

  return {
    bucket: cfg.bucket,

    async put(key: string, body: Buffer, contentType: string) {
      await internal.send(
        new PutObjectCommand({
          Bucket: cfg.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          // Generated files never change (new generation = new key) -> cache aggressively.
          CacheControl: 'private, max-age=31536000, immutable',
        }),
      );
    },

    /** Read an object fully into memory. For generated assets (a few MB), not for huge files. */
    async get(key: string): Promise<Buffer> {
      const res = await internal.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
      if (!res.Body) throw new Error(`empty body for ${key}`);
      return Buffer.from(await res.Body.transformToByteArray());
    },

    /** Stream an object to a local file (large uploads: never held in memory). */
    async download(key: string, filePath: string): Promise<void> {
      const res = await internal.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
      if (!res.Body) throw new Error(`empty body for ${key}`);
      await pipeline(res.Body as Readable, createWriteStream(filePath));
    },

    /** Size + type of an object as stored (null = it doesn't exist). */
    async head(key: string): Promise<{ bytes: number; contentType?: string } | null> {
      try {
        const res = await internal.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }));
        return { bytes: res.ContentLength ?? 0, contentType: res.ContentType };
      } catch (err) {
        const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (status === 404 || (err as Error).name === 'NotFound') return null;
        throw err;
      }
    },

    /**
     * A browser upload straight to the bucket (the file never passes through our API).
     * Presigned POST, not PUT: the signed POLICY makes S3 itself reject a file that is bigger
     * than `maxBytes` or has a different Content-Type. A presigned PUT can't limit size.
     */
    async presignUpload(key: string, contentType: string, maxBytes: number, expiresSeconds = 600) {
      const { url, fields } = await createPresignedPost(publicClient, {
        Bucket: cfg.bucket,
        Key: key,
        Conditions: [
          ['content-length-range', 1, maxBytes],
          ['eq', '$Content-Type', contentType],
        ],
        Fields: { 'Content-Type': contentType },
        Expires: expiresSeconds,
      });
      return { url, fields };
    },

    /** Short-lived GET URL reachable from THIS process (ffprobe reads uploads over HTTP, no download). */
    internalUrl(key: string, expiresIn = 300): Promise<string> {
      return getSignedUrl(internal, new GetObjectCommand({ Bucket: cfg.bucket, Key: key }), { expiresIn });
    },

    async remove(key: string) {
      await internal.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
    },

    /** Short-lived link to view the object. `downloadName` makes the browser save it instead of opening it. */
    signedUrl(key: string, downloadName?: string): Promise<string> {
      return getSignedUrl(
        publicClient,
        new GetObjectCommand({
          Bucket: cfg.bucket,
          Key: key,
          ResponseContentDisposition: downloadName ? `attachment; filename="${downloadName}"` : undefined,
        }),
        { expiresIn: cfg.signedUrlTtlSeconds },
      );
    },

    /** Create the bucket if missing. Used by tests/CI and local dev; prod buckets come from infrastructure code. */
    async ensureBucket() {
      try {
        await internal.send(new HeadBucketCommand({ Bucket: cfg.bucket }));
      } catch {
        await internal.send(new CreateBucketCommand({ Bucket: cfg.bucket }));
      }
    },

    async ping(): Promise<boolean> {
      try {
        await internal.send(new HeadBucketCommand({ Bucket: cfg.bucket }));
        return true;
      } catch {
        return false;
      }
    },

    destroy() {
      internal.destroy();
      publicClient.destroy();
    },
  };
}


/** S3/MinIO or Vercel Blob, from env (STORAGE_DRIVER). */
export async function storageFromEnv(env: Parameters<typeof storageConfigFromEnv>[0] & { STORAGE_DRIVER: 's3' | 'vercel-blob'; BLOB_READ_WRITE_TOKEN?: string }): Promise<Storage> {
  if (env.STORAGE_DRIVER === 'vercel-blob') {
    const { createBlobStorage } = await import('./blob-storage.js');
    return createBlobStorage({ token: env.BLOB_READ_WRITE_TOKEN!, signedUrlTtlSeconds: env.SIGNED_URL_TTL_SECONDS });
  }
  return createStorage(storageConfigFromEnv(env));
}

export function storageConfigFromEnv(env: {
  S3_BUCKET: string;
  S3_REGION: string;
  S3_ENDPOINT?: string;
  S3_PUBLIC_ENDPOINT?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
  S3_FORCE_PATH_STYLE: boolean;
  SIGNED_URL_TTL_SECONDS: number;
}): StorageConfig {
  return {
    bucket: env.S3_BUCKET,
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT,
    publicEndpoint: env.S3_PUBLIC_ENDPOINT,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    signedUrlTtlSeconds: env.SIGNED_URL_TTL_SECONDS,
  };
}
