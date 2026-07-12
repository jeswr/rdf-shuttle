/** sq-uyney synthetic >128-token-kind fixture grammar. */
export function syntheticGrammar(keywords) {
  const alts = [];
  for (let i = 0; i < keywords; i++) {
    const n = String(i).padStart(3, '0');
    alts.push(`    ${i === 0 ? '::=' : '  |'} 'kw${n}' { value = <http://synthetic.example/p/${n}> }`);
  }
  return `grammar synthetic${keywords} ;
target rdf-1.2 ;
spec-ref "synthetic mask-fallback fixture" ;
start doc ;
emits triples ;
profile synthetic ;
import core-terms ;

env {
  base : iri = <> ;
}

token WS : unit ::= [\\u0020\\u0009\\u000D\\u000A]+ ;
token IRIREF : string ::= '<' [^\\u0000-\\u0020<>"{}|^\`\\\\]* '>' => body ;

doc : graph ::= stmt* ;

stmt : graph [emits, reads env.base]
  ::= s=IRIREF ( k=kw o=IRIREF { emit resolve(env.base, s) k resolve(env.base, o) } )* '.' ;

kw : term
${alts.join('\n')}
  ;
`;
}
