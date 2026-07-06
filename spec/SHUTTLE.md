# Shuttle — a declarative, RDF-native grammar formalism for RDF concrete syntaxes

**Version:** 0.2 (draft)
**Status:** Working draft for review. Nothing here is stable.
**Design record:** [RFC 0001](../docs/rfc/0001-shuttle-v0.2-design.md) (normative rationale for every decision below).
**Vocabulary:** [`vocab/shuttle.ttl`](../vocab/shuttle.ttl) · **Well-formedness shapes:** [`vocab/shuttle-shapes.ttl`](../vocab/shuttle-shapes.ttl)

> **Supersession notice.** v0.2 supersedes the v0.1 *authoring surface*: the
> `.shu` clause language of semantic blocks, the seven verbs, `env.x := e`,
> `thread … in (…)*`, the blank-node label table, and imperative `fresh` are
> **no longer normative** (§2 shows what replaced each). What **survives
> unchanged** from v0.1: the relational core (one relation, three modes, §1),
> the token/primitive-iso layer (§6), the streaming machine and its laws
> (§7), the print residual-consumption semantics and laws L1–L3 (§8), the
> generate mode (§9), the shared IR and backends (§12), and the scope
> boundary (§13). The v0.1 text of those sections is retained below with
> v0.2 amendments marked. `grammar/shuttle.ebnf`, `grammars/*.shuttle`, and
> the hand-written meta front-end (`packages/gen-js/src/meta.js`) are retired
> as normative objects and kept only as v0.1 reference artifacts for the
> differential gate (§11).

A Shuttle specification of a concrete RDF syntax is an **RDF graph** — a
*module* of pure-attribute-grammar triples in the `shtl:` vocabulary
(namespace `https://w3id.org/shuttle/vocab#`; RFC 0001 writes the same
namespace with the prefix `shu:`). From that graph the toolchain derives,
mechanically:

1. a **streaming parser** (text → quads, single pass, bounded memory),
2. a **serializer** (quads → text, derived from the *same* alternatives,
   never hand-synchronized), and
3. a **conformance test generator** producing (document, expected-quads)
   pairs plus provably-negative syntax tests, in W3C `manifest.ttl` format.

The three artifacts are three *modes* of one denotation, so their mutual
consistency is a theorem checked at compile time. New in v0.2, the grammars
themselves are first-class RDF: **import is named-graph union, extension is
adding a triple, well-formedness is SHACL conformance, and the meta-syntax
is Turtle** — one of the very languages in the lattice (§10).

Target syntaxes: N-Triples, N-Quads, Turtle 1.2, TriG 1.2, SHACL Compact
Syntax, Notation3 (syntax and structural encoding only).

---

## 1. Denotational core: one relation, three modes *(v0.1, surviving)*

Each production `p` denotes a relation

```
R_p  ⊆  Tok* × Tok* × ⟦inh(p)⟧ × Set(Quad) × ⟦syn(p)⟧
```

read as: *consuming a prefix of the token stream, given inherited attribute
values, emitting a set of quads, and synthesizing result values.* (v0.2
amendment: the separately-threaded `Env × Env` pair of v0.1 is now just a
chained attribute inside `inh`/`syn` — §2; the emission accumulator is a
**set** by default, `Bag` under an explicit `shtl:emits shtl:TripleBag`
module.)

Three modes are **derived** from `R_p` by choosing which components are
ground:

| Mode | Ground | Free | Discipline |
|---|---|---|---|
| **parse** | text | quads, value | deterministic LL(k≤2), single pass, streaming |
| **print** | quads | text | residual-multiset consumption, prioritized alternatives, policy-refined |
| **generate** | nothing | text *and* quads | weighted, depth-bounded, coverage-directed enumeration |

The compiler proves the properties each mode needs — LL determinism,
L-attributedness/earliest emission, print totality (law L3), token
round-trip obligations — or **rejects the grammar with a counterexample**.
A grammar edit that silently breaks streaming or printing fails the build.

---

## 2. The declarative model (every imperative v0.1 construct, removed)

A v0.2 module denotes, for each IRI-named nonterminal, a typed attribute
signature `inh(N)`/`syn(N)` and a set of alternatives. Each alternative
carries:

1. an **ordered syntax row** (`shtl:items`, a closed `rdf:List`) — the ONE
   ordered thing, because concatenation is ordered;
2. an **unordered set of pure equations**, one per defined attribute
   occurrence, statically checked acyclic and single-assignment; an *absent*
   equation is a Knuth **copy rule**;
3. an **unordered set of triple templates** ⟨s,p,o[,g][,when]⟩ with
   SPARQL-CONSTRUCT semantics;
4. an **unordered set of constraints** (`require` → diagnostic resources
   with stable error codes; emptiness of the auto-unioned diagnostics
   attribute defines validity);
5. **Skolem binders** (`shtl:let` with a `shux:Skolem` expression).

The meaning of a document is the **unique solution of the equation system
on its LL-deterministic parse tree**; the emitted graph is the set union of
template instances over the tree. Parse/print/generate remain the three
groundness modes of §1.

### 2.1 Correspondence: v0.1 construct → v0.2 replacement

| v0.1 (imperative, superseded) | v0.2 (declarative) |
|---|---|
| `env.x := e`, threaded `Env × Env` | one `shtl:chain env : Env` declaration per module; the statement spine threads it via **generated** copy rules; a directive is one equation `envOut = update(env, prefixes, bind(env.prefixes, ns, resolve(env.base, i)))`; a triples statement contributes the identity |
| `thread v : T = init in (…)*` | structural recursion over the right-recursive chain nonterminal the repetition desugars to; collections are the natural unfold (cons cell: `let cell = Skolem`, templates `cell rdf:first o` / `cell rdf:rest tail.head`); authors may write `fold` sugar, macro-defined to exactly this chain |
| pending-reifier `pend :=` / reset | an inherited `SubjT?` parameter of the annotation chain — scope safety is lexical (the attribute exists only on the chain), not a reset discipline |
| blank-node label table (`labels` env field, push/pop) | deleted: `_:x` denotes the pure term `skolem(scope, "x")` over an inherited `scope` attribute (constant doc scope for Turtle; the formula's own Skolem for N3 — push/pop becomes one parameter equation) |
| imperative `fresh` / `fresh()` counter | `shux:Skolem` nodes denoting `bnodeAt(derivation-path, k)`; deterministic `_:b0, _:b1 …` labels are recovered because document-order enumeration of Skolem positions is a bijection — the compiler fuses the Skolem function back into v0.1's counter, now a *correct implementation of a pure semantics* |
| ordered `{c1; c2}` blocks, seven verbs | four order-free categories: equations (`value`/`let`/env), templates (`emit`+`when`), constraints (`require`), Skolems (`fresh`); `oracle` is a declared pure decidable predicate; `e ?? d` is the total `shtl:otherwise` over option types |
| `term!` special SemType (NOTE 2) | dissolved: any production may synthesize any term-algebra subtype AND carry templates — value-plus-emissions is just syn typing plus template presence, checked by SHACL positional typing |
| `skip WS, COMMENT ;` header prose (NOTE 1) | `shtl:skip true` on the terminal — ordinary module data, unioned up the lattice, functional per terminal |
| `// rdf12`-commented gating (NOTE 3) | the module boundary itself: `mod:turtle11` is a real graph; remaining carvings are `shtl:Profile`s |
| loose print-guard prose (NOTE 4) | the closed, IRI-identified guard vocabulary with declared `shtl:requiresIndex` (§8) |

### 2.2 Streaming reconciliation

Order-freedom *licenses* streaming: since the denotation is a set, any
emission order is correct, so the compiler picks the earliest, via four
derived analyses replacing v0.1's authored discipline:

- **(a) L-attributedness check** per alternative over the equation
  dependency graph (classic ordered-AG test; failure yields the offending
  cycle; `shtl:buffered true` is the visible opt-out);
- **(b) groundness-point analysis** per template, with *prediction-time
  synthesis*: attributes computable from clause selection + constants +
  Skolems + inherited attributes are ground at the callee's **first token**
  — this is why `cell rdf:rest tail.head` fires as each element closes, and
  why Skolem pre-availability lets v0.2 emit `:s :p _:c0` at `(` — one
  token *earlier* than v0.1's hand-placed emit;
- **(c) linearization:** tail-recursive chains compile to loops
  (`O(depth + |env| + token)` memory); single-threaded chained attributes
  compile to one in-place record — the compiler *introduces* the mutation
  v0.1 made authors write; genuinely duplicated envs (N3 formulae) fall
  back per-field to an O(1)-amortized undo log;
- **(d) Skolem→counter fusion.**

Every production **exports** a `shtl:strictness` class —
`shtl:Immediate | [a shtl:AfterTokens; shtl:k n] | shtl:AtEnd` — that
deltas must keep: a caller's schedule depends only on callees' strictness
classes, never their clause lists, so **schedule stability under extension
is contractual** (§5).

---

## 3. The RDF term algebra (RDF 1.2, positionally typed) *(v0.1, surviving; now first-class RDF)*

```
type dir     = ltr | rtl
type term    = iri(abs) | bnode(id)
             | literal(lex, dt, lang?, dir?)
             | tt(s: subjT, p: iri, o: term)          // triple term; nests via o only
             | var(name)                              // n3 modules only
type subjT   = iri | bnode
type graphT  = default | iri | bnode | formula(id)    // formula: n3 modules
quad = (subjT, iri, term, graphT)
```

v0.2 amendment: the subtype lattice is **first-class RDF** in the
vocabulary — `shtl:Iri ⊑ shtl:SubjT ⊑ shtl:Term`, `shtl:TripleTermT ⊑
shtl:Term` and `owl:disjointWith shtl:SubjT`, `shtl:Iri/shtl:BnodeT ⊑
shtl:GraphT` — and template positions are typed against it by SHACL
(`shtl:s ⊑ SubjT`, `shtl:p ⊑ Iri`, `shtl:o ⊑ Term`, `shtl:g ⊑ GraphT`),
validated over the merged import closure **before the compiler runs**.
Constructor invariants survive verbatim:

- `lang` without `dir` forces `rdf:langString`; `lang` + `dir` forces
  `rdf:dirLangString`; `"x"@en^^dt` stays unlexable by clause shape.
- `shux:tt : (SubjT, Iri, Term) → TripleTermT` — a triple term in subject
  or predicate position is a **type error on the grammar graph itself**;
  object-only nesting is a subtype fact.
- **Lexical fidelity:** literal lexical forms are preserved verbatim
  (Turtle's `0.9` is `literal("0.9", xsd:decimal)`, never a host float).

Constructor signatures are triples (`shux:tt shtl:sig (shtl:SubjT shtl:Iri
shtl:Term); shtl:returns shtl:TripleTermT`), so deltas can only **add**
constructors — RDF 1.1 modules compile unchanged against RDF 1.2 closures.

---

## 4. The `shtl:` grammar vocabulary (grammars ARE RDF)

Namespaces: `shtl:` = `https://w3id.org/shuttle/vocab#` (ontology in
[`vocab/shuttle.ttl`](../vocab/shuttle.ttl), itself an importable module
`mod:shu-ontology`), `shux:` = `https://w3id.org/shuttle/expr#`
(expressions), modules under `https://w3id.org/shuttle/mod/`.

A module is a **named graph whose name is the module IRI**. Extensible
resources — productions, alternatives, templates, terminals, tests,
policies, isos — MUST be IRI-identified; blank nodes are legal only for
non-extensible internals (items, expressions, attribute declarations).
SHACL-enforced.

| Layer | Resources & predicates |
|---|---|
| **module** | `shtl:Module`; `shtl:imports` (⊑ `owl:imports`, acyclic DAG, semantics = named-graph union of the transitive closure, compiled only against a hash-pinned lockfile); `shtl:Profile` ⊑ Module with `shtl:profileOf`/`excludes`/`includesOnly`; `shtl:start`; `shtl:specRef` (mandatory spec pin); `shtl:emits` (TripleSet\|QuadSet\|TripleBag\|QuadBag); `shtl:chain` (declares a chained attribute threaded by generated copy rules) |
| **syntax** | `shtl:Production` (`shtl:inh`/`shtl:syn` → `shtl:AttrDecl` [`name`,`type`,`default`]; `shtl:strictness` — the exported streaming contract; `shtl:buffered`); `shtl:Alternative` with `shtl:alternativeOf` (**THE extension point: an OPEN predicate** — a production's alternative set is whatever the import closure asserts); `shtl:items` (closed `rdf:List` — order lives here only); items `shtl:Lit(text)`, `shtl:TerminalRef(terminal)`, `shtl:NonterminalRef(calls,args,bind)`, `shtl:Opt/Star/Plus/SepList(of,sep)`, each with a normative desugaring into fresh right-recursive productions; `fold` sugar likewise |
| **semantic** | `shtl:Equation` (`onAlternative`, `target` [own-attr string or `shtl:Occurrence(ofItem,attr)`], `expr`, `otherwise`); **absent equation = copy rule**; `shtl:TripleTemplate` (`onAlternative` — open — `s`,`p`,`o`,`g` [default: inherited g],`when`); `shtl:Constraint` (`test`,`errorCode`); `shtl:let` → `shtl:LetBinding`; expressions `shux:App(fn,args)`, `shux:AttrRef(item,attr)`, `shux:VarRef(name)`, `shux:Case`, `shux:Skolem` (explicit node — never a bare blank node); constants are the RDF terms **themselves** (`rdf:first` in a template is the IRI `rdf:first`) |
| **terminal** | `shtl:Terminal` (`shtl:pattern` — anchored `shtl:regex` literal + optional `structuredPattern`; functional, one per closure); `shtl:fragment`; `shtl:skip`; `shtl:valueIso`/`unparseIso` → `shtl:Iso` (`forwardFn`,`backwardFn`,`lossy`+`canonicalizer`); `shtl:extendsTerminal` (declared language-superset obligation, checked by lexical conservativity); `shtl:reservedAgainst` (tie-breaks as queryable triples) |
| **print** | `shtl:prefer` (rank on alternatives); `shtl:printGuard` → the **closed, IRI-identified guard vocabulary** (`shtl:listShaped`, `shtl:freshSingleUse`, `shtl:reifiesQuadPresent`, `shtl:needsLongQuoting`, `shtl:abbreviable`), each declaring `shtl:requiresIndex`; `shux:And/Or/Not` compositions; `shtl:PrintPolicy` (`orderBy`, `groupBySubject`, `prefixMining`, `directivePlacement`, `layout`); guard-free fallbacks live in the **least module declaring the production** |
| **test** | `shtl:TestSuite` ⊑ Module (`suiteFor`; Suite(M) = tests of the import closure); `shtl:EvalTest`/`PositiveSyntaxTest`/`NegativeSyntaxTest` ⊑ `rdft:` classes with `mf:action`/`mf:result` reused verbatim; `shtl:negativeScope` (`ThisLanguage` default \| `Hereditary`); `shtl:negativeFor` (mechanical re-tagging); `shtl:resultLift` (`[shtl:onSuite S; shtl:lift shtl:IntoDefaultGraph]`) |
| **reflective** | `shtl:MonotoneProperty` (extension may add: `alternativeOf`, `onAlternative`, inh-fields-with-defaults, `suiteFor`, prefer-ranked candidates, guards, tests, terminals, constructors) vs `shtl:FunctionalGrammarProperty` (at most one per closure: pattern per terminal, equation per occurrence, synthesized type per production, strictness, guard-free fallback per group) — **the vocabulary classifies its own predicates**; violations are hard errors reported **with both named graphs** |

Worked fragment (the collection cons cell — the structural-recursion pair
replacing v0.1's `thread prev`):

```turtle
ttl:cellChain a shtl:Production ;
  shtl:syn [ shtl:name "head" ; shtl:type shtl:Term ] ;
  shtl:strictness [ a shtl:AfterTokens ; shtl:k 1 ] .

ttl:cellChain-cons a shtl:Alternative ;
  shtl:alternativeOf ttl:cellChain ;
  shtl:items (
    [ a shtl:NonterminalRef ; shtl:calls nt:object    ; shtl:bind "o" ]
    [ a shtl:NonterminalRef ; shtl:calls ttl:cellChain ; shtl:bind "t" ]
  ) ;
  shtl:let [ shtl:name "cell" ; shtl:expr [ a shux:Skolem ] ] ;
  shtl:eq  [ shtl:target "head" ; shtl:expr [ a shux:VarRef ; shux:name "cell" ] ] .

ttl:cc-first a shtl:TripleTemplate ;
  shtl:onAlternative ttl:cellChain-cons ;
  shtl:s [ a shux:VarRef ; shux:name "cell" ] ;
  shtl:p rdf:first ;
  shtl:o [ a shux:AttrRef ; shux:item "o" ; shux:attr "value" ] ;
  shtl:g [ a shux:AttrRef ; shux:attr "g" ] .

ttl:cc-rest a shtl:TripleTemplate ;
  shtl:onAlternative ttl:cellChain-cons ;
  shtl:s [ a shux:VarRef ; shux:name "cell" ] ;
  shtl:p rdf:rest ;
  shtl:o [ a shux:AttrRef ; shux:item "t" ; shux:attr "head" ] ;
  shtl:g [ a shux:AttrRef ; shux:attr "g" ] .
```

Note the deliberate ouroboros: `shtl:items` uses the very
`rdf:first`/`rdf:rest` cells the collection production defines.

### 4.1 Well-formedness = SHACL conformance

A grammar graph is **well-formed iff its merged import closure conforms to
[`vocab/shuttle-shapes.ttl`](../vocab/shuttle-shapes.ttl)** (`mod:shu-shapes`)
— checkable by *any* RDF stack with zero Shuttle tooling. The shapes encode:

- **arities** (every layer: one `alternativeOf` + one `items` per
  alternative, one `calls` per ref, one `pattern` per terminal, s/p/o
  exactly once per template, …);
- **one-equation-per-occurrence** and single-assignment lets (the pairwise
  FunctionalGrammarProperty conflicts, reported on the alternative);
- **acyclicity / L-attributedness as a shape**: argument expressions on a
  call, and equations targeting an inherited occurrence, may reference only
  items strictly to the LEFT of that call; degenerate self-reference cycles
  are rejected at the data level;
- **positional term typing incl. RDF 1.2**: constructed values in `shtl:s`
  must return ⊑ `SubjT` (so `shux:tt` in subject position is a SHACL
  violation — object-only nesting of triple terms is checked on the grammar
  graph), `shtl:p` ⊑ `Iri` (no literal or bnode predicates), `shtl:g` ⊑
  `GraphT`;
- **Skolem linearity** (structural half): a `shux:Skolem` node is the
  `shtl:expr` of exactly one binder, never inline, never shared;
- **IRI-on-extensible-resources** (productions, alternatives, templates,
  terminals, tests, policies, isos).

The deeper theorems — LL(k≤2) disjointness against imported FIRST
summaries, strictness-contract preservation, L3 totality, lexical
conservativity, full ordered-AG cycle analysis — sit **above** the shapes,
in the compiler, which consumes the same graph.

---

## 5. Modules, imports, and the subset lattice

**Mechanism.** Module = named graph; `shtl:imports` = transitive
named-graph union (idempotent, so the TriG diamond over N-Triples is free);
compilation always against a **hash-pinned lockfile** (graph IRI → content
hash) closing RDF's open world into a sound compile unit. Each compiled
module exports an **interface summary graph** (per-production FIRST/FOLLOW
contributions, strictness classes, attribute-dependency summaries,
groundness frontiers, token automaton, print-guard index needs, context-row
type, content hash), so composition is summary-based and incremental.

**Extension is monotone triple-addition ONLY:** new alternatives on visible
production IRIs, templates on your OWN alternatives, terminals,
constructors, chain-field widenings with defaults (imported equations never
mention new fields, so they lift via copy rules unchanged; env compiles to
a single record pointer, so imported *compiled* code is ABI-stable —
N-Triples' compiled productions serve Turtle unmodified), prefer-ranked
guarded print candidates, tests. **No override of any kind exists in v0.2
core.** Where the subset relation forces a shape change (the statement
seam), the lattice bottom is **pre-factored** instead: `nt:statement ::=
subject predicateObjectList '.'` with N-Triples' predicateObjectList having
exactly one degenerate alternative (`verb object`) — same language,
W3C-Turtle-shaped spine — and Turtle adds the `;`/`,` chain alternatives
monotonically.

**Four delta-checked contracts** make extension safe:

1. **LL(k≤2) disjointness** of new alternatives against imported FIRST
   summaries (fail = counterexample naming both alternative IRIs and home
   graphs; imported parses are bitwise identical — never silent reshaping);
2. **lexical conservativity:** the merged token DFA must tokenize the
   imported token language identically (LANG_DIR ⊒ LANGTAG passes);
3. **strictness contracts:** a new alternative binding the synthesized
   value later than the production's declared class is rejected *at the
   delta* — no import can demote a streaming production to buffered;
4. **L3 stability:** guard-free fallbacks are pinned to the least declaring
   module and survive any extension.

**Restriction** only via `shtl:Profile`: `excludes`/`includesOnly` may
remove only *sugar* (never a guard-free fallback ⇒ L(profile) ⊆ L(base) and
print totality automatic), no dangling references, profiles import only
profiles. Prefer-ties across diamonds are a hard conflict, resolved
explicitly, never silently.

**The lattice.**

```
mod:rdf-terms  (term algebra, isos, guard vocabulary, shapes — defined ONCE)
   └─ mod:ntriples11   terminals IRIREF/STRING_LITERAL_QUOTE/BLANK_NODE_LABEL/LANGTAG
      │                + WS/COMMENT skips; pre-factored spine; ONE template ⟨s,p,o,@g⟩
      │                (inherited g : GraphT defaults to shtl:defaultGraph);
      │                canonical one-line print policy; ntriples11-tests
      ├─ mod:turtle11  = ntriples11 + Δ: PNAME/ANON/number/boolean/string terminals;
      │                  chain env gains prefixes+base (row widening, zero edits);
      │                  directives (pure env equations); pOL/objectList chains,
      │                  collections, bnpl — each ADDED to imported choice points;
      │                  prefer/guards on sugar — the imported N-Triples alternatives
      │                  ARE the guard-free fallbacks: THE LATTICE IS THE L3 CHAIN
      ├─ mod:nquads11  = ntriples11 + graph-labels: one production delta (optional
      │                  graph label); ZERO semantic delta — the template was
      │                  quad-shaped all along; module-closed constant folding keeps
      │                  the Turtle artifact free of the graph slot
      ├─ mod:trig11    = turtle11 + nquads11 (diamond free): wrappedGraph + GRAPH;
      │                  every Turtle template streams into TriG unmodified (all were
      │                  parametric in g); the W3C bare-4-column discrepancy is the
      │                  trig-w3c PROFILE excluding nq:statement — one triple, not a fork
      ├─ mod:n3        = turtle11 + n3-terms (Var, Formula(scope) ⊑ GraphT): formulae
      │                  are two inherited-field updates; QUICK_VAR; paths desugar to
      │                  fresh-object chaining (streamable by construction); '=>'
      │                  sugars log:implies
      └─ RDF 1.2 as a delta layer: mod:rdf12-terms (tt, dirLangString, LANG_DIR
                         extendsTerminal LANGTAG) shared by all four line/sugar
                         syntaxes; ntriples12 = ntriples11 + rdf12-terms + (tripleTerm,
                         object-tt alternative, LANG_DIR); turtle12 = turtle11 +
                         ntriples12 + (reifiedTriple, reifier, annotationChain with
                         inherited pend, version directive as one env equation);
                         nquads12/trig12 likewise
```

**Coherence theorems** (compiler-checked, both directions of every edge):
`profile(turtle12 − rdf12Δ) ≡ turtle11`; `profile(turtle11, fallbacks-only)
≡ ntriples11` (plus a language-equivalence test against the W3C N-Triples
EBNF, discharging the pre-factoring fidelity risk); `profile(trig12,
no-braces) ≡ nquads12`.

**Tests accrete UP:** `turtle11-tests` imports `ntriples11-tests` — every
(doc, expected) pair runs verbatim against the Turtle parser because
extension is conservative (checked: no templates on alternatives reachable
in the imported language; violations need an explicit
`shtl:nonConservative` flag). Crossing a triples→quads edge declares
`shtl:resultLift shtl:IntoDefaultGraph` (`.nt` results reinterpreted as
`.nq` in the default graph — the lattice pays for its own test
infrastructure). **Negatives:** `shtl:ThisLanguage` (default) accretes down
profile edges only and is mechanically re-decided by LL-table membership in
supersets, re-tagged `shtl:negativeFor`; `shtl:Hereditary` negatives
(`"x"@en^^dt`) are re-verified against every composed superset.

**Name resolution:** all names are IRIs; no scoping, shadowing, or import
renaming; file-local prefixes are cosmetic; dangling IRI = compile error
naming the missing module; "the definition" of a resource = the triples
about it in the pinned closure, with named-graph provenance on every
conflict report.

**Net result:** every syntax in the family is import + small delta; nothing
is defined twice; the W3C-suite anchor for N-Triples is paid once and
inherited by every superset; serializer sharing is free (§8); a W3C WD
change lands as an edit to exactly one module and propagates by import.

---

## 6. Terminals and primitive isos *(v0.1, surviving; now module data)*

Tokens are **strictly regular**; each terminal is an IRI-named resource
with an anchored `shtl:pattern` regex (optional structured form for
auditing) and `shtl:valueIso`/`shtl:unparseIso` transducers.

Value transducers are built from a closed set of **primitive isos** —
`resolve/relativize`, `expandPName/abbreviate`,
`unescapeString/escapeString(quoteStyle)`, `unescapeU`, `langCanon` — the
trusted leaves of the system, IRI-identified in `mod:rdf-terms`. They ship
once per toolchain as an audited runtime library with property-tested
round-trip obligations (`fwd ∘ bwd = id` on the print domain), plus
differential tests against a reference implementation before a release may
serve as a conformance oracle. Non-injective transducers are declared
`shtl:lossy` with a `shtl:canonicalizer`.

The token automaton is a suspendable longest-match DFA: chunk boundaries
suspend mid-token, retaining only the incomplete token. **Honest lexing**
survives: contextual resolution (`<` vs `<<` vs `<<(`, `@prefix` vs LANGTAG,
PN_LOCAL trailing dot) is declared in terminal data (`shtl:reservedAgainst`
tie-breaks as queryable triples), exactly where the W3C specs resolve it in
prose. v0.2 additions: `shtl:skip` is unioned module data (a module cannot
flip an imported terminal's skip status), and `shtl:extendsTerminal`
declares language-superset obligations (LANG_DIR ⊒ LANGTAG) checked by
lexical conservativity on the merged DFA.

---

## 7. Parse mode: the L-attributed streaming discipline *(v0.1, surviving; checks now derived)*

The central compile-time theorem is unchanged:

> Every attribute is computable in a single left-to-right pass **iff** every
> template fires at the earliest point its arguments are ground.

v0.2 derives the schedule from the four analyses of §2.2 instead of an
authored discipline, and freezes it across module composition via exported
`shtl:strictness` classes. The generated parser is recursive descent
compiled to an **explicit-stack resumable machine**:

- quads leave the parser the instant their arguments are ground (Skolem
  pre-availability makes collection/bnpl subjects available one token
  earlier than v0.1);
- memory is `O(depth + |env| + longest token)`;
- push-mode / chunked input, mid-token suspension (§6);
- immune to host-stack overflow; depth bounds enforced by the machine.

**Laws (parse):** deterministic; total on the token language; streaming as
above; **stable under import** (a delta can add alternatives but never
reschedule imported emission).

---

## 8. Print mode: the serializer, derived *(v0.1, surviving; guards now IRIs, sharing via the lattice)*

The serializer is the **backward reading** of the same alternatives.
**Residual-consumption semantics** (unchanged): printing a graph `G` starts
with `G` as a residual multiset; each template consumes exactly one
matching quad; Skolem sites are linear blank-node matches; repetitions
become match-driven iteration; alternatives are tried in `shtl:prefer`
order subject to `shtl:printGuard` guards, ending at the guard-free
fallback. **Print succeeds iff the residual empties.**

**Laws.**

- **L1** `parse(print(G, π)) ≅ G` for every policy `π` (graph isomorphism).
- **L2** `parse ∘ print ∘ parse = parse`.
- **L3** (totality) every prioritized group ends guard-free — and in v0.2
  the **lattice IS the L3 chain**: the imported N-Triples alternatives are
  the guard-free fallbacks of every superset, so "canonical N-Triples
  output of any Turtle graph" is just printing under the ntriples profile.
  For SHACL-C, print failure remains the *correct* verdict "not
  SHACL-C-expressible", reported with the non-empty residual.
- Byte-level round-tripping is explicitly **not** promised (lexical forms
  of literals are preserved; layout is not).

**Guards** are the closed, IRI-identified vocabulary of §4 (home module
`mod:print-core`): each guard declares `shtl:requiresIndex`, so the
compiler derives **exactly which indexes** the closure's guards need and
emits that as the store interface (batch-pretty), while stream-pretty
evaluates guards against the subject window only and falls back to L3 when
non-local evidence is missing. Extensions may mint new guard IRIs with
declared index needs — monotone and summary-graph-visible.

**Policies** are modules that refine, never redefine (`shtl:PrintPolicy`:
ordering, grouping, prefix mining, directive placement, layout skeleton);
pretty-policy refines canonical-policy; restriction can only lose branches,
so a profile's printer is total and only faster. **Duplicate quads:** set
semantics is normative for the laws; line-oriented profiles may declare
`shtl:emits shtl:TripleBag`/`shtl:QuadBag`; test accretion across a
set/bag edge applies direction-of-accretion coercion explicitly.

---

## 9. Generate mode: conformance pairs *(v0.1, surviving; suites are modules)*

The generator runs the relation with nothing ground, threading the same
chained attributes forward — pnames are drawn only from declared prefixes,
base resolution is live, Skolem scopes are live — so generated documents
are semantically valid **by construction**.

- **Coverage-directed** over (production × alternative × token-boundary
  bucket × print-guard both ways).
- **Boundary-biased token sampling:** escape classes, surrogate-adjacent
  codepoints, PN_LOCAL dot/colon/percent hazards, long-string quote runs.
- **Deterministic:** Skolem enumeration yields `_:b0, _:b1, …`; pairs are
  reproducible from a seed; automorphism-free graphs keep the isomorphism
  check linear.

**Negative tests**, two provably-sound families (unchanged): LL-table
mutants (provably outside the language, verified against the compiled parse
mode) and semantic negatives per `shtl:errorCode`. v0.2 adds the scoping
data model: `shtl:negativeScope` and mechanical `shtl:negativeFor`
re-tagging up the lattice (§5).

**Output:** W3C-format `manifest.ttl` plus (document, expected) pairs —
suites are `shtl:TestSuite` modules importing `mf:`/`rdft:` verbatim, so
existing rdf-tests harnesses consume them unchanged, and W3C manifests
import directly into the suite lattice.

**Trust anchor** (unchanged): the slow reference interpreter of the
compiled IR must replay the official W3C rdf12 suites before a Shuttle spec
is used as an oracle.

---

## 10. Self-hosting & reflective closure

Two loops, one grounded bootstrap, all CI-checked.

**Loop 1 — grammars are RDF, and Turtle is in the lattice:** a v0.2 grammar
IS a `shtl:` graph normally written in Turtle, so "parse a grammar" = run
the parser generated from `mod:turtle12` (itself one of these graphs) and
SHACL-validate against `mod:shu-shapes`. **The meta-syntax IS Turtle**;
grammar well-formedness = SHACL conformance (§4.1), checkable by any RDF
stack with zero Shuttle tooling.

**Loop 2 — the `.shu` authoring surface is an ordinary module:**
`mod:shu-surface` is a Shuttle grammar whose *emitted triples* are the
`shtl:` grammar graph (text→RDF like any other syntax), and whose derived
printer is the canonical graph→`.shu` pretty-printer — never
hand-synchronized; any surface feature must have an RDF projection by
construction. Self-test: `parse_shu(shu-surface.shu) ≅ ⟦mod:shu-surface⟧`.

**Bootstrap order** (finite, explicit trusted base):

- **Stage 0** — a tiny hand-written N-Triples reader plus the v0.1
  reference IR interpreter load the distribution's module graphs shipped in
  canonical N-Triples (the most restricted lattice point is the bootstrap
  format — itself a lattice statement): `ntriples12.nt`, `turtle12.nt`.
- **Stage 1** — compile and generate the Turtle parser; re-read every
  module in its normative `.ttl` form; check seed-parsed graph ≅
  self-parsed graph (trusting-trust cross-check).
- **Stage 2** — regenerate all artifacts from the re-read graphs; check the
  **fixpoint**: stage-2 compiled IR bit-identical to stage 1.

**Shipped closure tests** (in the conformance suite, run in CI):
(1) quine round-trip `parse_turtle12(print_turtle12(G_turtle12)) ≅
G_turtle12`; (2) the stage-2 bootstrap fixpoint; (3) meta-shape
self-application: `mod:shu-shapes` validates its own graph and
`mod:shu-ontology`'s; (4) the v0.1↔v0.2 differential gate (§11).

Self-hosting thereby stops being v0.1's aspirational Q7 exit criterion and
becomes a **standing build invariant**; the trusted base narrows to the
stage-0 N-Triples reader + the audited primitive-iso library, and is stated
as such (threat model).

**Reflective dividends:** grammars, deltas, tests, policies, and analysis
*outputs* (conflict reports, derived strictness, coverage maps — emitted as
annotation graphs) are all RDF in one queryable dataset — "which
alternatives of `nt:object` did trig12 add and which tests cover them" is a
SPARQL query; grammar diffs are graph diffs; spec pins are provenance;
third-party extension needs no package manager beyond w3id-dereferenced,
hash-pinned graphs.

---

## 11. Performance & the v0.1 differential gate

The RDF grammar graph is **compile-time only**: graph → SHACL → AG analyses
→ the *unchanged* v0.1 shared IR (explicit-stack resumable machine,
suspendable token DFA, reverse match plans) → existing backends
(`gen-js`, …). Module structure is **erased before codegen**: the composed
artifact is bit-identical whether authored monolithically or as a union of
deltas (module-erasure guarantee), and module-closed constant folding drops
the graph slot from the Turtle parser.

CI obligations:

- the **v0.1↔v0.2 IR α-equivalence gate**: v0.1 `turtle12.shuttle` and the
  v0.2 turtle12 module graph must lower to α-equivalent IR (same states,
  same emit sites modulo the earlier Skolem emissions);
- the pinned **Q8 benchmark harness** re-run per composed artifact
  (turtle12, trig12) against a **stated N3.js version** — the baseline
  moves with the live N3.js perf series, so the claim is re-earned per
  release.

---

## 12. Derived-artifact contract (informative summary) *(v0.1, surviving; front-end swapped)*

Pipeline: load hash-pinned module closure → SHACL well-formedness
(`mod:shu-shapes`) → AG analyses (L-attributedness/earliest-emission;
copy-rule elision; chain linearization; Skolem fusion) → grammar analysis
(desugaring, left-factoring, FIRST/FOLLOW, LL(k≤2) tables with conflict
counterexamples; token DFA with longest-match resolution; delta contracts
i–iv of §5) → print analysis (reverse match plans; guard index derivation;
L3 proof) → the **shared IR** (unchanged from v0.1) → backends
`--emit js | rust | tests`. JS and Rust artifacts are
conformance-identical by construction because both are emitted from the
same IR; the reference interpreter of that IR is the oracle and fuzzing
counterpart.

---

## 13. Scope boundary (declared, not discovered later) *(v0.1, surviving)*

- **JSON-LD:** the surface JSON is expressible; the triple mapping is
  algorithmic and out of core. The honest offering remains a fixed-context
  profile (deferred).
- **HDT:** a binary format, not a grammar problem — excluded.
- **N3 logic** (`log:implies`, quantifier meaning): downstream of quad
  emission — Shuttle covers N3 syntax and structural encoding only.

---

## 14. Open questions

Carried in [RFC 0001 §"Open questions"](../docs/rfc/0001-shuttle-v0.2-design.md)
(ranked by risk): pre-factoring fidelity of the N-Triples spine; N3 LL(2)
sufficiency; performance evidence against a pinned N3.js; conservativity
approximation ergonomics (`shtl:nonConservative`); strictness granularity
(is AfterTokens(k) the right contract lattice); lockfile/w3id versioning
operations; diamond prefer-ties; bag/set coercion at accretion edges;
bootstrap trust statement.
