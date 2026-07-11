#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { generateModule } from './generate.js';

const args = process.argv.slice(2);
let out = null;
let grammar = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-o') out = args[++i];
  else grammar = args[i];
}
if (!grammar) {
  console.error('usage: shuttle-gen-rs <grammar.shuttle> [-o out.rs]');
  process.exit(2);
}
const text = fs.readFileSync(grammar, 'utf8');
const { code } = generateModule(text, grammar);
if (out) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, code);
  console.error(`wrote ${out} (${code.length} bytes)`);
} else {
  process.stdout.write(code);
}
