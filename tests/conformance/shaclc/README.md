# SHACL Compact Syntax conformance corpus

Fixture pairs for the parsers generated from
[`grammars/shaclc12ext.shuttle`](../../../grammars/shaclc12ext.shuttle)
(strict = `--profile rdf12`, extended = `--profile rdf12,ext`). Each pair is a
`.shaclc` document and its expected triples as a `.ttl` oracle; the harness
(`packages/gen-js/test/shaclc.test.js`) compares by **RDF graph isomorphism**,
parsing the oracle side with the generated turtle12 module. Relative IRIs in
the oracles resolve against `urn:x-base:default` (shaclc-parse's default base,
passed as `options.baseIRI`).

## Layout

| Dir | Contents | Expectation |
|---|---|---|
| `valid/` | the 44 standard-syntax pairs vendored verbatim from [jeswr/shaclcjs](https://github.com/jeswr/shaclcjs) `__tests__/valid` (MIT) | both artifacts parse ≅ oracle |
| `extended/` | the 12 extended-syntax pairs vendored from shaclcjs `__tests__/extended` (MIT), plus `leak-*` — two pairs isolating the constructs shaclc-js 2.x wrongly accepts with `extendedSyntax:false` (`% … %` escapes, trailing turtle statements) | extended artifact parses ≅ oracle; **strict artifact rejects every file** |
| `rdf12/` | RDF 1.2 / SHACL 1.2 surface pairs authored here — no 1.2 SHACL-CS corpus exists anywhere else. Triple terms in value positions, dir-lang literals, `TripleTerm` nodeKind, `reifierShape`/`reificationRequired` | both artifacts parse ≅ oracle |
| `negative/` | syntax invalid in **both** profiles (undeclared prefix, `"x"@en--ltr^^dt`, directive after shape, `% … %` after a node-level constraint, `[*..2]`, bad direction suffix) | both artifacts reject |

## Notes

- The strict-rejects-extended obligation is the *strict-mode enforcement
  leak fix*: in the jison parser only the `;`-annotation and the `a` keyword
  call `ensureExtended`; `% … %` sections and trailing turtle statements are
  accepted in strict mode. The Shuttle grammar carves all four constructs out
  of the strict parse tables by `@profile(ext)`, so acceptance is impossible
  by construction.
- The `rdf12/` surface syntax is INVENTED here (the W3C shacl12-cs ED has no
  RDF 1.2 surface yet) and is pinned in the grammar header for coordination
  with [jeswr/shaclc-1.2](https://github.com/jeswr/shaclc-1.2).
- Deviations from shaclc-js (all documented in the grammar header, D1–D5):
  case-sensitive keywords, property-only `% … %` attachment, nested bodies
  composing with `|`/`!`, verbatim DOUBLE lexical forms, directive ordering.
