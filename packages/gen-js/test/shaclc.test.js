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

/* ================================================================
 * 7. Print direction — the residual-consumption serializer.
 *
 * Laws exercised (spec/SHUTTLE.md §8):
 *  - L1/L2 on the whole corpus: parse ∘ print ∘ parse = parse, by graph
 *    isomorphism (the parse direction is independently validated against
 *    the .ttl oracles above, so it is the trusted side);
 *  - partiality as the expressibility verdict: graphs carrying constructs
 *    outside a profile leave a non-empty residual instead of printing
 *    (strict rejects by construction what only the extended layer or no
 *    layer at all can absorb);
 *  - the print{}-default inversion and the never-backward oracle.
 * ================================================================ */

const RTBASE = 'urn:x-base:default';

function roundTrip(mod, quads, prefixes) {
  const text = mod.writeQuads(quads, { baseIRI: RTBASE, prefixes });
  return { text, quads: mod.parseToQuads(text, { baseIRI: RTBASE }).quads };
}

// valid + rdf12 pairs are strict-language: BOTH artifacts must round-trip them
for (const [dir, names] of [['valid', valid], ['rdf12', rdf12]]) {
  for (const name of names) {
    const doc = read(dir, name, 'shaclc');
    for (const [label, mod] of [['strict', strict], ['extended', ext]]) {
      test(`${dir}/${name}: ${label} parse∘print∘parse ≅ parse`, () => {
        const got = mod.parseToQuads(doc, { baseIRI: RTBASE });
        const rt = roundTrip(mod, got.quads, got.prefixes);
        assert.ok(isIsomorphic(rt.quads, got.quads),
          `round-trip differs\n--- printed ---\n${rt.text}\n--- got ---\n${dump(rt.quads)}\n--- expected ---\n${dump(got.quads)}`);
      });
    }
  }
}

// extended pairs: the extended artifact round-trips them (its annotation /
// '%…%' / trailing-turtle layers are the declared guard-free fallbacks)
for (const name of extended) {
  const doc = read('extended', name, 'shaclc');
  test(`extended/${name}: extended parse∘print∘parse ≅ parse`, () => {
    const got = ext.parseToQuads(doc, { baseIRI: RTBASE });
    const rt = roundTrip(ext, got.quads, got.prefixes);
    assert.ok(isIsomorphic(rt.quads, got.quads),
      `round-trip differs\n--- printed ---\n${rt.text}\n--- got ---\n${dump(rt.quads)}\n--- expected ---\n${dump(got.quads)}`);
  });
}

// the two strict-mode leak cases: the graphs need the extended layer, so the
// STRICT printer must return a residual verdict, never a lossy document
for (const name of ['leak-percent-escape-only', 'leak-trailing-turtle-only']) {
  test(`extended/${name}: STRICT print yields a residual verdict`, () => {
    const got = ext.parseToQuads(read('extended', name, 'shaclc'), { baseIRI: RTBASE });
    assert.throws(
      () => strict.writeQuads(got.quads, { baseIRI: RTBASE, prefixes: got.prefixes }),
      (e) => e instanceof strict.ShuttleResidualError && e.residual.length > 0
    );
    const v = strict.printWithResidual(got.quads, { baseIRI: RTBASE, prefixes: got.prefixes });
    assert.ok(v.residual.length > 0, 'expected non-empty residual');
    // the printable part is still valid strict SHACL-CS
    assert.doesNotThrow(() => strict.parseToQuads(v.text, { baseIRI: RTBASE }));
  });
}

/* ---- showpiece 1: the oracle never runs backward ---- */

for (const [label, mod] of [['strict', strict], ['extended', ext]]) {
  test(`print: sh:class xsd:string prints as class=, never as a bare IRI (${label})`, () => {
    const doc = 'shape <s> {\n  <p> class=xsd:string .\n}\n';
    const got = mod.parseToQuads(doc, { baseIRI: RTBASE });
    const text = mod.writeQuads(got.quads, { baseIRI: RTBASE, prefixes: got.prefixes });
    assert.match(text, /class=xsd:string/);
    const rt = mod.parseToQuads(text, { baseIRI: RTBASE });
    assert.ok(isIsomorphic(rt.quads, got.quads), text);
  });
}

test('print: sh:datatype xsd:string prints as the bare oracle IRI', () => {
  const doc = 'shape <s> {\n  <p> xsd:string .\n}\n';
  const got = strict.parseToQuads(doc, { baseIRI: RTBASE });
  const text = strict.writeQuads(got.quads, { baseIRI: RTBASE, prefixes: got.prefixes });
  assert.match(text, /<urn:p> xsd:string/);
  assert.doesNotMatch(text, /datatype=/);
});

/* ---- showpiece 2: conditional-emit inversion (print{} defaults) ---- */

test('print: lone sh:maxCount regenerates [0..1] via print{} defaults', () => {
  const doc = 'shape <s> {\n  <p> xsd:string [0..1] .\n}\n';
  const got = strict.parseToQuads(doc, { baseIRI: RTBASE });
  // parse suppressed minCount (when int(mn) > 0), so only maxCount is present
  assert.ok(!got.quads.some((q) => q.predicate.value.endsWith('minCount')));
  const text = strict.writeQuads(got.quads, { baseIRI: RTBASE, prefixes: got.prefixes });
  assert.match(text, /\[0\.\.1\]/);
  const rt = strict.parseToQuads(text, { baseIRI: RTBASE });
  assert.ok(isIsomorphic(rt.quads, got.quads), text);
});

test('print: an explicit sh:minCount 0 quad is refused (guard-inverted), not dropped', () => {
  const { namedNode, literal, blankNode, quad } = strict.factory;
  const XSD_INT = namedNode('http://www.w3.org/2001/XMLSchema#integer');
  const SH = 'http://www.w3.org/ns/shacl#';
  const ps = blankNode('ps');
  const quads = [
    quad(namedNode(RTBASE), namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), namedNode('http://www.w3.org/2002/07/owl#Ontology')),
    quad(namedNode('urn:s'), namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), namedNode(SH + 'NodeShape')),
    quad(namedNode('urn:s'), namedNode(SH + 'property'), ps),
    quad(ps, namedNode(SH + 'path'), namedNode('urn:p')),
    quad(ps, namedNode(SH + 'minCount'), literal('0', XSD_INT)),
  ];
  const v = strict.printWithResidual(quads, { baseIRI: RTBASE });
  assert.equal(v.residual.length, 1);
  assert.ok(v.residual[0].predicate.value === SH + 'minCount');
});

/* ---- showpiece 3: partiality as the expressibility decision procedure ---- */

test('print: an sh:sparql constraint leaves exactly that quad as strict residual', () => {
  const { namedNode, blankNode, literal, quad } = strict.factory;
  const SH = 'http://www.w3.org/ns/shacl#';
  const ps = blankNode('ps');
  const quads = [
    quad(namedNode(RTBASE), namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), namedNode('http://www.w3.org/2002/07/owl#Ontology')),
    quad(namedNode('urn:s'), namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), namedNode(SH + 'NodeShape')),
    quad(namedNode('urn:s'), namedNode(SH + 'property'), ps),
    quad(ps, namedNode(SH + 'path'), namedNode('urn:p')),
    quad(ps, namedNode(SH + 'sparql'), literal('ASK {}')),
  ];
  const v = strict.printWithResidual(quads, { baseIRI: RTBASE });
  assert.equal(v.residual.length, 1);
  assert.equal(v.residual[0].predicate.value, SH + 'sparql');
  // ... while the EXTENDED profile absorbs it via the '% … %' escape
  const text = ext.writeQuads(quads, { baseIRI: RTBASE });
  assert.match(text, /%/);
  assert.ok(isIsomorphic(ext.parseToQuads(text, { baseIRI: RTBASE }).quads, quads));
});

test('print: a shared (multiply-referenced) blank node is not expressible', () => {
  const { namedNode, blankNode, quad } = ext.factory;
  const SH = 'http://www.w3.org/ns/shacl#';
  const ps = blankNode('shared');
  const quads = [
    quad(namedNode(RTBASE), namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), namedNode('http://www.w3.org/2002/07/owl#Ontology')),
    quad(namedNode('urn:s'), namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), namedNode(SH + 'NodeShape')),
    quad(namedNode('urn:s'), namedNode(SH + 'property'), ps),
    quad(namedNode('urn:t'), namedNode(SH + 'property'), ps), // second reference
    quad(ps, namedNode(SH + 'path'), namedNode('urn:p')),
  ];
  // even the extended profile has no blank-node labels: residual in both
  for (const mod of [strict, ext]) {
    const v = mod.printWithResidual(quads, { baseIRI: RTBASE });
    assert.ok(v.residual.length >= 1, 'expected a residual for the shared blank');
  }
});

test('print: a graph without the document owl:Ontology quad is not printable', () => {
  const { namedNode, quad } = strict.factory;
  const quads = [
    quad(namedNode('urn:s'), namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), namedNode('http://www.w3.org/ns/shacl#NodeShape')),
  ];
  assert.throws(
    () => strict.writeQuads(quads, { baseIRI: RTBASE }),
    (e) => e instanceof strict.ShuttleResidualError && e.missing !== null
  );
});

/* ---- writer API parity ---- */

test('createWriter batches to the same document as writeQuads', () => {
  const got = strict.parseToQuads(read('valid', 'complex1', 'shaclc'), { baseIRI: RTBASE });
  const w = strict.createWriter({ baseIRI: RTBASE, prefixes: got.prefixes });
  for (const q of got.quads) w.quad(q);
  assert.equal(w.end(), strict.writeQuads(got.quads, { baseIRI: RTBASE, prefixes: got.prefixes }));
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
