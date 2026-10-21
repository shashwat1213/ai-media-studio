// Vercel function entry: /api/* -> the Express app (prefix stripped, like nginx in Docker).
// Background jobs keep running after the response through waitUntil (@vercel/functions).
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.FFMPEG_PATH ??= path.join(here, 'bin', 'ffmpeg');
process.env.FFPROBE_PATH ??= path.join(here, 'bin', 'ffprobe');

const require = createRequire(path.join(here, 'api', 'package.json'));
const { waitUntil } = require('@vercel/functions');

let appPromise;
function getApp() {
  appPromise ??= import('./api/dist/serverless.js').then((m) => m.createServerlessApp((p) => waitUntil(p), { jobTimeoutMs: 280_000 }));
  return appPromise;
}

export default async function handler(req, res) {
  const app = await getApp();
  // /api/auth/me -> /auth/me
  req.url = req.url.replace(/^\/api(?=\/|$|\?)/, '') || '/';
  return app(req, res);
}
