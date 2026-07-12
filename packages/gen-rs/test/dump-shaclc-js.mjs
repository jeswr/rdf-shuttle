/**
 * dump-shaclc-js.mjs — produce the SAME canonical SHACL-CS dumps from the
 * gen-js artifacts that the Rust harness's `shaclc` subcommand produces
 * from the gen-rs artifacts, so a plain byte diff proves quad-set identity
 * (deterministic blank-node allocation on both sides) plus identical
 * accept/reject behaviour per profile.
 *
 * usage: node dump-shaclc-js.mjs <shaclc-conformance-root> <out-dir>
 */

import fs from 'node:fs';
import path from 'node:path';
import * as strict from '../../gen-js/generated/shaclc12.js';
import * as ext from '../../gen-js/generated/shaclc12ext.js';

const [root, outDir] = process.argv.slice(2);
if (!root || !outDir) {
  console.error('usage: node dump-shaclc-js.mjs <shaclc-conformance-root> <out-dir>');
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });

const BASE = 'urn:x-base:default';
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

/** One-shot parse -> {ok, text}: canonical dump or the stable REJECT line. */
function oneShot(mod, doc) {
  try {
    return { ok: true, text: dump(mod.parseToQuads(doc, { baseIRI: BASE }).quads) };
  } catch (e) {
    return { ok: false, text: `REJECT ${e.code || '-'}\n` };
  }
}

/** Parse -> residual print -> reparse: {ok, ser, re} or the verdict line. */
function writeShot(mod, doc) {
  let got;
  try {
    got = mod.parseToQuads(doc, { baseIRI: BASE });
  } catch (e) {
    return { ok: false, text: `REJECT ${e.code || '-'}\n` };
  }
  let ser;
  try {
    ser = mod.writeQuads(got.quads, { baseIRI: BASE, prefixes: got.prefixes });
  } catch (e) {
    return { ok: false, text: `RESIDUAL ${e.residual ? e.residual.length : '?'} missing=${e.missing !== null && e.missing !== undefined}\n` };
  }
  try {
    const re = mod.parseToQuads(ser, { baseIRI: BASE });
    return { ok: true, ser, re: dump(re.quads) };
  } catch (e) {
    return { ok: false, text: `REPARSE-FAIL ${e.code || '-'}\n${ser}` };
  }
}

/** Chunked push parse (7 UTF-16 units; any chunking must agree). */
function pushShot(mod, doc) {
  try {
    const quads = [];
    const p = mod.createPushParser({ baseIRI: BASE, onQuad: (q) => quads.push(q) });
    for (let i = 0; i < doc.length; i += 7) p.push(doc.slice(i, i + 7));
    p.end();
    return { ok: true, text: dump(quads) };
  } catch (e) {
    return { ok: false, text: `REJECT ${e.code || '-'}\n` };
  }
}

const list = (sub) => fs.readdirSync(path.join(root, sub))
  .filter((f) => f.endsWith('.shaclc'))
  .map((f) => f.replace(/\.shaclc$/, ''))
  .sort();
const read = (sub, name) => fs.readFileSync(path.join(root, sub, `${name}.shaclc`), 'utf8');
const w = (f, c) => fs.writeFileSync(path.join(outDir, f), c);

const valid = list('valid');
const rdf12 = list('rdf12');
const extended = list('extended');
const negative = list('negative');
if (valid.length < 44) throw new Error(`expected >= 44 valid pairs, found ${valid.length}`);
if (extended.length < 14) throw new Error(`expected >= 14 extended pairs, found ${extended.length}`);
if (rdf12.length < 8) throw new Error(`expected >= 8 rdf12 pairs, found ${rdf12.length}`);
if (negative.length < 6) throw new Error(`expected >= 6 negative cases, found ${negative.length}`);

let files = 0;
for (const [sub, names] of [['valid', valid], ['rdf12', rdf12]]) {
  for (const name of names) {
    const doc = read(sub, name);
    const s = oneShot(strict, doc);
    const e = oneShot(ext, doc);
    const ps = pushShot(strict, doc);
    const pe = pushShot(ext, doc);
    for (const [r, label] of [[s, 'strict'], [e, 'ext'], [ps, 'pushs'], [pe, 'pushe']]) {
      if (!r.ok) throw new Error(`${sub}/${name}: ${label} parse failed: ${r.text}`);
    }
    const ws = writeShot(strict, doc);
    const we = writeShot(ext, doc);
    if (!ws.ok) throw new Error(`${sub}/${name}: strict write failed: ${ws.text}`);
    if (!we.ok) throw new Error(`${sub}/${name}: ext write failed: ${we.text}`);
    w(`${sub}-${name}.strict.txt`, s.text);
    w(`${sub}-${name}.ext.txt`, e.text);
    w(`${sub}-${name}.pushs.txt`, ps.text);
    w(`${sub}-${name}.pushe.txt`, pe.text);
    w(`${sub}-${name}.sers.txt`, ws.ser);
    w(`${sub}-${name}.resers.txt`, ws.re);
    w(`${sub}-${name}.sere.txt`, we.ser);
    w(`${sub}-${name}.resere.txt`, we.re);
    files += 8;
  }
}
for (const name of extended) {
  const doc = read('extended', name);
  const e = oneShot(ext, doc);
  const pe = pushShot(ext, doc);
  const s = oneShot(strict, doc);
  if (!e.ok) throw new Error(`extended/${name}: ext parse failed: ${e.text}`);
  if (!pe.ok) throw new Error(`extended/${name}: ext push failed: ${pe.text}`);
  if (s.ok) throw new Error(`extended/${name}: STRICT accepted an extended fixture (enforcement leak)`);
  const we = writeShot(ext, doc);
  if (!we.ok) throw new Error(`extended/${name}: ext write failed: ${we.text}`);
  w(`extended-${name}.ext.txt`, e.text);
  w(`extended-${name}.pushe.txt`, pe.text);
  w(`extended-${name}.strict.txt`, s.text);
  w(`extended-${name}.sere.txt`, we.ser);
  w(`extended-${name}.resere.txt`, we.re);
  files += 5;
}
for (const name of negative) {
  const doc = read('negative', name);
  const s = oneShot(strict, doc);
  const e = oneShot(ext, doc);
  if (s.ok) throw new Error(`negative/${name}: accepted by strict`);
  if (e.ok) throw new Error(`negative/${name}: accepted by ext`);
  w(`negative-${name}.strict.txt`, s.text);
  w(`negative-${name}.ext.txt`, e.text);
  files += 2;
}
console.log(`dumped ${files} shaclc files (${valid.length} valid, ${rdf12.length} rdf12, ${extended.length} extended, ${negative.length} negative) to ${outDir}`);
