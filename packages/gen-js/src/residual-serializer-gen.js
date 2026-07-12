/**
 * residual-serializer-gen.js — the residual-consumption print mode
 * (spec/SHUTTLE.md §8) for the SHACL-CS grammar family (`profile shaclc`).
 *
 * Printing starts with the whole graph as a residual multiset (set
 * semantics; duplicates collapse) and each printed construct CONSUMES the
 * quads it re-emits on parse. Print succeeds iff the residual empties;
 * a non-empty residual is the *verdict* "this graph is not
 * SHACL-CS-expressible", reported quad-by-quad (law L3's SHACL-C reading).
 * The three showpieces of examples/shacl-compact.md are implemented:
 *
 *  - the oracle never runs backward: the consumed quad's PREDICATE
 *    discharges it (an sh:datatype quad prints as a bare IRI only when the
 *    IRI is in the declared registry; sh:class xsd:string can never
 *    mis-print as a bare IRI that would re-parse as sh:datatype);
 *  - conditional-emit inversion: the production's `print { … ?? d }`
 *    defaults regenerate suppressed bounds ([0..1] from a lone
 *    sh:maxCount), and a quad that would NOT re-emit under the parse-side
 *    `when` guard (sh:minCount 0) is refused — it goes to the residual
 *    instead of silently round-trip-drifting;
 *  - partiality as a feature: in the extended profile the turtle
 *    annotation / '% … %' / trailing-statement layers are the declared
 *    guard-free fallbacks; in strict builds those alternatives do not
 *    exist, so the same graphs yield a residual verdict by construction.
 *
 * HONEST DERIVATION NOTE (v0.1 backend). Everything the grammar STATES is
 * extracted from its AST — keyword↔IRI tables (paramName / targetName /
 * nodeKindName / pathMod), the @oracle registry, every emitted predicate
 * and class (sh:property, sh:path, sh:or, sh:not, rdf list vocabulary,
 * owl:Ontology, …), the `print {}` inversion defaults, punctuation
 * literals, numeric/boolean token↔datatype pairs, token-derived
 * full-match guards and PN_LOCAL escaping, the predeclared prefixes, and
 * the @profile-filtered presence of each extended alternative (a strict
 *  build simply has no fallback layer). The CONTROL SKELETON — which
 * production consumes which quads in which order — is the backend's
 * built-in print-mode reading of these production shapes, not yet a
 * generic inversion of arbitrary clause bodies; extraction fails loudly
 * if the grammar drifts from the shapes it reads.
 */

import {
  derivePnLocalCode,
  deriveNumericCases,
  deriveBooleanInfo,
} from './serializer-gen.js';
import { curieIriOf } from './clausec.js';

/* =================================================================
 * Grammar-AST extraction helpers
 * ================================================================= */

function need(g, name) {
  const p = g.prodByName.get(name);
  if (!p) throw new Error(`residual serializer: production '${name}' missing`);
  return p;
}

/** All sem clauses in a production, deep (groups + threads). */
function allClauses(prod) {
  const out = [];
  const walkItems = (items) => {
    for (const it of items) {
      if (it.kind === 'sem') { out.push(...it.clauses); continue; }
      if (it.kind === 'thread') { for (const a of it.body) walkItems(a.items); continue; }
      if (it.prim && it.prim.kind === 'group') for (const a of it.prim.alts) walkItems(a.items);
    }
  };
  for (const a of prod.alts) walkItems(a.items);
  return out;
}

/** All literal texts in a production, deep, in order. */
function allLits(prod) {
  const out = [];
  const walkItems = (items) => {
    for (const it of items) {
      if (it.kind === 'sem') continue;
      if (it.kind === 'thread') { for (const a of it.body) walkItems(a.items); continue; }
      if (it.prim.kind === 'lit') out.push(it.prim.text);
      if (it.prim.kind === 'group') for (const a of it.prim.alts) walkItems(a.items);
    }
  };
  for (const a of prod.alts) walkItems(a.items);
  return out;
}

/** First literal of a production (its leading keyword). */
function firstLit(prod) {
  const l = allLits(prod);
  if (l.length === 0) throw new Error(`residual serializer: production '${prod.name}' has no literal`);
  return l[0];
}

/**
 * keyword -> IRI map from a `'kw' { value = curie }` alternation
 * (targetName / paramName / nodeKindName / pathMod shape).
 */
function kwValueMap(gen, prod) {
  const out = [];
  for (const a of prod.alts) {
    const lit = a.items.find((i) => i.kind === 'factor' && i.prim.kind === 'lit');
    const sem = a.items.find((i) => i.kind === 'sem');
    if (!lit || !sem) continue;
    const v = sem.clauses.find((c) => c.k === 'value');
    if (v && (v.expr.k === 'curie' || v.expr.k === 'iri')) out.push([curieIriOf(gen, v.expr), lit.prim.text]);
  }
  if (out.length === 0) throw new Error(`residual serializer: '${prod.name}' yielded no keyword/value pairs`);
  return out;
}

/** IRI of the predicate curie of the n-th emit clause of a production. */
function emitPred(gen, prod, n = 0) {
  const emits = allClauses(prod).filter((c) => c.k === 'emit');
  if (!emits[n]) throw new Error(`residual serializer: '${prod.name}' emit #${n} missing`);
  return curieIriOf(gen, emits[n].p);
}

function emitObj(gen, prod, n = 0) {
  const emits = allClauses(prod).filter((c) => c.k === 'emit');
  if (!emits[n]) throw new Error(`residual serializer: '${prod.name}' emit #${n} missing`);
  return curieIriOf(gen, emits[n].o);
}

/** The curie in the first slot of a tuple `value = (curie, x)` clause. */
function tupleCurie(gen, clause) {
  if (clause.k !== 'value' || clause.expr.k !== 'tuple') throw new Error('residual serializer: expected tuple value clause');
  return curieIriOf(gen, clause.expr.items[0]);
}

/* =================================================================
 * Generator
 * ================================================================= */

/**
 * Extract the BACKEND-AGNOSTIC print model (vocabulary, keyword tables,
 * oracle registry, print{} inversion defaults, profile-gated layer flags,
 * numeric/boolean lexical data, full-match token list) from the grammar
 * AST. Shared by the JS and Rust residual-serializer backends.
 */
export function extractShaclcPrintModel(g, gen) {
  /* ---- vocabulary and punctuation, extracted from the grammar ---- */

  const rdfType = emitPred(gen, need(g, 'shaclcDoc'));
  const ontology = emitObj(gen, need(g, 'shaclcDoc'));
  const imports = emitPred(gen, need(g, 'importsDecl'));
  const kwBase = firstLit(need(g, 'baseDecl'));
  const kwImports = firstLit(need(g, 'importsDecl'));
  const kwPrefix = firstLit(need(g, 'prefixDecl'));

  const nodeShapeProd = need(g, 'nodeShape');
  const kwShape = firstLit(nodeShapeProd);
  const nodeShapeCls = emitObj(gen, nodeShapeProd, 0);
  const shapeClassProd = need(g, 'shapeClass');
  const kwShapeClass = firstLit(shapeClassProd);
  const rdfsClass = emitObj(gen, shapeClassProd, 1);
  const targetClassProd = need(g, 'targetClass');
  const kwArrow = firstLit(targetClassProd);
  const targetClass = emitPred(gen, targetClassProd);

  const propShapeProd = need(g, 'propertyShape');
  const shProperty = emitPred(gen, propShapeProd, 0);
  const shPath = emitPred(gen, propShapeProd, 1);

  // propertyCount: '[' mn '..' mx ']', min/max predicates, xsd:integer,
  // and the print-directive inversion defaults.
  const pcProd = need(g, 'propertyCount');
  const pcLits = allLits(pcProd);
  if (pcLits.length < 3) throw new Error('residual serializer: propertyCount punctuation missing');
  const [cntOpen, cntDots, cntClose] = pcLits;
  const pcEmits = allClauses(pcProd).filter((c) => c.k === 'emit');
  const shMinCount = curieIriOf(gen, pcEmits[0].p);
  const shMaxCount = curieIriOf(gen, pcEmits[1].p);
  const litCall = pcEmits[0].o;
  if (litCall.k !== 'call' || litCall.fn !== 'literal') throw new Error('residual serializer: propertyCount literal() shape missing');
  const xsdInteger = curieIriOf(gen, litCall.args[1]);
  // the parse-side when-guard on min (`int(mn) > 0`): its presence means a
  // stored bound violating it will not re-emit; refuse such quads.
  const minGuarded = pcEmits[0].when !== null;
  if (!pcProd.printDirective) throw new Error('residual serializer: propertyCount print {} directive missing');
  const defaults = {};
  const dre = /(\w+)\s*=\s*lookup\(\s*\w+\s*,\s*([\w]+:[\w]+)\s*\)\s*\?\?\s*([^\s;}]+)/g;
  let dm;
  while ((dm = dre.exec(pcProd.printDirective)) !== null) {
    const [pfx, local] = dm[2].split(':');
    defaults[curieIriOf(gen, { k: 'curie', prefix: pfx, local })] = dm[3];
  }
  const minDefault = defaults[shMinCount];
  const maxDefault = defaults[shMaxCount];
  if (minDefault === undefined || maxDefault === undefined) {
    throw new Error('residual serializer: propertyCount print {} defaults not recognized');
  }

  // or / not / list vocabulary
  const orSep = firstLit(need(g, 'nodeOrTail'));
  const shOr = allClauses(need(g, 'nodeOrEmit')).filter((c) => c.k === 'emit')
    .map((c) => c.p).filter((p) => p.k === 'curie').map((p) => curieIriOf(gen, p))[0];
  if (!shOr) throw new Error('residual serializer: sh:or predicate not found in nodeOrEmit');
  const notProd = need(g, 'nodeNot');
  const kwNot = allLits(notProd)[0];
  const shNot = tupleCurie(gen, allClauses(notProd).filter((c) => c.k === 'value')
    .find((c) => c.expr.k === 'tuple' && c.expr.items[0].k === 'curie'));
  const tailEmits = allClauses(need(g, 'propOrTail')).filter((c) => c.k === 'emit')
    .filter((c) => c.p.k === 'curie'); // fst(first)-predicated emits are pair-dynamic
  const rdfFirst = tailEmits.map((c) => curieIriOf(gen, c.p)).find((p) => p.endsWith('#first'));
  const rdfRest = tailEmits.map((c) => curieIriOf(gen, c.p)).find((p) => p.endsWith('#rest'));
  const rdfNil = tailEmits.filter((c) => c.o.k === 'curie').map((c) => curieIriOf(gen, c.o)).find((o) => o.endsWith('#nil'));
  if (!rdfFirst || !rdfRest || !rdfNil) throw new Error('residual serializer: rdf list vocabulary not found in propOrTail');

  // paths
  const shAltPath = allClauses(need(g, 'pathAltTail')).filter((c) => c.k === 'emit' && c.p.k === 'curie')
    .map((c) => curieIriOf(gen, c.p)).find((p) => !p.endsWith('#first') && !p.endsWith('#rest'));
  const pathSeqSep = firstLit(need(g, 'pathSeqTail'));
  const invProd = need(g, 'pathEltOrInverse');
  const kwInverse = allLits(invProd)[0];
  const shInverse = emitPred(gen, invProd, 0);
  const pathMods = kwValueMap(gen, need(g, 'pathMod'));
  const ppLits = allLits(need(g, 'pathPrimary'));
  const [parOpen, parClose] = ppLits;
  if (!shAltPath || !parOpen || !parClose) throw new Error('residual serializer: path vocabulary incomplete');

  // atoms: oracle branches + sh:node + param/nodekind keyword tables
  const atomProd = need(g, 'propertyAtom');
  const oracleClause = allClauses(atomProd).find((c) => c.k === 'oracle');
  if (!oracleClause || !oracleClause.els) throw new Error('residual serializer: propertyAtom oracle clause missing');
  const shDatatype = tupleCurie(gen, oracleClause.then);
  const shClass = tupleCurie(gen, oracleClause.els);
  const oracleName = oracleClause.name;
  if (!g.oracles.some((o) => o.name === oracleName)) throw new Error(`residual serializer: oracle '${oracleName}' undeclared`);
  // per-alternative pair predicates: the alt whose factor calls shapeRef /
  // nodeShapeBody carries (sh:node, _); the nodeKindName alt (sh:nodeKind, _)
  let shNode = null;
  let shNodeKindPred = null;
  for (const a of atomProd.alts) {
    const call = a.items.find((i) => i.kind === 'factor' && i.prim.kind === 'call');
    const sem = a.items.find((i) => i.kind === 'sem');
    const v = sem && sem.clauses.find((c) => c.k === 'value'
      && c.expr.k === 'tuple' && c.expr.items[0].k === 'curie');
    if (!call || !v) continue;
    if (call.prim.name === 'shapeRef' || call.prim.name === 'nodeShapeBody') shNode = curieIriOf(gen, v.expr.items[0]);
    if (call.prim.name === 'nodeKindName') shNodeKindPred = curieIriOf(gen, v.expr.items[0]);
  }
  if (!shNode || !shNodeKindPred) throw new Error('residual serializer: sh:node / sh:nodeKind pairs not found in propertyAtom');
  const nodeKindMap = kwValueMap(gen, need(g, 'nodeKindName'));
  const propParamMap = kwValueMap(gen, need(g, 'paramName'));
  // nodeParamName is a union of production references: derive its map as
  // the union of the referenced productions' keyword tables.
  const nodeParamMap = [];
  for (const a of need(g, 'nodeParamName').alts) {
    const call = a.items.find((i) => i.kind === 'factor' && i.prim.kind === 'call');
    if (call) nodeParamMap.push(...kwValueMap(gen, need(g, call.prim.name)));
  }
  if (nodeParamMap.length === 0) throw new Error('residual serializer: nodeParamName union empty');
  const kwRef = firstLit(need(g, 'shapeRef'));

  // bodies / statements / arrays
  const [bodyOpen, bodyClose] = allLits(need(g, 'nodeShapeBody'));
  const stmtDot = allLits(need(g, 'constraint')).find((t) => t === '.') || '.';
  const arrLits = allLits(need(g, 'iriOrLiteralOrArray'));
  const arrOpen = arrLits[0];
  const arrClose = arrLits[arrLits.length - 1];
  // the empty-array shape: `emit h rdf:rest rdf:nil when b == none`
  const emptyArrayEmit = allClauses(need(g, 'iriOrLiteralOrArray')).some((c) => c.k === 'emit');

  // triple terms (rdf12 layer; absent if the profile carved it out)
  const ttProd = g.prodByName.get('tripleTerm');
  const hasTT = !!ttProd && ttProd.alts.length > 0
    && need(g, 'iriOrLiteral').alts.some((a) => a.items.some((i) => i.kind === 'factor' && i.prim.kind === 'call' && i.prim.name === 'tripleTerm'));
  let ttOpen = null;
  let ttClose = null;
  if (hasTT) {
    const lits = allLits(ttProd);
    ttOpen = lits[0];
    ttClose = lits[lits.length - 1];
  }

  // RDFLiteral punctuation ('^^')
  const dtSep = allLits(need(g, 'RDFLiteral')).find((t) => t.includes('^')) || '^^';

  // extended layer: present iff the @profile-labelled alternatives survived
  const extAnnotation = need(g, 'shapeBodyTail').alts
    .some((a) => a.items.some((i) => i.kind === 'factor' && i.prim.kind === 'call' && i.prim.name === 'annotation'));
  const pcSectionProd = g.prodByName.get('pcSection');
  const extPc = !!pcSectionProd && pcSectionProd.alts.length > 0;
  const ttlStatementProd = g.prodByName.get('ttlStatement');
  const extTtl = !!ttlStatementProd && ttlStatementProd.alts.length > 0;
  const annSep = firstLit(need(g, 'annotation'));
  const olSepItem = need(g, 'objectList').alts[0].items.find((i) => i.kind === 'factor' && i.postfix === 'sepList');
  const objSep = olSepItem ? olSepItem.sep : ',';
  let pcOpen = '%';
  let pcClose = '%';
  if (extPc) {
    const lits = allLits(pcSectionProd);
    pcOpen = lits[0];
    pcClose = lits[lits.length - 1];
  }
  const [bnOpen, , bnClose] = extTtl ? allLits(need(g, 'bnSection')) : ['[', ';', ']'];
  const [listOpen, listClose] = extTtl ? allLits(need(g, 'ttlList')) : ['(', ')'];

  // predeclared prefixes from the env block
  const prefEnv = g.env.find((e) => e.name === 'prefixes');
  const predeclared = prefEnv && prefEnv.init && prefEnv.init.k === 'mapLit' ? prefEnv.init.entries : [];

  // boolean / numeric lexical guards (token-derived) + PN escaping
  const numCases = deriveNumericCases(g, gen);
  const boolInfo = deriveBooleanInfo(g, gen);
  const intToken = (() => {
    const tokItem = pcProd.alts[0].items.find((i) => i.kind === 'factor' && i.prim.kind === 'token');
    if (!tokItem) throw new Error('residual serializer: propertyCount INTEGER token missing');
    return tokItem.prim.name;
  })();
  const fmTokens = [...new Set([intToken, ...numCases.map((c) => c.token), 'PN_PREFIX', 'LANG_DIR'])]
    .filter((t) => g.tokenByName.has(t));

  const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
  const RDF_LANGSTR = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString';
  const RDF_DIRLANGSTR = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#dirLangString';

  const V = {
    rdfType,
    ontology,
    imports,
    nodeShapeCls,
    rdfsClass,
    targetClass,
    shProperty,
    shPath,
    shMinCount,
    shMaxCount,
    shOr,
    shNot,
    shNode,
    shDatatype,
    shClass,
    shNodeKind: shNodeKindPred,
    rdfFirst,
    rdfRest,
    rdfNil,
    shAltPath,
    shInverse,
    xsdInteger,
    xsdString: XSD_STRING,
    langString: RDF_LANGSTR,
    dirLangString: RDF_DIRLANGSTR,
  };
  const KW = {
    base: kwBase,
    imports: kwImports,
    prefix: kwPrefix,
    shape: kwShape,
    shapeClass: kwShapeClass,
    arrow: kwArrow,
    not: kwNot,
    or: orSep,
    ref: kwRef,
    dot: stmtDot,
    bodyOpen,
    bodyClose,
    cntOpen,
    cntDots,
    cntClose,
    arrOpen,
    arrClose,
    parOpen,
    parClose,
    pathSeqSep,
    inverse: kwInverse,
    dtSep,
    ttOpen,
    ttClose,
    annSep,
    objSep,
    pcOpen,
    pcClose,
    bnOpen,
    bnClose,
    listOpen,
    listClose,
    minDefault,
    maxDefault,
  };

  return {
    V,
    KW,
    nodeParamMap,
    propParamMap,
    nodeKindMap,
    pathMods,
    predeclared,
    ext: { annotation: extAnnotation, pc: extPc, ttl: extTtl },
    minGuarded,
    hasTT,
    emptyArrayEmit,
    oracleName,
    intToken,
    numCases,
    boolInfo,
    fmTokens,
  };
}

export function genResidualSerializer(g, an, makeStandaloneMatchers, gen) {
  const M = extractShaclcPrintModel(g, gen);
  const { V, KW, oracleName, intToken, numCases, boolInfo } = M;
  const nodeParamMap = M.nodeParamMap;
  const propParamMap = M.propParamMap;
  const nodeKindMap = M.nodeKindMap;
  const pathMods = M.pathMods;
  const predeclared = M.predeclared;
  const extAnnotation = M.ext.annotation;
  const extPc = M.ext.pc;
  const extTtl = M.ext.ttl;
  const minGuarded = M.minGuarded;
  const hasTT = M.hasTT;
  const emptyArrayEmit = M.emptyArrayEmit;
  const fmCode = makeStandaloneMatchers(M.fmTokens);
  const pnLocalCode = derivePnLocalCode(g);

  const numGuardCode = numCases.map((c) =>
    `  if (dtv === ${JSON.stringify(c.dt)} && fm_${c.token}(v)) return v;`).join('\n');
  const boolGuardCode = boolInfo
    ? `  if (dtv === ${JSON.stringify(boolInfo.dt)} && (${boolInfo.lexes.map((l) => `v === ${JSON.stringify(l)}`).join(' || ')})) return v;`
    : '';

  const code = `
/* ==================================================================
 * Serializer — residual-consumption print mode of the same grammar
 * (spec §8, shaclc profile). Batch window: printing consumes quads
 * from the residual; print succeeds iff the residual empties, and a
 * non-empty residual is the "not compact-expressible" verdict.
 * Vocabulary, keywords, oracle registry, print{} inversion defaults,
 * lexical guards and profile-gated fallback layers are extracted from
 * the grammar AST at generation time.
 * ================================================================== */

${fmCode}
${pnLocalCode}

export class ShuttleResidualError extends Error {
  constructor(message, residual, missing) {
    super(message);
    this.name = 'ShuttleResidualError';
    this.residual = residual || [];
    this.missing = missing || null;
  }
}

const RSV = ${JSON.stringify(V, null, 2)};
const RSK = ${JSON.stringify(KW, null, 2)};
const RS_NODE_PARAM = new Map(${JSON.stringify(nodeParamMap)});
const RS_PROP_PARAM = new Map(${JSON.stringify(propParamMap)});
const RS_NODEKIND = new Map(${JSON.stringify(nodeKindMap)});
const RS_PATHMOD = new Map(${JSON.stringify(pathMods)});
const RS_PREDECLARED = ${JSON.stringify(predeclared)};
const RS_EXT = ${JSON.stringify({ annotation: extAnnotation, pc: extPc, ttl: extTtl })};
const RS_MIN_GUARDED = ${JSON.stringify(minGuarded)};
const RS_HAS_TT = ${JSON.stringify(hasTT)};
const RS_EMPTY_ARRAY = ${JSON.stringify(emptyArrayEmit)};
const RS_ORACLE = ORS_${oracleName};

const RS_NEEDS_LONG_RE = /[\\n\\r]/;

function rsNumBool(v, dtv) {
${numGuardCode}
${boolGuardCode}
  return null;
}

function rsTermKey(t) {
  switch (t.termType) {
    case 'NamedNode': return '<' + t.value + '>';
    case 'BlankNode': return '_:' + t.value;
    case 'Literal': return JSON.stringify(t.value) + '@' + t.language + '--' + (t.direction || '')
      + '^^' + (t.datatype ? t.datatype.value : '');
    case 'Quad': return '<<(' + rsTermKey(t.subject) + ' ' + rsTermKey(t.predicate) + ' ' + rsTermKey(t.object) + ')>>';
    default: return '?' + t.termType;
  }
}

function rsStripFragment(iri) {
  const h = iri.indexOf('#');
  return h < 0 ? iri : iri.slice(0, h);
}

/**
 * Print a quad array as a SHACL-CS document.
 * Returns { text, residual, missing }:
 *  - residual: quads no printable construct could consume (the
 *    "not compact-expressible" verdict when non-empty);
 *  - missing: the required document-ontology pattern, when absent (the
 *    document clause would re-emit it, so no faithful print exists).
 * options: { baseIRI, prefixes } — prefixes as { label: iri | { value } }.
 */
export function printWithResidual(quads, options = {}) {
  /* ---- residual load: set semantics, default graph only ---- */
  const all = [];
  const residual = [];
  const seen = new Set();
  for (const q of quads) {
    if (q.graph && q.graph.termType !== 'DefaultGraph') { residual.push(q); continue; }
    const k = rsTermKey(q.subject) + ' ' + rsTermKey(q.predicate) + ' ' + rsTermKey(q.object);
    if (!seen.has(k)) { seen.add(k); all.push(q); }
  }
  const used = new Uint8Array(all.length);
  const bySubj = new Map();
  const bRef = new Map(); // blank label -> object-position reference count
  for (let i = 0; i < all.length; i++) {
    const q = all[i];
    const sk = rsTermKey(q.subject);
    let arr = bySubj.get(sk);
    if (arr === undefined) { arr = []; bySubj.set(sk, arr); }
    arr.push(i);
    if (q.object.termType === 'BlankNode') bRef.set(q.object.value, (bRef.get(q.object.value) || 0) + 1);
  }
  const singleRef = (t) => (bRef.get(t.value) || 0) === 1;
  const on = (t) => bySubj.get(rsTermKey(t)) || [];
  const free = (i, txn) => used[i] === 0 && !txn.has(i);
  const commit = (txn) => { for (const i of txn) used[i] = 1; };

  /* ---- prefixes: effective map = predeclared overridden by options ---- */
  const eff = new Map(RS_PREDECLARED);
  const declared = [];
  const optPrefixes = options.prefixes || {};
  for (const label of Object.keys(optPrefixes)) {
    const raw = optPrefixes[label];
    const iri = String(raw && raw.value !== undefined ? raw.value : raw);
    if (label !== '' && !fm_PN_PREFIX(label)) continue; // unlexable label: unusable
    if (eff.get(label) === iri) continue;               // predeclared: implicit
    eff.set(label, iri);
    declared.push([label, iri]);
  }
  const prefixList = [...eff.entries()].map(([label, iri]) => ({ label, iri }));
  prefixList.sort((a, b) => b.iri.length - a.iri.length);
  const abbrevCache = new Map();
  function iriText(v) {
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

  /* ---- literals: lexical-fidelity print or refusal ---- */
  function litText(t) {
    const v = t.value;
    const dtv = t.datatype ? t.datatype.value : RSV.xsdString;
    const nb = rsNumBool(v, dtv);
    if (nb !== null) return nb;
    const q = RS_NEEDS_LONG_RE.test(v) ? '"""' + escStrLong(v) + '"""' : '"' + escStrShort(v) + '"';
    if (t.language) {
      const tag = '@' + t.language + (t.direction ? '--' + t.direction : '');
      // parse canonicalizes the tag (lowercase) and lexes LANG_DIR: a tag
      // that would not round-trip to this term is refused.
      if (t.language !== t.language.toLowerCase() || !fm_LANG_DIR(tag)) return null;
      if (t.direction && dtv !== RSV.dirLangString) return null;
      if (!t.direction && dtv !== RSV.langString) return null;
      return q + tag;
    }
    if (dtv !== RSV.xsdString) return q + RSK.dtSep + iriText(dtv);
    return q;
  }

  /* ---- rdf list reader (transactional) ----
   * Cons cells must be single-use blanks with exactly {first, rest} free. */
  function readList(head, txn) {
    const elems = [];
    let node = head;
    for (;;) {
      if (node.termType === 'NamedNode' && node.value === RSV.rdfNil) return elems;
      if (node.termType !== 'BlankNode' || !singleRef(node)) return null;
      const idxs = on(node).filter((i) => free(i, txn));
      if (idxs.length !== 2) return null;
      let fi = -1;
      let ri = -1;
      for (const i of idxs) {
        if (all[i].predicate.value === RSV.rdfFirst) fi = i;
        else if (all[i].predicate.value === RSV.rdfRest) ri = i;
      }
      if (fi < 0 || ri < 0) return null;
      txn.add(fi);
      txn.add(ri);
      elems.push(all[fi].object);
      node = all[ri].object;
    }
  }

  /* ---- triple terms ---- */
  function ttText(t) {
    if (!RS_HAS_TT) return null;
    if (t.subject.termType !== 'NamedNode' || t.predicate.termType !== 'NamedNode') return null;
    const o = t.object;
    let ot = null;
    if (o.termType === 'NamedNode') ot = iriText(o.value);
    else if (o.termType === 'Literal') ot = litText(o);
    else if (o.termType === 'Quad') ot = ttText(o);
    if (ot === null) return null;
    return RSK.ttOpen + ' ' + iriText(t.subject.value) + ' ' + iriText(t.predicate.value) + ' ' + ot + ' ' + RSK.ttClose;
  }

  /* ---- iriOrLiteralOrArray ---- */
  function valueText(t, txn) {
    if (t.termType === 'NamedNode') return iriText(t.value);
    if (t.termType === 'Literal') return litText(t);
    if (t.termType === 'Quad') return ttText(t);
    if (t.termType !== 'BlankNode' || !singleRef(t)) return null;
    // array: a proper rdf list of iri/literal/tt, or the empty-array shape
    const idxs = on(t).filter((i) => free(i, txn));
    if (RS_EMPTY_ARRAY && idxs.length === 1) {
      const q = all[idxs[0]];
      if (q.predicate.value === RSV.rdfRest && q.object.termType === 'NamedNode' && q.object.value === RSV.rdfNil) {
        txn.add(idxs[0]);
        return RSK.arrOpen + RSK.arrClose;
      }
    }
    const elems = readList(t, txn);
    if (elems === null || elems.length === 0) return null;
    const parts = [];
    for (const e of elems) {
      if (e.termType === 'BlankNode') return null; // arrays hold iriOrLiteral only
      const et = valueText(e, txn);
      if (et === null) return null;
      parts.push(et);
    }
    return RSK.arrOpen + ' ' + parts.join(' ') + ' ' + RSK.arrClose;
  }

  /* ---- path algebra inversion ----
   * levels: 0 alternative | 1 sequence | 2 eltOrInverse | 3 elt | 4 primary */
  function pathText(t, txn, needLevel) {
    if (t.termType === 'NamedNode') return iriText(t.value);
    if (t.termType !== 'BlankNode' || !singleRef(t)) return null;
    const idxs = on(t).filter((i) => free(i, txn));
    const wrap = (text, level) => (level < needLevel ? RSK.parOpen + text + RSK.parClose : text);
    if (idxs.length === 1) {
      const q = all[idxs[0]];
      const p = q.predicate.value;
      if (p === RSV.shAltPath) {
        txn.add(idxs[0]);
        const elems = readList(q.object, txn);
        if (elems === null || elems.length < 2) return null;
        const parts = [];
        for (const e of elems) {
          const et = pathText(e, txn, 1);
          if (et === null) return null;
          parts.push(et);
        }
        return wrap(parts.join(' ' + RSK.or + ' '), 0);
      }
      if (p === RSV.shInverse) {
        txn.add(idxs[0]);
        const et = pathText(q.object, txn, 3);
        if (et === null) return null;
        return wrap(RSK.inverse + et, 2);
      }
      const mod = RS_PATHMOD.get(p);
      if (mod !== undefined) {
        txn.add(idxs[0]);
        const et = pathText(q.object, txn, 4);
        if (et === null) return null;
        return wrap(et + mod, 3);
      }
      return null;
    }
    // a sequence: the path node IS the list head
    const elems = readList(t, txn);
    if (elems === null || elems.length < 2) return null;
    const parts = [];
    for (const e of elems) {
      const et = pathText(e, txn, 2);
      if (et === null) return null;
      parts.push(et);
    }
    return wrap(parts.join(RSK.pathSeqSep), 1);
  }

  /* ---- property-shape atoms (propertyOr / propertyNot / propertyAtom) ---- */
  function propertyAtomText(pred, obj, txn) {
    if (pred === RSV.shDatatype && obj.termType === 'NamedNode' && RS_ORACLE.has(obj.value)) {
      return iriText(obj.value); // oracle discharged by the consumed predicate
    }
    if (pred === RSV.shClass && obj.termType === 'NamedNode' && !RS_ORACLE.has(obj.value)) {
      return iriText(obj.value); // would re-parse as sh:class (oracle misses)
    }
    if (pred === RSV.shNodeKind && obj.termType === 'NamedNode') {
      const kw = RS_NODEKIND.get(obj.value);
      if (kw !== undefined) return kw;
    }
    if (pred === RSV.shNode) {
      if (obj.termType === 'NamedNode') return RSK.ref + iriText(obj.value);
      if (obj.termType === 'BlankNode' && singleRef(obj)) {
        const btxn = new Set(txn); // failed nested bodies must not consume
        const body = bodyText(obj, btxn);
        if (body !== null) { for (const k of btxn) txn.add(k); return body; }
      }
      return null;
    }
    const kw = RS_PROP_PARAM.get(pred);
    if (kw !== undefined) {
      const vt = valueText(obj, txn);
      if (vt !== null) return kw + '=' + vt;
    }
    return null;
  }

  function propertyNotText(pred, obj, txn) {
    if (pred === RSV.shNot && obj.termType === 'BlankNode' && singleRef(obj)) {
      const idxs = on(obj).filter((i) => free(i, txn));
      if (idxs.length === 1) {
        const q = all[idxs[0]];
        const inner = propertyAtomText(q.predicate.value, q.object, txn);
        if (inner !== null) { txn.add(idxs[0]); return RSK.not + ' ' + inner; }
      }
      return null;
    }
    return propertyAtomText(pred, obj, txn);
  }

  function orChainText(pred, obj, txn, elemFn) {
    if (pred !== RSV.shOr || obj.termType !== 'BlankNode' || !singleRef(obj)) return null;
    const otxn = new Set(txn); // a failed chain must not consume
    const elems = readList(obj, otxn);
    if (elems === null || elems.length < 2) return null;
    const parts = [];
    for (const e of elems) {
      if (e.termType !== 'BlankNode' || !singleRef(e)) return null;
      const idxs = on(e).filter((i) => free(i, otxn));
      if (idxs.length !== 1) return null; // each element carries exactly one pair
      const q = all[idxs[0]];
      const t = elemFn(q.predicate.value, q.object, otxn);
      if (t === null) return null;
      otxn.add(idxs[0]);
      parts.push(t);
    }
    for (const k of otxn) txn.add(k);
    return parts.join(' ' + RSK.or + ' ');
  }

  function propertyOrText(pred, obj, txn) {
    const or = orChainText(pred, obj, txn, propertyNotText);
    if (or !== null) return or;
    return propertyNotText(pred, obj, txn);
  }

  /* ---- node-level constraints (nodeOrEmit / nodeNot / nodeValue) ---- */
  function nodeValueText(pred, obj, txn) {
    const kw = RS_NODE_PARAM.get(pred);
    if (kw === undefined) return null;
    const vt = valueText(obj, txn);
    if (vt === null) return null;
    return kw + '=' + vt;
  }

  function nodeNotText(pred, obj, txn) {
    if (pred === RSV.shNot && obj.termType === 'BlankNode' && singleRef(obj)) {
      const idxs = on(obj).filter((i) => free(i, txn));
      if (idxs.length === 1) {
        const q = all[idxs[0]];
        const inner = nodeValueText(q.predicate.value, q.object, txn);
        if (inner !== null) { txn.add(idxs[0]); return RSK.not + ' ' + inner; }
      }
      return null;
    }
    return nodeValueText(pred, obj, txn);
  }

  function nodeOrText(pred, obj, txn) {
    const or = orChainText(pred, obj, txn, nodeNotText);
    if (or !== null) return or;
    return nodeNotText(pred, obj, txn);
  }

  /* ---- extended-layer object language (iriOrLiteral | bnSection | ttlList) ---- */
  function extObjectText(t, txn, indent) {
    if (t.termType === 'NamedNode') return iriText(t.value);
    if (t.termType === 'Literal') return litText(t);
    if (t.termType === 'Quad') return ttText(t);
    if (t.termType !== 'BlankNode' || !singleRef(t)) return null;
    // prefer the collection form when the blank is a proper list
    const ltxn = new Set(txn);
    const elems = readList(t, ltxn);
    if (elems !== null) {
      const parts = [];
      let ok = true;
      for (const e of elems) {
        const et = extObjectText(e, ltxn, indent);
        if (et === null) { ok = false; break; }
        parts.push(et);
      }
      if (ok) {
        for (const i of ltxn) txn.add(i);
        return elems.length === 0 ? RSK.listOpen + RSK.listClose
          : RSK.listOpen + ' ' + parts.join(' ') + ' ' + RSK.listClose;
      }
    }
    // bnSection: every quad on the blank must be expressible
    const idxs = on(t).filter((i) => free(i, txn));
    if (idxs.length === 0) return null;
    const groups = extPredicateGroups(t, txn, indent);
    if (groups === null) return null;
    return RSK.bnOpen + ' ' + groups.join(' ' + RSK.annSep + ' ') + ' ' + RSK.bnClose;
  }

  /** Group ALL free quads of a subject as 'p o1, o2' entries; null if any
   *  object is inexpressible (all-or-nothing, so blanks never dangle). */
  function extPredicateGroups(subj, txn, indent) {
    const idxs = on(subj).filter((i) => free(i, txn));
    const byPred = new Map();
    for (const i of idxs) {
      const p = all[i].predicate;
      if (p.termType !== 'NamedNode') return null;
      let arr = byPred.get(p.value);
      if (arr === undefined) { arr = []; byPred.set(p.value, arr); }
      arr.push(i);
    }
    const groups = [];
    for (const [p, list] of byPred) {
      const objs = [];
      for (const i of list) {
        const ot = extObjectText(all[i].object, txn, indent);
        if (ot === null) return null;
        txn.add(i);
        objs.push(ot);
      }
      groups.push(iriText(p) + ' ' + objs.join(RSK.objSep + ' '));
    }
    return groups;
  }

  /* ---- nested shape bodies: all-or-nothing constraint printing ---- */
  function bodyText(n, txn, depth = 1) {
    const pad = '  '.repeat(depth + 1);
    const lines = constraintLines(n, txn, depth + 1, false);
    if (lines === null) return null;
    const idxs = on(n).filter((i) => free(i, txn));
    if (idxs.length > 0) return null; // leftovers: the nested body cannot absorb them
    if (lines.length === 0) return RSK.bodyOpen + RSK.bodyClose;
    return RSK.bodyOpen + '\\n' + lines.map((l) => pad + l).join('\\n') + '\\n' + '  '.repeat(depth) + RSK.bodyClose;
  }

  /**
   * The constraints of a focus node: property shapes + node-level params.
   * Consumes what it can (into txn); inexpressible quads stay free for the
   * caller (top level: annotation fallback or residual; nested: refusal).
   */
  function constraintLines(n, txn, depth, topLevel) {
    const lines = [];
    // property shapes
    for (const i of on(n)) {
      if (!free(i, txn)) continue;
      const q = all[i];
      if (q.predicate.value !== RSV.shProperty) continue;
      if (q.object.termType !== 'BlankNode' || !singleRef(q.object)) continue;
      const t = propertyShapeText(q.object, txn, depth);
      if (t !== null) { txn.add(i); lines.push(t + ' ' + RSK.dot); }
    }
    // node-level or / not / params
    for (const i of on(n)) {
      if (!free(i, txn)) continue;
      const q = all[i];
      const sub = new Set(txn);
      const t = nodeOrText(q.predicate.value, q.object, sub);
      if (t !== null) {
        sub.add(i);
        for (const k of sub) txn.add(k);
        lines.push(t + ' ' + RSK.dot);
      }
    }
    void topLevel;
    return lines;
  }

  function propertyShapeText(ps, txn, depth) {
    const sub = new Set(txn);
    // path is the gate: no path, no property shape
    let pathIdx = -1;
    for (const i of on(ps)) {
      if (free(i, sub) && all[i].predicate.value === RSV.shPath) { pathIdx = i; break; }
    }
    if (pathIdx < 0) return null;
    sub.add(pathIdx);
    const pt = pathText(all[pathIdx].object, sub, 0);
    if (pt === null) return null;
    const parts = [pt];
    // counts: one min (guard-invertible) + one max, defaults from print {}
    let mn = null;
    let mx = null;
    for (const i of on(ps)) {
      if (!free(i, sub)) continue;
      const q = all[i];
      const o = q.object;
      const isInt = o.termType === 'Literal' && o.datatype && o.datatype.value === RSV.xsdInteger
        && !o.language && fm_${intToken}(o.value);
      if (q.predicate.value === RSV.shMinCount && mn === null && isInt) {
        // parse-side when-guard: a bound it would suppress cannot round-trip
        if (RS_MIN_GUARDED && !(parseInt(o.value, 10) > 0)) continue;
        mn = o.value;
        sub.add(i);
      } else if (q.predicate.value === RSV.shMaxCount && mx === null && isInt) {
        mx = o.value;
        sub.add(i);
      }
    }
    if (mn !== null || mx !== null) {
      parts.push(RSK.cntOpen + (mn === null ? RSK.minDefault : mn) + RSK.cntDots + (mx === null ? RSK.maxDefault : mx) + RSK.cntClose);
    }
    // atoms
    for (const i of on(ps)) {
      if (!free(i, sub)) continue;
      const q = all[i];
      const atxn = new Set(sub);
      const t = propertyOrText(q.predicate.value, q.object, atxn);
      if (t !== null) {
        atxn.add(i);
        for (const k of atxn) sub.add(k);
        parts.push(t);
      }
    }
    // '% … %' escape (extended): the declared guard-free fallback
    if (RS_EXT.pc) {
      const leftover = on(ps).filter((i) => free(i, sub));
      if (leftover.length > 0) {
        const ptxn = new Set(sub);
        const groups = extPredicateGroups(ps, ptxn, depth);
        if (groups !== null) {
          for (const k of ptxn) sub.add(k);
          parts.push(RSK.pcOpen + ' ' + groups.join(' ' + RSK.annSep + ' ') + ' ' + RSK.pcClose);
        }
      }
    }
    for (const k of sub) txn.add(k);
    return parts.join(' ');
  }

  /* ================================================================
   * Document assembly
   * ================================================================ */
  const out = [];

  // BASE + the document-ontology clause (emitted by shaclcDoc at EOF: a
  // faithful print REQUIRES a matching quad — its absence is a verdict).
  // The document IRI is READ OFF the graph (the first IRI typed
  // owl:Ontology): a BASE directive in the original document overrides any
  // parse-time baseIRI, so the option is only a preference among candidates.
  const optBase = options.baseIRI !== undefined ? rsStripFragment(String(options.baseIRI)) : null;
  let ontoIdx = -1;
  for (let i = 0; i < all.length; i++) {
    const q = all[i];
    if (used[i] === 0 && q.predicate.value === RSV.rdfType && q.object.termType === 'NamedNode'
      && q.object.value === RSV.ontology && q.subject.termType === 'NamedNode') {
      if (ontoIdx < 0) ontoIdx = i;
      if (optBase !== null && q.subject.value === optBase) { ontoIdx = i; break; }
    }
  }
  if (ontoIdx < 0) {
    return {
      text: null,
      residual: all.filter((_, i) => used[i] === 0).concat(residual),
      missing: { subject: optBase, predicate: RSV.rdfType, object: RSV.ontology },
    };
  }
  const base = all[ontoIdx].subject.value;
  used[ontoIdx] = 1;
  out.push(RSK.base + ' <' + escIri(base) + '>');

  // IMPORTS: subject is the (single, printed) base
  for (let i = 0; i < all.length; i++) {
    const q = all[i];
    if (used[i] === 0 && q.predicate.value === RSV.imports && q.subject.termType === 'NamedNode'
      && q.subject.value === base && q.object.termType === 'NamedNode') {
      used[i] = 1;
      out.push(RSK.imports + ' <' + escIri(q.object.value) + '>');
    }
  }

  for (const [label, iri] of declared) out.push(RSK.prefix + ' ' + label + ': <' + escIri(iri) + '>');
  out.push('');

  // shapes, in input order of their typing quads
  for (let i = 0; i < all.length; i++) {
    if (used[i] !== 0) continue;
    const q = all[i];
    if (q.predicate.value !== RSV.rdfType || q.object.termType !== 'NamedNode'
      || q.object.value !== RSV.nodeShapeCls || q.subject.termType !== 'NamedNode') continue;
    used[i] = 1;
    const n = q.subject;
    const txn = new Set();
    // shapeClass? (consumes the rdfs:Class typing too)
    let isClass = false;
    for (const j of on(n)) {
      if (free(j, txn) && all[j].predicate.value === RSV.rdfType
        && all[j].object.termType === 'NamedNode' && all[j].object.value === RSV.rdfsClass) {
        isClass = true;
        txn.add(j);
        break;
      }
    }
    let header = (isClass ? RSK.shapeClass : RSK.shape) + ' ' + iriText(n.value);
    // '->' target classes (the grammar puts targetClass on 'shape' only)
    if (!isClass) {
      const targets = [];
      for (const j of on(n)) {
        if (free(j, txn) && all[j].predicate.value === RSV.targetClass && all[j].object.termType === 'NamedNode') {
          txn.add(j);
          targets.push(iriText(all[j].object.value));
        }
      }
      if (targets.length > 0) header += ' ' + RSK.arrow + ' ' + targets.join(' ');
    }
    const lines = constraintLines(n, txn, 1, true);
    // extended: turtle-style annotations absorb whatever is left on n
    if (RS_EXT.annotation) {
      const leftover = on(n).filter((j) => free(j, txn));
      if (leftover.length > 0) {
        const atxn = new Set(txn);
        const groups = extPredicateGroups(n, atxn, 1);
        if (groups !== null) {
          for (const k of atxn) txn.add(k);
          header += ' ' + RSK.annSep + ' ' + groups.join(' ' + RSK.annSep + ' ');
        }
      }
    }
    commit(txn);
    if (lines.length === 0) out.push(header + ' ' + RSK.bodyOpen + RSK.bodyClose);
    else out.push(header + ' ' + RSK.bodyOpen + '\\n' + lines.map((l) => '  ' + l).join('\\n') + '\\n' + RSK.bodyClose);
  }

  // extended: trailing turtle statements absorb leftover IRI-subject quads
  if (RS_EXT.ttl) {
    const subjects = [];
    const seenSubj = new Set();
    for (let i = 0; i < all.length; i++) {
      if (used[i] !== 0) continue;
      const s = all[i].subject;
      if (s.termType !== 'NamedNode') continue;
      if (!seenSubj.has(s.value)) { seenSubj.add(s.value); subjects.push(s); }
    }
    for (const s of subjects) {
      const txn = new Set();
      const groups = extPredicateGroups(s, txn, 0);
      if (groups !== null && groups.length > 0) {
        commit(txn);
        out.push(iriText(s.value) + ' ' + groups.join(' ' + RSK.annSep + ' ') + ' ' + RSK.dot);
      }
    }
  }

  for (let i = 0; i < all.length; i++) if (used[i] === 0) residual.push(all[i]);
  return { text: out.join('\\n') + '\\n', residual, missing: null };
}

/**
 * Total print or verdict: returns the document, or throws
 * ShuttleResidualError carrying the unconsumed quads (the graph is not
 * expressible in this grammar/profile).
 */
export function writeQuads(quads, options = {}) {
  const r = printWithResidual(quads, options);
  if (r.missing !== null) {
    throw new ShuttleResidualError(
      '${g.name}: not printable — the document clause re-emits <' + String(r.missing.subject) + '> rdf:type owl:Ontology, which the graph does not contain',
      r.residual, r.missing);
  }
  if (r.residual.length > 0) {
    throw new ShuttleResidualError(
      '${g.name}: graph is not compact-expressible in this profile — ' + r.residual.length + ' residual quad(s)',
      r.residual, null);
  }
  return r.text;
}

/** Batch writer (API parity with the streaming serializers). */
export function createWriter(options = {}) {
  const quads = [];
  return {
    quad(q) { quads.push(q); },
    end() {
      const text = writeQuads(quads, options);
      if (options.write) { options.write(text); return undefined; }
      return text;
    },
  };
}
`;
  return { code };
}
