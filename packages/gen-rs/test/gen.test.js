/**
 * gen.test.js — node-only checks on the emitted Rust artifact (the full
 * cross-backend conformance identity run, which additionally needs cargo,
 * is test/conformance.sh).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateModule } from '../src/generate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GRAMMAR = path.join(HERE, '..', '..', '..', 'grammars', 'turtle12.shuttle');

const { code, grammar } = generateModule(fs.readFileSync(GRAMMAR, 'utf8'), GRAMMAR);

test('generates a turtle12 module', () => {
  assert.equal(grammar.name, 'turtle12');
  assert.ok(code.length > 50_000);
});

test('artifact is dependency-free (std-only imports)', () => {
  const uses = [...code.matchAll(/^use ([a-z_]+)::/gm)].map((m) => m[1]);
  assert.ok(uses.length > 0);
  for (const u of uses) assert.equal(u, 'std', `non-std import: ${u}`);
  assert.ok(!/extern crate/.test(code));
});

test('artifact contains no unsafe code', () => {
  // the only permitted occurrence is the doc-comment mention of forbid()
  const nonDoc = code.split('\n').filter((l) => !l.trimStart().startsWith('//'));
  assert.ok(!nonDoc.some((l) => l.includes('unsafe')), 'unsafe outside comments');
});

test('public API surface is present', () => {
  for (const item of ['pub fn parse<', 'pub fn parse_to_triples', 'pub struct PushParser',
    'pub struct Writer', 'pub fn write_triples', 'pub enum Term', 'pub struct Triple',
    'pub struct SyntaxError', 'pub struct ParseOutcome']) {
    assert.ok(code.includes(item), `missing: ${item}`);
  }
});

test('checked-in generated artifact is current', () => {
  const checked = fs.readFileSync(path.join(HERE, '..', 'generated', 'turtle12.rs'), 'utf8');
  assert.equal(checked, code, 'generated/turtle12.rs is stale — run npm run generate');
});
