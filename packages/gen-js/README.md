# @rdf-shuttle/gen-js — the Shuttle JS backend

Consumes a `.shuttle` grammar and emits **one dependency-free ES module**
containing a streaming parser (syntax → RDF/JS quads), a chunked push parser
with bounded memory, and a serializer (quads → syntax) — the parse and print
modes of the same relation (spec/SHUTTLE.md §1).

```
node src/cli.js ../../grammars/turtle12.shuttle -o generated/turtle12.js
node src/cli.js ../../grammars/shaclc12ext.shuttle -o generated/shaclc12.js    --profile rdf12
node src/cli.js ../../grammars/shaclc12ext.shuttle -o generated/shaclc12ext.js --profile rdf12,ext
```

`--profile` selects which `@profile`-labelled alternative layers are compiled
in (unlabelled alternatives are always in; omit the flag for the full
language). A stricter build **rejects** the carved-out syntax by
construction — the alternatives are absent from its parse tables.

```js
import { parse, parseToQuads, createPushParser, parseStream, writeQuads, createWriter }
  from '@rdf-shuttle/gen-js/turtle12';

parse(text, { onQuad: (q) => …, baseIRI });        // one-shot, RDF/JS quads
const p = createPushParser({ onQuad });            // p.push(chunk); p.end()
const ttl = writeQuads(quads, { prefixes });       // print mode
```

## Pipeline

`src/meta.js` parses the meta-language of `grammar/shuttle.ebnf` (header, env
block, token rules, productions, the seven-verb clause language, unparse
templates). Then:

- **`lexer-gen.js`** compiles token rules to direct-coded `charCodeAt`
  matchers: no regexes, no token objects — a token is `(kind:int, start,
  end)` plus an escapes-seen flag and boundary marks. First-char dispatch
  switch (128 entries + non-ASCII fallback); longest-match across the
  candidate set with declaration-order tie-break (`@prefix` beats LANG_DIR,
  exactly the overlap resolutions the grammar declares). The `X* Y`
  trailing-context idiom (PN_LOCAL dots) compiles to a single forward scan
  tracking the last Y-element end — linear, escape-safe. Long strings
  compile to a quote-run scanner. Prefix subsumption folds PNAME_NS into the
  PNAME_LN scan (one scan decides both). Chunk boundaries: any matcher that
  touches the buffer end sets a flag and the driver suspends the statement
  (`INCOMPLETE`) instead of committing a shorter match.
- **`parser-gen.js`** compiles productions to recursive descent with LL(1)
  dispatch over token kinds (FIRST/nullable computed; overlaps are generator
  errors). Semantic blocks compile via **`clausec.js`**; `emit` fires exactly
  where the grammar places it (earliest emission), `thread` locals become
  loop variables, `fresh` is the deterministic per-derivation counter,
  `require … else error E` throws the stable code E. Recursive productions
  carry an explicit `@maxdepth` guard.
- **`serializer-gen.js`** emits the print mode (stream-pretty window):
  term rendering follows the `@prefer`/`@when` structure of the prioritized
  groups; *inferred* guards (bare numbers, booleans) are full-match functions
  generated from the very token patterns the lexer uses; PN_LOCAL
  escaping/validation is derived from the grammar's charsets; statement
  shape (`;` `,` `.` `a` `<<( )>>` `@prefix`) is extracted from the
  production/token ASTs.
- **`runtime.inc.js`** is the audited primitive-iso library (spec §5):
  RFC 3986 `resolve`, unescape/escape families, `langCanon`, and the RDF/JS
  term classes + DataFactory. It ships once per toolchain and is inlined
  into every artifact.

## SHACL Compact Syntax (shaclc12ext)

The second grammar, `grammars/shaclc12ext.shuttle`, exercises the formalism
features Turtle does not: the **oracle** clause (`@oracle xsdDatatype(iri) =
…` — SHACL-C's recognized-datatype registry deciding `sh:datatype` vs
`sh:class`), **conditional emission** (`emit … when int(mn) > 0` — the
minCount-omitted-when-0 invariant), **pair-valued productions** (`value =
(p, o)` with `fst`/`snd` — every `<atom> ('|' <atom>)*` shape decides
direct-vs-`sh:or`-list one nonterminal late), and **@profile layers**
(strict/`rdf12`/`ext`). Reference semantics are the shaclc-js jison parser,
validated by graph isomorphism over its vendored fixture corpus plus new
RDF 1.2 pairs (`tests/conformance/shaclc/`, see its README).

Honest scope: the artifact is **parse-only** — the serializer generator
below reads the Turtle statement spine and cannot yet derive the
residual-consumption printer SHACL-C needs (`examples/shacl-compact.md`
§print); `writeQuads`/`createWriter` throw with a clear message. The derived
printer (whose non-empty residual is the "not SHACL-C-expressible" verdict)
is the tracked next step. The push parser degrades to whole-buffer parsing
(the start production is document-shaped, not a statement star).

## Conformance

`npm test` regenerates the artifact and runs the oracle pairs
(`tests/conformance/turtle12-eval-01…22`): parser obligation
(parse(.ttl) ≅ parse(.nt), graph isomorphism), serializer round-trip
(L1/L2, plain and prefix-abbreviated), chunked push parsing (7-byte chunks),
and negative cases (undeclared prefix → `UNDECLARED_PREFIX`, `"x"@prefix`
keyword tie). `test/shaclc.test.js` runs the SHACL-CS corpus: the 44 valid
pairs against BOTH artifacts, the 14 extended pairs (extended accepts ≅
oracle, strict rejects — including the two strict-mode-leak cases), the 8
rdf12 pairs, the negative set, push-parser agreement, and baseIRI
resolution. Status: **234/234 across both suites.**

## Honest scope notes (v0.1)

Grammar-driven vs. not, stated plainly:

- The lexer, parser dispatch, clause semantics, and the serializer's term
  decision trees are compiled from the grammar AST. Changing the grammar
  changes the artifact.
- The serializer's **structural sugar guards** (`listShaped`,
  `freshSingleUse`, `reifiesQuadPresent`) need residual-graph indexes the
  stream window does not have; v0.1 evaluates them as false, so collections,
  `[ … ]`, and annotation blocks print as plain statements — the L3
  guard-free fallback (spec §7). Batch-pretty (index-backed guards) is the
  natural next step.
- `case`/tuple patterns are compiled for the shapes the six v1 grammars use
  (option-discriminated pairs), not the full pattern language.
- The **reference interpreter** of the shared IR (the conformance oracle and
  fuzzing anchor) does not exist yet; the oracle pairs are the current trust
  anchor. `--emit tests` and `--emit rust` are later waves.

## Meta-language gaps surfaced by this backend (v0.1 feedback)

Beyond NOTE 1–4 in `grammars/turtle12.shuttle`:

- **NOTE 5 (token captures).** Token rules have no capture syntax: the `=>`
  expressions name parts (`body`, `ns`, `local`, `lang`, `dir`) that the
  backend resolves by convention (fixed literal affixes, sub-token-ref name
  matching, trailing-optional position). Proposal: explicit bindings in
  token bodies, e.g. `'@' lang=([a-zA-Z]+ ('-' …)*) ('--' dir=(…))?`.
- **NOTE 6 (skip declaration).** This backend implements the proposed
  `skip WS, COMMENT ;` header clause and defaults to it when absent.
- **NOTE 7 (iso arity).** `unescapeString(body, dquote)`'s second argument is
  a quote-style constant, not a capture — the iso signature table should be
  normative so backends need not special-case it.
