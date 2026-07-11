/* ---- Shuttle Rust runtime: RDF term model + the primitive iso library ----
 * Ships once per toolchain (spec/SHUTTLE.md §5): resolve, unescape/escape
 * families, langCanon. Inlined so the emitted module is dependency-free. */

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::rc::Rc;

/// An RDF 1.2 term. `Rc`-backed so clones are reference-count bumps; the
/// parser interns named nodes, so repeated IRIs share one allocation.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Term {
    /// An IRI.
    NamedNode(Rc<str>),
    /// A blank node (the label, without the `_:` prefix).
    BlankNode(Rc<str>),
    /// A literal.
    Literal(Rc<LiteralData>),
    /// An RDF 1.2 triple term.
    Triple(Rc<Triple>),
}

/// The payload of a [`Term::Literal`].
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct LiteralData {
    /// The lexical form, verbatim (lexical fidelity: `0.9` stays `"0.9"`).
    pub value: Rc<str>,
    /// BCP47 language tag, ASCII-lowercased; empty when not a language string.
    pub language: Rc<str>,
    /// Base direction (`ltr`/`rtl`) of a directional language string.
    pub direction: Option<Rc<str>>,
    /// The datatype IRI, always a [`Term::NamedNode`].
    pub datatype: Term,
}

/// A triple (this grammar `emits triples`; the graph component is implicit).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Triple {
    /// Subject term.
    pub subject: Term,
    /// Predicate term.
    pub predicate: Term,
    /// Object term.
    pub object: Term,
}

/// A syntax error, with a 1-based line/column and the grammar's stable
/// error code (e.g. `UNDECLARED_PREFIX`) when one applies.
#[derive(Debug, Clone)]
pub struct SyntaxError {
    /// Human-readable message.
    pub message: String,
    /// 1-based line of the offending token.
    pub line: usize,
    /// 1-based column of the offending token.
    pub column: usize,
    /// Stable machine-readable code from the grammar, if any.
    pub code: Option<&'static str>,
}

impl fmt::Display for SyntaxError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.code {
            Some(c) => write!(f, "[{c}] {}", self.message),
            None => write!(f, "{}", self.message),
        }
    }
}

impl std::error::Error for SyntaxError {}

/// Internal parse signal: a real syntax error, or (push mode only) an
/// incomplete-statement suspension at the end of the current chunk.
enum PErr {
    Incomplete,
    Syntax(SyntaxError),
}

impl From<SyntaxError> for PErr {
    fn from(e: SyntaxError) -> Self {
        PErr::Syntax(e)
    }
}

/// Lexer matcher flags (boundary marks + escape flag + end-of-buffer touch).
#[derive(Default)]
struct Fl {
    m_esc: bool,
    m0: isize,
    m_d: isize,
    hit_end: bool,
}

/// Decode the code point starting at byte `p` (assumed to be a UTF-8 char
/// boundary of valid UTF-8, which `&str` guarantees). Returns (cp, width).
#[inline]
fn cp_at(b: &[u8], p: usize) -> (u32, usize) {
    let x = b[p];
    if x < 0x80 {
        (u32::from(x), 1)
    } else if x < 0xE0 {
        ((u32::from(x & 0x1F) << 6) | u32::from(b[p + 1] & 0x3F), 2)
    } else if x < 0xF0 {
        (
            (u32::from(x & 0x0F) << 12) | (u32::from(b[p + 1] & 0x3F) << 6) | u32::from(b[p + 2] & 0x3F),
            3,
        )
    } else {
        (
            (u32::from(x & 0x07) << 18)
                | (u32::from(b[p + 1] & 0x3F) << 12)
                | (u32::from(b[p + 2] & 0x3F) << 6)
                | u32::from(b[p + 3] & 0x3F),
            4,
        )
    }
}

/* ---- iso: unescape ---- */

#[inline]
fn hex_val(b: &[u8], i: usize, n: usize) -> u32 {
    // The lexer validated the hex digits; this cannot fail post-match.
    let mut v: u32 = 0;
    for k in 0..n {
        let c = b[i + k];
        let d = match c {
            b'0'..=b'9' => u32::from(c - b'0'),
            b'A'..=b'F' => u32::from(c - b'A' + 10),
            _ => u32::from(c - b'a' + 10),
        };
        v = v * 16 + d;
    }
    v
}

/// A `\u`/`\U` escape decoded to a code point Rust strings cannot hold
/// (a surrogate or > U+10FFFF). The W3C grammars require *any* code point
/// here; JS strings can hold lone surrogates, Rust `String` cannot, so the
/// Rust artifact reports these as syntax errors (documented divergence).
struct BadCodePoint;

/// `\uXXXX` / `\UXXXXXXXX` only (IRIREF bodies).
fn unesc_u(s: &str) -> Result<String, BadCodePoint> {
    let b = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while let Some(j) = s[i..].find('\\').map(|k| k + i) {
        out.push_str(&s[i..j]);
        let c = b[j + 1];
        let (v, w) = if c == b'u' {
            (hex_val(b, j + 2, 4), 6)
        } else {
            (hex_val(b, j + 2, 8), 10)
        };
        out.push(char::from_u32(v).ok_or(BadCodePoint)?);
        i = j + w;
    }
    out.push_str(&s[i..]);
    Ok(out)
}

/// ECHAR + UCHAR (string bodies).
fn unesc_str(s: &str) -> Result<String, BadCodePoint> {
    let b = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while let Some(j) = s[i..].find('\\').map(|k| k + i) {
        out.push_str(&s[i..j]);
        let c = b[j + 1];
        match c {
            b'u' => {
                out.push(char::from_u32(hex_val(b, j + 2, 4)).ok_or(BadCodePoint)?);
                i = j + 6;
            }
            b'U' => {
                out.push(char::from_u32(hex_val(b, j + 2, 8)).ok_or(BadCodePoint)?);
                i = j + 10;
            }
            _ => {
                out.push(match c {
                    b't' => '\t',
                    b'b' => '\u{8}',
                    b'n' => '\n',
                    b'r' => '\r',
                    b'f' => '\u{c}',
                    _ => c as char, // '"', '\'', '\\' — validated by the lexer
                });
                i = j + 2;
            }
        }
    }
    out.push_str(&s[i..]);
    Ok(out)
}

/// PN_LOCAL: drop the backslash of `\`-escapes; `%XX` stays verbatim.
fn unesc_local(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while let Some(j) = s[i..].find('\\').map(|k| k + i) {
        out.push_str(&s[i..j]);
        out.push_str(&s[j + 1..j + 2]);
        i = j + 2;
    }
    out.push_str(&s[i..]);
    out
}

/// Language tags are ASCII by the token pattern; canonical form is lowercase.
fn lang_canon(s: &str) -> Cow<'_, str> {
    if s.bytes().any(|c| c.is_ascii_uppercase()) {
        Cow::Owned(s.to_ascii_lowercase())
    } else {
        Cow::Borrowed(s)
    }
}

/* ---- iso: escape (print direction) ---- */

fn esc_u_char(out: &mut String, c: char) {
    let v = c as u32;
    out.push_str(&format!("\\u{v:04X}"));
}

fn esc_iri(s: &str) -> Cow<'_, str> {
    if !s
        .bytes()
        .any(|c| c <= 0x20 || matches!(c, b'<' | b'>' | b'"' | b'{' | b'}' | b'|' | b'^' | b'`' | b'\\'))
    {
        return Cow::Borrowed(s);
    }
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        if c <= '\u{20}' || matches!(c, '<' | '>' | '"' | '{' | '}' | '|' | '^' | '`' | '\\') {
            esc_u_char(&mut out, c);
        } else {
            out.push(c);
        }
    }
    Cow::Owned(out)
}

fn esc_str_short(s: &str) -> Cow<'_, str> {
    if !s.bytes().any(|c| c < 0x20 || c == b'"' || c == b'\\') {
        return Cow::Borrowed(s);
    }
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\u{c}' => out.push_str("\\f"),
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if c < '\u{20}' => esc_u_char(&mut out, c),
            c => out.push(c),
        }
    }
    Cow::Owned(out)
}

fn esc_str_long(s: &str) -> String {
    let mut out = s.replace('\\', "\\\\").replace("\"\"\"", "\\\"\"\"");
    if out.ends_with('"') {
        out.pop();
        out.push_str("\\\"");
    }
    out
}

/* ---- iso: resolve (RFC 3986 §5) ---- */

fn remove_dot_segments(path: &str) -> Cow<'_, str> {
    if path.is_empty()
        || (!path.contains("./") && !path.ends_with("/.") && !path.ends_with("/..") && path != "." && path != "..")
    {
        return Cow::Borrowed(path);
    }
    let mut input = path;
    let mut output: Vec<&str> = Vec::new();
    while !input.is_empty() {
        if let Some(rest) = input.strip_prefix("../") {
            input = rest;
        } else if let Some(rest) = input.strip_prefix("./") {
            input = rest;
        } else if let Some(rest) = input.strip_prefix("/./") {
            // '/./…' -> '/…' : re-borrow including the leading slash
            input = &input[2..];
            debug_assert!(input.starts_with('/'));
            let _ = rest;
        } else if input == "/." {
            input = "/";
        } else if input.strip_prefix("/../").is_some() {
            input = &input[3..];
            output.pop();
        } else if input == "/.." {
            input = "/";
            output.pop();
        } else if input == "." || input == ".." {
            input = "";
        } else {
            let start = usize::from(input.starts_with('/'));
            let j = input[start..].find('/').map_or(input.len(), |k| k + start);
            output.push(&input[..j]);
            input = &input[j..];
        }
    }
    Cow::Owned(output.concat())
}

/// Split an IRI reference into (scheme, authority, path, query, fragment),
/// mirroring the RFC 3986 appendix-B regex.
fn uri_split(s: &str) -> (Option<&str>, Option<&str>, &str, Option<&str>, Option<&str>) {
    let b = s.as_bytes();
    let mut i = 0;
    // scheme: ALPHA (ALPHA / DIGIT / '+' / '-' / '.')* ':'
    let mut scheme = None;
    if !b.is_empty() && b[0].is_ascii_alphabetic() {
        let mut k = 1;
        while k < b.len() && (b[k].is_ascii_alphanumeric() || matches!(b[k], b'+' | b'-' | b'.')) {
            k += 1;
        }
        if k < b.len() && b[k] == b':' {
            scheme = Some(&s[..k]);
            i = k + 1;
        }
    }
    // authority
    let mut authority = None;
    if s[i..].starts_with("//") {
        let a0 = i + 2;
        let mut k = a0;
        while k < b.len() && !matches!(b[k], b'/' | b'?' | b'#') {
            k += 1;
        }
        authority = Some(&s[a0..k]);
        i = k;
    }
    // path
    let p0 = i;
    while i < b.len() && !matches!(b[i], b'?' | b'#') {
        i += 1;
    }
    let path = &s[p0..i];
    // query
    let mut query = None;
    if i < b.len() && b[i] == b'?' {
        let q0 = i + 1;
        while i < b.len() && b[i] != b'#' {
            i += 1;
        }
        query = Some(&s[q0..i]);
    }
    // fragment
    let fragment = if i < b.len() { Some(&s[i + 1..]) } else { None };
    (scheme, authority, path, query, fragment)
}

/// Fast path: absolute IRI with no dot segments — no split, no rebuild.
fn is_plain_absolute(rel: &str) -> bool {
    let b = rel.as_bytes();
    if b.is_empty() || !b[0].is_ascii_alphabetic() {
        return false;
    }
    let mut i = 1;
    while i < b.len() {
        let c = b[i];
        if c == b':' {
            break;
        }
        if !(c.is_ascii_alphanumeric() || matches!(c, b'+' | b'-' | b'.')) {
            return false;
        }
        i += 1;
    }
    if i >= b.len() || b[i] != b':' {
        return false;
    }
    // conservative: fall back to the full algorithm if any dot segment may exist
    !rel[i..].contains("./") && !rel.ends_with("/.") && !rel.ends_with("/..")
}

fn rebuild(
    scheme: Option<&str>,
    authority: Option<&str>,
    path: &str,
    query: Option<&str>,
    fragment: Option<&str>,
) -> String {
    let mut out = String::with_capacity(
        scheme.map_or(0, |s| s.len() + 1)
            + authority.map_or(0, |a| a.len() + 2)
            + path.len()
            + query.map_or(0, |q| q.len() + 1)
            + fragment.map_or(0, |f| f.len() + 1),
    );
    if let Some(sc) = scheme {
        out.push_str(sc);
        out.push(':');
    }
    if let Some(a) = authority {
        out.push_str("//");
        out.push_str(a);
    }
    out.push_str(path);
    if let Some(q) = query {
        out.push('?');
        out.push_str(q);
    }
    if let Some(f) = fragment {
        out.push('#');
        out.push_str(f);
    }
    out
}

/// RFC 3986 §5 reference resolution (the `resolve` primitive iso).
fn resolve_iri<'a>(base: &str, rel: &'a str) -> Cow<'a, str> {
    if rel.is_empty() {
        // same-document reference: base without its fragment
        return match base.find('#') {
            Some(h) => Cow::Owned(base[..h].to_string()),
            None => Cow::Owned(base.to_string()),
        };
    }
    if is_plain_absolute(rel) {
        return Cow::Borrowed(rel);
    }
    let (r_scheme, r_auth, r_path, r_query, r_frag) = uri_split(rel);
    if let Some(sc) = r_scheme {
        let path = remove_dot_segments(r_path);
        return Cow::Owned(rebuild(Some(sc), r_auth, &path, r_query, r_frag));
    }
    if base.is_empty() {
        return Cow::Borrowed(rel); // no base declared: keep as-is
    }
    let (b_scheme, b_auth, b_path, b_query, _) = uri_split(base);
    let (authority, path, query): (Option<&str>, Cow<'_, str>, Option<&str>) = if let Some(a) = r_auth {
        (Some(a), remove_dot_segments(r_path), r_query)
    } else if r_path.is_empty() {
        (b_auth, Cow::Borrowed(b_path), r_query.or(b_query))
    } else if r_path.starts_with('/') {
        (b_auth, remove_dot_segments(r_path), r_query)
    } else {
        let base_path: Cow<'_, str> = if b_auth.is_some() && b_path.is_empty() {
            Cow::Borrowed("/")
        } else {
            Cow::Borrowed(&b_path[..b_path.rfind('/').map_or(0, |k| k + 1)])
        };
        let merged = format!("{base_path}{r_path}");
        (b_auth, Cow::Owned(remove_dot_segments(&merged).into_owned()), r_query)
    };
    Cow::Owned(rebuild(b_scheme, authority, &path, query, r_frag))
}

#[inline]
fn rc_from_string(s: String) -> Rc<str> {
    Rc::from(s)
}

#[inline]
fn rc_from_cow(c: Cow<'_, str>) -> Rc<str> {
    match c {
        Cow::Borrowed(v) => Rc::from(v),
        Cow::Owned(v) => Rc::from(v),
    }
}

/* ---- term construction (free functions, so callers can split-borrow
 *      machine fields in one expression) ----
 *
 * Deliberately NO term-interning caches: measured on this backend, owned
 * per-occurrence allocation beats both an IRI-interning map and a two-level
 * pname cache on every corpus profile (repeated-term Turtle, repeated-IRI
 * N-Triples, high-distinct-cardinality N-Triples) — hashing costs more than
 * bump allocation here. (The JS backend's caches are a JS-ism: object
 * allocation + GC pressure dominate there.) Consumers that want shared
 * terms intern downstream (e.g. a dictionary sink on the emit callback). */

/// Build a named node from a (possibly borrowed) IRI string.
#[inline]
fn nn(v: Cow<'_, str>) -> Term {
    Term::NamedNode(rc_from_cow(v))
}

/// Expand a prefixed name. `require boundPrefix(...)` ran before this.
fn expand_pn(prefixes: &HashMap<String, Rc<str>>, pfx: &str, local: &str) -> Term {
    let ns = prefixes.get(pfx).expect("prefix bound (checked by require)");
    let mut s = String::with_capacity(ns.len() + local.len());
    s.push_str(ns);
    s.push_str(local);
    Term::NamedNode(Rc::from(s))
}
