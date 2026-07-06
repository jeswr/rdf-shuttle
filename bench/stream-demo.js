/**
 * stream-demo.js [file] — bounded-memory streaming demonstration.
 *
 * Feeds a large corpus through createPushParser via a 64 KiB fs read
 * stream, never holding the document: reports peak RSS, peak carry
 * (bytes retained across chunk boundaries = current statement only),
 * and throughput. Optionally compare: `node stream-demo.js <file> n3`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] || path.join(HERE, 'corpus-large.ttl');
const which = process.argv[3] || 'shuttle';
const bytes = fs.statSync(file).size;

let quads = 0;
let peakRss = 0;
let peakCarry = 0;
const t0 = process.hrtime.bigint();

const sample = () => {
  const r = process.memoryUsage.rss();
  if (r > peakRss) peakRss = r;
};

if (which === 'shuttle') {
  const m = await import('../packages/gen-js/generated/turtle12.js');
  const p = m.createPushParser({ onQuad: () => { quads++; } });
  const stream = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 64 * 1024 });
  let i = 0;
  for await (const chunk of stream) {
    p.push(chunk);
    if (p.pending > peakCarry) peakCarry = p.pending;
    if ((i++ & 15) === 0) sample();
  }
  p.end();
} else {
  const N3 = (await import('n3')).default;
  const parser = new N3.StreamParser();
  const stream = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 64 * 1024 });
  let i = 0;
  parser.on('data', () => { quads++; if ((i++ & 4095) === 0) sample(); });
  await new Promise((resolve, reject) => {
    parser.on('end', resolve);
    parser.on('error', reject);
    stream.pipe(parser);
  });
  peakCarry = -1;
}
sample();

const ms = Number(process.hrtime.bigint() - t0) / 1e6;
console.log(JSON.stringify({
  parser: which,
  file: path.basename(file),
  inputMiB: +(bytes / 1048576).toFixed(1),
  quads,
  seconds: +(ms / 1000).toFixed(1),
  quadsPerSec: Math.round(quads / (ms / 1000)),
  MBperSec: +(bytes / 1048576 / (ms / 1000)).toFixed(2),
  peakRssMiB: +(peakRss / 1048576).toFixed(1),
  peakCarryBytes: peakCarry,
}));
