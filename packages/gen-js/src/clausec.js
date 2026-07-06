/**
 * clausec.js — compiles the Shuttle clause language (spec/SHUTTLE.md §4.3,
 * shuttle.ebnf §8–9) to JavaScript statements, in parse-mode reading.
 *
 * The compiler is type-light: expression compilation carries a small tag
 * ('term' | 'str' | 'opt' | 'unknown') so that iri-typed strings are wrapped
 * into interned NamedNodes exactly at the points the grammar's semTypes
 * require a term.
 *
 * Primitive isos (spec §5) map to the runtime library:
 *   resolve       -> resolveIri (RFC 3986)     [str -> str]
 *   expandPName   -> prefix lookup + concat    [-> term]
 *   bind/lookup   -> Map set/get
 *   tt            -> triple-term (Quad) constructor
 *   literal       -> L / LL / LD constructors
 *   fresh()       -> per-derivation blank node counter
 *
 * `import core-terms` (grammar header) supplies the compile-time curie table
 * for constants like rdf:type, xsd:string.
 */

export const CORE_PREFIXES = {
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
};

/** Compile-time environment for one production body. */
export class Ctx {
  constructor(gen, prod) {
    this.gen = gen;           // shared generator state (constants pool, etc.)
    this.prod = prod;
    this.bindings = new Map(); // name -> { js, t } | { tuple: [{js},{js}] }
    this.tmp = 0;
  }
  freshTmp() { return `_t${this.tmp++}`; }
  child() {
    const c = new Ctx(this.gen, this.prod);
    c.bindings = new Map(this.bindings);
    c.tmp = this.tmp; // share temp counter to avoid collisions in one function
    return c;
  }
}

/** Intern a curie constant, returns the JS identifier of the NamedNode const. */
export function curieConst(gen, prefix, local) {
  const ns = CORE_PREFIXES[prefix];
  if (!ns) throw new Error(`unknown compile-time curie prefix '${prefix}:' (only core-terms rdf:/xsd: are importable)`);
  const iri = ns + local;
  return iriConst(gen, iri);
}

export function iriConst(gen, iri) {
  let id = gen.constPool.get(iri);
  if (!id) {
    id = `C${gen.constPool.size}`;
    gen.constPool.set(iri, id);
  }
  return id;
}

const ENV_JS = (name) => `env_${name}`;

/**
 * Compile an expression.
 * Returns { js, t } and may push prelude statements onto `stmts`
 * (used for block expressions and `??` with side-effecting defaults).
 */
export function compileExpr(e, ctx, stmts) {
  switch (e.k) {
    case 'name': {
      const b = ctx.bindings.get(e.name);
      if (!b) throw new Error(`unbound name '${e.name}' in ${ctx.prod ? ctx.prod.name : '?'}`);
      if (b.tuple) return { js: null, t: 'tuple', tuple: b.tuple };
      return b;
    }
    case 'env': return { js: ENV_JS(e.name), t: e.name === 'base' ? 'str' : 'unknown' };
    case 'fresh': return { js: 'BNF()', t: 'term' };
    case 'none': return { js: 'null', t: 'opt' };
    case 'some': return compileExpr(e.item, ctx, stmts);
    case 'str': return { js: JSON.stringify(e.value), t: 'str' };
    case 'int': return { js: String(e.value), t: 'str' };
    case 'iri': return { js: JSON.stringify(e.value), t: 'str' };
    case 'curie': return { js: curieConst(ctx.gen, e.prefix, e.local), t: 'term' };
    case 'tuple': {
      const parts = e.items.map((it) => compileExpr(it, ctx, stmts));
      return { js: null, t: 'tuple', tuple: parts };
    }
    case 'coal': {
      // A ?? B  — B may be a block expression with clauses (side effects):
      // hoist into statements.
      const a = compileExpr(e.l, ctx, stmts);
      const tmp = ctx.freshTmp();
      stmts.push(`let ${tmp} = ${a.js};`);
      const bStmts = [];
      const b = compileExpr(e.r, ctx, bStmts);
      if (bStmts.length > 0) {
        stmts.push(`if (${tmp} == null) { ${bStmts.join(' ')} ${tmp} = ${b.js}; }`);
      } else {
        stmts.push(`if (${tmp} == null) ${tmp} = ${b.js};`);
      }
      return { js: tmp, t: a.t === 'opt' ? b.t : a.t };
    }
    case 'cond': {
      const c = compileExpr(e.cond, ctx, stmts);
      const t = compileExpr(e.then, ctx, stmts);
      const f = compileExpr(e.els, ctx, stmts);
      return { js: `(${c.js} != null ? ${t.js} : ${f.js})`, t: t.t };
    }
    case 'cmp': {
      const l = compileExpr(e.l, ctx, stmts);
      const r = compileExpr(e.r, ctx, stmts);
      const op = e.op === '==' ? '===' : e.op === '!=' ? '!==' : e.op;
      return { js: `(${l.js} ${op} ${r.js})`, t: 'unknown' };
    }
    case 'block': {
      const inner = ctx.child();
      for (const cl of e.clauses) compileClause(cl, inner, stmts);
      const r = compileExpr(e.result, inner, stmts);
      ctx.tmp = inner.tmp;
      return r;
    }
    case 'case': {
      // Supported shape (RDFLiteral): tuple subject with option discriminant
      // in one component: (l, none) -> A | (l, some d) -> B
      const subj = compileExpr(e.subject, ctx, stmts);
      if (subj.t !== 'tuple') throw new Error('case: only tuple subjects supported in v0.1');
      if (e.arms.length !== 2) throw new Error('case: exactly two arms supported in v0.1');
      // find the discriminating component (pnone in one arm, psome in other)
      const [a0, a1] = e.arms;
      const comps = a0.pat.items;
      let disc = -1;
      for (let i = 0; i < comps.length; i++) {
        if (comps[i].k === 'pnone' || comps[i].k === 'psome') disc = i;
      }
      if (disc < 0) throw new Error('case: no option discriminant found');
      const noneArm = a0.pat.items[disc].k === 'pnone' ? a0 : a1;
      const someArm = noneArm === a0 ? a1 : a0;
      const bindArm = (arm, ctx2) => {
        arm.pat.items.forEach((p, i) => {
          if (p.k === 'pname') ctx2.bindings.set(p.name, subj.tuple[i]);
          if (p.k === 'psome' && p.item.k === 'pname') ctx2.bindings.set(p.item.name, subj.tuple[i]);
        });
      };
      const nCtx = ctx.child(); bindArm(noneArm, nCtx);
      const sCtx = ctx.child(); bindArm(someArm, sCtx);
      const nE = compileExpr(noneArm.body, nCtx, stmts);
      const sE = compileExpr(someArm.body, sCtx, stmts);
      ctx.tmp = Math.max(nCtx.tmp, sCtx.tmp);
      return { js: `(${subj.tuple[disc].js} == null ? ${nE.js} : ${sE.js})`, t: 'term' };
    }
    case 'call': return compileCall(e, ctx, stmts);
    default:
      throw new Error(`unsupported expression kind '${e.k}'`);
  }
}

function arg(e, ctx, stmts) { return compileExpr(e, ctx, stmts); }

function compileCall(e, ctx, stmts) {
  const { fn, args } = e;
  switch (fn) {
    case 'resolve': {
      const b = arg(args[0], ctx, stmts), r = arg(args[1], ctx, stmts);
      return { js: `resolveIri(${b.js}, ${r.js})`, t: 'str' };
    }
    case 'bind': {
      // bind(map, k, v) — used as `env.X := bind(env.X, k, v)`: handled in
      // compileClause(envSet); reaching here is a grammar we do not support.
      throw new Error('bind() only supported directly under env.X := …');
    }
    case 'lookup': {
      const m = arg(args[0], ctx, stmts), k = arg(args[1], ctx, stmts);
      return { js: `(${m.js}.get(${k.js}) ?? null)`, t: 'opt' };
    }
    case 'fst': {
      const a = arg(args[0], ctx, stmts);
      if (a.t !== 'tuple') throw new Error('fst() of non-tuple');
      return a.tuple[0];
    }
    case 'snd': {
      const a = arg(args[0], ctx, stmts);
      if (a.t !== 'tuple') throw new Error('snd() of non-tuple');
      return a.tuple[1];
    }
    case 'boundPrefix': {
      const m = arg(args[0], ctx, stmts), k = arg(args[1], ctx, stmts);
      return { js: `${m.js}.has(${k.js})`, t: 'unknown' };
    }
    case 'expandPName': {
      // span-hash interning: repeated pnames (predicates, class IRIs) hit a
      // two-level (prefix -> local -> term) cache of short strings instead of
      // hashing the full expanded IRI every time.
      const m = arg(args[0], ctx, stmts);
      const n = arg(args[1], ctx, stmts);
      if (n.t !== 'tuple') throw new Error('expandPName arg must be (prefix, local) tuple');
      return { js: `expandPN(${m.js}, ${n.tuple[0].js}, ${n.tuple[1].js})`, t: 'term' };
    }
    case 'tt': {
      const s = termArg(args[0], ctx, stmts);
      const p = termArg(args[1], ctx, stmts);
      const o = termArg(args[2], ctx, stmts);
      return { js: `new QuadT(${s.js}, ${p.js}, ${o.js})`, t: 'term' };
    }
    case 'literal': {
      const lex = arg(args[0], ctx, stmts);
      if (args.length === 2) {
        const dt = termArg(args[1], ctx, stmts);
        return { js: `new Literal(${lex.js}, '', null, ${dt.js})`, t: 'term' };
      }
      const kind = args[1];
      const lang = arg(args[2], ctx, stmts);
      if (args.length === 3) {
        // literal(lex, rdf:langString, lang)
        return { js: `new Literal(${lex.js}, ${lang.js}, null, DT_LANGSTRING)`, t: 'term' };
      }
      const dir = arg(args[3], ctx, stmts);
      void kind;
      return { js: `new Literal(${lex.js}, ${lang.js}, ${dir.js}, DT_DIRLANGSTRING)`, t: 'term' };
    }
    default:
      throw new Error(`unknown primitive iso '${fn}' in ${ctx.prod ? ctx.prod.name : '?'}`);
  }
}

/** Compile an expression and coerce iri-typed strings to interned terms. */
export function termArg(e, ctx, stmts) {
  const r = compileExpr(e, ctx, stmts);
  if (r.t === 'str') return { js: `NN(${r.js})`, t: 'term' };
  return r;
}

/**
 * Compile one clause to statements pushed onto `stmts`.
 * `valueVar` is the JS variable receiving `value = e` (or null for unit/graph).
 */
export function compileClause(cl, ctx, stmts, valueVar = '_v') {
  switch (cl.k) {
    case 'value': {
      let r = compileExpr(cl.expr, ctx, stmts);
      const semT = ctx.prod ? ctx.prod.semType : 'term';
      if ((semT === 'term' || semT === 'term!') && r.t === 'str') r = { js: `NN(${r.js})`, t: 'term' };
      if (r.t === 'tuple') throw new Error('tuple-valued productions not supported');
      stmts.push(`${valueVar} = ${r.js};`);
      return;
    }
    case 'emit': {
      const s = termArg(cl.s, ctx, stmts);
      const p = termArg(cl.p, ctx, stmts);
      const o = termArg(cl.o, ctx, stmts);
      if (cl.g || cl.when) throw new Error('emit @graph / when not supported by the turtle profile backend yet');
      stmts.push(`emitQ(${s.js}, ${p.js}, ${o.js});`);
      return;
    }
    case 'freshDecl': {
      stmts.push(`const ${cl.name} = BNF();`);
      ctx.bindings.set(cl.name, { js: cl.name, t: 'term' });
      return;
    }
    case 'let': {
      const r = compileExpr(cl.expr, ctx, stmts);
      if (r.t === 'tuple') { ctx.bindings.set(cl.name, { js: null, t: 'tuple', tuple: r.tuple }); return; }
      stmts.push(`let ${cl.name} = ${r.js};`);
      ctx.bindings.set(cl.name, { js: cl.name, t: r.t });
      return;
    }
    case 'envSet': {
      const target = ENV_JS(cl.name);
      const ex = cl.expr;
      if (ex.k === 'call' && ex.fn === 'bind') {
        // env.X := bind(env.X, k, v) — in-place map update (linearity holds:
        // the old map is dead after the clause).
        const k = compileExpr(ex.args[1], ctx, stmts);
        let v = compileExpr(ex.args[2], ctx, stmts);
        if (v.t === 'str' && cl.name !== 'prefixes') v = { js: `NN(${v.js})`, t: 'term' };
        if (cl.name === 'labels') {
          stmts.push(`bindLabel(${k.js}, ${v.js});`);
        } else if (cl.name === 'prefixes') {
          // rebinding a prefix invalidates the pname interning cache
          stmts.push(`${target}.set(${k.js}, ${v.js}); pnCache.delete(${k.js});`);
        } else {
          stmts.push(`${target}.set(${k.js}, ${v.js});`);
        }
        return;
      }
      const r = compileExpr(ex, ctx, stmts);
      stmts.push(`${target} = ${r.js};`);
      return;
    }
    case 'require': {
      const c = compileExpr(cl.cond, ctx, stmts);
      stmts.push(`if (!(${c.js})) perr(${JSON.stringify(cl.code)});`);
      return;
    }
    case 'assign': {
      // threaded-local update
      const r = compileExpr(cl.expr, ctx, stmts);
      stmts.push(`${cl.name} = ${r.js};`);
      return;
    }
    default:
      throw new Error(`unsupported clause kind '${cl.k}'`);
  }
}
