# Benchmark harness — generated turtle12 parser vs N3.js

Protocol per the JS-backend plan and spec §10 Q8: same box, same corpus,
one parser per process, `nice -n 18`, best-of-N *and* median reported —
**ratios are the claim, not absolute numbers** (this box is a loaded,
shared 2-core EC2 instance).

```
npm install          # pins the N3.js comparison baseline (see package.json)
node gen-corpus.js   # deterministic corpora (4 MiB / 1 MiB rdf12 / 68 MiB)
node bench-one.js <shuttle|shuttle-array|n3> corpus-ttl11.ttl [runs]
node stream-demo.js corpus-large.ttl <shuttle|n3>
node code-size.js
```

`shuttle` = counting `onQuad` callback (the generated parser's native
interface). `shuttle-array` = materializes a quad array — apples-to-apples
with N3's synchronous `parse(text)` (N3's callback form defers through the
scheduler and cannot be timed synchronously). Both parsers were first
cross-validated on the corpus: identical graphs, 137,610 quads, 0 diffs.

## Results — 2026-07-06, Node v22.23.1, shared 2-core box, n3@1.26.0

4 MiB dense Turtle 1.1 corpus (137,610 quads), 9 runs:

| parser | best ms | median ms | best quads/s | best MB/s |
|---|---|---|---|---|
| n3 (sync array)       | 506 | 598 | 271,904 | 7.9  |
| shuttle-array         | 257 | 294 | 535,336 | 15.6 |
| shuttle (count-only)  | 194 | 223 | 709,441 | 20.6 |

**Ratio, like-for-like (shuttle-array vs n3): 1.97x best / 2.04x median.**
Count-only callback vs N3's sync path: 2.6x best. The honest target from the
design note is 2–4x; the like-for-like number sits at the bottom edge of that
band on this box.

RDF 1.2 corpus (annotations `{| |}`, triple terms `<<( )>>`, reified triples,
`@ar--rtl`): shuttle parses 1 MiB / 32,208 quads at 464k quads/s best;
**n3@1.26.0 errors on the first RDF 1.2 form** — no baseline exists for this
profile yet, which is the point of generating parsers from the pinned grammar.

## Streaming / bounded memory — 68 MiB input, 2,339,370 quads

| parser | wall | quads/s | peak RSS | max bytes retained across chunks |
|---|---|---|---|---|
| shuttle push parser | 3.8 s | 621,554 | 93.4 MiB | **343 bytes** |
| n3 StreamParser     | 6.3 s | 369,498 | 89.4 MiB | n/a |

The push parser holds only the current statement across chunk boundaries
(`peakCarryBytes` — 343 bytes on this corpus, vs 68 MiB of input); peak RSS
is V8 baseline + read-stream buffers + the term-interning caches. RSS parity
with N3 at 1.7x the throughput.

## Code size

| artifact | raw KiB | gzip KiB |
|---|---|---|
| generated `turtle12.js` — parser + push parser + serializer + runtime, **one file, zero deps** | 86.5 | 13.8 |
| n3 `lib/*.js` (lexer+parser+writer+store+reasoner) | 155.8 | 35.0 |
| n3 parser-side share only (Lexer+Parser+DataFactory+Util+IRIs) | 77.8 | 17.3 |
| n3 transitive runtime deps (`readable-stream` tree etc.) | 405.2 | — |

Scope-fair reading: generated parser+writer+factory (86.5 raw / **13.8 gzip**)
vs the equivalent n3 subset (~96 raw / ~21 gzip) — smaller compressed, and no
dependency tree.

## Known noise & caveats

- Loaded shared box: run-to-run spread is ±20%; medians move less than bests.
- The corpus is synthetic (dense, pname-heavy). N-Triples-bulk and
  adversarial deep-nesting corpora from the protocol are not yet wired in.
- N3.js perf is an active parallel effort (rdfjs/N3.js #635, #642–#649);
  re-run against its perf branches before publishing any claim (spec §10 Q8).

## Optimization next steps (concrete, in expected-impact order)

1. **Merged token automaton.** Numbers still scan up to 3 candidate matchers
   (INTEGER/DECIMAL/DOUBLE) per token; fold into one DFA-style scan with
   post-classification, as already done for PNAME_NS⊂PNAME_LN (that
   subsumption alone was worth ~15%).
2. **Keyword dispatch.** `@`-tokens try up to 4 matchers; a two-char dispatch
   (or perfect-hash on the keyword table) removes the cascade.
3. **Allocation.** Literal objects are allocated per occurrence; a span-hash
   literal cache (verify-on-hit, like the pname cache) would help
   repeated-object corpora. Quad objects could optionally be pooled /
   micro-batched behind the onQuad callback.
4. **Value slicing.** Token values are sliced eagerly at consume time even
   when the production only re-concatenates (pnames avoid this via the
   two-level cache; IRIREF and strings could carry (start,end) spans into
   term construction).
5. **Dispatch tables.** `switch (tk)` in hot productions (object/verb) could
   become computed-goto-style jump arrays if V8 profiles show mispredicts.
