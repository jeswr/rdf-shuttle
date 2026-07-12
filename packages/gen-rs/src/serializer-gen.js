/**
 * serializer-gen.js — the print mode (spec/SHUTTLE.md §7), stream-pretty
 * variant, generated from the same productions as the parser — Rust
 * emission. Mirrors the JS backend point for point:
 *
 *  - statement shape (subject grouping with `;`/`,`, terminator, `a` for
 *    rdf:type, triple-term delimiters, `@prefix`) is extracted from the
 *    production/token ASTs, never hard-coded;
 *  - inferred print guards (bare numbers, booleans) are full-match calls on
 *    the very matcher functions the parser lexes with (§4.4);
 *  - PN_LOCAL escaping/validation derives from the grammar's charsets;
 *  - window = subject (stream-pretty): residual-evidence guards are
 *    conservatively false in v0.1 — collection/[…]/annotation sugar falls
 *    back to plain statements (L3: degrading prettiness, never correctness).
 */

import { resolveCharset } from '../../gen-js/src/lexer-gen.js';
import { genFullMatchers } from './lexer-gen.js';

function rangesTest(ranges, cVar) {
  const parts = ranges.map(([lo, hi]) => {
    if (lo === hi) return `${cVar} == ${lo}`;
    if (lo === 0) return `${cVar} <= ${hi}`; // c is unsigned: >= 0 is vacuous
    return `(${cVar} >= ${lo} && ${cVar} <= ${hi})`;
  });
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

/**
 * Derive the Rust `esc_local` (PN_LOCAL escaping) helper from the grammar's
 * PN_LOCAL token. Shared by the Turtle-spine and residual serializers.
 */
export function derivePnLocalRs(g) {
  let pnLocalCode = `fn esc_local(_s: &str) -> Option<String> { None }`;
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
#[inline]
fn pn_first(c: u32) -> bool { ${rangesTest(charsetUnion(firstEls), 'c')} }
#[inline]
fn pn_mid(c: u32) -> bool { ${rangesTest(charsetUnion(midEls), 'c')} }
#[inline]
fn pn_last(c: u32) -> bool { ${rangesTest(charsetUnion(lastEls), 'c')} }
#[inline]
fn pn_esc(c: u32) -> bool { ${escRanges.length ? rangesTest(escRanges, 'c') : 'false'} }

/// Escape an IRI suffix as a PN_LOCAL, or None if not expressible.
fn esc_local(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let n = b.len();
    let mut out = String::with_capacity(n + 2);
    let mut i = 0;
    while i < n {
        let (cp, w) = cp_at(b, i);
        let ok = if i == 0 { pn_first(cp) } else if i + w >= n { pn_last(cp) } else { pn_mid(cp) };
        if ok {
            out.push_str(&s[i..i + w]);
        } else if pn_esc(cp) {
            out.push('\\\\');
            out.push_str(&s[i..i + w]);
        } else {
            return None;
        }
        i += w;
    }
    Some(out)
}`;
  }

  return pnLocalCode;
}

export function genSerializer(g, an, lx) {
  const need = (name) => {
    const p = g.prodByName.get(name);
    if (!p) throw new Error(`serializer: production ${name} missing`);
    return p;
  };

  /* ---- extract concrete syntax carriers from the grammar ---- */

  const olSepItem = findItem(need('objectList'), (it) => it.kind === 'factor' && it.postfix === 'sepList');
  const olSep = olSepItem ? olSepItem.sep : ',';
  const polStar = findItem(need('predicateObjectList'), (it) =>
    it.kind === 'factor' && it.postfix === 'star' && it.prim.kind === 'group');
  const polSep = polStar ? polStar.prim.alts[0].items[0].prim.text : ';';
  const stmtAlt = need('statement').alts.find((a) => a.items.some((i) => i.kind === 'factor' && i.prim.kind === 'lit'));
  const stmtTerm = stmtAlt ? stmtAlt.items.find((i) => i.prim && i.prim.kind === 'lit').prim.text : '.';
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
  const ttProd = g.prodByName.get('tripleTerm');
  let ttOpen = '<<(';
  let ttClose = ')>>';
  if (ttProd) {
    const lits = ttProd.alts[0].items.filter((i) => i.kind === 'factor' && i.prim.kind === 'lit');
    if (lits.length >= 2) { ttOpen = lits[0].prim.text; ttClose = lits[lits.length - 1].prim.text; }
  }
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
  const fmCode = genFullMatchers(g, an, lx, fmTokens);

  /* ---- PN_LOCAL charsets for prefixed-name locals ---- */

  const pnLocalCode = derivePnLocalRs(g);

  const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';

  const numGuardCode = numCases.map((c) =>
    `    if dtv == ${JSON.stringify(c.dt)} && fm_${c.token}(&l.value) { return l.value.to_string(); }`).join('\n');
  const boolGuardCode = boolInfo
    ? `    if dtv == ${JSON.stringify(boolInfo.dt)} && (${boolInfo.lexes.map((x) => `l.value.as_ref() == ${JSON.stringify(x)}`).join(' || ')}) { return l.value.to_string(); }`
    : '';

  const rstr = JSON.stringify; // Rust string literals: JSON escaping is compatible

  const code = `
/* ==================================================================
 * Serializer — print mode of the same grammar (stream-pretty window).
 * ================================================================== */

${fmCode}
${pnLocalCode}

fn needs_long(v: &str) -> bool { v.bytes().any(|c| c == b'\\n' || c == b'\\r') } // needsLongQuoting print guard

fn same_t(a: &Term, b: &Term) -> bool {
    match (a, b) {
        (Term::NamedNode(x), Term::NamedNode(y)) => x == y,
        (Term::BlankNode(x), Term::BlankNode(y)) => x == y,
        _ => false,
    }
}

/// An error constructing a writer (e.g. an invalid prefix label).
#[derive(Debug, Clone)]
pub struct WriteError {
    /// Human-readable message.
    pub message: String,
}

impl fmt::Display for WriteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { write!(f, "{}", self.message) }
}

impl std::error::Error for WriteError {}

/// Streaming serializer: feed triples with [\`Writer::triple\`], collect the
/// document with [\`Writer::end\`]. The backward (print) reading of the same
/// grammar the parser was generated from.
pub struct Writer {
    prefix_list: Vec<(String, String)>,
    abbrev_cache: HashMap<String, String>,
    bn_map: HashMap<String, String>,
    bn_used: HashSet<String>,
    bn_ctr: u64,
    last_s: Option<Term>,
    last_p: Option<Term>,
    header_done: bool,
    out: String,
}

impl Writer {
    /// Create a writer; \`prefixes\` is an ordered (label, iri) list used for
    /// abbreviation (longest IRI wins). Fails on an invalid prefix label.
    pub fn new(prefixes: &[(String, String)]) -> Result<Self, WriteError> {
        let mut prefix_list: Vec<(String, String)> = Vec::with_capacity(prefixes.len());
        for (label, iri) in prefixes {
            if !label.is_empty() && !fm_PN_PREFIX(label) {
                return Err(WriteError { message: format!("invalid prefix label: {label}") });
            }
            prefix_list.push((label.clone(), iri.clone()));
        }
        prefix_list.sort_by_key(|p| std::cmp::Reverse(p.1.len()));
        Ok(Writer {
            prefix_list,
            abbrev_cache: HashMap::new(),
            bn_map: HashMap::new(),
            bn_used: HashSet::new(),
            bn_ctr: 0,
            last_s: None,
            last_p: None,
            header_done: false,
            out: String::new(),
        })
    }

    fn bn_label(&mut self, v: &str) -> String {
        if let Some(l) = self.bn_map.get(v) {
            return l.clone();
        }
        let full = format!("_:{v}");
        let mut label: Option<String> = if fm_BLANK_NODE_LABEL(&full) && !self.bn_used.contains(v) {
            Some(v.to_string())
        } else {
            None
        };
        if label.is_none() {
            loop {
                let cand = format!("b{}", self.bn_ctr);
                self.bn_ctr += 1;
                if !self.bn_used.contains(&cand) {
                    label = Some(cand);
                    break;
                }
            }
        }
        let l = label.unwrap_or_default();
        self.bn_used.insert(l.clone());
        self.bn_map.insert(v.to_string(), l.clone());
        l
    }

    fn iri_str(&mut self, v: &str) -> String {
        if let Some(a) = self.abbrev_cache.get(v) {
            return a.clone();
        }
        let mut a: Option<String> = None;
        for (label, iri) in &self.prefix_list {
            if let Some(rest) = v.strip_prefix(iri.as_str()) {
                if let Some(l) = esc_local(rest) {
                    a = Some(format!("{label}:{l}"));
                }
                break;
            }
        }
        let a = a.unwrap_or_else(|| format!("<{}>", esc_iri(v)));
        self.abbrev_cache.insert(v.to_string(), a.clone());
        a
    }

    fn verb_str(&mut self, t: &Term) -> String {
        ${typeKw !== null ? `if let Term::NamedNode(v) = t {
            if v.as_ref() == ${rstr(typeIri)} {
                return ${rstr(typeKw)}.to_string();
            }
        }` : ''}
        self.term_str(t)
    }

    fn lit_str(&mut self, l: &LiteralData) -> String {
        let dtv: &str = if let Term::NamedNode(d) = &l.datatype { d } else { "" };
${numGuardCode}
${boolGuardCode}
        let q = if needs_long(&l.value) {
            format!("\\"\\"\\"{}\\"\\"\\"", esc_str_long(&l.value))
        } else {
            format!("\\"{}\\"", esc_str_short(&l.value))
        };
        if !l.language.is_empty() {
            return match &l.direction {
                Some(d) => format!("{q}@{}--{d}", l.language),
                None => format!("{q}@{}", l.language),
            };
        }
        if dtv != ${rstr(XSD_STRING)} {
            let dts = self.iri_str(dtv);
            return format!("{q}^^{dts}");
        }
        q
    }

    fn term_str(&mut self, t: &Term) -> String {
        match t {
            Term::NamedNode(v) => self.iri_str(v),
            Term::Literal(l) => { let l = Rc::clone(l); self.lit_str(&l) }
            Term::BlankNode(v) => { let v = Rc::clone(v); format!("_:{}", self.bn_label(&v)) }
            Term::Triple(q) => {
                let q = Rc::clone(q);
                let s = self.term_str(&q.subject);
                let p = self.verb_str(&q.predicate);
                let o = self.term_str(&q.object);
                format!("${ttOpen} {s} {p} {o} ${ttClose}")
            }
        }
    }

    fn header(&mut self) {
        self.header_done = true;
        for (label, iri) in &self.prefix_list {
            self.out.push_str(&format!("${prefixKw} {label}: <{}> ${stmtTerm}\\n", esc_iri(iri)));
        }
        if !self.prefix_list.is_empty() {
            self.out.push('\\n');
        }
    }

    /// Write one triple (stream-pretty: consecutive same-subject triples
    /// group with \`${polSep}\`, same-predicate objects with \`${olSep}\`).
    pub fn triple(&mut self, q: &Triple) {
        if !self.header_done {
            self.header();
        }
        let same_s = self.last_s.as_ref().is_some_and(|ls| same_t(&q.subject, ls));
        if same_s {
            let same_p = self.last_p.as_ref().is_some_and(|lp| same_t(&q.predicate, lp));
            if same_p {
                let o = self.term_str(&q.object);
                self.out.push_str("${olSep} ");
                self.out.push_str(&o);
            } else {
                let v = self.verb_str(&q.predicate);
                let o = self.term_str(&q.object);
                self.out.push_str(" ${polSep}\\n    ");
                self.out.push_str(&v);
                self.out.push(' ');
                self.out.push_str(&o);
                self.last_p = Some(q.predicate.clone());
            }
        } else {
            if self.last_s.is_some() {
                self.out.push_str(" ${stmtTerm}\\n");
            }
            let s = self.term_str(&q.subject);
            let v = self.verb_str(&q.predicate);
            let o = self.term_str(&q.object);
            self.out.push_str(&s);
            self.out.push(' ');
            self.out.push_str(&v);
            self.out.push(' ');
            self.out.push_str(&o);
            self.last_s = Some(q.subject.clone());
            self.last_p = Some(q.predicate.clone());
        }
    }

    /// Terminate the document and return it.
    pub fn end(mut self) -> String {
        if self.last_s.is_some() {
            self.out.push_str(" ${stmtTerm}\\n");
        } else if !self.header_done {
            self.header();
        }
        self.out
    }
}

/// Serialize a slice of triples with the given prefix table.
pub fn write_triples(triples: &[Triple], prefixes: &[(String, String)]) -> Result<String, WriteError> {
    let mut w = Writer::new(prefixes)?;
    for q in triples {
        w.triple(q);
    }
    Ok(w.end())
}
`;
  return { code };
}
