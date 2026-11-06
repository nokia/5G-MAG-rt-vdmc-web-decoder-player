/**
 * © 2026 Nokia
 *
 * Licensed under the 5G-MAG Public License (v1.0)
 */

/* webVideoDecoder.js — WebCodecs-based HEVC video decoder (main-thread, GPU-direct)
 *
 * Decodes an HEVC (H.265) Annex-B substream with the browser-native WebCodecs `VideoDecoder` and
 * uploads each decoded VideoFrame straight into a bounded GPU texture ring in the app's
 * THREE.WebGLRenderer context — no per-frame CPU readback. It calls back once per frame with a
 * ready-to-sample THREE.Texture (the mesh shader recovers displacement codes inline):
 *
 *   const dec = new WebVideoDecoder({ renderer });        // a THREE.WebGLRenderer is required
 *   const ok = await dec.decode(bitstream, frameCount, firstFrameId, (frameId, payload) => {
 *     // payload: { texture: THREE.Texture, kind: 'texture'|'displacement', width, height, ... }
 *   }, 'texture');
 *
 * `decode()` resolves to `true` when at least one frame was produced, or `false` if WebCodecs
 * HEVC is unsupported / no renderer was given / the stream failed (callers fall back to flat
 * base-mesh rendering).
 */

import { GpuTexRing } from './GpuTexRing.js';
import * as Calib from './rampCalibClip.js';

// Per-frame chunk duration in microseconds (~30fps). Used to encode the V-DMC frameId
// into the EncodedVideoChunk timestamp so it survives the WebCodecs decode and comes back
// on the output VideoFrame.timestamp. This makes frameId independent of output arrival order.
const FRAME_DURATION_US = 33333;

// 10-bit Main10 first (V-DMC displacement + most texture streams are 10-bit), then 8-bit Main,
// across a couple of levels and both sample-entry fourccs.
const HEVC_CODEC_CANDIDATES = [
  'hvc1.2.4.L153.B0',
  'hev1.2.4.L153.B0',
  'hvc1.2.4.L120.90',
  'hvc1.1.6.L153.B0',
  'hev1.1.6.L153.B0',
  'hvc1.1.6.L120.90',
];

class WebVideoDecoder {
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
    this.onFrame = null;        // (frameId, canvas) => void
    this.label = 'video';
    this.pending = [];          // in-flight createImageBitmap/snapshot promises
    this.renderer = opts.renderer || null;   // when set, emit ready THREE.Textures via a GPU ring
    this.ringSize = opts.ringSize || 8;
    this.enablePreviews = opts.enablePreviews ?? false;
    this._texRing = null;       // GpuTexRing (GPU-direct output) when a renderer is given
    this._resolvedCal = null;   // {scaleY, offsetY, maxCode, bitDepth, source} from Calib.resolveCalibration
  }

  // Lazily create this stream's GPU texture ring in the app's context. Both streams use rgba16f
  // (half-float, 10-bit-capable); the colour stream falls back to rgba8 where rgba16f is unavailable.
  _ring() {
    if (!this._texRing) {
      // Texture prefers rgba16f (10-bit, correct on both ANGLE + mobile), then rgba8. rgb10_a2 is
      // NOT used: on ANGLE texImage2D(VideoFrame -> RGB10_A2) uploads garbage without erroring.
      const formats = this.label === 'displacement' ? ['rgba16f'] : ['rgba16f', 'rgba8'];
      const filter = this.label === 'displacement' ? 'nearest' : 'linear';
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
      const needs = !vr || vr.x !== 0 || vr.y !== 0 || vr.width !== cw || vr.height !== ch
        || frame.displayWidth !== cw || frame.displayHeight !== ch;
      if (needs && typeof VideoFrame === 'function') {
        const wrap = new VideoFrame(frame, { visibleRect: { x: 0, y: 0, width: cw, height: ch }, displayWidth: cw, displayHeight: ch });
        return { src: wrap, wrap };
      }
    } catch (_) { /* re-wrap unsupported — use the raw frame */ }
    return { src: frame, wrap: null };
  }

  /**
   * Probe WebCodecs HEVC support and pick a codec string the platform accepts.
   * @returns {Promise<string|null>} a supported codec string, or null if none
   */
  static async pickSupportedCodec() {
    if (typeof VideoDecoder === 'undefined' || typeof VideoDecoder.isConfigSupported !== 'function') {
      return null;
    }
    for (const codec of HEVC_CODEC_CANDIDATES) {
      try {
        const res = await VideoDecoder.isConfigSupported({ codec });
        if (res && res.supported) return codec;
      } catch (_) {
        // try next candidate
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
    return Calib.warmupCalibration(renderer);
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
    this.label = label || 'video';
    this.pending = [];

    const codec = await WebVideoDecoder.pickSupportedCodec();
    if (!codec) {
      console.warn(`[WebVideoDecoder:${this.label}] No supported HEVC codec — WebCodecs HEVC unavailable`);
      return false;
    }
    this.codec = codec;

    console.log(`[WebVideoDecoder:${this.label}] decode: ${bitstream.byteLength} bytes, ${frameCount} frames, codec ${codec}`);

    // GPU-direct is the only path: decoded frames upload straight into the renderer's texture ring.
    if (!this.renderer) {
      console.warn(`[WebVideoDecoder:${this.label}] no THREE.WebGLRenderer — video decode requires one (base-mesh fallback)`);
      return false;
    }

    try {
      this.decoder = new VideoDecoder({
        output: (frame) => this.onOutput(frame),
        error: (err) => this.onError(err),
      });

      // codedWidth/codedHeight intentionally omitted — the in-band SPS drives dimensions,
      // and the C++ side does not forward them.
      const config = { codec, optimizeForLatency: false };
      this.decoder.configure(config);
      this.isConfigured = true;

      // Resolve the device's displacement luma calibration before decoding frames.
      if (this.label === 'displacement') {
        this._resolvedCal = await Calib.resolveCalibration(this.renderer);
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
      try { this.decoder && this.decoder.state !== 'closed' && this.decoder.close(); } catch (_) {}
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
      throw new Error('Decoder not configured');
    }

    // Find all NAL units by scanning for start codes
    const nalUnits = this.splitAnnexB(bitstream);
    console.log(`[WebVideoDecoder] Found ${nalUnits.length} NAL units`);

    if (nalUnits.length === 0) {
      throw new Error('No NAL units found in bitstream');
    }

    // Separate parameter sets from frame data
    const parameterSets = [];
    const frameNALs = [];

    for (const nal of nalUnits) {
      const nalType = this.getNALType(nal.data);
      
      // Parameter sets: VPS(32), SPS(33), PPS(34)
      if (nalType >= 32 && nalType <= 34) {
        parameterSets.push(nal);
        console.log(`[WebVideoDecoder] Found parameter set NAL type ${nalType}`);
      } 
      // Frame NALs: IDR and non-IDR slices
      else if (this.isFrameNAL(nalType)) {
        frameNALs.push(nal);
      }
    }

    // First chunk: parameter sets + first frame (keyframe)
    if (frameNALs.length > 0) {
      const firstFrameNAL = frameNALs[0];
      const keyframeData = this.concatenateNALs([...parameterSets, firstFrameNAL]);

      // Encode the V-DMC frameId in the chunk timestamp (frameId * FRAME_DURATION_US).
      // WebCodecs copies this onto the output VideoFrame.timestamp, letting onOutput recover
      // the exact frameId regardless of the order frames are emitted.
      const keyframeId = this.firstFrameId;
      const keyframeChunk = new EncodedVideoChunk({
        type: 'key',
        data: keyframeData,
        timestamp: keyframeId * FRAME_DURATION_US,
        duration: FRAME_DURATION_US
      });

      this.decoder.decode(keyframeChunk);
      console.log(`[WebVideoDecoder:${this.label}] Fed keyframe chunk: frameId=${keyframeId}, ${keyframeData.byteLength} bytes`);

      // Subsequent frames as delta chunks
      for (let i = 1; i < frameNALs.length; i++) {
        const frameNAL = frameNALs[i];
        const nalType = this.getNALType(frameNAL.data);
        const isKey = this.isKeyFrameNAL(nalType);

        // If this is an IDR frame, include parameter sets again
        let frameData;
        if (isKey) {
          frameData = this.concatenateNALs([...parameterSets, frameNAL]);
        } else {
          frameData = this.concatenateNALs([frameNAL]);
        }

        const frameId = this.firstFrameId + i;
        const chunk = new EncodedVideoChunk({
          type: isKey ? 'key' : 'delta',
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

    // Find all start codes (0x000001 or 0x00000001)
    for (let i = 0; i < bitstream.length - 3; i++) {
      if (bitstream[i] === 0x00 && bitstream[i + 1] === 0x00) {
        if (bitstream[i + 2] === 0x01) {
          // 3-byte start code
          startCodePositions.push({ pos: i, length: 3 });
          i += 2;
        } else if (bitstream[i + 2] === 0x00 && i < bitstream.length - 4 && bitstream[i + 3] === 0x01) {
          // 4-byte start code
          startCodePositions.push({ pos: i, length: 4 });
          i += 3;
        }
      }
    }

    // Extract NAL units between start codes
    for (let i = 0; i < startCodePositions.length; i++) {
      const start = startCodePositions[i].pos + startCodePositions[i].length;
      const end = i + 1 < startCodePositions.length 
        ? startCodePositions[i + 1].pos 
        : bitstream.length;

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
    // HEVC NAL type is in bits 1-6 of first byte
    return (nalData[0] >> 1) & 0x3F;
  }

  /**
   * Check if NAL type is a frame NAL (slice)
   * @param {number} nalType
   * @returns {boolean}
   */
  isFrameNAL(nalType) {
    // TRAIL_N(0), TRAIL_R(1), IDR_W_RADL(19), IDR_N_LP(20), 
    // BLA_W_LP(16), BLA_W_RADL(17), BLA_N_LP(18), CRA_NUT(21)
    return (nalType >= 0 && nalType <= 9) || 
           (nalType >= 16 && nalType <= 21);
  }

  /**
   * Check if NAL type is a keyframe (IDR or BLA)
   * @param {number} nalType
   * @returns {boolean}
   */
  isKeyFrameNAL(nalType) {
    // IDR_W_RADL(19), IDR_N_LP(20), BLA_W_LP(16), BLA_W_RADL(17), BLA_N_LP(18)
    return (nalType >= 16 && nalType <= 20);
  }

  /**
   * Concatenate NAL units with start codes
   * @param {Array<{data: Uint8Array}>} nals
   * @returns {Uint8Array}
   */
  concatenateNALs(nals) {
    const startCode = new Uint8Array([0x00, 0x00, 0x00, 0x01]);
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
    // Recover the frameId from the timestamp we encoded at feed time. This is authoritative
    // and does NOT depend on the order WebCodecs emits frames. Fall back to the sequential
    // counter only if the platform dropped the timestamp.
    const arrivalIndex = this.outputFrameIndex++;
    const tsFrameId = Number.isFinite(frame.timestamp)
      ? Math.round(frame.timestamp / FRAME_DURATION_US)
      : null;
    const frameId = (tsFrameId !== null) ? tsFrameId : (this.firstFrameId + arrivalIndex);

    const expectedSequential = this.firstFrameId + arrivalIndex;
    if (tsFrameId !== null && tsFrameId !== expectedSequential) {
      console.warn(`[WebVideoDecoder:${this.label}] OUT-OF-ORDER output: frameId=${frameId} arrived at position ${arrivalIndex} (sequential would be ${expectedSequential}) — frameId preserved via timestamp`);
    }
    console.log(`[WebVideoDecoder:${this.label}] output frameId=${frameId} (arrival #${arrivalIndex}, ts=${frame.timestamp})`);

    // One-time per stream: log coded vs visible/display geometry + format. A codedSize larger
    // than visibleRect (or a non-zero visibleRect offset) confirms the Edge hardware-decoder
    // padding that caused the "wrong part of texture" crop.
    if (arrivalIndex === 0) {
      const vr = frame.visibleRect;
      console.log(`[WebVideoDecoder:${this.label}] geometry: format=${frame.format} `
        + `coded=${frame.codedWidth}x${frame.codedHeight} `
        + `display=${frame.displayWidth}x${frame.displayHeight} `
        + `visible=${vr ? `${vr.x},${vr.y} ${vr.width}x${vr.height}` : 'n/a'}`);
    }

    const p = (async () => {
      try {
        // The texture/displacement is a CODED atlas (UVs and the displacement packing address the
        // full coded picture, e.g. 1024x1024). Upload the whole coded frame straight into the
        // renderer's ring and emit a ready THREE.Texture; the mesh shader recovers displacement
        // codes inline. No CPU readback. `_fullCoded` corrects frames whose visibleRect crops the
        // atlas (e.g. a conformance window that is meaningless for an atlas).
        const cw = frame.codedWidth, ch = frame.codedHeight;
        if (!cw || !ch) {
          console.warn(`[WebVideoDecoder:${this.label}] frameId=${frameId} has zero coded size (${cw}x${ch}) — skipping`);
          return;
        }
        const { src, wrap } = this._fullCoded(frame, cw, ch);
        const texture = this._ring().upload(src, cw, ch);

        let previewImage = null;
        const isPreviewEnabled = typeof this.enablePreviews === 'function' ? this.enablePreviews() : this.enablePreviews;
        if (isPreviewEnabled) {
          try {
            const cvs = (typeof OffscreenCanvas !== 'undefined')
              ? new OffscreenCanvas(cw, ch)
              : document.createElement('canvas');
            cvs.width = cw;
            cvs.height = ch;
            const ctx = cvs.getContext('2d');
            ctx.drawImage(src, 0, 0, cw, ch);
            previewImage = cvs;
          } catch (e) {
            console.warn(`[WebVideoDecoder:${this.label}] preview snapshot failed:`, e);
          }
        }

        if (wrap) { try { wrap.close(); } catch (_) {} }
        const payload = (this.label === 'displacement')
          ? { texture, kind: 'displacement', cal: this._resolvedCal, width: cw, height: ch, gpu: true, previewImage }
          : { texture, kind: 'texture', width: cw, height: ch, gpu: true, previewImage };
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
        if (this.decoder.state !== 'closed') this.decoder.close();
      } catch (err) {
        console.error(`[WebVideoDecoder:${this.label}] error during destroy:`, err);
      }
      this.decoder = null;
    }
    if (this._texRing) { this._texRing.dispose(); this._texRing = null; }
    this.isConfigured = false;
    this.outputFrameIndex = 0;
    this.pending = [];
  }
}

export { WebVideoDecoder };
