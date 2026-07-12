/**
 * generate.js — assembles the single dependency-free Rust module emitted for
 * a grammar: runtime + generated lexer + generated parser + generated
 * serializer + public API (parse / PushParser / Writer).
 *
 * The artifact contract (sq-tonhr.1): ONE .rs file, zero runtime deps,
 * `#![forbid(unsafe_code)]`-compatible, MSRV 1.87, clean under
 * `clippy -D warnings` (with a small, documented allow-list for
 * generated-code style), streaming push parser with mid-token suspension.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGrammar } from '../../gen-js/src/meta.js';
import { applyProfiles } from '../../gen-js/src/generate.js';
import { analyzeTokens, genLexer } from './lexer-gen.js';
import { ParserGen } from './parser-gen.js';
import { genSerializer } from './serializer-gen.js';
import { curieTable, curieIriOf } from './clausec.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function generateModule(grammarText, grammarFile, options = {}) {
  const g = parseGrammar(grammarText, grammarFile);
  applyProfiles(g, options.profiles || null);
  const an = analyzeTokens(g);
  const lex = genLexer(g, an);

  // env slot types (consumed by clausec)
  const envTypes = new Map();
  for (const e of g.env) {
    const t = e.type;
    if (t === 'iri') envTypes.set(e.name, 'iri-string');
    else if (t.startsWith('map')) envTypes.set(e.name, /bnode/.test(t) ? 'labelmap' : 'map');
    else if (t === 'string?') envTypes.set(e.name, 'optstr');
    else if (t === 'string') envTypes.set(e.name, 'str');
    else throw new Error(`unsupported env slot type '${t}' for env.${e.name}`);
  }
  const hasLabels = envTypes.get('labels') === 'labelmap';

  const gen = { constPool: new Map(), envTypes, curies: curieTable(g.imports), oracles: new Map() };
  for (const o of g.oracles || []) gen.oracles.set(o.name, o);
  const pg = new ParserGen(g, an, lex, gen);
  const parserOut = pg.generate();

  // the print mode is derivable only for grammars carrying the Turtle
  // statement spine; other grammars (SHACL-C) get an honest parse-only
  // artifact until the residual-consumption serializer lands (spec §8) —
  // no writer symbols are emitted at all (compile-time absence, not a
  // runtime panic).
  const TURTLE_SPINE = ['statement', 'predicateObjectList', 'objectList', 'verb'];
  const hasSpine = TURTLE_SPINE.every((n) => g.prodByName.has(n));
  const ser = hasSpine ? genSerializer(g, an, lex.lx) : { code: `
/* ==================================================================
 * Print mode: NOT derivable for this grammar by the v0.1 backend (the
 * serializer generator reads the Turtle statement spine). The derived
 * residual-consumption printer — whose failure residual is the
 * "not compact-expressible" verdict — is tracked upstream. No writer
 * symbols are emitted for this grammar.
 * ================================================================== */
` };

  // start production drives the document loop; a `X*` body gets the
  // statement-level bounded-memory push loop, anything else falls back to
  // whole-buffer push parsing (document-shaped grammars like SHACL-C).
  const start = g.prodByName.get(g.headers.start);
  if (!start) throw new Error(`start production ${g.headers.start} not found`);
  const startFactors = start.alts[0].items.filter((i) => i.kind === 'factor');
  const singleStar = startFactors.length === 1 && startFactors[0].postfix === 'star' && startFactors[0].prim.kind === 'call';
  const stmtProd = singleStar ? startFactors[0].prim.name : null;

  /* ---- environment declarations -> machine fields ---- */

  const envFields = [];
  const envInit = [];
  const hasPrefixes = envTypes.get('prefixes') === 'map';
  for (const e of g.env) {
    const et = envTypes.get(e.name);
    if (et === 'iri-string') {
      envFields.push(`env_${e.name}: String,`);
      if (e.name === 'base') {
        envInit.push(`env_${e.name}: base_iri.map_or_else(String::new, str::to_string),`);
      } else {
        envInit.push(`env_${e.name}: ${JSON.stringify(e.init && e.init.k === 'iri' ? e.init.value : '')}.to_string(),`);
      }
    } else if (et === 'labelmap') {
      envFields.push(`env_${e.name}: HashMap<String, Term>,`);
      envInit.push(`env_${e.name}: HashMap::new(),`);
    } else if (et === 'map') {
      envFields.push(`env_${e.name}: HashMap<String, Rc<str>>,`);
      if (e.init && e.init.k === 'mapLit') {
        // predeclared entries (e.g. SHACL-CS's five predeclared prefixes):
        // seeded into the map AND the declaration-order list, matching the
        // JS backend's `new Map(entries)` + result() surfacing.
        const pairs = e.init.entries.map(([k, v]) => `(${JSON.stringify(k)}.to_string(), Rc::from(${JSON.stringify(v)}))`).join(', ');
        envInit.push(`env_${e.name}: HashMap::from([${pairs}]),`);
      } else {
        envInit.push(`env_${e.name}: HashMap::new(),`);
      }
    } else if (et === 'optstr') {
      envFields.push(`env_${e.name}: Option<Rc<str>>,`);
      envInit.push(`env_${e.name}: None,`);
    } else {
      envFields.push(`env_${e.name}: Rc<str>,`);
      envInit.push(`env_${e.name}: Rc::from(""),`);
    }
  }
  if (hasPrefixes) {
    const pfx = g.env.find((e) => e.name === 'prefixes');
    const seeded = pfx && pfx.init && pfx.init.k === 'mapLit'
      ? `vec![${pfx.init.entries.map(([k]) => `${JSON.stringify(k)}.to_string()`).join(', ')}]`
      : 'Vec::new()';
    envFields.push(`prefix_order: Vec<String>,`);
    envInit.push(`prefix_order: ${seeded},`);
  }

  /* ---- interned constants (compile-time, from core-terms) ---- */

  const constFields = [...gen.constPool.entries()]
    .map(([, id]) => `${id}: Term,`);
  const constInit = [...gen.constPool.entries()]
    .map(([iri, id]) => `${id}: Term::NamedNode(Rc::from(${JSON.stringify(iri)})),`);

  /* ---- oracle decision sets (@oracle declarations) ---- */

  const oracleCode = (g.oracles || []).map((o) => {
    if (!o.set) throw new Error(`oracle '${o.name}' has no decision set (runtime oracles unsupported in this backend)`);
    if (o.argTypes.length !== 1) throw new Error(`oracle '${o.name}': exactly one argument supported`);
    const iris = o.set.map((e) => curieIriOf(gen, e));
    return `/// \`@oracle ${o.name}\` — declared finite decision set (${iris.length} IRIs), compiled\n/// to a static match (parse-mode reading of spec §4.3 clause 7).\nfn or_${o.name}(t: &Term) -> bool {\n    match t {\n        Term::NamedNode(v) => matches!(v.as_ref(), ${iris.map((i) => JSON.stringify(i)).join(' | ')}),\n        _ => false,\n    }\n}`;
  }).join('\n\n');

  /* ---- outcome ---- */

  const outcomeFields = [];
  const outcomeInit = [];
  if (hasPrefixes) {
    outcomeFields.push(`    /// Declared prefixes, in declaration order.\n    pub prefixes: Vec<(String, String)>,`);
    outcomeInit.push(`prefixes: self.prefix_order.iter().map(|k| (k.clone(), self.env_prefixes.get(k).map(|v| v.to_string()).unwrap_or_default())).collect(),`);
  }
  if (envTypes.get('base') === 'iri-string') {
    outcomeFields.push(`    /// The final base IRI.\n    pub base: String,`);
    outcomeInit.push(`base: self.env_base.clone(),`);
  }
  if (envTypes.get('version') === 'optstr') {
    outcomeFields.push(`    /// The VERSION directive value, if declared.\n    pub version: Option<String>,`);
    outcomeInit.push(`version: self.env_version.as_ref().map(|v| v.to_string()),`);
  }

  let runtime = fs.readFileSync(path.join(HERE, 'runtime.inc.rs'), 'utf8');
  if (!hasSpine) {
    // parse-only artifact: drop the print-direction escape helpers (and the
    // writer-only HashSet import) so the module compiles without dead code.
    runtime = runtime.replace(/\/\* ---- iso: escape \(print direction\) ---- \*\/[\s\S]*?(?=\/\* ---- iso: resolve)/, '');
    runtime = runtime.replace('use std::collections::{HashMap, HashSet};', 'use std::collections::HashMap;');
    if (/esc_iri|HashSet/.test(runtime)) throw new Error('parse-only runtime strip failed (markers moved in runtime.inc.rs)');
  }

  const code = `//! GENERATED by @rdf-shuttle/gen-rs from ${path.basename(grammarFile)} — DO NOT EDIT.
//!
//! grammar: ${g.name}  target: ${g.headers.target || '?'}  profile: ${g.headers.profile || '?'}
//! spec-ref: ${(g.headers['spec-ref'] || '').split(' — ')[0].replace(/(https?:\/\/\S+)/g, '<$1>')}
//!
${hasSpine ? `//! One dependency-free Rust module: streaming parser (text -> triples),
//! push parser (chunked input, bounded memory, mid-token suspension), and
//! serializer (triples -> text) — parse and print modes of the same Shuttle
//! relation. \`#![forbid(unsafe_code)]\`-compatible; zero dependencies
//! beyond std.` : `//! One dependency-free Rust module: streaming parser (text -> triples) and
//! push parser (chunked input, whole-buffer fallback for this
//! document-shaped grammar). PARSE-ONLY: the print mode needs the derived
//! residual-consumption serializer (tracked upstream) — no writer symbols
//! are emitted. \`#![forbid(unsafe_code)]\`-compatible; zero dependencies
//! beyond std.`}
//!
//! Generated-code allow-list (style lints that direct-coded matchers and
//! grammar-shaped control flow trip by construction; correctness lints all
//! stay on):
#![allow(non_snake_case)] // production/token names track the W3C grammar one-for-one
#![allow(clippy::manual_range_contains)] // charset tests are generated range chains
#![allow(clippy::nonminimal_bool)] // negated charset tests
#![allow(clippy::needless_late_init)] // deferred-init value slots: rustc proves the grammar's value obligations
#![allow(clippy::collapsible_if, clippy::collapsible_else_if)] // nested alternative fallbacks
#![allow(clippy::manual_range_patterns)] // dispatch arms are FIRST-set token-kind lists (contiguity incidental)
#![allow(clippy::too_many_lines)] // one function per production/token, however large

${runtime}

/* ---- token kinds ---- */
${lex.constsCode}
${oracleCode ? `
/* ---- oracle decision sets (@oracle declarations) ---- */
${oracleCode}
` : ''}
/* ---- parser first-set masks ---- */
${pg.tableDefs.join('\n')}

${lex.matchersCode()}

/* ==================================================================
 * Parser machine: all state lives here.
 * ================================================================== */

/// What a parse leaves behind besides the triples.
#[derive(Debug, Clone)]
pub struct ParseOutcome {
${outcomeFields.join('\n')}
}

struct Machine<'i, F: FnMut(Triple)> {
    inp: Cow<'i, str>,
    pos: usize,
    is_final: bool,
    tk: u16,
    ts: usize,
    te: usize,
    t_esc: bool,
    t_m0: isize,
    t_md: isize,
    depth: u32,
    /* environment (grammar env block) */
    ${envFields.join('\n    ')}
    /* fresh blank nodes: per-derivation counter (deterministic b0, b1, …) */
    fresh_ctr: u64,
    /* push-mode statement rollback */
    push_mode: bool,
${hasLabels ? '    trail: Vec<String>,' : ''}
    stmt_buf: Vec<Triple>,
    on_quad: F,
    /* interned constants (compile-time, from core-terms) */
    rc_empty: Rc<str>,
    ${constFields.join('\n    ')}
}

impl<'i, F: FnMut(Triple)> Machine<'i, F> {
    fn new(base_iri: Option<&str>, push_mode: bool, on_quad: F) -> Machine<'i, F> {
        Machine {
            inp: Cow::Borrowed(""),
            pos: 0,
            is_final: true,
            tk: 0,
            ts: 0,
            te: 0,
            t_esc: false,
            t_m0: -1,
            t_md: -1,
            depth: 0,
            ${envInit.join('\n            ')}
            fresh_ctr: 0,
            push_mode,
${hasLabels ? '            trail: Vec::new(),' : ''}
            stmt_buf: Vec::new(),
            on_quad,
            rc_empty: Rc::from(""),
            ${constInit.join('\n            ')}
        }
    }

    fn set_input(&mut self, s: Cow<'i, str>, is_final: bool) {
        self.inp = s;
        self.pos = 0;
        self.is_final = is_final;
    }

    fn fresh_bn(&mut self) -> Term {
        let t = Term::BlankNode(Rc::from(format!("b{}", self.fresh_ctr)));
        self.fresh_ctr += 1;
        t
    }

    fn emit_q(&mut self, s: Term, p: Term, o: Term) {
        let t = Triple { subject: s, predicate: p, object: o };
        if self.push_mode {
            self.stmt_buf.push(t);
        } else {
            (self.on_quad)(t);
        }
    }

    fn line_col(&self, at: usize) -> (usize, usize) {
        let b = self.inp.as_bytes();
        let mut line = 1usize;
        let mut last: isize = -1;
        for (i, &c) in b.iter().enumerate().take(at.min(b.len())) {
            if c == b'\\n' {
                line += 1;
                last = i as isize;
            }
        }
        (line, (at as isize - last) as usize)
    }

    fn perr(&self, code: &'static str) -> PErr {
        let (l, c) = self.line_col(self.ts);
        PErr::Syntax(SyntaxError { message: format!("parse error at line {l}:{c}"), line: l, column: c, code: Some(code) })
    }

    fn perr_exp(&self, kind: u16) -> PErr {
        let (l, c) = self.line_col(self.ts);
        PErr::Syntax(SyntaxError {
            message: format!("expected {} but got {} at line {l}:{c}", TOKEN_NAMES[kind as usize], TOKEN_NAMES[self.tk as usize]),
            line: l, column: c, code: Some("UNEXPECTED_TOKEN"),
        })
    }

    fn perr_alt(&self, kinds: &[u16]) -> PErr {
        let (l, c) = self.line_col(self.ts);
        let names: Vec<&str> = kinds.iter().map(|&k| TOKEN_NAMES[k as usize]).collect();
        PErr::Syntax(SyntaxError {
            message: format!("expected one of {} but got {} at line {l}:{c}", names.join(", "), TOKEN_NAMES[self.tk as usize]),
            line: l, column: c, code: Some("UNEXPECTED_TOKEN"),
        })
    }

    fn lex_err(&self) -> PErr {
        let (l, c) = self.line_col(self.pos);
        PErr::Syntax(SyntaxError { message: format!("unrecognized token at line {l}:{c}"), line: l, column: c, code: Some("LEX") })
    }

    fn outcome(&self) -> ParseOutcome {
        ParseOutcome {
            ${outcomeInit.join('\n            ')}
        }
    }
${lex.nextTokenCode}

/* ---- productions ---- */

${parserOut.code}

    /* ---- drivers ---- */

    fn parse_all(&mut self) -> Result<(), PErr> {
        self.depth = 0;
        self.next_token()?;
        self.p_${g.headers.start}()?;
        if self.tk != T_EOF {
            return Err(self.perr_alt(&[T_EOF]));
        }
        Ok(())
    }

${stmtProd !== null ? `    /// Push-mode statement loop. Parses statements until the buffer is
    /// exhausted; an INCOMPLETE suspension rolls the current statement back
    /// (fresh counter, label bindings, buffered triples) and reports the
    /// carry point. Memory held across chunks is O(current statement).
    fn parse_chunk(&mut self) -> Result<Option<usize>, SyntaxError> {
        self.depth = 0;
        let mut stmt_start = 0usize;
        let mut cp_fresh = self.fresh_ctr;
        match self.parse_chunk_loop(&mut stmt_start, &mut cp_fresh) {
            Ok(()) => Ok(None),
            Err(PErr::Incomplete) => {
                self.fresh_ctr = cp_fresh;
${hasLabels ? `                for k in std::mem::take(&mut self.trail) {
                    self.env_labels.remove(&k);
                }` : ''}
                self.stmt_buf.clear();
                Ok(Some(stmt_start))
            }
            Err(PErr::Syntax(e)) => Err(e),
        }
    }

    fn parse_chunk_loop(&mut self, stmt_start: &mut usize, cp_fresh: &mut u64) -> Result<(), PErr> {
        self.next_token()?;
        loop {
            if self.tk == T_EOF {
                return Ok(());
            }
            *stmt_start = self.ts;
            *cp_fresh = self.fresh_ctr;
${hasLabels ? '            self.trail.clear();' : ''}
            self.stmt_buf.clear();
            self.p_${stmtProd}()?;
            for q in self.stmt_buf.drain(..) {
                (self.on_quad)(q);
            }
        }
    }` : `    /// Push-mode fallback for a document-shaped start production (not a
    /// statement star): accumulate the whole document and parse once at
    /// end. Memory is O(document) — fine for the small documents such
    /// grammars describe; a statement-level loop would need FOLLOW-driven
    /// phase transitions in this driver.
    fn parse_chunk(&mut self) -> Result<Option<usize>, SyntaxError> {
        if !self.is_final {
            return Ok(Some(0));
        }
        self.push_mode = false;
        match self.parse_all() {
            Ok(()) => Ok(None),
            Err(PErr::Syntax(e)) => Err(e),
            Err(PErr::Incomplete) => Err(SyntaxError { message: "unexpected end of input".to_string(), line: 0, column: 0, code: Some("EOF") }),
        }
    }`}
}

/* ==================================================================
 * Public API
 * ================================================================== */

/// One-shot parse of a complete document string; \`on_quad\` receives each
/// triple as it is emitted (streaming, earliest-emission order).
pub fn parse<F: FnMut(Triple)>(input: &str, base_iri: Option<&str>, on_quad: F) -> Result<ParseOutcome, SyntaxError> {
    let mut m = Machine::new(base_iri, false, on_quad);
    m.set_input(Cow::Borrowed(input), true);
    match m.parse_all() {
        Ok(()) => Ok(m.outcome()),
        Err(PErr::Syntax(e)) => Err(e),
        Err(PErr::Incomplete) => Err(SyntaxError { message: "unexpected end of input".to_string(), line: 0, column: 0, code: Some("EOF") }),
    }
}

/// Convenience: parse a complete document to a Vec of triples.
pub fn parse_to_triples(input: &str) -> Result<(Vec<Triple>, ParseOutcome), SyntaxError> {
    let mut quads = Vec::new();
    let outcome = parse(input, None, |q| quads.push(q))?;
    Ok((quads, outcome))
}

/// Chunked push parser with bounded memory: only the current (incomplete)
/// statement is retained between \`push\` calls.
pub struct PushParser<F: FnMut(Triple)> {
    m: Machine<'static, F>,
    carry: String,
    ended: bool,
}

impl<F: FnMut(Triple)> PushParser<F> {
    /// Create a push parser; \`on_quad\` receives each triple as its
    /// statement completes.
    pub fn new(base_iri: Option<&str>, on_quad: F) -> PushParser<F> {
        PushParser { m: Machine::new(base_iri, true, on_quad), carry: String::new(), ended: false }
    }

    /// Feed one chunk. Chunks may split the document anywhere (including
    /// mid-token); the parser suspends and resumes at statement granularity.
    pub fn push(&mut self, chunk: &str) -> Result<(), SyntaxError> {
        if self.ended {
            return Err(SyntaxError { message: "push after end".to_string(), line: 0, column: 0, code: Some("PUSH_AFTER_END") });
        }
        let s = if self.carry.is_empty() {
            chunk.to_string()
        } else {
            let mut s = std::mem::take(&mut self.carry);
            s.push_str(chunk);
            s
        };
        self.m.set_input(Cow::Owned(s), false);
        match self.m.parse_chunk() {
            Ok(None) => { self.carry.clear(); Ok(()) }
            Ok(Some(idx)) => { self.carry = self.m.inp[idx..].to_string(); Ok(()) }
            Err(e) => { self.ended = true; Err(e) }
        }
    }

    /// Finish the document, flushing any carried statement.
    pub fn end(mut self) -> Result<ParseOutcome, SyntaxError> {
        self.ended = true;
        let s = std::mem::take(&mut self.carry);
        self.m.set_input(Cow::Owned(s), true);
        match self.m.parse_chunk() {
            Ok(None) => Ok(self.m.outcome()),
            Ok(Some(_)) => Err(SyntaxError { message: "unexpected end of input".to_string(), line: 0, column: 0, code: Some("EOF") }),
            Err(e) => Err(e),
        }
    }

    /// Bytes currently carried (the incomplete trailing statement).
    pub fn pending(&self) -> usize {
        self.carry.len()
    }
}
${ser.code}`;

  return { code, grammar: g };
}
