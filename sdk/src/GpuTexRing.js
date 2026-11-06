/**
 * © 2026 Nokia
 *
 * Licensed under the 5G-MAG Public License (v1.0)
 */

// GpuTexRing.js — a bounded, reusable ring of GPU textures living in the APP's WebGL2 context.
//
// Decoded VideoFrames (displacement / texture) are uploaded straight into a ring slot and the frame
// is closed immediately, so at most `count` frames are ever GPU-resident — no per-frame CPU readback
// / re-upload, and no all-frames-in-memory. Each slot is wrapped as a THREE.Texture via property
// injection (set __webglTexture, keep version 0) so a ShaderMaterial samples it without Three trying
// to (re)upload or dispose it. Validated on r0.160.
//
// Formats: 'rgba16f' (half-float, 10-bit-capable) with an 'rgba8' fallback.

import * as THREE from 'three';

const FMT = {
  rgba16f:  { internal: 'RGBA16F',  type: 'HALF_FLOAT',    threeType: THREE.HalfFloatType },
  rgba8:    { internal: 'RGBA8',    type: 'UNSIGNED_BYTE',  threeType: THREE.UnsignedByteType },
};

export class GpuTexRing {
  /**
   * @param {THREE.WebGLRenderer} renderer  Owns the WebGL2 context the ring lives in.
   * @param {object} [opts]
   * @param {number} [opts.count=8]                Ring size (max GPU-resident frames).
   * @param {string[]} [opts.formats=['rgba16f']]  Preference order; the first the GPU accepts wins.
   * @param {string} [opts.filter='nearest']       'nearest' | 'linear' texture filtering.
   */
  constructor(renderer, { count = 8, formats = ['rgba16f'], filter = 'nearest' } = {}) {
    if (!renderer) throw new Error('GpuTexRing requires a THREE.WebGLRenderer');
    this.renderer = renderer;
    this.gl = renderer.getContext();
    this.count = Math.max(1, count | 0);
    this.filter = filter;
    this.formats = (Array.isArray(formats) ? formats : [formats]).filter((f) => FMT[f]);
    if (!this.formats.length) this.formats = ['rgba16f'];
    this.chosenFormat = null;
    this.width = 0;
    this.height = 0;
    this._i = 0;
    this._slots = null;       // [{ tex: THREE.Texture, glTex: WebGLTexture }]
  }

  // Probe the preference list against the real decoded frame; keep the first the GPU accepts.
  _selectFormat(source) {
    const gl = this.gl;
    const probe = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, probe);
    let chosen = this.formats[this.formats.length - 1];
    for (const f of this.formats) {
      while (gl.getError() !== gl.NO_ERROR) { /* drain */ }
      gl.texImage2D(gl.TEXTURE_2D, 0, gl[FMT[f].internal], gl.RGBA, gl[FMT[f].type], source);
      if (gl.getError() === gl.NO_ERROR) { chosen = f; break; }
    }
    gl.deleteTexture(probe);
    return chosen;
  }

  _ensureAllocated(source, w, h) {
    if (this._slots) return;
    const gl = this.gl;
    this.chosenFormat = this._selectFormat(source);
    this.width = w; this.height = h;
    const fmt = FMT[this.chosenFormat];
    const isLinear = this.filter === 'linear';
    const glFilter = isLinear ? gl.LINEAR : gl.NEAREST;
    const threeFilter = isLinear ? THREE.LinearFilter : THREE.NearestFilter;

    this._slots = [];
    for (let i = 0; i < this.count; i++) {
      const glTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, glTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, glFilter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, glFilter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl[fmt.internal], w, h, 0, gl.RGBA, gl[fmt.type], null);

      const tex = new THREE.Texture();
      tex.image = { width: w, height: h };
      tex.type = fmt.threeType;
      tex.magFilter = threeFilter;
      tex.minFilter = threeFilter;
      tex.generateMipmaps = false;
      tex.flipY = false;   // the atlas V-flip is done in the mesh shader, not here
      tex.colorSpace = THREE.NoColorSpace;
      const props = this.renderer.properties.get(tex);
      props.__webglTexture = glTex;   // hand Three our texture; version stays 0 so it never re-uploads
      props.__webglInit = true;
      this._slots.push({ tex, glTex });
    }
    this.renderer.resetState();
  }

  /**
   * Upload a decoded frame (VideoFrame / canvas / any TexImageSource) into the next ring slot and
   * return the THREE.Texture wrapping it. The caller may close the VideoFrame right after.
   * @param {TexImageSource} source
   * @param {number} w coded width
   * @param {number} h coded height
   * @returns {THREE.Texture}
   */
  upload(source, w, h) {
    this._ensureAllocated(source, w, h);
    const gl = this.gl;
    const slot = this._slots[this._i];
    this._i = (this._i + 1) % this.count;
    const fmt = FMT[this.chosenFormat];
    gl.bindTexture(gl.TEXTURE_2D, slot.glTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl[fmt.internal], gl.RGBA, gl[fmt.type], source);
    // The caller closes the VideoFrame right after this returns. On some drivers (ANGLE) the upload
    // is queued lazily, so the closed frame's pooled buffer gets reused by a LATER frame before the
    // copy runs — landing the wrong frame's pixels in this slot. Force the copy to finish first.
    gl.finish();
    this.renderer.resetState();       // keep Three's cached GL state consistent for the next draw
    return slot.tex;
  }

  dispose() {
    if (!this._slots) return;
    for (const s of this._slots) { try { this.gl.deleteTexture(s.glTex); } catch (_) {} }
    this._slots = null;
  }
}
