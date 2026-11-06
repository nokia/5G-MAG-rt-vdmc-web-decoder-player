/**
 * © 2026 Nokia
 *
 * Licensed under the 5G-MAG Public License (v1.0)
 */

// VDMCMeshStream.js — V-DMC SDK core: bitstream → ready-to-render Three.js meshes.
//
// Decodes a V-DMC (.vmesh) bitstream and emits, per frame, a self-contained Three.js mesh
// that is ALREADY subdivided, instanced, textured and displaced via the V-DMC subdivision +
// displacement shader. The host only needs to add the mesh to its own scene.
//
// This module owns NO canvas, scene, camera, controls or playback UI — those belong to the
// application (see VDMCPlayer.js for an optional playback helper, and the sample app for a
// full viewer). Subdivision, instancing and displacement ARE part of V-DMC decoding and so
// live here.
//
// Requires an import map providing "three" and "three/addons/" (see sample-app/index.html).

import * as THREE from 'three';
import { VDMCDecoder } from './VDMCDecoder.js';
import { WebVideoDecoder } from './webVideoDecoder.js';
import { SubdivideMesh } from './SubdivideMesh.js';

/**
 * @typedef {Object} VDMCFrame
 * @property {number} frameId            Globally-unique decoder frame id.
 * @property {number} index              Monotonic emission index (0,1,2,…).
 * @property {THREE.Object3D} mesh       Ready-to-render mesh (subdivided+displaced, or base-mesh fallback).
 * @property {THREE.BufferGeometry} baseGeometry  Welded position+uv base-mesh geometry (for app-side base views).
 * @property {object|null} dispParams    V-DMC displacement parameters for the frame (or null).
 * @property {(HTMLCanvasElement|null)} textureImage       Decoded texture frame (null in base-mesh mode).
 * @property {(HTMLCanvasElement|null)} displacementImage  Decoded displacement frame (null in base-mesh mode).
 * @property {()=>void} dispose          Release this frame's GPU resources.
 */

export class VDMCMeshStream {
  /**
   * @param {object} [opts]
   * @param {number} [opts.subdivLevel=3]   Fallback subdivision level if the stream omits it.
   * @param {number} [opts.dispScale=0.01]  Displacement multiplier applied to emitted meshes.
   * @param {boolean} [opts.wireframe=false]
   * @param {THREE.WebGLRenderer} opts.renderer  Required for video (texture+displacement) playback:
   *        decoded frames upload straight into a bounded GPU texture ring in the renderer's context
   *        (no per-frame CPU readback), and displacement calibration reads back in the same context.
   *        Without it, only the flat base-mesh path is available.
   * @param {number} [opts.ringSize=8]  Max GPU-resident frames per stream.
   * @param {(msg:string)=>void} [opts.onLog]
   */
  constructor(opts = {}) {
    this.SUBDIV_LEVEL = opts.subdivLevel ?? 3;
    this.DISP_SCALE = opts.dispScale ?? 0.01;
    this.WIREFRAME = opts.wireframe ?? false;
    this.renderer = opts.renderer || null;
    this.RING_SIZE = opts.ringSize ?? 8;
    this.enablePreviews = opts.enablePreviews ?? true;
    this.onLog = opts.onLog || (() => {});

    // Public callbacks (assignable by the host).
    this.onReady = null;     // () => void
    this.onMode = null;      // (mode: 'full'|'basemesh') => void
    this.onFrame = null;     // (frame: VDMCFrame) => void
    this.onComplete = null;  // ({ frameCount }) => void

    // 3-queue state keyed by frameId.
    this._geometryQueue = new Map(); // frameId -> THREE.BufferGeometry
    this._textureQueue = new Map();  // frameId -> canvas (RGB)
    this._dispQueue = new Map();     // frameId -> canvas (grayscale) | { texture, cal, gpu }
    this._frames = new Map();        // frameId -> VDMCFrame (emitted)
    this._videoDecoders = [];        // active per-stream WebVideoDecoders (they own their GPU rings)
    this._emittedCount = 0;

    this._mode = 'pending';          // 'pending' | 'full' | 'basemesh'
    this._stats = { base: 0, tex: 0, disp: 0, full: 0 };

    // Completion tracking: onComplete must fire only once ALL renderable frames are assembled,
    // i.e. after the base-mesh decode AND (in full mode) every video stream have finished.
    this._baseComplete = false;
    this._completeFired = false;
    this._videoStreamsExpected = 0;
    this._videoStreamsDone = 0;

    this._initDecoder();
  }

  // ------------------------------------------------------------------- Public API
  /** Decode + render a .vmesh from a URL string or an in-memory Uint8Array. */
  async load(urlOrBytes) {
    if (typeof urlOrBytes === 'string') return this.loadUrl(urlOrBytes);
    return this.loadBitstream(urlOrBytes);
  }

  /** Fetch a .vmesh URL and decode it progressively as chunks arrive. */
  async loadUrl(url) {
    this.onLog(`Fetching ${url}…`);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    return this.attachStream(resp);
  }

  /** Decode an in-memory Uint8Array bitstream. */
  async loadBitstream(bitstream, sourceLabel = 'bitstream') {
    this._resetState();
    const codec = await WebVideoDecoder.pickSupportedCodec();
    this._mode = codec ? 'full' : 'basemesh';
    this.onLog(`WebCodecs HEVC ${codec ? 'supported (' + codec + ')' : 'NOT supported — base-mesh fallback'}`);
    this.onLog(`Decoding ${sourceLabel} (${bitstream.length} bytes), mode=${this._mode}`);
    this.onMode?.(this._mode);
    if (this._mode === 'full') WebVideoDecoder.warmupCalibration(this.renderer);
    this._decoder.decode(bitstream);
  }

  /** Feed a bitstream packet or chunk (Uint8Array, ArrayBuffer, or Blob). */
  async feed(chunk, label = 'packet') {
    if (!chunk) return;
    if (typeof Blob !== 'undefined' && chunk instanceof Blob) {
      chunk = new Uint8Array(await chunk.arrayBuffer());
    } else if (chunk instanceof ArrayBuffer) {
      chunk = new Uint8Array(chunk);
    } else if (chunk.buffer && !(chunk instanceof Uint8Array)) {
      chunk = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    }
    if (!(chunk instanceof Uint8Array) || chunk.length === 0) return;

    if (this._mode === 'pending') {
      const codec = await WebVideoDecoder.pickSupportedCodec();
      this._mode = codec ? 'full' : 'basemesh';
      this.onLog(`WebCodecs HEVC ${codec ? 'supported (' + codec + ')' : 'NOT supported — base-mesh fallback'}`);
      this.onMode?.(this._mode);
      if (this._mode === 'full') WebVideoDecoder.warmupCalibration(this.renderer);
    }

    this._streamChunks.push(chunk);
    const totalBytes = this._streamChunks.reduce((sum, c) => sum + c.length, 0);
    this.onLog(`Feed ${label}: ${chunk.length} bytes (accumulated ${totalBytes} bytes)`);
  }

  /** Alias for feed(packet). */
  async appendPacket(packet, label) {
    return this.feed(packet, label);
  }

  /** Signal that packet streaming is finished for the active stream. */
  endStream() {
    this._streamEnded = true;
    if (this._streamChunks.length > 0) {
      let totalLen = 0;
      for (const c of this._streamChunks) totalLen += c.length;
      const combined = new Uint8Array(totalLen);
      let offset = 0;
      for (const c of this._streamChunks) {
        combined.set(c, offset);
        offset += c.length;
      }
      this.onLog(`Decoding accumulated stream (${totalLen} bytes)`);
      this._decoder.decode(combined);
    } else {
      this._maybeComplete();
    }
  }

  /**
   * Connect to a WebSocket or attach an existing one, feeding binary packets as they arrive.
   * @param {WebSocket|string} wsOrUrl - WebSocket instance or socket URL string.
   * @returns {WebSocket}
   */
  attachWebSocket(wsOrUrl) {
    this._resetState();
    const ws = (typeof wsOrUrl === 'string') ? new WebSocket(wsOrUrl) : wsOrUrl;
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('message', (evt) => {
      if (evt.data) this.feed(evt.data, 'ws-packet');
    });
    ws.addEventListener('close', () => this.endStream());
    ws.addEventListener('error', (err) => console.error('[VDMCMeshStream] WebSocket error:', err));
    return ws;
  }

  /**
   * Stream packets from a WHATWG ReadableStream or Response object (e.g. fetch response body).
   * @param {ReadableStream|Response} streamOrResponse
   */
  async attachStream(streamOrResponse) {
    this._resetState();
    const stream = (streamOrResponse && streamOrResponse.body) ? streamOrResponse.body : streamOrResponse;
    if (!stream || typeof stream.getReader !== 'function') {
      throw new Error('attachStream requires a ReadableStream or Response object');
    }
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) await this.feed(value, 'chunk');
      }
    } finally {
      this.endStream();
    }
  }

  /** Live-update the displacement multiplier on all emitted meshes. */
  setDispScale(value) {
    this.DISP_SCALE = value;
    for (const frame of this._frames.values()) {
      const u = frame.mesh?.material?.uniforms;
      if (u && u.dispScale) u.dispScale.value = value;
    }
  }

  /** Toggle wireframe on all emitted meshes. */
  setWireframe(on) {
    this.WIREFRAME = on;
    for (const frame of this._frames.values()) {
      if (frame.mesh?.material) frame.mesh.material.wireframe = on;
    }
  }

  /** Number of frames emitted so far. */
  get frameCount() { return this._frames.size; }

  /** Current render mode: 'pending' | 'full' | 'basemesh'. */
  get mode() { return this._mode; }

  /** Release every emitted frame's GPU resources and clear all state. */
  dispose() {
    this._resetState();
  }

  // ------------------------------------------------------------------- Internals
  _resetState() {
    for (const frame of this._frames.values()) frame.dispose();
    this._frames.clear();
    this._geometryQueue.clear();
    this._textureQueue.clear();
    this._dispQueue.clear();
    for (const d of this._videoDecoders) { try { d.destroy(); } catch (_) {} }
    this._videoDecoders = [];
    this._streamChunks = [];
    this._streamEnded = false;
    this._emittedCount = 0;
    this._mode = 'pending';
    this._stats.base = this._stats.tex = this._stats.disp = this._stats.full = 0;
    this._baseComplete = false;
    this._completeFired = false;
    this._videoStreamsExpected = 0;
    this._videoStreamsDone = 0;
  }

  // --- Materials ---
  _fallbackMaterial() {
    return new THREE.MeshStandardMaterial({
      color: 0x60a5fa, side: THREE.DoubleSide, flatShading: false, metalness: 0.0, roughness: 0.8,
    });
  }

  // --- Geometry / textures ---
  // Build a welded position+uv BufferGeometry from the C++ base-mesh streams.
  _buildBaseGeometry({ positions, indices, uvs, uvIndices }) {
    const geo = new THREE.BufferGeometry();
    const haveUv = uvs && uvs.length > 0 && uvIndices && uvIndices.length === indices.length;

    if (indices && indices.length > 0) {
      const corners = indices.length;
      const outPos = new Float32Array(corners * 3);
      const outUv = haveUv ? new Float32Array(corners * 2) : null;
      for (let c = 0; c < corners; c++) {
        const vi = indices[c] * 3;
        outPos[c * 3 + 0] = positions[vi + 0] || 0;
        outPos[c * 3 + 1] = positions[vi + 1] || 0;
        outPos[c * 3 + 2] = positions[vi + 2] || 0;
        if (outUv) {
          const ti = uvIndices[c] * 2;
          outUv[c * 2 + 0] = uvs[ti + 0] || 0;
          outUv[c * 2 + 1] = uvs[ti + 1] || 0;
        }
      }
      geo.setAttribute('position', new THREE.Float32BufferAttribute(outPos, 3));
      if (outUv) geo.setAttribute('uv', new THREE.Float32BufferAttribute(outUv, 2));
    } else {
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      if (uvs && uvs.length > 0) geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    }
    geo.computeVertexNormals();
    geo.computeBoundingBox();
    // Keep the raw indexed base (canonical vertex order, dequantized) for tooling/tests.
    geo.userData.baseData = { positions, indices, uvs, uvIndices };
    return geo;
  }

  // ------------------------------------------------------------ Build pipeline
  // A frame becomes renderable when:
  //   full mode     — geometry + texture + displacement are all present;
  //   basemesh mode — geometry is present.
  // Each frame is emitted to onFrame exactly once.
  _tryBuildFrame(fid) {
    if (this._frames.has(fid)) return; // already emitted
    const geo = this._geometryQueue.get(fid);
    if (!geo) return;

    if (this._mode === 'full') {
      const texEntry = this._textureQueue.get(fid);
      const dispEntry = this._dispQueue.get(fid);
      if (!texEntry || !dispEntry) return;

      let mesh = null;
      try {
        // Both entries carry a GPU ring texture — the video decoder has no CPU output path.
        const dispParams = this._decoder.dispParams ? this._decoder.dispParams.get(fid) : null;
        const subdiv = (dispParams && dispParams.subdivIterationCount) || this.SUBDIV_LEVEL;
        mesh = SubdivideMesh(geo, texEntry.texture, dispEntry.texture, subdiv, this.WIREFRAME, dispParams);
        // TransformType=NONE single-scale inverse quantization, folded into dispScale so the
        // shader's d*dispScale*uDispUnit == (mapDisp.r-0.5) * 2^geomBitDepth * iscale[0]. The
        // shader itself is left generic (properSubdiv relies on that same d*dispScale*uDispUnit).
        const hasProper = !!(dispParams && dispParams.edgeTable);
        const u = mesh.material.uniforms;
        const uDispUnit = u.uDispUnit.value || 1;
        const refScale = (dispParams && dispParams.iscale && dispParams.iscale[0]) || 1;
        const properScale = hasProper ? (Math.pow(2, dispParams.geomBitDepth) * refScale / uDispUnit) : 1;
        u.dispScale.value = this.DISP_SCALE * properScale;
        // mapDisp is the raw decoded frame, so the shader recovers the code with the decoder's
        // calibration affine (scaleY/offsetY) instead of a pre-normalized R32F.
        const cal = dispEntry.cal || {};
        const bd = cal.bitDepth != null ? cal.bitDepth : ((dispParams && dispParams.geomBitDepth) || 10);
        u.uDispRaw.value = 1;
        u.uCalScale.value = cal.scaleY != null ? cal.scaleY : 1;
        u.uCalOffset.value = cal.offsetY != null ? cal.offsetY : 0;
        u.uDispNorm.value = 1 / Math.pow(2, bd);
        // The ring texture is the raw (sRGB-encoded) decoded colour — decode to linear in the shader.
        u.uTexRaw.value = 1;

        this._textureQueue.delete(fid);
        this._dispQueue.delete(fid);
        this._stats.full++;
        this._emitFrame(fid, geo, mesh, dispParams, texEntry.previewImage, dispEntry.previewImage);
      } catch (err) {
        console.error(`[VDMCMeshStream] frame ${fid}: SubdivideMesh failed`, err);
      }
    } else if (this._mode === 'basemesh') {
      const mesh = new THREE.Mesh(geo, this._fallbackMaterial());
      this._emitFrame(fid, geo, mesh, null, null, null);
    }
  }

  _emitFrame(fid, geo, mesh, dispParams, textureImage, displacementImage) {
    const frame = {
      frameId: fid,
      index: this._emittedCount++,
      mesh,
      baseGeometry: geo,
      dispParams: dispParams || null,
      textureImage: textureImage || null,
      displacementImage: displacementImage || null,
      dispose: () => {
        mesh.geometry?.dispose?.();        // instanced subdivision geometry
        mesh.material?.dispose?.();
        geo.dispose?.();                   // base-mesh geometry
      },
    };
    this._frames.set(fid, frame);
    this.onFrame?.(frame);
  }

  _switchToBaseMeshMode(reason) {
    if (this._mode === 'basemesh') return;
    this.onLog(`Falling back to base-mesh rendering (${reason})`);
    this._mode = 'basemesh';
    this.onMode?.('basemesh');
    for (const fid of this._geometryQueue.keys()) this._tryBuildFrame(fid);
  }

  // ------------------------------------------------------------ Decoder wiring
  _initDecoder() {
    const decoder = new VDMCDecoder();
    this._decoder = decoder;

    decoder.onReady = () => {
      this.onLog('Decoder worker ready');
      this.onReady?.();
    };

    decoder.onBaseMesh = (frameId, data) => {
      const geo = this._buildBaseGeometry(data);
      this._geometryQueue.set(frameId, geo);
      this._stats.base++;
      this._tryBuildFrame(frameId);
    };

    decoder.onVideoStream = (streamType, bitstream, frameCount, firstFrameId) => {
      this.onLog(`Video stream: ${streamType} (${bitstream.byteLength} bytes, ${frameCount} frames)`);
      if (this._mode !== 'full') return;
      this._videoStreamsExpected++;

      const queue = streamType === 'texture' ? this._textureQueue : this._dispQueue;
      // Pass the renderer so the decoder emits ready THREE.Textures via its own GPU ring (10-bit,
      // no CPU readback). Without a renderer the decoder falls back to the CPU canvas/data path.
      const decOpts = {
        renderer: this.renderer,
        ringSize: this.RING_SIZE,
        enablePreviews: () => this.enablePreviews,
      };
      const dec = new WebVideoDecoder(decOpts);
      this._videoDecoders.push(dec);
      const runDecode = () => dec.decode(bitstream, frameCount, firstFrameId, (fid, payload) => {
        queue.set(fid, payload);
        if (streamType === 'texture') this._stats.tex++; else this._stats.disp++;
        this._tryBuildFrame(fid);
      }, streamType).then(ok => {
        if (!ok) this._switchToBaseMeshMode(`${streamType} HEVC decode unavailable`);
        else this.onLog(`${streamType} decode finished`);
      }).catch(err => {
        console.error(`[VDMCMeshStream] ${streamType} decode error`, err);
        this._switchToBaseMeshMode(`${streamType} decode error`);
      }).finally(() => {
        this._videoStreamsDone++;
        this._maybeComplete();
      });

      // Let calibration finish first so its ramp isn't starved by these video decoders sharing the
      // single hardware HEVC decoder. Cached, so this waits at most once and is a no-op thereafter.
      WebVideoDecoder.warmupCalibration(this.renderer).then(runDecode, runDecode);
    };

    decoder.onComplete = (frames) => {
      this._baseComplete = true;
      this.onLog(`Base-mesh decode complete: ${frames} frames`);
      this._maybeComplete();
    };
  }

  // Fire onComplete exactly once, after the base-mesh decode AND (in full mode) every video
  // stream have finished — i.e. once all renderable frames have actually been assembled.
  _maybeComplete() {
    if (this._completeFired || !this._baseComplete) return;
    if (this._mode === 'full' && this._videoStreamsDone < this._videoStreamsExpected) return;
    this._completeFired = true;
    console.log(`[VDMCMeshStream][stats] base=${this._stats.base} tex=${this._stats.tex} disp=${this._stats.disp} full=${this._stats.full} mode=${this._mode}`);
    this.onComplete?.({ frameCount: this._frames.size });
  }
}
