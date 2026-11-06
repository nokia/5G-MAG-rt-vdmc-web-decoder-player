/**
 * V-DMC Web Decoder SDK
 * Copyright 2026 Nokia. Licensed under the 5G-MAG Public License (v1.0);
 * see LICENSE and NOTICE in the distribution, or
 * https://www.5g-mag.com/reference-tools. Distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *
 * Third-party components (full notices in NOTICE):
 *  - MPEG V-DMC reference decoder, compiled to WebAssembly.
 *    Copyright (c) 2022, ISO/IEC. BSD 3-Clause. No patent rights are granted.
 *    Loaded from the sibling wasm/ directory.
 */

// src/VDMCMeshStream.js
import * as THREE2 from "three";

// src/VDMCDecoder.js
var VDMCDecoder = class {
  constructor() {
    this.onReady = null;
    this.onBaseMesh = null;
    this.onVideoStream = null;
    this.onComplete = null;
    this.dispParams = /* @__PURE__ */ new Map();
    this.worker = new Worker(new URL("../wasm/vdmc_worker.js", import.meta.url), { type: "module" });
    this.worker.onerror = (e) => {
      console.error("VDMCDecoder worker error:", e.message, `@ ${e.filename}:${e.lineno}`);
    };
    this.worker.onmessageerror = (e) => {
      console.error("VDMCDecoder worker messageerror:", e);
    };
    this.worker.onmessage = (e) => {
      const msg = e.data;
      switch (msg.type) {
        case "ready":
          this.onReady?.();
          break;
        case "dispParams":
          this.dispParams.set(msg.frameId, msg.params);
          break;
        case "baseMesh":
          this.onBaseMesh?.(msg.frameId, {
            positions: msg.positions,
            indices: msg.indices,
            uvs: msg.uvs,
            uvIndices: msg.uvIndices
          });
          break;
        case "videoStream":
          this.onVideoStream?.(msg.streamType, msg.bitstream, msg.frameCount, msg.firstFrameId);
          break;
        case "complete":
          this.onComplete?.(msg.totalFrames);
          break;
        case "workerError":
          console.error("VDMCDecoder worker:", msg.message, msg.filename ? `@ ${msg.filename}:${msg.lineno}` : "");
          break;
        default:
          break;
      }
    };
  }
  decode(data) {
    const arr = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.dispParams.clear();
    const payload = new Uint8Array(arr);
    this.worker.postMessage({ type: "decode", payload }, [payload.buffer]);
  }
};

// src/GpuTexRing.js
import * as THREE from "three";
var FMT = {
  rgba16f: { internal: "RGBA16F", type: "HALF_FLOAT", threeType: THREE.HalfFloatType },
  rgba8: { internal: "RGBA8", type: "UNSIGNED_BYTE", threeType: THREE.UnsignedByteType }
};
var GpuTexRing = class {
  /**
   * @param {THREE.WebGLRenderer} renderer  Owns the WebGL2 context the ring lives in.
   * @param {object} [opts]
   * @param {number} [opts.count=8]                Ring size (max GPU-resident frames).
   * @param {string[]} [opts.formats=['rgba16f']]  Preference order; the first the GPU accepts wins.
   * @param {string} [opts.filter='nearest']       'nearest' | 'linear' texture filtering.
   */
  constructor(renderer, { count = 8, formats = ["rgba16f"], filter = "nearest" } = {}) {
    if (!renderer) throw new Error("GpuTexRing requires a THREE.WebGLRenderer");
    this.renderer = renderer;
    this.gl = renderer.getContext();
    this.count = Math.max(1, count | 0);
    this.filter = filter;
    this.formats = (Array.isArray(formats) ? formats : [formats]).filter((f) => FMT[f]);
    if (!this.formats.length) this.formats = ["rgba16f"];
    this.chosenFormat = null;
    this.width = 0;
    this.height = 0;
    this._i = 0;
    this._slots = null;
  }
  // Probe the preference list against the real decoded frame; keep the first the GPU accepts.
  _selectFormat(source) {
    const gl = this.gl;
    const probe = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, probe);
    let chosen = this.formats[this.formats.length - 1];
    for (const f of this.formats) {
      while (gl.getError() !== gl.NO_ERROR) {
      }
      gl.texImage2D(gl.TEXTURE_2D, 0, gl[FMT[f].internal], gl.RGBA, gl[FMT[f].type], source);
      if (gl.getError() === gl.NO_ERROR) {
        chosen = f;
        break;
      }
    }
    gl.deleteTexture(probe);
    return chosen;
  }
  _ensureAllocated(source, w, h) {
    if (this._slots) return;
    const gl = this.gl;
    this.chosenFormat = this._selectFormat(source);
    this.width = w;
    this.height = h;
    const fmt = FMT[this.chosenFormat];
    const isLinear = this.filter === "linear";
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
      tex.flipY = false;
      tex.colorSpace = THREE.NoColorSpace;
      const props = this.renderer.properties.get(tex);
      props.__webglTexture = glTex;
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
    gl.finish();
    this.renderer.resetState();
    return slot.tex;
  }
  dispose() {
    if (!this._slots) return;
    for (const s of this._slots) {
      try {
        this.gl.deleteTexture(s.glTex);
      } catch (_) {
      }
    }
    this._slots = null;
  }
};

// src/GpuReadback.js
var GpuReadback = class {
  /** @param {THREE.WebGLRenderer} renderer  Owns the WebGL2 context the readback runs in. */
  constructor(renderer) {
    if (!renderer) throw new Error("GpuReadback requires a THREE.WebGLRenderer");
    this.renderer = renderer;
    this.gl = renderer.getContext();
  }
  /**
   * Render into a fresh w×h RGBA8 framebuffer and return its bytes (length w*h*4), or null on
   * failure. `draw(gl)` binds the program / attributes / uniforms / textures and issues the draw
   * call(s); blending, depth, scissor and culling are disabled and the target is cleared to 0 first.
   * @param {number} w
   * @param {number} h
   * @param {(gl: WebGL2RenderingContext) => void} draw
   * @returns {Uint8Array|null}
   */
  toBytes(w, h, draw) {
    const gl = this.gl;
    let fbo = null, tex = null;
    try {
      tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return null;
      gl.viewport(0, 0, w, h);
      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.SCISSOR_TEST);
      gl.disable(gl.CULL_FACE);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      while (gl.getError() !== gl.NO_ERROR) {
      }
      draw(gl);
      const bytes = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
      if (gl.getError() !== gl.NO_ERROR) return null;
      return bytes;
    } catch (_) {
      return null;
    } finally {
      try {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      } catch (_) {
      }
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(tex);
      this.renderer.resetState();
    }
  }
  /**
   * Convenience capture: upload a source frame (VideoFrame / canvas / any TexImageSource) into a
   * texture, run a fullscreen fragment shader over it and return the RGBA8 bytes. The fragment
   * shader must declare `uniform sampler2D u_video; in vec2 uv; out vec4 o;` and pack its result
   * into the bytes of `o`. Used by one-time calibration readbacks.
   * @param {TexImageSource} frame
   * @param {number} w  output width
   * @param {number} h  output height
   * @param {string} fragSrc  GLSL ES 3.00 fragment shader
   * @returns {Uint8Array|null}
   */
  shadeFrame(frame, w, h, fragSrc) {
    const gl = this.gl;
    let prog = null, vao = null, quad = null, inTex = null;
    try {
      const mk = (t, s) => {
        const sh = gl.createShader(t);
        gl.shaderSource(sh, s);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
        return sh;
      };
      const vs = `#version 300 es
        in vec2 p; out vec2 uv; void main(){ gl_Position=vec4(p,0.,1.); uv=p*0.5+0.5; }`;
      prog = gl.createProgram();
      gl.attachShader(prog, mk(gl.VERTEX_SHADER, vs));
      gl.attachShader(prog, mk(gl.FRAGMENT_SHADER, fragSrc));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
      vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      quad = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, "p");
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      inTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, inTex);
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      while (gl.getError() !== gl.NO_ERROR) {
      }
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, frame);
      if (gl.getError() !== gl.NO_ERROR) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
        if (gl.getError() !== gl.NO_ERROR) return null;
      }
      return this.toBytes(w, h, (g) => {
        g.useProgram(prog);
        g.bindVertexArray(vao);
        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D, inTex);
        g.uniform1i(g.getUniformLocation(prog, "u_video"), 0);
        g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
      });
    } catch (e) {
      console.warn("[GpuReadback] shadeFrame failed:", e && e.message || e);
      return null;
    } finally {
      try {
        gl.bindVertexArray(null);
      } catch (_) {
      }
      gl.deleteTexture(inTex);
      gl.deleteBuffer(quad);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(prog);
    }
  }
};

// src/rampCalibClip.js
var RAMP_HEVC_B64 = "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";
var RAMP_W = 128;
var RAMP_H = 128;
var RAMP_BITDEPTH = 10;
var HEVC_RAMP_CODECS = [
  "hvc1.2.4.L153.B0",
  "hev1.2.4.L153.B0",
  "hvc1.2.4.L120.90",
  "hvc1.1.6.L153.B0",
  "hev1.1.6.L153.B0",
  "hvc1.1.6.L120.90"
];
var _calibPromise = null;
function _b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function _fitRampAffine(raw, W, H) {
  const fit = (flip) => {
    const n = W * H;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) {
      const y = i / W | 0, x = i % W;
      const s = flip ? (H - 1 - y) * W + x : i;
      const code = i & 1023, xv = raw[s];
      sx += xv;
      sy += code;
      sxx += xv * xv;
      sxy += xv * code;
    }
    const den = n * sxx - sx * sx, a = (n * sxy - sx * sy) / den, b = (sy - a * sx) / n;
    let ex = 0;
    for (let i = 0; i < n; i++) {
      const y = i / W | 0, x = i % W;
      const s = flip ? (H - 1 - y) * W + x : i;
      if (Math.round(a * raw[s] + b) === (i & 1023)) ex++;
    }
    return { a, b, exactPct: 100 * ex / n };
  };
  const up = fit(false), fl = fit(true);
  return fl.exactPct > up.exactPct ? fl : up;
}
async function _pickRampCodec() {
  if (typeof VideoDecoder === "undefined" || typeof VideoDecoder.isConfigSupported !== "function") return null;
  for (const codec of HEVC_RAMP_CODECS) {
    try {
      const r = await VideoDecoder.isConfigSupported({ codec });
      if (r && r.supported) return codec;
    } catch (_) {
    }
  }
  return null;
}
function _decodeRampFrame() {
  const bytes = _b64ToBytes(RAMP_HEVC_B64);
  const tryConfig = (accel) => new Promise((resolve) => {
    (async () => {
      const codec = await _pickRampCodec();
      if (!codec) return resolve(null);
      let done = false, dec = null;
      const finish = (v) => {
        if (!done) {
          done = true;
          resolve(v);
        }
      };
      try {
        const cfg = { codec, optimizeForLatency: true };
        if (accel) cfg.hardwareAcceleration = accel;
        try {
          const s = await VideoDecoder.isConfigSupported(cfg);
          if (!s || !s.supported) return finish(null);
        } catch (_) {
        }
        dec = new VideoDecoder({ output: (f) => finish(f), error: () => finish(null) });
        dec.configure(cfg);
        dec.decode(new EncodedVideoChunk({ type: "key", timestamp: 0, data: bytes }));
        dec.flush().catch(() => {
        });
      } catch (_) {
        finish(null);
      }
      setTimeout(() => {
        finish(null);
        try {
          dec && dec.state !== "closed" && dec.close();
        } catch (_) {
        }
      }, 3e3);
    })();
  });
  return (async () => {
    for (const accel of [void 0, "prefer-software"]) {
      const f = await tryConfig(accel);
      if (f) return f;
    }
    return null;
  })();
}
function _readRampCodes(renderer, frame, cw, ch) {
  const fs = `#version 300 es
    precision highp float;
    uniform sampler2D u_video; in vec2 uv; out vec4 o;
    void main(){
      ivec2 sz=textureSize(u_video,0);
      ivec2 tc=ivec2(floor(clamp(uv,0.,0.999999)*vec2(sz)));
      vec3 rgb=texelFetch(u_video,tc,0).rgb;
      float y=clamp((rgb.r+rgb.g+rgb.b)/3.0,0.0,1.0);
      float code=floor(y*65535.0+0.5);
      float hi=floor(code/256.0); float lo=floor(code-hi*256.0);
      o=vec4(hi/255.0, lo/255.0, 0.0, 1.0);
    }`;
  const bytes = new GpuReadback(renderer).shadeFrame(frame, cw, ch, fs);
  if (!bytes) return null;
  const codes = new Uint16Array(cw * ch);
  for (let i = 0; i < cw * ch; i++) codes[i] = bytes[i * 4] * 256 + bytes[i * 4 + 1];
  return codes;
}
function warmupCalibration(renderer) {
  if (_calibPromise) return _calibPromise;
  _calibPromise = (async () => {
    if (!renderer) {
      console.warn("[calib] needs a THREE.WebGLRenderer \u2014 using default mapping");
      return null;
    }
    try {
      const frame = await _decodeRampFrame();
      if (!frame) return null;
      const cw = frame.codedWidth || RAMP_W, ch = frame.codedHeight || RAMP_H;
      const raw = _readRampCodes(renderer, frame, cw, ch);
      try {
        frame.close();
      } catch (_) {
      }
      if (!raw) return null;
      const fit = _fitRampAffine(raw, cw, ch);
      return { scaleY: fit.a * 65535, offsetY: fit.b, exactPct: fit.exactPct };
    } catch (e) {
      console.warn("[calib] error:", e && e.message || e);
      return null;
    }
  })();
  return _calibPromise;
}
async function resolveCalibration(renderer, bitDepth = RAMP_BITDEPTH) {
  const maxCode = (1 << bitDepth) - 1;
  const fit = await warmupCalibration(renderer);
  let cal;
  if (fit && fit.exactPct >= 95) {
    cal = { scaleY: fit.scaleY, offsetY: fit.offsetY, maxCode, bitDepth, source: "auto" };
  } else if (fit && Number.isFinite(fit.scaleY) && Number.isFinite(fit.offsetY) && fit.scaleY > maxCode * 0.6 && fit.scaleY < maxCode * 1.4 && Math.abs(fit.offsetY) < maxCode * 0.2) {
    cal = { scaleY: fit.scaleY, offsetY: fit.offsetY, maxCode, bitDepth, source: "auto-besteffort" };
  } else {
    cal = { scaleY: maxCode, offsetY: 0, maxCode, bitDepth, source: "default" };
  }
  const pct = fit ? `${fit.exactPct.toFixed(1)}%` : "unavailable";
  console.log(`[calib] ${cal.source} (ramp ${pct}) scaleY=${cal.scaleY.toFixed(2)} offsetY=${cal.offsetY.toFixed(2)}`);
  return cal;
}

// src/webVideoDecoder.js
var FRAME_DURATION_US = 33333;
var HEVC_CODEC_CANDIDATES = [
  "hvc1.2.4.L153.B0",
  "hev1.2.4.L153.B0",
  "hvc1.2.4.L120.90",
  "hvc1.1.6.L153.B0",
  "hev1.1.6.L153.B0",
  "hvc1.1.6.L120.90"
];
var WebVideoDecoder = class _WebVideoDecoder {
  /**
   * @param {object} [opts]
   * @param {THREE.WebGLRenderer} [opts.renderer]  Required for GPU-direct decode + calibration.
   * @param {number} [opts.ringSize=8]  Max GPU-resident frames per stream.
   */
  constructor(opts = {}) {
    this.decoder = null;
    this.codec = null;
    this.isConfigured = false;
    this.outputFrameIndex = 0;
    this.firstFrameId = 0;
    this.onFrame = null;
    this.label = "video";
    this.pending = [];
    this.renderer = opts.renderer || null;
    this.ringSize = opts.ringSize || 8;
    this.enablePreviews = opts.enablePreviews ?? false;
    this._texRing = null;
    this._resolvedCal = null;
  }
  // Lazily create this stream's GPU texture ring in the app's context. Both streams use rgba16f
  // (half-float, 10-bit-capable); the colour stream falls back to rgba8 where rgba16f is unavailable.
  _ring() {
    if (!this._texRing) {
      const formats = this.label === "displacement" ? ["rgba16f"] : ["rgba16f", "rgba8"];
      const filter = this.label === "displacement" ? "nearest" : "linear";
      this._texRing = new GpuTexRing(this.renderer, { count: this.ringSize, formats, filter });
    }
    return this._texRing;
  }
  // A VideoFrame whose visibleRect != coded area (e.g. the texture atlas) would upload only its
  // visible region via texImage2D. Re-wrap it so the visible rect is the whole coded frame; the
  // caller closes the returned wrapper (if any) after the upload. Displacement frames already have
  // visible == coded, so no wrapper is made.
  _fullCoded(frame, cw, ch) {
    try {
      const vr = frame.visibleRect;
      const needs = !vr || vr.x !== 0 || vr.y !== 0 || vr.width !== cw || vr.height !== ch || frame.displayWidth !== cw || frame.displayHeight !== ch;
      if (needs && typeof VideoFrame === "function") {
        const wrap = new VideoFrame(frame, { visibleRect: { x: 0, y: 0, width: cw, height: ch }, displayWidth: cw, displayHeight: ch });
        return { src: wrap, wrap };
      }
    } catch (_) {
    }
    return { src: frame, wrap: null };
  }
  /**
   * Probe WebCodecs HEVC support and pick a codec string the platform accepts.
   * @returns {Promise<string|null>} a supported codec string, or null if none
   */
  static async pickSupportedCodec() {
    if (typeof VideoDecoder === "undefined" || typeof VideoDecoder.isConfigSupported !== "function") {
      return null;
    }
    for (const codec of HEVC_CODEC_CANDIDATES) {
      try {
        const res = await VideoDecoder.isConfigSupported({ codec });
        if (res && res.supported) return codec;
      } catch (_) {
      }
    }
    return null;
  }
  /**
   * Pre-decode the auto-calibration ramp on the (single) hardware HEVC decoder BEFORE any texture/
   * displacement video occupies it — otherwise the ramp decode starves and displacement extraction
   * drops to the less-exact bitstream fallback. Session-cached, so it runs at most once; safe to
   * call eagerly and to await from every video stream.
   * @param {THREE.WebGLRenderer} renderer  Context the ramp is read back in (calibration is GPU-side).
   * @returns {Promise<{scaleY:number,offsetY:number,exactPct:number}|null>}
   */
  static warmupCalibration(renderer) {
    return warmupCalibration(renderer);
  }
  /**
   * Decode a complete HEVC Annex-B substream.
   * @param {Uint8Array} bitstream - Annex-B HEVC bytes
   * @param {number} frameCount - expected number of frames
   * @param {number} firstFrameId - frameId of the first (presentation-order) output
   * @param {(frameId:number, canvas:(HTMLCanvasElement|OffscreenCanvas)) => void} onFrame
   * @param {string} [label] - 'texture' | 'displacement' (for logs)
   * @returns {Promise<boolean>} true if >=1 frame decoded, false on unsupported/failure
   */
  async decode(bitstream, frameCount, firstFrameId, onFrame, label) {
    this.outputFrameIndex = 0;
    this.firstFrameId = firstFrameId | 0;
    this.onFrame = onFrame;
    this.label = label || "video";
    this.pending = [];
    const codec = await _WebVideoDecoder.pickSupportedCodec();
    if (!codec) {
      console.warn(`[WebVideoDecoder:${this.label}] No supported HEVC codec \u2014 WebCodecs HEVC unavailable`);
      return false;
    }
    this.codec = codec;
    console.log(`[WebVideoDecoder:${this.label}] decode: ${bitstream.byteLength} bytes, ${frameCount} frames, codec ${codec}`);
    if (!this.renderer) {
      console.warn(`[WebVideoDecoder:${this.label}] no THREE.WebGLRenderer \u2014 video decode requires one (base-mesh fallback)`);
      return false;
    }
    try {
      this.decoder = new VideoDecoder({
        output: (frame) => this.onOutput(frame),
        error: (err) => this.onError(err)
      });
      const config = { codec, optimizeForLatency: false };
      this.decoder.configure(config);
      this.isConfigured = true;
      if (this.label === "displacement") {
        this._resolvedCal = await resolveCalibration(this.renderer);
      }
      await this.feedBitstream(bitstream);
      await this.decoder.flush();
      await Promise.allSettled(this.pending);
      console.log(`[WebVideoDecoder:${this.label}] complete: ${this.outputFrameIndex} frames decoded`);
      return this.outputFrameIndex > 0;
    } catch (err) {
      console.error(`[WebVideoDecoder:${this.label}] decode failed:`, err);
      return false;
    } finally {
      try {
        this.decoder && this.decoder.state !== "closed" && this.decoder.close();
      } catch (_) {
      }
      this.decoder = null;
      this.isConfigured = false;
    }
  }
  /**
   * Split Annex-B HEVC bitstream into NAL units and feed to decoder
   * @param {Uint8Array} bitstream
   */
  async feedBitstream(bitstream) {
    if (!this.isConfigured) {
      throw new Error("Decoder not configured");
    }
    const nalUnits = this.splitAnnexB(bitstream);
    console.log(`[WebVideoDecoder] Found ${nalUnits.length} NAL units`);
    if (nalUnits.length === 0) {
      throw new Error("No NAL units found in bitstream");
    }
    const parameterSets = [];
    const frameNALs = [];
    for (const nal of nalUnits) {
      const nalType = this.getNALType(nal.data);
      if (nalType >= 32 && nalType <= 34) {
        parameterSets.push(nal);
        console.log(`[WebVideoDecoder] Found parameter set NAL type ${nalType}`);
      } else if (this.isFrameNAL(nalType)) {
        frameNALs.push(nal);
      }
    }
    if (frameNALs.length > 0) {
      const firstFrameNAL = frameNALs[0];
      const keyframeData = this.concatenateNALs([...parameterSets, firstFrameNAL]);
      const keyframeId = this.firstFrameId;
      const keyframeChunk = new EncodedVideoChunk({
        type: "key",
        data: keyframeData,
        timestamp: keyframeId * FRAME_DURATION_US,
        duration: FRAME_DURATION_US
      });
      this.decoder.decode(keyframeChunk);
      console.log(`[WebVideoDecoder:${this.label}] Fed keyframe chunk: frameId=${keyframeId}, ${keyframeData.byteLength} bytes`);
      for (let i = 1; i < frameNALs.length; i++) {
        const frameNAL = frameNALs[i];
        const nalType = this.getNALType(frameNAL.data);
        const isKey = this.isKeyFrameNAL(nalType);
        let frameData;
        if (isKey) {
          frameData = this.concatenateNALs([...parameterSets, frameNAL]);
        } else {
          frameData = this.concatenateNALs([frameNAL]);
        }
        const frameId = this.firstFrameId + i;
        const chunk = new EncodedVideoChunk({
          type: isKey ? "key" : "delta",
          data: frameData,
          timestamp: frameId * FRAME_DURATION_US,
          duration: FRAME_DURATION_US
        });
        this.decoder.decode(chunk);
      }
      console.log(`[WebVideoDecoder:${this.label}] Fed ${frameNALs.length} frame chunks (frameId ${this.firstFrameId}..${this.firstFrameId + frameNALs.length - 1})`);
    }
  }
  /**
   * Split Annex-B bitstream into NAL units
   * @param {Uint8Array} bitstream
   * @returns {Array<{data: Uint8Array, offset: number}>}
   */
  splitAnnexB(bitstream) {
    const nalUnits = [];
    const startCodePositions = [];
    for (let i = 0; i < bitstream.length - 3; i++) {
      if (bitstream[i] === 0 && bitstream[i + 1] === 0) {
        if (bitstream[i + 2] === 1) {
          startCodePositions.push({ pos: i, length: 3 });
          i += 2;
        } else if (bitstream[i + 2] === 0 && i < bitstream.length - 4 && bitstream[i + 3] === 1) {
          startCodePositions.push({ pos: i, length: 4 });
          i += 3;
        }
      }
    }
    for (let i = 0; i < startCodePositions.length; i++) {
      const start = startCodePositions[i].pos + startCodePositions[i].length;
      const end = i + 1 < startCodePositions.length ? startCodePositions[i + 1].pos : bitstream.length;
      const nalData = bitstream.slice(start, end);
      nalUnits.push({
        data: nalData,
        offset: start
      });
    }
    return nalUnits;
  }
  /**
   * Get HEVC NAL unit type from NAL header
   * @param {Uint8Array} nalData
   * @returns {number} NAL type (0-63)
   */
  getNALType(nalData) {
    if (nalData.length === 0) return -1;
    return nalData[0] >> 1 & 63;
  }
  /**
   * Check if NAL type is a frame NAL (slice)
   * @param {number} nalType
   * @returns {boolean}
   */
  isFrameNAL(nalType) {
    return nalType >= 0 && nalType <= 9 || nalType >= 16 && nalType <= 21;
  }
  /**
   * Check if NAL type is a keyframe (IDR or BLA)
   * @param {number} nalType
   * @returns {boolean}
   */
  isKeyFrameNAL(nalType) {
    return nalType >= 16 && nalType <= 20;
  }
  /**
   * Concatenate NAL units with start codes
   * @param {Array<{data: Uint8Array}>} nals
   * @returns {Uint8Array}
   */
  concatenateNALs(nals) {
    const startCode = new Uint8Array([0, 0, 0, 1]);
    let totalLength = 0;
    for (const nal of nals) {
      totalLength += startCode.length + nal.data.length;
    }
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const nal of nals) {
      result.set(startCode, offset);
      offset += startCode.length;
      result.set(nal.data, offset);
      offset += nal.data.length;
    }
    return result;
  }
  /**
   * Called when the decoder outputs a decoded frame (in presentation order).
   * Snapshots the frame to a canvas and forwards it via onFrame, then closes the VideoFrame.
   * @param {VideoFrame} frame
   */
  onOutput(frame) {
    const arrivalIndex = this.outputFrameIndex++;
    const tsFrameId = Number.isFinite(frame.timestamp) ? Math.round(frame.timestamp / FRAME_DURATION_US) : null;
    const frameId = tsFrameId !== null ? tsFrameId : this.firstFrameId + arrivalIndex;
    const expectedSequential = this.firstFrameId + arrivalIndex;
    if (tsFrameId !== null && tsFrameId !== expectedSequential) {
      console.warn(`[WebVideoDecoder:${this.label}] OUT-OF-ORDER output: frameId=${frameId} arrived at position ${arrivalIndex} (sequential would be ${expectedSequential}) \u2014 frameId preserved via timestamp`);
    }
    console.log(`[WebVideoDecoder:${this.label}] output frameId=${frameId} (arrival #${arrivalIndex}, ts=${frame.timestamp})`);
    if (arrivalIndex === 0) {
      const vr = frame.visibleRect;
      console.log(`[WebVideoDecoder:${this.label}] geometry: format=${frame.format} coded=${frame.codedWidth}x${frame.codedHeight} display=${frame.displayWidth}x${frame.displayHeight} visible=${vr ? `${vr.x},${vr.y} ${vr.width}x${vr.height}` : "n/a"}`);
    }
    const p = (async () => {
      try {
        const cw = frame.codedWidth, ch = frame.codedHeight;
        if (!cw || !ch) {
          console.warn(`[WebVideoDecoder:${this.label}] frameId=${frameId} has zero coded size (${cw}x${ch}) \u2014 skipping`);
          return;
        }
        const { src, wrap } = this._fullCoded(frame, cw, ch);
        const texture = this._ring().upload(src, cw, ch);
        let previewImage = null;
        const isPreviewEnabled = typeof this.enablePreviews === "function" ? this.enablePreviews() : this.enablePreviews;
        if (isPreviewEnabled) {
          try {
            const cvs = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(cw, ch) : document.createElement("canvas");
            cvs.width = cw;
            cvs.height = ch;
            const ctx = cvs.getContext("2d");
            ctx.drawImage(src, 0, 0, cw, ch);
            previewImage = cvs;
          } catch (e) {
            console.warn(`[WebVideoDecoder:${this.label}] preview snapshot failed:`, e);
          }
        }
        if (wrap) {
          try {
            wrap.close();
          } catch (_) {
          }
        }
        const payload = this.label === "displacement" ? { texture, kind: "displacement", cal: this._resolvedCal, width: cw, height: ch, gpu: true, previewImage } : { texture, kind: "texture", width: cw, height: ch, gpu: true, previewImage };
        if (this.onFrame) this.onFrame(frameId, payload);
      } catch (err) {
        console.error(`[WebVideoDecoder:${this.label}] frame ${frameId} upload failed:`, err);
      } finally {
        frame.close();
      }
    })();
    this.pending.push(p);
  }
  /**
   * Called on decoder errors.
   * @param {Error} err
   */
  onError(err) {
    console.error(`[WebVideoDecoder:${this.label}] decoder error:`, err);
  }
  /**
   * Destroy decoder and free resources.
   */
  async destroy() {
    if (this.decoder) {
      try {
        if (this.decoder.state !== "closed") this.decoder.close();
      } catch (err) {
        console.error(`[WebVideoDecoder:${this.label}] error during destroy:`, err);
      }
      this.decoder = null;
    }
    if (this._texRing) {
      this._texRing.dispose();
      this._texRing = null;
    }
    this.isConfigured = false;
    this.outputFrameIndex = 0;
    this.pending = [];
  }
};

// src/SubdivideMesh.js
import {
  Vector3,
  Color,
  BufferGeometry,
  BufferAttribute,
  InstancedBufferAttribute,
  InstancedMesh,
  ShaderMaterial,
  GLSL3,
  DoubleSide
} from "three";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";

// src/subdivNumbering.mjs
function vBasis(i) {
  return /* @__PURE__ */ new Map([[i, 1]]);
}
function vAvg(a, b) {
  const out = /* @__PURE__ */ new Map();
  for (const [k, w] of a) out.set(k, (out.get(k) || 0) + w * 0.5);
  for (const [k, w] of b) out.set(k, (out.get(k) || 0) + w * 0.5);
  return out;
}
function vKey(m) {
  return [...m.entries()].filter(([, w]) => Math.abs(w) > 1e-12).sort((x, y) => x[0] - y[0]).map(([k, w]) => `${k}:${Math.round(w * 1048576)}`).join("|");
}
function buildCanonicalDescriptors(level) {
  const corner = [
    { type: "corner", slot: 0, bary: vBasis(0) },
    { type: "corner", slot: 1, bary: vBasis(1) },
    { type: "corner", slot: 2, bary: vBasis(2) }
  ];
  const baseEdge = [0, 1, 2].map((k) => ({
    type: "base",
    slot: k,
    endA: corner[k],
    endB: corner[(k + 1) % 3]
  }));
  const baseTri = { type: "baseTri" };
  let tris = [{
    corners: [corner[0], corner[1], corner[2]],
    edges: [baseEdge[0], baseEdge[1], baseEdge[2]],
    triRecipe: baseTri,
    band: 0
  }];
  const vertsByKey = /* @__PURE__ */ new Map();
  const order = [];
  const reg = (vr) => {
    const k = vKey(vr.bary);
    if (!vertsByKey.has(k)) {
      vertsByKey.set(k, vr);
      order.push(vr);
    }
    return vertsByKey.get(k);
  };
  corner.forEach(reg);
  const getMid = (edge) => {
    const bary = vAvg(edge.endA.bary, edge.endB.bary);
    const k = vKey(bary);
    if (vertsByKey.has(k)) return vertsByKey.get(k);
    const vr = { type: "mid", edge, bary };
    vertsByKey.set(k, vr);
    order.push(vr);
    return vr;
  };
  for (let it = 0; it < level; it++) {
    const midOf = /* @__PURE__ */ new Map();
    for (const T of tris) {
      for (let k = 0; k < 3; k++) {
        if (!midOf.has(T.edges[k])) midOf.set(T.edges[k], getMid(T.edges[k]));
      }
    }
    if (it >= level - 1) break;
    const g = it;
    const eb = it + 1;
    const newTris = [];
    for (const T of tris) {
      const C = T.corners, Ed = T.edges;
      const m = [midOf.get(Ed[0]), midOf.get(Ed[1]), midOf.get(Ed[2])];
      const sub = [];
      for (let k = 0; k < 3; k++) {
        const kn = (k + 1) % 3;
        sub[k] = [
          { type: "split", parent: Ed[k], near: C[k], far: C[kn], band: eb, endA: C[k], endB: m[k] },
          { type: "split", parent: Ed[k], near: C[kn], far: C[k], band: eb, endA: C[kn], endB: m[k] }
        ];
      }
      const intE = [0, 1, 2].map((k) => ({
        type: "interior",
        tri: T.triRecipe,
        slot: k,
        band: eb,
        endA: m[k],
        endB: m[(k + 1) % 3]
      }));
      const childRecipe = (kind) => ({ type: "triChild", parent: T.triRecipe, kind, band: g });
      newTris.push({
        corners: [m[0], m[1], m[2]],
        edges: [intE[0], intE[1], intE[2]],
        triRecipe: childRecipe("center"),
        band: g + 1
      });
      newTris.push({
        corners: [C[0], m[0], m[2]],
        edges: [sub[0][0], intE[2], sub[2][1]],
        triRecipe: childRecipe(0),
        band: g + 1
      });
      newTris.push({
        corners: [m[0], C[1], m[1]],
        edges: [sub[0][1], sub[1][0], intE[0]],
        triRecipe: childRecipe(1),
        band: g + 1
      });
      newTris.push({
        corners: [m[2], m[1], C[2]],
        edges: [intE[1], sub[1][1], sub[2][0]],
        triRecipe: childRecipe(2),
        band: g + 1
      });
    }
    tris = newTris;
  }
  return order.map((vr) => {
    const b = [0, 0, 0];
    for (const [k, w] of vr.bary) b[k] = w;
    return { bary: b, recipe: vr };
  });
}
function recipeLevel(recipe) {
  if (recipe.type === "corner") return 0;
  const e = recipe.edge;
  return e.type === "base" ? 1 : e.band + 1;
}
function buildShaderPattern(level) {
  const descriptors = buildCanonicalDescriptors(level);
  const denom = 1 << level;
  const ikey = (b) => `${Math.round(b[0] * denom)},${Math.round(b[1] * denom)},${Math.round(b[2] * denom)}`;
  const descByKey = /* @__PURE__ */ new Map();
  descriptors.forEach((d, i) => descByKey.set(ikey(d.bary), i));
  let tris = [[[1, 0, 0], [0, 1, 0], [0, 0, 1]]];
  for (let it = 0; it < level; it++) {
    const next = [];
    for (const [A, B, C] of tris) {
      const m = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
      const M1 = m(A, B), M2 = m(B, C), M3 = m(C, A);
      next.push([A, M1, M3], [M1, B, M2], [M3, M2, C], [M1, M2, M3]);
    }
    tris = next;
  }
  const indices = [];
  for (const tr of tris) for (const v of tr) {
    const idx = descByKey.get(ikey(v));
    if (idx === void 0) throw new Error("pattern vertex missing descriptor: " + v);
    indices.push(idx);
  }
  const nVerts = descriptors.length;
  const positions = new Float32Array(nVerts * 3);
  const meta = new Float32Array(nVerts * 3);
  descriptors.forEach((d, i) => {
    positions[i * 3 + 0] = d.bary[0];
    positions[i * 3 + 1] = d.bary[1];
    positions[i * 3 + 2] = d.bary[2];
    meta[i * 3 + 1] = recipeLevel(d.recipe);
    meta[i * 3 + 2] = i;
  });
  const IndexArray = nVerts > 65535 ? Uint32Array : Uint16Array;
  return {
    positions,
    indices: new IndexArray(indices),
    meta,
    vertexCount: nVerts
  };
}
function buildDIdxGLSL(level) {
  const descriptors = buildCanonicalDescriptors(level);
  const emitVertex = (vr) => vr.type === "corner" ? `Cg[${vr.slot}]` : emitEdge(vr.edge);
  const emitEdge = (er) => {
    if (er.type === "base") return `(V[0] + Eg[${er.slot}])`;
    if (er.type === "split") {
      const p = emitEdge(er.parent);
      const off = `((${emitVertex(er.near)} < ${emitVertex(er.far)}) ? 0 : 1)`;
      return `(V[${er.band}] + 2 * (${p} - V[${er.band - 1}]) + ${off})`;
    }
    return `(V[${er.band}] + 2 * E[${er.band - 1}] + 3 * ${emitTri(er.tri)} + ${er.slot})`;
  };
  const emitTri = (tr) => {
    if (tr.type === "baseTri") return `tbm`;
    const p = emitTri(tr.parent);
    return tr.kind === "center" ? p : `(T[${tr.band}] + 3 * ${p} + ${tr.kind})`;
  };
  let s = "";
  s += "int computeDIdxRow(int row, ivec3 Cg, ivec3 Eg, int tbm, int V[8], int E[8], int T[8]) {\n";
  s += "  switch (row) {\n";
  descriptors.forEach((d, v) => {
    s += `  case ${v}: return ${emitVertex(d.recipe)};
`;
  });
  s += "  }\n";
  s += "  return 0;\n";
  s += "}\n";
  return { glsl: s, vertexCount: descriptors.length };
}
function buildNormalNlerpGLSL(level) {
  const descriptors = buildCanonicalDescriptors(level);
  const emit = (vr) => vr.type === "corner" ? `n${vr.slot}` : `normalize(0.5 * (${emit(vr.edge.endA)} + ${emit(vr.edge.endB)}))`;
  let s = "";
  s += "vec3 nlerpNormalRow(int row, vec3 n0, vec3 n1, vec3 n2) {\n";
  s += "  switch (row) {\n";
  descriptors.forEach((d, v) => {
    s += `  case ${v}: return ${emit(d.recipe)};
`;
  });
  s += "  default: return n0;\n";
  s += "  }\n";
  s += "}\n";
  return { glsl: s, vertexCount: descriptors.length };
}

// src/SubdivideMesh.js
function generateIndexedPattern(level) {
  let tris = [[[1, 0, 0], [0, 1, 0], [0, 0, 1]]];
  for (let i = 0; i < level; i++) {
    const next = [];
    tris.forEach(([A, B, C]) => {
      const M1 = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2];
      const M2 = [(B[0] + C[0]) / 2, (B[1] + C[1]) / 2, (B[2] + C[2]) / 2];
      const M3 = [(C[0] + A[0]) / 2, (C[1] + A[1]) / 2, (C[2] + A[2]) / 2];
      next.push([A, M1, M3], [M1, B, M2], [M3, M2, C], [M1, M2, M3]);
    });
    tris = next;
  }
  const verts = [], idxs = [], map = /* @__PURE__ */ new Map();
  tris.forEach((tr) => tr.forEach((v) => {
    const key = v.join();
    if (!map.has(key)) {
      map.set(key, verts.length);
      verts.push(v);
    }
    idxs.push(map.get(key));
  }));
  const positions = new Float32Array(verts.flat());
  return { positions, indices: new Uint16Array(idxs) };
}
function weldNormalsFast(geo, eps = 1e-4) {
  const pos = geo.getAttribute("position");
  const nrm = geo.getAttribute("normal");
  const n = pos.count, q = 1 / eps;
  const map = /* @__PURE__ */ new Map();
  const sumX = [], sumY = [], sumZ = [], lists = [];
  for (let i = 0; i < n; ++i) {
    const k = (pos.getX(i) * q | 0) * 73856093 ^ (pos.getY(i) * q | 0) * 19349663 ^ (pos.getZ(i) * q | 0) * 83492791;
    let g = map.get(k);
    if (g === void 0) {
      g = sumX.length;
      map.set(k, g);
      sumX[g] = sumY[g] = sumZ[g] = 0;
      lists[g] = [];
    }
    sumX[g] += nrm.getX(i);
    sumY[g] += nrm.getY(i);
    sumZ[g] += nrm.getZ(i);
    lists[g].push(i);
  }
  for (let g = 0; g < sumX.length; ++g) {
    let x = sumX[g], y = sumY[g], z = sumZ[g];
    const len = Math.hypot(x, y, z) || 1;
    x /= len;
    y /= len;
    z /= len;
    const ids = lists[g];
    for (let j = 0; j < ids.length; ++j) nrm.setXYZ(ids[j], x, y, z);
  }
  nrm.needsUpdate = true;
}
function applyDecoderBaseNormals(geo) {
  const bd = geo.userData && geo.userData.baseData;
  if (!(bd && bd.indices && bd.positions)) {
    geo.computeVertexNormals();
    return;
  }
  const P = bd.positions, idx = bd.indices, nV = P.length / 3;
  const acc = new Float32Array(nV * 3);
  for (let f = 0; f < idx.length; f += 3) {
    const a = idx[f], b = idx[f + 1], c = idx[f + 2];
    const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
    const e1x = P[b * 3] - ax, e1y = P[b * 3 + 1] - ay, e1z = P[b * 3 + 2] - az;
    const e2x = P[c * 3] - ax, e2y = P[c * 3 + 1] - ay, e2z = P[c * 3 + 2] - az;
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    acc[a * 3] += nx;
    acc[a * 3 + 1] += ny;
    acc[a * 3 + 2] += nz;
    acc[b * 3] += nx;
    acc[b * 3 + 1] += ny;
    acc[b * 3 + 2] += nz;
    acc[c * 3] += nx;
    acc[c * 3 + 1] += ny;
    acc[c * 3 + 2] += nz;
  }
  for (let v = 0; v < nV; v++) {
    const L = Math.hypot(acc[v * 3], acc[v * 3 + 1], acc[v * 3 + 2]) || 1;
    acc[v * 3] /= L;
    acc[v * 3 + 1] /= L;
    acc[v * 3 + 2] /= L;
  }
  const nrm = new Float32Array(idx.length * 3);
  for (let c = 0; c < idx.length; c++) {
    const v = idx[c];
    nrm[c * 3] = acc[v * 3];
    nrm[c * 3 + 1] = acc[v * 3 + 1];
    nrm[c * 3 + 2] = acc[v * 3 + 2];
  }
  geo.setAttribute("normal", new BufferAttribute(nrm, 3));
}
function SubdivideMesh(base, tex, disp, subdiv = 3, wireframe = true, dispParams = null) {
  const hasProperDisp = !!(dispParams && dispParams.edgeTable);
  if (!hasProperDisp) base = mergeVertices(base, 1e-6);
  if (hasProperDisp) {
    applyDecoderBaseNormals(base);
  } else {
    base.computeVertexNormals();
    weldNormalsFast(base);
  }
  base.computeBoundingSphere();
  const modelRadius = base.boundingSphere && base.boundingSphere.radius || 1;
  const pattern = hasProperDisp ? buildShaderPattern(subdiv) : generateIndexedPattern(subdiv);
  const patternPos = pattern.positions;
  const patternIdx = pattern.indices;
  const didxGLSL = hasProperDisp ? buildDIdxGLSL(subdiv).glsl : "";
  const normGLSL = hasProperDisp ? buildNormalNlerpGLSL(subdiv).glsl : "";
  const posAttr = base.getAttribute("position");
  const normAttr = base.getAttribute("normal");
  const uvAttr = base.getAttribute("uv");
  const idx = base.getIndex();
  const count = (idx ? idx.count : posAttr.count) / 3;
  function packMatrix(getIdx2, attr3, uvGetter) {
    const mats = new Float32Array(count * 16);
    for (let t = 0; t < count; t++) {
      const baseOff = t * 16;
      for (let j = 0; j < 3; j++) {
        const i = getIdx2(t * 3 + j);
        const o = baseOff + j * 4;
        mats[o + 0] = attr3.getX(i);
        mats[o + 1] = attr3.getY(i);
        mats[o + 2] = attr3.getZ(i);
        mats[o + 3] = uvGetter(i);
      }
    }
    return mats;
  }
  const getIdx = idx ? ((i) => idx.getX(i)) : ((i) => i);
  const Mpos = packMatrix(getIdx, posAttr, (i) => uvAttr.getX(i));
  const Mnorm = packMatrix(getIdx, normAttr, (i) => uvAttr.getY(i));
  const baseData = base.userData && base.userData.baseData;
  const cornerToBaseV = baseData && baseData.indices ? baseData.indices : idx ? idx.array : null;
  const baseVIdx = cornerToBaseV ? ((i) => cornerToBaseV[i]) : ((i) => i);
  if (hasProperDisp) {
    for (let t = 0; t < count; t++) {
      const o = t * 16;
      Mpos[o + 12] = baseVIdx(t * 3 + 0);
      Mpos[o + 13] = baseVIdx(t * 3 + 1);
      Mpos[o + 14] = baseVIdx(t * 3 + 2);
      Mpos[o + 15] = 0;
      Mnorm[o + 12] = dispParams.edgeTable[3 * t + 0];
      Mnorm[o + 13] = dispParams.edgeTable[3 * t + 1];
      Mnorm[o + 14] = dispParams.edgeTable[3 * t + 2];
      Mnorm[o + 15] = 0;
    }
  }
  const inst = new BufferGeometry();
  inst.setAttribute("position", new BufferAttribute(patternPos, 3));
  inst.setIndex(new BufferAttribute(patternIdx, 1));
  inst.setAttribute("mP", new InstancedBufferAttribute(Mpos, 16));
  inst.setAttribute("mN", new InstancedBufferAttribute(Mnorm, 16));
  if (hasProperDisp) {
    inst.setAttribute("aMeta", new BufferAttribute(pattern.meta, 3));
  }
  const dispTexW = disp && disp.image && disp.image.width || 0;
  const dispTexH = disp && disp.image && disp.image.height || 0;
  const dispUniforms = hasProperDisp ? {
    uBaseVertexCount: { value: dispParams.baseVertexCount },
    uBaseEdgesCount: { value: dispParams.baseEdgesCount },
    uBaseTriCount: { value: count },
    uDispWidth: { value: dispParams.dispWidth || dispTexW },
    uDispHeight: { value: dispParams.dispHeight || dispTexH },
    uLog2BlockSize: { value: dispParams.log2BlockSize },
    uPackingMethod: { value: dispParams.packingMethod },
    uLodCount: { value: dispParams.lodCount || (dispParams.iscale ? dispParams.iscale.length : 0) }
  } : {};
  const mat = new ShaderMaterial({
    glslVersion: GLSL3,
    side: DoubleSide,
    wireframe,
    uniforms: {
      mapTexture: { value: tex },
      mapDisp: { value: disp },
      lightDir: { value: new Vector3(-0.3, -0.8, 1.5).normalize() },
      ambientColor: { value: new Color(0.35, 0.35, 0.35) },
      dispScale: { value: 0 },
      uDispUnit: { value: modelRadius },
      // world units per unit dispScale (smooth path)
      uUseProperDisp: { value: hasProperDisp ? 1 : 0 },
      // Base surface used BEFORE displacement: 0 = midpoint (flat, linear barycentric — the
      // surface V-DMC MIDPOINT subdivision (method 0) produces), 1 = quadratic Bezier surface,
      // which is the geometric form of V-DMC NORMAL subdivision (method 2): midpoint + a normal-
      // direction edge offset, degree-2 (NOT cubic PN). The GPU surface must match whichever
      // asve_subdivision_method the encoder used, or the displacement double-counts.
      // Proper displacement defaults to midpoint here; the no-displacement preview defaults to quadratic.
      uSubdivMode: { value: hasProperDisp ? 0 : 1 },
      // Raw GPU-direct displacement (renderer ring path): mapDisp holds the decoded frame's luma;
      // calibrate inline. uDispRaw=0 keeps the CPU path where mapDisp.r is already normalized code.
      uDispRaw: { value: 0 },
      uCalScale: { value: 1 },
      uCalOffset: { value: 0 },
      uDispNorm: { value: 1 },
      uTexRaw: { value: 0 },
      ...dispUniforms
    },
    vertexShader: `
      in mat4 mP;                  // cols 0-2: positions + uv.x; col 3: corner global indices (proper)
      in mat4 mN;                  // cols 0-2: normals  + uv.y; col 3: base-edge global indices (proper)
      ${hasProperDisp ? "in vec3 aMeta;" : ""}     // (opCount, Lv, row)
      out vec2 vUv;
      out vec3 vNormal;
	    uniform float dispScale;
	    uniform float uDispUnit;
      uniform int uUseProperDisp;
      uniform int uSubdivMode;     // 0 = midpoint (method 0, flat), 1 = quadratic Bezier (method 2, NORMAL)
      uniform sampler2D mapDisp;
      uniform int uDispRaw;      // 1 = mapDisp is the raw decoded frame (calibrate luma inline)
      uniform float uCalScale;   // luma->code affine (raw path)
      uniform float uCalOffset;
      uniform float uDispNorm;   // 1 / 2^bitDepth (raw path)

      ${hasProperDisp ? `
      // ---- Proper V-DMC displacement uniforms ----
      uniform int uBaseVertexCount;
      uniform int uBaseEdgesCount;
      uniform int uBaseTriCount;
      uniform int uDispWidth;
      uniform int uDispHeight;
      uniform int uLog2BlockSize;
      uniform int uPackingMethod;
      uniform int uLodCount;
      ` : ""}

      mat3 edgeMat(mat3 P, mat3 Q, mat3 N, float A, float B)
      {
          vec3 d = vec3(dot(P[0] - Q[0], N[0]), 
                        dot(P[1] - Q[1], N[1]), 
                        dot(P[2] - Q[2], N[2]));

    	  mat3 n3 = mat3(N[0] * d.x, N[1] * d.y, N[2] * d.z);

          return A * (P + B * (Q + n3));
      }

      vec3 _normal(vec3 bary, mat3 P, mat3 N)
      {
          mat3 En = edgeMat(P, mat3(P[1], P[2], P[0]), N, 0.5, 1.0);
          mat3 Ep = edgeMat(P, mat3(P[2], P[0], P[1]), N, 0.5, 1.0);

          vec3 s = bary * bary,
          	   p = bary * bary.yzx,
               q = bary * bary.zxy;

          return P * s + En * p + Ep * q;
      }

      ${hasProperDisp ? `
      // ---- Morton / block packing ----
      void extracOddBits(inout int x) {
        x = x & 0x55555555;
        x = (x | (x >> 1)) & 0x33333333;
        x = (x | (x >> 2)) & 0x0F0F0F0F;
        x = (x | (x >> 4)) & 0x00FF00FF;
        x = (x | (x >> 8)) & 0x0000FFFF;
      }
      void computeMorton2D(int i, out int x, out int y) {
        x = i >> 1; y = i;
        extracOddBits(x); extracOddBits(y);
      }
      void blockPositionInPatch(int bindx, int blockSize, out int x0, out int y0) {
        int widthInBlocks = int(ceil(float(uDispWidth) / float(blockSize)));
        int temp = int(mod(float(bindx), float(widthInBlocks)));
        x0 = temp * blockSize;
        y0 = int(floor(float(bindx) / float(widthInBlocks))) * blockSize;
      }
      ivec2 indexToPixel(int idx, int pixelsInBlock, int blockIdxStart, int totalBlocksInPatch) {
        int blockIdx = int(floor(float(idx) / float(pixelsInBlock))) + blockIdxStart;
        int indexWithinBlock = int(mod(float(idx), float(pixelsInBlock)));
        // Reverse packing (asve_packing_method==1) reverses block + in-block order over the FULL
        // patch block count. Forward packing (0) addresses blocks directly. Controlled by the param.
        if (uPackingMethod == 1) {
          blockIdx = totalBlocksInPatch - 1 - blockIdx;
          indexWithinBlock = pixelsInBlock - 1 - indexWithinBlock;
        }
        int x0, y0; blockPositionInPatch(blockIdx, 1 << uLog2BlockSize, x0, y0);
        int x1, y1; computeMorton2D(indexWithinBlock, x1, y1);
        return ivec2(x0 + x1, y0 + y1);
      }
      // ---- Universal dIdx evaluator (generated, loop-free, static-indexed) ----
      ${didxGLSL}
      // ---- Per-level nlerp normal evaluator (displacement direction) ----
      ${normGLSL}
      ` : ""}

      // Signed displacement from a displacement texel. CPU path: mapDisp.r is the normalized code
      // (subtract the 0.5 midpoint). Raw path: mapDisp holds the decoded frame's luma, so recover
      // the code with the calibration affine, normalize by 2^bitDepth, then subtract the midpoint.
      float _dispFromTexel(vec4 t) {
        if (uDispRaw == 1) {
          float luma = (t.r + t.g + t.b) / 3.0;   // neutral chroma: R=G=B=luma
          float maxCode = 1.0 / uDispNorm - 1.0;
          // Round to the nearest integer code (matches the CPU extractor) so fp16 sampling noise
          // doesn't leak into the displacement; then normalize and subtract the midpoint.
          float code = clamp(floor(luma * uCalScale + uCalOffset + 0.5), 0.0, maxCode);
          return code * uDispNorm - 0.5;
        }
        return t.r - 0.5;
      }

      // Signed displacement for this vertex. Proper mode reads the V-DMC packed pixel via the
      // op-interpreter (vertex-index space); simple mode samples at the interpolated UV.
      float sampleDisplacement(vec2 uv)
      {
      ${hasProperDisp ? `
        if (uUseProperDisp == 1) {
          // Cumulative vertex/edge/triangle counts per subdivision level. Also accumulate the
          // number of displacement BLOCKS this patch actually uses: one or more 64x64 blocks per
          // LoD level (LoD0 has V0 entries, LoD l>=1 has E[l-1] entries). The V-DMC reverse block
          // packing is relative to THIS used-block count \u2014 NOT the full texture size. (The TM
          // reference hardcodes a per-asset 'patchShift' to fake this; deriving the used-block
          // count is the universal, asset-independent equivalent.)
          int V[8], E[8], T[8];
          V[0] = uBaseVertexCount; E[0] = uBaseEdgesCount; T[0] = uBaseTriCount;
          int blockSize     = 1 << uLog2BlockSize;
          int pixelsInBlock = blockSize * blockSize;
          int usedBlocks = 0;
          for (int l = 0; l < 7; l++) {
            if (l < uLodCount) {
              int cnt = (l == 0) ? V[0] : E[l - 1];
              usedBlocks += int(ceil(float(cnt) / float(pixelsInBlock)));
            }
            V[l + 1] = V[l] + E[l];
            E[l + 1] = 2 * E[l] + 3 * T[l];
            T[l + 1] = 4 * T[l];
          }

          int Cg[3]; Cg[0] = int(mP[3].x); Cg[1] = int(mP[3].y); Cg[2] = int(mP[3].z);
          int Eg[3]; Eg[0] = int(mN[3].x); Eg[1] = int(mN[3].y); Eg[2] = int(mN[3].z);
          int tbm = gl_InstanceID;

          int dIdx = computeDIdxRow(int(aMeta.z),
                                    ivec3(Cg[0], Cg[1], Cg[2]),
                                    ivec3(Eg[0], Eg[1], Eg[2]),
                                    tbm, V, E, T);

          int Lv = int(aMeta.y);

          int blockIdxStart = 0;
          for (int l = 0; l < Lv; l++) {
            int cnt = (l == 0) ? V[0] : E[l - 1];
            blockIdxStart += int(ceil(float(cnt) / float(pixelsInBlock)));
          }
          int localIdx = (Lv == 0) ? dIdx : dIdx - V[Lv - 1];

          // Reverse packing reverses over the FULL patch block count (uDispWidth*uDispHeight),
          // not the used-block count; forward packing ignores it.
          int fullBlocks = (uDispWidth * uDispHeight) / pixelsInBlock;
          ivec2 pixelCoord = indexToPixel(localIdx, pixelsInBlock, blockIdxStart, fullBlocks);
          return _dispFromTexel(texelFetch(mapDisp, pixelCoord, 0));
        }
      ` : ""}
        // V-DMC stores a +512 offset (midpoint ~0.5 == zero); subtract 0.5 for signed magnitude.
        return _dispFromTexel(texture(mapDisp, uv));
      }

      void main()
      {
        mat3 P = mat3(mP[0].xyz, mP[1].xyz, mP[2].xyz);
        mat3 N = mat3(mN[0].xyz, mN[1].xyz, mN[2].xyz);

        // UV is the barycentric blend of the per-corner channels. We blend ONLY the xyz/w of
        // columns 0-2 (via mat3 / dot with the barycentric position), never the full mat4*vec4:
        // in proper mode column 3 carries packed corner/edge indices that must not leak in.
        vUv = vec2(dot(vec3(mP[0].w, mP[1].w, mP[2].w), position),
                   dot(vec3(mN[0].w, mN[1].w, mN[2].w), position));

        // Base surface before displacement.
        //   midpoint (0): flat linear barycentric interpolation of the 3 base-triangle corners,
        //                 i.e. exactly the V-DMC midpoint-subdivided position the displacements
        //                 were measured against.
        //   quadratic (1): degree-2 Bezier triangle = V-DMC NORMAL subdivision (method 2) surface.
        vec3 pBase = (uSubdivMode == 1) ? _normal(position, P, N) : (P * position);

        // Displacement direction. Proper mode: per-level nlerp of base normals along the
        // subdivision recipe (== decoder interpolateSubdivision). Smooth path: barycentric blend.
        vec3 nDir = ${hasProperDisp ? "normalize(nlerpNormalRow(int(aMeta.z), N[0], N[1], N[2]))" : "normalize(N * position)"};

        float d = sampleDisplacement(vUv);
        vec3 pos = pBase + nDir * d * dispScale * uDispUnit;

        vNormal  = normalize(normalMatrix * nDir);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
      }`,
    fragmentShader: `
    precision highp float;

    in vec2 vUv;
    in vec3 vNormal;

    uniform sampler2D mapTexture;
    uniform int uTexRaw;
    uniform vec3 lightDir;
    uniform vec3 ambientColor;

    out vec4 outColor;

    void main() 
    {
      vec3  N   = normalize(vNormal);
      vec3  L   = normalize(lightDir);
      float diff = max(dot(N, L), 0.0);

      // Raw GPU-direct colour texture is uploaded top-left (UNPACK_FLIP_Y is unreliable for
      // VideoFrame across drivers), so flip V here to match the CanvasTexture (flipY) convention.
      vec2  texUv  = (uTexRaw == 1) ? vec2(vUv.x, 1.0 - vUv.y) : vUv;
      vec3  albedo = texture(mapTexture, texUv).rgb;
      if (uTexRaw == 1) {
        // Raw GPU-direct colour texture is sRGB-encoded; decode to linear (the CPU CanvasTexture
        // path gets this from its sRGB upload). Accurate sRGB EOTF.
        albedo = mix(albedo / 12.92, pow((albedo + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), albedo));
      }

      float ambient = ambientColor.r;
      vec3  colorLinear = albedo * (ambient + (1.0 - ambient) * diff);

      // Custom ShaderMaterial output is not auto-encoded; encode linear->sRGB ourselves.
      vec3  colorSrgb = pow(colorLinear, vec3(1.0 / 2.2));

      outColor = vec4(colorSrgb, 1.0);
    }`
  });
  const mesh = new InstancedMesh(inst, mat, count);
  mesh.frustumCulled = false;
  return mesh;
}

// src/VDMCMeshStream.js
var VDMCMeshStream = class {
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
    this.onLog = opts.onLog || (() => {
    });
    this.onReady = null;
    this.onMode = null;
    this.onFrame = null;
    this.onComplete = null;
    this._geometryQueue = /* @__PURE__ */ new Map();
    this._textureQueue = /* @__PURE__ */ new Map();
    this._dispQueue = /* @__PURE__ */ new Map();
    this._frames = /* @__PURE__ */ new Map();
    this._videoDecoders = [];
    this._emittedCount = 0;
    this._mode = "pending";
    this._stats = { base: 0, tex: 0, disp: 0, full: 0 };
    this._baseComplete = false;
    this._completeFired = false;
    this._videoStreamsExpected = 0;
    this._videoStreamsDone = 0;
    this._initDecoder();
  }
  // ------------------------------------------------------------------- Public API
  /** Decode + render a .vmesh from a URL string or an in-memory Uint8Array. */
  async load(urlOrBytes) {
    if (typeof urlOrBytes === "string") return this.loadUrl(urlOrBytes);
    return this.loadBitstream(urlOrBytes);
  }
  /** Fetch a .vmesh URL and decode it progressively as chunks arrive. */
  async loadUrl(url) {
    this.onLog(`Fetching ${url}\u2026`);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    return this.attachStream(resp);
  }
  /** Decode an in-memory Uint8Array bitstream. */
  async loadBitstream(bitstream, sourceLabel = "bitstream") {
    this._resetState();
    const codec = await WebVideoDecoder.pickSupportedCodec();
    this._mode = codec ? "full" : "basemesh";
    this.onLog(`WebCodecs HEVC ${codec ? "supported (" + codec + ")" : "NOT supported \u2014 base-mesh fallback"}`);
    this.onLog(`Decoding ${sourceLabel} (${bitstream.length} bytes), mode=${this._mode}`);
    this.onMode?.(this._mode);
    if (this._mode === "full") WebVideoDecoder.warmupCalibration(this.renderer);
    this._decoder.decode(bitstream);
  }
  /** Feed a bitstream packet or chunk (Uint8Array, ArrayBuffer, or Blob). */
  async feed(chunk, label = "packet") {
    if (!chunk) return;
    if (typeof Blob !== "undefined" && chunk instanceof Blob) {
      chunk = new Uint8Array(await chunk.arrayBuffer());
    } else if (chunk instanceof ArrayBuffer) {
      chunk = new Uint8Array(chunk);
    } else if (chunk.buffer && !(chunk instanceof Uint8Array)) {
      chunk = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    }
    if (!(chunk instanceof Uint8Array) || chunk.length === 0) return;
    if (this._mode === "pending") {
      const codec = await WebVideoDecoder.pickSupportedCodec();
      this._mode = codec ? "full" : "basemesh";
      this.onLog(`WebCodecs HEVC ${codec ? "supported (" + codec + ")" : "NOT supported \u2014 base-mesh fallback"}`);
      this.onMode?.(this._mode);
      if (this._mode === "full") WebVideoDecoder.warmupCalibration(this.renderer);
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
    const ws = typeof wsOrUrl === "string" ? new WebSocket(wsOrUrl) : wsOrUrl;
    ws.binaryType = "arraybuffer";
    ws.addEventListener("message", (evt) => {
      if (evt.data) this.feed(evt.data, "ws-packet");
    });
    ws.addEventListener("close", () => this.endStream());
    ws.addEventListener("error", (err) => console.error("[VDMCMeshStream] WebSocket error:", err));
    return ws;
  }
  /**
   * Stream packets from a WHATWG ReadableStream or Response object (e.g. fetch response body).
   * @param {ReadableStream|Response} streamOrResponse
   */
  async attachStream(streamOrResponse) {
    this._resetState();
    const stream = streamOrResponse && streamOrResponse.body ? streamOrResponse.body : streamOrResponse;
    if (!stream || typeof stream.getReader !== "function") {
      throw new Error("attachStream requires a ReadableStream or Response object");
    }
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) await this.feed(value, "chunk");
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
  get frameCount() {
    return this._frames.size;
  }
  /** Current render mode: 'pending' | 'full' | 'basemesh'. */
  get mode() {
    return this._mode;
  }
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
    for (const d of this._videoDecoders) {
      try {
        d.destroy();
      } catch (_) {
      }
    }
    this._videoDecoders = [];
    this._streamChunks = [];
    this._streamEnded = false;
    this._emittedCount = 0;
    this._mode = "pending";
    this._stats.base = this._stats.tex = this._stats.disp = this._stats.full = 0;
    this._baseComplete = false;
    this._completeFired = false;
    this._videoStreamsExpected = 0;
    this._videoStreamsDone = 0;
  }
  // --- Materials ---
  _fallbackMaterial() {
    return new THREE2.MeshStandardMaterial({
      color: 6333946,
      side: THREE2.DoubleSide,
      flatShading: false,
      metalness: 0,
      roughness: 0.8
    });
  }
  // --- Geometry / textures ---
  // Build a welded position+uv BufferGeometry from the C++ base-mesh streams.
  _buildBaseGeometry({ positions, indices, uvs, uvIndices }) {
    const geo = new THREE2.BufferGeometry();
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
      geo.setAttribute("position", new THREE2.Float32BufferAttribute(outPos, 3));
      if (outUv) geo.setAttribute("uv", new THREE2.Float32BufferAttribute(outUv, 2));
    } else {
      geo.setAttribute("position", new THREE2.Float32BufferAttribute(positions, 3));
      if (uvs && uvs.length > 0) geo.setAttribute("uv", new THREE2.Float32BufferAttribute(uvs, 2));
    }
    geo.computeVertexNormals();
    geo.computeBoundingBox();
    geo.userData.baseData = { positions, indices, uvs, uvIndices };
    return geo;
  }
  // ------------------------------------------------------------ Build pipeline
  // A frame becomes renderable when:
  //   full mode     — geometry + texture + displacement are all present;
  //   basemesh mode — geometry is present.
  // Each frame is emitted to onFrame exactly once.
  _tryBuildFrame(fid) {
    if (this._frames.has(fid)) return;
    const geo = this._geometryQueue.get(fid);
    if (!geo) return;
    if (this._mode === "full") {
      const texEntry = this._textureQueue.get(fid);
      const dispEntry = this._dispQueue.get(fid);
      if (!texEntry || !dispEntry) return;
      let mesh = null;
      try {
        const dispParams = this._decoder.dispParams ? this._decoder.dispParams.get(fid) : null;
        const subdiv = dispParams && dispParams.subdivIterationCount || this.SUBDIV_LEVEL;
        mesh = SubdivideMesh(geo, texEntry.texture, dispEntry.texture, subdiv, this.WIREFRAME, dispParams);
        const hasProper = !!(dispParams && dispParams.edgeTable);
        const u = mesh.material.uniforms;
        const uDispUnit = u.uDispUnit.value || 1;
        const refScale = dispParams && dispParams.iscale && dispParams.iscale[0] || 1;
        const properScale = hasProper ? Math.pow(2, dispParams.geomBitDepth) * refScale / uDispUnit : 1;
        u.dispScale.value = this.DISP_SCALE * properScale;
        const cal = dispEntry.cal || {};
        const bd = cal.bitDepth != null ? cal.bitDepth : dispParams && dispParams.geomBitDepth || 10;
        u.uDispRaw.value = 1;
        u.uCalScale.value = cal.scaleY != null ? cal.scaleY : 1;
        u.uCalOffset.value = cal.offsetY != null ? cal.offsetY : 0;
        u.uDispNorm.value = 1 / Math.pow(2, bd);
        u.uTexRaw.value = 1;
        this._textureQueue.delete(fid);
        this._dispQueue.delete(fid);
        this._stats.full++;
        this._emitFrame(fid, geo, mesh, dispParams, texEntry.previewImage, dispEntry.previewImage);
      } catch (err) {
        console.error(`[VDMCMeshStream] frame ${fid}: SubdivideMesh failed`, err);
      }
    } else if (this._mode === "basemesh") {
      const mesh = new THREE2.Mesh(geo, this._fallbackMaterial());
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
        mesh.geometry?.dispose?.();
        mesh.material?.dispose?.();
        geo.dispose?.();
      }
    };
    this._frames.set(fid, frame);
    this.onFrame?.(frame);
  }
  _switchToBaseMeshMode(reason) {
    if (this._mode === "basemesh") return;
    this.onLog(`Falling back to base-mesh rendering (${reason})`);
    this._mode = "basemesh";
    this.onMode?.("basemesh");
    for (const fid of this._geometryQueue.keys()) this._tryBuildFrame(fid);
  }
  // ------------------------------------------------------------ Decoder wiring
  _initDecoder() {
    const decoder = new VDMCDecoder();
    this._decoder = decoder;
    decoder.onReady = () => {
      this.onLog("Decoder worker ready");
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
      if (this._mode !== "full") return;
      this._videoStreamsExpected++;
      const queue = streamType === "texture" ? this._textureQueue : this._dispQueue;
      const decOpts = {
        renderer: this.renderer,
        ringSize: this.RING_SIZE,
        enablePreviews: () => this.enablePreviews
      };
      const dec = new WebVideoDecoder(decOpts);
      this._videoDecoders.push(dec);
      const runDecode = () => dec.decode(bitstream, frameCount, firstFrameId, (fid, payload) => {
        queue.set(fid, payload);
        if (streamType === "texture") this._stats.tex++;
        else this._stats.disp++;
        this._tryBuildFrame(fid);
      }, streamType).then((ok) => {
        if (!ok) this._switchToBaseMeshMode(`${streamType} HEVC decode unavailable`);
        else this.onLog(`${streamType} decode finished`);
      }).catch((err) => {
        console.error(`[VDMCMeshStream] ${streamType} decode error`, err);
        this._switchToBaseMeshMode(`${streamType} decode error`);
      }).finally(() => {
        this._videoStreamsDone++;
        this._maybeComplete();
      });
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
    if (this._mode === "full" && this._videoStreamsDone < this._videoStreamsExpected) return;
    this._completeFired = true;
    console.log(`[VDMCMeshStream][stats] base=${this._stats.base} tex=${this._stats.tex} disp=${this._stats.disp} full=${this._stats.full} mode=${this._mode}`);
    this.onComplete?.({ frameCount: this._frames.size });
  }
};

// src/VDMCPlayer.js
import * as THREE3 from "three";
var VDMCPlayer = class {
  /**
   * @param {import('./VDMCMeshStream.js').VDMCMeshStream} stream
   * @param {object} opts
   * @param {THREE.Object3D} opts.container   Host container the active frame mesh is parented to.
   * @param {number} [opts.targetFps=30]
   * @param {boolean} [opts.autoPlay=true]    Start looping automatically once decode completes.
   * @param {boolean} [opts.loop=true]        Loop automatically on reaching the last frame.
   */
  constructor(stream, { container, targetFps = 30, autoPlay = true, loop = true } = {}) {
    if (!container) throw new Error("VDMCPlayer requires a { container } THREE.Object3D");
    this.stream = stream;
    this.container = container;
    this.FRAME_INTERVAL = 1e3 / targetFps;
    this.autoPlay = autoPlay;
    this.loop = loop;
    this._frames = [];
    this._currentIndex = -1;
    this._activeMesh = null;
    this._isPlaying = false;
    this._lastFrameTime = 0;
    this._decodeComplete = false;
    this.onFrameCounter = null;
    this.onFirstFrame = null;
    this.onShow = null;
    this.onComplete = null;
    this.onEnded = null;
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
  play() {
    if (this._frames.length > 0) this._isPlaying = true;
  }
  pause() {
    this._isPlaying = false;
  }
  togglePlay() {
    this._isPlaying = !this._isPlaying && this._frames.length > 0;
    return this._isPlaying;
  }
  /** Pause and jump `delta` frames (wraps around). Used by the transport step buttons. */
  step(delta) {
    if (this._frames.length === 0) return;
    this.pause();
    const n = this._frames.length;
    this.show(((this._currentIndex + delta) % n + n) % n);
  }
  stepForward() {
    this.step(1);
  }
  stepBackward() {
    this.step(-1);
  }
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
  get playing() {
    return this._isPlaying;
  }
  get frameCount() {
    return this._frames.length;
  }
  get currentIndex() {
    return this._currentIndex;
  }
  /** The currently displayed frame, or null. */
  get currentFrame() {
    return this._frames[this._currentIndex] || null;
  }
  _updateCounter() {
    if (!this.onFrameCounter) return;
    if (this._frames.length === 0) {
      this.onFrameCounter("\u2014");
      return;
    }
    const pos = this._currentIndex >= 0 ? this._currentIndex + 1 : 0;
    const suffix = this._decodeComplete ? ` (${this.stream.mode})` : " (building\u2026)";
    this.onFrameCounter(`Frame ${pos}/${this._frames.length}${suffix}`);
  }
};

// src/VDMCMesh.js
import * as THREE4 from "three";
var VDMCMesh = class extends THREE4.Group {
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
    this.type = "VDMCMesh";
    this.stream = new VDMCMeshStream({
      renderer: opts.renderer || null,
      subdivLevel: opts.subdivLevel ?? 3,
      dispScale: opts.dispScale ?? 1,
      wireframe: opts.wireframe ?? false,
      ringSize: opts.ringSize ?? 8,
      enablePreviews: opts.enablePreviews ?? true,
      onLog: opts.onLog
    });
    this.player = new VDMCPlayer(this.stream, {
      container: this,
      targetFps: opts.fps ?? opts.targetFps ?? 30,
      autoPlay: opts.autoPlay ?? true,
      loop: opts.loop ?? true
    });
    this._listeners = /* @__PURE__ */ new Map();
    this._wireEvents();
    if (opts.src) {
      this.load(opts.src);
    }
  }
  // ------------------------------------------------------------------- Event Emitter
  /** Subscribe to events ('ready', 'mode', 'firstframe', 'frame', 'ended', 'complete'). */
  on(event, callback) {
    if (!this._listeners.has(event)) this._listeners.set(event, /* @__PURE__ */ new Set());
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
      try {
        cb(...args);
      } catch (err) {
        console.error(`[VDMCMesh] Event '${event}' handler error:`, err);
      }
    }
  }
  _wireEvents() {
    this.stream.onReady = () => this.emit("ready");
    this.stream.onMode = (mode) => this.emit("mode", mode);
    this.player.onFirstFrame = (frame) => this.emit("firstframe", frame);
    this.player.onShow = (index, frame) => this.emit("frame", index, frame);
    this.player.onComplete = (frameCount) => this.emit("complete", frameCount);
    this.player.onEnded = () => this.emit("ended");
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
  play() {
    this.player.play();
  }
  pause() {
    this.player.pause();
  }
  togglePlay() {
    return this.player.togglePlay();
  }
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
  stepForward() {
    this.player.stepForward();
  }
  stepBackward() {
    this.player.stepBackward();
  }
  seek(index) {
    this.player.show(index);
  }
  // ------------------------------------------------------------------- Media Properties
  get playing() {
    return this.player.playing;
  }
  get currentIndex() {
    return this.player.currentIndex;
  }
  get frameCount() {
    return this.player.frameCount;
  }
  get currentFrame() {
    return this.player.currentFrame;
  }
  get mode() {
    return this.stream.mode;
  }
  get loop() {
    return this.player.loop;
  }
  set loop(v) {
    this.player.loop = v;
  }
  get fps() {
    return 1e3 / this.player.FRAME_INTERVAL;
  }
  set fps(v) {
    this.player.FRAME_INTERVAL = 1e3 / v;
  }
  get dispScale() {
    return this.stream.DISP_SCALE;
  }
  set dispScale(v) {
    this.stream.setDispScale(v);
  }
  get wireframe() {
    return this.stream.WIREFRAME;
  }
  set wireframe(v) {
    this.stream.setWireframe(v);
  }
  get enablePreviews() {
    return this.stream.enablePreviews;
  }
  set enablePreviews(v) {
    this.stream.enablePreviews = v;
  }
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
};
export {
  VDMCMesh,
  VDMCMeshStream,
  VDMCPlayer
};
