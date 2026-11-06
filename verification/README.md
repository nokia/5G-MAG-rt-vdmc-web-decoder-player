# V-DMC SDK verification

A self-contained test that verifies the browser V-DMC decoder SDK against the native
MPEG VMESH reference tools.

## What it does

Each run is organised into phases, written into a fresh timestamped test folder
`runs/test.<YYMMDDHHmm>/` with one subfolder per phase:

0. **Phase 0** — create the timestamped test folder + `reference/`, `decoded/`, `verification/`.
1. **Phase 1 — reference** (`encode-decode.mjs`): encode the frame(s) with native `encode.exe`
   → `reference/out.vmesh` (+ `rec_%04d.obj`), then decode with `decode.exe`
   → `reference/decoded_%04d.obj/.png`. Logs: `reference/encoder.log`, `reference/decoder.log`.
2. **Phase 2 — decoded** (web SDK, `sdk/src/VDMCMeshStream.js`) in headless Edge (WebCodecs HEVC +
   WASM base-mesh worker). The page drives a real `THREE.WebGLRenderer` — the SDK decodes video
   straight into GPU textures and needs one — then captures the vertices the displacement shader
   actually produces via `gpu-capture.mjs` → `decoded/sdk_decoded_%04d.obj`. Nothing is
   re-derived on the CPU.
3. **Phase 3 — verification**: compare the captured SDK output against the reference `rec_%04d.obj`
   (and the native `decode.exe` output) with symmetric nearest-neighbour RMSE, plus an exact
   per-vertex check indexed by displacement index. PASS if within 2% of the model size.
   Report: `verification/verification_report.log`.

`run-verification.mjs` drives all three. **Phase 1 is a standalone, reusable module**
(`encode-decode.mjs`) so the same encode/decode step can also be used on its own to prepare a new
`out.vmesh` stream for the SDK / sample app.

## Requirements

- Node.js, `playwright-core` (installed via `npm install` here).
- The native reference tools and configs, laid out under `tm-reference/` in the package root
  (git-ignored — you provide them from your own TMM17 v17.0 build, the same checkout used to
  build the WASM decoder; see [`../docs/BUILD-WASM.md`](../docs/BUILD-WASM.md)):

  ```
  tm-reference/bin/encode.exe
  tm-reference/bin/decode.exe
  tm-reference/cfg/hm/{displacements,texture}-{ai,ld}.cfg
  tm-reference/cfg/hdrconvert/{bgr444toyuv420,yuv420tobgr444}.cfg
  ```

- Microsoft Edge (used for its WebCodecs HEVC support). Path override: `VDMC_EDGE_EXE`.
- Python 3 (for `serve.py`, which serves the repo with the cross-origin isolation headers the SDK needs).
- Source frames in `input/football_voxelized/` (override with `VDMC_INPUT_DIR`): the pre-quantized
  mesh `football_fr%04d_qp12_qt13.obj` (12-bit integer positions, 13-bit integer texcoords) plus the
  full-res `football_fr%04d.png` texture. The raw float mesh must NOT be used — its 0..1 UVs
  collapse under 13-bit quantization and the encoded texture comes out flat/black.
  The football sequence is not redistributed here; `--sphere` runs the whole verification on the
  bundled [`assets/sphere/`](assets/sphere/) mesh instead and needs no external input.

## Run

```powershell
npm install          # first time only
node run-verification.mjs                 # full 3-phase verification (intra)
node run-verification.mjs --sphere        # same, on the bundled sphere asset (no external input)
node run-verification.mjs --inter --count 4   # inter (low-delay, P-frames) over 4 frames
```

Options: `--frame 445`, `--count 1`, `--inter`, `--sphere`, `--dispScale 1.0`, `--port 8099`,
`--headed`, `--keep`.

`--sphere` encodes the local `assets/sphere/` mesh instead of the football sequence (defaults to
`--frame 0`), which isolates the SDK's reconstruction on a simple, known-good surface.

`--inter` selects the low-delay HM video configs (`displacements-ld.cfg` / `texture-ld.cfg`) plus
`analyzeGof=1`, so the displacement/texture substreams are inter-coded (P-frames). Without it, the
all-intra configs are used and every frame is an I-frame. It needs `--count > 1` to have any effect.

### Phase 1 standalone (prepare a stream for the SDK)

```powershell
node encode-decode.mjs --frame 445 --count 1 [--inter] [--out <dir>]
```

Runs only the native encode + decode into `<dir>` (default `runs/test.<YYMMDDHHmm>/reference/`),
producing `out.vmesh` + `rec_%04d.obj` + `decoded_%04d.obj/.png` — ready to feed to the web SDK.

## Files

- `run-verification.mjs` — 3-phase orchestrator (Phase 0 folders → Phase 1 → 2 → 3 comparison).
- `encode-decode.mjs` — reusable Phase 1 (native encode + decode); standalone CLI + `encodeDecode()` API.
- `gpu-capture.mjs` — **shared** capture of the SDK displacement shader's real output. Used by this
  verification, [`parity/`](parity/) and [`../verify/`](../verify/), so all three measure the same thing
  through the same code. See [Shared capture](#shared-capture).
- `encoder.cfg` — native encoder config (texture ON, built-in HM HEVC). Documented in
  [`../docs/VDMC-FEATURES.md`](../docs/VDMC-FEATURES.md).
- `assets/sphere/` — the bundled sphere asset used by `--sphere`.
- `package.json` — declares `playwright-core`.
- `parity/` — displacement parity test: checks `SubdivideMesh.js` against the reference
  reconstruction per displacement index, on interchangeable datasets. See
  [`parity/README.md`](parity/README.md).

## Shared capture

`gpu-capture.mjs` reuses the production vertex shader source straight off the live material —
patched only to emit the displaced position, the global displacement index and the sampled
displacement — so a capture can never drift from what the SDK renders. It runs in the app's own
WebGL2 context and takes the displacement texture from the material by handle, which is what makes
it universal: it works both for the GPU-direct ring texture (`VDMCMeshStream`) and for a CPU
`DataTexture` (the parity test) with no per-caller special cases.

Uniforms are mirrored by enumerating the linked program's **active** uniforms and reading the
matching entries from `material.uniforms`. Nothing is hardcoded, so adding or removing a shader
uniform cannot silently break the capture.

Two capture paths, picked automatically:

| Path | Used on | Why |
|------|---------|-----|
| transform feedback | desktop / ANGLE, Adreno | exact and direct |
| RGBA8 readback | Mali (or forced with `?rtt`) | transform feedback silently writes nothing on Mali, and float render targets fail on both ANGLE and Mali, so each output float is rasterised into one RGBA8 texel as its exact bit pattern |

Both paths are verified to agree bit-for-bit on desktop via `verify/test.html?dump&rtt`.

## See also

[`../verify/`](../verify/) — an interactive desktop + mobile test that captures the SDK's
actual GPU shader output and compares it per displacement index against the reference decoder.
It reuses `encode-decode.mjs` for its ground truth, and catches driver-specific
subdivision/displacement bugs that this verification's mesh-level RMSE does not.
