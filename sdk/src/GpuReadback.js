/**
 * © 2026 Nokia
 *
 * Licensed under the 5G-MAG Public License (v1.0)
 */

// GpuReadback.js — portable GPU→CPU pixel readback in the app's THREE.WebGLRenderer context, for
// ONE-TIME calibration and offline verification only (never per-frame).
//
// Renders a caller-supplied draw into an RGBA8 target and reads the bytes back. RGBA8 is the only
// render+readback format that works everywhere including Mali: float render targets (RGBA16F /
// RGBA32F) raise INVALID_OPERATION on ANGLE *and* Mali even when the framebuffer reports complete.
// Callers therefore pack their data into bytes themselves (e.g. a hi/lo code, or float32 bit
// patterns via floatBitsToUint). The renderer's GL state is restored after each capture.

export class GpuReadback {
  /** @param {THREE.WebGLRenderer} renderer  Owns the WebGL2 context the readback runs in. */
  constructor(renderer) {
    if (!renderer) throw new Error('GpuReadback requires a THREE.WebGLRenderer');
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
      gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.SCISSOR_TEST); gl.disable(gl.CULL_FACE);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      while (gl.getError() !== gl.NO_ERROR) { /* drain */ }

      draw(gl);

      const bytes = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
      if (gl.getError() !== gl.NO_ERROR) return null;
      return bytes;
    } catch (_) {
      return null;
    } finally {
      try { gl.bindFramebuffer(gl.FRAMEBUFFER, null); } catch (_) {}
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(tex);
      this.renderer.resetState();   // restore Three's cached GL state for the next scene render
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
      const mk = (t, s) => { const sh = gl.createShader(t); gl.shaderSource(sh, s); gl.compileShader(sh); if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh)); return sh; };
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
      const loc = gl.getAttribLocation(prog, 'p');
      gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

      inTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, inTex);
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      while (gl.getError() !== gl.NO_ERROR) { /* drain */ }
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, frame);   // 10-bit-capable
      if (gl.getError() !== gl.NO_ERROR) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame); // 8-bit fallback
        if (gl.getError() !== gl.NO_ERROR) return null;
      }

      return this.toBytes(w, h, (g) => {
        g.useProgram(prog);
        g.bindVertexArray(vao);
        g.activeTexture(g.TEXTURE0); g.bindTexture(g.TEXTURE_2D, inTex);
        g.uniform1i(g.getUniformLocation(prog, 'u_video'), 0);
        g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
      });
    } catch (e) {
      console.warn('[GpuReadback] shadeFrame failed:', (e && e.message) || e);
      return null;
    } finally {
      try { gl.bindVertexArray(null); } catch (_) {}
      gl.deleteTexture(inTex); gl.deleteBuffer(quad); gl.deleteVertexArray(vao); gl.deleteProgram(prog);
    }
  }
}
