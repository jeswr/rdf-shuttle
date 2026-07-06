/**
 * Conformance: the generated turtle12 parser + serializer against the
 * hand-authored oracle pairs (tests/conformance/README.md):
 *
 *  1. parser obligation: parse(.ttl) ≅ parse(.nt)   (graph isomorphism)
 *  2. round trip (L1/L2): parse(write(parse(.ttl))) ≅ parse(.nt),
 *     with and without prefix abbreviation;
 *  3. streaming: the push parser fed 7-byte chunks produces the same graph;
 *  4. negative: undeclared prefix raises the grammar's stable error code.
 *
 * The .nt oracles are RDF 1.2 N-Triples — a sublanguage of the turtle12
 * grammar, so the same generated parser reads them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseToQuads, createPushParser, writeQuads, ShuttleSyntaxError } from '../generated/turtle12.js';
import { isIsomorphic } from './iso.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONF = path.join(HERE, '..', '..', '..', 'tests', 'conformance');

const pairs = fs.readdirSync(CONF)
  .filter((f) => /^turtle12-eval-\d+\.ttl$/.test(f))
  .map((f) => f.replace(/\.ttl$/, ''))
  .sort();

assert.ok(pairs.length >= 22, `expected >= 22 oracle pairs, found ${pairs.length}`);

for (const name of pairs) {
  const ttl = fs.readFileSync(path.join(CONF, `${name}.ttl`), 'utf8');
  const nt = fs.readFileSync(path.join(CONF, `${name}.nt`), 'utf8');

  test(`${name}: parse(.ttl) ≅ .nt`, () => {
    const got = parseToQuads(ttl);
    const expected = parseToQuads(nt);
    assert.ok(isIsomorphic(got.quads, expected.quads),
      `graphs differ\n--- got ---\n${dump(got.quads)}\n--- expected ---\n${dump(expected.quads)}`);
  });

  test(`${name}: write∘parse round-trips (plain)`, () => {
    const got = parseToQuads(ttl);
    const expected = parseToQuads(nt);
    const out = writeQuads(got.quads);
    const re = parseToQuads(out);
    assert.ok(isIsomorphic(re.quads, expected.quads),
      `round-trip differs\n--- serialized ---\n${out}\n--- reparsed ---\n${dump(re.quads)}`);
  });

  test(`${name}: write∘parse round-trips (abbreviated)`, () => {
    const got = parseToQuads(ttl);
    const expected = parseToQuads(nt);
    const out = writeQuads(got.quads, { prefixes: got.prefixes });
    const re = parseToQuads(out);
    assert.ok(isIsomorphic(re.quads, expected.quads),
      `abbreviated round-trip differs\n--- serialized ---\n${out}`);
  });

  test(`${name}: push parser (7-byte chunks) ≅ one-shot`, () => {
    const expected = parseToQuads(ttl);
    const quads = [];
    const p = createPushParser({ onQuad: (q) => quads.push(q) });
    for (let i = 0; i < ttl.length; i += 7) p.push(ttl.slice(i, i + 7));
    p.end();
    assert.ok(isIsomorphic(quads, expected.quads), `chunked parse differs (${quads.length} vs ${expected.quads.length} quads)`);
  });
}

test('negative: undeclared prefix raises UNDECLARED_PREFIX', () => {
  assert.throws(
    () => parseToQuads('nope:s nope:p nope:o .'),
    (e) => e instanceof ShuttleSyntaxError && e.code === 'UNDECLARED_PREFIX'
  );
});

test('negative: "x"@prefix is a syntax error (keyword wins the LANG_DIR tie)', () => {
  assert.throws(() => parseToQuads('<http://e/s> <http://e/p> "x"@prefix .'));
});

test('negative: bare word is a syntax error', () => {
  assert.throws(() => parseToQuads('<http://e/s> <http://e/p> banana .'));
});

function dump(quads) {
  return quads.map((q) => `${t(q.subject)} ${t(q.predicate)} ${t(q.object)} .`).join('\n');
}
function t(x) {
  switch (x.termType) {
    case 'NamedNode': return `<${x.value}>`;
    case 'BlankNode': return `_:${x.value}`;
    case 'Literal': return `"${x.value}"${x.language ? `@${x.language}${x.direction ? `--${x.direction}` : ''}` : ''}^^<${x.datatype.value}>`;
    case 'Quad': return `<<( ${t(x.subject)} ${t(x.predicate)} ${t(x.object)} )>>`;
    default: return '?';
  }
}
