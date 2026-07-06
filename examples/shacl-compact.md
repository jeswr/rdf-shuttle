# Worked example: SHACL Compact Syntax

Same formalism, different vocabulary — this is the test that Shuttle is a
grammar *formalism* and not a Turtle generator. It also shows the three
mechanisms Turtle does not exercise: oracles, conditional emission with
inversion, and print partiality as an expressibility decision procedure.

**What it replaces:** shaclc-js's jison grammar threads
`Parser.currentNodeShape` / `Parser.currentPropertyNode` / a hand-rolled
`nodeShapeStack` as mutable globals. In Shuttle the focus node is a typed
inherited parameter, so nesting can never clobber state — and the *writer*
(the missing half of the shaclc-js ecosystem) falls out of the same file.

## Grammar (excerpt)

```
grammar shaclc ; target rdf-1.2 ; start shaclcDoc ; emits triples ; profile shaclc ;
@oracle xsdDatatype(iri) ;          // RDF-recognized datatype registry, declared side condition

shaclcDoc : graph ::= directive* ( nodeShape | shapeClass )*
  { emit resolve(env.base, "") rdf:type owl:Ontology } ;

nodeShape : graph ::= 'shape' n=iri { emit n rdf:type sh:NodeShape }
  targetClass(n)? nodeShapeBody(n) ;

targetClass(n: subjT) : graph ::= '->' ( c=iri { emit n sh:targetClass c } )+ ;
nodeShapeBody(n: subjT) : graph ::= '{' constraint(n)* '}' ;   // n auto-copies down

propertyShape(n: subjT) : graph [emits, gen]
  ::= p=path { fresh ps ; emit n sh:property ps ; emit ps sh:path p }
      ( propertyCount(ps) | propertyAtom(ps) )* '.' ;

propertyCount(ps: subjT) : graph
  ::= '[' mn=INTEGER '..' mx=( m=INTEGER | '*' ) ']'
  { emit ps sh:minCount literal(mn, xsd:integer) when int(mn) > 0 ;
    emit ps sh:maxCount literal(mx, xsd:integer) when mx != * }
  print { mn = lookup(ps, sh:minCount) ?? 0 ; mx = lookup(ps, sh:maxCount) ?? * } ;

propertyAtom(ps: subjT) : graph
  ::= dt=iri  { oracle xsdDatatype(dt) -> emit ps sh:datatype dt ;
                otherwise             -> emit ps sh:class dt }
    | k=NODEKIND        { emit ps sh:nodeKind iri(SH + k) }
    | '@' ref=iri       { emit ps sh:node ref }
    | prm=PARAM '=' v=iriOrLiteralOrArray { emit ps iri(SH + prm) v }
  print fallback turtleAnnotation ;    // SHACL-C's extended-Turtle section, per its spec
```

## Input

```
BASE <http://ex.org/shapes>
PREFIX ex: <http://ex.org/>
shape ex:PersonShape -> ex:Person {
  ex:ssn xsd:string [0..1] pattern="^\\d{3}-\\d{2}-\\d{4}$" .
}
```

## Parse direction: exact triples, in stream order

Matches shaclc-js behavior, including its `min > 0` guard and `*` omission.

```
E1  ex:PersonShape rdf:type sh:NodeShape .
E2  ex:PersonShape sh:targetClass ex:Person .
E3  ex:PersonShape sh:property _:b0 .
E4  _:b0 sh:path ex:ssn .
E5  _:b0 sh:datatype xsd:string .           # oracle: xsd:string IS a recognized datatype
E6  _:b0 sh:maxCount "1"^^xsd:integer .     # minCount 0 suppressed by `when int(mn) > 0`
E7  _:b0 sh:pattern "^\\d{3}-\\d{2}-\\d{4}$" .
E8  <http://ex.org/shapes> rdf:type owl:Ontology .   # doc-level clause at end of shaclcDoc
```

## Print direction: three showpieces

1. **The oracle never runs backward.** The consumed quad's predicate
   discharges it: an `sh:datatype` quad selects the first branch, an
   `sh:class` quad the second. So `sh:class xsd:string` can never mis-print as
   a bare IRI that would re-parse as `sh:datatype`.

2. **Conditional-emit inversion.** A property shape with no `sh:minCount` quad
   forces the `when` clause false; `INTEGER ≥ 0` pins `mn = 0`, and the
   `print { … ?? 0 / … ?? * }` defaults regenerate `[0..1]` exactly —
   round-tripping despite only `sh:maxCount` having been emitted.

3. **Partiality as a feature.** A shape carrying, say, `sh:sparql` constraints
   leaves a non-empty residual after all sugar alternatives; the declared
   `turtleAnnotation` fallback absorbs what it can, and anything still left
   produces a residual report. The generated writer is, for free, a decision
   procedure for "is this graph SHACL-C-expressible" — which the hand-written
   ecosystem only approximates ad hoc. (This is law L3's SHACL-C reading in
   [`spec/SHUTTLE.md` §7](../spec/SHUTTLE.md).)
