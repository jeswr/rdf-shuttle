/**
 * iso.js — graph isomorphism check for conformance comparison (bnode
 * relabelling allowed, spec/SHUTTLE.md §8). Handles RDF 1.2 triple terms
 * (Quad-valued objects, possibly containing blank nodes) recursively.
 * Backtracking with degree-signature pruning; fine for the small oracle
 * graphs and the automorphism-free generated corpora.
 */

function termKey(t, bmap) {
  switch (t.termType) {
    case 'NamedNode': return `<${t.value}>`;
    case 'Literal':
      return `"${t.value}"@${t.language}--${t.direction || ''}^^${t.datatype ? t.datatype.value : ''}`;
    case 'BlankNode': {
      const m = bmap && bmap.get(t.value);
      return m !== undefined ? `_:${m}` : '_:?';
    }
    case 'Quad':
      return `<<(${termKey(t.subject, bmap)} ${termKey(t.predicate, bmap)} ${termKey(t.object, bmap)})>>`;
    case 'DefaultGraph': return '';
    default: throw new Error(`termKey: ${t.termType}`);
  }
}

function quadKey(q, bmap) {
  return `${termKey(q.subject, bmap)} ${termKey(q.predicate, bmap)} ${termKey(q.object, bmap)} ${termKey(q.graph, bmap)}`;
}

function collectBnodes(t, out) {
  if (t.termType === 'BlankNode') out.add(t.value);
  else if (t.termType === 'Quad') {
    collectBnodes(t.subject, out);
    collectBnodes(t.predicate, out);
    collectBnodes(t.object, out);
  }
}

export function bnodesOf(quads) {
  const out = new Set();
  for (const q of quads) {
    collectBnodes(q.subject, out);
    collectBnodes(q.object, out);
    collectBnodes(q.graph, out);
  }
  return [...out];
}

/** Ground signature of a bnode: multiset of its quad shapes with bnodes wildcarded. */
function signature(quads, b) {
  const parts = [];
  const wild = new Map(); // all bnodes -> '?'
  for (const q of quads) {
    const ids = new Set();
    collectBnodes(q.subject, ids); collectBnodes(q.object, ids); collectBnodes(q.graph, ids);
    if (ids.has(b)) parts.push(quadKey(q, wild));
  }
  return parts.sort().join('\n');
}

export function isIsomorphic(quadsA, quadsB) {
  if (quadsA.length !== quadsB.length) return false;
  const bA = bnodesOf(quadsA);
  const bB = bnodesOf(quadsB);
  if (bA.length !== bB.length) return false;

  // fast path: no bnodes
  const setB = (bmapA, bmapB) => {
    const sa = quadsA.map((q) => quadKey(q, bmapA)).sort();
    const sb = quadsB.map((q) => quadKey(q, bmapB)).sort();
    return sa.every((x, i) => x === sb[i]);
  };
  if (bA.length === 0) return setB(null, null);

  // candidate sets by signature
  const sigA = new Map(bA.map((b) => [b, signature(quadsA, b)]));
  const sigB = new Map(bB.map((b) => [b, signature(quadsB, b)]));
  const cands = new Map();
  for (const a of bA) {
    const c = bB.filter((b) => sigB.get(b) === sigA.get(a));
    if (c.length === 0) return false;
    cands.set(a, c);
  }
  const order = [...bA].sort((x, y) => cands.get(x).length - cands.get(y).length);
  const used = new Set();
  const mapping = new Map();

  const tryAssign = (i) => {
    if (i === order.length) {
      const bmapA = mapping;
      const idB = new Map(bB.map((b) => [b, b]));
      return setB(bmapA, idB);
    }
    const a = order[i];
    for (const b of cands.get(a)) {
      if (used.has(b)) continue;
      used.add(b);
      mapping.set(a, b);
      if (tryAssign(i + 1)) return true;
      used.delete(b);
      mapping.delete(a);
    }
    return false;
  };
  return tryAssign(0);
}

export function canonLines(quads) {
  return quads.map((q) => quadKey(q, new Map())).sort().join('\n');
}
