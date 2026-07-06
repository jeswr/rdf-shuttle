/**
 * gen-corpus.js — deterministic synthetic Turtle corpora.
 *
 *  corpus-ttl11.ttl   (~4 MB)  dense, Turtle 1.1-only — the N3.js head-to-head
 *  corpus-ttl12.ttl   (~1 MB)  RDF 1.2 forms (annotations, triple terms,
 *                              dir-lang tags) — generated-parser-only
 *  corpus-large.ttl   (~64 MB) corpus-ttl11 repeated — bounded-memory demo
 *
 * Shapes mirror real-world dense data: repeated predicates, prefixed names,
 * mixed literal kinds, IRIs, escapes, lists of objects.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// deterministic LCG
let seed = 0xC0FFEE;
const rnd = (n) => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed % n;
};

const FIRST = ['Alice', 'Bob', 'Chen', 'Dana', 'Eve', 'Farid', 'Grete', 'Hiro', 'Ines', 'Jörg'];
const CITIES = ['Berlin', 'Osaka', 'Nairobi', 'Porto', 'Austin', 'Tromsø', 'Quito', 'Hanoi'];

const HEADER = `@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix foaf: <http://xmlns.com/foaf/0.1/> .
@prefix ex: <http://example.org/data/> .
@prefix org: <http://www.w3.org/ns/org#> .

`;

function record(i) {
  const name = `${FIRST[rnd(FIRST.length)]} ${String.fromCharCode(65 + rnd(26))}. ${FIRST[rnd(FIRST.length)]}sen`;
  const city = CITIES[rnd(CITIES.length)];
  const knows = [];
  for (let k = 0, kn = 1 + rnd(4); k < kn; k++) knows.push(`ex:p${rnd(100000)}`);
  return `ex:p${i} a foaf:Person ;
    foaf:name "${name}" ;
    foaf:age ${18 + rnd(70)} ;
    foaf:mbox <mailto:p${i}@example.org> ;
    foaf:based_near ex:city-${city} ;
    foaf:knows ${knows.join(', ')} ;
    ex:height ${(140 + rnd(60))}.${rnd(10)} ;
    ex:score ${rnd(100)}.${rnd(100)}e${rnd(5)} ;
    ex:active ${rnd(2) === 0} ;
    ex:note "line one\\nline two \\"${city}\\"" ;
    ex:label "étiquette n°${i}"@fr .
`;
}

function record12(i) {
  return `ex:p${i} foaf:knows ex:p${i + 1} {| ex:confidence 0.${rnd(9) + 1} ; ex:source ex:doc${rnd(100)} |} .
ex:claim${i} ex:states <<( ex:p${i} foaf:knows ex:p${i + 2} )>> .
<< ex:p${i} ex:met ex:p${i + 3} ~ ex:r${i} >> ex:when "2026-0${1 + rnd(9)}-1${rnd(9)}"^^xsd:date .
ex:p${i} ex:motto "إلى الأمام"@ar--rtl .
`;
}

function build(file, mkRecord, targetBytes) {
  const parts = [HEADER];
  let bytes = HEADER.length;
  let i = 0;
  while (bytes < targetBytes) {
    const r = mkRecord(i++);
    parts.push(r);
    bytes += Buffer.byteLength(r);
  }
  fs.writeFileSync(file, parts.join(''));
  return { records: i, bytes: fs.statSync(file).size };
}

const t11 = build(path.join(HERE, 'corpus-ttl11.ttl'), record, 4 * 1024 * 1024);
console.log(`corpus-ttl11.ttl: ${t11.records} records, ${(t11.bytes / 1048576).toFixed(2)} MiB`);

seed = 0xC0FFEE;
const t12 = build(path.join(HERE, 'corpus-ttl12.ttl'), record12, 1024 * 1024);
console.log(`corpus-ttl12.ttl: ${t12.records} record groups, ${(t12.bytes / 1048576).toFixed(2)} MiB`);

// large: repeat the 4 MiB corpus body to ~64 MiB (same header once)
{
  const src = fs.readFileSync(path.join(HERE, 'corpus-ttl11.ttl'), 'utf8');
  const body = src.slice(HEADER.length);
  const out = fs.createWriteStream(path.join(HERE, 'corpus-large.ttl'));
  out.write(HEADER);
  const reps = Math.ceil((64 * 1024 * 1024) / Buffer.byteLength(body));
  for (let r = 0; r < reps; r++) out.write(body);
  out.end(() => {
    console.log(`corpus-large.ttl: ${(fs.statSync(path.join(HERE, 'corpus-large.ttl')).size / 1048576).toFixed(1)} MiB`);
  });
}
