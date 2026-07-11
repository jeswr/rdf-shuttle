/**
 * Conformance: the generated SHACL-CS 1.2 parsers against the vendored
 * shaclc-js fixture corpus + the new rdf12 pairs (tests/conformance/shaclc/):
 *
 *  1. strict + extended artifacts parse every valid pair to a graph
 *     isomorphic with the .ttl oracle (parsed by the generated turtle12
 *     module — the toolchain dogfoods its own Turtle 1.2 parser, which
 *     also covers the rdf12 pairs' triple terms / dir-lang literals);
 *  2. the extended artifact parses every extended pair (including the two
 *     leak cases isolating '% … %' escapes and trailing turtle statements);
 *  3. the STRICT artifact rejects every extended fixture — including the
 *     constructs shaclc-js 2.x wrongly accepts with extendedSyntax:false
 *     (the strict-mode enforcement leak, fixed here by construction:
 *     the extended alternatives are not in the strict parse tables);
 *  4. negative cases are rejected by both artifacts;
 *  5. the push parser (whole-buffer fallback for the document-shaped start
 *     production) agrees with the one-shot parse;
 *  6. baseIRI-relative resolution matches shaclc-parse's documented
 *     behaviour.
 *
 * The expected .ttl sides of the vendored corpus resolve relative IRIs
 * against urn:x-base:default — shaclc-parse's default base, passed
 * explicitly here (the grammar itself does not bake it in).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as strict from '../generated/shaclc12.js';
import * as ext from '../generated/shaclc12ext.js';
import { parseToQuads as parseTurtle } from '../generated/turtle12.js';
import { isIsomorphic } from './iso.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONF = path.join(HERE, '..', '..', '..', 'tests', 'conformance', 'shaclc');
const BASE = 'urn:x-base:default';

const pairsIn = (dir) => fs.readdirSync(path.join(CONF, dir))
  .filter((f) => f.endsWith('.shaclc'))
  .map((f) => f.replace(/\.shaclc$/, ''))
  .sort();

const read = (dir, name, extn) => fs.readFileSync(path.join(CONF, dir, `${name}.${extn}`), 'utf8');

const valid = pairsIn('valid');
const extended = pairsIn('extended');
const rdf12 = pairsIn('rdf12');
const negative = pairsIn('negative');

assert.ok(valid.length >= 44, `expected >= 44 valid pairs, found ${valid.length}`);
assert.ok(extended.length >= 14, `expected >= 14 extended pairs (12 vendored + 2 leak cases), found ${extended.length}`);
assert.ok(rdf12.length >= 8, `expected >= 8 rdf12 pairs, found ${rdf12.length}`);
assert.ok(negative.length >= 6, `expected >= 6 negative cases, found ${negative.length}`);

function expectQuads(dir, name) {
  return parseTurtle(read(dir, name, 'ttl'), { baseIRI: BASE }).quads;
}

/* ---- 1. valid corpus: BOTH artifacts, graph isomorphism ---- */

for (const name of valid) {
  const doc = read('valid', name, 'shaclc');
  for (const [label, mod] of [['strict', strict], ['extended', ext]]) {
    test(`valid/${name}: ${label} parse ≅ .ttl`, () => {
      const got = mod.parseToQuads(doc, { baseIRI: BASE });
      const expected = expectQuads('valid', name);
      assert.ok(isIsomorphic(got.quads, expected),
        `graphs differ\n--- got ---\n${dump(got.quads)}\n--- expected ---\n${dump(expected)}`);
    });
  }
}

/* ---- 2+3. extended corpus: extended accepts, strict REJECTS ---- */

const JISON_PREFIXES = {
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  sh: 'http://www.w3.org/ns/shacl#',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
  owl: 'http://www.w3.org/2002/07/owl#',
  ex: 'http://example.org/test#',
};

for (const name of extended) {
  const doc = read('extended', name, 'shaclc');
  test(`extended/${name}: extended parse ≅ .ttl`, () => {
    const got = ext.parseToQuads(doc, { baseIRI: BASE });
    const expected = expectQuads('extended', name);
    assert.ok(isIsomorphic(got.quads, expected),
      `graphs differ\n--- got ---\n${dump(got.quads)}\n--- expected ---\n${dump(expected)}`);
    assert.deepEqual(got.prefixes, JISON_PREFIXES);
  });
  test(`extended/${name}: STRICT rejects (no enforcement leak)`, () => {
    assert.throws(() => strict.parseToQuads(doc, { baseIRI: BASE }));
  });
}

/* ---- rdf12 pairs: part of the STRICT (1.2) language, both artifacts ---- */

for (const name of rdf12) {
  const doc = read('rdf12', name, 'shaclc');
  for (const [label, mod] of [['strict', strict], ['extended', ext]]) {
    test(`rdf12/${name}: ${label} parse ≅ .ttl`, () => {
      const got = mod.parseToQuads(doc, { baseIRI: BASE });
      const expected = expectQuads('rdf12', name);
      assert.ok(isIsomorphic(got.quads, expected),
        `graphs differ\n--- got ---\n${dump(got.quads)}\n--- expected ---\n${dump(expected)}`);
    });
  }
}

/* ---- 4. negatives: rejected by BOTH artifacts ---- */

for (const name of negative) {
  const doc = read('negative', name, 'shaclc');
  test(`negative/${name}: rejected by strict and extended`, () => {
    assert.throws(() => strict.parseToQuads(doc, { baseIRI: BASE }), `strict accepted negative/${name}`);
    assert.throws(() => ext.parseToQuads(doc, { baseIRI: BASE }), `extended accepted negative/${name}`);
  });
}

test('negative: undeclared prefix raises the stable error code', () => {
  assert.throws(
    () => strict.parseToQuads('shape nope:S {\n}\n', { baseIRI: BASE }),
    (e) => e instanceof strict.ShuttleSyntaxError && e.code === 'UNDECLARED_PREFIX'
  );
});

/* ---- 5. push parser (whole-buffer fallback) ---- */

test('push parser (7-byte chunks) ≅ one-shot on complex1', () => {
  const doc = read('valid', 'complex1', 'shaclc');
  const expected = ext.parseToQuads(doc, { baseIRI: BASE });
  const quads = [];
  const p = ext.createPushParser({ onQuad: (q) => quads.push(q), baseIRI: BASE });
  for (let i = 0; i < doc.length; i += 7) p.push(doc.slice(i, i + 7));
  const res = p.end();
  assert.ok(isIsomorphic(quads, expected.quads), `chunked parse differs (${quads.length} vs ${expected.quads.length})`);
  assert.equal(res.base, expected.base);
});

/* ---- 6. baseIRI resolution (shaclc-parse behaviour) ---- */

test('relative IRIs resolve against options.baseIRI', () => {
  const doc = 'PREFIX ex: <http://example.org/>\n\nshape <#MyShape> -> </MyClass> {\n}\n';
  const got = strict.parseToQuads(doc, { baseIRI: 'http://www.jeswr.org/humanShape' });
  const expected = parseTurtle(`
    <http://www.jeswr.org/humanShape#MyShape> a <http://www.w3.org/ns/shacl#NodeShape> ;
      <http://www.w3.org/ns/shacl#targetClass> <http://www.jeswr.org/MyClass> .
    <http://www.jeswr.org/humanShape> a <http://www.w3.org/2002/07/owl#Ontology> .
  `).quads;
  assert.ok(isIsomorphic(got.quads, expected), dump(got.quads));
});

/* ---- print mode: honest stub until the residual serializer lands ---- */

test('print mode: parse-only artifact throws with a clear message', () => {
  assert.throws(() => strict.writeQuads([]), /print mode not generated/);
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
