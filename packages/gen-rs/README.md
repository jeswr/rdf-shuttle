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
  error (JS strings can hold lone surrogates; Rust `String` cannot).

## Usage

```sh
npm run generate    # grammars/turtle12.shuttle -> generated/turtle12.rs
npm test            # node-only artifact checks
test/conformance.sh # full cross-backend identity run (needs cargo >= 1.87)
```

`test/conformance.sh` regenerates both backends, runs the Rust harness and
`test/dump-js.mjs` over the 22 oracle pairs in **5 modes** (parse `.nt`,
parse `.ttl`, plain round trip, abbreviated round trip, 7-byte-chunk push
parse) and byte-diffs the dumps *and* the serialized round-trip bytes.
A seeded-divergence mutation check (e.g. offsetting the fresh-bnode counter)
turns the diff red — the harness is not vacuous.

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
