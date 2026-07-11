/**
 * parser-gen.js — compiles Shuttle productions to recursive-descent
 * LL(1)-on-token-kinds Rust parser methods (spec/SHUTTLE.md §6).
 *
 * Same architecture as the JS backend (FIRST/nullable over token kinds,
 * conflict = generator error, earliest emission, thread-locals as loop
 * variables, explicit depth guard), with Rust-specific choices:
 *
 *  - every production is a `fn p_X(&mut self, …) -> Result<T, PErr>` method
 *    on the machine; INCOMPLETE/syntax signals propagate with `?`;
 *  - value-producing dispatches use a deferred-init local (`let _v: T;`)
 *    that every non-diverging arm assigns exactly once — rustc's
 *    definite-initialization check then *proves* the grammar's value
 *    obligations (a v0.1 well-formedness rule checked for free);
 *  - FIRST-set membership beyond 3 kinds compiles to a compile-time bitmask
 *    constant (u64/u128), not a runtime table.
 */

import { compileClause, compileExpr, Ctx, rustTy } from './clausec.js';

const MAXDEPTH = 8192;

export class ParserGen {
  constructor(g, an, lex, gen) {
    this.g = g;
    this.an = an;
    this.lex = lex;
    this.gen = gen; // shared: constPool, envTypes
    this.firstK = new Map();
    this.nullableP = new Map();
    this.tables = new Map(); // setKey -> const name
    this.tableDefs = [];
    this.labelCtr = 0;
    this.computeFirst();
    this.recursive = this.findRecursive();
  }

  litKind(text) {
    const nm = this.an.refLits.get(text);
    if (!nm) throw new Error(`literal '${text}' not tokenized`);
    return `T_${nm}`;
  }
  tokKind(name) {
    if (!this.an.kindOf.has(name)) throw new Error(`token ${name} not a real token`);
    return `T_${name}`;
  }
  kindNum(kstr) {
    if (kstr === 'T_EOF') return 0;
    return this.an.kindOf.get(kstr.slice(2));
  }

  /* ---------------- FIRST/nullable ---------------- */

  firstPrim(prim) {
    switch (prim.kind) {
      case 'token': return { set: new Set([this.tokKind(prim.name)]), nullable: false };
      case 'lit': return { set: new Set([this.litKind(prim.text)]), nullable: false };
      case 'call': {
        return {
          set: new Set(this.firstK.get(prim.name) || []),
          nullable: this.nullableP.get(prim.name) || false,
        };
      }
      case 'group': {
        const set = new Set();
        let nullable = false;
        for (const a of prim.alts) {
          const f = this.firstItems(a.items);
          for (const k of f.set) set.add(k);
          nullable = nullable || f.nullable;
        }
        return { set, nullable };
      }
      default: throw new Error(`firstPrim ${prim.kind}`);
    }
  }

  firstItem(it) {
    if (it.kind === 'sem') return { set: new Set(), nullable: true };
    if (it.kind === 'thread') {
      const set = new Set();
      for (const a of it.body) for (const k of this.firstItems(a.items).set) set.add(k);
      return { set, nullable: it.rep === 'star' };
    }
    const f = this.firstPrim(it.prim);
    if (it.postfix === 'opt' || it.postfix === 'star') return { set: f.set, nullable: true };
    return f;
  }

  firstItems(items) {
    const set = new Set();
    let nullable = true;
    for (const it of items) {
      const f = this.firstItem(it);
      for (const k of f.set) set.add(k);
      if (!f.nullable) { nullable = false; break; }
    }
    return { set, nullable };
  }

  computeFirst() {
    for (const p of this.g.prods) { this.firstK.set(p.name, new Set()); this.nullableP.set(p.name, false); }
    let changed = true;
    while (changed) {
      changed = false;
      for (const p of this.g.prods) {
        const set = this.firstK.get(p.name);
        const before = set.size;
        let nullable = false;
        for (const a of p.alts) {
          const f = this.firstItems(a.items);
          for (const k of f.set) set.add(k);
          nullable = nullable || f.nullable;
        }
        if (set.size !== before || nullable !== this.nullableP.get(p.name)) changed = true;
        if (nullable) this.nullableP.set(p.name, true);
      }
    }
  }

  findRecursive() {
    const calls = new Map();
    const walk = (items, out) => {
      for (const it of items) {
        if (it.kind === 'sem') continue;
        if (it.kind === 'thread') { for (const a of it.body) walk(a.items, out); continue; }
        if (it.prim.kind === 'call') out.add(it.prim.name);
        if (it.prim.kind === 'group') for (const a of it.prim.alts) walk(a.items, out);
      }
    };
    for (const p of this.g.prods) {
      const out = new Set();
      for (const a of p.alts) walk(a.items, out);
      calls.set(p.name, out);
    }
    const recursive = new Set();
    for (const p of this.g.prods) {
      const seen = new Set();
      const stack = [...(calls.get(p.name) || [])];
      while (stack.length) {
        const q = stack.pop();
        if (q === p.name) { recursive.add(p.name); break; }
        if (seen.has(q)) continue;
        seen.add(q);
        for (const r of calls.get(q) || []) stack.push(r);
      }
    }
    return recursive;
  }

  /* ---------------- set membership tests ---------------- */

  testFor(set) {
    const kinds = [...set].sort();
    if (kinds.length === 0) return 'false';
    if (kinds.length <= 3) return `matches!(self.tk, ${kinds.join(' | ')})`;
    const key = kinds.join(',');
    let nm = this.tables.get(key);
    if (!nm) {
      nm = `FS_${this.tables.size}`;
      this.tables.set(key, nm);
      const nums = kinds.map((k) => this.kindNum(k));
      const width = this.an.real.length + 1 <= 64 ? 64 : 128;
      if (this.an.real.length + 1 > 128) throw new Error('more than 128 token kinds: FIRST-set bitmask needs an array fallback');
      let mask = 0n;
      for (const n of nums) mask |= 1n << BigInt(n);
      this.tableDefs.push(`const ${nm}: u${width} = 0x${mask.toString(16)}; // { ${kinds.join(', ')} }`);
    }
    return `(${nm} >> self.tk) & 1 != 0`;
  }

  /* ---------------- item compilation ---------------- */

  semTypeHasValue(semType) { return semType !== 'unit' && semType !== 'graph'; }

  retTy(semType) {
    if (semType === 'unit' || semType === 'graph') return '()';
    if (semType === 'term' || semType === 'term!') return 'Term';
    return 'Rc<str>';
  }

  calleeType(name) {
    const p = this.g.prodByName.get(name);
    if (!p) throw new Error(`unknown production '${name}'`);
    const st = p.semType;
    if (st === 'term' || st === 'term!') return 'term';
    if (st === 'unit' || st === 'graph') return null;
    return 'str';
  }

  callCode(prim, ctx) {
    const args = (prim.args || []).map((a) => {
      const stmts = [];
      const r = compileExpr(a, ctx, stmts);
      if (stmts.length > 0) throw new Error('side-effecting call arguments unsupported');
      return r.rs;
    });
    return `self.p_${prim.name}(${args.join(', ')})?`;
  }

  /** Consume a token/lit prim. */
  consumeToken(kind, checked, out) {
    if (!checked) out.push(`if self.tk != ${kind} { return Err(self.perr_exp(${kind})); }`);
    out.push(`self.next_token()?;`);
  }

  bindToken(prim, binding, ctx, checked, out) {
    const kind = this.tokKind(prim.name);
    if (!checked) out.push(`if self.tk != ${kind} { return Err(self.perr_exp(${kind})); }`);
    if (binding) {
      const snip = this.lex.valueSnippets.get(prim.name);
      if (snip === undefined) throw new Error(`token ${prim.name} has no value but is bound`);
      if (Array.isArray(snip)) {
        snip.forEach((s, i) => out.push(`let ${binding}_${i}: ${rustTy(s.t)} = ${s.rs};`));
        ctx.bindings.set(binding, {
          t: 'tuple',
          tuple: snip.map((s, i) => ({ rs: `${binding}_${i}.clone()`, ref: `${binding}_${i}`, t: s.t })),
        });
      } else {
        out.push(`let ${binding}: ${rustTy(snip.t)} = ${snip.rs};`);
        ctx.bindings.set(binding, { rs: binding, t: snip.t });
      }
    }
    out.push(`self.next_token()?;`);
  }

  /**
   * Compile a primary occurrence (no postfix), optionally assigning `into`
   * ({ target, wrapSome }).
   */
  primOnce(prim, binding, ctx, checked, out, into = null) {
    const wrap = (expr) => (into && into.wrapSome ? `Some(${expr})` : expr);
    switch (prim.kind) {
      case 'token': {
        if (into) {
          const snip = this.lex.valueSnippets.get(prim.name);
          const kind = this.tokKind(prim.name);
          if (!checked) out.push(`if self.tk != ${kind} { return Err(self.perr_exp(${kind})); }`);
          if (Array.isArray(snip)) throw new Error(`tuple token ${prim.name} in value position unsupported`);
          out.push(`${into.target} = ${wrap(snip.rs)};`);
          out.push(`self.next_token()?;`);
        } else this.bindToken(prim, binding, ctx, checked, out);
        return;
      }
      case 'lit': {
        this.consumeToken(this.litKind(prim.text), checked, out);
        return;
      }
      case 'call': {
        const t = this.calleeType(prim.name);
        const call = this.callCode(prim, ctx);
        if (into) out.push(`${into.target} = ${wrap(call)};`);
        else if (binding) {
          if (t === null) throw new Error(`binding on unit production ${prim.name}`);
          out.push(`let ${binding} = ${call};`);
          ctx.bindings.set(binding, { rs: binding, t });
        } else out.push(`${call};`);
        return;
      }
      case 'group': {
        if (binding && !into) {
          out.push(`let ${binding}: Term;`);
          ctx.bindings.set(binding, { rs: binding, t: 'term' });
          this.dispatch(prim.alts, ctx, out, { assign: { target: binding, wrapSome: false }, checked });
        } else {
          this.dispatch(prim.alts, ctx, out, { assign: into, checked });
        }
        return;
      }
      default: throw new Error(`primOnce ${prim.kind}`);
    }
  }

  threadTy(typeStr) {
    const base = typeStr.replace(/\?$/, '');
    const opt = typeStr.endsWith('?');
    const t = base === 'string' || base === 'int' ? 'str' : 'term';
    return opt ? (t === 'term' ? 'optterm' : 'optstr') : t;
  }

  compileItem(it, ctx, out, checked) {
    if (it.kind === 'sem') {
      for (const cl of it.clauses) compileClause(cl, ctx, out, '_v');
      return;
    }
    if (it.kind === 'thread') {
      const stmts = [];
      const init = compileExpr(it.init, ctx, stmts);
      out.push(...stmts);
      const ty = this.threadTy(it.type);
      let initRs = init.rs;
      if ((ty === 'optterm' || ty === 'optstr') && !(init.t === 'optterm' || init.t === 'optstr')) initRs = `Some(${initRs})`;
      out.push(`let mut ${it.name}: ${rustTy(ty)} = ${initRs};`);
      ctx.bindings.set(it.name, { rs: it.name, t: ty });
      const lbl = `'tl${this.labelCtr++}`;
      const lines = [];
      this.dispatchLoop(it.body, ctx, lines, lbl);
      if (it.rep === 'plus') {
        // at least one iteration: run dispatch once unconditionally first
        const once = [];
        this.dispatch(it.body, ctx, once, { assign: null, checked: false });
        out.push(...once);
      }
      out.push(`${lbl}: loop {`);
      out.push(...lines);
      out.push(`}`);
      return;
    }
    // factor
    const { binding, prim, postfix, sep } = it;
    if (postfix === null) { this.primOnce(prim, binding, ctx, checked, out); return; }
    const f = this.firstPrim(prim);
    const test = this.testFor(f.set);
    if (postfix === 'opt') {
      if (binding) {
        const t = prim.kind === 'call' ? this.calleeType(prim.name) : 'term';
        const optT = t === 'str' ? 'optstr' : 'optterm';
        out.push(`let mut ${binding}: ${rustTy(optT)} = None;`);
        ctx.bindings.set(binding, { rs: binding, t: optT });
        const inner = [];
        this.primOnce(prim, null, ctx.child(), true, inner, { target: binding, wrapSome: true });
        out.push(`if ${test} {`);
        out.push(...inner);
        out.push(`}`);
      } else {
        const inner = [];
        this.primOnce(prim, null, ctx.child(), true, inner);
        out.push(`if ${test} {`);
        out.push(...inner);
        out.push(`}`);
      }
      return;
    }
    if (postfix === 'star' || postfix === 'plus') {
      if (binding) throw new Error(`binding on ${postfix} repetition unsupported`);
      const inner = [];
      this.primOnce(prim, null, ctx.child(), true, inner);
      if (postfix === 'star') {
        out.push(`while ${test} {`);
        out.push(...inner);
        out.push(`}`);
      } else {
        out.push(`loop {`);
        out.push(...inner);
        out.push(`if !(${test}) { break; }`);
        out.push(`}`);
      }
      return;
    }
    if (postfix === 'sepList') {
      if (binding) throw new Error('binding on separated list unsupported');
      const sepK = this.litKind(sep);
      const inner = [];
      this.primOnce(prim, null, ctx.child(), false, inner);
      out.push(`loop {`);
      out.push(...inner);
      out.push(`if self.tk == ${sepK} { self.next_token()?; continue; }`);
      out.push(`break;`);
      out.push(`}`);
      return;
    }
    throw new Error(`postfix ${postfix}`);
  }

  compileAlt(alt, ctx, out, checked, assign) {
    const c = ctx.child();
    if (assign) {
      // value-producing group alternative: single factor
      const factors = alt.items.filter((i) => i.kind === 'factor');
      if (factors.length === 1 && alt.items.length === 1 && !factors[0].postfix) {
        this.primOnce(factors[0].prim, null, c, checked, out, assign);
        return;
      }
    }
    let first = checked;
    for (const it of alt.items) {
      this.compileItem(it, c, out, first);
      first = false; // only the very first token position is pre-checked
    }
  }

  altFirst(alt) { return this.firstItems(alt.items); }

  /** Dispatch over alternatives via match on self.tk. */
  dispatch(alts, ctx, out, { assign = null, checked = false } = {}) {
    if (alts.length === 1) {
      this.compileAlt(alts[0], ctx, out, checked, assign);
      return;
    }
    const infos = alts.map((a) => ({ alt: a, f: this.altFirst(a) }));
    // overlap check
    const seen = new Map();
    for (const { alt, f } of infos) {
      for (const k of f.set) {
        if (seen.has(k)) throw new Error(`LL(1) conflict on token ${k} between alternatives (production dispatch)`);
        seen.set(k, alt);
      }
    }
    const defaults = infos.filter((i) => i.f.nullable);
    if (defaults.length > 1) throw new Error('multiple nullable alternatives');
    const cases = [];
    for (const info of infos) {
      if (info.f.nullable && info.f.set.size === 0) continue;
      const labels = [...info.f.set].sort().join(' | ');
      const body = [];
      this.compileAlt(info.alt, ctx, body, true, assign);
      cases.push(`${labels} => {\n${body.join('\n')}\n}`);
    }
    let dflt;
    if (defaults.length === 1) {
      const body = [];
      this.compileAlt(defaults[0].alt, ctx, body, false, assign);
      dflt = body.join('\n');
    } else {
      const all = [...seen.keys()].sort();
      dflt = `return Err(self.perr_alt(&[${all.join(', ')}]));`;
    }
    out.push(`match self.tk {\n${cases.join('\n')}\n_ => {\n${dflt}\n}\n}`);
  }

  /** Star-loop dispatch (thread bodies): loop while a token matches an alt. */
  dispatchLoop(alts, ctx, out, label) {
    const infos = alts.map((a) => ({ alt: a, f: this.altFirst(a) }));
    const cases = [];
    for (const info of infos) {
      const labels = [...info.f.set].sort().join(' | ');
      const body = [];
      this.compileAlt(info.alt, ctx, body, true, null);
      cases.push(`${labels} => {\n${body.join('\n')}\n}`);
    }
    out.push(`match self.tk {\n${cases.join('\n')}\n_ => break ${label},\n}`);
  }

  /* ---------------- productions ---------------- */

  production(p) {
    const ctx = new Ctx(this.gen, p);
    const paramT = (t) => {
      const base = t.replace(/\?$/, '');
      if (base === 'string' || base === 'int') return 'str';
      return 'term';
    };
    for (const par of p.params) ctx.bindings.set(par.name, { rs: par.name, t: paramT(par.type) });
    const hasValue = this.semTypeHasValue(p.semType);
    const rec = this.recursive.has(p.name);
    const body = [];
    if (rec) {
      body.push(`self.depth += 1;`);
      body.push(`if self.depth > ${MAXDEPTH} { return Err(self.perr("MAXDEPTH")); }`);
    }
    if (hasValue) body.push(`let _v: ${this.retTy(p.semType)};`);
    this.dispatch(p.alts, ctx, body, {});
    if (rec) body.push(`self.depth -= 1;`);
    body.push(hasValue ? `Ok(_v)` : `Ok(())`);
    const params = p.params.map((q) => `${q.name}: ${rustTy(paramT(q.type))}`).join(', ');
    const comma = params.length > 0 ? ', ' : '';
    return `fn p_${p.name}(&mut self${comma}${params}) -> Result<${this.retTy(p.semType)}, PErr> {\n${body.join('\n')}\n}`;
  }

  generate() {
    const fns = this.g.prods.map((p) => this.production(p));
    return { code: fns.join('\n\n') };
  }
}
