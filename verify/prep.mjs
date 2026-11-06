/**
 * © 2026 Nokia
 *
 * Licensed under the 5G-MAG Public License (v1.0)
 */

/**
 * prep.mjs — PC-side ground truth for the GPU reconstruction check.
 *
 * Given a V-DMC .vmesh, run the native reference decoder (decode.exe) to produce the decoded
 * mesh for frame 0 (decoded_0000.obj). That OBJ is the CPU ground truth; the browser test page
 * (verify/test.html) then reconstructs the SAME .vmesh entirely on the GPU via the SDK, captures
 * the shader output with transform feedback, and compares — no CPU/JS reconstruction anywhere.
 *
 * The exact same .vmesh + decoded_0000.obj are served to both desktop and mobile (adb reverse);
 * only this decode step runs on the PC.
 *
 * Two modes:
 *   node verify/prep.mjs                 encode a fresh SINGLE-frame football stream (fast default)
 *   node verify/prep.mjs <path.vmesh>    decode a provided .vmesh (uses its frame 0)
 *
 * The single-frame default exists because a multi-frame stream forces the SDK to decode the whole
 * texture+displacement video before frame 0's mesh is ready; one frame keeps the check quick.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeDecode } from '../verification/encode-decode.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const TM_BIN    = path.join(REPO_ROOT, 'tm-reference', 'bin');
const TM_CFG_HDR = path.join(REPO_ROOT, 'tm-reference', 'cfg', 'hdrconvert');
const DECODE_EXE = path.join(TM_BIN, 'decode.exe');
const DATA_DIR   = path.join(__dirname, 'data');

const log = (...a) => console.log('\x1b[36m[prep]\x1b[0m', ...a);
const ok  = (...a) => console.log('\x1b[32m[ ok ]\x1b[0m', ...a);

fs.mkdirSync(DATA_DIR, { recursive: true });
const vmeshDst = path.join(DATA_DIR, 'mesh.vmesh');
const frame0   = path.join(DATA_DIR, 'decoded_0000.obj');

// Clear prior outputs so a stale frame 0 can't be mistaken for a fresh one.
for (const n of fs.readdirSync(DATA_DIR)) {
  if (/^decoded_\d+\.(obj|mtl|png)$/.test(n) || n === 'mesh.vmesh' || /_dec_bitstream\.txt$/.test(n))
    fs.rmSync(path.join(DATA_DIR, n));
}

const srcArg = process.argv[2];
if (srcArg) {
  // ---- provided .vmesh: decode its frame 0 with the reference decoder --------------------------
  const srcVmesh = path.resolve(srcArg);
  if (!fs.existsSync(srcVmesh)) throw new Error('vmesh not found: ' + srcVmesh);
  if (!fs.existsSync(DECODE_EXE)) throw new Error('decode.exe not found: ' + DECODE_EXE);
  fs.copyFileSync(srcVmesh, vmeshDst);
  log(`vmesh: ${path.basename(srcVmesh)} (${fs.statSync(vmeshDst).size} B) -> data/mesh.vmesh`);

  const decArgv = [
    `--compressed=mesh.vmesh`,
    `--decMesh=decoded_%04d.obj`,
    `--decMat=decoded_%04d.mtl`,
    `--decTex=decoded_%04d.png`,
    `--textureVideoDecoderConvertConfig=${path.join(TM_CFG_HDR, 'yuv420tobgr444.cfg')}`,
  ];
  log('decode.exe', decArgv.join(' '));
  const r = spawnSync(DECODE_EXE, decArgv, { cwd: DATA_DIR, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`decode.exe exited with ${r.status}`);
} else {
  // ---- default: encode + decode a fresh SINGLE-frame football stream ---------------------------
  const encDir = path.join(DATA_DIR, '_enc');
  fs.rmSync(encDir, { recursive: true, force: true });
  log('no .vmesh given — encoding a single-frame football stream (frame 445)…');
  const res = encodeDecode({ frame: 445, count: 1, inter: false, outDir: encDir });
  fs.copyFileSync(res.vmesh, vmeshDst);
  fs.copyFileSync(path.join(encDir, 'decoded_0000.obj'), frame0);
  for (const ext of ['mtl', 'png'])
    if (fs.existsSync(path.join(encDir, `decoded_0000.${ext}`)))
      fs.copyFileSync(path.join(encDir, `decoded_0000.${ext}`), path.join(DATA_DIR, `decoded_0000.${ext}`));
  fs.rmSync(encDir, { recursive: true, force: true });
  log(`vmesh: single frame (${fs.statSync(vmeshDst).size} B) -> data/mesh.vmesh`);
}

// decode.exe decodes the whole stream; keep only frame 0, drop the rest + debug bitstream dumps.
for (const n of fs.readdirSync(DATA_DIR)) {
  if (/^decoded_(?!0000\.)\d+\.(obj|mtl|png)$/.test(n) || /_dec_bitstream\.txt$/.test(n))
    fs.rmSync(path.join(DATA_DIR, n));
}

if (!fs.existsSync(frame0)) throw new Error('did not produce decoded_0000.obj');
const nV = (fs.readFileSync(frame0, 'utf8').match(/^v /gm) || []).length;
ok(`ground truth: data/decoded_0000.obj (${nV} vertices)`);
console.log('open: http://localhost:8097/verify/test.html?dump');
