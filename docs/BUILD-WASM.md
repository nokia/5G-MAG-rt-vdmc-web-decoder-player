# Building the V-DMC Web SDK

This document describes how to compile the MPEG V-DMC reference software into the
WebAssembly base-mesh decoder consumed by the SDK (`sdk/wasm/decode.{js,wasm}`).

This repository does **not** ship the reference software sources. Instead it ships a single
patch, [`../tm-reference/wasm_decoder.patch`](../tm-reference/wasm_decoder.patch), that turns
a pristine **official MPEG TMM17 v17.0** checkout into the decoder-only WASM build. You apply
that patch to your own TMM17 checkout and build from there.

The browser only needs the **decoder**. The encoder still builds natively (for preparing
`.vmesh` test content) but is not required for the web pipeline.

---

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| **git** | any | to clone TMM17 and apply the patch |
| **Emscripten SDK** | 3.1.x or newer | `emcmake`, `emcc` on `PATH` |
| **CMake** | ≥ 3.20 | |
| **Ninja** (recommended) | any | faster than Make |
| **Python** | 3.8+ | for the dev server |

Activate the Emscripten environment first:

```bat
:: Windows
C:\path\to\emsdk\emsdk_env.bat

# Linux / macOS
source /path/to/emsdk/emsdk_env.sh
```

---

## Get the source (apply the patch)

Clone the official TMM17 v17.0 release and apply the patch. `$TM` is a scratch checkout
kept **outside** this repository, and `$FOSS` is the path to this repository.

```bash
git clone --single-branch -b v17.0 \
  https://git.mpeg.expert/MPEG/3dgh/v-dmc/software/mpeg-vmesh-tm.git "$TM"
git -C "$TM" apply "$FOSS/tm-reference/wasm_decoder.patch"
```

Access to the MPEG git server is required to obtain the reference software; the patch itself
contains only the decoder-specific modifications, not the upstream sources.

---

## Build

From the patched TMM17 checkout (`$TM`):

```bash
emcmake cmake -S . -B build_wasm \
  -DCMAKE_BUILD_TYPE=Release \
  -DMESH_TYPE=float \
  -DCMAKE_POLICY_VERSION_MINIMUM=3.5

cmake --build build_wasm --target decode
```

> **Build only the `decode` target.** Building `all` pulls in extra wrapper apps and native
> codecs that are not needed (and not buildable) under Emscripten.

The outputs are produced in `build_wasm/source/app/`:

```
decode.js     Emscripten ES-module glue
decode.wasm   compiled decoder
```

---

## Install into the SDK

Copy **both** files together (they must come from the same build) into the SDK. `$FOSS` is
this repository:

```bash
cp build_wasm/source/app/decode.js   "$FOSS/sdk/wasm/vdmc_decode.js"
cp build_wasm/source/app/decode.wasm "$FOSS/sdk/wasm/decode.wasm"
```

> ⚠️ The glue loads the binary by its baked-in name **`decode.wasm`** (via
> `import.meta.url`), so the `.wasm` file must keep that exact name even though the glue is
> renamed to `vdmc_decode.js`. If the two files come from different builds the browser
> throws `No EM_ASM constant found at address … (wasm out of sync with JS)` — always copy
> the pair atomically and verify with a hash.

---

## Key Emscripten configuration

Set automatically by `CMakeLists.txt` when `CMAKE_SYSTEM_NAME == Emscripten`:

| Setting | Value | Why |
|---------|-------|-----|
| `WASM_BUILD` define | on | Activates the web code paths (see scope below) |
| `MESH_TYPE` | `float` | Smaller memory footprint than double |
| Desktop video codecs (HM/VTM/VVC) | **off** | Video decoded in JS via WebCodecs |
| Draco geometry codec | **off** | Not used in the web path |
| `USE_WEB_VIDEO_DECODER` | on | Emits video sub-streams to JS instead of decoding in C++ |
| `MODULARIZE` + `EXPORT_ES6` | on | Loadable as an ES module inside a Worker |
| `EXPORT_NAME` | `createVDMC` (decode) | Module factory name |
| `ALLOW_MEMORY_GROWTH`, `INITIAL_HEAP=256MB` | on | Large meshes |
| `ASYNCIFY` | on | Lets C++ call back into JS (`Module.onBaseMesh`, etc.) |
| `ENVIRONMENT` | `web,worker` | Runs in the browser / Worker (not Node) |
| `EXPORTED_RUNTIME_METHODS` | `FS, callMain, ccall, cwrap, HEAPU8, HEAPF32, HEAPU32` | Heap views the JS reads |

### Fast-link note

Compilation uses `-O2` (good codegen, cached per object) but **links with `-O0`** to skip
Binaryen/`wasm-opt`, which otherwise makes link times tens of minutes. ASYNCIFY is kept
because the decoder requires it. The resulting glue is non-minified.

---

## Scope of changes to the reference software

All web-specific changes are guarded by `#ifdef WASM_BUILD` / `#ifndef WASM_BUILD`, so the
native build is unaffected. They are confined to a handful of files:

| File | Change |
|------|--------|
| `source/lib/vmeshDecoder/decoder.cpp`, `decoderOAuvcoord.cpp` | Emit each decoded base mesh + displacement metadata to JS (`Module.onBaseMesh`, `Module.onDispParams`) instead of subdividing/displacing in C++; hand video sub-streams to JS. |
| `source/app/decode.cpp` | Expose the decode entry point to the Emscripten module. |
| `source/wrapper/videoDecoder/webVideoDecoder{,Impl}.{cpp,hpp}` (new), `videoDecoder.{cpp,hpp}` | Video sub-streams are handed to the JS/WebCodecs decoder instead of HM/VTM/VVC. |
| `source/lib/atlasDecoder/atlasDecoder.cpp`, `source/lib/basemeshDecoder/baseMeshDecoder.cpp`, `source/lib/basemeshBitstream/baseMeshCommon.hpp` | Guards for the decoder-only WASM target. |
| `source/lib/vmeshCommon/wasm_stubs.cpp` (new) | Web-side stubs replacing native-only functionality. |
| `source/lib/vmeshCommon/util/{mesh,image,vector,vector_patch}.{hpp,cpp}`, `vmc.hpp`, `vmcCommon.cpp` | WASM accessors exposing mesh buffers to JS; skip native file/image I/O. |
| `dependencies/program-options-lite/program_options_lite.h` | Remove `exceptions(failbit)` on parse streams under WASM. |
| `CMakeLists.txt`, `source/app/CMakeLists.txt`, `source/lib/{vmeshCommon,basemeshDecoder}/CMakeLists.txt`, `source/wrapper/videoDecoder/CMakeLists.txt` | Emscripten configuration, codec toggles, link flags above. |

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for a visual map of what was
modified and how the C++ ⇄ JS boundary works.

To regenerate `wasm_decoder.patch` after changing the patched checkout, stage everything
(the patch adds new files) and diff against the pristine `v17.0` tag:

```bash
git -C "$TM" add -A
git -C "$TM" diff --cached v17.0 > "$FOSS/tm-reference/wasm_decoder.patch"
```

---

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `No EM_ASM constant found at address N` in the browser | `vdmc_decode.js` and `decode.wasm` are from different builds — recopy the pair. |
| `'HEAP32' was not exported` | Only `HEAPU8/HEAPU32/HEAPF32` are exported; read indices via `HEAPU32`, or add `HEAP32` to `EXPORTED_RUNTIME_METHODS` and rebuild. |
| Link hangs for many minutes | `wasm-opt` running — ensure the `-O0` link flag is applied (fast-link). |
| `main()` runs unexpectedly at load | The module factory runs `main()` with no arguments unless `noInitialRun: true` is passed; the decoder just prints its usage text and the SDK's explicit `callMain` still works. |
| Browser keeps using the old wasm | Streaming-compiled wasm is cached; reload again. The dev server already sends `no-store`. |
