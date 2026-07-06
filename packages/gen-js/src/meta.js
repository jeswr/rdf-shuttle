/**
 * meta.js — parser for the Shuttle meta-language (.shuttle files).
 *
 * Hand-written recursive-descent front end over the notation defined in
 * grammar/shuttle.ebnf (v0.1). Produces the grammar AST consumed by
 * lexer-gen / parser-gen / serializer-gen.
 *
 * Deliberately tolerant where v0.1 is loose (see spec/SHUTTLE.md §10 Q4 and
 * the NOTES block of grammars/turtle12.shuttle): effect rows and `print {}`
 * bodies are retained as raw text, not interpreted.
 */

const NAME_START = /[A-Za-z]/;
const NAME_CHAR = /[A-Za-z0-9_-]/;

class Scanner {
  constructor(text, file = '<input>') {
    this.text = text;
    this.pos = 0;
    this.file = file;
  }

  err(msg) {
    const upto = this.text.slice(0, this.pos);
    const line = (upto.match(/\n/g) || []).length + 1;
    const col = this.pos - upto.lastIndexOf('\n');
    throw new Error(`${this.file}:${line}:${col}: ${msg} (near ${JSON.stringify(this.text.slice(this.pos, this.pos + 30))})`);
  }

  /** Skip whitespace, `//` comments, and nestable `/* *​/` comments. */
  skip() {
    const t = this.text;
    for (;;) {
      while (this.pos < t.length && /\s/.test(t[this.pos])) this.pos++;
      if (t.startsWith('//', this.pos)) {
        const nl = t.indexOf('\n', this.pos);
        this.pos = nl < 0 ? t.length : nl + 1;
        continue;
      }
      if (t.startsWith('/*', this.pos)) {
        let depth = 1;
        this.pos += 2;
        while (this.pos < t.length && depth > 0) {
          if (t.startsWith('/*', this.pos)) { depth++; this.pos += 2; }
          else if (t.startsWith('*/', this.pos)) { depth--; this.pos += 2; }
          else this.pos++;
        }
        continue;
      }
      break;
    }
  }

  eof() { this.skip(); return this.pos >= this.text.length; }

  peekCh() { this.skip(); return this.text[this.pos]; }

  /** Try to consume a literal punctuation string (post-skip). */
  tryLit(s) {
    this.skip();
    if (this.text.startsWith(s, this.pos)) { this.pos += s.length; return true; }
    return false;
  }

  expectLit(s) { if (!this.tryLit(s)) this.err(`expected '${s}'`); }

  /** Try to consume a keyword (literal followed by a non-name char). */
  tryWord(w) {
    this.skip();
    if (this.text.startsWith(w, this.pos)) {
      const after = this.text[this.pos + w.length];
      if (after === undefined || !NAME_CHAR.test(after)) { this.pos += w.length; return true; }
    }
    return false;
  }

  peekWord() {
    this.skip();
    const m = /^[A-Za-z][A-Za-z0-9_-]*/.exec(this.text.slice(this.pos, this.pos + 64));
    return m ? m[0] : null;
  }

  name() {
    this.skip();
    if (!NAME_START.test(this.text[this.pos] || '')) this.err('expected name');
    const start = this.pos;
    while (this.pos < this.text.length && NAME_CHAR.test(this.text[this.pos])) this.pos++;
    return this.text.slice(start, this.pos);
  }

  int() {
    this.skip();
    const m = /^[0-9]+/.exec(this.text.slice(this.pos));
    if (!m) this.err('expected integer');
    this.pos += m[0].length;
    return parseInt(m[0], 10);
  }

  /** Raw string: quote to same quote, no escapes (shuttle.ebnf STRING). */
  string() {
    this.skip();
    const q = this.text[this.pos];
    if (q !== "'" && q !== '"') this.err('expected string');
    const end = this.text.indexOf(q, this.pos + 1);
    if (end < 0) this.err('unterminated string');
    const s = this.text.slice(this.pos + 1, end);
    this.pos = end + 1;
    return s;
  }

  isString() { this.skip(); const c = this.text[this.pos]; return c === "'" || c === '"'; }

  /** IRIREF-shaped literal in expressions, e.g. `<>`. */
  tryIriref() {
    this.skip();
    if (this.text[this.pos] !== '<') return null;
    const m = /^<([^<>"{}|^`\\\s]*)>/.exec(this.text.slice(this.pos));
    if (!m) return null;
    this.pos += m[0].length;
    return m[1];
  }

  /** Balanced-brace raw text (for print directives). Assumes at '{'. */
  rawBraces() {
    this.skip();
    if (this.text[this.pos] !== '{') this.err("expected '{'");
    let depth = 0;
    const start = this.pos;
    while (this.pos < this.text.length) {
      const c = this.text[this.pos];
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { this.pos++; return this.text.slice(start + 1, this.pos - 1); } }
      this.pos++;
    }
    this.err('unbalanced braces');
  }
}

/* ------------------------------------------------------------------ */
/* Token-pattern (regular expression) parsing                          */
/* ------------------------------------------------------------------ */

const ESCAPES = { n: 10, r: 13, t: 9, b: 8, f: 12, "'": 39, '"': 34, '\\': 92, '-': 45, '[': 91, ']': 93 };

function parseClass(sc) {
  // at '['
  sc.expectLit('[');
  const t = sc.text;
  let neg = false;
  if (t[sc.pos] === '^') { neg = true; sc.pos++; }
  const ranges = [];
  const readOne = () => {
    if (t[sc.pos] === '\\') {
      sc.pos++;
      const c = t[sc.pos];
      if (c === 'u' || c === 'U') {
        const len = c === 'u' ? 4 : 8;
        const hex = t.slice(sc.pos + 1, sc.pos + 1 + len);
        if (!new RegExp(`^[0-9A-Fa-f]{${len}}$`).test(hex)) sc.err('bad unicode escape in class');
        sc.pos += 1 + len;
        return parseInt(hex, 16);
      }
      if (!(c in ESCAPES)) sc.err(`bad class escape \\${c}`);
      sc.pos++;
      return ESCAPES[c];
    }
    const cp = t.codePointAt(sc.pos);
    sc.pos += cp > 0xffff ? 2 : 1;
    return cp;
  };
  while (t[sc.pos] !== ']') {
    if (sc.pos >= t.length) sc.err('unterminated class');
    const lo = readOne();
    let hi = lo;
    if (t[sc.pos] === '-' && t[sc.pos + 1] !== ']') { sc.pos++; hi = readOne(); }
    ranges.push([lo, hi]);
  }
  sc.pos++; // ']'
  ranges.sort((a, b) => a[0] - b[0]);
  // merge
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  return { k: 'class', neg, ranges: merged };
}

const PATTERN_STOPS = ['|', ')', ';', '=>'];

function isPatternStop(sc) {
  sc.skip();
  const t = sc.text;
  for (const s of PATTERN_STOPS) if (t.startsWith(s, sc.pos)) return true;
  // 'unparse' keyword terminates a pattern
  const w = sc.peekWord();
  return w === 'unparse';
}

function parsePatternAlt(sc) {
  const items = [parsePatternSeq(sc)];
  while (sc.tryLit('|')) items.push(parsePatternSeq(sc));
  return items.length === 1 ? items[0] : { k: 'alt', items };
}

function parsePatternSeq(sc) {
  const items = [];
  for (;;) {
    if (isPatternStop(sc)) break;
    items.push(parsePatternFactor(sc));
  }
  if (items.length === 0) sc.err('empty pattern sequence');
  return items.length === 1 ? items[0] : { k: 'seq', items };
}

function parsePatternFactor(sc) {
  let prim;
  sc.skip();
  const c = sc.text[sc.pos];
  if (c === "'" || c === '"') {
    prim = { k: 'lit', text: sc.string() };
  } else if (c === '[') {
    prim = parseClass(sc);
  } else if (c === '(') {
    sc.expectLit('(');
    prim = parsePatternAlt(sc);
    sc.expectLit(')');
  } else if (/[A-Z]/.test(c || '')) {
    prim = { k: 'ref', name: sc.name() };
  } else {
    sc.err('expected pattern primary');
  }
  if (sc.tryLit('?')) return { k: 'opt', item: prim };
  if (sc.tryLit('*')) return { k: 'star', item: prim };
  if (sc.tryLit('+')) return { k: 'plus', item: prim };
  return prim;
}

/* ------------------------------------------------------------------ */
/* Expressions and clauses (shuttle.ebnf §8–9)                         */
/* ------------------------------------------------------------------ */

const CLAUSE_KEYWORDS = new Set(['value', 'emit', 'fresh', 'let', 'require', 'oracle']);

function parseExpr(sc) {
  // caseExpr
  if (sc.tryWord('case')) {
    const subject = parseCond(sc);
    if (!sc.tryWord('of')) sc.err("expected 'of'");
    const arms = [];
    for (;;) {
      sc.skip();
      const ch = sc.text[sc.pos];
      if (!(ch === '(' || ch === '_' || NAME_START.test(ch || ''))) break;
      // Heuristic: an arm starts with a pattern followed by '->'
      const save = sc.pos;
      let pat;
      try { pat = parsePattern(sc); } catch { sc.pos = save; break; }
      if (!sc.tryLit('->')) { sc.pos = save; break; }
      arms.push({ pat, body: parseExpr(sc) });
    }
    if (arms.length === 0) sc.err('case with no arms');
    return { k: 'case', subject, arms };
  }
  return parseCond(sc);
}

function parseCond(sc) {
  const e = parseCoal(sc);
  // `?` conditional — beware of postfix '?' in RHS (not reachable here: exprs
  // only appear inside (), args, or clause bodies).
  sc.skip();
  if (sc.text[sc.pos] === '?' && sc.text[sc.pos + 1] !== '?') {
    sc.pos++;
    const then = parseExpr(sc);
    sc.expectLit(':');
    const els = parseExpr(sc);
    return { k: 'cond', cond: e, then, els };
  }
  return e;
}

function parseCoal(sc) {
  let e = parseCmp(sc);
  while (sc.tryLit('??')) e = { k: 'coal', l: e, r: parseCmp(sc) };
  return e;
}

function parseCmp(sc) {
  let e = parseApply(sc);
  for (const op of ['==', '!=', '<=', '>=']) {
    if (sc.tryLit(op)) return { k: 'cmp', op, l: e, r: parseApply(sc) };
  }
  return e;
}

function parseApply(sc) {
  const a = parseAtom(sc);
  // call parens must be adjacent to the callee name
  if (a.k === 'name' && sc.text[sc.pos] === '(') {
    sc.pos++;
    const args = [];
    if (!sc.tryLit(')')) {
      do { args.push(parseExpr(sc)); } while (sc.tryLit(','));
      sc.expectLit(')');
    }
    return { k: 'call', fn: a.name, args };
  }
  return a;
}

function parseAtom(sc) {
  sc.skip();
  const c = sc.text[sc.pos];
  if (c === '{') {
    // block expression: clauses then a final expression
    sc.expectLit('{');
    const { clauses, result } = parseClauseSeq(sc, true);
    sc.expectLit('}');
    return { k: 'block', clauses, result };
  }
  if (c === '(') {
    sc.expectLit('(');
    const items = [parseExpr(sc)];
    while (sc.tryLit(',')) items.push(parseExpr(sc));
    sc.expectLit(')');
    return items.length === 1 ? items[0] : { k: 'tuple', items };
  }
  if (c === "'" || c === '"') return { k: 'str', value: sc.string() };
  if (/[0-9]/.test(c || '')) return { k: 'int', value: sc.int() };
  if (c === '<') {
    const iri = sc.tryIriref();
    if (iri !== null) return { k: 'iri', value: iri };
  }
  if (sc.tryWord('env')) {
    sc.expectLit('.');
    return { k: 'env', name: sc.name() };
  }
  if (sc.tryWord('fresh')) {
    sc.expectLit('(');
    sc.expectLit(')');
    return { k: 'fresh' };
  }
  if (sc.tryWord('some')) {
    sc.expectLit('(');
    const e = parseExpr(sc);
    sc.expectLit(')');
    return { k: 'some', item: e };
  }
  if (sc.tryWord('none')) return { k: 'none' };
  if (NAME_START.test(c || '')) {
    const n = sc.name();
    // curie constant: NAME ':' local with no intervening space
    if (sc.text[sc.pos] === ':' && /[A-Za-z0-9_]/.test(sc.text[sc.pos + 1] || '')) {
      sc.pos++;
      const m = /^[a-zA-Z0-9_.-]*/.exec(sc.text.slice(sc.pos));
      sc.pos += m[0].length;
      return { k: 'curie', prefix: n, local: m[0] };
    }
    return { k: 'name', name: n };
  }
  sc.err('expected expression');
}

function parsePattern(sc) {
  sc.skip();
  const c = sc.text[sc.pos];
  if (c === '(') {
    sc.expectLit('(');
    const items = [parsePattern(sc)];
    while (sc.tryLit(',')) items.push(parsePattern(sc));
    sc.expectLit(')');
    return { k: 'ptuple', items };
  }
  if (c === '_') { sc.pos++; return { k: 'pwild' }; }
  if (sc.tryWord('some')) return { k: 'psome', item: parsePattern(sc) };
  if (sc.tryWord('none')) return { k: 'pnone' };
  const n = sc.name();
  return { k: 'pname', name: n };
}

/** Parse `clause (';' clause)* [';' expr]` — the body of a sem block. */
function parseClauseSeq(sc, allowResult) {
  const clauses = [];
  let result = null;
  for (;;) {
    sc.skip();
    if (sc.text[sc.pos] === '}') break;
    const item = parseClauseOrExpr(sc);
    if (item.isClause) clauses.push(item.node);
    else {
      result = item.node;
      break;
    }
    if (!sc.tryLit(';')) break;
  }
  if (result !== null && !allowResult) sc.err('unexpected trailing expression in clause block');
  return { clauses, result };
}

function parseClauseOrExpr(sc) {
  const w = sc.peekWord();
  if (w === 'value') {
    sc.name(); sc.expectLit('=');
    return { isClause: true, node: { k: 'value', expr: parseExpr(sc) } };
  }
  if (w === 'emit') {
    sc.name();
    const s = parseApply(sc), p = parseApply(sc), o = parseApply(sc);
    let g = null, when = null;
    if (sc.tryLit('@')) g = parseApply(sc);
    if (sc.tryWord('when')) when = parseExpr(sc);
    return { isClause: true, node: { k: 'emit', s, p, o, g, when } };
  }
  if (w === 'fresh') {
    // `fresh NAME` (clause) vs `fresh()` (expression, may be a block result)
    const save = sc.pos;
    sc.name();
    sc.skip();
    if (sc.text[sc.pos] === '(') { sc.pos = save; return { isClause: false, node: parseExpr(sc) }; }
    return { isClause: true, node: { k: 'freshDecl', name: sc.name() } };
  }
  if (w === 'let') {
    sc.name();
    const name = sc.name();
    sc.expectLit('=');
    return { isClause: true, node: { k: 'let', name, expr: parseExpr(sc) } };
  }
  if (w === 'require') {
    sc.name();
    const cond = parseExpr(sc);
    if (!sc.tryWord('else')) sc.err("expected 'else'");
    if (!sc.tryWord('error')) sc.err("expected 'error'");
    return { isClause: true, node: { k: 'require', cond, code: sc.name() } };
  }
  if (w === 'env') {
    const save = sc.pos;
    sc.name();
    if (sc.tryLit('.')) {
      const name = sc.name();
      if (sc.tryLit(':=')) return { isClause: true, node: { k: 'envSet', name, expr: parseExpr(sc) } };
    }
    sc.pos = save;
    return { isClause: false, node: parseExpr(sc) };
  }
  if (w !== null && !CLAUSE_KEYWORDS.has(w)) {
    // `NAME := expr` threaded-local update?
    const save = sc.pos;
    const n = sc.name();
    if (sc.tryLit(':=')) return { isClause: true, node: { k: 'assign', name: n, expr: parseExpr(sc) } };
    sc.pos = save;
  }
  return { isClause: false, node: parseExpr(sc) };
}

/* ------------------------------------------------------------------ */
/* Unparse templates (token rules)                                     */
/* ------------------------------------------------------------------ */

/** Parse a juxtaposed template: STRING | NAME | call | '(' cond-template ')'. */
function parseTemplate(sc, stops = [';']) {
  const items = [];
  for (;;) {
    sc.skip();
    const c = sc.text[sc.pos];
    if (c === undefined) break;
    if (stops.some((s) => sc.text.startsWith(s, sc.pos))) break;
    if (c === "'" || c === '"') { items.push({ k: 'str', value: sc.string() }); continue; }
    if (c === '(') {
      sc.expectLit('(');
      // possibly `x ? tpl : tpl`
      const first = parseTemplate(sc, ['?', ':', ')']);
      if (sc.tryLit('?')) {
        const then = parseTemplate(sc, [':', ')']);
        sc.expectLit(':');
        const els = parseTemplate(sc, [')']);
        sc.expectLit(')');
        items.push({ k: 'tcond', cond: first, then, els });
      } else {
        sc.expectLit(')');
        items.push(first);
      }
      continue;
    }
    if (NAME_START.test(c)) {
      const n = sc.name();
      // call only when '(' is adjacent — `escapeU(s)` yes, `l (d? …)` no
      if (sc.text[sc.pos] === '(') {
        sc.pos++;
        const args = [];
        if (!sc.tryLit(')')) {
          do { args.push(parseTemplate(sc, [',', ')'])); } while (sc.tryLit(','));
          sc.expectLit(')');
        }
        items.push({ k: 'call', fn: n, args });
      } else items.push({ k: 'name', name: n });
      continue;
    }
    break;
  }
  return items.length === 1 ? items[0] : { k: 'concat', items };
}

/* ------------------------------------------------------------------ */
/* Right-hand sides of productions                                     */
/* ------------------------------------------------------------------ */

const RHS_STOP = /^(\||\)|;)/;

function parseAlternatives(sc) {
  const alts = [parseAlternative(sc)];
  while (sc.tryLit('|')) alts.push(parseAlternative(sc));
  return alts;
}

function parseAlternative(sc) {
  const annots = { prefer: null, when: null, covers: null };
  for (;;) {
    if (sc.tryLit('@prefer')) { sc.expectLit('('); annots.prefer = sc.int(); sc.expectLit(')'); continue; }
    if (sc.tryLit('@when')) { sc.expectLit('('); annots.when = parseExpr(sc); sc.expectLit(')'); continue; }
    if (sc.tryLit('@covers')) { sc.expectLit('('); annots.covers = sc.name(); sc.expectLit(')'); continue; }
    break;
  }
  const items = [];
  for (;;) {
    sc.skip();
    const rest = sc.text.slice(sc.pos, sc.pos + 8);
    if (RHS_STOP.test(rest) || sc.pos >= sc.text.length) break;
    if (sc.peekWord() === 'print') break;
    items.push(parseItem(sc));
  }
  return { annots, items };
}

function parseItem(sc) {
  sc.skip();
  const c = sc.text[sc.pos];
  if (c === '{') {
    sc.expectLit('{');
    const { clauses } = parseClauseSeq(sc, false);
    sc.expectLit('}');
    return { kind: 'sem', clauses };
  }
  if (sc.peekWord() === 'thread') {
    sc.name();
    const name = sc.name();
    sc.expectLit(':');
    // type: read until '='
    let type = '';
    sc.skip();
    while (sc.text[sc.pos] !== '=' && sc.pos < sc.text.length) type += sc.text[sc.pos++];
    sc.expectLit('=');
    // init expression, up to 'in'
    const init = parseExpr(sc);
    if (!sc.tryWord('in')) sc.err("expected 'in' after thread init");
    sc.expectLit('(');
    const body = parseAlternatives(sc);
    sc.expectLit(')');
    let rep = null;
    if (sc.tryLit('*')) rep = 'star';
    else if (sc.tryLit('+')) rep = 'plus';
    else sc.err("expected '*' or '+' after thread body");
    return { kind: 'thread', name, type: type.trim(), init, body, rep };
  }
  // factor: [NAME '='] primary postfix?
  let binding = null;
  if (NAME_START.test(c || '')) {
    const save = sc.pos;
    const n = sc.name();
    sc.skip();
    if (sc.text[sc.pos] === '=' && sc.text[sc.pos + 1] !== '=' && sc.text[sc.pos + 1] !== '>') {
      sc.pos++;
      binding = n;
    } else sc.pos = save;
  }
  let prim;
  sc.skip();
  const c2 = sc.text[sc.pos];
  if (c2 === "'" || c2 === '"') {
    prim = { kind: 'lit', text: sc.string() };
  } else if (c2 === '(') {
    sc.expectLit('(');
    prim = { kind: 'group', alts: parseAlternatives(sc) };
    sc.expectLit(')');
  } else if (NAME_START.test(c2 || '')) {
    const n = sc.name();
    if (/^[A-Z][A-Z0-9_]*$/.test(n)) prim = { kind: 'token', name: n };
    else {
      let args = null;
      // argument list only when '(' is adjacent: `predicateObjectList(s)` vs
      // `lex=String ( group … )`
      if (sc.text[sc.pos] === '(') {
        sc.pos++;
        args = [];
        if (!sc.tryLit(')')) {
          do { args.push(parseExpr(sc)); } while (sc.tryLit(','));
          sc.expectLit(')');
        }
      }
      prim = { kind: 'call', name: n, args };
    }
  } else {
    sc.err('expected RHS item');
  }
  let postfix = null;
  let sep = null;
  if (sc.tryLit('?')) postfix = 'opt';
  else if (sc.tryLit('*')) postfix = 'star';
  else if (sc.tryLit('+')) postfix = 'plus';
  else if (sc.tryLit('%')) { postfix = 'sepList'; sep = sc.string(); }
  return { kind: 'factor', binding, prim, postfix, sep };
}

/* ------------------------------------------------------------------ */
/* Top level                                                           */
/* ------------------------------------------------------------------ */

export function parseGrammar(text, file) {
  const sc = new Scanner(text, file);
  const g = {
    name: null,
    headers: {},
    skipTokens: [],
    env: [],
    tokens: [],
    tokenByName: new Map(),
    prods: [],
    prodByName: new Map(),
  };

  if (!sc.tryWord('grammar')) sc.err("expected 'grammar'");
  g.name = sc.name();
  sc.expectLit(';');

  const HEADER_WORDS = new Set(['target', 'spec-ref', 'start', 'emits', 'profile', 'import', 'skip']);

  while (!sc.eof()) {
    const w = sc.peekWord();
    if (w !== null && HEADER_WORDS.has(w)) {
      sc.name();
      if (w === 'skip') {
        do { g.skipTokens.push(sc.name()); } while (sc.tryLit(','));
      } else if (w === 'spec-ref') {
        g.headers[w] = sc.string();
      } else if (w === 'emits') {
        g.headers[w] = sc.name();
        if (sc.tryWord('bag')) g.headers[w] += ' bag';
      } else {
        // loose word: header values like `rdf-1.2` are not NAMEs
        sc.skip();
        const m = /^[^\s;]+/.exec(sc.text.slice(sc.pos));
        g.headers[w] = m[0];
        sc.pos += m[0].length;
      }
      sc.expectLit(';');
      continue;
    }
    if (w === 'env') {
      sc.name();
      sc.expectLit('{');
      while (!sc.tryLit('}')) {
        const name = sc.name();
        sc.expectLit(':');
        let scoped = false;
        if (sc.tryWord('scoped')) scoped = true;
        // type: raw until '=' or ';'
        let type = '';
        sc.skip();
        while (sc.text[sc.pos] !== '=' && sc.text[sc.pos] !== ';') {
          type += sc.text[sc.pos++];
          sc.skip();
        }
        let init = null;
        if (sc.tryLit('=')) {
          sc.skip();
          if (sc.text[sc.pos] === '<') init = { k: 'iri', value: sc.tryIriref() };
          else if (sc.text[sc.pos] === '{') { sc.expectLit('{'); sc.expectLit('}'); init = { k: 'emptyMap' }; }
          else init = parseExpr(sc);
        }
        sc.expectLit(';');
        g.env.push({ name, type: type.trim(), scoped, init });
      }
      continue;
    }
    if (w === 'token') {
      sc.name();
      const name = sc.name();
      sc.expectLit(':');
      // type: raw until '::='
      let type = '';
      sc.skip();
      while (!sc.text.startsWith('::=', sc.pos)) { type += sc.text[sc.pos++]; sc.skip(); }
      sc.expectLit('::=');
      const pattern = parsePatternAlt(sc);
      let valueExpr = null;
      let unparse = null;
      if (sc.tryLit('=>')) valueExpr = parseExpr(sc);
      if (sc.tryWord('unparse')) {
        const pat = parsePattern(sc);
        sc.expectLit('=');
        const tpl = parseTemplate(sc, [';']);
        unparse = { pat, tpl };
      }
      sc.expectLit(';');
      const tok = { name, type: type.trim(), pattern, valueExpr, unparse, declIndex: g.tokens.length };
      g.tokens.push(tok);
      g.tokenByName.set(name, tok);
      continue;
    }
    // production
    const name = sc.name();
    let params = [];
    sc.skip();
    if (sc.text[sc.pos] === '(') {
      sc.pos++;
      do {
        const pn = sc.name();
        sc.expectLit(':');
        // param type: until ',' or ')'
        let pt = '';
        sc.skip();
        while (sc.text[sc.pos] !== ',' && sc.text[sc.pos] !== ')') { pt += sc.text[sc.pos++]; sc.skip(); }
        params.push({ name: pn, type: pt.trim() });
      } while (sc.tryLit(','));
      sc.expectLit(')');
    }
    sc.expectLit(':');
    // semType: word plus optional '!'
    let semType = sc.name();
    if (sc.tryLit('!')) semType += '!';
    // effect row: raw
    let effects = null;
    sc.skip();
    if (sc.text[sc.pos] === '[') {
      const start = sc.pos;
      const end = sc.text.indexOf(']', sc.pos);
      if (end < 0) sc.err('unterminated effect row');
      effects = sc.text.slice(start + 1, end);
      sc.pos = end + 1;
    }
    sc.expectLit('::=');
    const alts = parseAlternatives(sc);
    let printDirective = null;
    if (sc.peekWord() === 'print') {
      sc.name();
      printDirective = sc.rawBraces();
    }
    sc.expectLit(';');
    const prod = { name, params, semType, effects, alts, printDirective };
    g.prods.push(prod);
    g.prodByName.set(name, prod);
  }

  return g;
}
