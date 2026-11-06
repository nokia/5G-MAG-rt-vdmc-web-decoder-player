/**
 * © 2026 Nokia
 *
 * Licensed under the 5G-MAG Public License (v1.0)
 */

// subdivNumbering.mjs
// Universal V-DMC midpoint-subdivision vertex numbering (dIdx) for ANY level.
//
// Everything derives from a faithful
// port of the C++ numbering rules in mesh.hpp:
//   initializeSubdiv  -> base edges, edges[] index == midpoint vertex index
//   SubdivideMidPoint -> midpoint vertex index == its edge's array index
//   UpdateEdgeAndFace -> Block A (edge split-children), Block B (interior edges),
//                        triangle split (center + 3 corner children)
//
// buildCanonicalDescriptors(level) runs a structural replay ONCE on a single
// canonical triangle (3 verts, 1 tri) to derive, for every pattern vertex, a
// closed-form "recipe". computeDIdx then evaluates that recipe per render-instance
// using only:
//    inst.c[3]   = global indices of the 3 base-triangle corners
//    inst.ebm[3] = global base-edge indices of the 3 local edges (edgeTable)
//    inst.tbm    = global base-triangle index
//    counts      = cumulative V/E/T counts per level
// No mesh subdivision happens at evaluation time. This mirrors exactly what the
// WebGL2 vertex shader will do.

//============================================================================
// Cumulative counts: V[L] verts, E[L] edges, T[L] tris after L subdivisions.
//============================================================================
export function cumulativeCounts(V0, E0, T0, level) {
  const V = [V0], E = [E0], T = [T0];
  for (let i = 0; i < level; i++) {
    V.push(V[i] + E[i]);
    E.push(2 * E[i] + 3 * T[i]);
    T.push(4 * T[i]);
  }
  return { V, E, T };
}

//============================================================================
// Sparse barycentric vectors over the base-vertex basis (exact, dyadic).
//============================================================================
function vBasis(i) { return new Map([[i, 1]]); }
function vAvg(a, b) {
  const out = new Map();
  for (const [k, w] of a) out.set(k, (out.get(k) || 0) + w * 0.5);
  for (const [k, w] of b) out.set(k, (out.get(k) || 0) + w * 0.5);
  return out;
}
function vKey(m) {
  return [...m.entries()]
    .filter(([, w]) => Math.abs(w) > 1e-12)
    .sort((x, y) => x[0] - y[0])
    .map(([k, w]) => `${k}:${Math.round(w * 1048576)}`)
    .join('|');
}

//============================================================================
// 1. CANONICAL DESCRIPTORS  (production: built once per LOD on one triangle)
//============================================================================
// Recipe node types:
//   vertex:  {type:'corner', slot}                       -> dIdx = c[slot]
//            {type:'mid', edge}                           -> dIdx = edgeArrayIndex(edge)
//   edge:    {type:'base', slot}                          -> V[0] + ebm[slot]
//            {type:'split', parent, near, far, band}      -> V[b]+2*(pIdx-V[b-1])+off
//            {type:'interior', tri, slot, band}           -> V[b]+2*E[b-1]+3*tIdx+slot
//   tri:     {type:'baseTri'}                             -> tbm
//            {type:'triChild', parent, kind, band}        -> center:pIdx | j: T[g]+3*pIdx+j
// `near`/`far` are the parent edge's two endpoint vertices; the split child sits
// next to `near`. Its offset (0/1) is decided at eval time by comparing the
// GLOBAL indices of near/far, exactly as C++ stores edges smaller-endpoint-first.

export function buildCanonicalDescriptors(level) {
  const corner = [
    { type: 'corner', slot: 0, bary: vBasis(0) },
    { type: 'corner', slot: 1, bary: vBasis(1) },
    { type: 'corner', slot: 2, bary: vBasis(2) },
  ];
  const baseEdge = [0, 1, 2].map((k) => ({
    type: 'base', slot: k,
    endA: corner[k], endB: corner[(k + 1) % 3],
  }));
  const baseTri = { type: 'baseTri' };

  let tris = [{
    corners: [corner[0], corner[1], corner[2]],
    edges: [baseEdge[0], baseEdge[1], baseEdge[2]],
    triRecipe: baseTri,
    band: 0,
  }];

  const vertsByKey = new Map();
  const order = [];
  const reg = (vr) => {
    const k = vKey(vr.bary);
    if (!vertsByKey.has(k)) { vertsByKey.set(k, vr); order.push(vr); }
    return vertsByKey.get(k);
  };
  corner.forEach(reg);

  const getMid = (edge) => {
    const bary = vAvg(edge.endA.bary, edge.endB.bary);
    const k = vKey(bary);
    if (vertsByKey.has(k)) return vertsByKey.get(k);
    const vr = { type: 'mid', edge, bary };
    vertsByKey.set(k, vr);
    order.push(vr);
    return vr;
  };

  for (let it = 0; it < level; it++) {
    // create midpoints of all current edges (level it+1 vertices)
    const midOf = new Map();
    for (const T of tris) {
      for (let k = 0; k < 3; k++) {
        if (!midOf.has(T.edges[k])) midOf.set(T.edges[k], getMid(T.edges[k]));
      }
    }
    if (it >= level - 1) break;

    const g = it;            // parent triangle band
    const eb = it + 1;       // band of edges created by this split
    const newTris = [];
    for (const T of tris) {
      const C = T.corners, Ed = T.edges;
      const m = [midOf.get(Ed[0]), midOf.get(Ed[1]), midOf.get(Ed[2])];
      const sub = [];
      for (let k = 0; k < 3; k++) {
        const kn = (k + 1) % 3;
        sub[k] = [
          { type: 'split', parent: Ed[k], near: C[k], far: C[kn], band: eb, endA: C[k], endB: m[k] },
          { type: 'split', parent: Ed[k], near: C[kn], far: C[k], band: eb, endA: C[kn], endB: m[k] },
        ];
      }
      const intE = [0, 1, 2].map((k) => ({
        type: 'interior', tri: T.triRecipe, slot: k, band: eb,
        endA: m[k], endB: m[(k + 1) % 3],
      }));
      const childRecipe = (kind) => ({ type: 'triChild', parent: T.triRecipe, kind, band: g });

      // center + 3 corner children (matches mesh.hpp split order)
      newTris.push({
        corners: [m[0], m[1], m[2]], edges: [intE[0], intE[1], intE[2]],
        triRecipe: childRecipe('center'), band: g + 1,
      });
      newTris.push({
        corners: [C[0], m[0], m[2]], edges: [sub[0][0], intE[2], sub[2][1]],
        triRecipe: childRecipe(0), band: g + 1,
      });
      newTris.push({
        corners: [m[0], C[1], m[1]], edges: [sub[0][1], sub[1][0], intE[0]],
        triRecipe: childRecipe(1), band: g + 1,
      });
      newTris.push({
        corners: [m[2], m[1], C[2]], edges: [intE[1], sub[1][1], sub[2][0]],
        triRecipe: childRecipe(2), band: g + 1,
      });
    }
    tris = newTris;
  }

  // emit descriptors as {bary:[b0,b1,b2], recipe}
  return order.map((vr) => {
    const b = [0, 0, 0];
    for (const [k, w] of vr.bary) b[k] = w;
    return { bary: b, recipe: vr };
  });
}

//============================================================================
// computeDIdx: evaluate a recipe for one render-instance (the shader's job).
//============================================================================
export function computeDIdx(recipe, inst, counts) {
  const { V, E, T } = counts;
  const c = inst.c, ebm = inst.ebm, tbm = inst.tbm;
  const memoV = new Map(), memoE = new Map(), memoT = new Map();

  function vDIdx(vr) {
    if (vr.type === 'corner') return c[vr.slot];
    if (memoV.has(vr)) return memoV.get(vr);
    const r = eIndex(vr.edge);
    memoV.set(vr, r);
    return r;
  }
  function eIndex(er) {
    if (memoE.has(er)) return memoE.get(er);
    let r;
    if (er.type === 'base') {
      r = V[0] + ebm[er.slot];
    } else if (er.type === 'split') {
      const b = er.band;
      const pIdx = eIndex(er.parent);
      const off = vDIdx(er.near) < vDIdx(er.far) ? 0 : 1;
      r = V[b] + 2 * (pIdx - V[b - 1]) + off;
    } else { // interior
      const b = er.band;
      const tIdx = tIndex(er.tri);
      r = V[b] + 2 * E[b - 1] + 3 * tIdx + er.slot;
    }
    memoE.set(er, r);
    return r;
  }
  function tIndex(tr) {
    if (tr.type === 'baseTri') return tbm;
    if (memoT.has(tr)) return memoT.get(tr);
    const p = tIndex(tr.parent);
    const r = tr.kind === 'center' ? p : T[tr.band] + 3 * p + tr.kind;
    memoT.set(tr, r);
    return r;
  }

  return vDIdx(recipe);
}

//============================================================================
// 2. FLATTENING  (turn a recipe DAG into a bounded op list the shader runs)
//============================================================================
// Op kinds (must match the GLSL interpreter in SubdivideMesh.js):
export const OP = {
  V_CORNER: 0,   // a = corner slot        -> c[a]
  V_MID: 1,      // a = edge op slot        -> val[a]
  E_BASE: 2,     // a = base-edge slot      -> V[0] + ebm[a]
  E_SPLIT: 3,    // a=parentOp b=nearOp c=farOp band -> V[b]+2*(val[a]-V[b-1])+(val[b']<val[c']?0:1)
  E_INTERIOR: 4, // a=triOp slot band       -> V[band]+2*E[band-1]+3*val[a]+slot
  T_BASE: 5,     //                          -> tbm
  T_CHILD: 6,    // a=parentOp slot(kind) band -> slot<0 ? val[a] : T[band]+3*val[a]+slot
};

// Flatten one vertex recipe into a topologically ordered op list (memoized
// within the vertex). Each op: {kind, a, b, c, band, slot}; the result vertex's
// dIdx is the value of the LAST op.
export function flattenRecipe(recipe) {
  const ops = [];
  const memo = new Map();
  const push = (op, obj) => { const s = ops.length; ops.push(op); if (obj) memo.set(obj, s); return s; };

  function vSlot(vr) {
    if (memo.has(vr)) return memo.get(vr);
    if (vr.type === 'corner') return push({ kind: OP.V_CORNER, a: vr.slot, b: 0, c: 0, band: 0, slot: 0 }, vr);
    const e = eSlot(vr.edge);
    return push({ kind: OP.V_MID, a: e, b: 0, c: 0, band: 0, slot: 0 }, vr);
  }
  function eSlot(er) {
    if (memo.has(er)) return memo.get(er);
    if (er.type === 'base') return push({ kind: OP.E_BASE, a: er.slot, b: 0, c: 0, band: 0, slot: 0 }, er);
    if (er.type === 'split') {
      const p = eSlot(er.parent);
      const n = vSlot(er.near), f = vSlot(er.far);
      return push({ kind: OP.E_SPLIT, a: p, b: n, c: f, band: er.band, slot: 0 }, er);
    }
    const t = tSlot(er.tri);
    return push({ kind: OP.E_INTERIOR, a: t, b: 0, c: 0, band: er.band, slot: er.slot }, er);
  }
  function tSlot(tr) {
    if (memo.has(tr)) return memo.get(tr);
    if (tr.type === 'baseTri') return push({ kind: OP.T_BASE, a: 0, b: 0, c: 0, band: 0, slot: 0 }, tr);
    const p = tSlot(tr.parent);
    return push({ kind: OP.T_CHILD, a: p, b: 0, c: 0, band: tr.band, slot: tr.kind === 'center' ? -1 : tr.kind }, tr);
  }
  vSlot(recipe);
  return ops;
}

// Evaluate a flattened op list (reference for the GLSL interpreter; tests only).
export function evalOps(ops, inst, counts) {
  const { V, E, T } = counts;
  const val = new Array(ops.length);
  for (let i = 0; i < ops.length; i++) {
    const o = ops[i];
    switch (o.kind) {
      case OP.V_CORNER: val[i] = inst.c[o.a]; break;
      case OP.V_MID: val[i] = val[o.a]; break;
      case OP.E_BASE: val[i] = V[0] + inst.ebm[o.a]; break;
      case OP.E_SPLIT: val[i] = V[o.band] + 2 * (val[o.a] - V[o.band - 1]) + (val[o.b] < val[o.c] ? 0 : 1); break;
      case OP.E_INTERIOR: val[i] = V[o.band] + 2 * E[o.band - 1] + 3 * val[o.a] + o.slot; break;
      case OP.T_BASE: val[i] = inst.tbm; break;
      case OP.T_CHILD: val[i] = o.slot < 0 ? val[o.a] : T[o.band] + 3 * val[o.a] + o.slot; break;
    }
  }
  return val[ops.length - 1];
}

// Creation level (vLod) of a recipe vertex: 0 for corners, edge.band+1 otherwise.
export function recipeLevel(recipe) {
  if (recipe.type === 'corner') return 0;
  const e = recipe.edge;
  return e.type === 'base' ? 1 : e.band + 1;
}

//============================================================================
// 3. SHADER PATTERN  (render geometry + op texture for the WebGL2 interpreter)
//============================================================================
// Subdivide ONE canonical triangle to produce instanced render geometry, and
// attach each unique vertex's flattened op list + meta. NO mesh subdivision of
// the actual base mesh happens here — this is the per-LOD pattern, built once.
export function buildShaderPattern(level) {
  const descriptors = buildCanonicalDescriptors(level);
  const denom = 1 << level;
  const ikey = (b) => `${Math.round(b[0] * denom)},${Math.round(b[1] * denom)},${Math.round(b[2] * denom)}`;

  // index unique vertices by integer barycentric key (matches subdivision below)
  const descByKey = new Map();
  descriptors.forEach((d, i) => descByKey.set(ikey(d.bary), i));

  // subdivide canonical triangle to get render triangles (barycentric)
  let tris = [[[1, 0, 0], [0, 1, 0], [0, 0, 1]]];
  for (let it = 0; it < level; it++) {
    const next = [];
    for (const [A, B, C] of tris) {
      const m = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
      const M1 = m(A, B), M2 = m(B, C), M3 = m(C, A);
      next.push([A, M1, M3], [M1, B, M2], [M3, M2, C], [M1, M2, M3]);
    }
    tris = next;
  }

  // build indices referencing the descriptor vertex order
  const indices = [];
  for (const tr of tris) for (const v of tr) {
    const idx = descByKey.get(ikey(v));
    if (idx === undefined) throw new Error('pattern vertex missing descriptor: ' + v);
    indices.push(idx);
  }

  // positions (barycentric) + per-vertex meta. The dIdx is computed by the generated
  // computeDIdxRow() switch (see buildDIdxGLSL), so meta only needs the creation level and
  // the switch row; no op encoding is uploaded.
  const nVerts = descriptors.length;
  const positions = new Float32Array(nVerts * 3);
  const meta = new Float32Array(nVerts * 3); // (unused, Lv, row)

  descriptors.forEach((d, i) => {
    positions[i * 3 + 0] = d.bary[0];
    positions[i * 3 + 1] = d.bary[1];
    positions[i * 3 + 2] = d.bary[2];
    meta[i * 3 + 1] = recipeLevel(d.recipe);
    meta[i * 3 + 2] = i; // computeDIdxRow() switch row
  });

  const IndexArray = nVerts > 65535 ? Uint32Array : Uint16Array;
  return {
    positions,
    indices: new IndexArray(indices),
    meta,
    vertexCount: nVerts,
  };
}

//============================================================================
// 4. STRAIGHT-LINE GLSL GENERATOR  (loop-free, branchless where possible)
//============================================================================
// Emits a GLSL ES 3.00 function returning the displacement index for a given
// canonical pattern-vertex `row`, from only the per-instance globals. There is NO
// loop, NO dynamically-indexed array, and NO op texture: each vertex's recipe is
// inlined into a SINGLE expression by walking the recipe DAG directly (mirroring
// computeDIdx, so it inherits its proven correctness).
//
// The expression naturally implements the tiered idea from the design notes:
//   * corner            -> Cg[slot]                         (Tier 1, trivial)
//   * LoD1 base-edge mid -> V[0] + Eg[slot]                 (Tier 1, trivial)
//   * central interior  -> affine in the triangle index      (Tier 1, no compare)
//   * split / interior edges at LoD>=2 -> nested recursive expression with one
//     orientation compare per split level (Tier 2; irreducible for V-DMC).
//
//   int computeDIdxRow(int row, ivec3 Cg, ivec3 Eg, int tbm,
//                      int V[8], int E[8], int T[8]);
//   - Cg  = the 3 base-triangle corner GLOBAL vertex indices
//   - Eg  = the 3 local edges' GLOBAL base-edge indices (edgeTable)
//   - tbm = base-triangle index (gl_InstanceID)
//   - V/E/T = cumulative vertex/edge/triangle counts per subdivision level
export function buildDIdxGLSL(level) {
  const descriptors = buildCanonicalDescriptors(level);

  // Inline emitters mirror computeDIdx exactly. Each returns a GLSL expression.
  const emitVertex = (vr) =>
    vr.type === 'corner' ? `Cg[${vr.slot}]` : emitEdge(vr.edge);

  const emitEdge = (er) => {
    if (er.type === 'base') return `(V[0] + Eg[${er.slot}])`;
    if (er.type === 'split') {
      const p = emitEdge(er.parent);
      const off = `((${emitVertex(er.near)} < ${emitVertex(er.far)}) ? 0 : 1)`;
      return `(V[${er.band}] + 2 * (${p} - V[${er.band - 1}]) + ${off})`;
    }
    // interior edge
    return `(V[${er.band}] + 2 * E[${er.band - 1}] + 3 * ${emitTri(er.tri)} + ${er.slot})`;
  };

  const emitTri = (tr) => {
    if (tr.type === 'baseTri') return `tbm`;
    const p = emitTri(tr.parent);
    return tr.kind === 'center' ? p : `(T[${tr.band}] + 3 * ${p} + ${tr.kind})`;
  };

  let s = '';
  s += 'int computeDIdxRow(int row, ivec3 Cg, ivec3 Eg, int tbm, int V[8], int E[8], int T[8]) {\n';
  s += '  switch (row) {\n';
  descriptors.forEach((d, v) => {
    s += `  case ${v}: return ${emitVertex(d.recipe)};\n`;
  });
  s += '  }\n';
  s += '  return 0;\n';
  s += '}\n';
  return { glsl: s, vertexCount: descriptors.length };
}

//============================================================================
// 5. NORMAL NLERP GENERATOR
//============================================================================
// The decoder derives each subdivided vertex's displacement-direction normal by per-level nlerp
// of the base normals: a midpoint vertex's normal = normalize(0.5*(normal(endA)+normal(endB))) of
// its two parents (interpolateSubdivision with normalize=true). This is NOT a single barycentric
// blend of the 3 corner normals (that diverges at sharp features). Emit a loop-free GLSL evaluator
// (per pattern row) from the same recipe DAG, so the shader matches the decoder exactly.
export function buildNormalNlerpGLSL(level) {
  const descriptors = buildCanonicalDescriptors(level);
  const emit = (vr) =>
    vr.type === 'corner'
      ? `n${vr.slot}`
      : `normalize(0.5 * (${emit(vr.edge.endA)} + ${emit(vr.edge.endB)}))`;
  let s = '';
  s += 'vec3 nlerpNormalRow(int row, vec3 n0, vec3 n1, vec3 n2) {\n';
  s += '  switch (row) {\n';
  descriptors.forEach((d, v) => { s += `  case ${v}: return ${emit(d.recipe)};\n`; });
  s += '  default: return n0;\n';
  s += '  }\n';
  s += '}\n';
  return { glsl: s, vertexCount: descriptors.length };
}

// JS reference of the same per-level nlerp (for the CPU mirror / tests).
export function nlerpNormal(recipe, n0, n1, n2) {
  const N = [n0, n1, n2];
  function ev(vr) {
    if (vr.type === 'corner') return N[vr.slot];
    const a = ev(vr.edge.endA), b = ev(vr.edge.endB);
    let x = 0.5 * (a[0] + b[0]), y = 0.5 * (a[1] + b[1]), z = 0.5 * (a[2] + b[2]);
    const L = Math.hypot(x, y, z) || 1; return [x / L, y / L, z / L];
  }
  return ev(recipe);
}


