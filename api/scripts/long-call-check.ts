// Proves the long-call fix for real: a server that waits 320 s before sending headers.
import http from 'node:http';
import { createLocalPictures } from '../src/modules/director/local-ai.js';

const srv = http.createServer((req, res) => {
  req.resume();
  setTimeout(() => { res.writeHead(200, { 'content-type': 'video/mp4' }); res.end('OK-AFTER-320s'); }, 320_000);
});
srv.listen(0, async () => {
  const port = (srv.address() as { port: number }).port;
  const t0 = Date.now();
  try {
    const c = await createLocalPictures({ baseUrl: `http://127.0.0.1:${port}`, token: 'x' }).clip!({ prompt: 'p', ref: Buffer.from([1]), width: 64, height: 64, seconds: 2 });
    console.log('OK', c.data.toString(), Math.round((Date.now() - t0) / 1000), 's');
  } catch (e) {
    console.log('FAILED after', Math.round((Date.now() - t0) / 1000), 's:', (e as Error).message);
  }
  srv.close();
});
