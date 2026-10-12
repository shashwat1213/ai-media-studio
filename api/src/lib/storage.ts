import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

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
export function createStorage(cfg: StorageConfig) {
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

export type Storage = ReturnType<typeof createStorage>;

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
