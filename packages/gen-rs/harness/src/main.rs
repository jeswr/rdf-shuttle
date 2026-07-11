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

mod turtle12;

use std::fmt::Write as _;
use turtle12::{parse_to_triples, write_triples, ParseOutcome, PushParser, Term, Triple};

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

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("conf") => conf(&args[2], &args[3]),
        Some("neg") => neg(),
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
            eprintln!("usage: harness conf <conformance-dir> <out-dir> | neg | count <file> | pending-demo");
            std::process::exit(2);
        }
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
