# Conformance oracle pairs — turtle12

Hand-authored seed set of **(Turtle document, expected N-Triples)** pairs for
[`grammars/turtle12.shuttle`](../../grammars/turtle12.shuttle), in W3C
`manifest.ttl` format ([`manifest.ttl`](manifest.ttl), entries
`turtle12-eval-01` … `turtle12-eval-22`).

## Role

These pairs are the **oracle the generate mode is checked against**, in both
directions:

1. **Parser obligation.** The compiled parse mode of `turtle12.shuttle` must
   map each `.ttl` to a graph isomorphic to its `.nt` (spec
   [`SHUTTLE.md` §8](../../spec/SHUTTLE.md), trust anchor).
2. **Generator calibration.** Before machine-generated pairs may serve as a
   conformance oracle for third-party parsers, the generator's reference
   interpreter must reproduce exactly these expected graphs from these
   documents. A generator that disagrees with a hand-derived pair is wrong by
   definition; the pair set is the fixed point the machinery is anchored to.

## Pair discipline

- **Determinism.** Blank nodes follow the per-derivation `fresh` counter:
  `_:b0, _:b1, …` in allocation order (spec §3). Document labels (`_:alice`)
  map through `env.labels` to the same counter, so expected files are
  bit-reproducible. Comparison is nevertheless defined **up to graph
  isomorphism** — third-party parsers may relabel.
- **Triple order** in the `.nt` files is the exact streaming emission order of
  the grammar (earliest-emission discipline, spec §6) and is **informative**;
  conformance comparison is over the graph (set semantics, spec §7).
- **Lexical fidelity.** Expected literals keep the source lexical form
  verbatim (`"1.2e3"^^xsd:double`, `".5"^^xsd:decimal`) — Shuttle never
  normalizes through host numerics (spec §2).
- **RDF 1.2 syntax in `.nt` files.** Pairs 13–22 use RDF 1.2 N-Triples forms:
  triple terms `<<( s p o )>>`, `rdf:reifies`, and directional language tags
  `@ar--rtl` (`rdf:dirLangString`).

## Coverage map

| pairs | feature | grammar site |
|---|---|---|
| 01–03 | `@prefix` / `@base` / SPARQL-style `PREFIX`+`BASE`, RFC 3986 resolution | `prefixID`, `base`, `sparqlPrefix`, `sparqlBase`, `iri` |
| 04–05 | `predicateObjectList` (`;`, trailing `;`, `a`), `objectList` (`,`) | `predicateObjectList`, `objectList`, `verb` |
| 06 | `[ … ]` as subject and object, fresh-before-descent order | `blankNodePropertyList`, `triples` |
| 07 | nested and empty collections | `collection`, `collectionBody` (threaded `prev`) |
| 08 | document-scoped `_:label` identity | `BlankNode`, `env.labels` |
| 09–11 | numeric / boolean / typed literals, all four string forms, ECHAR+UCHAR | `NumericLiteral`, `BooleanLiteral`, `RDFLiteral`, `String` tokens |
| 12 | language tags (`rdf:langString`) | `LANG_DIR` (no dir) |
| 13 | **RDF 1.2** directional language tags (`rdf:dirLangString`) | `LANG_DIR` (`--ltr`/`--rtl`) |
| 14 | **RDF 1.2** `VERSION` directive (no emission) | `sparqlVersion`, `env.version` |
| 15–16 | **RDF 1.2** triple terms, incl. object-position nesting; inner triple not asserted | `tripleTerm`, `ttObject` |
| 17–18 | **RDF 1.2** reified triples: subject position (fresh reifier, emission *before* the statement), explicit `~ r`, bare statement | `reifiedTriple`, `reifier`, `triples` |
| 19–22 | **RDF 1.2** annotation blocks: bare block, pending-reifier reuse, trailing bare reifier (no leak), multiple reifiers + blocks | `annotation` (threaded `pend`) |

## W3C test-suite alignment

Pairs 01–12 are shaped after the corresponding
[w3c/rdf-tests](https://github.com/w3c/rdf-tests) Turtle 1.1 evaluation
families (submission tests, `LITERAL*`, prefix/base and list tests); pairs
13–22 after the RDF 1.2 (`rdf12`) Turtle evaluation tests for
`dirLangString`, triple terms, reifiers, and annotations, per the pinned
Working Draft of 12 June 2026 (`spec-ref` in the grammar). They are
re-derivations against the Shuttle semantics, not copies — before release the
compiled grammar must additionally replay the official suites verbatim (spec
§8, trust anchor).

Pair 21 (`annotation-trailing-bare-reifier`) is the regression that exposed
three conformance failures in a current hand-written parser (spec §8).

## Validation status

- Pairs 01–12 (the Turtle 1.1 subset) machine-checked against N3.js 1.17.1:
  parse of `.ttl` is graph-isomorphic to parse of `.nt` for every pair.
- Pairs 13–22 hand-derived from the WD 2026-06-12 semantics and the normative
  rendering in spec §9 / [`examples/turtle12.md`](../../examples/turtle12.md);
  no independent RDF 1.2 parser was used as oracle (that circularity — testing
  the pairs with the parsers they are meant to test — is exactly what the
  reference-interpreter trust anchor replaces).

## SHACL Compact Syntax corpus

The `shaclc/` subdirectory carries the corpus for the parsers generated from
`grammars/shaclc12ext.shuttle` (vendored shaclc-js pairs + new RDF 1.2 pairs +
strict-mode negative cases) — see [`shaclc/README.md`](shaclc/README.md).
