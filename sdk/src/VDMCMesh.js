/**
 * © 2026 Nokia
 *
 * Licensed under the 5G-MAG Public License (v1.0)
 */

// VDMCMesh.js — high-level, media-element-like Three.js Group component for V-DMC streams.
//
// Combines VDMCMeshStream and VDMCPlayer into a single THREE.Group that can be added directly
// to a Three.js scene (`scene.add(vdmc)`), loaded from a URL or Uint8Array, and controlled with
// standard media methods (play, pause, stop, restart, seek, stepForward, stepBackward).

import * as THREE from 'three';
import { VDMCMeshStream } from './VDMCMeshStream.js';
import { VDMCPlayer } from './VDMCPlayer.js';

export class VDMCMesh extends THREE.Group {
  /**
   * @param {object} [opts]
   * @param {string|Uint8Array} [opts.src]            Optional URL string or Uint8Array bitstream to load immediately.
   * @param {THREE.WebGLRenderer} [opts.renderer]    Required for video (texture+displacement) decoding.
   * @param {boolean} [opts.autoPlay=true]           Start playing automatically once frames arrive.
   * @param {boolean} [opts.loop=true]               Loop back to frame 0 on reaching EOF.
   * @param {number} [opts.fps=30]                   Target playback frame rate (or targetFps).
   * @param {number} [opts.subdivLevel=3]            Fallback subdivision level if bitstream omits it.
   * @param {number} [opts.dispScale=1.0]            Displacement scale multiplier.
   * @param {boolean} [opts.wireframe=false]          Render wireframe.
   * @param {number} [opts.ringSize=8]               Max GPU-resident frames per stream.
   * @param {(msg:string)=>void} [opts.onLog]        Log callback.
   */
  constructor(opts = {}) {
    super();
    this.type = 'VDMCMesh';

    this.stream = new VDMCMeshStream({
      renderer: opts.renderer || null,
      subdivLevel: opts.subdivLevel ?? 3,
      dispScale: opts.dispScale ?? 1.0,
      wireframe: opts.wireframe ?? false,
      ringSize: opts.ringSize ?? 8,
      enablePreviews: opts.enablePreviews ?? true,
      onLog: opts.onLog,
    });

    this.player = new VDMCPlayer(this.stream, {
      container: this,
      targetFps: opts.fps ?? opts.targetFps ?? 30,
      autoPlay: opts.autoPlay ?? true,
      loop: opts.loop ?? true,
    });

    this._listeners = new Map();
    this._wireEvents();

    if (opts.src) {
      this.load(opts.src);
    }
  }

  // ------------------------------------------------------------------- Event Emitter
  /** Subscribe to events ('ready', 'mode', 'firstframe', 'frame', 'ended', 'complete'). */
  on(event, callback) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(callback);
    return () => this.off(event, callback);
  }

  /** Unsubscribe from an event. */
  off(event, callback) {
    this._listeners.get(event)?.delete(callback);
  }

  /** Emit an event to all subscribers. */
  emit(event, ...args) {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const cb of set) {
      try { cb(...args); } catch (err) { console.error(`[VDMCMesh] Event '${event}' handler error:`, err); }
    }
  }

  _wireEvents() {
    this.stream.onReady = () => this.emit('ready');
    this.stream.onMode = (mode) => this.emit('mode', mode);

    this.player.onFirstFrame = (frame) => this.emit('firstframe', frame);
    this.player.onShow = (index, frame) => this.emit('frame', index, frame);
    this.player.onComplete = (frameCount) => this.emit('complete', frameCount);
    this.player.onEnded = () => this.emit('ended');
  }

  // ------------------------------------------------------------------- Media Loading
  /** Load a .vmesh from a URL string or an in-memory Uint8Array bitstream. */
  async load(src) {
    return this.stream.load(src);
  }

  /** Fetch a .vmesh URL and start decoding. */
  async loadUrl(url) {
    return this.stream.loadUrl(url);
  }

  /** Decode an in-memory Uint8Array bitstream. */
  async loadBitstream(bytes, label) {
    return this.stream.loadBitstream(bytes, label);
  }

  /** Feed a bitstream packet or chunk (Uint8Array, ArrayBuffer, or Blob). */
  async feed(chunk, label) {
    return this.stream.feed(chunk, label);
  }

  /** Alias for feed(packet). */
  async appendPacket(packet, label) {
    return this.stream.appendPacket(packet, label);
  }

  /** Signal that packet streaming is finished for the current stream. */
  endStream() {
    this.stream.endStream();
  }

  /**
   * Connect to a WebSocket or attach an existing one, feeding binary packets as they arrive.
   * @param {WebSocket|string} wsOrUrl - WebSocket instance or socket URL string.
   * @returns {WebSocket}
   */
  attachWebSocket(wsOrUrl) {
    return this.stream.attachWebSocket(wsOrUrl);
  }

  /**
   * Stream packets from a WHATWG ReadableStream or Response object (e.g. fetch response body).
   * @param {ReadableStream|Response} streamOrResponse
   */
  async attachStream(streamOrResponse) {
    return this.stream.attachStream(streamOrResponse);
  }

  // ------------------------------------------------------------------- Playback Transport
  /** Advance animation playback. Call once per frame in your requestAnimationFrame loop. */
  update(timeMs) {
    this.player.update(timeMs);
  }

  play() { this.player.play(); }
  pause() { this.player.pause(); }
  togglePlay() { return this.player.togglePlay(); }

  /** Pause playback and seek to frame 0. */
  stop() {
    this.player.pause();
    if (this.player.frameCount > 0) this.player.show(0);
  }

  /** Seek to frame 0 and resume playing. */
  restart() {
    if (this.player.frameCount > 0) this.player.show(0);
    this.player.play();
  }

  stepForward() { this.player.stepForward(); }
  stepBackward() { this.player.stepBackward(); }
  seek(index) { this.player.show(index); }

  // ------------------------------------------------------------------- Media Properties
  get playing() { return this.player.playing; }
  get currentIndex() { return this.player.currentIndex; }
  get frameCount() { return this.player.frameCount; }
  get currentFrame() { return this.player.currentFrame; }
  get mode() { return this.stream.mode; }

  get loop() { return this.player.loop; }
  set loop(v) { this.player.loop = v; }

  get fps() { return 1000 / this.player.FRAME_INTERVAL; }
  set fps(v) { this.player.FRAME_INTERVAL = 1000 / v; }

  get dispScale() { return this.stream.DISP_SCALE; }
  set dispScale(v) { this.stream.setDispScale(v); }

  get wireframe() { return this.stream.WIREFRAME; }
  set wireframe(v) { this.stream.setWireframe(v); }

  get enablePreviews() { return this.stream.enablePreviews; }
  set enablePreviews(v) { this.stream.enablePreviews = v; }

  get duration() {
    const fps = this.fps || 30;
    return this.frameCount / fps;
  }

  // ------------------------------------------------------------------- Cleanup
  /** Release all GPU textures, geometries, materials, worker, and clear the Group children. */
  dispose() {
    this.player.pause();
    this.stream.dispose();
    this.clear();
    this._listeners.clear();
  }
}
