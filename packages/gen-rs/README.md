# @rdf-shuttle/gen-rs

The Shuttle **Rust backend**: emits, from a `.shuttle` grammar, ONE
dependency-free `.rs` module containing a streaming parser (text → triples),
a chunked **push parser** (bounded memory, mid-token suspension), and a
serializer (triples → text) — the parse and print modes of the same Shuttle
relation. Sibling of [`gen-js`](../gen-js); both consume the same v0.1
grammar AST (`gen-js/src/meta.js`).

## Generated-artifact contract

- **single file, zero dependencies** (std-only), no build-time codegen in the
  consumer's build graph — consumers check the artifact in and re-generate
  with this package only in a drift-check lane;
- `#![forbid(unsafe_code)]`-compatible (no `unsafe` anywhere);
- MSRV **1.87**, clean under `cargo clippy -- -D warnings` and
  `RUSTDOCFLAGS="-D warnings" cargo doc` (a small documented allow-list of
  *style* lints at the top of the artifact covers generated-code shapes;
  correctness lints all stay on);
- deterministic blank-node allocation (`b0`, `b1`, …) identical to the JS
  backend, so cross-backend conformance is a byte diff, not an isomorphism
  check.

## Architecture

| stage | file | notes |
|---|---|---|
| grammar front end | reused from `gen-js/src/meta.js` | one AST, two backends |
| token analysis | reused from `gen-js/src/lexer-gen.js` | charsets, FIRST, value spans |
| lexer emission | `src/lexer-gen.js` | free `fn m_*(&[u8], usize, &mut Fl) -> isize` matchers; byte-offset spans; ASCII byte fast paths + `cp_at` decode |
| clause language | `src/clausec.js` | concretely typed: `Term`(Rc) / `Rc<str>` / `Option<_>`; split-borrow helper calls |
| productions | `src/parser-gen.js` | `fn p_X(&mut self, …) -> Result<T, PErr>` methods; deferred-init value slots (rustc proves the value obligations); FIRST-set bitmask consts |
| serializer | `src/serializer-gen.js` | stream-pretty writer; guards are full-match calls on the parser's own matchers |
| assembly | `src/generate.js` + `src/runtime.inc.rs` | machine struct, push driver, public API |

Differences from the JS artifact (all documented in the artifact header):

- positions are UTF-8 byte offsets (JS: UTF-16 units) — internally consistent,
  spans never cross the API; error columns count bytes;
- `\uD800`-style lone-surrogate escapes are a `INVALID_CODEPOINT` syntax
  error (JS strings can hold lone surrogates; Rust `String` cannot);
- **no term-interning caches** (the JS backend interns NamedNodes and
  pnames): measured on this backend, per-occurrence owned allocation beats
  both an IRI-interning map and a two-level pname cache on every corpus
  profile tried (repeated-term Turtle, repeated-IRI N-Triples, high-distinct-
  cardinality N-Triples) — hashing costs more than bump allocation in Rust,
  the reverse of the JS GC trade-off. Consumers that want shared terms
  intern downstream (e.g. a dictionary sink on the emit callback); see
  `harness` bench mode for the numbers on your machine.

## Usage

```sh
npm run generate    # turtle12.rs + shaclc12.rs (--profile rdf12) + shaclc12ext.rs (--profile rdf12,ext)
npm test            # node-only artifact checks
test/conformance.sh # full cross-backend identity run (needs cargo >= 1.87)
```

`test/conformance.sh` regenerates both backends, runs the Rust harness and
`test/dump-js.mjs` over the 22 oracle pairs in **5 modes** (parse `.nt`,
parse `.ttl`, plain round trip, abbreviated round trip, 7-byte-chunk push
parse) and byte-diffs the dumps *and* the serialized round-trip bytes.
A seeded-divergence mutation check (e.g. offsetting the fresh-bnode counter)
turns the diff red — the harness is not vacuous.

It then runs the **SHACL-CS legs** (`shaclc` subcommand +
`test/dump-shaclc-js.mjs`): the whole `tests/conformance/shaclc/` corpus —
valid + rdf12 through BOTH profile artifacts in one-shot and 7-chunk push
modes, extended accepted by `shaclc12ext` and **rejected** by the strict
`shaclc12` (the enforcement-leak fix, provable because the ext alternatives
are absent from the strict parse tables), negatives rejected by both — again
as a byte diff against the gen-js artifacts.

### SHACL-CS artifacts

`shaclc12ext.shuttle` exercises the v0.1 constructs beyond the Turtle spine:
`@profile` layers (subtractive: excluded productions become clean
`PROFILE_EXCLUDED` stubs and unreachable subtrees are pruned from the
artifact), the `oracle` clause + `@oracle` finite decision sets (compiled to
a static `matches!`), `emit … when` conditional emission (an `x != none`
guard if-let-narrows the option binding), pair-valued productions
(`(Term, Term)`), option-valued productions (a `value = none` alternative
makes the return type `Option<T>`), env map-literal inits (the five
predeclared prefixes), `import` curie tables, `int()` + comparisons, and the
whole-buffer push fallback for document-shaped start productions — plus the
**residual-consumption printer** (spec §8): `write_triples` /
`print_with_residual` start with the whole graph as a residual, each
printed construct consumes the triples it re-emits on parse, and a
non-empty residual is the typed "not compact-expressible" verdict
(`ResidualError` / `ResidualPrint`). The oracle never runs backward (the
consumed predicate discharges it), the `print {}` defaults regenerate
suppressed bounds, a strict-profile graph carrying extension-layer
constructs residualizes by construction, and the printer's OUTPUT BYTES
are identical to the gen-js printer's on every printable corpus graph
(the `sers`/`sere` dump legs are byte-diffed).

## Consuming the artifact

```rust
mod turtle12; // the checked-in generated file

let (triples, outcome) = turtle12::parse_to_triples(text)?;

let mut p = turtle12::PushParser::new(None, |t| store.insert(t));
for chunk in chunks { p.push(chunk)?; }
let outcome = p.end()?;

let doc = turtle12::write_triples(&triples, &outcome.prefixes)?;
```

`harness/` is the dev-only conformance + bench crate (not published; the
artifact itself has no crate — consumers vendor the single file).
