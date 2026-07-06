# Shuttle — a translation-grammar formalism for RDF concrete syntaxes

**Version:** 0.1 (draft)
**Status:** Working draft for review. Nothing here is stable.

Shuttle is a deterministic, L-attributed translation grammar with relational
semantics and lens-derived printing. A single Shuttle specification of a
concrete RDF syntax (a `.shu` file) determines, mechanically:

1. a **streaming parser** (text → quads, single pass, bounded memory),
2. a **serializer** (quads → text, derived from the *same* productions, never
   hand-synchronized), and
3. a **conformance test generator** producing (document, expected-quads) pairs
   plus provably-negative syntax tests, in W3C `manifest.ttl` format.

The three artifacts are three *modes* of one denotation, so their mutual
consistency (round-tripping, oracle validity) is a theorem checked at compile
time, not a property hoped for across three hand-written codebases.

Target syntaxes for v1: N-Triples, N-Quads, Turtle 1.2, TriG 1.2, SHACL
Compact Syntax, Notation3 (syntax and structural encoding only).

---

## 1. Denotational core: one relation, three modes

A `.shu` file consists of a header, an environment block, oracle declarations,
token rules, productions, and print policies. Each production `p` denotes a
relation

```
R_p  ⊆  Tok* × Tok* × Env × Env × Bag(Quad) × ⟦params⟧ × ⟦value⟧
```

read as: *consuming a prefix of the token stream (difference of the two Tok\*
components), transforming the environment, emitting a bag of quads, given
inherited parameter values, and synthesizing a result value.* This is the DCG
construction with a threaded environment and an emission accumulator.

Three modes are **derived** from `R_p` by choosing which components are ground:

| Mode | Ground | Free | Discipline |
|---|---|---|---|
| **parse** | text | quads, value | deterministic LL(k≤2), single pass, streaming |
| **print** | quads | text | residual-multiset consumption, prioritized alternatives, policy-refined |
| **generate** | nothing | text *and* quads | weighted, depth-bounded, coverage-directed enumeration |

The compiler (`shuc`) proves the properties each mode needs — LL determinism,
L-attributedness/earliest emission, print totality (law L3), token round-trip
obligations — or **rejects the grammar with a counterexample**. A grammar edit
that silently breaks streaming or printing fails the build.

Because parser and printer are both refinements of the same relation, the
round-trip laws of §8 hold by construction, and are additionally tested.

---

## 2. The RDF term algebra (RDF 1.2, positionally typed)

```
type dir     = ltr | rtl
type term    = iri(abs: string)
             | bnode(id)
             | literal(lex: string, dt: iri, lang: string?, dir: dir?)
             | tt(s: subjT, p: iri, o: term)          // triple term; nests via o only
             | var(name)                              // profile n3 only
type subjT   = iri | bnode
type graphT  = default | iri | bnode | formula(id)    // formula: profile n3
quad = (subjT, iri, term, graphT)
```

Constructor invariants make ill-formed RDF 1.2 data **unrepresentable**:

- `lang` present without `dir` forces `dt = rdf:langString`; `lang` and `dir`
  present forces `dt = rdf:dirLangString`. A source form like `"x"@en^^dt` is a
  *syntax* error by grammar shape, never a runtime check.
- The emission primitive is typed `emit : subjT × iri × term [@ graphT]`.
  A triple term in subject position, a literal in predicate position, etc. are
  **type errors in the grammar** — a Shuttle grammar that could produce
  generalized RDF does not compile (except under an explicit future profile).
- Triple terms `tt(s,p,o)` nest through the object component only, matching
  RDF 1.2.

**Lexical fidelity.** Literal lexical forms are preserved verbatim: Turtle's
`0.9` parses to `literal("0.9", xsd:decimal)`, not to a host float. This is
what keeps the numeric-sugar print alternatives exactly invertible.

---

## 3. Environment and attributes

All parsing context is *declared*; nothing hides in host-language state.

```
env {
  base     : iri = <> ;                    // RFC 3986 resolution via the resolve iso
  prefixes : map<string, iri> = {} ;
  labels   : scoped map<string, bnode> ;   // document scope; N3 formulae push/pop scopes
  version  : string? ;                     // RDF 1.2 VERSION directive, no emission
}
```

- **Inherited attributes** are typed production parameters (e.g. the current
  subject, the current graph). Parameters not passed explicitly **auto-copy**
  from the lexically enclosing production when names and types match (the
  classic attribute-grammar copy-rule convention). This is what collapses,
  e.g., shaclc-js's mutable `currentNodeShape`/`nodeShapeStack` globals into a
  single declared parameter that nesting can never clobber.
- **Synthesized attributes** are the production's typed result (`value = e`).
- **Effect rows.** Every production carries
  `[emits, gen, reads env.X, writes env.X]`; a caller's row must cover the
  union of its callees'. The three mode analyses are computed from these rows,
  and the row doubles as machine-checked documentation.
- **Threaded locals.** A repetition may open a locally threaded accumulator:

  ```
  thread v : T = init in ( ... )*
  ```

  Formally this is an inherited attribute on the desugared repetition-chain
  nonterminal (hence fully analyzable); a linearity check licenses compiling it
  to a plain in-place loop variable (hence fast).
- **`fresh`** draws blank nodes from a per-derivation counter, yielding
  deterministic labels `_:b0, _:b1, …` — conformance pairs and round-trips are
  bit-reproducible.

---

## 4. The meta-notation (canonical)

This section is normative for how Shuttle specifications are written. The
grammar of the meta-language itself is given in
[`grammar/shuttle.ebnf`](../grammar/shuttle.ebnf).

### 4.1 Production form

```
Name(p1: T1, …) : SemType [effects]
  ::= alternative
    | alternative
  ;
```

- `Name(p1: T1, …)` — the nonterminal and its typed **inherited parameters**.
- `SemType` — the synthesized type:

  | SemType | meaning | example |
  |---|---|---|
  | `term` | pure value, **no emissions** | `tripleTerm` |
  | `term!` | value **and** emissions | `reifiedTriple`, `blankNodePropertyList` |
  | `graph` | emissions only, no value | `predicateObjectList` |
  | `unit` | neither | directives |
  | scalar types | token/value results | `(string, dir?)` |

- `[effects]` — the effect row (§3). Omitted means pure.

### 4.2 Right-hand sides

An alternative is an EBNF sequence of items:

- `'text'` — quoted terminal.
- `NAME` / `Name(args)` — token reference / nonterminal call with arguments.
- `x=E` — binding of an item's value.
- `E?  E*  E+` — optional / repetition.
- `( E ) % ','` — one-or-more `E` separated by the terminal (sugar for the
  obvious chain).
- `thread v : T = e in ( … )*` — threaded local over a repetition (§3).
- `{ clause ; … }` — a **semantic block**, attachable after any item; clauses
  execute left-to-right at that point in the derivation.

### 4.3 Semantic clauses (the seven verbs)

Each clause has a **normative dual reading**. The parse column defines the
parser; the print column defines the serializer; both are readings of the same
relational clause. There are exactly seven:

| clause | parse reading | print reading |
|---|---|---|
| `value = e` | construct term from captures | pattern-match the goal term, bind captures |
| `emit s p o [@g] [when c]` | assert quad the instant all args are ground | consume exactly one matching quad from the residual; `when` inverts by clause solving |
| `fresh b` | gensym from the derivation counter | linear match: this bnode is printed by exactly this site |
| `let x = e ?? d` | compute with default | invert `e`; if the source quad is absent, `x = d` |
| `env.x := e` | update env left-to-right | read the print policy; emit the directive |
| `require c else error E` | well-formedness check (`E` is a stable error code) | holds by construction; `E` doubles as a negative-test generator hook |
| `oracle O(args) -> cl ; otherwise -> cl` | consult the declared decidable predicate | discharged from the consumed quad's shape instead — never ambiguous backward |

`fresh` also has an expression form `fresh()` for anonymous allocation
(e.g. `let rr = r ?? fresh()`); both forms share the counter and both invert to
linear bnode matches. `{ clause ; … ; e }` may be used as a block *expression*
whose value is its final expression.

### 4.4 Alternative discipline

**Parsing.** Alternatives are order-independent and must be parse-disjoint
under LL(k≤2) after automatic left-factoring; the compiler emits conflict
counterexamples otherwise. Token-level disambiguation — `<` vs `<<` vs `<<(`,
`@prefix` vs LANGTAG vs `@version`, PN_LOCAL trailing dot — is declared in
token rules with longest-match, exactly where the W3C specs resolve it. There
is no ordered choice and no backtracking: mis-ordering alternatives cannot
silently change the language, which matters for a *specification* formalism.

**Printing.** The same alternatives form a **prioritized group**:

- `@prefer(n)` orders candidates (lower prints first).
- `@when(pred)` guards a sugar alternative. Guards are declared, or *inferred*
  from iso domains (a bare-number alternative's guard is membership in the
  INTEGER token language — costs the author nothing).
- Every prioritized group **must** end in a guard-free fallback (law L3,
  checked statically). Fallbacks degrade prettiness, never correctness.

**Other annotations.**
`@covers(tag)` marks alternatives for coverage accounting.
`@oracle name(types)` declares an external decidable predicate (e.g. SHACL-C's
recognized-datatype registry).
`@buffered` opts one production out of the streaming check (none of the six v1
grammars need it).
`@maxdepth(k)` bounds nesting; enforced by the generated machines.
`print { … }` / `print fallback N` (a trailing directive on the production) is
the hand-written print escape hatch, in the same file — no second spec to
drift.
`@native(js|rust) { … }` exists but forfeits invertibility and oracle status
for that rule; it is a measured admission, not a loophole.

---

## 5. Tokens and primitive isos

Tokens are **strictly regular**; each carries a value transducer:

```
token LANG_DIR : (string, dir?)
  ::= '@' [a-zA-Z]+ ('-' [a-zA-Z0-9]+)* ('--' ('ltr'|'rtl'))?
  => (langCanon(lang), dir)
  unparse (l, d) = '@' l (d? '--' d : '') ;
```

Value transducers are built from a closed set of **primitive isos** —
`resolve/relativize`, `expandPName/abbreviate`,
`unescapeString/escapeString(quoteStyle)`, `unescapeU`, `langCanon` — the
trusted leaves of the system. They ship once per toolchain as an audited
runtime library with property-tested round-trip obligations
(`fwd ∘ bwd = id` on the print domain), plus differential tests against a
reference implementation before a release may serve as a conformance oracle.
Non-injective transducers must be declared `@lossy` with a canonicalizer.

The token automaton is a suspendable DFA: chunk boundaries suspend mid-token,
retaining only the incomplete token — no rescanning of a growing buffer.

**Honest lexing.** The W3C "context-free" grammars quietly rely on contextual
lexing; Shuttle declares that resolution in token rules (longest-match rules
per token) instead of hiding it in prose.

---

## 6. Parse mode: the L-attributed streaming discipline

The central compile-time theorem is stated once:

> Every attribute is computable in a single left-to-right pass **iff** every
> `emit` fires at the earliest point its arguments are ground.

L-attributedness and earliest-emission scheduling are the same check. The
compiler verifies it per production and reports a named error (with the
offending attribute flow) when it fails; `@buffered` is the explicit, visible
opt-out.

The generated parser is recursive descent compiled to an **explicit-stack
resumable machine**:

- quads leave the parser the instant their arguments are ground (see the
  worked stream orders in [`examples/`](../examples/));
- memory is `O(depth + |env| + longest token)`;
- push-mode / chunked input, mid-token suspension (§5);
- immune to host-stack overflow; `@maxdepth` enforced.

**Laws (parse):** deterministic; total on the token language; streaming as
above.

---

## 7. Print mode: the serializer, derived

The serializer is not written; it is the **backward reading** of the same
productions (§4.3, print column).

**Residual-consumption semantics.** Printing a graph `G` starts with `G` as a
residual multiset. Each `emit s p o` consumes exactly one matching quad;
`fresh b` matches a blank node linearly (printed by exactly this site);
Kleene repetitions become match-driven iteration; alternatives are tried in
`@prefer` order subject to `@when` guards, ending at the guard-free fallback.
**Print succeeds iff the residual empties.** Serializer completeness is
thereby a checkable property, not a hope.

**Laws.**

- **L1** `parse(print(G, π)) ≅ G` for every policy `π` (≅ = graph isomorphism;
  blank nodes may relabel).
- **L2** `parse ∘ print ∘ parse = parse` (idempotence at the graph level).
- **L3** (totality) every prioritized group ends guard-free, so
  `dom(print) =` all RDF 1.2 graphs for the Turtle family (proved by the
  compiler), and a *proper subset* for SHACL-C — where print failure is the
  **correct** verdict "this graph is not SHACL-C-expressible", reported with
  the non-empty residual. Partiality is a feature: the generated writer is a
  decision procedure for expressibility.
- Byte-level round-tripping is explicitly **not** promised (L1/L2 are
  graph-level; lexical forms of literals are preserved, layout is not).

**Two generated printers per grammar.**

- *batch-pretty*: guards may consult `match(s,p,o)` and object-incidence
  counts; the compiler derives **exactly which indexes** the guards need and
  emits that as the store interface — any conforming store qualifies.
- *stream-pretty*: `window = subject`; guards evaluate against the window
  only; whenever non-local evidence is missing, the L3 fallback prints a plain
  statement — uglier, still law-abiding.

**Policies** (`print policy` blocks) refine, never redefine: ordering,
grouping, prefix mining, directive placement, layout skeleton. The policy
vocabulary is a fixed declarative set (§10, Q4) — deliberately not a
programming language.

**Duplicate quads.** Print consumes an exact-once cover: duplicate source
statements collapse, as in every RDF toolchain (L1/L2 are stated over graphs).
Line-oriented profiles (N-Triples/N-Quads) may declare `emits triples bag` /
`emits quads bag` in the header to preserve multiplicity through a round-trip.

---

## 8. Generate mode: conformance pairs

The generator runs the relation with nothing ground, threading the **same
environment** forward — pnames are drawn only from declared prefixes, base
resolution is live, the label table is live — so generated documents are
semantically valid **by construction**, never by post-filtering.

- **Coverage-directed:** the sampler targets the coverage map over
  (production × alternative × token-boundary bucket × print-guard both ways);
  `@covers` tags feed the accounting.
- **Boundary-biased token sampling:** escape classes, surrogate-adjacent
  codepoints, PN_LOCAL dot/colon/percent hazards, long-string quote runs.
- **Deterministic:** `fresh` labels are `_:b0, _:b1, …`; pairs are
  reproducible from a seed.
- **Automorphism-free graphs** are generated so expected-vs-actual comparison
  is a linear isomorphism check.

**Negative tests**, two provably-sound families:

1. **LL-table mutants** — single-token corruptions chosen from the parse
   tables, hence *provably* outside the language (no human judgment needed;
   this construction is unavailable to PEG-based formalisms), each verified
   against the compiled parse mode before shipping.
2. **Semantic negatives** — one generator per `require … else error E` clause,
   tagged with the expected stable error code.

**Output:** W3C-format `manifest.ttl` plus (document, expected `.nq`) pairs —
`rdft:TestTurtleEval` / `PositiveSyntax` / `NegativeSyntax` analogues per
profile — drop-in for existing rdf-tests harnesses.

**Trust anchor:** the toolchain ships a slow reference interpreter of the
compiled IR. It must replay the official W3C rdf12 test suites (and shaclc's
suite) *before* a Shuttle spec is used as an oracle, and it is the standing
differential-fuzzing counterpart to the fast generated parsers.

This machinery has already earned its keep: first-wave alternative coverage of
the `annotation` production (§9) generated the trailing-bare-reifier case
`:s :p :o ~ :r2 .`, exposing three distinct RDF 1.2 conformance failures in a
current hand-written parser (duplicated assertion, dropped `rdf:reifies` quad,
reifier leaking into the next statement).

---

## 9. RDF 1.2 core (normative rendering)

These productions are shared by the Turtle-family grammars and are the
reference rendering of the trickiest RDF 1.2 semantics.

```
tripleTerm : term
  ::= '<<(' s=ttSubject p=verb o=ttObject ')>>'  { value = tt(s,p,o) } ;   // pure

reifiedTriple : term! [emits, gen]
  ::= '<<' s=rtSubject p=verb o=rtObject r=reifier? '>>'
  { let rr = r ?? fresh() ; emit rr rdf:reifies tt(s,p,o) ; value = rr } ;

reifier : term! [gen] ::= '~' e=(iri | BlankNode)?  { value = e ?? fresh() } ;

annotation(s: subjT, p: iri, o: term) : graph [emits, gen]
  ::= thread pend : subjT? = none in
      (   r=reifier          { emit r rdf:reifies tt(s,p,o) ; pend := some(r) }
        | '{|'               { let a = pend ?? { fresh f ;
                                                 emit f rdf:reifies tt(s,p,o) ; f } }
          predicateObjectList(a)
          '|}'               { pend := none }
      )*
  print { prefer sugar when residual has (s,p,o) consumed
          and ?r rdf:reifies tt(s,p,o) present ; fallback: plain statements } ;

objectList(s: subjT, p: iri) : graph [emits, gen]
  ::= ( o=object { emit s p o } annotation(s,p,o) ) % ',' ;

RDFLiteral : term
  ::= lex=String
      ( ld=LANG_DIR   { value = case ld of (l, none)   -> literal(lex, rdf:langString, l)
                                           (l, some d) -> literal(lex, rdf:dirLangString, l, d) }
      | '^^' dt=iri   { value = literal(lex, dt) }
      |               { value = literal(lex, xsd:string) } ) ;
```

Readings worth spelling out:

- `tripleTerm` is a pure `term`: the inner triple is **not** asserted.
- `reifiedTriple` denotes its reifier and emits exactly one `rdf:reifies`
  quad; because the emit fires at groundness, a reified triple in *subject*
  position emits **before** the enclosing statement's quads.
- The `pend` thread encodes the pending-reifier rule: `~ :r {| … |}` reuses
  `:r` (no second reifies quad); consecutive bare `{| … |}` blocks mint
  distinct fresh reifiers; `pend` cannot leak across statements because the
  thread's scope is the repetition.
- `LANG_DIR` makes `rdf:dirLangString` arise by construction; `@ar--rtl^^dt`
  is unparseable.

Collections and blank-node property lists are ordinary productions (threaded
head/prev locals emitting `rdf:first`/`rdf:rest` cells as parsed;
`[ … ]` = `fresh` + `predicateObjectList`). TriG:
`wrappedGraph ::= g=labelOrSubject? '{' triplesBlock(g ?? default) '}'` with
`emit … @ g`. N3: a formula pushes a `labels` scope, allocates `formula(id)`,
sets the graph parameter, and synthesizes the formula term.

Header and modularity:

```
grammar turtle12 ; target rdf-1.2 ; start turtleDoc ; emits triples ;   // or: emits quads
profile turtle ;         // turtle | trig | ntriples | nquads | n3 | shaclc — gates productions
import core-terms ;      // shared token/production modules; TriG = import turtle12 + graph param
```

Each `.shu` file **must** also carry a `spec-ref` pragma pinning the exact
W3C document (and Working Draft date, while RDF 1.2 is in flux) it encodes;
see §10, Q1.

---

## 10. Resolved and open questions

The design synthesis raised ten questions. Resolutions adopted in this draft:

| # | Question | Resolution in v0.1 |
|---|---|---|
| Q1 | RDF 1.2 Working-Draft flux (pending reifier, `VERSION`, dir-lang) | **Resolved (process):** every `.shu` file pins its source spec via a mandatory `spec-ref` pragma (document + WD date); the `annotation`/`reifier` productions must be re-verified when RDF 1.2 reaches CR. Upstream bug reports for the parser failures found in §8 are handled outside this repo, coordinated with the active N3.js performance/conformance efforts. |
| Q3 | Trust in primitive isos (RFC 3986 corner cases) | **Resolved:** property-tested round-trip obligations *plus* mandatory differential testing against a reference implementation are release gates for the iso library; a formally verified implementation is explicitly not required for v1. |
| Q4 | Print-policy expressiveness | **Resolved:** a fixed declarative vocabulary (ordering, grouping, prefix mining, directive placement, layout skeleton), no user-defined functions, target ≤ ~30 lines per grammar. Revisit only if a real serializer need breaks it. |
| Q5 | Isomorphism checking for third-party outputs | **Resolved:** the core harness keeps the linear check (valid because generated graphs are automorphism-free and pairs keep the bnode correspondence). RDFC-1.0 canonicalization is an optional harness plugin, out of core. |
| Q6 | JSON-LD fixed-context profile | **Resolved:** deferred until the six core grammars ship. The scope boundary (§11) stands. |
| Q7 | Bootstrap order | **Resolved:** hand-written `shuc` front-end → N-Triples → Turtle 1.2 → W3C-suite anchor → benchmark gate → TriG/SHACL-C → N3. Self-hosting (the meta-grammar of [`grammar/shuttle.ebnf`](../grammar/shuttle.ebnf) rewritten in Shuttle) is the v1 exit criterion, not the starting point. |
| Q9 | Duplicate-quad round-tripping | **Resolved:** set semantics (exact-once cover) is normative for graph-level laws; line-oriented profiles may opt into `emits … bag` (§7) to preserve multiplicity. |

Remaining **open** questions, carried forward:

- **Q2 — LL(2) sufficiency for N3.** Turtle/TriG/N-Triples/N-Quads/SHACL-C are
  confirmed LL(≤2) after left-factoring and token-level resolution. N3 path
  syntax (`!`/`^`) and formula corners still need verification. Ruling if it
  fails: the offending production takes an explicit `@buffered`, visibly.
- **Q8 — Performance-claim discipline.** The 2–4x-over-N3.js JS target must be
  demonstrated on the pinned benchmark harness against a stated N3.js version
  (re-checked against its open perf PRs) before any public claim. Gate
  ownership and the normative corpus are not yet assigned.
- **Q10 — Error-message quality.** LL tables give precise expected-token sets
  and `require` codes give stable semantic diagnostics, but polished recovery
  and reporting is unscheduled backend work; the first release targets the
  conformance-tooling audience.

---

## 11. Scope boundary (declared, not discovered later)

- **JSON-LD:** the surface JSON is expressible; the triple mapping is
  algorithmic (`@context` processing, remote fetching) and out of core. The
  honest offering is a *fixed-context profile* — a context known at generator
  time compiles to a specialized bidirectional grammar (deferred, §10 Q6).
- **HDT:** a binary format, not a grammar problem — excluded.
- **N3 logic** (`log:implies`, quantifier meaning): downstream of quad
  emission — Shuttle covers N3 syntax and structural encoding only.

---

## 12. Derived-artifact contract (informative summary)

`shuc` pipeline: parse + typecheck the clause language → effect-row check →
attribute analysis (L-attributed/earliest-emission; copy-rule elision;
threaded-local linearity) → grammar analysis (desugaring, left-factoring,
FIRST/FOLLOW, LL(k≤2) tables with conflict counterexamples; token DFA with
longest-match resolution) → print analysis (reverse match plans; guard
inference; L3 proof; index-requirement derivation) → a **shared IR** →
backends `--emit js | rust | tests`. JS and Rust artifacts are
conformance-identical by construction because both are emitted from the same
IR; the reference interpreter of that IR is the oracle and fuzzing
counterpart. Performance targets and the benchmark protocol are tracked
outside this spec (see §10, Q8).
