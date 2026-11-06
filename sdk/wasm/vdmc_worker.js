/**
 * © 2026 Nokia
 *
 * Licensed under the 5G-MAG Public License (v1.0)
 */

// vdmc_worker.js - Dedicated Web Worker for the WASM base-mesh decoder.

self.addEventListener('error', (e) => {
  postMessage({ type: 'workerError', message: e.message, filename: e.filename, lineno: e.lineno });
});
self.addEventListener('unhandledrejection', (e) => {
  postMessage({ type: 'workerError', message: 'unhandledrejection: ' + ((e.reason && e.reason.message) || e.reason) });
});

(async () => {
  try {
    const vdmc_decoder = (await import('./vdmc_decode.js')).default;
    const Module = await vdmc_decoder();
    let baseMeshCount = 0;
    let videoStreamCount = 0;

    // --- Global frameId remapping across GOFs ---------------------------------
    let gofFrameBase = 0;             // global offset added to per-GOF ids
    let framesInCurrentGof = 0;       // max(frameIndex)+1 seen in current GOF
    let sawBaseMeshSinceVideoBurst = false;

    const beginGofIfNewVideoBurst = () => {
      if (sawBaseMeshSinceVideoBurst) {
        gofFrameBase += framesInCurrentGof;
        framesInCurrentGof = 0;
        sawBaseMeshSinceVideoBurst = false;
      }
    };
    const noteFrame = (localFrameId) => {
      if (localFrameId + 1 > framesInCurrentGof) framesInCurrentGof = localFrameId + 1;
      sawBaseMeshSinceVideoBurst = true;
    };

    Module.onDispParams = (frameId,
                           edgeTablePtr, edgeTableLen,
                           baseEdgesCount, baseVertexCount, subdivIterationCount,
                           dispWidth, dispHeight,
                           log2BlockSize, packingMethod, geomBitDepth,
                           oneDimDisplacementFlag, interpolateNormalsFlag,
                           scalePtr, scaleLen,
                           lodCount, dispDimension) => {
      try {
        const bufU32 = Module.HEAPU32.buffer;
        const bufF32 = Module.HEAPF32.buffer;

        const edgeTable = (edgeTablePtr && edgeTableLen > 0)
          ? new Uint32Array(bufU32, edgeTablePtr, edgeTableLen).slice()
          : new Uint32Array(0);
        
        const iscale = (scalePtr && scaleLen > 0)
          ? new Float32Array(bufF32, scalePtr, scaleLen).slice()
          : new Float32Array(0);
        
        const params = {
          edgeTable,
          baseEdgesCount,
          baseVertexCount,
          subdivIterationCount,
          dispWidth,
          dispHeight,
          log2BlockSize,
          packingMethod,
          geomBitDepth,
          oneDimDisplacementFlag,
          interpolateNormalsFlag,
          iscale,
          lodCount,
          dispDimension
        };
        
        const transferable = [];
        if (edgeTable.length) transferable.push(edgeTable.buffer);
        if (iscale.length) transferable.push(iscale.buffer);

        noteFrame(frameId);
        const globalFrameId = gofFrameBase + frameId;
        postMessage({ type: 'dispParams', frameId: globalFrameId, params }, transferable);
      } catch (err) {
        console.error('Worker: Exception in onDispParams callback:', err);
      }
    };
    
    Module.onBaseMesh = (frameId, posPtr, posLen, idxPtr, idxLen, uvPtr, uvLen, uvIdxPtr, uvIdxLen) => {
      try {
        const bufF32 = Module.HEAPF32.buffer;
        const bufU32 = Module.HEAPU32.buffer;

        const positions = new Float32Array(bufF32, posPtr, posLen).slice();
        const indices = (idxPtr && idxLen > 0) ? new Uint32Array(bufU32, idxPtr, idxLen).slice() : new Uint32Array(0);
        const uvs = (uvPtr && uvLen > 0) ? new Float32Array(bufF32, uvPtr, uvLen).slice() : new Float32Array(0);
        const uvIndices = (uvIdxPtr && uvIdxLen > 0) ? new Uint32Array(bufU32, uvIdxPtr, uvIdxLen).slice() : new Uint32Array(0);

        const transferable = [positions.buffer];
        if (indices.length) transferable.push(indices.buffer);
        if (uvs.length) transferable.push(uvs.buffer);
        if (uvIndices.length) transferable.push(uvIndices.buffer);

        baseMeshCount++;
        noteFrame(frameId);
        const globalFrameId = gofFrameBase + frameId;
        postMessage(
          { type: 'baseMesh', frameId: globalFrameId, positions, indices, uvs, uvIndices },
          transferable
        );
      } catch (err) {
        console.error('Worker: Exception in onBaseMesh callback:', err);
      }
    };

    Module.enqueueVideo = (streamType, bitstream, frameCount, firstFrameId) => {
      try {
        const kind = streamType === 0 ? 'displacement' : 'texture';
        let bytes = bitstream;
        if (bytes.byteOffset !== 0 || bytes.byteLength !== bytes.buffer.byteLength) {
          bytes = bytes.slice();
        }
        videoStreamCount++;
        beginGofIfNewVideoBurst();
        const globalFirstFrameId = gofFrameBase + (firstFrameId | 0);
        console.log(`[frameid][decoder] forwarding ${kind} stream: firstFrameId=${globalFirstFrameId} (gof-local ${firstFrameId}, base ${gofFrameBase}), ${frameCount} frames (${bytes.byteLength} bytes)`);
        postMessage(
          { type: 'videoStream', streamType: kind, bitstream: bytes, frameCount, firstFrameId: globalFirstFrameId },
          [bytes.buffer]
        );
      } catch (err) {
        console.error('Worker: Exception in enqueueVideo callback:', err);
      }
    };

    onmessage = async (e) => {
      if (e.data.type === 'decode') {
        const data = e.data.payload;
        baseMeshCount = 0;
        videoStreamCount = 0;
        gofFrameBase = 0;
        framesInCurrentGof = 0;
        sawBaseMeshSinceVideoBurst = false;
        try {
          Module.FS.writeFile('/input.vmesh', data);
          console.log('Worker: Starting callMain...');
          const ret = Module.callMain(['--compressed=input.vmesh']);
          if (ret && typeof ret.then === 'function') {
            await ret;
          }
        } catch (err) {
          if (err instanceof Error && err.name === 'ExitStatus') {
            console.log('Worker: Decoder finished with status', err.status);
          } else {
            console.error('Worker: Error during decoding:', err);
          }
        }
        postMessage({ type: 'complete', totalFrames: baseMeshCount, videoStreams: videoStreamCount });
      }
    };

    postMessage({ type: 'ready' });
  } catch (err) {
    postMessage({ type: 'workerError', message: 'worker init failed: ' + (err && err.message || err) });
  }
})();
