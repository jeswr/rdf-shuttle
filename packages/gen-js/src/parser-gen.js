/**
 * parser-gen.js — compiles Shuttle productions to a recursive-descent
 * LL(1)-on-token-kinds parser (spec/SHUTTLE.md §6).
 *
 * - FIRST/nullable computed over token kinds; alternative overlap is a
 *   generator error with the conflicting tokens named (§4.4).
 * - Semantic blocks compile via clausec.js; emits fire exactly where the
 *   grammar places them (earliest emission — the streaming discipline).
 * - `thread v : T = e in ( … )*` compiles to a plain loop variable
 *   (threaded-local linearity, §3).
 * - Recursive productions carry an explicit depth guard (`@maxdepth`
 *   default 8192) so adversarial nesting fails cleanly instead of
 *   overflowing the host stack.
 */

import { compileClause, compileExpr, Ctx } from './clausec.js';

const MAXDEPTH = 8192;

export class ParserGen {
  constructor(g, an, lex, gen) {
    this.g = g;
    this.an = an;
    this.lex = lex;
    this.gen = gen; // shared: constPool, tables
    this.firstK = new Map();
    this.nullableP = new Map();
    this.tables = new Map(); // setKey -> table const name
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
      // DFS: is p reachable from p?
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
    if (kinds.length <= 3) return kinds.map((k) => `tk === ${k}`).join(' || ');
    const key = kinds.join(',');
    let nm = this.tables.get(key);
    if (!nm) {
      nm = `FS_${this.tables.size}`;
      this.tables.set(key, nm);
      this.tableDefs.push(`const ${nm} = mkFS([${kinds.join(', ')}]);`);
    }
    return `${nm}[tk] !== 0`;
  }

  /* ---------------- item compilation ---------------- */

  semTypeHasValue(semType) { return semType !== 'unit' && semType !== 'graph'; }

  calleeType(name) {
    const p = this.g.prodByName.get(name);
    if (!p) throw new Error(`unknown production '${name}'`);
    const st = p.semType;
    if (st === 'term' || st === 'term!') return 'term';
    if (st === 'pair') return 'pair';
    if (st === 'unit' || st === 'graph') return null;
    return 'str';
  }

  /** Runtime tuple binding for a pair-valued variable (a JS 2-array). */
  pairBinding(name) {
    return {
      js: name,
      t: 'tuple',
      tuple: [{ js: `${name}[0]`, t: 'term' }, { js: `${name}[1]`, t: 'term' }],
    };
  }

  callCode(prim, ctx) {
    const args = (prim.args || []).map((a) => {
      const stmts = [];
      const r = compileExpr(a, ctx, stmts);
      if (stmts.length > 0) throw new Error('side-effecting call arguments unsupported');
      if (r.t === 'tuple') {
        // pair argument: pass the runtime 2-array (or rebuild it from parts,
        // e.g. a PNAME_LN token's split spans).
        return r.js !== null ? r.js : `[${r.tuple.map((x) => x.js).join(', ')}]`;
      }
      return r.js;
    });
    return `p_${prim.name}(${args.join(', ')})`;
  }

  /** Consume a token/lit prim; returns code lines. */
  consumeToken(kind, checked, out) {
    if (!checked) out.push(`if (tk !== ${kind}) perrExp(${kind});`);
    out.push(`next();`);
  }

  bindToken(prim, binding, ctx, checked, out) {
    const kind = this.tokKind(prim.name);
    if (!checked) out.push(`if (tk !== ${kind}) perrExp(${kind});`);
    if (binding) {
      const snip = this.lex.valueSnippets.get(prim.name);
      if (snip === undefined) throw new Error(`token ${prim.name} has no value but is bound`);
      if (Array.isArray(snip)) {
        snip.forEach((s, i) => out.push(`const ${binding}_${i} = ${s};`));
        ctx.bindings.set(binding, {
          js: null, t: 'tuple',
          tuple: snip.map((_, i) => ({ js: `${binding}_${i}`, t: i === 0 ? 'str' : 'opt' })),
        });
      } else {
        out.push(`const ${binding} = ${snip};`);
        ctx.bindings.set(binding, { js: binding, t: 'str' });
      }
    }
    out.push(`next();`);
  }

  /** Compile a primary occurrence (no postfix), optionally assigning `into`. */
  primOnce(prim, binding, ctx, checked, out, into = null) {
    switch (prim.kind) {
      case 'token': {
        if (into) {
          const snip = this.lex.valueSnippets.get(prim.name);
          const kind = this.tokKind(prim.name);
          if (!checked) out.push(`if (tk !== ${kind}) perrExp(${kind});`);
          out.push(`${into} = ${snip};`);
          out.push(`next();`);
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
        if (into) out.push(`${into} = ${call};`);
        else if (binding) {
          out.push(`const ${binding} = ${call};`);
          ctx.bindings.set(binding, t === 'pair' ? this.pairBinding(binding) : { js: binding, t: t || 'unknown' });
        } else out.push(`${call};`);
        return;
      }
      case 'group': {
        if (binding && !into) {
          out.push(`let ${binding};`);
          ctx.bindings.set(binding, { js: binding, t: 'term' });
          this.dispatch(prim.alts, ctx, out, { assign: binding, checked });
        } else {
          this.dispatch(prim.alts, ctx, out, { assign: into, checked });
        }
        return;
      }
      default: throw new Error(`primOnce ${prim.kind}`);
    }
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
      out.push(`let ${it.name} = ${init.js};`);
      ctx.bindings.set(it.name, { js: it.name, t: init.t });
      const lbl = `tl${this.labelCtr++}`;
      const lines = [];
      this.dispatchLoop(it.body, ctx, lines, lbl);
      if (it.rep === 'plus') {
        // at least one iteration: run dispatch once unconditionally first
        const once = [];
        this.dispatch(it.body, ctx, once, { assign: null, checked: false });
        out.push(...once);
      }
      out.push(`${lbl}: for (;;) {`);
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
        out.push(`let ${binding} = null;`);
        ctx.bindings.set(binding, { js: binding, t: 'opt' });
        const inner = [];
        this.primOnce(prim, null, ctx.child(), true, inner, binding);
        out.push(`if (${test}) {`);
        out.push(...inner);
        out.push(`}`);
      } else {
        const inner = [];
        this.primOnce(prim, null, ctx.child(), true, inner);
        out.push(`if (${test}) {`);
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
        out.push(`while (${test}) {`);
        out.push(...inner);
        out.push(`}`);
      } else {
        out.push(`for (;;) {`);
        out.push(...inner);
        out.push(`if (!(${test})) break;`);
        out.push(`}`);
      }
      return;
    }
    if (postfix === 'sepList') {
      if (binding) throw new Error('binding on separated list unsupported');
      const sepK = this.litKind(sep);
      const inner = [];
      this.primOnce(prim, null, ctx.child(), false, inner);
      out.push(`for (;;) {`);
      out.push(...inner);
      out.push(`if (tk === ${sepK}) { next(); continue; }`);
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

  /** Dispatch over alternatives via switch(tk). */
  dispatch(alts, ctx, out, { assign = null, checked = false } = {}) {
    if (alts.length === 0) {
      // all alternatives excluded by the active profile: the production is
      // dead. Reachable only through opt/star references (whose FIRST-set
      // guards are statically false); a required reference is a generator
      // error at the reference site.
      out.push(`perr('PROFILE_EXCLUDED');`);
      return;
    }
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
      const labels = [...info.f.set].sort().map((k) => `case ${k}:`).join(' ');
      const body = [];
      this.compileAlt(info.alt, ctx, body, true, assign);
      cases.push(`${labels} {\n${body.join('\n')}\nbreak;\n}`);
    }
    let dflt;
    if (defaults.length === 1) {
      const body = [];
      this.compileAlt(defaults[0].alt, ctx, body, false, assign);
      dflt = body.join('\n');
    } else {
      const all = [...seen.keys()].sort();
      dflt = `perrAlt([${all.join(', ')}]);`;
    }
    out.push(`switch (tk) {\n${cases.join('\n')}\ndefault: {\n${dflt}\n}\n}`);
  }

  /** Star-loop dispatch (thread bodies): loop while a token matches an alt. */
  dispatchLoop(alts, ctx, out, label) {
    const infos = alts.map((a) => ({ alt: a, f: this.altFirst(a) }));
    const cases = [];
    for (const info of infos) {
      const labels = [...info.f.set].sort().map((k) => `case ${k}:`).join(' ');
      const body = [];
      this.compileAlt(info.alt, ctx, body, true, null);
      cases.push(`${labels} {\n${body.join('\n')}\nbreak;\n}`);
    }
    out.push(`switch (tk) {\n${cases.join('\n')}\ndefault: break ${label};\n}`);
  }

  /* ---------------- productions ---------------- */

  production(p) {
    const ctx = new Ctx(this.gen, p);
    const paramT = (t) => {
      const base = t.replace(/\?$/, '');
      if (base === 'string' || base === 'int') return 'str';
      return 'term';
    };
    for (const par of p.params) {
      const base = par.type.replace(/\?$/, '');
      ctx.bindings.set(par.name, base === 'pair' ? this.pairBinding(par.name) : { js: par.name, t: paramT(par.type) });
    }
    const hasValue = this.semTypeHasValue(p.semType);
    const rec = this.recursive.has(p.name);
    const body = [];
    if (rec) body.push(`if (++depth > ${p.maxdepth ?? MAXDEPTH}) perr('MAXDEPTH');`);
    if (hasValue) body.push(`let _v;`);
    this.dispatch(p.alts, ctx, body, {});
    if (rec) body.push(`depth--;`);
    if (hasValue) body.push(`return _v;`);
    const params = p.params.map((q) => q.name).join(', ');
    return `function p_${p.name}(${params}) {\n${body.join('\n')}\n}`;
  }

  generate() {
    const fns = this.g.prods.map((p) => this.production(p));
    return {
      code: `${this.tableDefs.join('\n')}\n\n${fns.join('\n\n')}`,
    };
  }
}
