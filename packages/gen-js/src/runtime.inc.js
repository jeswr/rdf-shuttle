/* ---- Shuttle JS runtime: RDF/JS terms + the primitive iso library ----
 * Ships once per toolchain (spec/SHUTTLE.md §5): resolve, unescape/escape
 * families, langCanon. Inlined so the emitted module is dependency-free. */

const INCOMPLETE = { shuttleIncomplete: true };

class ShuttleSyntaxError extends Error {
  constructor(message, line, column, code) {
    super(code ? `[${code}] ${message}` : message);
    this.name = 'ShuttleSyntaxError';
    this.line = line;
    this.column = column;
    this.code = code || null;
  }
}

class NamedNode {
  constructor(value) { this.value = value; }
  equals(o) { return !!o && o.termType === 'NamedNode' && o.value === this.value; }
}
NamedNode.prototype.termType = 'NamedNode';

class BlankNode {
  constructor(value) { this.value = value; }
  equals(o) { return !!o && o.termType === 'BlankNode' && o.value === this.value; }
}
BlankNode.prototype.termType = 'BlankNode';

class Literal {
  constructor(value, language, direction, datatype) {
    this.value = value;
    this.language = language;
    this.direction = direction;
    this.datatype = datatype;
  }
  equals(o) {
    return !!o && o.termType === 'Literal' && o.value === this.value
      && o.language === this.language && (o.direction || null) === (this.direction || null)
      && this.datatype.equals(o.datatype);
  }
}
Literal.prototype.termType = 'Literal';

class DefaultGraph {
  equals(o) { return !!o && o.termType === 'DefaultGraph'; }
}
DefaultGraph.prototype.termType = 'DefaultGraph';
DefaultGraph.prototype.value = '';
const DEFAULT_GRAPH = new DefaultGraph();

class Quad {
  constructor(subject, predicate, object, graph) {
    this.subject = subject;
    this.predicate = predicate;
    this.object = object;
    this.graph = graph || DEFAULT_GRAPH;
  }
  equals(o) {
    return !!o && o.termType === 'Quad' && this.subject.equals(o.subject)
      && this.predicate.equals(o.predicate) && this.object.equals(o.object)
      && this.graph.equals(o.graph);
  }
}
Quad.prototype.termType = 'Quad';
Quad.prototype.value = '';

/** RDF/JS DataFactory-compatible surface. */
const factory = {
  namedNode: (v) => new NamedNode(v),
  blankNode: (v) => new BlankNode(v === undefined ? `n3s${factory._bn++}` : v),
  literal: (value, langOrDt) => {
    if (langOrDt === undefined) return new Literal(value, '', null, XSD_STRING_NN);
    if (typeof langOrDt === 'string') {
      const i = langOrDt.indexOf('--');
      if (i >= 0) return new Literal(value, langOrDt.slice(0, i), langOrDt.slice(i + 2), DT_DIRLANGSTRING);
      return new Literal(value, langOrDt, null, DT_LANGSTRING);
    }
    return new Literal(value, '', null, langOrDt);
  },
  defaultGraph: () => DEFAULT_GRAPH,
  quad: (s, p, o, g) => new Quad(s, p, o, g),
  _bn: 0,
};

const RDF_NS = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const XSD_NS = 'http://www.w3.org/2001/XMLSchema#';
const DT_LANGSTRING = new NamedNode(`${RDF_NS}langString`);
const DT_DIRLANGSTRING = new NamedNode(`${RDF_NS}dirLangString`);
const XSD_STRING_NN = new NamedNode(`${XSD_NS}string`);

function mkFS(kinds) {
  const a = new Uint8Array(NTOK);
  for (const k of kinds) a[k] = 1;
  return a;
}

/* ---- iso: unescape ---- */

function hexVal(s, i, n) {
  let v = 0;
  for (let k = 0; k < n; k++) {
    const c = s.charCodeAt(i + k);
    let d;
    if (c >= 48 && c <= 57) d = c - 48;
    else if (c >= 65 && c <= 70) d = c - 55;
    else if (c >= 97 && c <= 102) d = c - 87;
    else return -1;
    v = v * 16 + d;
  }
  return v;
}

/** \uXXXX / \UXXXXXXXX only (IRIREF bodies). */
function unescU(s, a, b) {
  let out = '';
  let i = a;
  for (;;) {
    const j = s.indexOf('\\', i);
    if (j < 0 || j >= b) { out += s.slice(i, b); return out; }
    out += s.slice(i, j);
    const c = s.charCodeAt(j + 1);
    if (c === 117) { out += String.fromCodePoint(hexVal(s, j + 2, 4)); i = j + 6; }
    else if (c === 85) { out += String.fromCodePoint(hexVal(s, j + 2, 8)); i = j + 10; }
    else throw new ShuttleSyntaxError(`bad escape in IRI`, 0, 0);
  }
}

const ECHAR_MAP = { t: '\t', b: '\b', n: '\n', r: '\r', f: '\f', '"': '"', "'": "'", '\\': '\\' };

/** ECHAR + UCHAR (string bodies). */
function unescStr(s, a, b) {
  let out = '';
  let i = a;
  for (;;) {
    const j = s.indexOf('\\', i);
    if (j < 0 || j >= b) { out += s.slice(i, b); return out; }
    out += s.slice(i, j);
    const c = s[j + 1];
    if (c === 'u') { out += String.fromCodePoint(hexVal(s, j + 2, 4)); i = j + 6; }
    else if (c === 'U') { out += String.fromCodePoint(hexVal(s, j + 2, 8)); i = j + 10; }
    else { out += ECHAR_MAP[c]; i = j + 2; }
  }
}

/** PN_LOCAL: drop the backslash of \-escapes; %XX stays verbatim. */
function unescLocal(s, a, b) {
  let out = '';
  let i = a;
  for (;;) {
    const j = s.indexOf('\\', i);
    if (j < 0 || j >= b) { out += s.slice(i, b); return out; }
    out += s.slice(i, j) + s[j + 1];
    i = j + 2;
  }
}

function langCanon(s) { return s.toLowerCase(); }

/* ---- iso: escape (print direction) ---- */

const IRI_ESC_RE = /[\u0000-\u0020<>"{}|^`\\]/g;

function escIriChar(ch) {
  const c = ch.codePointAt(0);
  return `\\u${c.toString(16).toUpperCase().padStart(4, '0')}`;
}

function escIri(s) { return s.replace(IRI_ESC_RE, escIriChar); }

const STR_ESC_RE = /[\u0000-\u001f"\\]/g;
const STR_ESC_MAP = { '\t': '\\t', '\b': '\\b', '\n': '\\n', '\r': '\\r', '\f': '\\f', '"': '\\"', '\\': '\\\\' };

function escStrShort(s) {
  return s.replace(STR_ESC_RE, (ch) => STR_ESC_MAP[ch]
    || `\\u${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
}

function escStrLong(s) {
  let out = s.replace(/\\/g, '\\\\').replace(/"""/g, '\\"""');
  if (out.endsWith('"')) out = `${out.slice(0, -1)}\\"`;
  return out;
}

/* ---- iso: resolve (RFC 3986 §5) ---- */

const URI_RE = /^(?:([A-Za-z][A-Za-z0-9+.-]*):)?(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#([\s\S]*))?$/;

function removeDotSegments(path) {
  if (path === '' || (!path.includes('./') && !path.endsWith('/.') && !path.endsWith('/..') && path !== '.' && path !== '..')) return path;
  let input = path;
  const output = [];
  while (input.length > 0) {
    if (input.startsWith('../')) input = input.slice(3);
    else if (input.startsWith('./')) input = input.slice(2);
    else if (input.startsWith('/./')) input = `/${input.slice(3)}`;
    else if (input === '/.') input = '/';
    else if (input.startsWith('/../')) { input = `/${input.slice(4)}`; output.pop(); }
    else if (input === '/..') { input = '/'; output.pop(); }
    else if (input === '.' || input === '..') input = '';
    else {
      let j = input.indexOf('/', input.startsWith('/') ? 1 : 0);
      if (j < 0) j = input.length;
      output.push(input.slice(0, j));
      input = input.slice(j);
    }
  }
  return output.join('');
}

/** Fast path: absolute IRI with no dot segments — no regex, no rebuild. */
function isPlainAbsolute(rel) {
  const n = rel.length;
  let c = rel.charCodeAt(0);
  if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122))) return false;
  let i = 1;
  for (; i < n; i++) {
    c = rel.charCodeAt(i);
    if (c === 58) break; // ':'
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  if (i >= n || rel.charCodeAt(i) !== 58) return false;
  // conservative: fall back to the full algorithm if any dot segment may exist
  return !rel.includes('./', i) && !rel.endsWith('/.') && !rel.endsWith('/..');
}

function resolveIri(base, rel) {
  if (rel === '') {
    // same-document reference: base without its fragment
    const h = base.indexOf('#');
    return h < 0 ? base : base.slice(0, h);
  }
  if (isPlainAbsolute(rel)) return rel;
  const r = URI_RE.exec(rel);
  const scheme = r[1];
  if (scheme !== undefined) {
    const path = removeDotSegments(r[3]);
    return `${scheme}:${r[2] !== undefined ? `//${r[2]}` : ''}${path}${r[4] !== undefined ? `?${r[4]}` : ''}${r[5] !== undefined ? `#${r[5]}` : ''}`;
  }
  if (base === '') return rel; // no base declared: keep as-is
  const b = URI_RE.exec(base);
  let authority;
  let path;
  let query;
  if (r[2] !== undefined) {
    authority = r[2];
    path = removeDotSegments(r[3]);
    query = r[4];
  } else {
    authority = b[2];
    if (r[3] === '') {
      path = b[3];
      query = r[4] !== undefined ? r[4] : b[4];
    } else {
      if (r[3].startsWith('/')) path = removeDotSegments(r[3]);
      else {
        // merge
        const basePath = b[2] !== undefined && b[3] === '' ? '/' : b[3].slice(0, b[3].lastIndexOf('/') + 1);
        path = removeDotSegments(basePath + r[3]);
      }
      query = r[4];
    }
  }
  return `${b[1] !== undefined ? `${b[1]}:` : ''}${authority !== undefined ? `//${authority}` : ''}${path}${query !== undefined ? `?${query}` : ''}${r[5] !== undefined ? `#${r[5]}` : ''}`;
}
