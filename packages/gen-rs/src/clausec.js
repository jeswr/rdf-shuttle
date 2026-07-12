/**
 * clausec.js — compiles the Shuttle clause language (spec/SHUTTLE.md §4.3,
 * shuttle.ebnf §8–9) to Rust statements, in parse-mode reading.
 *
 * Typing: unlike the JS backend's type-light tags, the Rust backend carries a
 * concrete type per expression so ownership/borrows come out right:
 *   'term'    -> Term            (Rc-backed, cheap Clone)
 *   'str'     -> Rc<str>         (cheap Clone; token values intern-friendly)
 *   'optterm' -> Option<Term>
 *   'optstr'  -> Option<Rc<str>>
 *   'bool'    -> bool
 *   tuple     -> component-wise (never a first-class runtime value)
 *
 * Clone policy: every use of a bound name emits `.clone()` — all value types
 * are reference-counted, so a clone is a refcount bump, and the generated
 * code never fights the borrow checker. Helpers that need machine state are
 * free functions taking disjoint `&mut self.field` arguments so one call can
 * split-borrow the machine.
 */

export const CORE_PREFIXES = {
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
};

/** Additional compile-time curie tables, keyed by `import` header name. */
export const IMPORT_PREFIXES = {
  'core-terms': CORE_PREFIXES,
  'shacl-terms': {
    sh: 'http://www.w3.org/ns/shacl#',
    owl: 'http://www.w3.org/2002/07/owl#',
    rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  },
};

/** Resolve the compile-time curie table for a grammar's import list. */
export function curieTable(imports) {
  const table = { ...CORE_PREFIXES }; // rdf:/xsd: always available (v0.1 compat)
  for (const im of imports || []) {
    const t = IMPORT_PREFIXES[im];
    if (!t) throw new Error(`unknown import '${im}' (known: ${Object.keys(IMPORT_PREFIXES).join(', ')})`);
    Object.assign(table, t);
  }
  return table;
}

/** Expand a curie/iri expression node to a full IRI string (compile time). */
export function curieIriOf(gen, e) {
  if (e.k === 'iri') return e.value;
  if (e.k === 'curie') {
    const ns = (gen.curies || CORE_PREFIXES)[e.prefix];
    if (!ns) throw new Error(`unknown compile-time curie prefix '${e.prefix}:'`);
    return ns + e.local;
  }
  throw new Error(`expected curie or IRI, got '${e.k}'`);
}

/** Compile-time environment for one production body. */
export class Ctx {
  constructor(gen, prod) {
    this.gen = gen;           // shared generator state (constants pool, env types)
    this.prod = prod;
    this.bindings = new Map(); // name -> { rs, t } | { t:'tuple', tuple: [{rs,t}] }
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

/** Intern a curie constant, returns the Rust expression for the Term. */
export function curieConst(gen, prefix, local) {
  const ns = (gen.curies || CORE_PREFIXES)[prefix];
  if (!ns) throw new Error(`unknown compile-time curie prefix '${prefix}:' (importable tables: ${Object.keys(IMPORT_PREFIXES).join(', ')})`);
  return iriConst(gen, ns + local);
}

export function iriConst(gen, iri) {
  let id = gen.constPool.get(iri);
  if (!id) {
    id = `kc${gen.constPool.size}`;
    gen.constPool.set(iri, id);
  }
  return `self.${id}.clone()`;
}

const ENV_RS = (name) => `self.env_${name}`;

const isOpt = (t) => t === 'optterm' || t === 'optstr';
const optOf = (t) => (t === 'term' ? 'optterm' : t === 'str' ? 'optstr' : t === 'optterm' || t === 'optstr' ? t : 'optterm');
const unOpt = (t) => (t === 'optterm' ? 'term' : t === 'optstr' ? 'str' : t);
export const rustTy = (t) => ({ term: 'Term', str: 'Rc<str>', optterm: 'Option<Term>', optstr: 'Option<Rc<str>>', bool: 'bool', unit: '()' }[t]);

/**
 * Compile an expression. Returns { rs, t } (and may push prelude statements
 * onto `stmts`). `rs` is an owned-value Rust expression.
 */
export function compileExpr(e, ctx, stmts) {
  switch (e.k) {
    case 'name': {
      const b = ctx.bindings.get(e.name);
      if (!b) throw new Error(`unbound name '${e.name}' in ${ctx.prod ? ctx.prod.name : '?'}`);
      if (b.t === 'tuple') return b;
      return { rs: `${b.rs}.clone()`, t: b.t, ref: b.rs };
    }
    case 'env': {
      const et = ctx.gen.envTypes.get(e.name);
      if (!et) throw new Error(`unknown env.${e.name}`);
      if (et === 'iri-string') return { rs: `Rc::from(${ENV_RS(e.name)}.as_str())`, t: 'str' };
      if (et === 'map' || et === 'labelmap') throw new Error(`env.${e.name}: maps are not first-class values (use lookup/bind/boundPrefix/expandPName)`);
      return { rs: `${ENV_RS(e.name)}.clone()`, t: et, ref: ENV_RS(e.name) };
    }
    case 'fresh': return { rs: 'self.fresh_bn()', t: 'term' };
    case 'none': return { rs: 'None', t: 'optterm' };
    case 'some': {
      const inner = compileExpr(e.item, ctx, stmts);
      return { rs: `Some(${inner.rs})`, t: optOf(inner.t) };
    }
    case 'str': return { rs: `Rc::from(${JSON.stringify(e.value)})`, t: 'str', litStr: e.value };
    case 'int': return { rs: `Rc::from(${JSON.stringify(String(e.value))})`, t: 'str', litStr: String(e.value) };
    case 'iri': return { rs: `Rc::from(${JSON.stringify(e.value)})`, t: 'str', litStr: e.value };
    case 'curie': return { rs: curieConst(ctx.gen, e.prefix, e.local), t: 'term' };
    case 'tuple': {
      const parts = e.items.map((it) => compileExpr(it, ctx, stmts));
      return { t: 'tuple', tuple: parts };
    }
    case 'coal': {
      // A ?? B — B may be a block expression with clauses (side effects).
      const a = compileExpr(e.l, ctx, stmts);
      if (!isOpt(a.t)) throw new Error('?? on non-option left operand');
      const bStmts = [];
      const b = compileExpr(e.r, ctx, bStmts);
      const tmp = ctx.freshTmp();
      const t = unOpt(a.t) === 'term' || b.t === 'term' ? 'term' : unOpt(a.t);
      const noneBody = bStmts.length > 0 ? `{\n${bStmts.join('\n')}\n${b.rs}\n}` : b.rs;
      stmts.push(`let ${tmp}: ${rustTy(t)} = match ${a.rs} { Some(_x) => _x, None => ${noneBody} };`);
      return { rs: `${tmp}.clone()`, t, ref: tmp };
    }
    case 'block': {
      const inner = ctx.child();
      for (const cl of e.clauses) compileClause(cl, inner, stmts);
      const r = compileExpr(e.result, inner, stmts);
      ctx.tmp = inner.tmp;
      return r;
    }
    case 'case': {
      // Supported shape (RDFLiteral): tuple subject with an option
      // discriminant in one component: (l, none) -> A | (l, some d) -> B.
      const subj = compileExpr(e.subject, ctx, stmts);
      if (subj.t !== 'tuple') throw new Error('case: only tuple subjects supported in v0.1');
      if (e.arms.length !== 2) throw new Error('case: exactly two arms supported in v0.1');
      const [a0, a1] = e.arms;
      const comps = a0.pat.items;
      let disc = -1;
      for (let i = 0; i < comps.length; i++) {
        if (comps[i].k === 'pnone' || comps[i].k === 'psome') disc = i;
      }
      if (disc < 0) throw new Error('case: no option discriminant found');
      const noneArm = a0.pat.items[disc].k === 'pnone' ? a0 : a1;
      const someArm = noneArm === a0 ? a1 : a0;
      const discPart = subj.tuple[disc];
      const bindArm = (arm, ctx2, someVar) => {
        arm.pat.items.forEach((p, i) => {
          if (p.k === 'pname') ctx2.bindings.set(p.name, { rs: subj.tuple[i].ref || subj.tuple[i].rs.replace(/\.clone\(\)$/, ''), t: subj.tuple[i].t });
          if (p.k === 'psome' && p.item.k === 'pname') ctx2.bindings.set(p.item.name, { rs: someVar, t: unOpt(subj.tuple[i].t) });
        });
      };
      const nCtx = ctx.child(); bindArm(noneArm, nCtx, null);
      const sCtx = ctx.child(); bindArm(someArm, sCtx, '_cd');
      const nStmts = [];
      const nE = compileExpr(noneArm.body, nCtx, nStmts);
      const sStmts = [];
      const sE = compileExpr(someArm.body, sCtx, sStmts);
      ctx.tmp = Math.max(nCtx.tmp, sCtx.tmp);
      const nBody = nStmts.length ? `{\n${nStmts.join('\n')}\n${nE.rs}\n}` : nE.rs;
      const sBody = sStmts.length ? `{\n${sStmts.join('\n')}\n${sE.rs}\n}` : sE.rs;
      return {
        rs: `match ${discPart.rs} { None => ${nBody}, Some(_cd) => ${sBody} }`,
        t: nE.t,
      };
    }
    case 'call': return compileCall(e, ctx, stmts);
    case 'num': return { rs: `${e.value}i128`, t: 'num' };
    case 'cmp': {
      // Comparison forms the SHACL-CS clauses need: option-vs-none tests
      // (`x == none` / `x != none`) and numeric bounds (`int(s) > 0`).
      const noneSide = e.l.k === 'none' ? 'l' : e.r.k === 'none' ? 'r' : null;
      if (noneSide) {
        if (e.op !== '==' && e.op !== '!=') throw new Error(`'${e.op}' comparison against none`);
        const other = compileExpr(noneSide === 'l' ? e.r : e.l, ctx, stmts);
        if (!isOpt(other.t)) throw new Error('none-comparison on non-option operand');
        let place = other.ref;
        if (!place) {
          const tmp = ctx.freshTmp();
          stmts.push(`let ${tmp}: ${rustTy(other.t)} = ${other.rs};`);
          place = tmp;
        }
        return { rs: `${place}.${e.op === '==' ? 'is_none' : 'is_some'}()`, t: 'bool' };
      }
      let l = compileExpr(e.l, ctx, stmts);
      let r = compileExpr(e.r, ctx, stmts);
      // an integer literal ('int' expr) compiles as a verbatim str; coerce
      // it numeric when compared against a num (int(s) > 0).
      const asNum = (x) => (x.t === 'str' && x.litStr !== undefined && /^-?\d+$/.test(x.litStr) ? { rs: `${x.litStr}i128`, t: 'num' } : x);
      if (l.t === 'num') r = asNum(r);
      if (r.t === 'num') l = asNum(l);
      if (l.t === 'num' && r.t === 'num') return { rs: `(${l.rs}) ${e.op} (${r.rs})`, t: 'bool' };
      if (l.t === 'str' && r.t === 'str') {
        const ls = l.litStr !== undefined ? JSON.stringify(l.litStr) : l.ref ? `${l.ref}.as_ref()` : `(${l.rs}).as_ref()`;
        const rs2 = r.litStr !== undefined ? JSON.stringify(r.litStr) : r.ref ? `${r.ref}.as_ref()` : `(${r.rs}).as_ref()`;
        if (e.op !== '==' && e.op !== '!=') throw new Error(`'${e.op}' comparison on strings`);
        return { rs: `${ls} ${e.op} ${rs2}`, t: 'bool' };
      }
      throw new Error(`unsupported comparison operand types ${l.t} ${e.op} ${r.t}`);
    }
    default:
      throw new Error(`unsupported expression kind '${e.k}'`);
  }
}

/** A `&str` borrow of a str-typed expression (skips the defensive clone). */
function strRef(e, ctx, stmts) {
  const r = compileExpr(e, ctx, stmts);
  if (r.t !== 'str') throw new Error(`expected str-typed expression, got ${r.t}`);
  if (r.litStr !== undefined) return JSON.stringify(r.litStr);
  if (r.ref) return `${r.ref}.as_ref()`;
  const tmp = ctx.freshTmp();
  stmts.push(`let ${tmp}: Rc<str> = ${r.rs};`);
  return `${tmp}.as_ref()`;
}

function arg(e, ctx, stmts) { return compileExpr(e, ctx, stmts); }

function compileCall(e, ctx, stmts) {
  const { fn, args } = e;
  switch (fn) {
    case 'resolve': {
      // resolve(env.base, rel) — the RFC 3986 iso; returns a str (Cow
      // internally, materialized to Rc<str> here; termArg avoids the
      // materialization by feeding the Cow straight into the interner).
      if (args[0].k !== 'env') throw new Error('resolve() base must be env.<name>');
      const rel = strRef(args[1], ctx, stmts);
      return {
        rs: `rc_from_cow(resolve_iri(&${ENV_RS(args[0].name)}, ${rel}))`,
        t: 'str',
        resolveParts: { base: ENV_RS(args[0].name), rel },
      };
    }
    case 'bind':
      throw new Error('bind() only supported directly under env.X := …');
    case 'lookup': {
      if (args[0].k !== 'env') throw new Error('lookup() map must be env.<name>');
      const k = strRef(args[1], ctx, stmts);
      return { rs: `${ENV_RS(args[0].name)}.get(${k}).cloned()`, t: 'optterm' };
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
      if (args[0].k !== 'env') throw new Error('boundPrefix() map must be env.<name>');
      const k = tupleHeadRef(args[1], ctx, stmts);
      return { rs: `${ENV_RS(args[0].name)}.contains_key(${k})`, t: 'bool' };
    }
    case 'int': {
      // int(s) — numeric reading of a verbatim lexical form (count bounds).
      // The token is digits-only; on the (absurd) >i128 overflow, saturate
      // positive — matching the JS backend's parseInt -> Infinity reading.
      const a = strRef(args[0], ctx, stmts);
      return { rs: `${a}.parse::<i128>().unwrap_or(i128::MAX)`, t: 'num' };
    }
    case 'expandPName': {
      // span-hash interning: repeated pnames hit a two-level
      // (prefix -> local -> term) cache of short strings instead of hashing
      // the full expanded IRI every time.
      if (args[0].k !== 'env') throw new Error('expandPName() map must be env.<name>');
      const n = arg(args[1], ctx, stmts);
      if (n.t !== 'tuple') throw new Error('expandPName arg must be (prefix, local) tuple');
      const p = partRef(n.tuple[0]);
      const l = partRef(n.tuple[1]);
      return {
        rs: `expand_pn(&${ENV_RS(args[0].name)}, ${p}, ${l})`,
        t: 'term',
      };
    }
    case 'tt': {
      const s = termArg(args[0], ctx, stmts);
      const p = termArg(args[1], ctx, stmts);
      const o = termArg(args[2], ctx, stmts);
      return { rs: `Term::Triple(Rc::new(Triple { subject: ${s.rs}, predicate: ${p.rs}, object: ${o.rs} }))`, t: 'term' };
    }
    case 'literal': {
      const lex = arg(args[0], ctx, stmts);
      if (lex.t !== 'str') throw new Error('literal() lexical form must be str');
      if (args.length === 2) {
        const dt = termArg(args[1], ctx, stmts);
        return { rs: `Term::Literal(Rc::new(LiteralData { value: ${lex.rs}, language: self.rc_empty.clone(), direction: None, datatype: ${dt.rs} }))`, t: 'term' };
      }
      const kind = args[1];
      if (kind.k !== 'curie') throw new Error('literal() language-string kind must be a curie constant');
      const dt = curieConst(ctx.gen, kind.prefix, kind.local);
      const lang = arg(args[2], ctx, stmts);
      if (args.length === 3) {
        return { rs: `Term::Literal(Rc::new(LiteralData { value: ${lex.rs}, language: ${lang.rs}, direction: None, datatype: ${dt} }))`, t: 'term' };
      }
      const dir = arg(args[3], ctx, stmts);
      return { rs: `Term::Literal(Rc::new(LiteralData { value: ${lex.rs}, language: ${lang.rs}, direction: Some(${dir.rs}), datatype: ${dt} }))`, t: 'term' };
    }
    default:
      throw new Error(`unknown primitive iso '${fn}' in ${ctx.prod ? ctx.prod.name : '?'}`);
  }
}

/** `&str` ref for a tuple's head (or a plain str expression). */
function tupleHeadRef(e, ctx, stmts) {
  if (e.k === 'call' && e.fn === 'fst') {
    const a = compileExpr(e.args[0], ctx, stmts);
    if (a.t !== 'tuple') throw new Error('fst() of non-tuple');
    return partRef(a.tuple[0]);
  }
  return strRef(e, ctx, stmts);
}

function partRef(part) {
  if (part.t !== 'str') throw new Error(`expected str tuple part, got ${part.t}`);
  if (part.litStr !== undefined) return JSON.stringify(part.litStr);
  if (part.ref) return `${part.ref}.as_ref()`;
  return `(${part.rs}).as_ref()`;
}

/** Compile an expression and coerce iri-typed strings to interned terms. */
export function termArg(e, ctx, stmts) {
  const r = compileExpr(e, ctx, stmts);
  if (r.t === 'str') {
    // A Cow-producing resolve feeds term construction without materializing
    // an Rc first.
    if (r.resolveParts) {
      return { rs: `nn(resolve_iri(&${r.resolveParts.base}, ${r.resolveParts.rel}))`, t: 'term' };
    }
    if (r.ref) return { rs: `Term::NamedNode(${r.ref}.clone())`, t: 'term' };
    return { rs: `Term::NamedNode(${r.rs})`, t: 'term' };
  }
  if (r.t !== 'term') throw new Error(`term argument has type ${r.t}`);
  return r;
}

/**
 * Compile one clause to statements pushed onto `stmts`.
 * `valueVar` receives `value = e` (null for unit/graph productions).
 */
export function compileClause(cl, ctx, stmts, valueVar = '_v') {
  switch (cl.k) {
    case 'value': {
      const optV = !!(ctx.gen.optValued && ctx.prod && ctx.gen.optValued.has(ctx.prod.name));
      if (optV && cl.expr.k === 'none') { stmts.push(`${valueVar} = None;`); return; }
      let r = compileExpr(cl.expr, ctx, stmts);
      const semT = ctx.prod ? ctx.prod.semType : 'term';
      if ((semT === 'term' || semT === 'term!') && r.t === 'str') r = termArg(cl.expr, ctx, stmts);
      if (optV) {
        // option-valued production: wrap non-none values in Some (the
        // return type is Option<T>; see ParserGen.findOptValued).
        if (r.t === 'tuple') throw new Error('opt-valued pair production unsupported');
        if (isOpt(r.t)) stmts.push(`${valueVar} = ${r.rs};`);
        else stmts.push(`${valueVar} = Some(${r.rs});`);
        return;
      }
      if (r.t === 'tuple') {
        // pair-valued production (`value = (p, o)`, shuttle.ebnf §9): the
        // runtime representation is a (Term, Term) tuple, destructured by
        // fst/snd at the caller. Needed wherever an emission's placement is
        // decided one nonterminal late (SHACL-C's '<atom> ("|" <atom>)*').
        if (semT !== 'pair') throw new Error(`tuple value in non-pair production '${ctx.prod ? ctx.prod.name : '?'}'`);
        if (r.rs) { stmts.push(`${valueVar} = ${r.rs};`); return; }
        const parts = r.tuple.map((x) => {
          if (x.t === 'term') return x.rs;
          if (x.t === 'str') return x.ref ? `Term::NamedNode(${x.ref}.clone())` : `Term::NamedNode(${x.rs})`;
          throw new Error(`unsupported pair component type ${x.t}`);
        });
        if (parts.length !== 2) throw new Error('pair value must have exactly two components');
        stmts.push(`${valueVar} = (${parts.join(', ')});`);
        return;
      }
      stmts.push(`${valueVar} = ${r.rs};`);
      return;
    }
    case 'emit': {
      if (cl.g) throw new Error('emit @graph not supported by the triples-emitting backend yet');
      if (cl.when) {
        // conditional emission (shuttle.ebnf §8 form 2): arguments are
        // evaluated only when the guard holds (they may be absent
        // otherwise, e.g. sh:maxCount for '*'). An `x != none` guard
        // if-let-narrows the option binding for the body, so option-typed
        // arguments type-check without unwraps.
        const w = cl.when;
        const inner = [];
        let ictx = ctx;
        let head = null;
        const noneSide = w.k === 'cmp' && w.op === '!=' ? (w.l.k === 'none' ? 'l' : w.r.k === 'none' ? 'r' : null) : null;
        const otherE = noneSide === 'l' ? w.r : noneSide === 'r' ? w.l : null;
        if (noneSide && otherE.k === 'name') {
          const b = ctx.bindings.get(otherE.name);
          if (!b || !isOpt(b.t)) throw new Error(`'${otherE.name} != none' guard on non-option binding`);
          ictx = ctx.child();
          ictx.bindings.set(otherE.name, { rs: '_w.clone()', ref: '_w', t: unOpt(b.t) });
          head = `if let Some(_w) = &${b.rs} {`;
        } else {
          const c = compileExpr(w, ctx, stmts);
          if (c.t !== 'bool') throw new Error('emit-when guard must be bool');
          head = `if ${c.rs} {`;
        }
        const s = termArg(cl.s, ictx, inner);
        const p = termArg(cl.p, ictx, inner);
        const o = termArg(cl.o, ictx, inner);
        inner.push(`self.emit_q(${s.rs}, ${p.rs}, ${o.rs});`);
        ctx.tmp = Math.max(ctx.tmp, ictx.tmp);
        stmts.push(`${head}\n${inner.join('\n')}\n}`);
        return;
      }
      const s = termArg(cl.s, ctx, stmts);
      const p = termArg(cl.p, ctx, stmts);
      const o = termArg(cl.o, ctx, stmts);
      stmts.push(`self.emit_q(${s.rs}, ${p.rs}, ${o.rs});`);
      return;
    }
    case 'oracle': {
      // `oracle NAME(args) -> clause ; otherwise -> clause` (§8 form 7).
      // Parse-mode reading: branch on the declared decidable predicate.
      // (Print-mode reading — the consumed quad's predicate discharges the
      // oracle — belongs to the residual serializer.)
      const decl = (ctx.gen.oracles || new Map()).get(cl.name);
      if (!decl) throw new Error(`oracle '${cl.name}' not declared (@oracle ${cl.name}(…) = …)`);
      const args = cl.args.map((a) => termArg(a, ctx, stmts));
      const cond = `or_${cl.name}(${args.map((a) => (a.ref ? `&${a.ref}` : `&(${a.rs})`)).join(', ')})`;
      const thenCtx = ctx.child();
      const thenStmts = [];
      compileClause(cl.then, thenCtx, thenStmts, valueVar);
      if (cl.els) {
        const elsCtx = ctx.child();
        const elsStmts = [];
        compileClause(cl.els, elsCtx, elsStmts, valueVar);
        ctx.tmp = Math.max(thenCtx.tmp, elsCtx.tmp);
        stmts.push(`if ${cond} {\n${thenStmts.join('\n')}\n} else {\n${elsStmts.join('\n')}\n}`);
      } else {
        ctx.tmp = thenCtx.tmp;
        stmts.push(`if ${cond} {\n${thenStmts.join('\n')}\n}`);
      }
      return;
    }
    case 'freshDecl': {
      stmts.push(`let ${cl.name} = self.fresh_bn();`);
      ctx.bindings.set(cl.name, { rs: cl.name, t: 'term' });
      return;
    }
    case 'let': {
      const r = compileExpr(cl.expr, ctx, stmts);
      if (r.t === 'tuple') { ctx.bindings.set(cl.name, { t: 'tuple', tuple: r.tuple }); return; }
      stmts.push(`let ${cl.name}: ${rustTy(r.t)} = ${r.rs};`);
      ctx.bindings.set(cl.name, { rs: cl.name, t: r.t });
      return;
    }
    case 'envSet': {
      const target = ENV_RS(cl.name);
      const envT = ctx.gen.envTypes.get(cl.name);
      const ex = cl.expr;
      if (ex.k === 'call' && ex.fn === 'bind') {
        // env.X := bind(env.X, k, v) — in-place map update (linearity holds:
        // the old map is dead after the clause).
        const k = strRef(ex.args[1], ctx, stmts);
        if (cl.name === 'labels' || envT === 'labelmap') {
          const v = compileExpr(ex.args[2], ctx, stmts);
          // push-mode statement rollback support: record first-bind keys
          stmts.push(`if self.push_mode && !${target}.contains_key(${k}) { self.trail.push(${k}.to_string()); }`);
          stmts.push(`${target}.insert(${k}.to_string(), ${v.rs});`);
        } else {
          // iri-valued map (prefixes)
          const v = ex.args[2].k === 'call' && ex.args[2].fn === 'resolve'
            ? compileExpr(ex.args[2], ctx, stmts)
            : (() => { const r = compileExpr(ex.args[2], ctx, stmts); if (r.t !== 'str') throw new Error('map values must be str'); return r; })();
          const tmp = ctx.freshTmp();
          stmts.push(`let ${tmp}: Rc<str> = ${v.rs};`);
          stmts.push(`if !${target}.contains_key(${k}) { self.prefix_order.push(${k}.to_string()); }`);
          stmts.push(`${target}.insert(${k}.to_string(), ${tmp});`);
        }
        return;
      }
      const r = compileExpr(ex, ctx, stmts);
      if (envT === 'iri-string') {
        const tmp = ctx.freshTmp();
        if (r.resolveParts) {
          stmts.push(`let ${tmp} = resolve_iri(&${r.resolveParts.base}, ${r.resolveParts.rel}).into_owned();`);
        } else if (r.t === 'str') {
          stmts.push(`let ${tmp} = ${r.rs}.as_ref().to_string();`);
        } else throw new Error(`cannot assign ${r.t} to iri env slot`);
        stmts.push(`${target} = ${tmp};`);
      } else {
        stmts.push(`${target} = ${r.rs};`);
      }
      return;
    }
    case 'require': {
      const c = compileExpr(cl.cond, ctx, stmts);
      if (c.t !== 'bool') throw new Error('require condition must be bool');
      stmts.push(`if !(${c.rs}) { return Err(self.perr(${JSON.stringify(cl.code)})); }`);
      return;
    }
    case 'assign': {
      // threaded-local update
      const b = ctx.bindings.get(cl.name);
      if (!b) throw new Error(`assign to unbound '${cl.name}'`);
      const r = compileExpr(cl.expr, ctx, stmts);
      let rhs = r.rs;
      if (isOpt(b.t) && !isOpt(r.t)) rhs = `Some(${r.rs})`;
      stmts.push(`${cl.name} = ${rhs};`);
      return;
    }
    default:
      throw new Error(`unsupported clause kind '${cl.k}'`);
  }
}
