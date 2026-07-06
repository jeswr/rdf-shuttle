/**
 * lexer-gen.js — compiles Shuttle token rules to a direct-coded lexer.
 *
 * Strategy (per the JS-backend architecture note):
 *  - one matcher function per token, generated from the pattern AST:
 *    charCodeAt loops, no regexes, no per-token objects — the token is
 *    (kind:int, start:int, end:int [+ escape flag, split marks]);
 *  - a 128-entry first-char dispatch switch + a non-ASCII fallback list;
 *  - longest-match/maximal-munch across the candidate set of the first char,
 *    ties resolved by declaration order (keywords before LANG_DIR, exactly
 *    the W3C prose resolution the grammar declares);
 *  - the `X* Y` trailing-context idiom (PN_LOCAL / PN_PREFIX / blank-node
 *    labels: `.` allowed inside, not at the end) compiles to a single
 *    forward scan that tracks the last position ending a Y-element — linear,
 *    no rescan, and safe across multi-char escape elements;
 *  - long-string tokens compile to a quote-run scanner;
 *  - matchers suspend at chunk boundaries by failing; the driver converts
 *    end-of-buffer failures into INCOMPLETE for the push parser.
 */

/* ------------------------------------------------------------------ */
/* charset utilities                                                   */
/* ------------------------------------------------------------------ */

function unionRanges(a, b) {
  const all = [...a, ...b].sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const r of all) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else out.push([...r]);
  }
  return out;
}

function litToCp(text) {
  const cp = text.codePointAt(0);
  const w = cp > 0xffff ? 2 : 1;
  return text.length === w ? cp : null;
}

/** Resolve a pattern node to a positive charset (or null). */
function resolveCharset(node, g, seen = new Set()) {
  switch (node.k) {
    case 'class':
      return node.neg ? null : node.ranges;
    case 'lit': {
      const cp = litToCp(node.text);
      return cp === null ? null : [[cp, cp]];
    }
    case 'ref': {
      if (seen.has(node.name)) return null;
      seen.add(node.name);
      const t = g.tokenByName.get(node.name);
      return t ? resolveCharset(t.pattern, g, seen) : null;
    }
    case 'alt': {
      let acc = [];
      for (const it of node.items) {
        const r = resolveCharset(it, g, seen);
        if (r === null) return null;
        acc = unionRanges(acc, r);
      }
      return acc;
    }
    default:
      return null;
  }
}

function rangesTest(ranges, cVar) {
  const parts = ranges.map(([lo, hi]) =>
    lo === hi ? `${cVar} === ${lo}` : `${cVar} >= ${lo} && ${cVar} <= ${hi}`
  );
  return parts.map((p) => (parts.length > 1 ? `(${p})` : p)).join(' || ');
}

function hasAstral(ranges) { return ranges.some(([, hi]) => hi > 0xffff); }

/** First-charset of a pattern: { ranges, nonAscii, nullable }. */
function firstOf(node, g, seen = new Set()) {
  switch (node.k) {
    case 'lit': {
      const cp = node.text.codePointAt(0);
      return { ranges: [[cp, cp]], nullable: node.text.length === 0 };
    }
    case 'class': {
      if (!node.neg) return { ranges: node.ranges, nullable: false };
      // complement within [0, 0x10FFFF]
      const out = [];
      let lo = 0;
      for (const [a, b] of node.ranges) {
        if (a > lo) out.push([lo, a - 1]);
        lo = b + 1;
      }
      if (lo <= 0x10ffff) out.push([lo, 0x10ffff]);
      return { ranges: out, nullable: false };
    }
    case 'ref': {
      if (seen.has(node.name)) return { ranges: [], nullable: false };
      seen.add(node.name);
      const t = g.tokenByName.get(node.name);
      if (!t) throw new Error(`unknown token ref ${node.name}`);
      return firstOf(t.pattern, g, seen);
    }
    case 'seq': {
      let ranges = [];
      let nullable = true;
      for (const it of node.items) {
        const f = firstOf(it, g, new Set(seen));
        ranges = unionRanges(ranges, f.ranges);
        if (!f.nullable) { nullable = false; break; }
      }
      return { ranges, nullable };
    }
    case 'alt': {
      let ranges = [];
      let nullable = false;
      for (const it of node.items) {
        const f = firstOf(it, g, new Set(seen));
        ranges = unionRanges(ranges, f.ranges);
        nullable = nullable || f.nullable;
      }
      return { ranges, nullable };
    }
    case 'opt':
    case 'star': {
      const f = firstOf(node.item, g, seen);
      return { ranges: f.ranges, nullable: true };
    }
    case 'plus':
      return firstOf(node.item, g, seen);
    default:
      throw new Error(`firstOf: ${node.k}`);
  }
}

/* ------------------------------------------------------------------ */
/* token analysis                                                      */
/* ------------------------------------------------------------------ */

export function analyzeTokens(g) {
  // tokens/literals referenced from productions
  const refTokens = new Set();
  const refLits = new Map(); // text -> anon token name
  const walkItems = (items) => {
    for (const it of items) {
      if (it.kind === 'sem') continue;
      if (it.kind === 'thread') { for (const a of it.body) walkItems(a.items); continue; }
      const prim = it.prim;
      if (prim.kind === 'token') refTokens.add(prim.name);
      else if (prim.kind === 'lit') refLits.set(prim.text, null);
      else if (prim.kind === 'group') for (const a of prim.alts) walkItems(a.items);
      if (it.postfix === 'sepList') refLits.set(it.sep, null);
    }
  };
  for (const p of g.prods) for (const a of p.alts) walkItems(a.items);

  const skip = g.skipTokens.length > 0 ? g.skipTokens
    : ['WS', 'COMMENT'].filter((n) => g.tokenByName.has(n));

  const real = []; // { name, pattern, valueExpr, token }
  for (const t of g.tokens) {
    if (skip.includes(t.name)) continue;
    if (refTokens.has(t.name)) real.push({ name: t.name, pattern: t.pattern, valueExpr: t.valueExpr, token: t });
  }
  let litIdx = 0;
  for (const text of refLits.keys()) {
    const name = `LIT_${litIdx++}`;
    refLits.set(text, name);
    real.push({ name, pattern: { k: 'lit', text }, valueExpr: null, token: null, litText: text });
  }

  // kind ids: 0 = EOF
  const kindOf = new Map();
  real.forEach((t, i) => kindOf.set(t.name, i + 1));

  const fragments = g.tokens.filter((t) => !refTokens.has(t.name) && !skip.includes(t.name));

  // escape fragments: first charset ⊆ {'\\', '%'}
  const escFrags = new Set();
  for (const f of fragments) {
    const first = firstOf(f.pattern, g);
    if (first.ranges.length > 0 && first.ranges.every(([lo, hi]) => (lo === hi && (lo === 92 || lo === 37))))
      escFrags.add(f.name);
  }

  return { real, kindOf, fragments, skip, refLits, escFrags };
}

export const litConstName = (an, text) => `T_${an.refLits.get(text)}`;
export const tokConstName = (name) => `T_${name}`;

/* ------------------------------------------------------------------ */
/* matcher compilation                                                 */
/* ------------------------------------------------------------------ */

class LexGen {
  constructor(g, an) {
    this.g = g;
    this.an = an;
    this.predFns = new Map();   // rangesKey -> fnName
    this.fragFns = new Map();   // fragment name -> code emitted flag
    this.out = [];
    this.marks = new Map();     // token name -> { m0: bool, mD: bool }
  }

  predFor(ranges, neg, hint) {
    const key = JSON.stringify([neg, ranges]);
    let fn = this.predFns.get(key);
    if (!fn) {
      fn = `in_${hint || 'cs'}${this.predFns.size}`;
      this.predFns.set(key, fn);
      const test = rangesTest(ranges, 'c');
      this.out.push(`function ${fn}(c) { return ${neg ? `!(${test})` : test}; }`);
    }
    return fn;
  }

  classTest(ranges, neg, cVar, hint) {
    if (ranges.length > 6) return `${this.predFor(ranges, neg, hint)}(${cVar})`;
    const t = rangesTest(ranges, cVar);
    return neg ? `!(${t})` : `(${t})`;
  }

  /** Emit "match one char of class, advance p" code. */
  emitClass(node, buf, g) {
    const ranges = node.k === 'ref' ? resolveCharset(node, g) : node.ranges;
    const neg = node.k === 'class' ? node.neg : false;
    const astral = !neg && hasAstral(ranges);
    const hint = node.k === 'ref' ? node.name : undefined;
    if (astral) {
      buf.push(`if (p >= len) { hitEnd = 1; fail = 1; } else { c = inp.charCodeAt(p); w = 1;`);
      buf.push(`  if (c >= 0xd800 && c <= 0xdbff) { const c2 = inp.charCodeAt(p + 1); if (c2 >= 0xdc00 && c2 <= 0xdfff) { c = (c - 0xd800) * 0x400 + (c2 - 0xdc00) + 0x10000; w = 2; } }`);
      buf.push(`  if (${this.classTest(ranges, neg, 'c', hint)}) p += w; else fail = 1; }`);
    } else {
      buf.push(`if (p >= len) { hitEnd = 1; fail = 1; } else if (${this.classTest(ranges, neg, '(c = inp.charCodeAt(p))', hint)}) p++; else fail = 1;`);
    }
  }

  emitLit(node, buf) {
    const codes = [];
    for (const ch of node.text) for (let i = 0; i < ch.length; i++) codes.push(ch.charCodeAt(i));
    const conds = codes.map((cc, i) => `inp.charCodeAt(p${i ? ` + ${i}` : ''}) === ${cc}`);
    buf.push(`if (p + ${codes.length} > len) { hitEnd = 1; fail = 1; } else if (${conds.join(' && ')}) p += ${codes.length}; else fail = 1;`);
  }

  fragFn(name) {
    if (!this.fragFns.has(name)) {
      this.fragFns.set(name, true);
      const t = this.g.tokenByName.get(name);
      const buf = [];
      this.emitNode(t.pattern, buf);
      this.out.push(`function f_${name}(i) { let p = i, c = 0, w = 1, fail = 0; ${''}\n  ${buf.join('\n  ')}\n  return fail !== 0 ? -1 : p; }`);
    }
    return `f_${name}`;
  }

  /** Is this node a pure charset (class / charset fragment / 1-char lit)? */
  charsetOf(node) {
    if (node.k === 'class') return { ranges: node.ranges, neg: node.neg, hint: undefined };
    if (node.k === 'lit') {
      const cp = litToCp(node.text);
      return cp === null ? null : { ranges: [[cp, cp]], neg: false, hint: undefined };
    }
    if (node.k === 'ref') {
      const r = resolveCharset(node, this.g);
      return r === null ? null : { ranges: r, neg: false, hint: node.name };
    }
    return null;
  }

  structKey(node) {
    if (node.k === 'ref') {
      const cs = resolveCharset(node, this.g);
      if (cs !== null) return `C:${JSON.stringify(cs)}`;
      return `R:${node.name}`;
    }
    if (node.k === 'class') return `C:${node.neg ? '^' : ''}${JSON.stringify(node.ranges)}`;
    if (node.k === 'lit') {
      const cp = litToCp(node.text);
      if (cp !== null) return `C:${JSON.stringify([[cp, cp]])}`;
      return `L:${node.text}`;
    }
    return null;
  }

  emitNode(node, buf) {
    switch (node.k) {
      case 'lit': this.emitLit(node, buf); return;
      case 'class': this.emitClass(node, buf, this.g); return;
      case 'ref': {
        const cs = resolveCharset(node, this.g);
        if (cs !== null) { this.emitClass(node, buf, this.g); return; }
        const fn = this.fragFn(node.name);
        const esc = this.an.escFrags.has(node.name) ? ' mEsc = 1;' : '';
        buf.push(`{ const e = ${fn}(p); if (e < 0) fail = 1; else { p = e;${esc} } }`);
        return;
      }
      case 'seq': return this.emitSeq(node.items, buf, null);
      case 'alt': {
        const emitAlts = (i) => {
          const inner = [];
          this.emitNode(node.items[i], inner);
          if (i === node.items.length - 1) return inner.join('\n');
          return `${inner.join('\n')}\nif (fail !== 0) { p = sv; fail = 0;\n${emitAlts(i + 1)}\n}`;
        };
        buf.push(`{ const sv = p;\n${emitAlts(0)}\n}`);
        return;
      }
      case 'opt': {
        const inner = [];
        this.emitNode(node.item, inner);
        buf.push(`{ const sv = p;\n${inner.join('\n')}\nif (fail !== 0) { p = sv; fail = 0; } }`);
        return;
      }
      case 'star': return this.emitStar(node.item, buf);
      case 'plus': {
        this.emitNode(node.item, buf);
        buf.push(`if (fail === 0) {`);
        this.emitStar(node.item, buf);
        buf.push(`}`);
        return;
      }
      default: throw new Error(`emitNode: ${node.k}`);
    }
  }

  emitStar(item, buf) {
    const cs = this.charsetOf(item);
    if (cs !== null) {
      // tight single-charset loop
      const astral = !cs.neg && hasAstral(cs.ranges);
      if (astral) {
        buf.push(`for (;;) { if (p >= len) { hitEnd = 1; break; } c = inp.charCodeAt(p); w = 1;`);
        buf.push(`  if (c >= 0xd800 && c <= 0xdbff) { const c2 = inp.charCodeAt(p + 1); if (c2 >= 0xdc00 && c2 <= 0xdfff) { c = (c - 0xd800) * 0x400 + (c2 - 0xdc00) + 0x10000; w = 2; } }`);
        buf.push(`  if (!(${this.classTest(cs.ranges, cs.neg, 'c', cs.hint)})) break; p += w; }`);
      } else {
        buf.push(`for (;;) { if (p >= len) { hitEnd = 1; break; } c = inp.charCodeAt(p); if (!(${this.classTest(cs.ranges, cs.neg, 'c', cs.hint)})) break; p++; }`);
      }
      return;
    }
    if (item.k === 'alt') {
      // optimized: class elements inline, fragment refs as calls
      const lines = [`sloop: for (;;) { if (p >= len) { hitEnd = 1; break; } c = inp.charCodeAt(p); w = 1;`];
      const anyAstral = item.items.some((el) => { const q = this.charsetOf(el); return q && !q.neg && hasAstral(q.ranges); });
      if (anyAstral) {
        lines.push(`  if (c >= 0xd800 && c <= 0xdbff) { const c2 = inp.charCodeAt(p + 1); if (c2 >= 0xdc00 && c2 <= 0xdfff) { c = (c - 0xd800) * 0x400 + (c2 - 0xdc00) + 0x10000; w = 2; } }`);
      }
      for (const el of item.items) {
        const q = this.charsetOf(el);
        if (q !== null) {
          lines.push(`  if (${this.classTest(q.ranges, q.neg, 'c', q.hint)}) { p += w; continue sloop; }`);
        } else if (el.k === 'ref') {
          const fn = this.fragFn(el.name);
          const esc = this.an.escFrags.has(el.name) ? ' mEsc = 1;' : '';
          lines.push(`  { const e = ${fn}(p); if (e >= 0) { p = e;${esc} continue sloop; } }`);
        } else {
          // general element
          const inner = [];
          this.emitNode(el, inner);
          lines.push(`  { const sv = p; fail = 0; ${inner.join(' ')} if (fail === 0) continue sloop; p = sv; fail = 0; }`);
        }
      }
      lines.push(`  break; }`);
      buf.push(lines.join('\n'));
      return;
    }
    // generic star
    const inner = [];
    this.emitNode(item, inner);
    buf.push(`for (;;) { const sv = p;\n${inner.join('\n')}\nif (fail !== 0) { p = sv; fail = 0; break; }\nif (p === sv) break; }`);
  }

  /**
   * Sequence with the `X* Y` trailing-context peephole and optional
   * boundary marks (markAfter: Map(index -> markVar)).
   */
  emitSeq(items, buf, markAfter) {
    let i = 0;
    let first = true;
    while (i < items.length) {
      const it = items[i];
      const next = items[i + 1];
      const inner = [];
      let consumed = 1;
      if (it.k === 'star' && next !== undefined && (!markAfter || !markAfter.has(i))
          && this.tryTrailingContext(it, next, inner)) {
        consumed = 2;
      } else {
        inner.length = 0;
        this.emitNode(it, inner);
      }
      const lastIdx = i + consumed - 1;
      if (markAfter && markAfter.has(lastIdx)) inner.push(`if (fail === 0) ${markAfter.get(lastIdx)} = p;`);
      if (first) buf.push(inner.join('\n'));
      else buf.push(`if (fail === 0) {\n${inner.join('\n')}\n}`);
      first = false;
      i += consumed;
    }
  }

  /** `Star(X) Y` where elems(Y) ⊆ elems(X) and X∖Y are single-char. */
  tryTrailingContext(starNode, yNode, buf) {
    const xElems = starNode.item.k === 'alt' ? starNode.item.items : [starNode.item];
    const yElems = yNode.k === 'alt' ? yNode.items : [yNode];
    const yKeys = new Set(yElems.map((e) => this.structKey(e)));
    if ([...yKeys].some((k) => k === null)) return false;
    const xKeys = xElems.map((e) => this.structKey(e));
    if (xKeys.some((k) => k === null)) return false;
    if (![...yKeys].every((k) => xKeys.includes(k))) return false;
    for (let i = 0; i < xElems.length; i++) {
      if (yKeys.has(xKeys[i])) continue;
      const cs = this.charsetOf(xElems[i]);
      if (cs === null) return false; // non-Y elements must be single-char
    }
    // combined loop, tracking end of the last Y element
    const lines = [`{ let lg = -1;`, `tcl: for (;;) { if (p >= len) { hitEnd = 1; break; } c = inp.charCodeAt(p); w = 1;`];
    const anyAstral = xElems.some((el) => { const q = this.charsetOf(el); return q && !q.neg && hasAstral(q.ranges); });
    if (anyAstral) {
      lines.push(`  if (c >= 0xd800 && c <= 0xdbff) { const c2 = inp.charCodeAt(p + 1); if (c2 >= 0xdc00 && c2 <= 0xdfff) { c = (c - 0xd800) * 0x400 + (c2 - 0xdc00) + 0x10000; w = 2; } }`);
    }
    for (let i = 0; i < xElems.length; i++) {
      const el = xElems[i];
      const good = yKeys.has(xKeys[i]);
      const q = this.charsetOf(el);
      if (q !== null) {
        lines.push(`  if (${this.classTest(q.ranges, q.neg, 'c', q.hint)}) { p += w;${good ? ' lg = p;' : ''} continue tcl; }`);
      } else if (el.k === 'ref') {
        const fn = this.fragFn(el.name);
        const esc = this.an.escFrags.has(el.name) ? ' mEsc = 1;' : '';
        lines.push(`  { const e = ${fn}(p); if (e >= 0) { p = e;${esc}${good ? ' lg = p;' : ''} continue tcl; } }`);
      } else return false;
    }
    lines.push(`  break; }`);
    lines.push(`if (lg < 0) fail = 1; else p = lg; }`);
    buf.push(lines.join('\n'));
    return true;
  }

  /** Long-string quote-run scanner: Seq[lit QQQ, Star(...), lit QQQ]. */
  tryLongString(pattern, buf) {
    if (pattern.k !== 'seq' || pattern.items.length !== 3) return false;
    const [open, mid, close] = pattern.items;
    if (open.k !== 'lit' || close.k !== 'lit' || open.text !== close.text) return false;
    if (open.text.length !== 3 || open.text[0] !== open.text[1] || open.text[1] !== open.text[2]) return false;
    if (mid.k !== 'star') return false;
    // element refs to try after a backslash
    const q = open.text.charCodeAt(0);
    const elemSeq = mid.item; // Seq[Opt(quotes), Alt[negclass, ECHAR, UCHAR]]
    let refs = [];
    const findRefs = (n) => {
      if (n.k === 'ref' && resolveCharset(n, this.g) === null) refs.push(n.name);
      else if (n.k === 'alt' || n.k === 'seq') n.items.forEach(findRefs);
      else if (n.k === 'opt' || n.k === 'star' || n.k === 'plus') findRefs(n.item);
    };
    findRefs(elemSeq);
    refs = [...new Set(refs)];
    this.emitLit(open, buf);
    const tryRefs = refs.map((r, i) =>
      `${i === 0 ? 'let e = ' : 'if (e < 0) e = '}${this.fragFn(r)}(p);`).join(' ');
    buf.push(`if (fail === 0) { let done = 0;
for (;;) {
  if (p >= len) { hitEnd = 1; break; }
  c = inp.charCodeAt(p);
  if (c === ${q}) {
    if (p + 2 < len) {
      if (inp.charCodeAt(p + 1) === ${q} && inp.charCodeAt(p + 2) === ${q}) { p += 3; done = 1; break; }
      p++;
    } else { hitEnd = 1; break; }
  } else if (c === 92) {
    ${tryRefs} if (e < 0) break; mEsc = 1; p = e;
  } else p++;
}
if (done === 0) fail = 1; }`);
    return true;
  }

  matcher(tok, valueInfo) {
    const buf = [];
    const marks = valueInfo && valueInfo.marks ? valueInfo.marks : null;
    const init = [];
    if (marks) {
      if (marks.m0After !== undefined) init.push(`m0 = -1;`);
      if (marks.mDForOptIndex !== undefined) init.push(`mD = -1;`);
    }
    init.push(`mEsc = 0;`);
    if (!this.tryLongString(tok.pattern, buf)) {
      if (tok.pattern.k === 'seq') {
        const markAfter = new Map();
        if (marks && marks.m0After !== undefined) markAfter.set(marks.m0After, 'm0');
        // mark for optional tail (LANG_DIR-style)
        if (marks && marks.mDForOptIndex !== undefined) {
          const idx = marks.mDForOptIndex;
          const opt = tok.pattern.items[idx];
          // compile items before, then the marked opt, then rest
          const pre = tok.pattern.items.slice(0, idx);
          this.emitSeq(pre, buf, markAfter);
          const inner = [];
          this.emitNode(opt.item, inner);
          buf.push(`if (fail === 0) { const sv = p;\n${inner.join('\n')}\nif (fail !== 0) { p = sv; fail = 0; } else mD = sv; }`);
          const rest = tok.pattern.items.slice(idx + 1);
          if (rest.length > 0) { buf.push(`if (fail === 0) {`); this.emitSeq(rest, buf, null); buf.push(`}`); }
        } else {
          this.emitSeq(tok.pattern.items, buf, markAfter);
        }
      } else {
        this.emitNode(tok.pattern, buf);
      }
    }
    this.out.push(`function m_${tok.name}(i) { let p = i, c = 0, w = 1, fail = 0; ${init.join(' ')}\n  ${buf.join('\n  ')}\n  return fail !== 0 ? -1 : p; }`);
  }
}

/* ------------------------------------------------------------------ */
/* value extraction                                                    */
/* ------------------------------------------------------------------ */

function collectNames(e, out) {
  if (!e || typeof e !== 'object') return;
  if (e.k === 'name') { if (!out.includes(e.name)) out.push(e.name); return; }
  if (e.k === 'call' && (e.fn === 'unescapeString' || e.fn === 'escapeString')) {
    // second argument is a quote-style constant of the iso, not a part name
    collectNames(e.args[0], out);
    return;
  }
  for (const key of Object.keys(e)) {
    const v = e[key];
    if (Array.isArray(v)) v.forEach((x) => collectNames(x, out));
    else if (v && typeof v === 'object') collectNames(v, out);
  }
}

/**
 * Derive value-extraction snippets for a token: how the => expression's
 * part names map to spans of the lexeme.
 *
 * v0.1 note (meta-language gap, reported upstream in the PR): token rules
 * have no explicit capture syntax; part names bind by these conventions:
 *   body  — lexeme minus fixed literal prefix/suffix
 *   NAME  — a top-level sub-token ref whose name contains NAME (PNAME_LN's
 *           `ns`/`local`), via a recorded boundary mark
 *   else  — the trailing optional group (LANG_DIR's `dir`), plus the span
 *           before it (`lang`), via a recorded optional-start mark
 */
export function tokenValueInfo(tok) {
  if (!tok.valueExpr) return null;
  const items = tok.pattern.k === 'seq' ? tok.pattern.items : [tok.pattern];
  let prefixLen = 0;
  let iPre = 0;
  while (iPre < items.length && items[iPre].k === 'lit') { prefixLen += items[iPre].text.length; iPre++; }
  let suffixLen = 0;
  let iSuf = items.length - 1;
  while (iSuf >= 0 && items[iSuf].k === 'lit') { suffixLen += items[iSuf].text.length; iSuf--; }

  const names = [];
  collectNames(tok.valueExpr, names);
  const spans = new Map();
  const marks = {};
  const unresolved = [];
  for (const nm of names) {
    if (nm === 'body') { spans.set(nm, { a: `ts + ${prefixLen}`, b: `te - ${suffixLen}`, refItem: false }); continue; }
    // sub-token ref match
    let matched = false;
    for (let i = 0; i < items.length; i++) {
      if (items[i].k === 'ref' && items[i].name.toLowerCase().includes(nm.toLowerCase())) {
        // boundary marks: start = (i==0 ? ts : mark after i-1), end = (i==last ? te : mark after i)
        if (i === 0 && items.length === 2) {
          marks.m0After = 0;
          spans.set(nm, { a: 'ts', b: 'tM0', refItem: true });
        } else if (i === items.length - 1 && items.length === 2) {
          marks.m0After = 0;
          spans.set(nm, { a: 'tM0', b: 'te', refItem: true });
        } else throw new Error(`token ${tok.name}: unsupported part position for '${nm}'`);
        matched = true;
        break;
      }
    }
    if (!matched) unresolved.push(nm);
  }
  if (unresolved.length > 0) {
    // LANG_DIR-style: last item is Opt(Seq[lit, …]); second unresolved name is
    // that optional, first is the middle span.
    const last = items[items.length - 1];
    if (unresolved.length === 2 && last.k === 'opt' && last.item.k === 'seq' && last.item.items[0].k === 'lit') {
      const litLen = last.item.items[0].text.length;
      marks.mDForOptIndex = items.length - 1;
      spans.set(unresolved[0], { a: `ts + ${prefixLen}`, b: `(tMD < 0 ? te : tMD)`, refItem: false });
      spans.set(unresolved[1], { optional: true, a: `tMD + ${litLen}`, b: 'te', refItem: false });
    } else {
      throw new Error(`token ${tok.name}: cannot resolve value parts ${unresolved.join(', ')}`);
    }
  }
  return { spans, marks };
}

/** Compile a token => expression into parser-scope JS snippet(s). */
export function compileTokenValue(tok, info) {
  const spanJs = (sp, forPrefixLabel) => {
    const b = forPrefixLabel && sp.refItem ? `${sp.b} - 1` : sp.b;
    return { a: sp.a, b };
  };
  const compile = (e) => {
    switch (e.k) {
      case 'name': {
        const sp = info.spans.get(e.name);
        if (!sp) throw new Error(`token ${tok.name}: no span for ${e.name}`);
        if (sp.optional) return `(tMD < 0 ? null : inp.slice(${sp.a}, ${sp.b}))`;
        return `inp.slice(${sp.a}, ${sp.b})`;
      }
      case 'tuple': return e.items.map(compile);
      case 'call': {
        const a0 = e.args[0];
        const sp = a0 && a0.k === 'name' ? info.spans.get(a0.name) : null;
        switch (e.fn) {
          case 'unescapeU': {
            const s = spanJs(sp);
            return `(tEsc !== 0 ? unescU(inp, ${s.a}, ${s.b}) : inp.slice(${s.a}, ${s.b}))`;
          }
          case 'unescapeString': {
            const s = spanJs(sp);
            return `(tEsc !== 0 ? unescStr(inp, ${s.a}, ${s.b}) : inp.slice(${s.a}, ${s.b}))`;
          }
          case 'unescapeLocal': {
            const s = spanJs(sp);
            return `(tEsc !== 0 ? unescLocal(inp, ${s.a}, ${s.b}) : inp.slice(${s.a}, ${s.b}))`;
          }
          case 'prefixLabel': {
            const s = spanJs(sp, true);
            return `inp.slice(${s.a}, ${s.b})`;
          }
          case 'labelPart': {
            const s = spanJs(sp);
            return `inp.slice(${s.a}, ${s.b})`;
          }
          case 'langCanon': {
            const s = spanJs(sp);
            return `langCanon(inp.slice(${s.a}, ${s.b}))`;
          }
          default: throw new Error(`token ${tok.name}: unknown value iso ${e.fn}`);
        }
      }
      default: throw new Error(`token ${tok.name}: unsupported value expr ${e.k}`);
    }
  };
  return compile(tok.valueExpr);
}

/* ------------------------------------------------------------------ */
/* driver: matchers + nextToken                                        */
/* ------------------------------------------------------------------ */

export function genLexer(g, an) {
  const lx = new LexGen(g, an);

  // token constants
  const consts = [`const T_EOF = 0;`];
  an.real.forEach((t, i) => {
    consts.push(`const T_${t.name} = ${i + 1};${t.litText !== undefined ? ` // '${t.litText}'` : ''}`);
  });
  consts.push(`const TOKEN_NAMES = ['<eof>', ${an.real.map((t) => JSON.stringify(t.litText !== undefined ? `'${t.litText}'` : t.name)).join(', ')}];`);

  // value snippets (drives which marks each matcher records)
  const valueSnippets = new Map();
  const valueInfos = new Map();
  for (const t of an.real) {
    if (!t.token || !t.valueExpr) continue;
    const info = tokenValueInfo(t.token);
    valueInfos.set(t.name, info);
    valueSnippets.set(t.name, compileTokenValue(t.token, info));
  }

  // matchers
  for (const t of an.real) lx.matcher(t, valueInfos.get(t.name) || null);

  // skip loop
  const skipCalls = an.skip.map((nm) => {
    const t = g.tokenByName.get(nm);
    const tokObj = { name: `SKIP_${nm}`, pattern: t.pattern };
    lx.matcher(tokObj, null);
    return `{ const e = m_SKIP_${nm}(pos); if (e > pos) { pos = e; continue; } }`;
  });

  // dispatch table
  const firsts = an.real.map((t) => firstOf(t.pattern, g));
  const byChar = new Map(); // charCode -> [tokenIndex]
  for (let c = 0; c < 128; c++) {
    const cands = [];
    firsts.forEach((f, i) => {
      if (f.ranges.some(([lo, hi]) => c >= lo && c <= hi)) cands.push(i);
    });
    if (cands.length > 0) byChar.set(c, cands);
  }
  const nonAscii = [];
  firsts.forEach((f, i) => {
    if (f.ranges.some(([, hi]) => hi > 127)) nonAscii.push(i);
  });

  // prefix subsumption: token B = Seq[Ref A, …] with a boundary mark after
  // item 0 — one scan of B decides both B and A (PNAME_LN / PNAME_NS): if B
  // fails but its A-prefix matched, the mark is A's end.
  const subsumes = new Map(); // B name -> A name
  for (const t of an.real) {
    const info = valueInfos.get(t.name);
    if (!info || !info.marks || info.marks.m0After !== 0) continue;
    if (t.pattern.k !== 'seq') continue;
    const head = t.pattern.items[0];
    if (head.k === 'ref' && an.kindOf.has(head.name)) subsumes.set(t.name, head.name);
  }

  const candBlock = (cands) => {
    const names = new Set(cands.map((i) => an.real[i].name));
    const skip = new Set();
    for (const i of cands) {
      const a = subsumes.get(an.real[i].name);
      if (a !== undefined && names.has(a)) skip.add(a);
    }
    const lines = [];
    for (const i of cands) {
      const t = an.real[i];
      if (skip.has(t.name)) continue;
      const a = subsumes.get(t.name);
      if (a !== undefined && names.has(a)) {
        lines.push(`e = m_${t.name}(pos); if (e > best) { best = e; bk = T_${t.name}; bEsc = mEsc; bM0 = m0; bMD = mD; }`);
        lines.push(`else if (e < 0 && m0 > best) { best = m0; bk = T_${a}; bEsc = 0; bM0 = -1; bMD = -1; }`);
      } else {
        lines.push(`e = m_${t.name}(pos); if (e > best) { best = e; bk = T_${t.name}; bEsc = mEsc; bM0 = m0; bMD = mD; }`);
      }
    }
    return lines.join('\n      ');
  };

  // group identical candidate lists
  const groups = new Map();
  for (const [c, cands] of byChar) {
    const key = cands.join(',');
    if (!groups.has(key)) groups.set(key, { cands, chars: [] });
    groups.get(key).chars.push(c);
  }
  const cases = [];
  for (const { cands, chars } of groups.values()) {
    const labels = chars.map((c) => `case ${c}:`).join(' ');
    cases.push(`    ${labels} {\n      ${candBlock(cands)}\n      break;\n    }`);
  }

  const nextToken = `
function nextToken() {
  // skip tokens (${an.skip.join(', ')})
  for (;;) {
    if (pos >= len) break;
    ${skipCalls.join('\n    ')}
    break;
  }
  ts = pos;
  if (pos >= len) {
    if (final === 0) throw INCOMPLETE;
    tk = T_EOF; te = pos;
    return;
  }
  hitEnd = 0;
  const c0 = inp.charCodeAt(pos);
  let e = 0, best = -1, bk = -1, bEsc = 0, bM0 = -1, bMD = -1;
  switch (c0) {
${cases.join('\n')}
    default: {
      if (c0 > 127) {
        ${candBlock(nonAscii)}
      }
      break;
    }
  }
  // Suspension rule (push mode): if any candidate touched the buffer end
  // (hitEnd), a longer match may exist in the next chunk — do not commit.
  if (final === 0 && (hitEnd !== 0 || best === len || best < 0)) throw INCOMPLETE;
  if (best < 0) lexErr();
  tk = bk; te = best; tEsc = bEsc; tM0 = bM0; tMD = bMD;
  pos = best;
}`;

  return {
    constsCode: consts.join('\n'),
    machineCode: [
      `// ---- charset predicates & token matchers (generated) ----`,
      lx.out.join('\n'),
      nextToken,
    ].join('\n\n'),
    valueSnippets,
    firsts,
    numTokens: an.real.length + 1,
  };
}

/**
 * Standalone full-match functions over selected tokens (serializer guards):
 * same matcher codegen, wrapped in an isolated scope.
 */
export function genStandaloneMatchers(g, an, tokenNames) {
  const lx = new LexGen(g, an);
  for (const nm of tokenNames) {
    const t = g.tokenByName.get(nm);
    lx.matcher({ name: nm, pattern: t.pattern }, null);
  }
  const names = tokenNames.map((nm) => `fm_${nm}`);
  return `const [${names.join(', ')}] = (() => {
  let inp = '', len = 0, mEsc = 0, m0 = -1, mD = -1, hitEnd = 0;
  void mEsc; void m0; void mD; void hitEnd;
${lx.out.join('\n')}
  const full = (m) => (s) => { inp = s; len = s.length; return m(0) === len; };
  return [${tokenNames.map((nm) => `full(m_${nm})`).join(', ')}];
})();`;
}

export { firstOf, resolveCharset };
