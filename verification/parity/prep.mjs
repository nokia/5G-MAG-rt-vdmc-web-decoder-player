/**
 * © 2026 Nokia
 *
 * Licensed under the 5G-MAG Public License (v1.0)
 */

/**
 * prep.mjs — assemble a parity dataset (data/<name>/) from a `--keep` verification run so that
 * test.html?data=<name> reconstructs OUR encode (native reference displacement) with the exact
 * per-vertex (dIdx) metric. Isolates the encode/shader chain from the browser video-decode path.
 *
 * Inputs (from <run>/reference/): fr_0_base_dec.ply (base mesh), disp_dec_<W>x<H>_10bits_p420.yuv
 * (native displacement), decoded_0000.obj (dIdx-order ground truth), dispParams.json (scale/dims).
 *
 * Usage: node prep.mjs [--data <name>] [<run reference dir>]
 *          --data <name>   destination dataset under data/ (default: sphere)
 *          <run ref dir>   defaults to the newest runs/test.<stamp>/reference
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNS = path.join(__dirname, '..', 'runs');

const argv = process.argv.slice(2);
const dataIdx = argv.indexOf('--data');
const DATA = dataIdx >= 0 ? argv[dataIdx + 1] : 'sphere';
if (dataIdx >= 0) argv.splice(dataIdx, 2);
const refArg = argv[0];

function newestRef() {
  const dirs = fs.readdirSync(RUNS).map(n => path.join(RUNS, n, 'reference'))
    .filter(p => fs.existsSync(path.join(p, 'dispParams.json')));
  if (!dirs.length) throw new Error('no run with dispParams.json — run: node run-verification.mjs --keep');
  return dirs.map(p => ({ p, t: fs.statSync(p).mtimeMs })).sort((a, b) => b.t - a.t)[0].p;
}

// Binary little-endian PLY (double xyz verts + int-index faces) -> OBJ (geometry only).
function plyToObj(plyPath) {
  const buf = fs.readFileSync(plyPath);
  const headerEnd = buf.indexOf('end_header\n') + 'end_header\n'.length;
  const header = buf.slice(0, headerEnd).toString('latin1');
  const nV = +(/element vertex (\d+)/.exec(header)[1]);
  const nF = +(/element face (\d+)/.exec(header)[1]);
  let o = headerEnd, out = '# base mesh (from PLY)\n';
  const V = [];
  for (let i = 0; i < nV; i++) {
    const x = buf.readDoubleLE(o); const y = buf.readDoubleLE(o + 8); const z = buf.readDoubleLE(o + 16);
    o += 24; V.push([x, y, z]);
    out += `v ${x} ${y} ${z}\n`;
  }
  for (let f = 0; f < nF; f++) {
    const n = buf.readUInt8(o); o += 1;
    const idx = [];
    for (let k = 0; k < n; k++) { idx.push(buf.readInt32LE(o)); o += 4; }
    // skip per-face texcoord list (uchar count + count doubles)
    const m = buf.readUInt8(o); o += 1 + m * 8;
    out += 'f ' + idx.map(i => i + 1).join(' ') + '\n';
  }
  return { obj: out, nV, nF };
}

const ref = refArg ? path.resolve(refArg) : newestRef();
const dst = path.join(__dirname, 'data', DATA);
fs.mkdirSync(dst, { recursive: true });

const yuv = fs.readdirSync(ref).find(n => /^disp_dec_\d+x\d+_10bits_p420\.yuv$/.test(n));
if (!yuv) throw new Error('displacement YUV not found in ' + ref + ' (decode with --keepVideoFiles)');
const [, w, h] = /disp_dec_(\d+)x(\d+)_/.exec(yuv);

// Base mesh: prefer the SDK's indexed base (dequantized, canonical order) over the raw PLY, whose
// coordinates are in the base-quantization space and don't match the reconstructed dec.obj.
let baseInfo;
const sdkBase = path.join(ref, 'base_sdk.obj');
if (fs.existsSync(sdkBase)) {
  const txt = fs.readFileSync(sdkBase, 'utf8');
  const nV = (txt.match(/^v /gm) || []).length, nF = (txt.match(/^f /gm) || []).length;
  fs.writeFileSync(path.join(dst, 'base.obj'), txt);
  baseInfo = { nV, nF, src: 'base_sdk.obj' };
} else {
  const ply = plyToObj(path.join(ref, 'fr_0_base_dec.ply'));
  fs.writeFileSync(path.join(dst, 'base.obj'), ply.obj);
  baseInfo = { nV: ply.nV, nF: ply.nF, src: 'fr_0_base_dec.ply' };
}
fs.copyFileSync(path.join(ref, yuv), path.join(dst, 'disp.yuv'));
fs.copyFileSync(path.join(ref, 'decoded_0000.obj'), path.join(dst, 'dec.obj'));
// The browser's WebCodecs-decoded displacement (8-bit R per pixel) — for ?browserdisp comparison.
if (fs.existsSync(path.join(ref, 'browser_disp.json')))
  fs.copyFileSync(path.join(ref, 'browser_disp.json'), path.join(dst, 'browser_disp.json'));

// Texture: native decoded PNG (reference/decoded_0000.png) or the SDK's (decoded/sdk_decoded_0000.png).
let hasTex = false;
for (const cand of [path.join(ref, 'decoded_0000.png'), path.join(ref, '..', 'decoded', 'sdk_decoded_0000.png')]) {
  if (fs.existsSync(cand)) { fs.copyFileSync(cand, path.join(dst, 'tex.png')); hasTex = true; break; }
}

const dp = JSON.parse(fs.readFileSync(path.join(ref, 'dispParams.json'), 'utf8'));
// refScale (test.html's multiplier on raw-512) == iscale[0] for TransformMethod=NONE, geomBitDepth=10.
const cfg = {
  subdiv: dp.subdivIterationCount,
  dispWidth: +w, dispHeight: +h,
  log2BlockSize: dp.log2BlockSize,
  geomBitDepth: dp.geomBitDepth,
  refScale: dp.iscale[0],
  baseVertexCount: baseInfo.nV, baseFaces: baseInfo.nF,
  hasTex,
  edgeTable: dp.edgeTable || [],
  packingMethod: dp.packingMethod,
  source: path.basename(path.dirname(ref)),
};
fs.writeFileSync(path.join(dst, 'params.json'), JSON.stringify(cfg, null, 2));
console.log(`data/${DATA}/ ready from`, cfg.source, '(base:', baseInfo.src + ')');
console.log(`  base ${baseInfo.nV}v/${baseInfo.nF}f, disp ${w}x${h}, refScale=${cfg.refScale}, subdiv=${cfg.subdiv}, tex=${hasTex}`);
console.log(`open: http://localhost:8097/verification/parity/test.html?dump&data=${DATA}`);
