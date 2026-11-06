/**
 * © 2026 Nokia
 *
 * Licensed under the 5G-MAG Public License (v1.0)
 */

/**
 * gpu-capture.mjs — capture the REAL vertices the SDK's displacement shader produces.
 *
 * The single capture implementation shared by every test (verification/parity, verify/,
 * run-verification.mjs). It reuses the production vertex shader source straight off the live
 * material — patched only to emit the displaced position, the global displacement index and the
 * sampled displacement — so a capture can never drift from what the SDK actually renders.
 *
 * It runs in the APP's WebGL2 context (the one owning the THREE.WebGLRenderer), which is what
 * makes it universal: the displacement texture is taken from the material by handle, so it works
 * both for the GPU-direct ring texture (VDMCMeshStream) and for a CPU DataTexture (parity
 * test), with no per-caller special cases.
 *
 * Uniforms are mirrored by enumerating the linked program's ACTIVE uniforms and reading the
 * matching entries out of `material.uniforms`. Nothing is hardcoded, so adding or removing a
 * shader uniform can never silently break the capture.
 *
 * Two capture paths, picked automatically:
 *   transform feedback — exact and direct; used on desktop/ANGLE and Adreno.
 *   RGBA8 readback     — Mali silently writes nothing through transform feedback, and float render
 *                        targets fail on both ANGLE and Mali, so each output float is rasterised
 *                        into one RGBA8 texel as its exact bit pattern over four passes.
 */

import { GpuReadback } from '/sdk/src/GpuReadback.js';

const CAPTURE_VARYINGS = ['oPos', 'oDIdx', 'oDisp'];

// Mali packs mP/mN onto position/aMeta unless the locations are pinned before linking, which
// makes the capture read zeros. mat4 attributes occupy 4 consecutive locations each.
const ATTRIB_LOCATIONS = { position: 0, aMeta: 1, mP: 2, mN: 6 };

/** True when this platform needs the RGBA8 readback path instead of transform feedback. */
export function needsReadbackPath() {
  return typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
}

// Patch the production vertex shader to expose the values we want, without changing its maths.
function buildCaptureSource(vertexShaderSrc, readback) {
  const outs = readback
    ? 'out vec3 vNormal;\n      flat out vec3 oPos;\n      flat out float oDIdxF;\n      flat out float oDisp;\n      uniform int uCapW; uniform int uCapH; uniform int uCapNVerts; uniform int uCapComp;'
    : 'out vec3 vNormal;\n      out vec3 oPos;\n      flat out int oDIdx;\n      out float oDisp;';

  let body = vertexShaderSrc.replace('out vec3 vNormal;', outs);

  // dIdx only exists on the proper-displacement path; default it so the varying is always written.
  body = body.replace(
    'mat3 P = mat3(mP[0].xyz, mP[1].xyz, mP[2].xyz);',
    (readback ? 'oDIdxF = -1.0;' : 'oDIdx = -1;') + '\n        mat3 P = mat3(mP[0].xyz, mP[1].xyz, mP[2].xyz);',
  );
  body = body.replace(
    'int Lv = int(aMeta.y);',
    (readback ? 'oDIdxF = float(dIdx);' : 'oDIdx = dIdx;') + '\n          int Lv = int(aMeta.y);',
  );
  body = body.replace(
    'float d = sampleDisplacement(vUv);',
    'float d = sampleDisplacement(vUv);\n        oDisp = d;',
  );
  body = body.replace(
    'gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);',
    readback
      // One POINT per output vertex, addressed into a capW x capH RGBA8 target.
      ? 'oPos = pos;\n        int nOut = gl_InstanceID * uCapNVerts + gl_VertexID;\n'
        + '        vec2 xy = (vec2(float(nOut % uCapW), float(nOut / uCapW)) + 0.5) / vec2(float(uCapW), float(uCapH)) * 2.0 - 1.0;\n'
        + '        gl_Position = vec4(xy, 0.0, 1.0);\n        gl_PointSize = 1.0;'
      : 'oPos = pos;\n        gl_Position = vec4(pos, 1.0);',
  );

  if (!body.includes('oPos = pos;')) {
    throw new Error('gpu-capture: could not locate the gl_Position assignment to inject the capture');
  }

  const vs = `#version 300 es
precision highp float;
precision highp int;
in vec3 position;
uniform mat4 projectionMatrix;
uniform mat4 modelViewMatrix;
uniform mat3 normalMatrix;
${body}`;

  const fs = readback
    ? `#version 300 es
precision highp float;
precision highp int;
flat in vec3 oPos;
flat in float oDIdxF;
flat in float oDisp;
uniform int uCapComp;
out vec4 c;
void main() {
  float v = uCapComp == 0 ? oPos.x : uCapComp == 1 ? oPos.y : uCapComp == 2 ? oPos.z
          : uCapComp == 3 ? oDIdxF : oDisp;
  uint b = floatBitsToUint(v);
  c = vec4(float(b & 0xFFu), float((b >> 8) & 0xFFu), float((b >> 16) & 0xFFu), float((b >> 24) & 0xFFu)) / 255.0;
}`
    : `#version 300 es
precision highp float;
out vec4 c;
void main() { c = vec4(0.0); }`;

  return { vs, fs };
}

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error('gpu-capture shader compile failed: ' + log);
  }
  return s;
}

function link(gl, vsSrc, fsSrc, readback) {
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fsSrc));
  for (const [name, loc] of Object.entries(ATTRIB_LOCATIONS)) gl.bindAttribLocation(prog, loc, name);
  if (!readback) gl.transformFeedbackVaryings(prog, CAPTURE_VARYINGS, gl.SEPARATE_ATTRIBS);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error('gpu-capture program link failed: ' + gl.getProgramInfoLog(prog));
  }
  return prog;
}

// Mirror every uniform the linked program actually declares from the live material. Driven by the
// program's active-uniform list rather than a hardcoded name set, so it cannot go stale.
function applyUniforms(gl, prog, uniforms, texUnit) {
  const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(prog, i);
    if (!info) continue;
    const name = info.name.replace(/\[0\]$/, '');
    const loc = gl.getUniformLocation(prog, info.name);
    if (!loc) continue;

    if (info.type === gl.SAMPLER_2D) {
      if (name === 'mapDisp') gl.uniform1i(loc, texUnit);
      continue;
    }
    const entry = uniforms[name];
    if (!entry || entry.value == null) continue;
    const v = entry.value;

    switch (info.type) {
      case gl.INT:
      case gl.BOOL:
        gl.uniform1i(loc, v | 0);
        break;
      case gl.FLOAT:
        if (info.size > 1 || ArrayBuffer.isView(v)) gl.uniform1fv(loc, v);
        else gl.uniform1f(loc, v);
        break;
      case gl.FLOAT_VEC2:
        gl.uniform2fv(loc, v.toArray ? v.toArray() : v);
        break;
      case gl.FLOAT_VEC3:
        gl.uniform3fv(loc, v.toArray ? v.toArray() : v);
        break;
      case gl.FLOAT_VEC4:
        gl.uniform4fv(loc, v.toArray ? v.toArray() : v);
        break;
      case gl.FLOAT_MAT3:
        gl.uniformMatrix3fv(loc, false, v.elements || v);
        break;
      case gl.FLOAT_MAT4:
        gl.uniformMatrix4fv(loc, false, v.elements || v);
        break;
      default:
        break;
    }
  }
  // The capture works in object space, so the view/projection chain must be identity.
  const I4 = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const I3 = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  for (const n4 of ['projectionMatrix', 'modelViewMatrix']) {
    const l = gl.getUniformLocation(prog, n4);
    if (l) gl.uniformMatrix4fv(l, false, I4);
  }
  const l3 = gl.getUniformLocation(prog, 'normalMatrix');
  if (l3) gl.uniformMatrix3fv(l3, false, I3);
}

// Resolve the material's displacement texture to a GL texture in the renderer's context. Covers
// both the injected ring texture (GpuTexRing) and a Three-managed CPU DataTexture.
function resolveDispTexture(renderer, texture) {
  if (!texture) throw new Error('gpu-capture: material has no mapDisp texture');
  try { renderer.initTexture(texture); } catch (_) { /* already resident, or not Three-managed */ }
  const glTex = renderer.properties.get(texture).__webglTexture;
  if (!glTex) throw new Error('gpu-capture: displacement texture is not uploaded yet — render one frame first');
  return glTex;
}

function bindAttributes(gl, prog, geo) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buffers = [];
  const mk = (data) => {
    const b = gl.createBuffer();
    buffers.push(b);
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    return b;
  };
  for (const [name, size] of [['position', 3], ['aMeta', 3]]) {
    const attr = geo.getAttribute(name);
    if (!attr) continue;
    mk(attr.array);
    const loc = gl.getAttribLocation(prog, name);
    if (loc < 0) continue;
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(loc, 0);
  }
  for (const name of ['mP', 'mN']) {
    const attr = geo.getAttribute(name);
    if (!attr) continue;
    mk(attr.array);
    const base = gl.getAttribLocation(prog, name);
    if (base < 0) continue;
    for (let k = 0; k < 4; k++) {
      gl.enableVertexAttribArray(base + k);
      gl.vertexAttribPointer(base + k, 4, gl.FLOAT, false, 64, k * 16);
      gl.vertexAttribDivisor(base + k, 1);
    }
  }
  return { vao, buffers };
}

/**
 * Capture every vertex the SDK's displacement shader produces for one frame.
 *
 * @param {THREE.InstancedMesh} mesh      the mesh built by SubdivideMesh (frame.mesh).
 * @param {THREE.WebGLRenderer} renderer  owns the context the mesh's textures live in.
 * @param {object} [opts]
 * @param {boolean} [opts.readback]       force the RGBA8 readback path (default: auto).
 * @returns {{pos:Float32Array, dIdx:Int32Array, disp:Float32Array,
 *            patternVertexCount:number, instanceCount:number, total:number, method:string}}
 */
export function captureShaderOutput(mesh, renderer, opts = {}) {
  if (!mesh || !mesh.material || !mesh.material.uniforms) {
    throw new Error('gpu-capture: expected a SubdivideMesh InstancedMesh');
  }
  if (!renderer) throw new Error('gpu-capture: a THREE.WebGLRenderer is required');

  const readback = opts.readback != null ? opts.readback : needsReadbackPath();
  const gl = renderer.getContext();
  const geo = mesh.geometry;
  const U = mesh.material.uniforms;

  const nPat = geo.getAttribute('position').count;
  const instCount = mesh.count;
  const total = nPat * instCount;

  const { vs, fs } = buildCaptureSource(mesh.material.vertexShader, readback);
  const prog = link(gl, vs, fs, readback);
  gl.useProgram(prog);

  const { vao, buffers } = bindAttributes(gl, prog, geo);

  const TEX_UNIT = 7;
  const glTex = resolveDispTexture(renderer, U.mapDisp.value);
  gl.activeTexture(gl.TEXTURE0 + TEX_UNIT);
  gl.bindTexture(gl.TEXTURE_2D, glTex);
  applyUniforms(gl, prog, U, TEX_UNIT);

  const pos = new Float32Array(total * 3);
  const dIdx = new Int32Array(total);
  const disp = new Float32Array(total);

  try {
    if (readback) {
      // Five passes: position xyz, dIdx, displacement — each as an exact float32 bit pattern.
      const capW = 256, capH = Math.ceil(total / capW);
      const setI = (n, v) => { const l = gl.getUniformLocation(prog, n); if (l) gl.uniform1i(l, v); };
      setI('uCapW', capW); setI('uCapH', capH); setI('uCapNVerts', nPat);
      const rb = new GpuReadback(renderer);
      for (let comp = 0; comp < 5; comp++) {
        const bytes = rb.toBytes(capW, capH, (g) => {
          g.useProgram(prog);
          g.bindVertexArray(vao);
          g.activeTexture(g.TEXTURE0 + TEX_UNIT);
          g.bindTexture(g.TEXTURE_2D, glTex);
          setI('mapDisp', TEX_UNIT);
          setI('uCapComp', comp);
          g.drawArraysInstanced(g.POINTS, 0, nPat, instCount);
        });
        if (!bytes) throw new Error(`gpu-capture: RGBA8 readback pass ${comp} failed`);
        const f = new Float32Array(bytes.buffer);   // little-endian: the texel bytes are the float
        for (let i = 0; i < total; i++) {
          if (comp < 3) pos[i * 3 + comp] = f[i];
          else if (comp === 3) dIdx[i] = Math.round(f[i]);
          else disp[i] = f[i];
        }
      }
    } else {
      // A buffer bound to both ARRAY_BUFFER and TRANSFORM_FEEDBACK_BUFFER makes the draw raise
      // INVALID_OPERATION and write nothing, so size the buffers then unbind from ARRAY_BUFFER.
      const sizes = [total * 3 * 4, total * 4, total * 4];
      const outBufs = sizes.map((bytes) => {
        const b = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, b);
        gl.bufferData(gl.ARRAY_BUFFER, bytes, gl.STATIC_READ);
        return b;
      });
      gl.bindBuffer(gl.ARRAY_BUFFER, null);

      const tf = gl.createTransformFeedback();
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, tf);
      outBufs.forEach((b, i) => gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, i, b));

      gl.enable(gl.RASTERIZER_DISCARD);
      gl.beginTransformFeedback(gl.POINTS);
      gl.drawArraysInstanced(gl.POINTS, 0, nPat, instCount);
      gl.endTransformFeedback();
      gl.disable(gl.RASTERIZER_DISCARD);

      const errDraw = gl.getError();
      if (errDraw !== gl.NO_ERROR) throw new Error(`gpu-capture: GL error after draw 0x${errDraw.toString(16)}`);

      // getBufferSubData binds ARRAY_BUFFER, which cannot coexist with TRANSFORM_FEEDBACK_BUFFER —
      // release the TF bindings first or the read silently returns all zeros.
      outBufs.forEach((_, i) => gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, i, null));
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);

      const reads = [pos, dIdx, disp];
      outBufs.forEach((b, i) => {
        gl.bindBuffer(gl.ARRAY_BUFFER, b);
        gl.getBufferSubData(gl.ARRAY_BUFFER, 0, reads[i]);
      });
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      outBufs.forEach((b) => gl.deleteBuffer(b));
      gl.deleteTransformFeedback(tf);
    }
  } finally {
    gl.bindVertexArray(null);
    gl.useProgram(null);
    buffers.forEach((b) => gl.deleteBuffer(b));
    gl.deleteVertexArray(vao);
    gl.deleteProgram(prog);
    renderer.resetState();
  }

  return {
    pos, dIdx, disp,
    patternVertexCount: nPat,
    instanceCount: instCount,
    total,
    method: readback ? 'rgba8-readback' : 'transform-feedback',
  };
}

/**
 * Serialize a capture as an OBJ. Vertex order is (instance * patternVertexCount + patternVertex),
 * and faces are expanded from the instanced pattern's index buffer.
 * @param {object} capture  result of captureShaderOutput().
 * @param {THREE.InstancedMesh} mesh  the mesh the capture came from (for the pattern index).
 * @param {string} [header]
 */
export function captureToObj(capture, mesh, header = '') {
  const { pos, patternVertexCount: nPat, instanceCount, total } = capture;
  const index = mesh.geometry.getIndex();
  const parts = [header ? `# ${header}\n` : '# V-DMC SDK GPU capture\n'];

  let buf = '';
  for (let i = 0; i < total; i++) {
    buf += `v ${pos[i * 3].toFixed(6)} ${pos[i * 3 + 1].toFixed(6)} ${pos[i * 3 + 2].toFixed(6)}\n`;
    if (buf.length > 1 << 20) { parts.push(buf); buf = ''; }
  }
  if (buf) { parts.push(buf); buf = ''; }

  let faces = 0;
  if (index) {
    const idx = index.array;
    for (let t = 0; t < instanceCount; t++) {
      const base = t * nPat + 1;   // OBJ is 1-based
      for (let k = 0; k < idx.length; k += 3) {
        buf += `f ${base + idx[k]} ${base + idx[k + 1]} ${base + idx[k + 2]}\n`;
        faces++;
        if (buf.length > 1 << 20) { parts.push(buf); buf = ''; }
      }
    }
    if (buf) parts.push(buf);
  }
  return { obj: parts.join(''), vertices: total, faces };
}
