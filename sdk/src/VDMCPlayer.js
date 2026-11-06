/**
 * © 2026 Nokia
 *
 * Licensed under the 5G-MAG Public License (v1.0)
 */

// VDMCPlayer.js — optional playback helper for VDMCMeshStream.
//
// Consumes the ready-to-render meshes emitted by a VDMCMeshStream, collects them in arrival
// order, and shows one frame at a time inside a host-provided THREE.Object3D container,
// driving play/pause/loop at a target frame rate.
//
// This helper is scene-agnostic: it never creates a renderer, camera, controls or canvas. The
// application owns the scene graph and render loop and simply parents `container` somewhere in
// its scene, then calls `update(time)` from its own requestAnimationFrame loop (or relies on
// the internal clock via `play()` which advances on `update`).

import * as THREE from 'three';

export class VDMCPlayer {
  /**
   * @param {import('./VDMCMeshStream.js').VDMCMeshStream} stream
   * @param {object} opts
   * @param {THREE.Object3D} opts.container   Host container the active frame mesh is parented to.
   * @param {number} [opts.targetFps=30]
   * @param {boolean} [opts.autoPlay=true]    Start looping automatically once decode completes.
   * @param {boolean} [opts.loop=true]        Loop automatically on reaching the last frame.
   */
  constructor(stream, { container, targetFps = 30, autoPlay = true, loop = true } = {}) {
    if (!container) throw new Error('VDMCPlayer requires a { container } THREE.Object3D');
    this.stream = stream;
    this.container = container;
    this.FRAME_INTERVAL = 1000 / targetFps;
    this.autoPlay = autoPlay;
    this.loop = loop;

    this._frames = [];        // VDMCFrame[] in emission order
    this._currentIndex = -1;
    this._activeMesh = null;
    this._isPlaying = false;
    this._lastFrameTime = 0;
    this._decodeComplete = false;

    // Optional host callbacks.
    this.onFrameCounter = null; // (text: string) => void
    this.onFirstFrame = null;   // (frame: VDMCFrame) => void
    this.onShow = null;         // (index: number, frame: VDMCFrame) => void
    this.onComplete = null;     // (frameCount: number) => void
    this.onEnded = null;        // () => void

    this._wire();
  }

  _wire() {
    const prevOnFrame = this.stream.onFrame;
    this.stream.onFrame = (frame) => {
      prevOnFrame?.(frame);
      this._frames.push(frame);
      if (this._frames.length === 1) {
        this.onFirstFrame?.(frame);
        this.show(0);
        if (this.autoPlay) this.play();
      }
      this._updateCounter();
    };

    const prevOnComplete = this.stream.onComplete;
    this.stream.onComplete = (info) => {
      prevOnComplete?.(info);
      this._decodeComplete = true;
      this._updateCounter();
      this.onComplete?.(this._frames.length);
    };
  }

  // ------------------------------------------------------------------- Playback
  /** Show the frame at the given index, swapping it into the container. */
  show(index) {
    if (index < 0 || index >= this._frames.length) return;
    const frame = this._frames[index];
    if (this._activeMesh) this.container.remove(this._activeMesh);
    this._activeMesh = frame.mesh;
    this.container.add(this._activeMesh);
    this._currentIndex = index;
    this.onShow?.(index, frame);
    this._updateCounter();
  }

  // Playback may start on the very first frame; update() waits until a second frame exists.
  play() { if (this._frames.length > 0) this._isPlaying = true; }
  pause() { this._isPlaying = false; }
  togglePlay() { this._isPlaying = !this._isPlaying && this._frames.length > 0; return this._isPlaying; }

  /** Pause and jump `delta` frames (wraps around). Used by the transport step buttons. */
  step(delta) {
    if (this._frames.length === 0) return;
    this.pause();
    const n = this._frames.length;
    this.show((((this._currentIndex + delta) % n) + n) % n);
  }
  stepForward() { this.step(1); }
  stepBackward() { this.step(-1); }

  /**
   * Advance playback. Call once per animation frame with a high-resolution timestamp
   * (e.g. the argument of requestAnimationFrame).
   */
  update(timeMs) {
    if (!this._isPlaying || this._frames.length < 2) return;
    if (timeMs - this._lastFrameTime < this.FRAME_INTERVAL) return;
    this._lastFrameTime = timeMs;
    let next = this._currentIndex + 1;
    if (next >= this._frames.length) {
      if (!this._decodeComplete) {
        // Still buffering/streaming packets: hold on current frame until new frames arrive.
        return;
      }
      if (this.loop) {
        next = 0;
      } else {
        this.pause();
        this.onEnded?.();
        return;
      }
    }
    this.show(next);
  }

  get playing() { return this._isPlaying; }
  get frameCount() { return this._frames.length; }
  get currentIndex() { return this._currentIndex; }
  /** The currently displayed frame, or null. */
  get currentFrame() { return this._frames[this._currentIndex] || null; }

  _updateCounter() {
    if (!this.onFrameCounter) return;
    if (this._frames.length === 0) { this.onFrameCounter('—'); return; }
    const pos = this._currentIndex >= 0 ? this._currentIndex + 1 : 0;
    const suffix = this._decodeComplete ? ` (${this.stream.mode})` : ' (building…)';
    this.onFrameCounter(`Frame ${pos}/${this._frames.length}${suffix}`);
  }
}
