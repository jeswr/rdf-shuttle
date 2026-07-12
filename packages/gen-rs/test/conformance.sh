#!/usr/bin/env bash
# Full cross-backend conformance identity run:
#   regenerate both artifacts, dump all 22 oracle pairs in 5 modes from the
#   Rust artifact AND the JS artifact, and byte-diff the dumps.
# Byte-identical dumps = quad-set identity in every mode (deterministic
# blank-node allocation on both sides), plus byte-identical serializer output.
# Requires: node >= 18, cargo (any toolchain >= 1.87).
set -euo pipefail
cd "$(dirname "$0")/.."

npm run generate
(cd ../gen-js && npm run generate)

cp generated/turtle12.rs harness/src/turtle12.rs
cp generated/shaclc12.rs harness/src/shaclc12.rs
cp generated/shaclc12ext.rs harness/src/shaclc12ext.rs
(cd harness && cargo build --quiet && cargo test --quiet)

RS_OUT=$(mktemp -d)
JS_OUT=$(mktemp -d)
trap 'rm -rf "$RS_OUT" "$JS_OUT"' EXIT

harness/target/debug/shuttle-rs-harness conf ../../tests/conformance "$RS_OUT"
node test/dump-js.mjs ../../tests/conformance "$JS_OUT"

diff -r "$RS_OUT" "$JS_OUT"
harness/target/debug/shuttle-rs-harness neg
echo "conformance identity: PASS (22 pairs x 5 modes, gen-rs == gen-js)"

rm -rf "$RS_OUT" "$JS_OUT"
mkdir -p "$RS_OUT" "$JS_OUT"
harness/target/debug/shuttle-rs-harness shaclc ../../tests/conformance/shaclc "$RS_OUT"
node test/dump-shaclc-js.mjs ../../tests/conformance/shaclc "$JS_OUT"
diff -r "$RS_OUT" "$JS_OUT"
echo "shaclc conformance identity: PASS (valid+rdf12 x {strict,ext,push-strict,push-ext}, extended accept/strict-reject, negatives; gen-rs == gen-js)"
