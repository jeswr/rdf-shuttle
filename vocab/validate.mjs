#!/usr/bin/env node
// Gate: vocab/shuttle.ttl + vocab/shuttle-shapes.ttl well-formedness.
//
//  1. Both files parse as Turtle (strict, via N3.js).
//  2. Every sh:sparql sh:select string in the shapes is valid SPARQL
//     (sparqljs), with the sh:declare'd prefixes prepended per the SHACL
//     spec's prefix-injection rule.
//  3. Full SHACL validation (shacl-engine, core + SHACL-SPARQL): the shapes
//     graph validates the ontology graph AND its own graph (meta-shape
//     self-application, RFC 0001 closure test 3). Both runs are over the
//     merged closure (ontology ∪ shapes), since the typing shapes traverse
//     the ontology's rdfs:subClassOf triples — exactly the "validate the
//     merged import closure" discipline of the RFC.
//
// Run from vocab/: npm install && npm run validate

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Parser, Store, DataFactory } from 'n3';
import SparqlParser from 'sparqljs';
import rdfDataModel from '@rdfjs/data-model';
import rdfDataset from '@rdfjs/dataset';
import Validator from 'shacl-engine/Validator.js';
import { validations as sparqlValidations, targetResolvers } from 'shacl-engine/sparql.js';

const here = dirname(fileURLToPath(import.meta.url));
const SH = 'http://www.w3.org/ns/shacl#';
let failures = 0;
const ok = (msg) => console.log(`ok   ${msg}`);
const bad = (msg) => { failures++; console.error(`FAIL ${msg}`); };

function parseTurtle(rel) {
  const text = readFileSync(join(here, rel), 'utf8');
  const parser = new Parser({ baseIRI: 'https://w3id.org/shuttle/vocab', format: 'text/turtle' });
  const quads = parser.parse(text); // throws on syntax error
  ok(`${rel} parses as Turtle (${quads.length} triples)`);
  return quads;
}

let vocabQuads, shapesQuads;
try { vocabQuads = parseTurtle('shuttle.ttl'); } catch (e) { bad(`shuttle.ttl parse: ${e.message}`); }
try { shapesQuads = parseTurtle('shuttle-shapes.ttl'); } catch (e) { bad(`shuttle-shapes.ttl parse: ${e.message}`); }
if (failures) process.exit(1);

// --- gate 2: SPARQL constraint syntax --------------------------------------
const store = new Store(shapesQuads);
const declares = [];
for (const q of store.getQuads(null, DataFactory.namedNode(SH + 'declare'), null)) {
  const node = q.object;
  const prefix = store.getObjects(node, DataFactory.namedNode(SH + 'prefix'), null)[0];
  const ns = store.getObjects(node, DataFactory.namedNode(SH + 'namespace'), null)[0];
  if (prefix && ns) declares.push(`PREFIX ${prefix.value}: <${ns.value}>`);
}
const prologue = declares.join('\n') + '\n';
const sparqlParser = new SparqlParser.Parser();
const selects = store.getQuads(null, DataFactory.namedNode(SH + 'select'), null);
let sparqlOk = 0;
for (const q of selects) {
  const query = prologue + q.object.value.replaceAll('$this', '?this');
  try { sparqlParser.parse(query); sparqlOk++; }
  catch (e) { bad(`sh:select syntax: ${e.message.split('\n')[0]}`); }
}
if (sparqlOk === selects.length) ok(`all ${selects.length} sh:sparql constraints are valid SPARQL`);

// --- gate 3: SHACL validation (core + SHACL-SPARQL) ------------------------
const toDataset = (...quadArrays) => {
  const ds = rdfDataset.dataset();
  for (const quads of quadArrays) for (const q of quads) ds.add(q);
  return ds;
};
const shapesDataset = toDataset(shapesQuads);
const validator = new Validator(shapesDataset, {
  factory: rdfDataModel,
  validations: sparqlValidations,
  targetResolvers,
});

for (const [label, data] of [
  ['ontology closure (mod:shu-ontology ∪ mod:shu-shapes)', toDataset(vocabQuads, shapesQuads)],
  ['shapes self-application (mod:shu-shapes ∪ mod:shu-ontology)', toDataset(shapesQuads, vocabQuads)],
]) {
  const report = await validator.validate({ dataset: data });
  if (report.conforms) ok(`SHACL (core + SPARQL): ${label} conforms`);
  else {
    bad(`SHACL (core + SPARQL): ${label} does NOT conform:`);
    for (const r of report.results) {
      const msg = r.message?.map((m) => m.value).join('; ');
      console.error(`     - [${r.severity?.value?.split('#')[1]}] focus=${r.focusNode?.value ?? r.focusNode?.terms?.map(t => t.value)} :: ${msg}`);
    }
  }
}

process.exit(failures ? 1 : 0);
