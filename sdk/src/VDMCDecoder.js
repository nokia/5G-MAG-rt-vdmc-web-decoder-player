/**
 * © 2026 Nokia
 *
 * Licensed under the 5G-MAG Public License (v1.0)
 */

// VDMCDecoder.js - Main thread wrapper for the WASM base-mesh decoder worker.

export class VDMCDecoder {
  constructor() {
    this.onReady = null;        // ()
    this.onBaseMesh = null;     // (frameId, { positions, indices, uvs, uvIndices })
    this.onVideoStream = null;  // (streamType, bitstream, frameCount, firstFrameId)
    this.onComplete = null;     // (totalFrames)

    // Storage for displacement parameters, keyed by frameId
    this.dispParams = new Map();  // frameId -> { edgeTable, baseEdgesCount, ..., iscale }

    // Spawn dedicated WASM decoder worker
    // Resolves the same from src/ and from dist/, which are both one level under sdk/.
    this.worker = new Worker(new URL('../wasm/vdmc_worker.js', import.meta.url), { type: 'module' });

    // Surface worker-side failures on the main thread (worker console is not forwarded).
    this.worker.onerror = (e) => {
      console.error('VDMCDecoder worker error:', e.message, `@ ${e.filename}:${e.lineno}`);
    };
    this.worker.onmessageerror = (e) => {
      console.error('VDMCDecoder worker messageerror:', e);
    };

    this.worker.onmessage = (e) => {
      const msg = e.data;
      switch (msg.type) {
        case 'ready':
          this.onReady?.();
          break;
        case 'dispParams':
          // Store params keyed by frameId (emitted BEFORE baseMesh for the same frameId)
          this.dispParams.set(msg.frameId, msg.params);
          break;
        case 'baseMesh':
          this.onBaseMesh?.(msg.frameId, {
            positions: msg.positions,
            indices: msg.indices,
            uvs: msg.uvs,
            uvIndices: msg.uvIndices,
          });
          break;
        case 'videoStream':
          this.onVideoStream?.(msg.streamType, msg.bitstream, msg.frameCount, msg.firstFrameId);
          break;
        case 'complete':
          this.onComplete?.(msg.totalFrames);
          break;
        case 'workerError':
          console.error('VDMCDecoder worker:', msg.message, msg.filename ? `@ ${msg.filename}:${msg.lineno}` : '');
          break;
        default:
          break;
      }
    };
  }

  decode(data) {
    const arr = data instanceof Uint8Array ? data : new Uint8Array(data);
    // Clear stale displacement params from any previous decode so frameId reuse
    // (a new file starts again at 0) can't read another load's parameters.
    this.dispParams.clear();
    // Copy before transfer so callers can reuse the original bitstream buffer.
    const payload = new Uint8Array(arr);
    this.worker.postMessage({ type: 'decode', payload }, [payload.buffer]);
  }
}
