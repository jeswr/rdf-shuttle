# Worked example: Turtle 1.2

This example exercises the four RDF 1.2 surface features in one document —
directional language tags, an explicit reifier with an annotation block, a
triple term in object position, and reified-triple sugar in *subject*
position — and shows the exact quads Shuttle's semantics produce, in the exact
order a conforming streaming parser must emit them.

## Input

```turtle
PREFIX : <http://ex.org/>
:alice :says "مرحبا"@ar--rtl .
:s :p :o ~ :r {| :confidence 0.9 |} .
:g :source <<( :s :p :o )>> .
<< :a :b :c >> :certainty 0.5 .
```

## Governing productions

Exactly the RDF 1.2 core productions of
[`spec/SHUTTLE.md` §9](../spec/SHUTTLE.md) — `objectList`, `annotation` (with
its threaded `pend`), `tripleTerm`, `reifiedTriple`, `RDFLiteral` — plus the
statement-level production:

```
triples : graph [emits, gen]
  ::= s=subject predicateObjectList(s)
    | b=blankNodePropertyList predicateObjectList(b)?
    | r=reifiedTriple predicateObjectList(r)
  ;
```

## Parse direction: emissions in exact stream order

Each quad leaves the parser the instant its arguments are ground (the
L-attributed earliest-emission discipline, checked at compile time). Below,
`:x` abbreviates `http://ex.org/x`; all quads are in the default graph.

```
E1  :alice :says "مرحبا"@ar--rtl .
      # RDFLiteral, LANG_DIR = ("ar", some rtl) → literal(lex, rdf:dirLangString, "ar", rtl)
      # fired by objectList's `emit s p o` at the token after the literal closes

E2  :s :p :o .
      # objectList emit — before any annotation is seen

E3  :r rdf:reifies <<( :s :p :o )>> .
      # annotation: the reifier alternative binds r = :r, emits, pend := some(:r)

E4  :r :confidence "0.9"^^xsd:decimal .
      # '{|' alternative: pend is some(:r) → NO fresh reifier, NO second reifies quad;
      # predicateObjectList(:r) emits as parsed; '|}' → pend := none
      # NB lexical fidelity: the object is literal("0.9", xsd:decimal), verbatim

E5  :g :source <<( :s :p :o )>> .
      # tripleTerm is a pure `term` — the inner triple is NOT asserted

E6  _:b0 rdf:reifies <<( :a :b :c )>> .
      # reifiedTriple as subject: no '~' → fresh() = _:b0; its emit fires while the
      # SUBJECT is still being parsed — hence E6 precedes E7

E7  _:b0 :certainty "0.5"^^xsd:decimal .
```

Seven quads, strictly left-to-right, `O(depth)` memory.

### Why the `pend` thread earns its keep

The conformance sampler's first coverage wave over `annotation`'s alternatives
includes the trailing-bare-reifier case:

```turtle
:s :p :o ~ :r2 .
```

for which the Shuttle semantics yield exactly

```
:s :p :o .
:r2 rdf:reifies <<( :s :p :o )>> .
```

A current hand-written parser (N3.js, at the time of the design synthesis)
instead duplicates the assertion, drops the `rdf:reifies` quad, and leaks
`:r2` into the following statement — three real conformance failures exposed
by one generated pair.

## Print direction (same 7 quads, policy `pretty`)

Top-level iteration is match-driven over subjects `:alice, :s, :g, _:b0`.

- `:r` never surfaces as a top-level subject: the annotation sugar guard fires
  because the residual contains both the asserted `(:s, :p, :o)` and
  `:r rdf:reifies tt(:s,:p,:o)`, so E3–E4 are consumed inside the annotation
  lens and print as `~ :r {| :confidence 0.9 |}`.
- `_:b0`'s reifies quad matches the `reifiedTriple` alternative (fresh-site
  linear match; in-degree conditions hold) and prints as
  `<< :a :b :c >> :certainty 0.5 .`.
- The residual empties, so print succeeds, and `parse(print(G)) ≅ G`
  (`_:b0` may relabel).

Under `window = subject` **streaming** printing, if the reifies quad falls
outside the window the L3 fallback prints
`_:b0 rdf:reifies <<( :a :b :c )>> .` as a plain statement instead — uglier,
still law-abiding.
