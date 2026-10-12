// Fails the build if the JS the browser downloads on first load grows past a budget.
// Run after `vite build`:  node scripts/check-bundle-size.mjs
// Why: bundle size directly drives load time on slow phones/networks, and it only
// ever grows unless something stops it. A CI budget makes growth a conscious decision.
import { readFileSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';

const BUDGET_KB = Number(process.env.BUNDLE_BUDGET_KB ?? 120); // gzip, initial JS for first page load
const dist = path.resolve(import.meta.dirname, '..', 'dist');
const html = readFileSync(path.join(dist, 'index.html'), 'utf8');

// Initial load = the entry <script> + any <link rel="modulepreload"> Vite injects into index.html.
const initial = [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.js)"/g)].map((m) => m[1]);
const all = readdirSync(path.join(dist, 'assets')).filter((f) => f.endsWith('.js'));

const gz = (file) => gzipSync(readFileSync(path.join(dist, file))).length / 1024;
const initialKb = initial.reduce((sum, f) => sum + gz(f), 0);
const totalKb = all.reduce((sum, f) => sum + gz(path.join('assets', f)), 0);

console.log(`Initial JS (gzip): ${initialKb.toFixed(1)} kB  [budget ${BUDGET_KB} kB]  — ${initial.length} file(s)`);
console.log(`All JS chunks (gzip): ${totalKb.toFixed(1)} kB across ${all.length} chunks (lazy-loaded per route)`);

if (initialKb > BUDGET_KB) {
  console.error(`✖ Initial JS is over budget by ${(initialKb - BUDGET_KB).toFixed(1)} kB`);
  process.exit(1);
}
console.log('✔ within budget');
