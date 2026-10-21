import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createBlobStorage, type BlobSdk } from './blob-storage.js';

/** A fake Vercel Blob SDK that records calls and keeps blobs in memory. */
function fakeSdk() {
  const blobs = new Map<string, { data: Buffer; contentType: string }>();
  const calls: { fn: string; args: unknown[] }[] = [];
  const rec = (fn: string, ...args: unknown[]) => calls.push({ fn, args });
  const notFound = () => Object.assign(new Error('Vercel Blob: The requested blob does not exist'), { name: 'BlobNotFoundError' });
  const sdk = {
    put: async (key: string, body: Buffer, o: { contentType: string }) => {
      rec('put', key, o);
      blobs.set(key, { data: Buffer.from(body), contentType: o.contentType });
      return { url: `https://store/${key}`, pathname: key };
    },
    get: async (key: string, o: unknown) => {
      rec('get', key, o);
      const b = blobs.get(key);
      if (!b) return null;
      return { statusCode: 200, stream: new Response(new Uint8Array(b.data)).body };
    },
    head: async (key: string, o: unknown) => {
      rec('head', key, o);
      const b = blobs.get(key);
      if (!b) throw notFound();
      return { size: b.data.length, contentType: b.contentType };
    },
    del: async (key: string, o: unknown) => {
      rec('del', key, o);
      blobs.delete(key);
    },
    issueSignedToken: async (o: unknown) => {
      rec('issueSignedToken', o);
      return { clientSigningToken: 'c', delegationToken: 'd', validUntil: 0 };
    },
    presignUrl: async (_t: unknown, o: { operation: string; pathname: string }) => {
      rec('presignUrl', o);
      return { presignedUrl: `https://signed/${o.operation}/${o.pathname}` };
    },
  } as unknown as BlobSdk;
  return { sdk, blobs, calls };
}

describe('Vercel Blob storage', () => {
  const make = () => {
    const f = fakeSdk();
    return { ...f, s: createBlobStorage({ token: 'tok', signedUrlTtlSeconds: 900, sdk: f.sdk }) };
  };

  it('put/get/head/remove: private, exact key (no random suffix), token passed', async () => {
    const { s, calls } = make();
    await s.put('users/u/a.png', Buffer.from('png!'), 'image/png');
    expect(calls[0]).toEqual({ fn: 'put', args: ['users/u/a.png', expect.objectContaining({ access: 'private', token: 'tok', contentType: 'image/png', addRandomSuffix: false, allowOverwrite: true })] });
    expect((await s.get('users/u/a.png')).toString()).toBe('png!');
    expect(await s.head('users/u/a.png')).toEqual({ bytes: 4, contentType: 'image/png' });
    await s.remove('users/u/a.png');
    expect(await s.head('users/u/a.png')).toBeNull();
    await expect(s.get('users/u/a.png')).rejects.toThrow(/not found/);
  });

  it('download streams the blob to a file', async () => {
    const { s } = make();
    await s.put('k', Buffer.from('hello'), 'text/plain');
    const dir = await mkdtemp(path.join(tmpdir(), 'blob-'));
    try {
      await s.download('k', path.join(dir, 'f'));
      expect(await readFile(path.join(dir, 'f'), 'utf8')).toBe('hello');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('signed GET links are scoped to ONE pathname and expire', async () => {
    const { s, calls } = make();
    const before = Date.now();
    expect(await s.signedUrl('users/u/a.png')).toBe('https://signed/get/users/u/a.png');
    const tok = calls.find((c) => c.fn === 'issueSignedToken')!.args[0] as { pathname: string; operations: string[]; validUntil: number };
    expect(tok).toMatchObject({ pathname: 'users/u/a.png', operations: ['get'] });
    expect(tok.validUntil).toBeGreaterThanOrEqual(before + 900_000);
    expect(tok.validUntil).toBeLessThan(before + 901_000);
    expect(await s.internalUrl('x', 60)).toBe('https://signed/get/x');
  });

  it('upload target: presigned PUT locked to the key, the type and the max size', async () => {
    const { s, calls } = make();
    const t = await s.presignUpload('uploads/u/1.png', 'image/png', 5000);
    expect(t).toEqual({ url: 'https://signed/put/uploads/u/1.png', fields: {}, method: 'PUT', headers: { 'x-content-type': 'image/png' } });
    expect(calls.find((c) => c.fn === 'issueSignedToken')!.args[0]).toMatchObject({ pathname: 'uploads/u/1.png', operations: ['put'], allowedContentTypes: ['image/png'], maximumSizeInBytes: 5000 });
    expect(calls.find((c) => c.fn === 'presignUrl')!.args[0]).toMatchObject({ access: 'private', operation: 'put', addRandomSuffix: false, allowOverwrite: false, allowedContentTypes: ['image/png'], maximumSizeInBytes: 5000 });
  });

  it('ping: a missing probe key means the store is reachable; other errors mean down', async () => {
    const { s } = make();
    expect(await s.ping()).toBe(true);
    const broken = createBlobStorage({ token: 't', signedUrlTtlSeconds: 1, sdk: { head: async () => { throw new Error('ECONNREFUSED'); } } as unknown as BlobSdk });
    expect(await broken.ping()).toBe(false);
    await expect(broken.head('x')).rejects.toThrow('ECONNREFUSED');
    await s.ensureBucket();
    s.destroy();
    expect(s.bucket).toBe('vercel-blob');
  });
});
