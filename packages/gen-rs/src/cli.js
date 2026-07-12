#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { generateModule } from './generate.js';

const args = process.argv.slice(2);
let out = null;
let grammar = null;
let profiles = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-o') out = args[++i];
  else if (args[i] === '--profile') profiles = args[++i].split(',').map((s) => s.trim()).filter(Boolean);
  else grammar = args[i];
}
if (!grammar) {
  console.error('usage: shuttle-gen-rs <grammar.shuttle> [-o out.rs] [--profile a,b]');
  process.exit(2);
}
const text = fs.readFileSync(grammar, 'utf8');
const { code } = generateModule(text, grammar, { profiles });
if (out) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, code);
  console.error(`wrote ${out} (${code.length} bytes)`);
} else {
  process.stdout.write(code);
}
