/**
 * residual-serializer-gen.js — Rust backend of the residual-consumption
 * print mode (spec/SHUTTLE.md §8) for the SHACL-CS grammar family
 * (`profile shaclc`). The backend-agnostic print MODEL (vocabulary,
 * keyword tables, oracle registry, print{} inversion defaults, lexical
 * data, profile-gated layer flags) is extracted once by
 * gen-js/src/residual-serializer-gen.js#extractShaclcPrintModel; this file
 * only translates the printer runtime into Rust.
 *
 * The printer's OUTPUT is byte-identical to the JS backend's on every
 * printable graph (the cross-backend conformance harness diffs the
 * serialized bytes), and the residual verdict (quads no construct could
 * consume) is the same set.
 */

import { extractShaclcPrintModel } from '../../gen-js/src/residual-serializer-gen.js';
import { genFullMatchers } from './lexer-gen.js';
import { derivePnLocalRs } from './serializer-gen.js';

const rstr = (s) => JSON.stringify(s); // Rust string literal (JSON-escape is compatible)

export function genResidualSerializer(g, an, lx, gen) {
  const M = extractShaclcPrintModel(g, gen);
  const { V, KW } = M;

  const fmCode = genFullMatchers(g, an, lx, M.fmTokens);
  const pnLocalCode = derivePnLocalRs(g);

  const mapConst = (name, entries) =>
    `static ${name}: &[(&str, &str)] = &[${entries.map(([k, v]) => `(${rstr(k)}, ${rstr(v)})`).join(', ')}];`;

  const numGuard = M.numCases.map((c) =>
    `    if dtv == ${rstr(c.dt)} && fm_${c.token}(v) { return Some(v.to_string()); }`).join('\n');
  const boolGuard = M.boolInfo
    ? `    if dtv == ${rstr(M.boolInfo.dt)} && (${M.boolInfo.lexes.map((l) => `v == ${rstr(l)}`).join(' || ')}) { return Some(v.to_string()); }`
    : '';

  const code = `
/* ==================================================================
 * Serializer — residual-consumption print mode of the same grammar
 * (spec §8, shaclc profile). Printing starts with the whole graph as
 * a residual; each printed construct consumes the triples it re-emits
 * on parse. Print succeeds iff the residual empties; a non-empty
 * residual is the "not compact-expressible" verdict. Vocabulary,
 * keywords, oracle registry, print{} inversion defaults, lexical
 * guards and profile-gated fallback layers are extracted from the
 * grammar AST at generation time. Output is byte-identical to the JS
 * backend's printer.
 * ================================================================== */

${fmCode}
${pnLocalCode}

/* ---- print-model constants (grammar-extracted) ---- */
${mapConst('RS_NODE_PARAM', M.nodeParamMap)}
${mapConst('RS_PROP_PARAM', M.propParamMap)}
${mapConst('RS_NODEKIND', M.nodeKindMap)}
${mapConst('RS_PATHMOD', M.pathMods)}
static RS_PREDECLARED: &[(&str, &str)] = &[${M.predeclared.map(([k, v]) => `(${rstr(k)}, ${rstr(v)})`).join(', ')}];
const RS_EXT_ANNOTATION: bool = ${M.ext.annotation};
const RS_EXT_PC: bool = ${M.ext.pc};
const RS_EXT_TTL: bool = ${M.ext.ttl};
const RS_MIN_GUARDED: bool = ${M.minGuarded};
const RS_HAS_TT: bool = ${M.hasTT};
const RS_EMPTY_ARRAY: bool = ${M.emptyArrayEmit};

const V_RDF_TYPE: &str = ${rstr(V.rdfType)};
const V_ONTOLOGY: &str = ${rstr(V.ontology)};
const V_IMPORTS: &str = ${rstr(V.imports)};
const V_NODESHAPE: &str = ${rstr(V.nodeShapeCls)};
const V_RDFS_CLASS: &str = ${rstr(V.rdfsClass)};
const V_TARGETCLASS: &str = ${rstr(V.targetClass)};
const V_PROPERTY: &str = ${rstr(V.shProperty)};
const V_PATH: &str = ${rstr(V.shPath)};
const V_MINCOUNT: &str = ${rstr(V.shMinCount)};
const V_MAXCOUNT: &str = ${rstr(V.shMaxCount)};
const V_OR: &str = ${rstr(V.shOr)};
const V_NOT: &str = ${rstr(V.shNot)};
const V_NODE: &str = ${rstr(V.shNode)};
const V_DATATYPE: &str = ${rstr(V.shDatatype)};
const V_CLASS: &str = ${rstr(V.shClass)};
const V_NODEKIND: &str = ${rstr(V.shNodeKind)};
const V_RDF_FIRST: &str = ${rstr(V.rdfFirst)};
const V_RDF_REST: &str = ${rstr(V.rdfRest)};
const V_RDF_NIL: &str = ${rstr(V.rdfNil)};
const V_ALTPATH: &str = ${rstr(V.shAltPath)};
const V_INVERSE: &str = ${rstr(V.shInverse)};
const V_XSD_INTEGER: &str = ${rstr(V.xsdInteger)};
const V_XSD_STRING: &str = ${rstr(V.xsdString)};
const V_LANGSTRING: &str = ${rstr(V.langString)};
const V_DIRLANGSTRING: &str = ${rstr(V.dirLangString)};

const K_BASE: &str = ${rstr(KW.base)};
const K_IMPORTS: &str = ${rstr(KW.imports)};
const K_PREFIX: &str = ${rstr(KW.prefix)};
const K_SHAPE: &str = ${rstr(KW.shape)};
const K_SHAPECLASS: &str = ${rstr(KW.shapeClass)};
const K_ARROW: &str = ${rstr(KW.arrow)};
const K_NOT: &str = ${rstr(KW.not)};
const K_OR: &str = ${rstr(KW.or)};
const K_REF: &str = ${rstr(KW.ref)};
const K_DOT: &str = ${rstr(KW.dot)};
const K_BODY_OPEN: &str = ${rstr(KW.bodyOpen)};
const K_BODY_CLOSE: &str = ${rstr(KW.bodyClose)};
const K_CNT_OPEN: &str = ${rstr(KW.cntOpen)};
const K_CNT_DOTS: &str = ${rstr(KW.cntDots)};
const K_CNT_CLOSE: &str = ${rstr(KW.cntClose)};
const K_ARR_OPEN: &str = ${rstr(KW.arrOpen)};
const K_ARR_CLOSE: &str = ${rstr(KW.arrClose)};
const K_PAR_OPEN: &str = ${rstr(KW.parOpen)};
const K_PAR_CLOSE: &str = ${rstr(KW.parClose)};
const K_PATH_SEQ_SEP: &str = ${rstr(KW.pathSeqSep)};
const K_INVERSE: &str = ${rstr(KW.inverse)};
const K_DT_SEP: &str = ${rstr(KW.dtSep)};
const K_TT_OPEN: &str = ${rstr(KW.ttOpen === null ? '' : KW.ttOpen)};
const K_TT_CLOSE: &str = ${rstr(KW.ttClose === null ? '' : KW.ttClose)};
const K_ANN_SEP: &str = ${rstr(KW.annSep)};
const K_OBJ_SEP: &str = ${rstr(KW.objSep)};
const K_PC_OPEN: &str = ${rstr(KW.pcOpen)};
const K_PC_CLOSE: &str = ${rstr(KW.pcClose)};
const K_BN_OPEN: &str = ${rstr(KW.bnOpen)};
const K_BN_CLOSE: &str = ${rstr(KW.bnClose)};
const K_LIST_OPEN: &str = ${rstr(KW.listOpen)};
const K_LIST_CLOSE: &str = ${rstr(KW.listClose)};
const K_MIN_DEFAULT: &str = ${rstr(KW.minDefault)};
const K_MAX_DEFAULT: &str = ${rstr(KW.maxDefault)};

fn rs_map_get(m: &'static [(&'static str, &'static str)], k: &str) -> Option<&'static str> {
    m.iter().find(|(mk, _)| *mk == k).map(|(_, v)| *v)
}

fn rs_num_bool(v: &str, dtv: &str) -> Option<String> {
${numGuard}
${boolGuard}
    None
}

/// The missing required document-ontology pattern (the document clause
/// would re-emit \`<base> rdf:type owl:Ontology\`, so no faithful print
/// exists without a matching triple in the graph).
#[derive(Debug, Clone)]
pub struct MissingOntology {
    /// The preferred subject (the caller's base IRI), if one was supplied.
    pub subject: Option<String>,
}

/// Outcome of a residual print: the document text (when the required
/// ontology pattern exists), the unconsumed residual, and the missing
/// pattern when there is one.
#[derive(Debug, Clone)]
pub struct ResidualPrint {
    /// The printed document (None iff \`missing\` is Some).
    pub text: Option<String>,
    /// Triples no printable construct could consume — non-empty means the
    /// graph is NOT compact-expressible in this profile.
    pub residual: Vec<Triple>,
    /// Set when the required document-ontology pattern is absent.
    pub missing: Option<MissingOntology>,
}

/// The "graph is not compact-expressible" verdict, carrying the residual.
#[derive(Debug, Clone)]
pub struct ResidualError {
    /// Human-readable verdict.
    pub message: String,
    /// The unconsumed triples.
    pub residual: Vec<Triple>,
    /// The missing document-ontology pattern, when that is the cause.
    pub missing: Option<MissingOntology>,
}

impl std::fmt::Display for ResidualError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ResidualError {}

fn rs_term_key(t: &Term) -> String {
    match t {
        Term::NamedNode(v) => format!("<{v}>"),
        Term::BlankNode(v) => format!("_:{v}"),
        Term::Literal(l) => {
            let dt = if let Term::NamedNode(d) = &l.datatype { d.as_ref() } else { "" };
            let dir = l.direction.as_ref().map_or("", |d| d.as_ref());
            format!("{:?}@{}--{}^^{}", l.value.as_ref(), l.language, dir, dt)
        }
        Term::Triple(q) => format!(
            "<<({} {} {})>>",
            rs_term_key(&q.subject),
            rs_term_key(&q.predicate),
            rs_term_key(&q.object)
        ),
    }
}

fn rs_strip_fragment(iri: &str) -> &str {
    match iri.find('#') {
        Some(h) => &iri[..h],
        None => iri,
    }
}

fn nn_value(t: &Term) -> Option<&str> {
    if let Term::NamedNode(v) = t { Some(v.as_ref()) } else { None }
}

fn bn_value(t: &Term) -> Option<&str> {
    if let Term::BlankNode(v) = t { Some(v.as_ref()) } else { None }
}

type Txn = HashSet<usize>;

/// Which element language an or-chain carries (property vs node level).
#[derive(Clone, Copy)]
enum ChainElem {
    Prop,
    Node,
}

struct RPrinter<'a> {
    all: Vec<&'a Triple>,
    used: Vec<bool>,
    by_subj: Vec<(String, Vec<usize>)>,
    b_ref: Vec<(String, usize)>,
    /// longest-IRI-first (stable) prefix list for abbreviation
    prefix_list: Vec<(String, String)>,
}

impl<'a> RPrinter<'a> {
    fn on_key(&self, key: &str) -> &[usize] {
        self.by_subj
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_slice())
            .unwrap_or(&[])
    }

    fn on(&self, t: &Term) -> Vec<usize> {
        self.on_key(&rs_term_key(t)).to_vec()
    }

    fn free(&self, i: usize, txn: &Txn) -> bool {
        !self.used[i] && !txn.contains(&i)
    }

    fn single_ref(&self, t: &Term) -> bool {
        match bn_value(t) {
            Some(label) => self.b_ref.iter().find(|(l, _)| l == label).map_or(0, |(_, c)| *c) == 1,
            None => false,
        }
    }

    fn pred(&self, i: usize) -> &str {
        nn_value(&self.all[i].predicate).unwrap_or("")
    }

    /* ---- prefixed-name abbreviation (no cache; shapes docs are small) ---- */
    fn iri_text(&self, v: &str) -> String {
        for (label, iri) in &self.prefix_list {
            if let Some(rest) = v.strip_prefix(iri.as_str()) {
                if let Some(l) = esc_local(rest) {
                    return format!("{label}:{l}");
                }
                break; // first (longest) matching prefix decides, as in parse
            }
        }
        format!("<{}>", esc_iri(v))
    }

    /* ---- literals: lexical-fidelity print or refusal ---- */
    fn lit_text(&self, l: &LiteralData) -> Option<String> {
        let v = l.value.as_ref();
        let dtv = if let Term::NamedNode(d) = &l.datatype { d.as_ref() } else { V_XSD_STRING };
        if let Some(nb) = rs_num_bool(v, dtv) {
            return Some(nb);
        }
        let q = if v.contains('\\n') || v.contains('\\r') {
            format!("\\"\\"\\"{}\\"\\"\\"", esc_str_long(v))
        } else {
            format!("\\"{}\\"", esc_str_short(v))
        };
        if !l.language.is_empty() {
            let lang = l.language.as_ref();
            let tag = match &l.direction {
                Some(d) => format!("@{lang}--{d}"),
                None => format!("@{lang}"),
            };
            // parse canonicalizes the tag (lowercase) and lexes LANG_DIR: a
            // tag that would not round-trip to this term is refused.
            if lang.chars().any(|c| c.is_ascii_uppercase()) || !fm_LANG_DIR(&tag) {
                return None;
            }
            if l.direction.is_some() && dtv != V_DIRLANGSTRING {
                return None;
            }
            if l.direction.is_none() && dtv != V_LANGSTRING {
                return None;
            }
            return Some(format!("{q}{tag}"));
        }
        if dtv != V_XSD_STRING {
            return Some(format!("{q}{}{}", K_DT_SEP, self.iri_text(dtv)));
        }
        Some(q)
    }

    /* ---- rdf list reader (transactional): cons cells must be single-use
     * blanks with exactly {first, rest} free ---- */
    fn read_list(&self, head: &Term, txn: &mut Txn) -> Option<Vec<Term>> {
        let mut elems = Vec::new();
        let mut node = head.clone();
        loop {
            if nn_value(&node) == Some(V_RDF_NIL) {
                return Some(elems);
            }
            if bn_value(&node).is_none() || !self.single_ref(&node) {
                return None;
            }
            let idxs: Vec<usize> = self.on(&node).into_iter().filter(|&i| self.free(i, txn)).collect();
            if idxs.len() != 2 {
                return None;
            }
            let mut fi = usize::MAX;
            let mut ri = usize::MAX;
            for &i in &idxs {
                if self.pred(i) == V_RDF_FIRST {
                    fi = i;
                } else if self.pred(i) == V_RDF_REST {
                    ri = i;
                }
            }
            if fi == usize::MAX || ri == usize::MAX {
                return None;
            }
            txn.insert(fi);
            txn.insert(ri);
            elems.push(self.all[fi].object.clone());
            node = self.all[ri].object.clone();
        }
    }

    /* ---- triple terms ---- */
    fn tt_text(&self, t: &Triple) -> Option<String> {
        if !RS_HAS_TT {
            return None;
        }
        let s = nn_value(&t.subject)?;
        let p = nn_value(&t.predicate)?;
        let ot = match &t.object {
            Term::NamedNode(v) => self.iri_text(v),
            Term::Literal(l) => self.lit_text(l)?,
            Term::Triple(q) => self.tt_text(q)?,
            Term::BlankNode(_) => return None,
        };
        Some(format!("{K_TT_OPEN} {} {} {ot} {K_TT_CLOSE}", self.iri_text(s), self.iri_text(p)))
    }

    /* ---- iriOrLiteralOrArray ---- */
    fn value_text(&self, t: &Term, txn: &mut Txn) -> Option<String> {
        match t {
            Term::NamedNode(v) => return Some(self.iri_text(v)),
            Term::Literal(l) => return self.lit_text(l),
            Term::Triple(q) => return self.tt_text(q),
            Term::BlankNode(_) => {}
        }
        if !self.single_ref(t) {
            return None;
        }
        // array: a proper rdf list of iri/literal/tt, or the empty-array shape
        let idxs: Vec<usize> = self.on(t).into_iter().filter(|&i| self.free(i, txn)).collect();
        if RS_EMPTY_ARRAY && idxs.len() == 1 {
            let q = self.all[idxs[0]];
            if self.pred(idxs[0]) == V_RDF_REST && nn_value(&q.object) == Some(V_RDF_NIL) {
                txn.insert(idxs[0]);
                return Some(format!("{K_ARR_OPEN}{K_ARR_CLOSE}"));
            }
        }
        let elems = self.read_list(t, txn)?;
        if elems.is_empty() {
            return None;
        }
        let mut parts = Vec::new();
        for e in &elems {
            if bn_value(e).is_some() {
                return None; // arrays hold iriOrLiteral only
            }
            parts.push(self.value_text(e, txn)?);
        }
        Some(format!("{K_ARR_OPEN} {} {K_ARR_CLOSE}", parts.join(" ")))
    }

    /* ---- path algebra inversion ----
     * levels: 0 alternative | 1 sequence | 2 eltOrInverse | 3 elt | 4 primary */
    fn path_text(&self, t: &Term, txn: &mut Txn, need_level: u8) -> Option<String> {
        if let Term::NamedNode(v) = t {
            return Some(self.iri_text(v));
        }
        if bn_value(t).is_none() || !self.single_ref(t) {
            return None;
        }
        let idxs: Vec<usize> = self.on(t).into_iter().filter(|&i| self.free(i, txn)).collect();
        let wrap = |text: String, level: u8| {
            if level < need_level {
                format!("{K_PAR_OPEN}{text}{K_PAR_CLOSE}")
            } else {
                text
            }
        };
        if idxs.len() == 1 {
            let q = self.all[idxs[0]];
            let p = self.pred(idxs[0]);
            if p == V_ALTPATH {
                txn.insert(idxs[0]);
                let elems = self.read_list(&q.object, txn)?;
                if elems.len() < 2 {
                    return None;
                }
                let mut parts = Vec::new();
                for e in &elems {
                    parts.push(self.path_text(e, txn, 1)?);
                }
                return Some(wrap(parts.join(&format!(" {K_OR} ")), 0));
            }
            if p == V_INVERSE {
                txn.insert(idxs[0]);
                let et = self.path_text(&q.object, txn, 3)?;
                return Some(wrap(format!("{K_INVERSE}{et}"), 2));
            }
            if let Some(m) = rs_map_get(RS_PATHMOD, p) {
                txn.insert(idxs[0]);
                let et = self.path_text(&q.object, txn, 4)?;
                return Some(wrap(format!("{et}{m}"), 3));
            }
            return None;
        }
        // a sequence: the path node IS the list head
        let elems = self.read_list(t, txn)?;
        if elems.len() < 2 {
            return None;
        }
        let mut parts = Vec::new();
        for e in &elems {
            parts.push(self.path_text(e, txn, 2)?);
        }
        Some(wrap(parts.join(K_PATH_SEQ_SEP), 1))
    }

    /* ---- property-shape atoms ---- */
    fn property_atom_text(&self, pred: &str, obj: &Term, txn: &mut Txn) -> Option<String> {
        if pred == V_DATATYPE {
            if let Some(v) = nn_value(obj) {
                if rs_oracle(obj) {
                    return Some(self.iri_text(v)); // oracle discharged by the consumed predicate
                }
            }
        }
        if pred == V_CLASS {
            if let Some(v) = nn_value(obj) {
                if !rs_oracle(obj) {
                    return Some(self.iri_text(v)); // would re-parse as sh:class (oracle misses)
                }
            }
        }
        if pred == V_NODEKIND {
            if let Some(v) = nn_value(obj) {
                if let Some(kw) = rs_map_get(RS_NODEKIND, v) {
                    return Some(kw.to_string());
                }
            }
        }
        if pred == V_NODE {
            if let Some(v) = nn_value(obj) {
                return Some(format!("{K_REF}{}", self.iri_text(v)));
            }
            if bn_value(obj).is_some() && self.single_ref(obj) {
                let mut btxn = txn.clone(); // failed nested bodies must not consume
                if let Some(body) = self.body_text(obj, &mut btxn, 1) {
                    *txn = btxn;
                    return Some(body);
                }
            }
            return None;
        }
        if let Some(kw) = rs_map_get(RS_PROP_PARAM, pred) {
            if let Some(vt) = self.value_text(obj, txn) {
                return Some(format!("{kw}={vt}"));
            }
        }
        None
    }

    fn property_not_text(&self, pred: &str, obj: &Term, txn: &mut Txn) -> Option<String> {
        if pred == V_NOT && bn_value(obj).is_some() && self.single_ref(obj) {
            let idxs: Vec<usize> = self.on(obj).into_iter().filter(|&i| self.free(i, txn)).collect();
            if idxs.len() == 1 {
                let q = self.all[idxs[0]];
                let p = self.pred(idxs[0]).to_string();
                if let Some(inner) = self.property_atom_text(&p, &q.object, txn) {
                    txn.insert(idxs[0]);
                    return Some(format!("{K_NOT} {inner}"));
                }
            }
            return None;
        }
        self.property_atom_text(pred, obj, txn)
    }

    fn chain_elem_text(&self, kind: ChainElem, pred: &str, obj: &Term, txn: &mut Txn) -> Option<String> {
        match kind {
            ChainElem::Prop => self.property_not_text(pred, obj, txn),
            ChainElem::Node => self.node_not_text(pred, obj, txn),
        }
    }

    fn or_chain_text(&self, pred: &str, obj: &Term, txn: &mut Txn, kind: ChainElem) -> Option<String> {
        if pred != V_OR || bn_value(obj).is_none() || !self.single_ref(obj) {
            return None;
        }
        let mut otxn = txn.clone(); // a failed chain must not consume
        let elems = self.read_list(obj, &mut otxn)?;
        if elems.len() < 2 {
            return None;
        }
        let mut parts = Vec::new();
        for e in &elems {
            if bn_value(e).is_none() || !self.single_ref(e) {
                return None;
            }
            let idxs: Vec<usize> = self.on(e).into_iter().filter(|&i| self.free(i, &otxn)).collect();
            if idxs.len() != 1 {
                return None; // each element carries exactly one pair
            }
            let q = self.all[idxs[0]];
            let p = self.pred(idxs[0]).to_string();
            let t = self.chain_elem_text(kind, &p, &q.object, &mut otxn)?;
            otxn.insert(idxs[0]);
            parts.push(t);
        }
        *txn = otxn;
        Some(parts.join(&format!(" {K_OR} ")))
    }

    fn property_or_text(&self, pred: &str, obj: &Term, txn: &mut Txn) -> Option<String> {
        if let Some(or) = self.or_chain_text(pred, obj, txn, ChainElem::Prop) {
            return Some(or);
        }
        self.property_not_text(pred, obj, txn)
    }

    /* ---- node-level constraints ---- */
    fn node_value_text(&self, pred: &str, obj: &Term, txn: &mut Txn) -> Option<String> {
        let kw = rs_map_get(RS_NODE_PARAM, pred)?;
        let vt = self.value_text(obj, txn)?;
        Some(format!("{kw}={vt}"))
    }

    fn node_not_text(&self, pred: &str, obj: &Term, txn: &mut Txn) -> Option<String> {
        if pred == V_NOT && bn_value(obj).is_some() && self.single_ref(obj) {
            let idxs: Vec<usize> = self.on(obj).into_iter().filter(|&i| self.free(i, txn)).collect();
            if idxs.len() == 1 {
                let q = self.all[idxs[0]];
                let p = self.pred(idxs[0]).to_string();
                if let Some(inner) = self.node_value_text(&p, &q.object, txn) {
                    txn.insert(idxs[0]);
                    return Some(format!("{K_NOT} {inner}"));
                }
            }
            return None;
        }
        self.node_value_text(pred, obj, txn)
    }

    fn node_or_text(&self, pred: &str, obj: &Term, txn: &mut Txn) -> Option<String> {
        if let Some(or) = self.or_chain_text(pred, obj, txn, ChainElem::Node) {
            return Some(or);
        }
        self.node_not_text(pred, obj, txn)
    }

    /* ---- extended-layer object language ---- */
    fn ext_object_text(&self, t: &Term, txn: &mut Txn) -> Option<String> {
        match t {
            Term::NamedNode(v) => return Some(self.iri_text(v)),
            Term::Literal(l) => return self.lit_text(l),
            Term::Triple(q) => return self.tt_text(q),
            Term::BlankNode(_) => {}
        }
        if !self.single_ref(t) {
            return None;
        }
        // prefer the collection form when the blank is a proper list
        let mut ltxn = txn.clone();
        if let Some(elems) = self.read_list(t, &mut ltxn) {
            let mut parts = Vec::new();
            let mut ok = true;
            for e in &elems {
                match self.ext_object_text(e, &mut ltxn) {
                    Some(et) => parts.push(et),
                    None => {
                        ok = false;
                        break;
                    }
                }
            }
            if ok {
                *txn = ltxn;
                return Some(if elems.is_empty() {
                    format!("{K_LIST_OPEN}{K_LIST_CLOSE}")
                } else {
                    format!("{K_LIST_OPEN} {} {K_LIST_CLOSE}", parts.join(" "))
                });
            }
        }
        // bnSection: every triple on the blank must be expressible
        let idxs: Vec<usize> = self.on(t).into_iter().filter(|&i| self.free(i, txn)).collect();
        if idxs.is_empty() {
            return None;
        }
        let groups = self.ext_predicate_groups(t, txn)?;
        Some(format!("{K_BN_OPEN} {} {K_BN_CLOSE}", groups.join(&format!(" {K_ANN_SEP} "))))
    }

    /// Group ALL free triples of a subject as 'p o1, o2' entries; None if
    /// any object is inexpressible (all-or-nothing, so blanks never dangle).
    fn ext_predicate_groups(&self, subj: &Term, txn: &mut Txn) -> Option<Vec<String>> {
        let idxs: Vec<usize> = self.on(subj).into_iter().filter(|&i| self.free(i, txn)).collect();
        let mut by_pred: Vec<(String, Vec<usize>)> = Vec::new();
        for i in idxs {
            let p = nn_value(&self.all[i].predicate)?.to_string();
            match by_pred.iter_mut().find(|(k, _)| *k == p) {
                Some((_, v)) => v.push(i),
                None => by_pred.push((p, vec![i])),
            }
        }
        let mut groups = Vec::new();
        for (p, list) in &by_pred {
            let mut objs = Vec::new();
            for &i in list {
                let ot = self.ext_object_text(&self.all[i].object, txn)?;
                txn.insert(i);
                objs.push(ot);
            }
            groups.push(format!("{} {}", self.iri_text(p), objs.join(&format!("{K_OBJ_SEP} "))));
        }
        Some(groups)
    }

    /* ---- nested shape bodies: all-or-nothing constraint printing ---- */
    fn body_text(&self, n: &Term, txn: &mut Txn, depth: usize) -> Option<String> {
        let pad = "  ".repeat(depth + 1);
        let lines = self.constraint_lines(n, txn, depth + 1);
        if self.on(n).into_iter().any(|i| self.free(i, txn)) {
            return None; // leftovers: the nested body cannot absorb them
        }
        if lines.is_empty() {
            return Some(format!("{K_BODY_OPEN}{K_BODY_CLOSE}"));
        }
        let body: Vec<String> = lines.iter().map(|l| format!("{pad}{l}")).collect();
        Some(format!("{K_BODY_OPEN}\\n{}\\n{}{K_BODY_CLOSE}", body.join("\\n"), "  ".repeat(depth)))
    }

    /// The constraints of a focus node: property shapes + node-level params.
    /// Consumes what it can (into txn); inexpressible triples stay free for
    /// the caller (top level: annotation fallback or residual; nested:
    /// refusal).
    fn constraint_lines(&self, n: &Term, txn: &mut Txn, depth: usize) -> Vec<String> {
        let mut lines = Vec::new();
        // property shapes
        for i in self.on(n) {
            if !self.free(i, txn) {
                continue;
            }
            let q = self.all[i];
            if self.pred(i) != V_PROPERTY {
                continue;
            }
            if bn_value(&q.object).is_none() || !self.single_ref(&q.object) {
                continue;
            }
            if let Some(t) = self.property_shape_text(&q.object, txn, depth) {
                txn.insert(i);
                lines.push(format!("{t} {K_DOT}"));
            }
        }
        // node-level or / not / params
        for i in self.on(n) {
            if !self.free(i, txn) {
                continue;
            }
            let q = self.all[i];
            let mut sub = txn.clone();
            let p = self.pred(i).to_string();
            if let Some(t) = self.node_or_text(&p, &q.object, &mut sub) {
                sub.insert(i);
                *txn = sub;
                lines.push(format!("{t} {K_DOT}"));
            }
        }
        lines
    }

    fn property_shape_text(&self, ps: &Term, txn: &mut Txn, depth: usize) -> Option<String> {
        let mut sub = txn.clone();
        // path is the gate: no path, no property shape
        let mut path_idx = usize::MAX;
        for i in self.on(ps) {
            if self.free(i, &sub) && self.pred(i) == V_PATH {
                path_idx = i;
                break;
            }
        }
        if path_idx == usize::MAX {
            return None;
        }
        sub.insert(path_idx);
        let pt = self.path_text(&self.all[path_idx].object, &mut sub, 0)?;
        let mut parts = vec![pt];
        // counts: one min (guard-invertible) + one max, defaults from print {}
        let mut mn: Option<String> = None;
        let mut mx: Option<String> = None;
        for i in self.on(ps) {
            if !self.free(i, &sub) {
                continue;
            }
            let q = self.all[i];
            let is_int = match &q.object {
                Term::Literal(l) => {
                    nn_value(&l.datatype) == Some(V_XSD_INTEGER)
                        && l.language.is_empty()
                        && fm_${M.intToken}(&l.value)
                }
                _ => false,
            };
            let lex = match &q.object {
                Term::Literal(l) => l.value.to_string(),
                _ => String::new(),
            };
            if self.pred(i) == V_MINCOUNT && mn.is_none() && is_int {
                // parse-side when-guard: a bound it would suppress cannot
                // round-trip (saturate on overflow, matching the parser).
                if RS_MIN_GUARDED && lex.parse::<i128>().unwrap_or(i128::MAX) <= 0 {
                    continue;
                }
                mn = Some(lex);
                sub.insert(i);
            } else if self.pred(i) == V_MAXCOUNT && mx.is_none() && is_int {
                mx = Some(lex);
                sub.insert(i);
            }
        }
        if mn.is_some() || mx.is_some() {
            parts.push(format!(
                "{K_CNT_OPEN}{}{K_CNT_DOTS}{}{K_CNT_CLOSE}",
                mn.as_deref().unwrap_or(K_MIN_DEFAULT),
                mx.as_deref().unwrap_or(K_MAX_DEFAULT)
            ));
        }
        // atoms
        for i in self.on(ps) {
            if !self.free(i, &sub) {
                continue;
            }
            let q = self.all[i];
            let mut atxn = sub.clone();
            let p = self.pred(i).to_string();
            if let Some(t) = self.property_or_text(&p, &q.object, &mut atxn) {
                atxn.insert(i);
                sub = atxn;
                parts.push(t);
            }
        }
        // '% ... %' escape (extended): the declared guard-free fallback
        if RS_EXT_PC && self.on(ps).into_iter().any(|i| self.free(i, &sub)) {
            let mut ptxn = sub.clone();
            if let Some(groups) = self.ext_predicate_groups(ps, &mut ptxn) {
                sub = ptxn;
                parts.push(format!("{K_PC_OPEN} {} {K_PC_CLOSE}", groups.join(&format!(" {K_ANN_SEP} "))));
            }
        }
        let _ = depth;
        *txn = sub;
        Some(parts.join(" "))
    }
}

/// Print a triple list as a SHACL-CS document, reporting the residual.
///
/// The document IRI is READ OFF the graph (the first IRI typed
/// \`owl:Ontology\`); \`base_iri\` is only a preference among candidates.
/// \`prefixes\` (label, iri) pairs come from a [\`ParseOutcome\`] or the
/// caller; predeclared prefixes are implicit and unlexable labels are
/// unusable (skipped), exactly as in parse mode.
pub fn print_with_residual(
    triples: &[Triple],
    base_iri: Option<&str>,
    prefixes: &[(String, String)],
) -> ResidualPrint {
    /* ---- residual load: set semantics ---- */
    let mut all: Vec<&Triple> = Vec::new();
    let mut seen = HashSet::new();
    for q in triples {
        let k = format!(
            "{} {} {}",
            rs_term_key(&q.subject),
            rs_term_key(&q.predicate),
            rs_term_key(&q.object)
        );
        if seen.insert(k) {
            all.push(q);
        }
    }
    let mut by_subj: Vec<(String, Vec<usize>)> = Vec::new();
    let mut b_ref: Vec<(String, usize)> = Vec::new();
    for (i, q) in all.iter().enumerate() {
        let sk = rs_term_key(&q.subject);
        match by_subj.iter_mut().find(|(k, _)| *k == sk) {
            Some((_, v)) => v.push(i),
            None => by_subj.push((sk, vec![i])),
        }
        if let Term::BlankNode(l) = &q.object {
            match b_ref.iter_mut().find(|(k, _)| k.as_str() == l.as_ref()) {
                Some((_, c)) => *c += 1,
                None => b_ref.push((l.to_string(), 1)),
            }
        }
    }

    /* ---- prefixes: effective map = predeclared overridden by caller ---- */
    let mut eff: Vec<(String, String)> = RS_PREDECLARED
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    let mut declared: Vec<(String, String)> = Vec::new();
    for (label, iri) in prefixes {
        if !label.is_empty() && !fm_PN_PREFIX(label) {
            continue; // unlexable label: unusable
        }
        if eff.iter().any(|(k, v)| k == label && v == iri) {
            continue; // predeclared (or repeated): implicit
        }
        match eff.iter_mut().find(|(k, _)| k == label) {
            Some((_, v)) => *v = iri.clone(),
            None => eff.push((label.clone(), iri.clone())),
        }
        declared.push((label.clone(), iri.clone()));
    }
    let mut prefix_list = eff;
    prefix_list.sort_by_key(|e| std::cmp::Reverse(e.1.len())); // stable: ties keep insertion order

    let n_all = all.len();
    let mut p = RPrinter { all, used: vec![false; n_all], by_subj, b_ref, prefix_list };

    let mut out: Vec<String> = Vec::new();

    // BASE + the document-ontology clause (emitted by the document rule at
    // EOF: a faithful print REQUIRES a matching triple — absence is a
    // verdict).
    let opt_base: Option<String> = base_iri.map(|b| rs_strip_fragment(b).to_string());
    let mut onto_idx = usize::MAX;
    for i in 0..p.all.len() {
        let q = p.all[i];
        if !p.used[i]
            && p.pred(i) == V_RDF_TYPE
            && nn_value(&q.object) == Some(V_ONTOLOGY)
            && nn_value(&q.subject).is_some()
        {
            if onto_idx == usize::MAX {
                onto_idx = i;
            }
            if let Some(ob) = &opt_base {
                if nn_value(&q.subject) == Some(ob.as_str()) {
                    onto_idx = i;
                    break;
                }
            }
        }
    }
    if onto_idx == usize::MAX {
        let residual: Vec<Triple> = p.all.iter().map(|q| (*q).clone()).collect();
        return ResidualPrint {
            text: None,
            residual,
            missing: Some(MissingOntology { subject: opt_base }),
        };
    }
    let base = nn_value(&p.all[onto_idx].subject).unwrap_or("").to_string();
    p.used[onto_idx] = true;
    out.push(format!("{K_BASE} <{}>", esc_iri(&base)));

    // IMPORTS: subject is the (single, printed) base
    for i in 0..p.all.len() {
        let q = p.all[i];
        if !p.used[i]
            && p.pred(i) == V_IMPORTS
            && nn_value(&q.subject) == Some(base.as_str())
        {
            if let Some(o) = nn_value(&q.object) {
                p.used[i] = true;
                out.push(format!("{K_IMPORTS} <{}>", esc_iri(o)));
            }
        }
    }

    for (label, iri) in &declared {
        out.push(format!("{K_PREFIX} {label}: <{}>", esc_iri(iri)));
    }
    out.push(String::new());

    // shapes, in input order of their typing triples
    for i in 0..p.all.len() {
        if p.used[i] {
            continue;
        }
        let q = p.all[i];
        if p.pred(i) != V_RDF_TYPE || nn_value(&q.object) != Some(V_NODESHAPE) {
            continue;
        }
        let Some(shape_iri) = nn_value(&q.subject).map(str::to_string) else {
            continue;
        };
        p.used[i] = true;
        let n = q.subject.clone();
        let mut txn: Txn = Txn::new();
        // shapeClass? (consumes the rdfs:Class typing too)
        let mut is_class = false;
        for j in p.on(&n) {
            if p.free(j, &txn)
                && p.pred(j) == V_RDF_TYPE
                && nn_value(&p.all[j].object) == Some(V_RDFS_CLASS)
            {
                is_class = true;
                txn.insert(j);
                break;
            }
        }
        let mut header = format!(
            "{} {}",
            if is_class { K_SHAPECLASS } else { K_SHAPE },
            p.iri_text(&shape_iri)
        );
        // '->' target classes (the grammar puts targetClass on 'shape' only)
        if !is_class {
            let mut targets = Vec::new();
            for j in p.on(&n) {
                if p.free(j, &txn) && p.pred(j) == V_TARGETCLASS {
                    if let Some(o) = nn_value(&p.all[j].object) {
                        txn.insert(j);
                        targets.push(p.iri_text(o));
                    }
                }
            }
            if !targets.is_empty() {
                header.push_str(&format!(" {K_ARROW} {}", targets.join(" ")));
            }
        }
        let lines = p.constraint_lines(&n, &mut txn, 1);
        // extended: turtle-style annotations absorb whatever is left on n
        if RS_EXT_ANNOTATION && p.on(&n).into_iter().any(|j| p.free(j, &txn)) {
            let mut atxn = txn.clone();
            if let Some(groups) = p.ext_predicate_groups(&n, &mut atxn) {
                txn = atxn;
                header.push_str(&format!(" {K_ANN_SEP} {}", groups.join(&format!(" {K_ANN_SEP} "))));
            }
        }
        for k in txn {
            p.used[k] = true;
        }
        if lines.is_empty() {
            out.push(format!("{header} {K_BODY_OPEN}{K_BODY_CLOSE}"));
        } else {
            let body: Vec<String> = lines.iter().map(|l| format!("  {l}")).collect();
            out.push(format!("{header} {K_BODY_OPEN}\\n{}\\n{K_BODY_CLOSE}", body.join("\\n")));
        }
    }

    // extended: trailing turtle statements absorb leftover IRI-subject triples
    if RS_EXT_TTL {
        let mut subjects: Vec<Term> = Vec::new();
        let mut seen_subj = HashSet::new();
        for i in 0..p.all.len() {
            if p.used[i] {
                continue;
            }
            if let Some(s) = nn_value(&p.all[i].subject) {
                if seen_subj.insert(s.to_string()) {
                    subjects.push(p.all[i].subject.clone());
                }
            }
        }
        for s in subjects {
            let mut txn: Txn = Txn::new();
            if let Some(groups) = p.ext_predicate_groups(&s, &mut txn) {
                if !groups.is_empty() {
                    for k in txn {
                        p.used[k] = true;
                    }
                    let sv = nn_value(&s).unwrap_or("");
                    out.push(format!(
                        "{} {} {K_DOT}",
                        p.iri_text(sv),
                        groups.join(&format!(" {K_ANN_SEP} "))
                    ));
                }
            }
        }
    }

    let mut residual = Vec::new();
    for i in 0..p.all.len() {
        if !p.used[i] {
            residual.push(p.all[i].clone());
        }
    }
    ResidualPrint { text: Some(out.join("\\n") + "\\n"), residual, missing: None }
}

/// Total print or verdict: returns the document, or the
/// [\`ResidualError\`] carrying the unconsumed triples (the graph is not
/// expressible in this grammar/profile).
pub fn write_triples(
    triples: &[Triple],
    base_iri: Option<&str>,
    prefixes: &[(String, String)],
) -> Result<String, ResidualError> {
    let r = print_with_residual(triples, base_iri, prefixes);
    if let Some(missing) = r.missing {
        return Err(ResidualError {
            message: format!(
                "${g.name}: not printable — the document clause re-emits <{}> rdf:type owl:Ontology, which the graph does not contain",
                missing.subject.as_deref().unwrap_or("?")
            ),
            residual: r.residual,
            missing: Some(missing),
        });
    }
    if !r.residual.is_empty() {
        return Err(ResidualError {
            message: format!(
                "${g.name}: graph is not compact-expressible in this profile — {} residual triple(s)",
                r.residual.len()
            ),
            residual: r.residual,
            missing: None,
        });
    }
    Ok(r.text.unwrap_or_default())
}
`;

  // the oracle guard: reuse the parser's or_<name> free function
  const oracleGlue = `
fn rs_oracle(t: &Term) -> bool {
    or_${M.oracleName}(t)
}
`;
  return { code: oracleGlue + code };
}
