/**
 * © 2026 Nokia
 *
 * Licensed under the 5G-MAG Public License (v1.0)
 */

import {
  Vector3,
  Color,
  BufferGeometry,
  BufferAttribute,
  InstancedBufferAttribute,
  InstancedMesh,
  ShaderMaterial,
  GLSL3,
  DoubleSide,
} from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildShaderPattern, buildDIdxGLSL, buildNormalNlerpGLSL } from './subdivNumbering.mjs';

// Generate subdivision pattern
function generateIndexedPattern(level) 
{
  let tris = [[[1,0,0],[0,1,0],[0,0,1]]];
  for (let i = 0; i < level; i++) 
  {
    const next = [];
    tris.forEach(([A, B, C]) => 
    {
      const M1 = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2];
      const M2 = [(B[0] + C[0]) / 2, (B[1] + C[1]) / 2, (B[2] + C[2]) / 2];
      const M3 = [(C[0] + A[0]) / 2, (C[1] + A[1]) / 2, (C[2] + A[2]) / 2];
      next.push([A, M1, M3], [M1, B, M2], [M3, M2, C], [M1, M2, M3]);
    });
    tris = next;
  }
  const verts = [], idxs = [], map = new Map();
  tris.forEach(tr => tr.forEach(v => 
  {
    const key = v.join();
    if (!map.has(key)) 
    {
      map.set(key, verts.length);
      verts.push(v);
    }
    idxs.push(map.get(key));
  }));
  const positions = new Float32Array(verts.flat());
  return { positions, indices: new Uint16Array(idxs) };
}

// Weld vertex normals across co-located positions so the displacement direction stays
// continuous across UV-patch seams (otherwise patches pull apart into cracks).
function weldNormalsFast(geo, eps = 1e-4)
{
  const pos = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
  const n   = pos.count, q = 1 / eps;

  const map = new Map();
  const sumX = [], sumY = [], sumZ = [], lists = [];

  for (let i = 0; i < n; ++i)
  {
    const k = ((pos.getX(i) * q) | 0) * 73856093 ^
              ((pos.getY(i) * q) | 0) * 19349663 ^
              ((pos.getZ(i) * q) | 0) * 83492791;

    let g = map.get(k);
    if (g === undefined) {
      g = sumX.length;
      map.set(k, g);
      sumX[g] = sumY[g] = sumZ[g] = 0;
      lists[g] = [];
    }
    sumX[g] += nrm.getX(i);
    sumY[g] += nrm.getY(i);
    sumZ[g] += nrm.getZ(i);
    lists[g].push(i);
  }

  for (let g = 0; g < sumX.length; ++g)
  {
    let x = sumX[g], y = sumY[g], z = sumZ[g];
    const len = Math.hypot(x, y, z) || 1;
    x /= len; y /= len; z /= len;
    const ids = lists[g];
    for (let j = 0; j < ids.length; ++j) nrm.setXYZ(ids[j], x, y, z);
  }

  nrm.needsUpdate = true;
}

// Area-weighted normals per base vertex matching the decoder's computeNormals(). Uses the indexed
// base topology (userData.baseData) when the geometry is per-corner expanded; falls back to THREE's
// computeVertexNormals for an indexed base (which is already area-weighted per shared vertex).
function applyDecoderBaseNormals(geo) {
  const bd = geo.userData && geo.userData.baseData;
  if (!(bd && bd.indices && bd.positions)) { geo.computeVertexNormals(); return; }
  const P = bd.positions, idx = bd.indices, nV = P.length / 3;
  const acc = new Float32Array(nV * 3);
  for (let f = 0; f < idx.length; f += 3) {
    const a = idx[f], b = idx[f + 1], c = idx[f + 2];
    const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
    const e1x = P[b * 3] - ax, e1y = P[b * 3 + 1] - ay, e1z = P[b * 3 + 2] - az;
    const e2x = P[c * 3] - ax, e2y = P[c * 3 + 1] - ay, e2z = P[c * 3 + 2] - az;
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    acc[a * 3] += nx; acc[a * 3 + 1] += ny; acc[a * 3 + 2] += nz;
    acc[b * 3] += nx; acc[b * 3 + 1] += ny; acc[b * 3 + 2] += nz;
    acc[c * 3] += nx; acc[c * 3 + 1] += ny; acc[c * 3 + 2] += nz;
  }
  for (let v = 0; v < nV; v++) { const L = Math.hypot(acc[v * 3], acc[v * 3 + 1], acc[v * 3 + 2]) || 1; acc[v * 3] /= L; acc[v * 3 + 1] /= L; acc[v * 3 + 2] /= L; }
  const nrm = new Float32Array(idx.length * 3);
  for (let c = 0; c < idx.length; c++) { const v = idx[c]; nrm[c * 3] = acc[v * 3]; nrm[c * 3 + 1] = acc[v * 3 + 1]; nrm[c * 3 + 2] = acc[v * 3 + 2]; }
  geo.setAttribute('normal', new BufferAttribute(nrm, 3));
}

// Subdivide a base mesh on the GPU via an instanced canonical pattern.
// dispParams (optional): when present, applies proper V-DMC displacement (vertex-index
// generated dIdx evaluator); when absent, renders the smooth quadratic surface only.
function SubdivideMesh(base, tex, disp, subdiv = 3, wireframe = true, dispParams = null)
{
  // Proper displacement indexes each vertex in VERTEX-INDEX space and is keyed to the decoder's
  // base-mesh vertex/edge numbering. mergeVertices() REORDERS vertices (by first-appearance in
  // the index buffer), which would desync the packed corner indices (Cg) from the displacement
  // video and edgeTable. So in proper mode we keep the base mesh's original numbering and only
  // weld normal DIRECTIONS for crack-free displacement. The smooth path may still merge.
  const hasProperDisp = !!(dispParams && dispParams.edgeTable);
  if (!hasProperDisp) base = mergeVertices(base, 1e-6);
  if (hasProperDisp) {
    // Match the decoder's computeNormals(): AREA-weighted (unnormalized cross) face normals summed
    // per base vertex, then normalized. The SDK base is per-corner expanded, so derive the per-
    // vertex normals from the indexed base topology and write them to every corner.
    applyDecoderBaseNormals(base);
  } else {
    base.computeVertexNormals();
    weldNormalsFast(base);
  }

  // Model lives in raw coordinates; express the smooth-path offset as a fraction of radius.
  base.computeBoundingSphere();
  const modelRadius = (base.boundingSphere && base.boundingSphere.radius) || 1.0;

  // Proper displacement needs the op-list pattern; the smooth path uses the midpoint pattern.
  const pattern = hasProperDisp ? buildShaderPattern(subdiv) : generateIndexedPattern(subdiv);
  const patternPos = pattern.positions;
  const patternIdx = pattern.indices;

  // Loop-free, static-indexed GLSL evaluator for the displacement index (proper mode only).
  // Generated once per level from the proven op-lists; avoids the dynamic local array + loop
  // that ANGLE/D3D miscompiles. Universal for any subdivision level (0..5+).
  const didxGLSL = hasProperDisp ? buildDIdxGLSL(subdiv).glsl : '';
  // Per-level nlerp normal evaluator (displacement direction) — matches the decoder exactly.
  const normGLSL = hasProperDisp ? buildNormalNlerpGLSL(subdiv).glsl : '';

  const posAttr = base.getAttribute('position');
  const normAttr = base.getAttribute('normal');
  const uvAttr = base.getAttribute('uv');
  const idx = base.getIndex();
  const count = (idx ? idx.count : posAttr.count) / 3;

  // Pack each corner's (xyz + one uv channel) into a column of a mat4 per instance.
  function packMatrix(getIdx, attr3, uvGetter) 
  {
    const mats = new Float32Array(count * 16);
    for (let t = 0; t < count; t++) 
    {
      const baseOff = t * 16;
      for (let j = 0; j < 3; j++) 
      {
        const i = getIdx(t * 3 + j);
        const o = baseOff + j * 4;
        mats[o + 0] = attr3.getX(i);
        mats[o + 1] = attr3.getY(i);
        mats[o + 2] = attr3.getZ(i);
        mats[o + 3] = uvGetter(i);
      }
      // row3 remains zero
    }
    return mats;
  }

  const getIdx = idx ? (i => idx.getX(i)) : (i => i);
  const Mpos = packMatrix(getIdx, posAttr, i => uvAttr.getX(i));
  const Mnorm= packMatrix(getIdx, normAttr, i => uvAttr.getY(i));

  // Corner -> base-vertex GLOBAL index. Proper displacement keys LoD0 (corner) vertices to the
  // base-mesh vertex numbering, so Cg must be the base-vertex index — NOT the corner index. For an
  // indexed base that's the index buffer; for the SDK's per-corner-expanded base it lives in
  // userData.baseData.indices (otherwise getIdx returns the corner index 3t+j and the dIdx lookup
  // reads the wrong displacement pixel for every non-first-triangle corner).
  const baseData = base.userData && base.userData.baseData;
  const cornerToBaseV = (baseData && baseData.indices) ? baseData.indices : (idx ? idx.array : null);
  const baseVIdx = cornerToBaseV ? (i => cornerToBaseV[i]) : (i => i);

  // Pack per-instance corner / base-edge global indices into the unused 4th column of
  // mP / mN (proper disp only). Avoids extra vertex attributes (ANGLE attribute limit).
  if (hasProperDisp) {
    for (let t = 0; t < count; t++) {
      const o = t * 16;
      Mpos[o + 12] = baseVIdx(t * 3 + 0);
      Mpos[o + 13] = baseVIdx(t * 3 + 1);
      Mpos[o + 14] = baseVIdx(t * 3 + 2);
      Mpos[o + 15] = 0.0;
      Mnorm[o + 12] = dispParams.edgeTable[3 * t + 0];
      Mnorm[o + 13] = dispParams.edgeTable[3 * t + 1];
      Mnorm[o + 14] = dispParams.edgeTable[3 * t + 2];
      Mnorm[o + 15] = 0.0;
    }
  }

  // Instanced geometry
  const inst = new BufferGeometry();
  inst.setAttribute('position', new BufferAttribute(patternPos, 3));
  inst.setIndex(new BufferAttribute(patternIdx, 1));
  inst.setAttribute('mP', new InstancedBufferAttribute(Mpos, 16));
  inst.setAttribute('mN', new InstancedBufferAttribute(Mnorm,16));

  // Per-pattern-vertex meta (proper disp only): aMeta = (unused, Lv, row). The row selects the
  // generated computeDIdxRow() branch; Lv is the vertex's creation level (for block addressing).
  if (hasProperDisp) {
    inst.setAttribute('aMeta', new BufferAttribute(pattern.meta, 3));
  }

  // Proper-displacement uniforms.
  // The decoder can emit dispWidth/dispHeight = 0 and lodCount undefined; recover them from the
  // actual displacement texture and the per-LoD iscale array, or the block packing addresses the
  // wrong pixel (widthInBlocks collapses to 0 -> mod-by-zero).
  const dispTexW = (disp && disp.image && disp.image.width) || 0;
  const dispTexH = (disp && disp.image && disp.image.height) || 0;
  const dispUniforms = hasProperDisp ? {
    uBaseVertexCount: { value: dispParams.baseVertexCount },
    uBaseEdgesCount:  { value: dispParams.baseEdgesCount },
    uBaseTriCount:    { value: count },
    uDispWidth:       { value: dispParams.dispWidth || dispTexW },
    uDispHeight:      { value: dispParams.dispHeight || dispTexH },
    uLog2BlockSize:   { value: dispParams.log2BlockSize },
    uPackingMethod:   { value: dispParams.packingMethod },
    uLodCount:        { value: dispParams.lodCount || (dispParams.iscale ? dispParams.iscale.length : 0) },
  } : {};

  // Shader material
  const mat = new ShaderMaterial({
    glslVersion: GLSL3,
    side : DoubleSide,
    wireframe: wireframe,

    uniforms: {
      mapTexture:    { value: tex },
      mapDisp:       { value: disp },
      lightDir:      { value: new Vector3(-0.3, -0.8, 1.5).normalize() },
      ambientColor:  { value: new Color(0.35, 0.35, 0.35) },
      dispScale:     { value: 0.0 },
      uDispUnit:     { value: modelRadius },  // world units per unit dispScale (smooth path)
      uUseProperDisp:{ value: hasProperDisp ? 1 : 0 },
      // Base surface used BEFORE displacement: 0 = midpoint (flat, linear barycentric — the
      // surface V-DMC MIDPOINT subdivision (method 0) produces), 1 = quadratic Bezier surface,
      // which is the geometric form of V-DMC NORMAL subdivision (method 2): midpoint + a normal-
      // direction edge offset, degree-2 (NOT cubic PN). The GPU surface must match whichever
      // asve_subdivision_method the encoder used, or the displacement double-counts.
      // Proper displacement defaults to midpoint here; the no-displacement preview defaults to quadratic.
      uSubdivMode:   { value: hasProperDisp ? 0 : 1 },
      // Raw GPU-direct displacement (renderer ring path): mapDisp holds the decoded frame's luma;
      // calibrate inline. uDispRaw=0 keeps the CPU path where mapDisp.r is already normalized code.
      uDispRaw:      { value: 0 },
      uCalScale:     { value: 1 },
      uCalOffset:    { value: 0 },
      uDispNorm:     { value: 1 },
      uTexRaw:       { value: 0 },
      ...dispUniforms
     },
    
    vertexShader: `
      in mat4 mP;                  // cols 0-2: positions + uv.x; col 3: corner global indices (proper)
      in mat4 mN;                  // cols 0-2: normals  + uv.y; col 3: base-edge global indices (proper)
      ${hasProperDisp ? 'in vec3 aMeta;' : ''}     // (opCount, Lv, row)
      out vec2 vUv;
      out vec3 vNormal;
	    uniform float dispScale;
	    uniform float uDispUnit;
      uniform int uUseProperDisp;
      uniform int uSubdivMode;     // 0 = midpoint (method 0, flat), 1 = quadratic Bezier (method 2, NORMAL)
      uniform sampler2D mapDisp;
      uniform int uDispRaw;      // 1 = mapDisp is the raw decoded frame (calibrate luma inline)
      uniform float uCalScale;   // luma->code affine (raw path)
      uniform float uCalOffset;
      uniform float uDispNorm;   // 1 / 2^bitDepth (raw path)

      ${hasProperDisp ? `
      // ---- Proper V-DMC displacement uniforms ----
      uniform int uBaseVertexCount;
      uniform int uBaseEdgesCount;
      uniform int uBaseTriCount;
      uniform int uDispWidth;
      uniform int uDispHeight;
      uniform int uLog2BlockSize;
      uniform int uPackingMethod;
      uniform int uLodCount;
      ` : ''}

      mat3 edgeMat(mat3 P, mat3 Q, mat3 N, float A, float B)
      {
          vec3 d = vec3(dot(P[0] - Q[0], N[0]), 
                        dot(P[1] - Q[1], N[1]), 
                        dot(P[2] - Q[2], N[2]));

    	  mat3 n3 = mat3(N[0] * d.x, N[1] * d.y, N[2] * d.z);

          return A * (P + B * (Q + n3));
      }

      vec3 _normal(vec3 bary, mat3 P, mat3 N)
      {
          mat3 En = edgeMat(P, mat3(P[1], P[2], P[0]), N, 0.5, 1.0);
          mat3 Ep = edgeMat(P, mat3(P[2], P[0], P[1]), N, 0.5, 1.0);

          vec3 s = bary * bary,
          	   p = bary * bary.yzx,
               q = bary * bary.zxy;

          return P * s + En * p + Ep * q;
      }

      ${hasProperDisp ? `
      // ---- Morton / block packing ----
      void extracOddBits(inout int x) {
        x = x & 0x55555555;
        x = (x | (x >> 1)) & 0x33333333;
        x = (x | (x >> 2)) & 0x0F0F0F0F;
        x = (x | (x >> 4)) & 0x00FF00FF;
        x = (x | (x >> 8)) & 0x0000FFFF;
      }
      void computeMorton2D(int i, out int x, out int y) {
        x = i >> 1; y = i;
        extracOddBits(x); extracOddBits(y);
      }
      void blockPositionInPatch(int bindx, int blockSize, out int x0, out int y0) {
        int widthInBlocks = int(ceil(float(uDispWidth) / float(blockSize)));
        int temp = int(mod(float(bindx), float(widthInBlocks)));
        x0 = temp * blockSize;
        y0 = int(floor(float(bindx) / float(widthInBlocks))) * blockSize;
      }
      ivec2 indexToPixel(int idx, int pixelsInBlock, int blockIdxStart, int totalBlocksInPatch) {
        int blockIdx = int(floor(float(idx) / float(pixelsInBlock))) + blockIdxStart;
        int indexWithinBlock = int(mod(float(idx), float(pixelsInBlock)));
        // Reverse packing (asve_packing_method==1) reverses block + in-block order over the FULL
        // patch block count. Forward packing (0) addresses blocks directly. Controlled by the param.
        if (uPackingMethod == 1) {
          blockIdx = totalBlocksInPatch - 1 - blockIdx;
          indexWithinBlock = pixelsInBlock - 1 - indexWithinBlock;
        }
        int x0, y0; blockPositionInPatch(blockIdx, 1 << uLog2BlockSize, x0, y0);
        int x1, y1; computeMorton2D(indexWithinBlock, x1, y1);
        return ivec2(x0 + x1, y0 + y1);
      }
      // ---- Universal dIdx evaluator (generated, loop-free, static-indexed) ----
      ${didxGLSL}
      // ---- Per-level nlerp normal evaluator (displacement direction) ----
      ${normGLSL}
      ` : ''}

      // Signed displacement from a displacement texel. CPU path: mapDisp.r is the normalized code
      // (subtract the 0.5 midpoint). Raw path: mapDisp holds the decoded frame's luma, so recover
      // the code with the calibration affine, normalize by 2^bitDepth, then subtract the midpoint.
      float _dispFromTexel(vec4 t) {
        if (uDispRaw == 1) {
          float luma = (t.r + t.g + t.b) / 3.0;   // neutral chroma: R=G=B=luma
          float maxCode = 1.0 / uDispNorm - 1.0;
          // Round to the nearest integer code (matches the CPU extractor) so fp16 sampling noise
          // doesn't leak into the displacement; then normalize and subtract the midpoint.
          float code = clamp(floor(luma * uCalScale + uCalOffset + 0.5), 0.0, maxCode);
          return code * uDispNorm - 0.5;
        }
        return t.r - 0.5;
      }

      // Signed displacement for this vertex. Proper mode reads the V-DMC packed pixel via the
      // op-interpreter (vertex-index space); simple mode samples at the interpolated UV.
      float sampleDisplacement(vec2 uv)
      {
      ${hasProperDisp ? `
        if (uUseProperDisp == 1) {
          // Cumulative vertex/edge/triangle counts per subdivision level. Also accumulate the
          // number of displacement BLOCKS this patch actually uses: one or more 64x64 blocks per
          // LoD level (LoD0 has V0 entries, LoD l>=1 has E[l-1] entries). The V-DMC reverse block
          // packing is relative to THIS used-block count — NOT the full texture size. (The TM
          // reference hardcodes a per-asset 'patchShift' to fake this; deriving the used-block
          // count is the universal, asset-independent equivalent.)
          int V[8], E[8], T[8];
          V[0] = uBaseVertexCount; E[0] = uBaseEdgesCount; T[0] = uBaseTriCount;
          int blockSize     = 1 << uLog2BlockSize;
          int pixelsInBlock = blockSize * blockSize;
          int usedBlocks = 0;
          for (int l = 0; l < 7; l++) {
            if (l < uLodCount) {
              int cnt = (l == 0) ? V[0] : E[l - 1];
              usedBlocks += int(ceil(float(cnt) / float(pixelsInBlock)));
            }
            V[l + 1] = V[l] + E[l];
            E[l + 1] = 2 * E[l] + 3 * T[l];
            T[l + 1] = 4 * T[l];
          }

          int Cg[3]; Cg[0] = int(mP[3].x); Cg[1] = int(mP[3].y); Cg[2] = int(mP[3].z);
          int Eg[3]; Eg[0] = int(mN[3].x); Eg[1] = int(mN[3].y); Eg[2] = int(mN[3].z);
          int tbm = gl_InstanceID;

          int dIdx = computeDIdxRow(int(aMeta.z),
                                    ivec3(Cg[0], Cg[1], Cg[2]),
                                    ivec3(Eg[0], Eg[1], Eg[2]),
                                    tbm, V, E, T);

          int Lv = int(aMeta.y);

          int blockIdxStart = 0;
          for (int l = 0; l < Lv; l++) {
            int cnt = (l == 0) ? V[0] : E[l - 1];
            blockIdxStart += int(ceil(float(cnt) / float(pixelsInBlock)));
          }
          int localIdx = (Lv == 0) ? dIdx : dIdx - V[Lv - 1];

          // Reverse packing reverses over the FULL patch block count (uDispWidth*uDispHeight),
          // not the used-block count; forward packing ignores it.
          int fullBlocks = (uDispWidth * uDispHeight) / pixelsInBlock;
          ivec2 pixelCoord = indexToPixel(localIdx, pixelsInBlock, blockIdxStart, fullBlocks);
          return _dispFromTexel(texelFetch(mapDisp, pixelCoord, 0));
        }
      ` : ''}
        // V-DMC stores a +512 offset (midpoint ~0.5 == zero); subtract 0.5 for signed magnitude.
        return _dispFromTexel(texture(mapDisp, uv));
      }

      void main()
      {
        mat3 P = mat3(mP[0].xyz, mP[1].xyz, mP[2].xyz);
        mat3 N = mat3(mN[0].xyz, mN[1].xyz, mN[2].xyz);

        // UV is the barycentric blend of the per-corner channels. We blend ONLY the xyz/w of
        // columns 0-2 (via mat3 / dot with the barycentric position), never the full mat4*vec4:
        // in proper mode column 3 carries packed corner/edge indices that must not leak in.
        vUv = vec2(dot(vec3(mP[0].w, mP[1].w, mP[2].w), position),
                   dot(vec3(mN[0].w, mN[1].w, mN[2].w), position));

        // Base surface before displacement.
        //   midpoint (0): flat linear barycentric interpolation of the 3 base-triangle corners,
        //                 i.e. exactly the V-DMC midpoint-subdivided position the displacements
        //                 were measured against.
        //   quadratic (1): degree-2 Bezier triangle = V-DMC NORMAL subdivision (method 2) surface.
        vec3 pBase = (uSubdivMode == 1) ? _normal(position, P, N) : (P * position);

        // Displacement direction. Proper mode: per-level nlerp of base normals along the
        // subdivision recipe (== decoder interpolateSubdivision). Smooth path: barycentric blend.
        vec3 nDir = ${hasProperDisp ? 'normalize(nlerpNormalRow(int(aMeta.z), N[0], N[1], N[2]))' : 'normalize(N * position)'};

        float d = sampleDisplacement(vUv);
        vec3 pos = pBase + nDir * d * dispScale * uDispUnit;

        vNormal  = normalize(normalMatrix * nDir);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
      }`,
  
    fragmentShader: `
    precision highp float;

    in vec2 vUv;
    in vec3 vNormal;

    uniform sampler2D mapTexture;
    uniform int uTexRaw;
    uniform vec3 lightDir;
    uniform vec3 ambientColor;

    out vec4 outColor;

    void main() 
    {
      vec3  N   = normalize(vNormal);
      vec3  L   = normalize(lightDir);
      float diff = max(dot(N, L), 0.0);

      // Raw GPU-direct colour texture is uploaded top-left (UNPACK_FLIP_Y is unreliable for
      // VideoFrame across drivers), so flip V here to match the CanvasTexture (flipY) convention.
      vec2  texUv  = (uTexRaw == 1) ? vec2(vUv.x, 1.0 - vUv.y) : vUv;
      vec3  albedo = texture(mapTexture, texUv).rgb;
      if (uTexRaw == 1) {
        // Raw GPU-direct colour texture is sRGB-encoded; decode to linear (the CPU CanvasTexture
        // path gets this from its sRGB upload). Accurate sRGB EOTF.
        albedo = mix(albedo / 12.92, pow((albedo + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), albedo));
      }

      float ambient = ambientColor.r;
      vec3  colorLinear = albedo * (ambient + (1.0 - ambient) * diff);

      // Custom ShaderMaterial output is not auto-encoded; encode linear->sRGB ourselves.
      vec3  colorSrgb = pow(colorLinear, vec3(1.0 / 2.2));

      outColor = vec4(colorSrgb, 1.0);
    }`
  });
  
  const mesh = new InstancedMesh(inst, mat, count);
  // World positions come from per-instance mP/mN attributes in the vertex shader, not the
  // instanceMatrix, so Three's auto bounding sphere is wrong and frustum-culls at some angles.
  mesh.frustumCulled = false;
  return mesh;
}

export { SubdivideMesh };

