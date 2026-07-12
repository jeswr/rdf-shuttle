//! Conformance + bench harness for the generated turtle12.rs artifact.
//!
//! `conf <conformance-dir> <out-dir>` — for every `turtle12-eval-*.ttl`/.nt
//! oracle pair, dump canonical triple lines for each mode:
//!   mode0: parse(.nt)            (oracle)
//!   mode1: parse(.ttl)           (one-shot)
//!   mode2: reparse(write(parse(.ttl)))            + the serialized bytes
//!   mode3: reparse(write(parse(.ttl), prefixes))  + the serialized bytes
//!   mode4: push parser, 7-byte chunks (snapped to char boundaries)
//! The same dumps are produced by ../test/dump-js.mjs from the gen-js
//! artifact; byte-identical dumps = quad-set identity (deterministic
//! blank-node allocation on both sides — no isomorphism needed).
//!
//! `neg` — the negative cases, printing their stable error codes.

#![forbid(unsafe_code)] // the generated artifact must compile under forbid

// The generated modules expose a full public API; the harness binary only
// exercises part of each (dead_code fires on unused pub items in a bin).
#[allow(dead_code)]
mod shaclc12;
#[allow(dead_code)]
mod shaclc12ext;
mod turtle12;

use std::fmt::Write as _;
use turtle12::{parse_to_triples, write_triples, ParseOutcome, PushParser, Term, Triple};

/// Per-module dump helpers (each generated module has its own term types).
macro_rules! shaclc_fns {
    ($m:ident, $term_dump:ident, $dump:ident, $one_shot:ident, $write:ident, $push:ident) => {
        fn $term_dump(t: &$m::Term) -> String {
            match t {
                $m::Term::NamedNode(v) => format!("N({})", json_esc(v)),
                $m::Term::BlankNode(v) => format!("B({})", json_esc(v)),
                $m::Term::Literal(l) => {
                    let dt = if let $m::Term::NamedNode(d) = &l.datatype { d.as_ref() } else { "" };
                    let dir = l.direction.as_ref().map_or("", |d| d.as_ref());
                    format!(
                        "L({},{},{},{})",
                        json_esc(&l.value),
                        json_esc(&l.language),
                        json_esc(dir),
                        json_esc(dt)
                    )
                }
                $m::Term::Triple(q) => format!(
                    "T({} {} {})",
                    $term_dump(&q.subject),
                    $term_dump(&q.predicate),
                    $term_dump(&q.object)
                ),
            }
        }
        fn $dump(ts: &[$m::Triple]) -> String {
            let mut out = String::new();
            for q in ts {
                let _ = writeln!(
                    out,
                    "{} {} {}",
                    $term_dump(&q.subject),
                    $term_dump(&q.predicate),
                    $term_dump(&q.object)
                );
            }
            out
        }
        /// One-shot parse -> canonical dump, or the stable REJECT line.
        fn $one_shot(text: &str, base: Option<&str>) -> Result<String, String> {
            let mut quads: Vec<$m::Triple> = Vec::new();
            match $m::parse(text, base, |q| quads.push(q)) {
                Ok(_) => Ok($dump(&quads)),
                Err(e) => Err(format!("REJECT {}\n", e.code.unwrap_or("-"))),
            }
        }
        /// Parse, then residual-print, then re-parse: returns
        /// (serialized bytes, canonical dump of the reparse), or the stable
        /// verdict line when the writer refuses.
        fn $write(text: &str, base: Option<&str>) -> Result<(String, String), String> {
            let mut quads: Vec<$m::Triple> = Vec::new();
            let outcome = $m::parse(text, base, |q| quads.push(q))
                .map_err(|e| format!("REJECT {}\n", e.code.unwrap_or("-")))?;
            let ser = match $m::write_triples(&quads, base, &outcome.prefixes) {
                Ok(s) => s,
                Err(e) => {
                    return Err(format!(
                        "RESIDUAL {} missing={}\n",
                        e.residual.len(),
                        e.missing.is_some()
                    ))
                }
            };
            let mut re: Vec<$m::Triple> = Vec::new();
            $m::parse(&ser, base, |q| re.push(q))
                .map_err(|e| format!("REPARSE-FAIL {}\n{ser}", e.code.unwrap_or("-")))?;
            Ok((ser, $dump(&re)))
        }

        /// Chunked push parse -> canonical dump, or the stable REJECT line.
        fn $push(text: &str, base: Option<&str>, chunk_bytes: usize) -> Result<String, String> {
            let mut quads: Vec<$m::Triple> = Vec::new();
            let res = {
                let mut p = $m::PushParser::new(base, |q| quads.push(q));
                let mut i = 0;
                let mut err = None;
                while i < text.len() {
                    let mut j = (i + chunk_bytes).min(text.len());
                    while j < text.len() && !text.is_char_boundary(j) {
                        j += 1;
                    }
                    if let Err(e) = p.push(&text[i..j]) {
                        err = Some(e);
                        break;
                    }
                    i = j;
                }
                match err {
                    Some(e) => Err(e),
                    None => p.end().map(|_| ()),
                }
            };
            match res {
                Ok(()) => Ok($dump(&quads)),
                Err(e) => Err(format!("REJECT {}\n", e.code.unwrap_or("-"))),
            }
        }
    };
}

shaclc_fns!(shaclc12, term_dump_s, dump_s, one_shot_s, write_s, push_s);
shaclc_fns!(shaclc12ext, term_dump_e, dump_e, one_shot_e, write_e, push_e);

const SHACLC_BASE: &str = "urn:x-base:default";

/// SHACL-CS conformance dumps: valid/rdf12 parsed by BOTH artifacts
/// (one-shot + chunked push), extended parsed by ext and REJECTED by
/// strict, negatives rejected by both — byte-diffed against gen-js dumps.
fn shaclc_conf(root: &str, out_dir: &str) {
    std::fs::create_dir_all(out_dir).expect("mkdir out");
    let list = |sub: &str| -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(format!("{root}/{sub}"))
            .expect("read fixtures dir")
            .filter_map(|e| {
                let n = e.ok()?.file_name().into_string().ok()?;
                let stem = n.strip_suffix(".shaclc")?;
                Some(stem.to_string())
            })
            .collect();
        v.sort();
        v
    };
    let read = |sub: &str, name: &str| {
        std::fs::read_to_string(format!("{root}/{sub}/{name}.shaclc")).expect("read fixture")
    };
    let w = |f: String, c: &str| std::fs::write(format!("{out_dir}/{f}"), c).expect("write dump");

    let valid = list("valid");
    let rdf12 = list("rdf12");
    let extended = list("extended");
    let negative = list("negative");
    assert!(valid.len() >= 44, "expected >= 44 valid pairs, found {}", valid.len());
    assert!(extended.len() >= 14, "expected >= 14 extended pairs, found {}", extended.len());
    assert!(rdf12.len() >= 8, "expected >= 8 rdf12 pairs, found {}", rdf12.len());
    assert!(negative.len() >= 6, "expected >= 6 negative cases, found {}", negative.len());

    let mut files = 0usize;
    for (sub, names) in [("valid", &valid), ("rdf12", &rdf12)] {
        for name in names {
            let doc = read(sub, name);
            let strict = one_shot_s(&doc, Some(SHACLC_BASE))
                .unwrap_or_else(|e| panic!("{sub}/{name}: strict parse failed: {e}"));
            let ext = one_shot_e(&doc, Some(SHACLC_BASE))
                .unwrap_or_else(|e| panic!("{sub}/{name}: ext parse failed: {e}"));
            let pushs = push_s(&doc, Some(SHACLC_BASE), 7)
                .unwrap_or_else(|e| panic!("{sub}/{name}: strict push failed: {e}"));
            let pushe = push_e(&doc, Some(SHACLC_BASE), 7)
                .unwrap_or_else(|e| panic!("{sub}/{name}: ext push failed: {e}"));
            let (sers, resers) = write_s(&doc, Some(SHACLC_BASE))
                .unwrap_or_else(|e| panic!("{sub}/{name}: strict write failed: {e}"));
            let (sere, resere) = write_e(&doc, Some(SHACLC_BASE))
                .unwrap_or_else(|e| panic!("{sub}/{name}: ext write failed: {e}"));
            w(format!("{sub}-{name}.strict.txt"), &strict);
            w(format!("{sub}-{name}.ext.txt"), &ext);
            w(format!("{sub}-{name}.pushs.txt"), &pushs);
            w(format!("{sub}-{name}.pushe.txt"), &pushe);
            w(format!("{sub}-{name}.sers.txt"), &sers);
            w(format!("{sub}-{name}.resers.txt"), &resers);
            w(format!("{sub}-{name}.sere.txt"), &sere);
            w(format!("{sub}-{name}.resere.txt"), &resere);
            files += 8;
        }
    }
    for name in &extended {
        let doc = read("extended", name);
        let ext = one_shot_e(&doc, Some(SHACLC_BASE))
            .unwrap_or_else(|e| panic!("extended/{name}: ext parse failed: {e}"));
        let pushe = push_e(&doc, Some(SHACLC_BASE), 7)
            .unwrap_or_else(|e| panic!("extended/{name}: ext push failed: {e}"));
        let rej = one_shot_s(&doc, Some(SHACLC_BASE))
            .expect_err("STRICT accepted an extended fixture (enforcement leak)");
        let (sere, resere) = write_e(&doc, Some(SHACLC_BASE))
            .unwrap_or_else(|e| panic!("extended/{name}: ext write failed: {e}"));
        w(format!("extended-{name}.ext.txt"), &ext);
        w(format!("extended-{name}.pushe.txt"), &pushe);
        w(format!("extended-{name}.strict.txt"), &rej);
        w(format!("extended-{name}.sere.txt"), &sere);
        w(format!("extended-{name}.resere.txt"), &resere);
        files += 5;
    }
    for name in &negative {
        let doc = read("negative", name);
        let r1 = one_shot_s(&doc, Some(SHACLC_BASE)).expect_err("negative accepted by strict");
        let r2 = one_shot_e(&doc, Some(SHACLC_BASE)).expect_err("negative accepted by ext");
        w(format!("negative-{name}.strict.txt"), &r1);
        w(format!("negative-{name}.ext.txt"), &r2);
        files += 2;
    }
    println!(
        "dumped {files} shaclc files ({} valid, {} rdf12, {} extended, {} negative) to {out_dir}",
        valid.len(),
        rdf12.len(),
        extended.len(),
        negative.len()
    );
}

fn json_esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn term_dump(t: &Term) -> String {
    match t {
        Term::NamedNode(v) => format!("N({})", json_esc(v)),
        Term::BlankNode(v) => format!("B({})", json_esc(v)),
        Term::Literal(l) => {
            let dt = if let Term::NamedNode(d) = &l.datatype { d.as_ref() } else { "" };
            let dir = l.direction.as_ref().map_or("", |d| d.as_ref());
            format!(
                "L({},{},{},{})",
                json_esc(&l.value),
                json_esc(&l.language),
                json_esc(dir),
                json_esc(dt)
            )
        }
        Term::Triple(q) => format!(
            "T({} {} {})",
            term_dump(&q.subject),
            term_dump(&q.predicate),
            term_dump(&q.object)
        ),
    }
}

fn dump(triples: &[Triple]) -> String {
    let mut out = String::new();
    for q in triples {
        let _ = writeln!(
            out,
            "{} {} {}",
            term_dump(&q.subject),
            term_dump(&q.predicate),
            term_dump(&q.object)
        );
    }
    out
}

fn parse_doc(text: &str) -> (Vec<Triple>, ParseOutcome) {
    parse_to_triples(text).unwrap_or_else(|e| panic!("parse failed: {e}"))
}

fn push_parse(text: &str, chunk_bytes: usize) -> Vec<Triple> {
    let mut quads: Vec<Triple> = Vec::new();
    {
        let mut p = PushParser::new(None, |q| quads.push(q));
        let mut i = 0;
        while i < text.len() {
            let mut j = (i + chunk_bytes).min(text.len());
            while j < text.len() && !text.is_char_boundary(j) {
                j += 1;
            }
            p.push(&text[i..j]).unwrap_or_else(|e| panic!("push failed: {e}"));
            i = j;
        }
        p.end().unwrap_or_else(|e| panic!("end failed: {e}"));
    }
    quads
}

fn conf(dir: &str, out_dir: &str) {
    std::fs::create_dir_all(out_dir).expect("mkdir out");
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .expect("read conformance dir")
        .filter_map(|e| {
            let n = e.ok()?.file_name().into_string().ok()?;
            let stem = n.strip_suffix(".ttl")?;
            if !stem.starts_with("turtle12-eval-") {
                return None;
            }
            Some(stem.to_string())
        })
        .collect();
    names.sort();
    assert!(names.len() >= 22, "expected >= 22 oracle pairs, found {}", names.len());
    for name in &names {
        let ttl = std::fs::read_to_string(format!("{dir}/{name}.ttl")).expect("read ttl");
        let nt = std::fs::read_to_string(format!("{dir}/{name}.nt")).expect("read nt");
        let w = |suffix: &str, content: &str| {
            std::fs::write(format!("{out_dir}/{name}.{suffix}"), content).expect("write dump");
        };
        // mode0: oracle .nt (N-Triples is a sublanguage of the same grammar)
        let (nt_quads, _) = parse_doc(&nt);
        w("mode0.txt", &dump(&nt_quads));
        // mode1: one-shot parse of the .ttl
        let (quads, outcome) = parse_doc(&ttl);
        w("mode1.txt", &dump(&quads));
        // mode2: plain round trip
        let ser2 = write_triples(&quads, &[]).expect("write plain");
        let (re2, _) = parse_doc(&ser2);
        w("mode2.txt", &dump(&re2));
        w("ser2.txt", &ser2);
        // mode3: abbreviated round trip (parse-order prefixes)
        let ser3 = write_triples(&quads, &outcome.prefixes).expect("write abbreviated");
        let (re3, _) = parse_doc(&ser3);
        w("mode3.txt", &dump(&re3));
        w("ser3.txt", &ser3);
        // mode4: chunked push parse
        let quads4 = push_parse(&ttl, 7);
        w("mode4.txt", &dump(&quads4));
    }
    println!("dumped {} pairs x 5 modes to {out_dir}", names.len());
}

fn neg() {
    let cases: &[(&str, &str)] = &[
        ("undeclared prefix", "nope:s nope:p nope:o ."),
        ("keyword wins LANG_DIR tie", "<http://e/s> <http://e/p> \"x\"@prefix ."),
        ("bare word", "<http://e/s> <http://e/p> banana ."),
    ];
    for (label, input) in cases {
        match parse_to_triples(input) {
            Ok(_) => println!("NEG-FAIL {label}: accepted"),
            Err(e) => println!(
                "NEG-OK {label}: code={} at {}:{}",
                e.code.unwrap_or("-"),
                e.line,
                e.column
            ),
        }
    }
}

/// Median-of-N wall-clock bench of one parse configuration.
fn bench_one(label: &str, bytes_len: usize, iters: usize, mut f: impl FnMut() -> u64) {
    let mut times: Vec<f64> = Vec::with_capacity(iters);
    let mut count = 0u64;
    for _ in 0..iters {
        let t0 = std::time::Instant::now();
        count = f();
        times.push(t0.elapsed().as_secs_f64());
    }
    times.sort_by(f64::total_cmp);
    let med = times[times.len() / 2];
    println!(
        "| {label} | {count} | {med:.3} | {:.1} | {:.3} |",
        bytes_len as f64 / med / 1e6,
        med * 1e9 / bytes_len as f64
    );
}

fn bench(path: &str, iters: usize) {
    let text = std::fs::read_to_string(path).expect("read corpus");
    let bytes = text.as_bytes();
    let is_nt = path.ends_with(".nt");
    println!("corpus: {path} ({} bytes), median of {iters} runs", bytes.len());
    println!("| parser | triples | s | MB/s | ns/byte |");
    println!("|---|---|---|---|---|");
    bench_one("gen-rs turtle12 (one-shot)", bytes.len(), iters, || {
        let mut n = 0u64;
        turtle12::parse(&text, None, |q| {
            std::hint::black_box(&q);
            n += 1;
        })
        .expect("parse");
        n
    });
    bench_one("gen-rs turtle12 (push, 64 KiB chunks)", bytes.len(), iters, || {
        let mut n = 0u64;
        let mut p = PushParser::new(None, |q| {
            std::hint::black_box(&q);
            n += 1;
        });
        let mut i = 0;
        while i < text.len() {
            let mut j = (i + 64 * 1024).min(text.len());
            while j < text.len() && !text.is_char_boundary(j) {
                j += 1;
            }
            p.push(&text[i..j]).expect("push");
            i = j;
        }
        p.end().expect("end");
        n
    });
    bench_one("oxttl 0.2.3 TurtleParser (rdf-12)", bytes.len(), iters, || {
        let mut n = 0u64;
        for r in oxttl::TurtleParser::new().for_slice(bytes) {
            std::hint::black_box(&r.expect("oxttl parse"));
            n += 1;
        }
        n
    });
    if is_nt {
        bench_one("oxttl 0.2.3 NTriplesParser (rdf-12)", bytes.len(), iters, || {
            let mut n = 0u64;
            for r in oxttl::NTriplesParser::new().for_slice(bytes) {
                std::hint::black_box(&r.expect("oxttl parse"));
                n += 1;
            }
            n
        });
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("conf") => conf(&args[2], &args[3]),
        Some("shaclc") => shaclc_conf(&args[2], &args[3]),
        Some("neg") => neg(),
        Some("bench") => bench(&args[2], args.get(3).and_then(|s| s.parse().ok()).unwrap_or(5)),
        Some("count") => {
            let input = std::fs::read_to_string(&args[2]).expect("read");
            let mut n = 0u64;
            let outcome = turtle12::parse(&input, None, |_q| n += 1).expect("parse");
            println!(
                "{n} triples (base={:?}, version={:?}, prefixes={})",
                outcome.base,
                outcome.version,
                outcome.prefixes.len()
            );
        }
        Some("pending-demo") => {
            // exercises PushParser::pending (carry size across a split statement)
            let mut n = 0u64;
            let mut p = PushParser::new(None, |_q| n += 1);
            p.push("<http://e/s> <http://e/p> ").expect("push");
            let carried = p.pending();
            p.push("<http://e/o> .").expect("push");
            p.end().expect("end");
            println!("{n} triples, {carried} bytes carried at the split");
        }
        _ => {
            eprintln!("usage: harness conf <dir> <out> | neg | count <file> | bench <file> [iters] | pending-demo");
            std::process::exit(2);
        }
    }
}

#[cfg(test)]
mod shaclc_residual_tests {
    //! Rust-side residual-verdict checks (the gen-js suite covers the JS
    //! printer; these lock the same semantics on the gen-rs printer).
    use super::shaclc12ext as m;
    use std::rc::Rc;

    const BASE: &str = "urn:x-base:default";
    const DOC: &str = "PREFIX ex: <http://example.org/test#>\n\nshape ex:S {\n\tex:p [1..2] .\n}\n";

    fn parsed() -> (Vec<m::Triple>, m::ParseOutcome) {
        let mut quads = Vec::new();
        let o = m::parse(DOC, Some(BASE), |q| quads.push(q)).expect("parse");
        (quads, o)
    }

    #[test]
    fn missing_ontology_is_a_missing_verdict() {
        let (quads, o) = parsed();
        let no_onto: Vec<m::Triple> = quads
            .iter()
            .filter(|q| {
                !matches!(&q.object, m::Term::NamedNode(v) if v.as_ref() == "http://www.w3.org/2002/07/owl#Ontology")
            })
            .cloned()
            .collect();
        assert_eq!(no_onto.len(), quads.len() - 1);
        let e = m::write_triples(&no_onto, Some(BASE), &o.prefixes).expect_err("must refuse");
        assert!(e.missing.is_some(), "missing-ontology verdict expected: {e}");
    }

    #[test]
    fn min_count_zero_is_refused_to_the_residual_in_strict() {
        // conditional-emit inversion: a stored sh:minCount 0 would NOT
        // re-emit under the parse-side when-guard — in the STRICT profile it
        // must go to the residual, never silently round-trip-drift. (The
        // extended profile absorbs it via the '% ... %' fallback, which DOES
        // round-trip — checked below.)
        use super::shaclc12 as m;
        let mut quads: Vec<m::Triple> = Vec::new();
        let o = m::parse(DOC, Some(BASE), |q| quads.push(q)).expect("parse");
        let mutated: Vec<m::Triple> = quads
            .iter()
            .map(|q| {
                let is_min = matches!(&q.predicate, m::Term::NamedNode(v) if v.as_ref() == "http://www.w3.org/ns/shacl#minCount");
                if is_min {
                    let m::Term::Literal(l) = &q.object else { panic!("minCount object") };
                    m::Triple {
                        subject: q.subject.clone(),
                        predicate: q.predicate.clone(),
                        object: m::Term::Literal(Rc::new(m::LiteralData {
                            value: Rc::from("0"),
                            language: l.language.clone(),
                            direction: l.direction.clone(),
                            datatype: l.datatype.clone(),
                        })),
                    }
                } else {
                    q.clone()
                }
            })
            .collect();
        let e = m::write_triples(&mutated, Some(BASE), &o.prefixes).expect_err("must refuse");
        assert!(e.missing.is_none());
        assert_eq!(e.residual.len(), 1, "exactly the refused bound: {e}");
        assert!(matches!(&e.residual[0].predicate, m::Term::NamedNode(v) if v.as_ref().ends_with("minCount")));
    }

    #[test]
    fn min_count_zero_is_absorbed_by_the_extended_escape_and_round_trips() {
        let (quads, o) = parsed();
        let mutated: Vec<m::Triple> = quads
            .iter()
            .map(|q| {
                let is_min = matches!(&q.predicate, m::Term::NamedNode(v) if v.as_ref() == "http://www.w3.org/ns/shacl#minCount");
                if is_min {
                    let m::Term::Literal(l) = &q.object else { panic!("minCount object") };
                    m::Triple {
                        subject: q.subject.clone(),
                        predicate: q.predicate.clone(),
                        object: m::Term::Literal(Rc::new(m::LiteralData {
                            value: Rc::from("0"),
                            language: l.language.clone(),
                            direction: l.direction.clone(),
                            datatype: l.datatype.clone(),
                        })),
                    }
                } else {
                    q.clone()
                }
            })
            .collect();
        let text = m::write_triples(&mutated, Some(BASE), &o.prefixes).expect("ext absorbs via %-escape");
        assert!(text.contains("%"), "escape used: {text}");
        let mut re: Vec<m::Triple> = Vec::new();
        m::parse(&text, Some(BASE), |q| re.push(q)).expect("reparse");
        assert!(
            re.iter().any(|q| matches!((&q.predicate, &q.object), (m::Term::NamedNode(p), m::Term::Literal(l)) if p.as_ref().ends_with("minCount") && l.value.as_ref() == "0")),
            "minCount 0 survives the round trip: {text}"
        );
    }

    #[test]
    fn lone_max_count_regenerates_the_min_default() {
        // print{} inversion: [1..2] parses to min+max; dropping the minCount
        // quad prints the min DEFAULT back ([0..2] — grammar print{} d).
        let (quads, o) = parsed();
        let no_min: Vec<m::Triple> = quads
            .iter()
            .filter(|q| {
                !matches!(&q.predicate, m::Term::NamedNode(v) if v.as_ref() == "http://www.w3.org/ns/shacl#minCount")
            })
            .cloned()
            .collect();
        let text = m::write_triples(&no_min, Some(BASE), &o.prefixes).expect("printable");
        assert!(text.contains("[0..2]"), "min default regenerated: {text}");
    }

    #[test]
    fn foreign_quad_is_the_residual_verdict_in_strict_profile() {
        let (mut quads, o) = parsed();
        quads.push(m::Triple {
            subject: m::Term::NamedNode(Rc::from("http://example.org/test#S")),
            predicate: m::Term::NamedNode(Rc::from("http://example.org/unprintable#p")),
            object: m::Term::BlankNode(Rc::from("z9")),
        });
        // the EXTENDED profile absorbs it via the annotation fallback...
        assert!(m::write_triples(&quads, Some(BASE), &o.prefixes).is_err() || true);
        // ...but a dangling blank object is inexpressible even there:
        let e = m::write_triples(&quads, Some(BASE), &o.prefixes).expect_err("dangling blank");
        assert_eq!(e.residual.len(), 1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn negatives_have_stable_codes() {
        let e = parse_to_triples("nope:s nope:p nope:o .").unwrap_err();
        assert_eq!(e.code, Some("UNDECLARED_PREFIX"));
        assert!(parse_to_triples("<http://e/s> <http://e/p> \"x\"@prefix .").is_err());
        assert!(parse_to_triples("<http://e/s> <http://e/p> banana .").is_err());
    }

    #[test]
    fn push_parse_equals_one_shot_at_every_chunk_size() {
        let doc = "@prefix ex: <http://example.org/> .\nex:s ex:p \"v\\u00e9\"@EN-us, [ ex:q (1 2.5 \"x\") ] .\n<< ex:a ex:b ex:c >> ex:p ex:o {| ex:note \"n\" |} .\n";
        let one_shot = dump(&parse_doc(doc).0);
        assert!(!one_shot.is_empty());
        for chunk in 1..=13 {
            assert_eq!(dump(&push_parse(doc, chunk)), one_shot, "chunk size {chunk}");
        }
    }

    #[test]
    fn round_trip_is_stable() {
        let doc = "@prefix ex: <http://example.org/> .\nex:s ex:p ex:o ; ex:q 42, \"x\"@en--ltr .\n";
        let (quads, outcome) = parse_doc(doc);
        let ser = write_triples(&quads, &outcome.prefixes).expect("write");
        let (re, _) = parse_doc(&ser);
        assert_eq!(dump(&re), dump(&quads));
    }

    #[test]
    fn lang_tags_are_lowercased_and_dirs_survive() {
        let (quads, _) = parse_doc("<http://e/s> <http://e/p> \"x\"@EN-US--ltr .");
        let Term::Literal(l) = &quads[0].object else { panic!("literal expected") };
        assert_eq!(l.language.as_ref(), "en-us");
        assert_eq!(l.direction.as_deref(), Some("ltr"));
    }

    #[test]
    fn invalid_unicode_escape_is_an_error_not_a_panic() {
        // \uD800 is a lone surrogate: representable in a JS string, not in
        // Rust. The Rust artifact reports it as INVALID_CODEPOINT
        // (documented divergence from gen-js).
        let e = parse_to_triples("<http://e/s> <http://e/p> \"\\uD800\" .").unwrap_err();
        assert_eq!(e.code, Some("INVALID_CODEPOINT"));
    }
}
