/**
 * lexer-gen.js — compiles Shuttle token rules to a direct-coded Rust lexer.
 *
 * Same strategy as the JS backend (one matcher fn per token, 128-entry
 * first-byte dispatch, longest-match with declaration-order ties, the
 * `X* Y` trailing-context peephole, quote-run long-string scanner,
 * INCOMPLETE suspension at chunk boundaries), with the Rust-specific twists:
 *
 *  - matchers/fragments are FREE FUNCTIONS over (&[u8], usize, &mut Fl) so
 *    the parser machine can split-borrow its fields around them;
 *  - positions are UTF-8 BYTE offsets (the JS artifact uses UTF-16 units;
 *    both are internally consistent — spans never cross the API);
 *  - ASCII-only positive charsets test raw bytes; anything else decodes a
 *    code point via cp_at (negated all-ASCII classes in star loops consume
 *    bytewise: every non-ASCII byte is accepted, and the loop can only stop
 *    on an ASCII byte, so it always ends on a char boundary);
 *  - class tests bind a fresh local `c` per test site (no shared mutable
 *    scratch vars, keeps rustc's definite-initialization analysis happy).
 *
 * Token analysis (charsets, FIRST sets, escape-fragment detection, value
 * span derivation) is backend-agnostic and imported from gen-js.
 */

import {
  analyzeTokens,
  firstOf,
  resolveCharset,
  tokenValueInfo,
} from '../../gen-js/src/lexer-gen.js';

export { analyzeTokens, firstOf, resolveCharset };

/* ------------------------------------------------------------------ */
/* charset utilities                                                   */
/* ------------------------------------------------------------------ */

function litToCp(text) {
  const cp = text.codePointAt(0);
  const w = cp > 0xffff ? 2 : 1;
  return text.length === w ? cp : null;
}

function rangesTest(ranges, cVar) {
  const parts = ranges.map(([lo, hi]) => {
    if (lo === hi) return `${cVar} == ${lo}`;
    if (lo === 0) return `${cVar} <= ${hi}`; // c is unsigned: >= 0 is vacuous
    return `${cVar} >= ${lo} && ${cVar} <= ${hi}`;
  });
  return parts.map((p) => (parts.length > 1 ? `(${p})` : p)).join(' || ');
}

const asciiOnly = (ranges) => ranges.every(([, hi]) => hi <= 127);

function utf8Bytes(text) {
  return [...Buffer.from(text, 'utf8')];
}

/* ------------------------------------------------------------------ */
/* matcher compilation                                                 */
/* ------------------------------------------------------------------ */

class LexGen {
  constructor(g, an) {
    this.g = g;
    this.an = an;
    this.predFns = new Map();   // rangesKey -> fnName (positive membership)
    this.fragFns = new Map();   // fragment name -> emitted flag
    this.out = [];
    this.lbl = 0;
  }

  /** Positive-membership predicate fn for a big charset. */
  predFor(ranges, hint) {
    const key = JSON.stringify(ranges);
    let fn = this.predFns.get(key);
    if (!fn) {
      fn = `in_${(hint || 'cs').toLowerCase()}${this.predFns.size}`;
      this.predFns.set(key, fn);
      this.out.push(`#[inline]\nfn ${fn}(c: u32) -> bool {\n    ${rangesTest(ranges, 'c')}\n}`);
    }
    return fn;
  }

  /** Positive-membership test text (call sites apply negation, wrapping). */
  posTest(ranges, cVar, hint) {
    if (ranges.length > 6) return `${this.predFor(ranges, hint)}(${cVar})`;
    return rangesTest(ranges, cVar);
  }

  /** Charset descriptor of a node, or null. */
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

  /** Emit "match one char of class, advance p" code. */
  emitClass(node, buf) {
    const cs = this.charsetOf(node);
    if (cs === null) throw new Error('emitClass on non-charset node');
    if (!cs.neg && asciiOnly(cs.ranges)) {
      buf.push(`if p >= len { fl.hit_end = true; fail = true; } else { let c = u32::from(inp[p]); if ${this.posTest(cs.ranges, 'c', cs.hint)} { p += 1; } else { fail = true; } }`);
    } else if (cs.neg) {
      // negated: decode so a matching (excluded-set-free) char advances fully
      buf.push(`if p >= len { fl.hit_end = true; fail = true; } else { let (c, w) = cp_at(inp, p); if ${this.posTest(cs.ranges, 'c', cs.hint)} { fail = true; } else { p += w; } }`);
    } else {
      buf.push(`if p >= len { fl.hit_end = true; fail = true; } else { let (c, w) = cp_at(inp, p); if ${this.posTest(cs.ranges, 'c', cs.hint)} { p += w; } else { fail = true; } }`);
    }
  }

  emitLit(node, buf) {
    const bytes = utf8Bytes(node.text);
    const conds = bytes.map((bb, i) => `inp[p${i ? ` + ${i}` : ''}] == ${bb}`);
    buf.push(`if p + ${bytes.length} > len { fl.hit_end = true; fail = true; } else if ${conds.join(' && ')} { p += ${bytes.length}; } else { fail = true; }`);
  }

  fragFn(name) {
    if (!this.fragFns.has(name)) {
      this.fragFns.set(name, true);
      const t = this.g.tokenByName.get(name);
      if (!t) throw new Error(`unknown fragment ${name}`);
      const buf = [];
      this.emitNode(t.pattern, buf);
      const body = buf.join('\n    ');
      const lenDecl = /\blen\b/.test(body) ? '\n    let len = inp.len();' : '';
      this.out.push(`fn f_${name}(inp: &[u8], i: usize, fl: &mut Fl) -> isize {${lenDecl}
    let mut p = i;
    let mut fail = false;
    ${body}
    if fail { -1 } else { p as isize }
}`);
    }
    return `f_${name}`;
  }

  emitNode(node, buf) {
    switch (node.k) {
      case 'lit': this.emitLit(node, buf); return;
      case 'class': this.emitClass(node, buf); return;
      case 'ref': {
        const cs = resolveCharset(node, this.g);
        if (cs !== null) { this.emitClass(node, buf); return; }
        const fn = this.fragFn(node.name);
        const esc = this.an.escFrags.has(node.name) ? ' fl.m_esc = true;' : '';
        buf.push(`{ let e = ${fn}(inp, p, fl); if e < 0 { fail = true; } else { p = e as usize;${esc} } }`);
        return;
      }
      case 'seq': return this.emitSeq(node.items, buf, null);
      case 'alt': {
        const emitAlts = (i) => {
          const inner = [];
          this.emitNode(node.items[i], inner);
          if (i === node.items.length - 1) return inner.join('\n');
          return `${inner.join('\n')}\nif fail { p = sv; fail = false;\n${emitAlts(i + 1)}\n}`;
        };
        buf.push(`{ let sv = p;\n${emitAlts(0)}\n}`);
        return;
      }
      case 'opt': {
        const inner = [];
        this.emitNode(node.item, inner);
        buf.push(`{ let sv = p;\n${inner.join('\n')}\nif fail { p = sv; fail = false; } }`);
        return;
      }
      case 'star': return this.emitStar(node.item, buf);
      case 'plus': {
        this.emitNode(node.item, buf);
        buf.push(`if !fail {`);
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
      if (!cs.neg && asciiOnly(cs.ranges)) {
        buf.push(`loop { if p >= len { fl.hit_end = true; break; } let c = u32::from(inp[p]); if !(${this.posTest(cs.ranges, 'c', cs.hint)}) { break; } p += 1; }`);
      } else if (cs.neg && asciiOnly(cs.ranges)) {
        // bytewise: every non-ASCII byte is accepted, loop only stops on ASCII
        buf.push(`loop { if p >= len { fl.hit_end = true; break; } let c = u32::from(inp[p]); if ${this.posTest(cs.ranges, 'c', cs.hint)} { break; } p += 1; }`);
      } else if (cs.neg) {
        buf.push(`loop { if p >= len { fl.hit_end = true; break; } let (c, w) = cp_at(inp, p); if ${this.posTest(cs.ranges, 'c', cs.hint)} { break; } p += w; }`);
      } else {
        buf.push(`loop { if p >= len { fl.hit_end = true; break; } let (c, w) = cp_at(inp, p); if !(${this.posTest(cs.ranges, 'c', cs.hint)}) { break; } p += w; }`);
      }
      return;
    }
    if (item.k === 'alt') {
      // optimized: class elements inline, fragment refs as calls
      const lbl = `'s${this.lbl++}`;
      const classEls = item.items.map((el) => this.charsetOf(el));
      const anyClass = classEls.some((q) => q !== null);
      const allAscii = classEls.every((q) => q === null || (asciiOnly(q.ranges) && !q.neg) || (q.neg && asciiOnly(q.ranges)));
      const lines = [`${lbl}: loop { if p >= len { fl.hit_end = true; break; }`];
      if (anyClass) {
        if (allAscii) lines.push(`  let c = u32::from(inp[p]); let w = 1;`);
        else lines.push(`  let (c, w) = cp_at(inp, p);`);
      }
      for (let i = 0; i < item.items.length; i++) {
        const el = item.items[i];
        const q = classEls[i];
        if (q !== null) {
          if (q.neg) lines.push(`  if !(${this.posTest(q.ranges, 'c', q.hint)}) { p += w; continue ${lbl}; }`);
          else lines.push(`  if ${this.posTest(q.ranges, 'c', q.hint)} { p += w; continue ${lbl}; }`);
        } else if (el.k === 'ref') {
          const fn = this.fragFn(el.name);
          const esc = this.an.escFrags.has(el.name) ? ' fl.m_esc = true;' : '';
          lines.push(`  { let e = ${fn}(inp, p, fl); if e >= 0 { p = e as usize;${esc} continue ${lbl}; } }`);
        } else {
          // general element
          const inner = [];
          this.emitNode(el, inner);
          lines.push(`  { let sv = p; let mut fail = false; ${inner.join(' ')} if !fail { continue ${lbl}; } p = sv; }`);
        }
      }
      lines.push(`  break; }`);
      buf.push(lines.join('\n'));
      return;
    }
    // generic star
    const inner = [];
    this.emitNode(item, inner);
    buf.push(`loop { let sv = p;\n${inner.join('\n')}\nif fail { p = sv; fail = false; break; }\nif p == sv { break; } }`);
  }

  /**
   * Sequence with the `X* Y` trailing-context peephole and optional
   * boundary marks (markAfter: Map(index -> mark field)).
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
      if (markAfter && markAfter.has(lastIdx)) inner.push(`if !fail { fl.${markAfter.get(lastIdx)} = p as isize; }`);
      if (first) buf.push(inner.join('\n'));
      else buf.push(`if !fail {\n${inner.join('\n')}\n}`);
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
    const classEls = xElems.map((el) => this.charsetOf(el));
    const anyClass = classEls.some((q) => q !== null);
    const allAscii = classEls.every((q) => q === null || asciiOnly(q.ranges));
    const lbl = `'t${this.lbl++}`;
    const lines = [`{ let mut lg: isize = -1;`, `${lbl}: loop { if p >= len { fl.hit_end = true; break; }`];
    if (anyClass) {
      if (allAscii) lines.push(`  let c = u32::from(inp[p]); let w = 1;`);
      else lines.push(`  let (c, w) = cp_at(inp, p);`);
    }
    for (let i = 0; i < xElems.length; i++) {
      const el = xElems[i];
      const good = yKeys.has(xKeys[i]);
      const q = classEls[i];
      if (q !== null) {
        const test = q.neg ? `!(${this.posTest(q.ranges, 'c', q.hint)})` : this.posTest(q.ranges, 'c', q.hint);
        lines.push(`  if ${test} { p += w;${good ? ' lg = p as isize;' : ''} continue ${lbl}; }`);
      } else if (el.k === 'ref') {
        const fn = this.fragFn(el.name);
        const esc = this.an.escFrags.has(el.name) ? ' fl.m_esc = true;' : '';
        lines.push(`  { let e = ${fn}(inp, p, fl); if e >= 0 { p = e as usize;${esc}${good ? ' lg = p as isize;' : ''} continue ${lbl}; } }`);
      } else return false;
    }
    lines.push(`  break; }`);
    lines.push(`if lg < 0 { fail = true; } else { p = lg as usize; } }`);
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
    const q = open.text.charCodeAt(0);
    const elemSeq = mid.item;
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
      `${i === 0 ? 'let mut e = ' : 'if e < 0 { e = '}${this.fragFn(r)}(inp, p, fl)${i === 0 ? ';' : '; }'}`).join('\n        ');
    buf.push(`if !fail { let mut done = false;
loop {
    if p >= len { fl.hit_end = true; break; }
    let c = inp[p];
    if u32::from(c) == ${q} {
        if p + 2 < len {
            if u32::from(inp[p + 1]) == ${q} && u32::from(inp[p + 2]) == ${q} { p += 3; done = true; break; }
            p += 1;
        } else { fl.hit_end = true; break; }
    } else if c == 92 {
        ${tryRefs}
        if e < 0 { break; }
        fl.m_esc = true; p = e as usize;
    } else { p += 1; }
}
if !done { fail = true; } }`);
    return true;
  }

  matcher(tok, valueInfo) {
    const buf = [];
    const marks = valueInfo && valueInfo.marks ? valueInfo.marks : null;
    const init = [`fl.m_esc = false;`];
    if (marks) {
      if (marks.m0After !== undefined) init.push(`fl.m0 = -1;`);
      if (marks.mDForOptIndex !== undefined) init.push(`fl.m_d = -1;`);
    }
    if (!this.tryLongString(tok.pattern, buf)) {
      if (tok.pattern.k === 'seq') {
        const markAfter = new Map();
        if (marks && marks.m0After !== undefined) markAfter.set(marks.m0After, 'm0');
        if (marks && marks.mDForOptIndex !== undefined) {
          const idx = marks.mDForOptIndex;
          const opt = tok.pattern.items[idx];
          const pre = tok.pattern.items.slice(0, idx);
          this.emitSeq(pre, buf, markAfter);
          const inner = [];
          this.emitNode(opt.item, inner);
          buf.push(`if !fail { let sv = p;\n${inner.join('\n')}\nif fail { p = sv; fail = false; } else { fl.m_d = sv as isize; } }`);
          const rest = tok.pattern.items.slice(idx + 1);
          if (rest.length > 0) { buf.push(`if !fail {`); this.emitSeq(rest, buf, null); buf.push(`}`); }
        } else {
          this.emitSeq(tok.pattern.items, buf, markAfter);
        }
      } else {
        this.emitNode(tok.pattern, buf);
      }
    }
    const body = buf.join('\n    ');
    const lenDecl = /\blen\b/.test(body) ? '\n    let len = inp.len();' : '';
    this.out.push(`fn m_${tok.name}(inp: &[u8], i: usize, fl: &mut Fl) -> isize {${lenDecl}
    let mut p = i;
    let mut fail = false;
    ${init.join(' ')}
    ${body}
    if fail { -1 } else { p as isize }
}`);
  }
}

/* ------------------------------------------------------------------ */
/* value extraction (Rust snippets)                                    */
/* ------------------------------------------------------------------ */

/** Translate a tokenValueInfo span expression to Rust. */
function spanRs(expr) {
  if (expr === '(tMD < 0 ? te : tMD)') return '(if self.t_md < 0 { self.te } else { self.t_md as usize })';
  return expr
    .replace(/\btM0\b/g, '(self.t_m0 as usize)')
    .replace(/\btMD\b/g, '(self.t_md as usize)')
    .replace(/\bts\b/g, 'self.ts')
    .replace(/\bte\b/g, 'self.te')
    .replace(/ \+ 0\b/g, '')
    .replace(/ - 0\b/g, '');
}

const slice = (a, b) => `&self.inp[${spanRs(a)}..${spanRs(b)}]`;

/**
 * Compile a token => expression into Rust snippet(s) evaluated in a
 * production body (before `self.next_token()`). Returns
 * { rs, t } or an array of them for tuple-valued tokens.
 */
export function compileTokenValue(tok, info) {
  const compile = (e) => {
    switch (e.k) {
      case 'name': {
        const sp = info.spans.get(e.name);
        if (!sp) throw new Error(`token ${tok.name}: no span for ${e.name}`);
        if (sp.optional) {
          return { rs: `if self.t_md < 0 { None } else { Some(Rc::from(${slice(sp.a, sp.b)})) }`, t: 'optstr' };
        }
        return { rs: `Rc::from(${slice(sp.a, sp.b)})`, t: 'str' };
      }
      case 'tuple': return e.items.map(compile);
      case 'call': {
        const a0 = e.args[0];
        const sp = a0 && a0.k === 'name' ? info.spans.get(a0.name) : null;
        const escaping = (fn, fallible) => {
          const s = slice(sp.a, sp.b);
          const call = fallible
            ? `rc_from_string(${fn}(${s}).map_err(|_| self.perr("INVALID_CODEPOINT"))?)`
            : `rc_from_string(${fn}(${s}))`;
          return { rs: `if self.t_esc { ${call} } else { Rc::from(${s}) }`, t: 'str' };
        };
        switch (e.fn) {
          case 'unescapeU': return escaping('unesc_u', true);
          case 'unescapeString': return escaping('unesc_str', true);
          case 'unescapeLocal': return escaping('unesc_local', false);
          case 'prefixLabel': {
            const b = sp.refItem ? `${sp.b} - 1` : sp.b;
            return { rs: `Rc::from(${slice(sp.a, b)})`, t: 'str' };
          }
          case 'labelPart':
            return { rs: `Rc::from(${slice(sp.a, sp.b)})`, t: 'str' };
          case 'langCanon':
            return { rs: `rc_from_cow(lang_canon(${slice(sp.a, sp.b)}))`, t: 'str' };
          default: throw new Error(`token ${tok.name}: unknown value iso ${e.fn}`);
        }
      }
      default: throw new Error(`token ${tok.name}: unsupported value expr ${e.k}`);
    }
  };
  return compile(tok.valueExpr);
}

/* ------------------------------------------------------------------ */
/* driver: matchers + next_token                                       */
/* ------------------------------------------------------------------ */

export function genLexer(g, an) {
  const lx = new LexGen(g, an);

  // token constants
  const consts = [`const T_EOF: u16 = 0;`];
  an.real.forEach((t, i) => {
    consts.push(`const T_${t.name}: u16 = ${i + 1};${t.litText !== undefined ? ` // '${t.litText}'` : ''}`);
  });
  consts.push(`static TOKEN_NAMES: [&str; ${an.real.length + 1}] = ["<eof>", ${an.real.map((t) => JSON.stringify(t.litText !== undefined ? `'${t.litText}'` : t.name)).join(', ')}];`);

  // value snippets (drives which marks each matcher records)
  const valueSnippets = new Map();
  const valueInfos = new Map();
  for (const t of an.real) {
    if (!t.token || !t.valueExpr) continue;
    const info = tokenValueInfo(t.token);
    valueInfos.set(t.name, info);
    valueSnippets.set(t.name, compileTokenValue(t.token, info));
  }

  // dispatch table
  const firsts = an.real.map((t) => firstOf(t.pattern, g));
  const byChar = new Map(); // byte -> [tokenIndex]
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

  // prefix subsumption (PNAME_LN / PNAME_NS): one scan decides both.
  const subsumes = new Map();
  for (const t of an.real) {
    const info = valueInfos.get(t.name);
    if (!info || !info.marks || info.marks.m0After !== 0) continue;
    if (t.pattern.k !== 'seq') continue;
    const head = t.pattern.items[0];
    if (head.k === 'ref' && an.kindOf.has(head.name)) subsumes.set(t.name, head.name);
  }

  const usedMatchers = new Set();
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
      usedMatchers.add(t.name);
      const a = subsumes.get(t.name);
      lines.push(`e = m_${t.name}(inp, self.pos, &mut fl); if e > best { best = e; bk = T_${t.name}; b_esc = fl.m_esc; b_m0 = fl.m0; b_md = fl.m_d; }`);
      if (a !== undefined && names.has(a)) {
        lines.push(`else if e < 0 && fl.m0 > best { best = fl.m0; bk = T_${a}; b_esc = false; b_m0 = -1; b_md = -1; }`);
      }
    }
    return lines.join('\n            ');
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
    const labels = chars.join(' | ');
    cases.push(`        ${labels} => {\n            ${candBlock(cands)}\n        }`);
  }
  const nonAsciiBlock = candBlock(nonAscii);

  // matchers — emitted only for tokens the dispatch actually calls (the
  // prefix-subsumption rule can make a token's own matcher globally dead)
  for (const t of an.real) {
    if (usedMatchers.has(t.name)) lx.matcher(t, valueInfos.get(t.name) || null);
  }

  // skip loop
  const skipCalls = an.skip.map((nm) => {
    const t = g.tokenByName.get(nm);
    const tokObj = { name: `SKIP_${nm}`, pattern: t.pattern };
    lx.matcher(tokObj, null);
    return `{ let e = m_SKIP_${nm}(inp, self.pos, &mut fl); if e > self.pos as isize { self.pos = e as usize; continue; } }`;
  });

  const nextToken = `
fn next_token(&mut self) -> Result<(), PErr> {
    let inp: &[u8] = self.inp.as_bytes();
    let len = inp.len();
    let mut fl = Fl::default();
    // skip tokens (${an.skip.join(', ')})
    loop {
        if self.pos >= len { break; }
        ${skipCalls.join('\n        ')}
        break;
    }
    self.ts = self.pos;
    if self.pos >= len {
        if !self.is_final { return Err(PErr::Incomplete); }
        self.tk = T_EOF;
        self.te = self.pos;
        return Ok(());
    }
    fl.hit_end = false;
    let c0 = inp[self.pos];
    let mut e: isize;
    let mut best: isize = -1;
    let mut bk: u16 = 0;
    let mut b_esc = false;
    let mut b_m0: isize = -1;
    let mut b_md: isize = -1;
    match c0 {
${cases.join('\n')}
        _ => {
            if c0 > 127 {
                ${nonAsciiBlock}
            }
        }
    }
    // Suspension rule (push mode): if any candidate touched the buffer end,
    // a longer match may exist in the next chunk — do not commit.
    if !self.is_final && (fl.hit_end || best == len as isize || best < 0) { return Err(PErr::Incomplete); }
    if best < 0 { return Err(self.lex_err()); }
    self.tk = bk;
    self.te = best as usize;
    self.t_esc = b_esc;
    self.t_m0 = b_m0;
    self.t_md = b_md;
    self.pos = best as usize;
    Ok(())
}`;

  return {
    lx,
    constsCode: consts.join('\n'),
    matchersCode: () => `// ---- charset predicates & token matchers (generated) ----\n${lx.out.join('\n\n')}`,
    nextTokenCode: nextToken,
    valueSnippets,
    firsts,
    numTokens: an.real.length + 1,
  };
}

/**
 * Full-match wrappers over selected token/fragment patterns (serializer
 * guards). Reuses the already-generated matcher/fragment functions.
 */
export function genFullMatchers(g, an, lx, tokenNames) {
  const lines = [];
  for (const nm of tokenNames) {
    let inner;
    if (an.kindOf.has(nm)) {
      if (!lx.out.some((s) => s.includes(`fn m_${nm}(`))) {
        throw new Error(`full-matcher for ${nm} requested but its matcher was never emitted (subsumption-dead?)`);
      }
      inner = `m_${nm}`;
    } else {
      inner = lx.fragFn(nm); // force emission for fragments
    }
    lines.push(`fn fm_${nm}(s: &str) -> bool {
    let mut fl = Fl::default();
    ${inner}(s.as_bytes(), 0, &mut fl) == s.len() as isize
}`);
  }
  return lines.join('\n');
}
