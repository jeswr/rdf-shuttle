/**
 * serializer-gen.js — the print mode (spec/SHUTTLE.md §7), stream-pretty
 * variant, generated from the same productions as the parser:
 *
 *  - term rendering follows the @prefer order of the `literal`/`String`/
 *    `iri`/`verb` prioritized groups; @when guards map to the fixed
 *    print-guard vocabulary, and *inferred* guards (bare numbers, booleans)
 *    compile to full-match functions generated from the very token patterns
 *    the parser lexes with (§4.4: "membership in the INTEGER token language");
 *  - statement shape (subject grouping with `;`/`,`, terminator `.`,
 *    `a` for rdf:type, `<<( … )>>` triple terms, `@prefix` directives) is
 *    extracted from the production/token ASTs;
 *  - PN_LOCAL escaping/validation for prefixed names is derived from the
 *    PN_LOCAL / PN_LOCAL_ESC charsets of the grammar;
 *  - window = subject (stream-pretty): guards that need residual-graph
 *    evidence (`listShaped`, `freshSingleUse`, `reifiesQuadPresent`) are
 *    conservatively false in v0.1, so collection / [ … ] / annotation sugar
 *    falls back to plain statements — the L3 guard-free fallback, degrading
 *    prettiness, never correctness.
 */

import { resolveCharset } from './lexer-gen.js';

function rangesTest(ranges, cVar) {
  const parts = ranges.map(([lo, hi]) =>
    lo === hi ? `${cVar} === ${lo}` : `(${cVar} >= ${lo} && ${cVar} <= ${hi})`
  );
  return parts.join(' || ');
}

/** Find the first item satisfying pred in a production's alts (deep). */
function findItem(prod, pred) {
  let found = null;
  const walk = (items) => {
    for (const it of items) {
      if (found) return;
      if (pred(it)) { found = it; return; }
      if (it.kind === 'thread') { for (const a of it.body) walk(a.items); continue; }
      if (it.kind === 'factor' && it.prim.kind === 'group') for (const a of it.prim.alts) walk(a.items);
    }
  };
  for (const a of prod.alts) walk(a.items);
  return found;
}

function curieIri(e) {
  const NS = {
    rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
    xsd: 'http://www.w3.org/2001/XMLSchema#',
  };
  return NS[e.prefix] + e.local;
}

export function genSerializer(g, an, makeStandaloneMatchers) {
  const need = (name) => {
    const p = g.prodByName.get(name);
    if (!p) throw new Error(`serializer: production ${name} missing`);
    return p;
  };

  /* ---- extract concrete syntax carriers from the grammar ---- */

  // objectList: `( … ) % ','`
  const olSepItem = findItem(need('objectList'), (it) => it.kind === 'factor' && it.postfix === 'sepList');
  const olSep = olSepItem ? olSepItem.sep : ',';
  // predicateObjectList: star group starting with a literal (';')
  const polStar = findItem(need('predicateObjectList'), (it) =>
    it.kind === 'factor' && it.postfix === 'star' && it.prim.kind === 'group');
  const polSep = polStar ? polStar.prim.alts[0].items[0].prim.text : ';';
  // statement: `triples '.'`
  const stmtAlt = need('statement').alts.find((a) => a.items.some((i) => i.kind === 'factor' && i.prim.kind === 'lit'));
  const stmtTerm = stmtAlt ? stmtAlt.items.find((i) => i.prim && i.prim.kind === 'lit').prim.text : '.';
  // verb: literal alternative + its constant (rdf:type -> 'a')
  const verbProd = need('verb');
  let typeKw = null;
  let typeIri = null;
  for (const a of verbProd.alts) {
    const lit = a.items.find((i) => i.kind === 'factor' && i.prim.kind === 'lit');
    const sem = a.items.find((i) => i.kind === 'sem');
    if (lit && sem) {
      const v = sem.clauses.find((c) => c.k === 'value');
      if (v && v.expr.k === 'curie') { typeKw = lit.prim.text; typeIri = curieIri(v.expr); }
    }
  }
  // tripleTerm delimiters
  const ttProd = g.prodByName.get('tripleTerm');
  let ttOpen = '<<(';
  let ttClose = ')>>';
  if (ttProd) {
    const lits = ttProd.alts[0].items.filter((i) => i.kind === 'factor' && i.prim.kind === 'lit');
    if (lits.length >= 2) { ttOpen = lits[0].prim.text; ttClose = lits[lits.length - 1].prim.text; }
  }
  // @prefix directive keyword (from the AT_PREFIX token pattern)
  let prefixKw = '@prefix';
  const pid = g.prodByName.get('prefixID');
  if (pid) {
    const tokItem = pid.alts[0].items.find((i) => i.kind === 'factor' && i.prim.kind === 'token');
    const tok = tokItem && g.tokenByName.get(tokItem.prim.name);
    if (tok && tok.pattern.k === 'lit') prefixKw = tok.pattern.text;
  }

  // NumericLiteral: token -> datatype mapping in @prefer order of `literal`
  const numCases = [];
  const numProd = g.prodByName.get('NumericLiteral');
  if (numProd) {
    for (const a of numProd.alts) {
      const tokItem = a.items.find((i) => i.kind === 'factor' && i.prim.kind === 'token');
      const sem = a.items.find((i) => i.kind === 'sem');
      const v = sem && sem.clauses.find((c) => c.k === 'value');
      if (tokItem && v && v.expr.k === 'call' && v.expr.fn === 'literal' && v.expr.args[1].k === 'curie') {
        numCases.push({ token: tokItem.prim.name, dt: curieIri(v.expr.args[1]) });
      }
    }
  }
  // BooleanLiteral: lexical forms + datatype
  let boolInfo = null;
  const boolProd = g.prodByName.get('BooleanLiteral');
  if (boolProd) {
    const lexes = [];
    let dt = null;
    for (const a of boolProd.alts) {
      const lit = a.items.find((i) => i.kind === 'factor' && i.prim.kind === 'lit');
      const sem = a.items.find((i) => i.kind === 'sem');
      const v = sem && sem.clauses.find((c) => c.k === 'value');
      if (lit && v) { lexes.push(lit.prim.text); dt = curieIri(v.expr.args[1]); }
    }
    if (dt) boolInfo = { lexes, dt };
  }

  /* ---- full-match guards from token patterns ---- */

  const fmTokens = [...new Set([...numCases.map((c) => c.token), 'PN_PREFIX', 'BLANK_NODE_LABEL'])]
    .filter((t) => g.tokenByName.has(t));
  const fmCode = makeStandaloneMatchers(fmTokens);

  /* ---- PN_LOCAL charsets for prefixed-name locals ---- */

  let pnLocalCode = 'function escLocal(s) { return null; }';
  const pnl = g.tokenByName.get('PN_LOCAL');
  if (pnl && pnl.pattern.k === 'seq') {
    const elems = (n) => (n.k === 'alt' ? n.items : [n]);
    const charsetUnion = (els) => {
      let acc = [];
      for (const el of els) {
        const r = resolveCharset(el, g);
        if (r !== null) acc = acc.concat(r);
      }
      acc.sort((a, b) => a[0] - b[0]);
      const merged = [];
      for (const r of acc) {
        const last = merged[merged.length - 1];
        if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
        else merged.push([...r]);
      }
      return merged;
    };
    const firstEls = elems(pnl.pattern.items[0]);
    const tail = pnl.pattern.items[1]; // Opt(Seq[Star(X), Y])
    let midEls = firstEls;
    let lastEls = firstEls;
    if (tail && tail.k === 'opt' && tail.item.k === 'seq') {
      midEls = elems(tail.item.items[0].item);
      lastEls = elems(tail.item.items[1]);
    }
    // escapable charset: the class of the backslash-escape fragment (PN_LOCAL_ESC)
    let escRanges = [];
    const findEscClass = (els) => {
      for (const el of els) {
        if (el.k !== 'ref') continue;
        const frag = g.tokenByName.get(el.name);
        if (!frag) continue;
        if (frag.pattern.k === 'alt') { findEscClass(frag.pattern.items.map((x) => x)); continue; }
        if (frag.pattern.k === 'seq' && frag.pattern.items[0].k === 'lit' && frag.pattern.items[0].text === '\\') {
          const cls = frag.pattern.items[1];
          if (cls.k === 'class') escRanges = cls.ranges;
        }
      }
    };
    findEscClass(midEls);
    pnLocalCode = `
const pnFirst = (c) => ${rangesTest(charsetUnion(firstEls), 'c')};
const pnMid = (c) => ${rangesTest(charsetUnion(midEls), 'c')};
const pnLast = (c) => ${rangesTest(charsetUnion(lastEls), 'c')};
const pnEsc = (c) => ${escRanges.length ? rangesTest(escRanges, 'c') : 'false'};
function escLocal(s) {
  const n = s.length;
  let out = '';
  let i = 0;
  while (i < n) {
    const cp = s.codePointAt(i);
    const w = cp > 0xffff ? 2 : 1;
    const ok = i === 0 ? pnFirst(cp) : (i + w >= n ? pnLast(cp) : pnMid(cp));
    if (ok) out += s.slice(i, i + w);
    else if (pnEsc(cp)) out += '\\\\' + s[i];
    else return null;
    i += w;
  }
  return out;
}`;
  }

  const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';

  const numGuardCode = numCases.map((c) =>
    `  if (dtv === ${JSON.stringify(c.dt)} && fm_${c.token}(v)) return v;`).join('\n');
  const boolGuardCode = boolInfo
    ? `  if (dtv === ${JSON.stringify(boolInfo.dt)} && (${boolInfo.lexes.map((l) => `v === ${JSON.stringify(l)}`).join(' || ')})) return v;`
    : '';

  const code = `
/* ==================================================================
 * Serializer — print mode of the same grammar (stream-pretty window).
 * ================================================================== */

${fmCode}
${pnLocalCode}

const NEEDS_LONG_RE = /[\\n\\r]/; // needsLongQuoting print guard

export function createWriter(options = {}) {
  const chunks = [];
  const push = options.write || ((s) => { chunks.push(s); });
  const prefixesOpt = options.prefixes || {};
  const prefixList = [];
  for (const label of Object.keys(prefixesOpt)) {
    const iri = String(prefixesOpt[label] && prefixesOpt[label].value !== undefined ? prefixesOpt[label].value : prefixesOpt[label]);
    if (label !== '' && !fm_PN_PREFIX(label)) throw new Error('invalid prefix label: ' + label);
    prefixList.push({ label, iri });
  }
  prefixList.sort((a, b) => b.iri.length - a.iri.length);
  const abbrevCache = new Map();
  const bnMap = new Map();
  const bnUsed = new Set();
  let bnCtr = 0;
  let lastS = null;
  let lastP = null;
  let headerDone = false;

  function bnLabel(v) {
    let l = bnMap.get(v);
    if (l === undefined) {
      l = fm_BLANK_NODE_LABEL('_:' + v) && !bnUsed.has(v) ? v : null;
      if (l === null) { do { l = 'b' + (bnCtr++); } while (bnUsed.has(l)); }
      bnUsed.add(l);
      bnMap.set(v, l);
    }
    return l;
  }

  function iriStr(t) {
    const v = t.value;
    let a = abbrevCache.get(v);
    if (a !== undefined) return a;
    a = null;
    for (let i = 0; i < prefixList.length; i++) {
      const P = prefixList[i];
      if (v.startsWith(P.iri)) {
        const l = escLocal(v.slice(P.iri.length));
        if (l !== null) a = P.label + ':' + l;
        break;
      }
    }
    if (a === null) a = '<' + escIri(v) + '>';
    abbrevCache.set(v, a);
    return a;
  }

  function verbStr(t) {
    ${typeKw !== null ? `if (t.value === ${JSON.stringify(typeIri)}) return ${JSON.stringify(typeKw)};` : ''}
    return iriStr(t);
  }

  function litStr(t) {
    const v = t.value;
    const dtv = t.datatype ? t.datatype.value : ${JSON.stringify(XSD_STRING)};
${numGuardCode}
${boolGuardCode}
    const q = NEEDS_LONG_RE.test(v)
      ? '"""' + escStrLong(v) + '"""'
      : '"' + escStrShort(v) + '"';
    if (t.language) return q + '@' + t.language + (t.direction ? '--' + t.direction : '');
    if (dtv !== ${JSON.stringify(XSD_STRING)}) return q + '^^' + iriStr(t.datatype);
    return q;
  }

  function termStr(t) {
    switch (t.termType) {
      case 'NamedNode': return iriStr(t);
      case 'Literal': return litStr(t);
      case 'BlankNode': return '_:' + bnLabel(t.value);
      case 'Quad':
        return ${JSON.stringify(ttOpen)} + ' ' + termStr(t.subject) + ' ' + verbStr(t.predicate)
          + ' ' + termStr(t.object) + ' ' + ${JSON.stringify(ttClose)};
      default:
        throw new Error('turtle12: cannot serialize term of type ' + t.termType);
    }
  }

  function sameT(a, b) { return a.termType === b.termType && a.value === b.value; }

  function header() {
    headerDone = true;
    for (const P of prefixList) push(${JSON.stringify(prefixKw)} + ' ' + P.label + ': <' + escIri(P.iri) + '> ${stmtTerm}\\n');
    if (prefixList.length > 0) push('\\n');
  }

  function quad(q) {
    if (!headerDone) header();
    if (q.graph && q.graph.termType !== 'DefaultGraph') {
      throw new Error('turtle12 emits triples: named graphs are not expressible (print residual would not empty)');
    }
    if (lastS !== null && sameT(q.subject, lastS)) {
      if (sameT(q.predicate, lastP)) {
        push('${olSep} ' + termStr(q.object));
      } else {
        push(' ${polSep}\\n    ' + verbStr(q.predicate) + ' ' + termStr(q.object));
        lastP = q.predicate;
      }
    } else {
      if (lastS !== null) push(' ${stmtTerm}\\n');
      push(termStr(q.subject) + ' ' + verbStr(q.predicate) + ' ' + termStr(q.object));
      lastS = q.subject;
      lastP = q.predicate;
    }
  }

  function end() {
    if (lastS !== null) push(' ${stmtTerm}\\n');
    else if (!headerDone) header();
    lastS = null;
    return options.write ? undefined : chunks.join('');
  }

  return { quad, end };
}

export function writeQuads(quads, options = {}) {
  const w = createWriter(options);
  for (const q of quads) w.quad(q);
  return w.end();
}
`;
  return { code };
}
