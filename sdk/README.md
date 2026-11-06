# V-DMC Web Decoder SDK

A browser-side SDK that decodes **V-DMC (Video-based Dynamic Mesh Coding)** bitstreams
and renders the animated, textured, displaced mesh in real time with WebGL2 / Three.js.

The heavy lifting is split across three layers:

| Layer | Runs in | Responsibility |
|-------|---------|----------------|
| **WASM base-mesh decoder** | Web Worker | Parse the `.vmesh` container, decode the base mesh + displacement metadata per frame |
| **WebCodecs HEVC decoder** | Main thread | Decode the texture and displacement video sub-streams to raw frames |
| **GPU subdivision + displacement** | WebGL2 vertex/fragment shader | Subdivide each base triangle, apply per-vertex V-DMC displacement, texture & light |

---

## Quick start

The SDK decodes a `.vmesh` stream into ready-to-render Three.js meshes — one self-contained
mesh per frame, with the V-DMC subdivision + displacement shader, instancing and texture
already attached. The application owns the scene, camera and render loop and simply adds each
emitted mesh to its scene.

```html
<!-- An import map providing "three" and "three/addons/" is required for modular SDK imports -->
<script type="importmap">
{
  "imports": {
    "three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js",
    "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"
  }
}
</script>

<script type="module">
  import * as THREE from 'three';
  import { VDMCMesh } from '/sdk/src/VDMCMesh.js';

  // High-level THREE.Group component — add directly to your scene
  const vdmc = new VDMCMesh({
    src: '/path/to/stream.vmesh',
    renderer, // THREE.WebGLRenderer
    autoPlay: true,
    loop: true,
  });
  scene.add(vdmc);

  // Advance playback in your animation loop
  function animate(time) {
    requestAnimationFrame(animate);
    vdmc.update(time);
    renderer.render(scene, camera);
  }
</script>
```

For animated playback, the optional `VDMCPlayer` collects emitted frames and swaps them in a
host-provided container at a target frame rate (see [API](#api) below).

> **Hosting requirement:** the page must be **cross-origin isolated**
> (`Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`
> or `credentialless`). This is needed for the Worker + WASM + WebCodecs path.
> The bundled `serve.py` sets these headers for local development.

---

## Package layout

```
sdk/
├── build.mjs           esbuild bundler producing dist/
├── src/                hand-written ES modules — the SDK source
│   ├── VDMCMesh.js         High-level media component — extends THREE.Group (recommended entry)
│   ├── VDMCMeshStream.js   Core stream decoder — decodes a .vmesh into ready-to-render meshes
│   ├── VDMCPlayer.js       Optional playback helper (frame swap + play/pause/loop)
│   ├── VDMCDecoder.js      Main-thread wrapper around the WASM base-mesh decoder worker
│   ├── webVideoDecoder.js  WebCodecs HEVC decoder for texture/displacement video
│   ├── GpuTexRing.js       Bounded ring of GPU textures the video frames decode straight into
│   ├── GpuReadback.js      Portable GPU→CPU pixel readback in the app's renderer context
│   ├── rampCalibClip.js    Runtime calibration of the 10-bit displacement luma range
│   ├── SubdivideMesh.js    GPU subdivision + V-DMC displacement shader material
│   └── subdivNumbering.mjs Canonical subdivision pattern + op-list generator
├── wasm/               decoder worker + the prebuilt Emscripten decoder
│   ├── vdmc_worker.js  Web Worker hosting the decoder module (source)
│   ├── vdmc_decode.js  Emscripten glue (generated — see ../docs/BUILD-WASM.md)
│   └── decode.wasm     Compiled base-mesh decoder (generated)
└── dist/               generated bundles — rebuild with `npm run build`
    ├── vdmc_decoder.js
    └── vdmc_decoder.standalone.js
```

An application imports `dist/vdmc_decoder.js` (or `src/VDMCMesh.js` directly during
development); either pulls in the rest. `src/` and `dist/` sit at the same depth under `sdk/`,
so the `../wasm/vdmc_worker.js` reference in `VDMCDecoder.js` resolves identically from both.

The SDK owns **no** canvas, scene, camera or controls — rendering surfaces belong to the app.
Subdivision, instancing and displacement, however, are intrinsic to V-DMC and are performed by
the SDK as part of producing each mesh.

### Bundles

Both files under `dist/` are checked in and export `VDMCMesh`, `VDMCMeshStream` and
`VDMCPlayer`. Rebuild them after changing anything in `src/` or `wasm/`:

```bash
npm install                  # esbuild + three (dev only)
npm run build                # → dist/vdmc_decoder.js
npm run build:standalone     # → dist/vdmc_decoder.standalone.js
```

| Bundle | Size | Needs at runtime |
|--------|------|------------------|
| `dist/vdmc_decoder.js` | ~90 kB | `"three"` / `"three/addons/"` from an import map, and the sibling `sdk/wasm/` folder |
| `dist/vdmc_decoder.standalone.js` | ~11 MB | nothing — three, OrbitControls, the decoder worker and `decode.wasm` are all inlined |

The standalone bundle is a single ES module that can be dropped anywhere: it re-exports
`THREE` and `OrbitControls` so the host uses the same Three.js instance as the SDK, and it
starts the decoder worker from a `Blob` URL with the WASM binary embedded as base64, so no
import map and no runtime fetch are needed. That is what offline hosts (e.g. an Android
WebView) require, and it is what [`../sample-app/`](../sample-app/) uses.

> **Use `dist/vdmc_decoder.js` when you can.** Three.js is a peer dependency, not something
> this SDK owns: leaving it external lets your app pin its own version and keeps a single
> instance in the page. Reach for the standalone bundle only when the host cannot supply
> Three.js — and then import `THREE` / `OrbitControls` **from the bundle** rather than
> loading Three.js again alongside it.

Both bundles carry the required third-party notices: a banner at the top and, for the
standalone build, the collected `@license` blocks at the end of the file.

---

## API

### `VDMCMesh`

A `THREE.Group` subclass that combines `VDMCMeshStream` + `VDMCPlayer` behind a media-element
style interface. This is the recommended entry point.

```js
const vdmc = new VDMCMesh({
  src,               // optional URL string or Uint8Array to load immediately
  renderer,          // THREE.WebGLRenderer — required for video (texture+displacement) playback
  autoPlay = true,
  loop = true,
  fps = 30,          // alias: targetFps
  subdivLevel = 3,
  dispScale = 1.0,
  wireframe = false,
  ringSize = 8,
  enablePreviews = true,
  onLog,
});
```

| Member | Description |
|--------|-------------|
| `load(src)` / `loadUrl(url)` / `loadBitstream(bytes, label?)` | Load from a URL or an in-memory `Uint8Array`. |
| `feed(chunk, label?)` / `appendPacket(packet, label?)` / `endStream()` | Push bitstream packets from a custom transport. |
| `attachWebSocket(wsOrUrl)` / `attachStream(streamOrResponse)` | Attach a WebSocket or a WHATWG `ReadableStream` / `Response`. |
| `update(timeMs)` | Call once per animation frame (pass the rAF timestamp). |
| `play()` / `pause()` / `togglePlay()` / `stop()` / `restart()` | Playback control. |
| `seek(index)` / `stepForward()` / `stepBackward()` | Frame navigation. |
| `on(event, cb)` / `off(event, cb)` | Events: `ready`, `mode`, `firstframe`, `frame`, `complete`, `ended`. `on()` returns an unsubscribe function. |
| `playing` / `currentIndex` / `frameCount` / `currentFrame` / `mode` / `duration` (getters) | Playback and decode state. |
| `loop` / `fps` / `dispScale` / `wireframe` / `enablePreviews` (accessors) | Live-settable properties. |
| `dispose()` | Release all GPU resources. |
| `stream` / `player` | The underlying `VDMCMeshStream` / `VDMCPlayer`. |

### `VDMCMeshStream`

Decodes a `.vmesh` stream and emits one ready-to-render mesh per frame.

```js
const stream = new VDMCMeshStream({
  renderer,          // THREE.WebGLRenderer — required for video (texture+displacement) playback
  subdivLevel = 3,   // fallback subdivision level if the stream omits it
  dispScale = 0.01,  // displacement multiplier (see below)
  wireframe = false,
  ringSize = 8,      // max GPU-resident frames per stream
  enablePreviews = true, // decode texture/displacement frames to canvases for `VDMCFrame`
  onLog,             // (msg: string) => void
});
```

| Member | Description |
|--------|-------------|
| `load(urlOrBytes)` | Decode a `.vmesh` from a URL string or a `Uint8Array`. |
| `loadUrl(url)` | Fetch and decode a `.vmesh` file. |
| `loadBitstream(bytes, label?)` | Decode an in-memory `Uint8Array` bitstream. |
| `feed(chunk, label?)` / `endStream()` | Accumulate bitstream packets, then decode. |
| `attachWebSocket(wsOrUrl)` / `attachStream(streamOrResponse)` | Attach a transport that feeds packets. |
| `setDispScale(value)` | Live-update the displacement multiplier on all emitted meshes. |
| `setWireframe(on)` | Toggle wireframe on all emitted meshes. |
| `dispose()` | Release every emitted frame's GPU resources and reset. |
| `onReady` | Callback fired once the WASM worker is initialised. |
| `onMode(mode)` | `'full'` (textured + displaced) or `'basemesh'` (fallback). |
| `onFrame(frame)` | Fired once per frame with a `VDMCFrame` (see below). |
| `onComplete({ frameCount })` | Fired when decode finishes. |
| `mode` / `frameCount` (getters) | Current render mode / number of emitted frames. |

A **`VDMCFrame`** carries:

| Field | Description |
|-------|-------------|
| `frameId` | Globally-unique decoder frame id. |
| `index` | Monotonic emission index (`0, 1, 2, …`). |
| `mesh` | Ready-to-render `THREE.Object3D` (subdivided + displaced, or base-mesh fallback). Just `scene.add(mesh)`. |
| `baseGeometry` | Welded position+uv base-mesh `THREE.BufferGeometry` (for app-side base views). |
| `dispParams` | V-DMC displacement parameters for the frame, or `null`. |
| `textureImage` | Decoded texture frame (canvas), or `null` in base-mesh mode. |
| `displacementImage` | Decoded displacement frame (canvas), or `null` in base-mesh mode. |
| `dispose()` | Release this frame's GPU resources. |

### `VDMCPlayer` (optional)

Collects the meshes emitted by a `VDMCMeshStream` and shows one at a time inside a
host-provided container, driving play/pause/loop. Scene-agnostic — it never creates a
renderer, camera or canvas.

```js
const player = new VDMCPlayer(stream, {
  container,          // THREE.Object3D — the active frame mesh is parented here
  targetFps = 30,
  autoPlay = true,
  loop = true,
});
```

| Member | Description |
|--------|-------------|
| `update(timeMs)` | Call once per animation frame (pass the rAF timestamp) to advance playback. |
| `show(index)` | Show a specific frame. |
| `play()` / `pause()` / `togglePlay()` | Playback control (`togglePlay` returns the new state). |
| `step(delta)` / `stepForward()` / `stepBackward()` | Frame stepping (pauses playback). |
| `playing` / `frameCount` / `currentIndex` / `currentFrame` (getters) | Playback state. |
| `onFirstFrame(frame)` | Fired when the first frame is shown (e.g. to fit cameras). |
| `onShow(index, frame)` | Fired each time a frame is shown. |
| `onFrameCounter(text)` | UI string for the current frame. |
| `onComplete(frameCount)` | Fired when decode finishes. |
| `onEnded()` | Fired on reaching EOF when `loop` is `false`. |

---

## Packet & WebSocket Streaming

When bitstream packets arrive from a WebSocket, chunked HTTP stream, or custom transport:

```js
// Option A: Feed packets manually as they arrive
const vdmc = new VDMCMesh({ renderer });
scene.add(vdmc);

socket.on('data', (packet) => {
  vdmc.feed(packet); // Uint8Array, ArrayBuffer, or Blob
});
socket.on('end', () => vdmc.endStream());

// Option B: Attach directly to a WebSocket
vdmc.attachWebSocket('wss://example.com/vdmc-stream');

// Option C: Attach directly to a WHATWG ReadableStream / fetch body
const response = await fetch('/stream.vmesh');
await vdmc.attachStream(response);
```

---

## Displacement scale

`dispScale` is a multiplier applied to the decoded V-DMC displacement along each vertex
normal. `1.0` corresponds to the true encoded displacement; lower values flatten the
surface, higher values exaggerate it. It defaults to `1.0` on `VDMCMesh` and `0.01` on the
lower-level `VDMCMeshStream`, and can be changed live via `setDispScale()` (or the
`vdmc.dispScale` accessor).

When a frame carries full V-DMC displacement parameters, the shader reconstructs the exact
per-vertex displacement from the packed displacement video (vertex-index addressing). When
those parameters are absent (e.g. base-mesh-only fallback), the shader renders the smooth
subdivided surface without displacement.

---

## Graceful degradation

The SDK probes WebCodecs HEVC support before decoding:

- **HEVC available** → full pipeline (base mesh + texture + displacement video).
- **HEVC unavailable** → automatic fallback to **base-mesh-only** rendering (untextured,
  undisplaced), so the geometry is still viewable.

---

## Local development server

```bash
python serve.py [port]      # default 8080
```

`serve.py` (in the package root) serves the repository root — so `/sdk/`, `/sample-app/`,
`/verify/` and `/verification/` are all reachable — applies the required cross-origin-isolation
headers, redirects `/` to the sample app, and forwards browser console output (posted to
`/log`) to the terminal and to `browser-console.log` for debugging.

See [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) for the full architecture,
data flow, dependency and licensing details, and
[`../docs/BUILD-WASM.md`](../docs/BUILD-WASM.md) for rebuilding the WASM
decoder from the MPEG reference software.

---

## Licence

Copyright 2026 Nokia, licensed under the 5G-MAG Public License (v1.0) — full text in
[`../LICENSE`](../LICENSE), notices in [`../NOTICE`](../NOTICE).
`wasm/decode.wasm` and `wasm/vdmc_decode.js` are compiled from the BSD-3-Clause MPEG V-DMC
reference software, and `dist/vdmc_decoder.standalone.js` additionally embeds Three.js (MIT);
see [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md#4-licensing-aspects).
