/**
 * generate.js — assembles the single dependency-free ES module emitted for a
 * grammar: runtime + generated lexer + generated parser + generated
 * serializer + public API (parse / createPushParser / parseStream / writer).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGrammar } from './meta.js';
import { analyzeTokens, genLexer, genStandaloneMatchers } from './lexer-gen.js';
import { ParserGen } from './parser-gen.js';
import { genSerializer } from './serializer-gen.js';
import { genResidualSerializer } from './residual-serializer-gen.js';
import { curieTable, curieIriOf } from './clausec.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Profile selection (@profile alternative labels, turtle12.shuttle NOTE 3):
 * an unlabelled alternative is in every build; a labelled one is kept only
 * when its label is selected. With `profiles === null` every label is kept
 * (the full language). Restriction is purely subtractive, so a stricter
 * build REJECTS the carved-out syntax by construction — its alternatives
 * are absent from the parse tables (and their keyword literals from the
 * lexer).
 */
function applyProfiles(g, profiles) {
  if (profiles === null) return;
  const keep = new Set(profiles);
  const filterAlts = (alts) => alts.filter((a) => a.annots.profile === null || keep.has(a.annots.profile));
  const walkItems = (items) => {
    for (const it of items) {
      if (it.kind === 'sem') continue;
      if (it.kind === 'thread') { it.body = filterAlts(it.body); it.body.forEach((a) => walkItems(a.items)); continue; }
      if (it.prim && it.prim.kind === 'group') { it.prim.alts = filterAlts(it.prim.alts); it.prim.alts.forEach((a) => walkItems(a.items)); }
    }
  };
  for (const p of g.prods) {
    p.alts = filterAlts(p.alts);
    for (const a of p.alts) walkItems(a.items);
  }
  // a REQUIRED reference to a now-empty production is a generator error;
  // opt/star references are statically dead (FIRST-set guard is false).
  const empty = new Set(g.prods.filter((p) => p.alts.length === 0).map((p) => p.name));
  const checkItems = (items, home) => {
    for (const it of items) {
      if (it.kind === 'sem') continue;
      if (it.kind === 'thread') { it.body.forEach((a) => checkItems(a.items, home)); continue; }
      if (it.prim.kind === 'call' && empty.has(it.prim.name) && (it.postfix === null || it.postfix === 'plus')) {
        throw new Error(`profile selection [${profiles.join(', ')}] empties production '${it.prim.name}', required from '${home}'`);
      }
      if (it.prim.kind === 'group') it.prim.alts.forEach((a) => checkItems(a.items, home));
    }
  };
  for (const p of g.prods) for (const a of p.alts) checkItems(a.items, p.name);
}

export function generateModule(grammarText, grammarFile, options = {}) {
  const g = parseGrammar(grammarText, grammarFile);
  applyProfiles(g, options.profiles || null);
  const an = analyzeTokens(g);
  const lex = genLexer(g, an);

  const gen = { constPool: new Map(), curies: curieTable(g.imports), oracles: new Map() };
  for (const o of g.oracles) gen.oracles.set(o.name, o);
  const pg = new ParserGen(g, an, lex, gen);
  const parserOut = pg.generate();

  // print-mode selection: grammars carrying the Turtle statement spine get
  // the stream-pretty serializer; the shaclc profile gets the batch
  // residual-consumption printer (spec §8 — print fails with the residual
  // as the "not compact-expressible" verdict); anything else is an honest
  // parse-only artifact.
  const TURTLE_SPINE = ['statement', 'predicateObjectList', 'objectList', 'verb'];
  const hasSpine = TURTLE_SPINE.every((n) => g.prodByName.has(n));
  const ser = hasSpine
    ? genSerializer(g, an, (tokens) => genStandaloneMatchers(g, an, tokens))
    : g.headers.profile === 'shaclc'
      ? genResidualSerializer(g, an, (tokens) => genStandaloneMatchers(g, an, tokens), gen)
      : { code: `
/* ==================================================================
 * Print mode: NOT derivable for this grammar by the v0.1 backend (the
 * serializer generator reads the Turtle statement spine or the shaclc
 * residual-consumption profile).
 * ================================================================== */
export function createWriter() { throw new Error('${g.name}: print mode not generated (v0.1 backend limitation)'); }
export function writeQuads() { throw new Error('${g.name}: print mode not generated (v0.1 backend limitation)'); }
` };

  // start production drives the document loop; a `X*` body gets the
  // statement-level bounded-memory push loop, anything else falls back to
  // whole-buffer push parsing (document-shaped grammars like SHACL-C).
  const start = g.prodByName.get(g.headers.start);
  if (!start) throw new Error(`start production ${g.headers.start} not found`);
  const startFactors = start.alts[0].items.filter((i) => i.kind === 'factor');
  const singleStar = startFactors.length === 1 && startFactors[0].postfix === 'star' && startFactors[0].prim.kind === 'call';
  const stmtProd = singleStar ? startFactors[0].prim.name : null;

  // environment declarations -> parser state
  const envDecls = g.env.map((e) => {
    const t = e.type;
    if (t.startsWith('map')) {
      const init = e.init && e.init.k === 'mapLit' ? JSON.stringify(e.init.entries) : '';
      return `const env_${e.name} = new Map(${init});`;
    }
    if (t === 'iri') return `let env_${e.name} = options.baseIRI !== undefined ? String(options.baseIRI) : ${JSON.stringify(e.init && e.init.k === 'iri' ? e.init.value : '')};`;
    return `let env_${e.name} = null;`;
  }).join('\n  ');

  // oracle decision sets (curies resolved compile-time)
  const oracleCode = g.oracles.map((o) => {
    if (!o.set) throw new Error(`oracle '${o.name}' has no decision set (runtime oracles unsupported in this backend)`);
    const iris = o.set.map((e) => curieIriOf(gen, e));
    return `const ORS_${o.name} = new Set(${JSON.stringify(iris)});\n`
      + `function OR_${o.name}(t) { return t.termType === 'NamedNode' && ORS_${o.name}.has(t.value); }`;
  }).join('\n');

  // result(): only the env fields this grammar declares
  const envNames = new Set(g.env.map((e) => e.name));
  const resultFields = [];
  if (envNames.has('prefixes')) resultFields.push('prefixes');
  if (envNames.has('base')) resultFields.push('base: env_base');
  if (envNames.has('version')) resultFields.push('version: env_version');

  const constPoolCode = [...gen.constPool.entries()]
    .map(([iri, id]) => `const ${id} = new NamedNode(${JSON.stringify(iri)});`)
    .join('\n');

  const runtime = fs.readFileSync(path.join(HERE, 'runtime.inc.js'), 'utf8');

  const code = `/* ================================================================
 * GENERATED by @rdf-shuttle/gen-js from ${path.basename(grammarFile)} — DO NOT EDIT.
 * grammar: ${g.name}  target: ${g.headers.target || '?'}  profile: ${g.headers.profile || '?'}
 * spec-ref: ${(g.headers['spec-ref'] || '').split(' — ')[0]}
 *
 * One dependency-free ES module: streaming parser (text -> RDF/JS quads),
 * push parser (chunked input, bounded memory), and serializer (quads ->
 * text) — parse and print modes of the same Shuttle relation.
 * ================================================================ */

const NTOK = ${lex.numTokens};

${runtime}

/* ---- token kinds ---- */
${lex.constsCode}

/* ---- interned curie constants (compile-time, from the import tables) ---- */
${constPoolCode}

/* ---- oracle decision sets (@oracle declarations) ---- */
${oracleCode}

/* ---- parser first-sets ---- */
${pg.tableDefs.join('\n')}

/* ================================================================
 * Parser factory: all machine state lives in this closure.
 * ================================================================ */
function makeParser(options, onQuad) {
  let inp = '';
  let len = 0;
  let pos = 0;
  let final = 1;
  let tk = 0;
  let ts = 0;
  let te = 0;
  let tEsc = 0;
  let tM0 = -1;
  let tMD = -1;
  let mEsc = 0;
  let m0 = -1;
  let mD = -1;
  let hitEnd = 0;
  let depth = 0;
  void tM0; void tMD; void m0; void mD;

  /* environment (grammar env block) */
  ${envDecls}

  /* fresh blank nodes: per-derivation counter (deterministic _:b0, _:b1 …) */
  let freshCtr = 0;
  function BNF() { return new BlankNode('b' + (freshCtr++)); }

  /* span-interning for named nodes */
  const iCache = new Map();
  function NN(v) {
    let t = iCache.get(v);
    if (t === undefined) { t = new NamedNode(v); iCache.set(v, t); }
    return t;
  }
  function QuadT(s, p, o) { return new Quad(s, p, o, DEFAULT_GRAPH); }

  /* pname interning: prefix -> (local -> term); short-string hashing only.
   * Invalidated when a prefix is (re)bound. */
  const pnCache = new Map();
  function expandPN(map, pfx, local) {
    let inner = pnCache.get(pfx);
    if (inner === undefined) { inner = new Map(); pnCache.set(pfx, inner); }
    let t = inner.get(local);
    if (t === undefined) { t = NN(map.get(pfx) + local); inner.set(local, t); }
    return t;
  }

  /* push-mode statement rollback support */
  let trail = null;
${envNames.has('labels') ? `  function bindLabel(k, v) {
    if (trail !== null && !env_labels.has(k)) trail.push(k);
    env_labels.set(k, v);
  }` : ''}

  /* quad sink: direct callback (one-shot) or per-statement buffer (push) */
  let sink = onQuad;
  const stmtBuf = [];
  function emitQ(s, p, o) { sink(new Quad(s, p, o, DEFAULT_GRAPH)); }

  function lineCol(at) {
    let line = 1;
    let last = -1;
    for (let i = 0; i < at && i < len; i++) {
      if (inp.charCodeAt(i) === 10) { line++; last = i; }
    }
    return [line, at - last];
  }
  function perr(code) {
    const [l, c] = lineCol(ts);
    throw new ShuttleSyntaxError('parse error at line ' + l + ':' + c, l, c, code);
  }
  function perrExp(kind) {
    const [l, c] = lineCol(ts);
    throw new ShuttleSyntaxError('expected ' + TOKEN_NAMES[kind] + ' but got ' + TOKEN_NAMES[tk] + ' at line ' + l + ':' + c, l, c, 'UNEXPECTED_TOKEN');
  }
  function perrAlt(kinds) {
    const [l, c] = lineCol(ts);
    throw new ShuttleSyntaxError('expected one of ' + kinds.map((k) => TOKEN_NAMES[k]).join(', ') + ' but got ' + TOKEN_NAMES[tk] + ' at line ' + l + ':' + c, l, c, 'UNEXPECTED_TOKEN');
  }
  function lexErr() {
    const [l, c] = lineCol(pos);
    throw new ShuttleSyntaxError('unrecognized token at line ' + l + ':' + c, l, c, 'LEX');
  }

${lex.machineCode}

  const next = nextToken;

/* ---- productions ---- */
${parserOut.code}

  /* ---- drivers ---- */

  function parseAll() {
    depth = 0;
    nextToken();
    p_${g.headers.start}();
    if (tk !== T_EOF) perrAlt([T_EOF]);
  }

${stmtProd !== null ? `  /**
   * Push-mode statement loop. Parses statements until the buffer is
   * exhausted; an INCOMPLETE suspension rolls the current statement back
   * (fresh counter, label bindings, buffered quads) and reports the carry
   * point. Memory held across chunks is O(current statement), never the
   * whole document.
   */
  function parseChunk() {
    depth = 0;
    let stmtStart = 0;
    let cpFresh = freshCtr;
    try {
      nextToken();
      for (;;) {
        if (tk === T_EOF) return -1;
        stmtStart = ts;
        cpFresh = freshCtr;
        trail.length = 0;
        stmtBuf.length = 0;
        p_${stmtProd}();
        for (let i = 0; i < stmtBuf.length; i++) onQuad(stmtBuf[i]);
        stmtBuf.length = 0;
      }
    } catch (e) {
      if (e !== INCOMPLETE) throw e;
      freshCtr = cpFresh;
${envNames.has('labels') ? '      for (let i = 0; i < trail.length; i++) env_labels.delete(trail[i]);' : ''}
      trail.length = 0;
      stmtBuf.length = 0;
      return stmtStart;
    }
  }` : `  /**
   * Push-mode fallback for a document-shaped start production (not a
   * statement star): accumulate the whole document and parse once at end.
   * Memory is O(document) — fine for the small documents such grammars
   * describe; a statement-level loop would need FOLLOW-driven phase
   * transitions in this driver.
   */
  function parseChunk() {
    if (final === 0) return 0;
    sink = onQuad;
    parseAll();
    return -1;
  }`}

  return {
    setInput(s, isFinal) { inp = s; len = s.length; pos = 0; final = isFinal ? 1 : 0; },
    enablePush() { trail = []; sink = (q) => { stmtBuf.push(q); }; },
    parseAll,
    parseChunk,
    result() {
${envNames.has('prefixes') ? `      const prefixes = {};
      for (const [k, v] of env_prefixes) prefixes[k] = v;` : '      const prefixes = {};'}
      return { ${resultFields.join(', ')} };
    },
  };
}

/* ================================================================
 * Public API
 * ================================================================ */

/**
 * One-shot parse of a complete document string.
 * options: { onQuad(quad), baseIRI }
 * returns: { prefixes, base, version }
 */
export function parse(input, options = {}) {
  const onQuad = options.onQuad || (() => {});
  const P = makeParser(options, onQuad);
  P.setInput(String(input), true);
  P.parseAll();
  return P.result();
}

/** Convenience: parse to an array of quads. */
export function parseToQuads(input, options = {}) {
  const quads = [];
  const res = parse(input, { ...options, onQuad: (q) => quads.push(q) });
  return { quads, ...res };
}

/**
 * Chunked push parser with bounded memory: only the current (incomplete)
 * statement is retained between push() calls.
 */
export function createPushParser(options = {}) {
  const onQuad = options.onQuad || (() => {});
  const P = makeParser(options, onQuad);
  P.enablePush();
  let carry = '';
  let ended = false;
  return {
    push(chunk) {
      if (ended) throw new Error('push after end');
      const s = carry.length > 0 ? carry + chunk : String(chunk);
      P.setInput(s, false);
      const idx = P.parseChunk();
      carry = idx < 0 ? '' : (idx > 0 ? s.slice(idx) : s);
    },
    end() {
      ended = true;
      P.setInput(carry, true);
      carry = '';
      const idx = P.parseChunk();
      if (idx >= 0) throw new ShuttleSyntaxError('unexpected end of input', 0, 0, 'EOF');
      return P.result();
    },
    get pending() { return carry.length; },
  };
}

/** Parse an (async) iterable of chunks (e.g. a Node fs ReadStream). */
export async function parseStream(iterable, options = {}) {
  const p = createPushParser(options);
  for await (const chunk of iterable) p.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
  return p.end();
}

export { NamedNode, BlankNode, Literal, Quad, DefaultGraph, DEFAULT_GRAPH, factory, ShuttleSyntaxError };

${ser.code}
`;

  return { code, grammar: g };
}
