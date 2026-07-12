#!/usr/bin/env node
/**
 * shuttle-gen-js <grammar.shuttle> [-o out.js] [--profile a,b] — emit the JS
 * artifact. --profile selects which @profile-labelled alternative layers are
 * compiled in (unlabelled alternatives are always in); omitting it keeps
 * every layer (the full language).
 */
import fs from 'node:fs';
import path from 'node:path';
import { generateModule } from './generate.js';

const args = process.argv.slice(2);
let grammarFile = null;
let outFile = null;
let profiles = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-o') { outFile = args[++i]; continue; }
  if (args[i] === '--profile') { profiles = args[++i].split(',').map((s) => s.trim()).filter(Boolean); continue; }
  grammarFile = args[i];
}
if (!grammarFile) {
  console.error('usage: shuttle-gen-js <grammar.shuttle> [-o out.js] [--profile a,b]');
  process.exit(2);
}
const text = fs.readFileSync(grammarFile, 'utf8');
const { code, grammar } = generateModule(text, grammarFile, { profiles });
if (!outFile) outFile = path.join(process.cwd(), `${grammar.name}.js`);
fs.writeFileSync(outFile, code);
console.error(`generated ${outFile} (${(code.length / 1024).toFixed(1)} KiB) from ${grammarFile}${profiles ? ` [profile ${profiles.join(',')}]` : ''}`);
