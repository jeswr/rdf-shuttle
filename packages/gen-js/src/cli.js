#!/usr/bin/env node
/** shuttle-gen-js <grammar.shuttle> -o <out.js> — emit the JS artifact. */
import fs from 'node:fs';
import path from 'node:path';
import { generateModule } from './generate.js';

const args = process.argv.slice(2);
let grammarFile = null;
let outFile = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-o') { outFile = args[++i]; continue; }
  grammarFile = args[i];
}
if (!grammarFile) {
  console.error('usage: shuttle-gen-js <grammar.shuttle> [-o out.js]');
  process.exit(2);
}
const text = fs.readFileSync(grammarFile, 'utf8');
const { code, grammar } = generateModule(text, grammarFile);
if (!outFile) outFile = path.join(process.cwd(), `${grammar.name}.js`);
fs.writeFileSync(outFile, code);
console.error(`generated ${outFile} (${(code.length / 1024).toFixed(1)} KiB) from ${grammarFile}`);
