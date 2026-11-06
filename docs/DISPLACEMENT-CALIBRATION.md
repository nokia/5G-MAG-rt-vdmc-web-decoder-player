# 10-bit Displacement Decode & Calibration (WebCodecs)

Engineering record of the investigation that made the V-DMC displacement video
sub-stream decode **bit-exact at 10-bit** in the browser over the *standard*
WebCodecs path — plus the design decisions and the dead-ends that were ruled out.

> Scope: the displacement sub-stream only. Texture uses the ordinary 8-bit path.
> Displacement codes drive per-vertex geometry, so they must be recovered as exact
> integers, not approximately.

---

## 1. Problem

Decode the 10-bit HEVC (Main10) displacement sub-stream to exact integer codes in the
browser, using the standard-defined WebCodecs `VideoDecoder` path — i.e. **without**
`prefer-software`, **without** non-standard channel packing, and **without** a separate
WASM HEVC decoder. The recovered codes must be bit-exact so the reconstructed mesh
matches the reference decoder.

## 2. Core obstacle

On mobile, the hardware HEVC decoder exposes the decoded `VideoFrame` as **8-bit RGBA**,
and there is **no software HEVC decoder** to fall back to. On desktop the compositor
(ANGLE) applies colour management that clamps to 8-bit. Either way the low 2 bits of the
10-bit displacement codes are lost through the normal draw/readback path.

## 3. Key finding — RGBA16F GPU extract (the path that works)

Uploading the hardware-decoded opaque HEVC `VideoFrame` **directly to a WebGL2
`RGBA16F` texture via `texImage2D`** bypasses the ANGLE/WebGPU 8-bit colour-management
clamp on **mobile GPUs** and preserves the full 10-bit luma.

A fragment shader then:
1. folds the neutral-chroma RGB to a single luma value `y = (r+g+b)/3` (0..1),
2. computes `code = clamp(round(y*scaleY + offsetY), 0, maxCode)`,
3. transports the 0..65535 integer as an **RGBA8 hi/lo byte pair**
   (`hi = floor(code/256)`, `lo = code - hi*256`) so it can be read back with the
   universally-supported `readPixels(RGBA8)` — direct `RGBA16F` readback is **not**
   portable.

As shipped, the displacement ring requests `rgba16f` only; the texture ring requests
`rgba16f` and falls back to `rgba8`. `RGB10_A2` is deliberately not in either list (§5).

## 4. Precision ceiling (why 10-bit is the max, 12-bit impossible)

`fp16` has a 10-bit mantissa → ~1024 distinct values per binade.

| Bit depth | Codes / octave needed | fp16 headroom | Bit-exact via GPU path? |
|-----------|-----------------------|---------------|-------------------------|
| 10-bit    | 512                   | 2×            | **Yes** |
| 12-bit    | 2048                  | insufficient  | **No** |

`RGB10_A2` is strictly 10-bit. So **10-bit is the ceiling of this GPU path**; true
12-bit displacement cannot be recovered bit-exact this way. This is an accepted,
documented limitation, not a bug to chase.

## 5. Negative findings (ruled out — do not retry)

- **Float16 _canvas_** (drawing the frame into a `float16`-configured canvas / 2D
  context) is flattened to 8-bit on mobile. This is a *different* code path from
  `RGBA16F` `texImage2D`; only the texture-upload path preserves precision.
- **Desktop is not bit-exact.** Chrome 152 / Edge 151 / Electron (all ANGLE-backed)
  flatten even the `RGBA16F` path — only ~82–88% of codes exact, ≤1–2 LSB error.
  Desktop keeps the software-decode fallback instead.
- **`prefer-software` HEVC is unavailable on the target mobile devices** — the
  "just ask for a software decoder" standard path does not exist there.
- **`RGB10_A2` is not usable as a general fallback.** It was bit-exact on Adreno, but on
  ANGLE `texImage2D(VideoFrame → RGB10_A2)` uploads **garbage without raising an error** — a
  silent corruption. `RGBA16F` was bit-exact on both tested mobile vendors, so it is the only
  format requested for displacement.
- **Minimum hardware-decodable ramp size is device-specific.** A 32×32 ramp is rejected by
  every tested mobile decoder. The Pixel 9 Pro accepts 64×64, but **some devices (e.g. the tested
  Samsung, One UI) reject 64×64 with "no frame"** and need a larger clip; **128×128 and 256×128
  are accepted on all tested devices**, so the bundled ramp is **128×128** for portability.
- **x265 embeds an encoder-parameters SEI** that bloated the ramp and made it
  non-minimal; stripped with `info=0` (bitstream 4.5 KB → 2.2 KB).
- **Calibration is device-specific.** The exact affine (`scaleY`/`offsetY`) differs per
  GPU/driver, so a single constant cannot be baked in — this is why calibration is done
  at runtime.

## 6. Device results

Football displacement frame — ground truth 180 distinct codes in the ~464–604 range.

| Device | GPU | `RGBA16F` | `RGB10_A2` | Notes |
|--------|-----|-----------|------------|-------|
| Pixel 9 Pro | Mali | 100% exact (maxAbs 0) | — | measured affine ≈ scaleY 1020–1024, offsetY ≈ −0.1..−2 |
| Samsung S25 (SM-S931B) | Adreno 830 | 100% | 100% | raw-scale ≈ 0.01557, offset ≈ +2.68 |
| Desktop Chrome 152 / Edge 151 / Electron | ANGLE | ~82–88% (≤1–2 LSB) | — | flattens 10-bit; uses `auto-besteffort` (DC-corrected, ~4-unit / ≤1 LSB residual) |

Ramp-calibrated displacement: **100% exact (maxAbs 0)** on Pixel at both 256×128 and
64×64 ramp sizes, and validated end-to-end in the sample app (`auto` mode,
`ramp 99.7%`, `scaleY≈1020.3 offsetY≈-0.08`, full 34-frame render correct).

## 7. Design decisions

1. **Primary path = `RGBA16F` `texImage2D` GPU extract** for 10-bit recovery on mobile;
   a legacy software `copyTo` path is kept as the desktop/fallback route.
2. **Runtime calibration, resolved automatically** — there is no caller-facing mode switch.
   `resolveCalibration()` in [`sdk/src/rampCalibClip.js`](../sdk/src/rampCalibClip.js) is invoked
   once, from the displacement decoder's init in
   [`sdk/src/webVideoDecoder.js`](../sdk/src/webVideoDecoder.js), and reports which of three
   outcomes it landed on via the `source` field:
   - **`auto`** — the bundled ramp clip is decoded once (session-cached), the measured
     raw→known-code affine is fitted, and **≥ 95%** of codes come back exact (a device that
     preserves >8-bit fits ~99.7%). Treated as bit-exact.
   - **`auto-besteffort`** — the fit is below the bit-exact bar but still a **plausible affine**
     (slope 0.6–1.4× `maxCode`, `|offset|` < 0.2× `maxCode`). On desktop's 8-bit path this is not
     bit-exact, but the fitted scale/offset still correct the systematic DC bias that otherwise
     **inflates** the model (desktop error ~26 → ~4 units, i.e. the 8-bit ≤1 LSB ceiling) — far
     better than the textbook default.
   - **`default`** — ramp undecodable, or no renderer/HEVC: full-range identity
     (`code = round(y * maxCode)`). Keeps rendering usable, but is not device-calibrated.

   > No SPS/VUI parsing is involved. Calibration measures a device/GPU property, so it stays
   > valid if the displacement sub-stream later moves to VP9/AV1.
3. **Ramp clip** — 128×128 (portable minimum decodable size across tested devices), 10-bit Main10,
   full-range, **lossless**, x265-SEI stripped (~8 KB), **base64-inlined** into
   [`sdk/src/rampCalibClip.js`](../sdk/src/rampCalibClip.js) so calibration needs no network or
   asset. Each pixel encodes `knownCode = pixelIndex & 1023`, which is why the clip
   **must be lossless** — a lossy ramp would break the known-code assumption.
4. **12-bit is out of scope** for the GPU path (fp16 limit, §4) — documented negative
   result, not a TODO.

## 8. Regenerating the ramp module

`sdk/src/rampCalibClip.js` is generated; the base64 it contains is the tracked source of
truth. Rebuild it with the ffmpeg-libx265 helper (intermediates live in the gitignored
`verification/helpers/`, which is not part of delivery — see §9):

1. Generate a 128×128 10-bit planar YUV where each pixel's luma = linear `index & 1023`
   and chroma is neutral (512), then encode lossless Main10, full-range, SEI-stripped:
   ```powershell
   ffmpeg -f rawvideo -pix_fmt yuv420p10le -s 128x128 -r 1 -i ramp128.yuv `
     -c:v libx265 -x265-params "lossless=1:range=full:info=0:log-level=none" `
     -frames:v 1 ramp128.hevc
   ```
2. Base64-inline it into `sdk/src/rampCalibClip.js` (with `RAMP_W=128`, `RAMP_H=128`,
   `RAMP_BITDEPTH=10`) — automated locally by `verification/helpers/tools/bake-ramp.mjs`.

## 9. Where the dev helpers live

All one-off investigation tooling — CDP format/precision probes (`cdp-*.mjs`), the
self-contained `calib-validate.html` / `webcodecs-probe.html` pages, `compare-disp.mjs`,
the ramp intermediates (`calib/`), and device screenshots (`screens/`) — is collected under
**`verification/helpers/`**, which is **gitignored** (not part of delivery). It is kept
locally as a reproduction/validation aid only.

The shader-output capture used by the delivered tests is a different, shipped module:
[`verification/gpu-capture.mjs`](../verification/gpu-capture.mjs).
