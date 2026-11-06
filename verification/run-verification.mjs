/**
 * © 2026 Nokia
 *
 * Licensed under the 5G-MAG Public License (v1.0)
 */

/**
 * run-verification.mjs — V-DMC decoder SDK verification, in three phases per run.
 *
 * Each run creates a timestamped test folder  verification/runs/test.<YYMMDDHHmm>/  containing:
 *   reference/    Phase 1 — native encode + decode (encode-decode.mjs): out.vmesh, rec_%04d.obj,
 *                 decoded_%04d.obj/.png, encoder.log, decoder.log.
 *   decoded/      Phase 2 — web SDK decode (headless Edge + WebCodecs HEVC): sdk_decoded_%04d.obj.
 *   verification/ Phase 3 — comparison of SDK output vs the reference: verification_report.log.
 *
 * Phase 1 is the reusable encode-decode.mjs module, so the same encode/decode step doubles as a
 * "prepare a new stream for the SDK" scenario (run encode-decode.mjs standalone).
 *
 * --inter selects inter (low-delay, P-frames) video configs and is passed straight through to
 * Phase 1's encoder command line (displacements-ld.cfg / texture-ld.cfg + analyzeGof=1).
 *
 * The SDK is browser-only (Web Worker + WASM base-mesh decoder, WebCodecs HEVC displacement/texture
 * video, WebGL2 subdivision/displacement shader), driven here through system Microsoft Edge via
 * playwright-core, serving /sdk/ through the repo's serve.py for cross-origin isolation.
 *
 * Usage: node run-verification.mjs [--frame 445] [--count 1] [--inter] [--dispScale 1.0] [--headed] [--keep]
 *        node run-verification.mjs --sphere   (encode+verify the local clean sphere asset instead of football)
 */

import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { encodeDecode, listNumbered, newTestDir, REPO_ROOT } from './encode-decode.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --------------------------------------------------------------------------- paths / config
const SERVE_PY  = path.join(REPO_ROOT, 'serve.py');
// Chromium-based browser with WebCodecs HEVC support; override with VDMC_EDGE_EXE.
const EDGE_EXE  = process.env.VDMC_EDGE_EXE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PAGE_NAME = '_sdk-decode-page.html';                          // generated, served, then removed

// --------------------------------------------------------------------------- CLI args
const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : def;
};
// --sphere: encode the clean local sphere asset instead of the football sequence (isolates SDK
// reconstruction on a simple, known-good surface). Sets the source-override env vars encode-decode
// reads, plus a [0,1024] quantization box matching the sphere's coordinate range; defaults to frame 0.
const SPHERE    = !!getArg('sphere', false);
if (SPHERE) {
  const sph = path.join(__dirname, 'assets', 'sphere');
  process.env.VDMC_SRC_OBJ = path.join(sph, 'sphere_1051_dec.obj');
  process.env.VDMC_SRC_PNG = path.join(sph, 'sphere.png');
  process.env.VDMC_MINPOS = process.env.VDMC_MINPOS || '0,0,0';
  process.env.VDMC_MAXPOS = process.env.VDMC_MAXPOS || '1024,1024,1024';
}
const FRAME     = parseInt(getArg('frame', SPHERE ? '0' : '445'), 10);
const COUNT     = Math.max(1, parseInt(getArg('count', '1'), 10));
const INTER     = !!getArg('inter', false);
const DISP_SCALE = parseFloat(getArg('dispScale', '1.0'));
const HEADED    = !!getArg('headed', false);
const KEEP      = !!getArg('keep', false);
const PORT      = parseInt(getArg('port', '8099'), 10);
const FRAMES    = Array.from({ length: COUNT }, (_, i) => FRAME + i);

// Phase 0 — timestamped test folder (name extension = .YYMMDDHHmm, plus _N if the minute is taken)
// + per-phase subfolders.
const TEST_DIR = newTestDir();
const REF_DIR  = path.join(TEST_DIR, 'reference');
const DEC_DIR  = path.join(TEST_DIR, 'decoded');
const VER_DIR  = path.join(TEST_DIR, 'verification');

const REPORT_FILE = () => path.join(VER_DIR, 'verification_report.log');

const log  = (...a) => console.log('\x1b[36m[test]\x1b[0m', ...a);
const ok   = (...a) => console.log('\x1b[32m[ ok ]\x1b[0m', ...a);
const warn = (...a) => console.log('\x1b[33m[warn]\x1b[0m', ...a);
const fail = (...a) => console.log('\x1b[31m[fail]\x1b[0m', ...a);

// Report accumulator: R() lines are printed AND collected into verification_report.log.
const reportLines = [];
const R = (line = '') => { console.log(line); reportLines.push(line); };
function writeReport() {
  try { fs.mkdirSync(VER_DIR, { recursive: true }); fs.writeFileSync(REPORT_FILE(), reportLines.join('\n') + '\n'); } catch (e) {}
}

// --------------------------------------------------------------------------- small utils
function waitPort(port, timeoutMs = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const s = net.connect(port, '127.0.0.1');
      s.on('connect', () => { s.destroy(); resolve(); });
      s.on('error', () => {
        s.destroy();
        if (Date.now() - start > timeoutMs) reject(new Error('serve.py did not open port ' + port));
        else setTimeout(tryOnce, 200);
      });
    };
    tryOnce();
  });
}

// Parse OBJ 'v' lines into a flat Float64Array [x0,y0,z0, x1,...].
function parseObjVertices(file) {
  const txt = fs.readFileSync(file, 'utf8');
  const out = [];
  let faces = 0;
  for (const line of txt.split('\n')) {
    if (line.charCodeAt(0) === 118 /* v */ && line[1] === ' ') {
      const p = line.split(/\s+/);
      out.push(+p[1], +p[2], +p[3]);
    } else if (line.charCodeAt(0) === 102 /* f */ && line[1] === ' ') {
      faces++;
    }
  }
  return { verts: Float64Array.from(out), faces };
}

function bbox(P) {
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3)
    for (let d = 0; d < 3; d++) { const v = P[i + d]; if (v < mn[d]) mn[d] = v; if (v > mx[d]) mx[d] = v; }
  return { mn, mx, diag: Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) };
}

// A uniform spatial hash over a point cloud, with a nearest-point query (expanding-shell search).
function makeGrid(P) {
  const bb = bbox(P);
  const cell = Math.max(bb.diag / Math.cbrt(P.length / 3) * 1.5, 1e-9);
  const g = new Map();
  for (let i = 0; i < P.length; i += 3) {
    const k = Math.floor(P[i] / cell) + ',' + Math.floor(P[i + 1] / cell) + ',' + Math.floor(P[i + 2] / cell);
    let a = g.get(k); if (!a) { a = []; g.set(k, a); } a.push(i);
  }
  return {
    diag: bb.diag,
    nearestSq(qx, qy, qz) {
      const cx = Math.floor(qx / cell), cy = Math.floor(qy / cell), cz = Math.floor(qz / cell);
      let best = Infinity;
      for (let r = 0; r < 64; r++) {
        for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue; // shell only
          const a = g.get((cx + dx) + ',' + (cy + dy) + ',' + (cz + dz));
          if (!a) continue;
          for (const idx of a) {
            const d = (P[idx] - qx) ** 2 + (P[idx + 1] - qy) ** 2 + (P[idx + 2] - qz) ** 2;
            if (d < best) best = d;
          }
        }
        if (best < Infinity && (r * cell) ** 2 > best) break; // guaranteed nearest
      }
      return best;
    },
  };
}

// Directed RMSE + max nearest-neighbour distance from query cloud Q to target grid.
function directedStats(Q, grid) {
  let sum = 0, mx = 0, cnt = Q.length / 3;
  for (let i = 0; i < Q.length; i += 3) {
    const d2 = grid.nearestSq(Q[i], Q[i + 1], Q[i + 2]);
    sum += d2; if (d2 > mx) mx = d2;
  }
  return { rmse: Math.sqrt(sum / cnt), max: Math.sqrt(mx) };
}

// Symmetric nearest-neighbour comparison (A = reference rec.obj, B = SDK reconstruction).
function nearestNeighbourStats(A, B) {
  const gridA = makeGrid(A), gridB = makeGrid(B);
  return { a2b: directedStats(A, gridB), b2a: directedStats(B, gridA), diag: gridA.diag };
}

// --------------------------------------------------------------------------- browser page
// Generated at runtime and served under /sdk/'s sibling tree so /sdk/ imports resolve. It runs
// the REAL SDK (VDMCMeshStream) to decode base mesh + HEVC displacement, then reconstructs the
// displaced surface in JS using the SDK's own subdivision-numbering module — mirroring the
// WebGL vertex shader in sdk/src/SubdivideMesh.js exactly (midpoint base surface + per-vertex
// V-DMC displacement via vertex-index addressing).
function browserPageHtml() {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>SDK decode</title></head>
<body>
<script>
(function () {
  var _send = function (level, msg) {
    try { fetch('/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: level, msg: msg }) }).catch(function(){}); } catch (e) {}
  };
  ['log','info','warn','error'].forEach(function (lvl) {
    var orig = console[lvl].bind(console);
    console[lvl] = function () { var m = Array.prototype.map.call(arguments, function (a) { try { return typeof a === 'object' ? JSON.stringify(a) : String(a); } catch (e) { return String(a); } }).join(' '); orig.apply(null, arguments); _send(lvl, m); };
  });
  window.addEventListener('error', function (e) { _send('error', 'Uncaught: ' + e.message + ' @ ' + e.filename + ':' + e.lineno); });
  window.addEventListener('unhandledrejection', function (e) { _send('error', 'UnhandledPromise: ' + (e.reason && e.reason.message || e.reason)); });
})();
</script>
<script type="importmap">
{ "imports": { "three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js", "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/" } }
</script>
<script type="module">
import * as THREE from 'three';
import { VDMCMeshStream } from '/sdk/src/VDMCMeshStream.js';
import { captureShaderOutput, captureToObj } from '/verification/gpu-capture.mjs';

const q = new URLSearchParams(location.search);
const vmeshUrl = q.get('vmesh');
const dispScale = parseFloat(q.get('dispScale') || '1.0');
const frameBase = parseInt(q.get('frame') || '0', 10);
const T = (m) => console.log('[TEST] ' + m);

function imageData(canvas) {
  const c = document.createElement('canvas'); c.width = canvas.width; c.height = canvas.height;
  const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(canvas, 0, 0);
  return ctx.getImageData(0, 0, c.width, c.height);
}

// Dump the browser's decoded displacement (R channel) so it can be diffed against the native YUV.
function dumpDisp(dimg) {
  if (dimg && dimg.data && dimg.width) return { w: dimg.width, h: dimg.height, bits: 'f32', r: Array.from(dimg.data) };
  const id = imageData(dimg), w = dimg.width, h = dimg.height, r = new Array(w * h);
  for (let i = 0; i < w * h; i++) r[i] = id.data[i * 4]; // 0..255
  return { w, h, bits: 8, r };
}

// OffscreenCanvas has no toDataURL; blit onto a regular canvas to encode PNG.
function toPngDataUrl(src) {
  const c = document.createElement('canvas'); c.width = src.width; c.height = src.height;
  c.getContext('2d').drawImage(src, 0, 0);
  return c.toDataURL('image/png');
}

// Serialize the SDK's raw indexed base mesh (canonical order, dequantized) as an OBJ with UVs.
function serializeBaseObj(bd) {
  if (!bd) return null;
  const { positions, indices, uvs, uvIndices } = bd;
  const nV = positions.length / 3;
  const haveUv = uvs && uvs.length && uvIndices && uvIndices.length === indices.length;
  const parts = ['# SDK base mesh (indexed, dequantized, canonical order)\\n'];
  let buf = '';
  for (let i = 0; i < nV; i++) buf += 'v ' + positions[i*3] + ' ' + positions[i*3+1] + ' ' + positions[i*3+2] + '\\n';
  if (haveUv) { const nT = uvs.length / 2; for (let i = 0; i < nT; i++) buf += 'vt ' + uvs[i*2] + ' ' + uvs[i*2+1] + '\\n'; }
  for (let c = 0; c < indices.length; c += 3) {
    buf += haveUv
      ? 'f ' + (indices[c]+1) + '/' + (uvIndices[c]+1) + ' ' + (indices[c+1]+1) + '/' + (uvIndices[c+1]+1) + ' ' + (indices[c+2]+1) + '/' + (uvIndices[c+2]+1) + '\\n'
      : 'f ' + (indices[c]+1) + ' ' + (indices[c+1]+1) + ' ' + (indices[c+2]+1) + '\\n';
  }
  parts.push(buf);
  return parts.join('');
}

let finished = false;
const expected = parseInt(q.get('count') || '1', 10);
const frames = [];

// The SDK decodes texture/displacement video straight into GPU textures, so it requires a real
// renderer; the capture then reads the shader's own output back out of that same context.
const canvas = document.createElement('canvas');
canvas.width = canvas.height = 16;
document.body.appendChild(canvas);
const renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: false });

const stream = new VDMCMeshStream({ dispScale: dispScale, renderer: renderer, onLog: (m) => console.log('[SDK] ' + m) });
stream.onMode = (m) => { window.__MODE__ = m; T('mode=' + m); };
function finalize() {
  if (finished) return;
  finished = true;
  if (frames.length === 0) { window.__ERROR__ = window.__ERROR__ || ('no displaced frame produced (mode=' + stream.mode + ')'); T('complete-no-result mode=' + stream.mode); return; }
  window.__RESULT__ = { frames: frames, expected: expected };
  T('RESULT frames=' + frames.length + '/' + expected);
}
stream.onFrame = (frame) => {
  if (finished) return;
  if (!frame.dispParams || !frame.mesh) { T('frame ' + frame.index + ' has no displacement (mode=' + stream.mode + ')'); return; }
  try {
    const cap = captureShaderOutput(frame.mesh, renderer);
    const out = captureToObj(cap, frame.mesh, 'V-DMC SDK GPU capture (dispScale=' + dispScale + ', ' + cap.method + ')');
    const texPng = frame.textureImage ? toPngDataUrl(frame.textureImage) : null;
    const small = cap.total < 300000;
    frames.push({
      index: frame.index,
      obj: out.obj, texPng: texPng,
      vertices: out.vertices, faces: out.faces, method: cap.method,
      dispW: frame.dispParams.dispWidth, dispH: frame.dispParams.dispHeight,
      subdiv: frame.dispParams.subdivIterationCount,
      baseVerts: frame.dispParams.baseVertexCount, baseEdges: frame.dispParams.baseEdgesCount,
      // Frame-0 dispParams (JSON-safe) so the parity test can reconstruct OUR encode.
      dispParams: frames.length === 0 ? {
        subdivIterationCount: frame.dispParams.subdivIterationCount,
        dispWidth: frame.dispParams.dispWidth, dispHeight: frame.dispParams.dispHeight,
        log2BlockSize: frame.dispParams.log2BlockSize, packingMethod: frame.dispParams.packingMethod,
        geomBitDepth: frame.dispParams.geomBitDepth, oneDimDisplacementFlag: frame.dispParams.oneDimDisplacementFlag,
        lodCount: frame.dispParams.lodCount, dispDimension: frame.dispParams.dispDimension,
        baseVertexCount: frame.dispParams.baseVertexCount, baseEdgesCount: frame.dispParams.baseEdgesCount,
        iscale: Array.from(frame.dispParams.iscale || []),
        edgeTable: Array.from(frame.dispParams.edgeTable || []),
      } : undefined,
      baseObj: frames.length === 0 ? serializeBaseObj(frame.baseGeometry.userData && frame.baseGeometry.userData.baseData) : undefined,
      // Exact per-vertex check payload (dIdx + positions). Gated by size to bound the page->node
      // payload; raised high enough to cover a single full football frame for step-by-step debug.
      gpuDIdx: small ? Array.from(cap.dIdx) : null,
      gpuPos: small ? Array.from(cap.pos) : null,
      dispDump: (frames.length === 0 && frame.displacementImage) ? dumpDisp(frame.displacementImage) : undefined,
    });
    T('frame ' + frame.index + ' captured (' + frames.length + '/' + expected + ') vertices=' + out.vertices + ' via ' + cap.method);
    if (frames.length >= expected) finalize();
  } catch (e) { window.__ERROR__ = String(e && e.stack || e); finished = true; T('ERROR ' + window.__ERROR__); }
};
stream.onComplete = () => finalize();
stream.onReady = () => { T('decoder ready, loading ' + vmeshUrl); stream.loadUrl(vmeshUrl).catch((e) => { window.__ERROR__ = String(e); T('load error ' + e); }); };
</script>
</body></html>`;
}

// --------------------------------------------------------------------------- steps
async function step3_decodeSdk() {
  log('--- PHASE 2: decode with the web SDK (headless Edge + WebCodecs HEVC) -> decoded/ ---');
  fs.mkdirSync(DEC_DIR, { recursive: true });
  const pagePath = path.join(__dirname, PAGE_NAME);
  fs.writeFileSync(pagePath, browserPageHtml());

  const serve = spawn('python', [SERVE_PY, String(PORT)], { cwd: REPO_ROOT, stdio: 'inherit' });
  let browser;
  try {
    await waitPort(PORT);
    const relPage  = path.relative(REPO_ROOT, pagePath).split(path.sep).join('/');
    const relVmesh = path.relative(REPO_ROOT, path.join(REF_DIR, 'out.vmesh')).split(path.sep).join('/');
    const vmeshUrl = `/${relVmesh}`;
    const pageUrl = `http://localhost:${PORT}/${relPage}?vmesh=${encodeURIComponent(vmeshUrl)}&dispScale=${DISP_SCALE}&count=${COUNT}&frame=${FRAME}`;
    log('page:', pageUrl);

    browser = await chromium.launch({
      executablePath: EDGE_EXE,
      headless: !HEADED,
      channel: undefined,
      args: ['--autoplay-policy=no-user-gesture-required'],
    });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on('console', (m) => { const t = m.text(); if (t.includes('[TEST]') || t.includes('error')) log('browser>', t); });
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });

    await page.waitForFunction(() => window.__RESULT__ || window.__ERROR__, null, { timeout: 180000 });
    const err = await page.evaluate(() => window.__ERROR__ || null);
    if (err) throw new Error('SDK page error: ' + err);
    const result = await page.evaluate(() => window.__RESULT__);

    if (result.frames.length < result.expected)
      warn(`SDK produced ${result.frames.length}/${result.expected} displaced frames`);

    const outFrames = result.frames.map((fr, i) => {
      const f4 = String(FRAME + i).padStart(4, '0');
      const sdkObj = path.join(DEC_DIR, `sdk_decoded_${f4}.obj`);
      fs.writeFileSync(sdkObj, fr.obj);
      let texNote = '';
      if (fr.texPng) {
        const pngName = `sdk_decoded_${f4}.png`;
        const b64 = fr.texPng.replace(/^data:image\/png;base64,/, '');
        fs.writeFileSync(path.join(DEC_DIR, pngName), Buffer.from(b64, 'base64'));
        texNote = `, tex ${pngName}`;
      }
      ok(`SDK frame ${FRAME + i}: sdk_decoded_${f4}.obj (${fr.vertices} verts, ${fr.faces} faces, subdiv=${fr.subdiv}, disp ${fr.dispW}x${fr.dispH}${texNote})`);
      ok(`  captured from the live shader via ${fr.method}`);
      return { sdkObj, meta: fr };
    });
    // Persist frame-0 dispParams + SDK base mesh next to the reference for the parity test.
    if (result.frames[0] && result.frames[0].dispParams)
      fs.writeFileSync(path.join(REF_DIR, 'dispParams.json'), JSON.stringify(result.frames[0].dispParams, null, 2));
    if (result.frames[0] && result.frames[0].baseObj)
      fs.writeFileSync(path.join(REF_DIR, 'base_sdk.obj'), result.frames[0].baseObj);
    if (result.frames[0] && result.frames[0].dispDump)
      fs.writeFileSync(path.join(REF_DIR, 'browser_disp.json'), JSON.stringify(result.frames[0].dispDump));
    return outFrames;
  } finally {
    if (browser) await browser.close().catch(() => {});
    serve.kill();
    if (!KEEP) try { fs.unlinkSync(pagePath); } catch (e) {}
  }
}

function step4_compare(sdkFrames, p1) {
  const recFiles = p1.recFiles, nativeFiles = p1.decFiles;
  log('--- PHASE 3: compare SDK OBJ vs reference rec_*.obj (per frame) -> verification/ ---');
  const TOL = 0.02; // 2% of bbox diagonal

  R('============================ V-DMC SDK VERIFICATION REPORT ============================');
  R('date            : ' + new Date().toISOString());
  R(`test folder     : ${path.relative(REPO_ROOT, TEST_DIR).split(path.sep).join('/')}`);
  R(`frames          : ${FRAME}..${FRAME + COUNT - 1} (${COUNT})`);
  R(`mode            : ${p1.inter ? 'INTER (low-delay, P-frames)' : 'INTRA (all-intra)'}`);
  R(`dispScale       : ${DISP_SCALE}`);
  R(`encoder log     : reference/${path.basename(p1.encoderLog)}`);
  R(`decoder log     : reference/${path.basename(p1.decoderLog)}`);
  R(`pass tolerance  : ${(TOL * 100).toFixed(0)}% of bbox diagonal`);
  R('');

  let allPass = true;
  for (let i = 0; i < sdkFrames.length; i++) {
    const frameNo = FRAME + i;
    const recPath = recFiles[i];
    if (!recPath || !fs.existsSync(recPath)) { R(`frame ${frameNo}: MISSING encoder rec obj — SKIPPED`); allPass = false; continue; }
    const rec = parseObjVertices(recPath);
    const sdk = parseObjVertices(sdkFrames[i].sdkObj);

    // The SDK mesh is the real shader output, captured off the GPU — not a CPU re-derivation.
    const s = nearestNeighbourStats(rec.verts, sdk.verts);
    const pct = (v) => (100 * v / s.diag).toFixed(3) + '%';
    const framePass = (s.a2b.rmse / s.diag) <= TOL;
    allPass = allPass && framePass;

    R(`---- frame ${frameNo}  [${framePass ? 'PASS' : 'FAIL'}] --------------------------------------------------`);
    R(`  rec (${path.basename(recPath)}) : ${rec.verts.length / 3} verts, ${rec.faces} faces`);
    R(`  sdk gpu capture         : ${sdk.verts.length / 3} verts, ${sdk.faces} faces (${sdkFrames[i].meta.method})`);
    R(`  bbox diagonal (rec)     : ${s.diag.toFixed(4)}`);
    R('                             RMSE            max');
    R(`  rec -> sdk           :   ${s.a2b.rmse.toFixed(5)} (${pct(s.a2b.rmse)})   ${s.a2b.max.toFixed(5)}`);
    R(`  sdk -> rec           :   ${s.b2a.rmse.toFixed(5)} (${pct(s.b2a.rmse)})   ${s.b2a.max.toFixed(5)}`);
    if (nativeFiles[i] && fs.existsSync(nativeFiles[i])) {
      const nat = parseObjVertices(nativeFiles[i]);
      const sNat = nearestNeighbourStats(nat.verts, sdk.verts);
      R(`  decode.exe -> sdk    :   ${sNat.a2b.rmse.toFixed(5)} (${pct(sNat.a2b.rmse)})   ${sNat.a2b.max.toFixed(5)}`);

      // Exact per-vertex check indexed by dIdx (decoded_%04d.obj is in global dIdx order). This
      // removes the nearest-neighbour confound — the same metric parity test.html reports.
      const meta = sdkFrames[i].meta;
      if (meta && meta.gpuDIdx && meta.gpuPos) {
        const nv = nat.verts.length / 3;
        let sum = 0, mx = 0, n = 0, dmin = 1e9, dmax = -1e9, worst = null;
        for (let k = 0; k < meta.gpuDIdx.length; k++) {
          const d = meta.gpuDIdx[k];
          if (d < dmin) dmin = d; if (d > dmax) dmax = d;
          if (d < 0 || d >= nv) continue;
          const dx = meta.gpuPos[k * 3] - nat.verts[d * 3];
          const dy = meta.gpuPos[k * 3 + 1] - nat.verts[d * 3 + 1];
          const dz = meta.gpuPos[k * 3 + 2] - nat.verts[d * 3 + 2];
          const e2 = dx * dx + dy * dy + dz * dz; sum += e2; if (e2 > mx) { mx = e2; worst = { k, d, g: [meta.gpuPos[k*3],meta.gpuPos[k*3+1],meta.gpuPos[k*3+2]], r: [nat.verts[d*3],nat.verts[d*3+1],nat.verts[d*3+2]] }; } n++;
        }
        if (n) R(`  exact per-vertex(dIdx):  ${Math.sqrt(sum / n).toFixed(5)} (${pct(Math.sqrt(sum / n))})   ${Math.sqrt(mx).toFixed(5)}  [${n}/${meta.gpuDIdx.length} matched]`);
        R(`  [diag] nat verts=${nv}, gpuDIdx range=${dmin}..${dmax}` + (worst ? `, worst dIdx=${worst.d} gpu=(${worst.g.map(v=>v.toFixed(1))}) ref=(${worst.r.map(v=>v.toFixed(1))})` : ''));
      }
    }
    R('');
  }

  R('======================================================================================');
  if (allPass) { R(`OVERALL: PASS — all ${sdkFrames.length} frame(s) within ${(TOL * 100).toFixed(0)}% of model size`); }
  else { R(`OVERALL: FAIL — one or more frames exceeded tolerance`); }
  R('======================================================================================');

  writeReport();
  if (allPass) ok(`report: ${path.basename(REPORT_FILE())} — PASS`);
  else fail(`report: ${path.basename(REPORT_FILE())} — FAIL`);
  return allPass ? 0 : 1;
}

// --------------------------------------------------------------------------- main
(async () => {
  log(`V-DMC SDK verification — frames ${FRAME}..${FRAME + COUNT - 1}, ${INTER ? 'INTER' : 'INTRA'}, dispScale ${DISP_SCALE}, ${HEADED ? 'headed' : 'headless'} Edge`);
  for (const p of [SERVE_PY, EDGE_EXE]) if (!fs.existsSync(p)) throw new Error('required tool not found: ' + p);

  // Phase 0 — create the timestamped test folder + per-phase subfolders.
  fs.mkdirSync(REF_DIR, { recursive: true });
  fs.mkdirSync(DEC_DIR, { recursive: true });
  fs.mkdirSync(VER_DIR, { recursive: true });
  log(`--- PHASE 0: test folder ${path.relative(REPO_ROOT, TEST_DIR).split(path.sep).join('/')} ---`);

  // Phase 1 — native encode + decode into reference/ (reusable encode-decode.mjs).
  log('--- PHASE 1: native encode + decode (encode-decode.mjs) -> reference/ ---');
  const p1 = encodeDecode({ frame: FRAME, count: COUNT, inter: INTER, outDir: REF_DIR });

  // Phase 2 — web SDK decode into decoded/.
  const sdkFrames = await step3_decodeSdk();

  // Phase 3 — compare into verification/.
  const code = step4_compare(sdkFrames, p1);
  log(`artifacts in ${path.relative(REPO_ROOT, TEST_DIR).split(path.sep).join('/')} — reference/, decoded/, verification/${KEEP ? ' (page kept)' : ''}`);
  process.exit(code);
})().catch((e) => { fail(e.stack || e.message || String(e)); try { writeReport(); } catch (_) {} process.exit(2); });
