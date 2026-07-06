/** code-size.js — artifact size: generated module vs the n3 package. */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function sizeOf(label, files) {
  const buf = Buffer.concat(files.map((f) => fs.readFileSync(f)));
  return { label, files: files.length, rawKiB: +(buf.length / 1024).toFixed(1), gzipKiB: +(zlib.gzipSync(buf, { level: 9 }).length / 1024).toFixed(1) };
}

const gen = sizeOf('shuttle generated/turtle12.js (parser+push+serializer+runtime, dependency-free)', [
  path.join(HERE, '../packages/gen-js/generated/turtle12.js'),
]);

const n3dir = path.join(HERE, 'node_modules/n3');
const n3ver = JSON.parse(fs.readFileSync(path.join(n3dir, 'package.json'))).version;
const n3files = fs.readdirSync(path.join(n3dir, 'lib')).filter((f) => f.endsWith('.js'))
  .map((f) => path.join(n3dir, 'lib', f));
const n3 = sizeOf(`n3@${n3ver} lib/*.js (parser+writer+store+runtime deps excluded)`, n3files);

// n3 runtime deps (queue-microtask, readable-stream tree) — count for honesty
let depBytes = 0;
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) depBytes += fs.statSync(p).size;
  }
};
for (const dep of fs.readdirSync(path.join(HERE, 'node_modules'))) {
  if (dep === 'n3' || dep.startsWith('.')) continue;
  walk(path.join(HERE, 'node_modules', dep));
}

console.log(JSON.stringify({ shuttle: gen, n3, n3TransitiveDepJsKiB: +(depBytes / 1024).toFixed(1) }, null, 2));
