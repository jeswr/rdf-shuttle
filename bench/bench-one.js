/**
 * bench-one.js <parser: shuttle|n3> <corpus file> [runs]
 *
 * One parser per process (GC/JIT isolation on the shared 2-core box).
 * Whole-string parse, quad-counting callback, 2 warmups + N timed runs.
 * Prints JSON: { parser, version, file, bytes, quads, runsMs, bestMs, medianMs }
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [, , which, file, runsArg] = process.argv;
const runs = parseInt(runsArg || '7', 10);
const text = fs.readFileSync(file, 'utf8');
const bytes = Buffer.byteLength(text);

let parseOnce;
let version;

if (which === 'shuttle') {
  // count-only callback: the generated parser's native push interface
  const m = await import('../packages/gen-js/generated/turtle12.js');
  version = JSON.parse(fs.readFileSync(path.join(HERE, '../packages/gen-js/package.json'))).version;
  parseOnce = () => {
    let n = 0;
    m.parse(text, { onQuad: () => { n++; } });
    return n;
  };
} else if (which === 'shuttle-array') {
  // materialize a quad array — apples-to-apples with N3's sync API
  const m = await import('../packages/gen-js/generated/turtle12.js');
  version = JSON.parse(fs.readFileSync(path.join(HERE, '../packages/gen-js/package.json'))).version;
  parseOnce = () => {
    const quads = [];
    m.parse(text, { onQuad: (q) => { quads.push(q); } });
    return quads.length;
  };
} else if (which === 'n3') {
  // N3's synchronous path (callback form defers via scheduling since 1.x)
  const N3 = (await import('n3')).default;
  version = JSON.parse(fs.readFileSync(path.join(HERE, 'node_modules/n3/package.json'))).version;
  parseOnce = () => new N3.Parser().parse(text).length;
} else {
  console.error('usage: bench-one.js <shuttle|shuttle-array|n3> <file> [runs]');
  process.exit(2);
}

// warmup
let quads = 0;
for (let i = 0; i < 2; i++) quads = parseOnce();

const runsMs = [];
for (let i = 0; i < runs; i++) {
  const t0 = process.hrtime.bigint();
  const n = parseOnce();
  const t1 = process.hrtime.bigint();
  if (n !== quads) throw new Error(`quad count changed: ${n} vs ${quads}`);
  runsMs.push(Number(t1 - t0) / 1e6);
}
const sorted = [...runsMs].sort((a, b) => a - b);
const bestMs = sorted[0];
const medianMs = sorted[Math.floor(sorted.length / 2)];

console.log(JSON.stringify({
  parser: which, version, file: path.basename(file), bytes, quads,
  runsMs: runsMs.map((x) => +x.toFixed(1)),
  bestMs: +bestMs.toFixed(1),
  medianMs: +medianMs.toFixed(1),
  bestQuadsPerSec: Math.round(quads / (bestMs / 1000)),
  bestMBperSec: +(bytes / 1048576 / (bestMs / 1000)).toFixed(2),
}));
