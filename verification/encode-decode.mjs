/**
 * © 2026 Nokia
 *
 * Licensed under the 5G-MAG Public License (v1.0)
 */

/**
 * encode-decode.mjs — Phase 1 of the V-DMC pipeline (native reference encode + decode).
 *
 * Runs the desktop reference tools (encode.exe -> out.vmesh + rec_%04d.obj, then decode.exe ->
 * decoded_%04d.obj/.png) into a single output directory. This is deliberately standalone so it can
 * be used two ways:
 *   1. As the first stage of run-verification.mjs (the SDK is validated against these outputs).
 *   2. On its own, as a "prepare a new stream for the SDK" scenario — e.g. to generate an
 *      out.vmesh (+ reference OBJ/PNG) that the web SDK / sample app can then load.
 *
 * Intra vs inter (P-frames): with --inter the displacement/texture video substreams use the
 * low-delay HM configs (displacements-ld.cfg / texture-ld.cfg) and --analyzeGof=1, matching the
 * reference "ld" condition (cfg-cond-ld.yaml). Without it, the all-intra configs are used
 * (displacements-ai.cfg / texture-ai.cfg, --analyzeGof=0) and every frame is an I-frame.
 *
 * CLI:  node encode-decode.mjs [--frame 445] [--count 1] [--inter] [--out <dir>]
 * API:  import { encodeDecode } from './encode-decode.mjs'
 *
 * Environment:
 *   VDMC_INPUT_DIR         directory holding football_fr%04d_qp12_qt13.obj / football_fr%04d.png
 *                          (default: <package root>/input/football_voxelized)
 *   VDMC_SRC_OBJ/_SRC_PNG  single-mesh source override (used by run-verification.mjs --sphere)
 *   VDMC_MINPOS/_MAXPOS    quantization box override for that source
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --------------------------------------------------------------------------- paths / config
export const REPO_ROOT = path.resolve(__dirname, '..');             // package root
const TM_BIN     = path.join(REPO_ROOT, 'tm-reference', 'bin');
const TM_CFG_HM  = path.join(REPO_ROOT, 'tm-reference', 'cfg', 'hm');
const TM_CFG_HDR = path.join(REPO_ROOT, 'tm-reference', 'cfg', 'hdrconvert');
const ENCODE_EXE = path.join(TM_BIN, 'encode.exe');
const DECODE_EXE = path.join(TM_BIN, 'decode.exe');
// Directory holding the football source frames; override with VDMC_INPUT_DIR.
const INPUT_DIR  = process.env.VDMC_INPUT_DIR || path.join(REPO_ROOT, 'input', 'football_voxelized');
const CFG_FILE   = path.join(__dirname, 'encoder.cfg');

// Football sequence quantization box (tm-reference/cfg/sequences.yaml, seq-id 7). The encoder
// input is the pre-quantized integer mesh (football_fr%04d_qp12_qt13.obj: 12-bit positions,
// 13-bit texcoords); these bounds give the encoder the real-world box for de/re-quantization.
// Feeding a raw float mesh instead collapses the 0..1 UVs to ~0 and yields a flat texture.
const SEQ_MIN_POS = '0.00728459982,-0.00232295995,-0.0394272991';
const SEQ_MAX_POS = '1023.96997,980.596008,966.742004';
const SRC_MESH_SUFFIX = '_qp12_qt13';

const log  = (...a) => console.log('\x1b[36m[enc]\x1b[0m', ...a);
const ok   = (...a) => console.log('\x1b[32m[ ok ]\x1b[0m', ...a);
const warn = (...a) => console.log('\x1b[33m[warn]\x1b[0m', ...a);

function sh(exe, argv, opts = {}) {
  const { logFile, ...rest } = opts;
  log('run:', path.basename(exe), argv.join(' '));
  if (logFile) {
    const r = spawnSync(exe, argv, { encoding: 'buffer', ...rest });
    const out = Buffer.concat([r.stdout || Buffer.alloc(0), r.stderr || Buffer.alloc(0)]);
    fs.writeFileSync(logFile, out);
    process.stdout.write(out);
    if (r.status !== 0) throw new Error(`${path.basename(exe)} exited with ${r.status} (see ${path.basename(logFile)})`);
    return;
  }
  const r = spawnSync(exe, argv, { stdio: 'inherit', ...rest });
  if (r.status !== 0) throw new Error(`${path.basename(exe)} exited with ${r.status}`);
}

// List existing files matching a `<prefix>_NNNN.<ext>` pattern, sorted by numeric index.
export function listNumbered(dir, prefix, ext) {
  if (!fs.existsSync(dir)) return [];
  const re = new RegExp('^' + prefix + '_(\\d+)\\.' + ext + '$');
  return fs.readdirSync(dir)
    .map((n) => { const m = n.match(re); return m ? { name: n, idx: parseInt(m[1], 10) } : null; })
    .filter(Boolean)
    .sort((a, b) => a.idx - b.idx)
    .map((e) => path.join(dir, e.name));
}

/**
 * Native encode + decode into `outDir`.
 * @param {object} o
 * @param {number} o.frame  first frame index (default 445)
 * @param {number} o.count  number of frames (default 1)
 * @param {boolean} o.inter use inter (low-delay, P-frames) video configs (default false)
 * @param {string} o.outDir directory to write all reference artifacts into (required)
 * @returns {{vmesh:string, recFiles:string[], decFiles:string[], encoderLog:string, decoderLog:string, inter:boolean}}
 */
export function encodeDecode({ frame = 445, count = 1, inter = false, outDir }) {
  if (!outDir) throw new Error('encodeDecode: outDir is required');
  for (const p of [ENCODE_EXE, DECODE_EXE]) if (!fs.existsSync(p)) throw new Error('required tool not found: ' + p);

  const frames = Array.from({ length: Math.max(1, count) }, (_, i) => frame + i);
  const encoderLog = path.join(outDir, 'encoder.log');
  const decoderLog = path.join(outDir, 'decoder.log');
  const dispCfg = inter ? 'displacements-ld.cfg' : 'displacements-ai.cfg';
  const texCfg  = inter ? 'texture-ld.cfg'       : 'texture-ai.cfg';

  // ---- encode ----
  log(`Phase 1 encode: frames ${frame}..${frame + frames.length - 1}, mode ${inter ? 'INTER (ld, P-frames)' : 'INTRA (ai)'}`);
  fs.mkdirSync(outDir, { recursive: true });

  // Optional source override (single mesh for all frames) — used e.g. to encode a clean sphere
  // instead of the football sequence. VDMC_SRC_OBJ/PNG point at the files, VDMC_MINPOS/MAXPOS give
  // the quantization box for that mesh.
  const OV_OBJ = process.env.VDMC_SRC_OBJ;
  const OV_PNG = process.env.VDMC_SRC_PNG;
  for (const f of frames) {
    const f4 = String(f).padStart(4, '0');
    const srcObj = OV_OBJ || path.join(INPUT_DIR, `football_fr${f4}${SRC_MESH_SUFFIX}.obj`);
    const srcPng = OV_PNG || path.join(INPUT_DIR, `football_fr${f4}.png`);
    if (!fs.existsSync(srcObj)) throw new Error('missing source mesh: ' + srcObj);
    fs.copyFileSync(srcObj, path.join(outDir, `frame_${f4}.obj`));
    if (fs.existsSync(srcPng)) fs.copyFileSync(srcPng, path.join(outDir, `frame_${f4}.png`));
  }

  const encArgv = [
    `--config=${CFG_FILE}`,
    `--srcMesh=frame_%04d.obj`,
    `--srcTex=frame_%04d.png`,
    `--startFrameIndex=${frame}`,
    `--frameCount=${frames.length}`,
    `--minPosition=${process.env.VDMC_MINPOS || SEQ_MIN_POS}`,
    `--maxPosition=${process.env.VDMC_MAXPOS || SEQ_MAX_POS}`,
    `--analyzeGof=${inter ? 1 : 0}`,
    `--compressed=out.vmesh`,
    `--recMesh=rec_%04d.obj`,
    `--recMat=rec_%04d.mtl`,
    `--geometryVideoEncoderConfig=${path.join(TM_CFG_HM, dispCfg)}`,
    `--textureVideoEncoderConfig=${path.join(TM_CFG_HM, texCfg)}`,
    // RGB<->YUV420 color conversion (built-in InternalColourConverter): without these the
    // encoded texture video is empty/flat. Matches the reference cfg-tools.yaml pipeline.
    `--textureVideoEncoderConvertConfig=${path.join(TM_CFG_HDR, 'bgr444toyuv420.cfg')}`,
    `--textureVideoDecoderConvertConfig=${path.join(TM_CFG_HDR, 'yuv420tobgr444.cfg')}`,
  ];
  sh(ENCODE_EXE, encArgv, { cwd: outDir, logFile: encoderLog });

  const vmesh = path.join(outDir, 'out.vmesh');
  const recFiles = listNumbered(outDir, 'rec', 'obj');
  if (!fs.existsSync(vmesh)) throw new Error('encoder did not produce out.vmesh');
  if (recFiles.length === 0) throw new Error('encoder did not produce any rec_%04d.obj');
  ok(`encoded: out.vmesh (${fs.statSync(vmesh).size} B), ${recFiles.length} rec_*.obj — log: ${path.basename(encoderLog)}`);

  // ---- decode ----
  log('Phase 1 decode: decode.exe (native reference)');
  const decArgv = [
    `--compressed=out.vmesh`,
    `--decMesh=decoded_%04d.obj`,
    `--decMat=decoded_%04d.mtl`,
    `--decTex=decoded_%04d.png`,
    // Dump the native decoder's raw displacement YUV + base mesh so the parity test.html
    // can reconstruct from OUR encode with the reference displacement (isolates the browser path).
    `--keepVideoFiles`,
    `--keepBaseMesh`,
    `--textureVideoDecoderConvertConfig=${path.join(TM_CFG_HDR, 'yuv420tobgr444.cfg')}`,
  ];
  sh(DECODE_EXE, decArgv, { cwd: outDir, logFile: decoderLog });

  const decFiles = listNumbered(outDir, 'decoded', 'obj');
  if (decFiles.length) ok(`native decode: ${decFiles.length} decoded_*.obj — log: ${path.basename(decoderLog)}`);
  else warn('native decoded OBJ not found');

  return { vmesh, recFiles, decFiles, encoderLog, decoderLog, inter: !!inter };
}

// --------------------------------------------------------------------------- standalone CLI
export function timestamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${p(d.getFullYear() % 100)}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
}

// A fresh run folder  <runsRoot>/test.<YYMMDDHHmm>  — if that already exists (another run in the
// same minute), append an incremental _1, _2, ... suffix until a free (new) name is found.
export function newTestDir(runsRoot = path.join(__dirname, 'runs')) {
  const stamp = timestamp();
  let dir = path.join(runsRoot, `test.${stamp}`);
  for (let n = 1; fs.existsSync(dir); n++) dir = path.join(runsRoot, `test.${stamp}_${n}`);
  return dir;
}

// Run directly (not imported) => execute a standalone encode/decode.
if (path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const getArg = (name, def) => {
    const i = args.indexOf('--' + name);
    return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : def;
  };
  const frame = parseInt(getArg('frame', '445'), 10);
  const count = Math.max(1, parseInt(getArg('count', '1'), 10));
  const inter = !!getArg('inter', false);
  const outDir = typeof getArg('out', null) === 'string'
    ? path.resolve(String(getArg('out', null)))
    : path.join(newTestDir(), 'reference');

  try {
    const r = encodeDecode({ frame, count, inter, outDir });
    ok(`Phase 1 done — reference artifacts in ${outDir}`);
    console.log('  vmesh   :', r.vmesh);
    console.log('  rec     :', r.recFiles.length, 'file(s)');
    console.log('  decoded :', r.decFiles.length, 'file(s)');
    process.exit(0);
  } catch (e) {
    console.error('\x1b[31m[fail]\x1b[0m', e.stack || e.message || String(e));
    process.exit(2);
  }
}
