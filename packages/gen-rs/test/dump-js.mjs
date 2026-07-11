/**
 * dump-js.mjs — produce the SAME canonical per-mode dumps from the gen-js
 * artifact that the Rust harness produces from the gen-rs artifact, so a
 * plain byte diff proves quad-set identity (deterministic blank-node
 * allocation on both sides).
 *
 * usage: node dump-js.mjs <conformance-dir> <out-dir>
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseToQuads, createPushParser, writeQuads } from '../../gen-js/generated/turtle12.js';

const [dir, outDir] = process.argv.slice(2);
if (!dir || !outDir) {
  console.error('usage: node dump-js.mjs <conformance-dir> <out-dir>');
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });

const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';

function termDump(t) {
  switch (t.termType) {
    case 'NamedNode': return `N(${JSON.stringify(t.value)})`;
    case 'BlankNode': return `B(${JSON.stringify(t.value)})`;
    case 'Literal': {
      const dt = t.datatype ? t.datatype.value : XSD_STRING;
      return `L(${JSON.stringify(t.value)},${JSON.stringify(t.language || '')},${JSON.stringify(t.direction || '')},${JSON.stringify(dt)})`;
    }
    case 'Quad': return `T(${termDump(t.subject)} ${termDump(t.predicate)} ${termDump(t.object)})`;
    default: throw new Error(`termDump: ${t.termType}`);
  }
}

const dump = (quads) => quads.map((q) => `${termDump(q.subject)} ${termDump(q.predicate)} ${termDump(q.object)}\n`).join('');

const names = fs.readdirSync(dir)
  .filter((f) => /^turtle12-eval-\d+\.ttl$/.test(f))
  .map((f) => f.replace(/\.ttl$/, ''))
  .sort();

if (names.length < 22) throw new Error(`expected >= 22 oracle pairs, found ${names.length}`);

for (const name of names) {
  const ttl = fs.readFileSync(path.join(dir, `${name}.ttl`), 'utf8');
  const nt = fs.readFileSync(path.join(dir, `${name}.nt`), 'utf8');
  const w = (suffix, content) => fs.writeFileSync(path.join(outDir, `${name}.${suffix}`), content);

  // mode0: oracle .nt
  w('mode0.txt', dump(parseToQuads(nt).quads));
  // mode1: one-shot parse of the .ttl
  const got = parseToQuads(ttl);
  w('mode1.txt', dump(got.quads));
  // mode2: plain round trip
  const ser2 = writeQuads(got.quads);
  w('mode2.txt', dump(parseToQuads(ser2).quads));
  w('ser2.txt', ser2);
  // mode3: abbreviated round trip (parse-order prefixes)
  const ser3 = writeQuads(got.quads, { prefixes: got.prefixes });
  w('mode3.txt', dump(parseToQuads(ser3).quads));
  w('ser3.txt', ser3);
  // mode4: chunked push parse (7 UTF-16 units; any chunking must agree)
  const quads4 = [];
  const p = createPushParser({ onQuad: (q) => quads4.push(q) });
  for (let i = 0; i < ttl.length; i += 7) p.push(ttl.slice(i, i + 7));
  p.end();
  w('mode4.txt', dump(quads4));
}
console.log(`dumped ${names.length} pairs x 5 modes to ${outDir}`);
