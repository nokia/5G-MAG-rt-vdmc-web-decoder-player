# V-DMC feature set in use

What subset of **V-DMC (ISO/IEC 23090-29, TMM17 v17.0)** this project actually exercises,
derived from [`verification/encoder.cfg`](../verification/encoder.cfg) plus the command-line
options added by [`verification/encode-decode.mjs`](../verification/encode-decode.mjs).

Defaults below are the reference encoder's built-in defaults (`encode.exe --help`, TMM17 v17.0).
**Only settings that differ from those defaults are called out**; everything else runs on the
reference default and is listed only as context for which coding tools are active.

---

## 1. Non-default settings

These are the deliberate deviations from the reference encoder defaults. They exist either to
match what the browser SDK's GPU shader can reconstruct, or to fit the football test sequence.

### 1.1 Required for web-SDK compatibility

| Option | Default | Used | Effect |
|--------|---------|------|--------|
| `transformMethod` | `1` (linear lifting) | **`0`** | No wavelet/linear-lifting transform. One displacement scale for all LoDs, matching the shader's plain `d · scale` reconstruction. Also disables per-LoD quantization and the lifting offset. |
| `displacementReversePacking` | `1` | **`0`** | Displacement blocks packed forward. Reverse packing reverses block order over the full patch block count, which the GPU packer does not implement. |
| `InverseQuantizationOffsetFlag` | `1` | **`0`** | Removes the `liftingBias` offset from inverse quantization; the shader applies a plain signed `-0.5` offset. |
| `interpolateSubdividedNormalsFlag` | `0` | **`1`** | Displacements measured against barycentric-interpolated base-corner normals instead of recomputed subdivided normals — matches the shader's `normalize(N · bary)`. |
| `log2GeometryVideoBlockSize` | `6` (64×64) | **`5`** (32×32) | Smaller displacement packing blocks. |

### 1.2 Sequence / quality tuning

| Option | Default | Used | Effect |
|--------|---------|------|--------|
| `texCoordBitDepth` | `12` | **`13`** | Input UVs are pre-quantized to 13 bits (`football_fr%04d_qp12_qt13.obj`). |
| `target` | `0.125` | **`0.03`** | Stronger decimation → smaller base mesh. |
| `baseMeshPositionBitDepth` | `10` | **`11`** | Finer base-mesh position quantization. |
| `baseMeshTexCoordBitDepth` | `8` | **`10`** | Finer base-mesh UV quantization. |
| `liftingQP` | `16,28,28` | **`40,50,50`** | Coarser displacement quantization → larger, more visible displacement steps. |
| `textureVideoWidth` / `Height` | `2048` | **`1024`** | 1K texture atlas. |
| `textureVideoQP` | `8` | **`20`** | Lower-bitrate texture substream. |
| `useOccMapRDO` | `1` | **`0`** | No occupancy-map RDO in HM, so no `_occmap.yuv` is produced (simpler/faster texture pass). |
| `gofMaxSize` | `32` | **`256`** | Whole test clip treated as one group of frames. |
| `analyzeGof` | `0` | **`1`** *(cfg)* | Enabled in the cfg; overridden per run on the command line — `1` for `--inter` (low-delay P-frames), `0` for intra. |

### 1.3 Geometry-parametrization relaxations (intra path)

| Option | Default | Used | Effect |
|--------|---------|------|--------|
| `ai_deformNormalThres` | `0.1` | **`-2.0`** | Normal-deviation gate disabled during initial deformation (any deviation accepted). |
| `ai_deformFlipThres` | `-0.5` | **`-2.0`** | Triangle-normal-flip rejection disabled. |
| `ai_smoothMotion` | `1` | **`0`** | Smoothing applied to vertex positions rather than to motion. |

### 1.4 Supplied on the command line (no meaningful default)

| Option | Value | Notes |
|--------|-------|-------|
| `startFrameIndex`, `frameCount` | per run | `--frame` / `--count`. |
| `minPosition` / `maxPosition` | sequence bbox | Default `0,0,0`; the real quantization box must be passed or dequantization is wrong. |
| `geometryVideoEncoderConfig` | `hm/displacements-ai.cfg` or `-ld.cfg` | Intra vs low-delay. |
| `textureVideoEncoderConfig` | `hm/texture-ai.cfg` or `-ld.cfg` | Intra vs low-delay. |
| `textureVideoEncoderConvertConfig` | `hdrconvert/bgr444toyuv420.cfg` | Colour conversion. |
| `textureVideoDecoderConvertConfig` | `hdrconvert/yuv420tobgr444.cfg` | Colour conversion. |
| `compressed`, `recMesh`, `recMat` | output names | — |

---

## 2. Active coding tools (all at reference defaults)

Listed for completeness — these define which V-DMC tools the stream relies on, and none of them
is overridden.

| Area | Setting | Value | Meaning |
|------|---------|-------|---------|
| Profile | `profileCodecGroupIdc` | `HEVC_Main10` | Video substreams are HEVC Main 10. |
| Displacements | `encodeDisplacements` | `2` | **Video-coded** displacements (not arithmetic-coded). |
| Displacements | `applyOneDimensionalDisplacement` | `1` | 1-D (normal-direction) displacement. |
| Displacements | `displacementQuantizationType` | `0` | DEFAULT (non-adaptive) packing. |
| Displacements | `displacementFillZerosFlag` | `0` | Off. |
| Displacements | `lodPatchesEnable` | `0` | All LoD displacements in one patch. |
| Geometry video | `geometryVideoCodecId` | `HM` | Built-in HM HEVC encoder → WebCodecs-decodable substream. |
| Geometry video | `geometryVideoBitDepth` | `10` | 10-bit displacement video. |
| Geometry video | `displacementVideoChromaFormat` | `1` | YUV 4:2:0. |
| Subdivision | `subdivisionIterationCount` / `ai_subdivIt` | `3` | 3 subdivision levels (LoD 0–3). |
| Subdivision | `sm`, `sml0..2` | `0` | **Midpoint** subdivision. |
| Subdivision | `lodAdaptiveSubdivisionFlag` | `0` | Off. |
| Quantization | `lodDisplacementQuantizationFlag` | `0` | Single QP set, no per-LoD QP. |
| Lifting | `dirlift` | `0` | Directional lifting off. |
| Base mesh | `meshCodecId` | `0` | Default base-mesh codec (MPEG EB; v17.0 renumbered it from `1`). |
| Base mesh | `baseMeshVertexTraversal` | `degree` | Vertex-degree traversal for prediction. |
| Base mesh | `unifyVertices`, `invertOrientation`, `baseMeshDeduplication` | `0` | Off. |
| Atlas | `submeshCount`, `tileCountGeometry`, `textureMapCount` | `1` | Single submesh, single tile, single texture map. |
| Atlas | `zipperingMethod` | `-1` | Zippering deactivated (only relevant with >1 submesh). |
| Texture | `encodeTextureVideo` | `1` | Texture substream present → SDK reaches full displaced+textured mode. |
| Texture | `textureVideoCodecId` | `HM` | HEVC. |
| Texture | `textureParameterizationType` | `0` | UVAtlas (input UVs preserved; ORTHO atlas not used). |
| Texture | `textureTransferEnable` | `1` | Texture transferred onto the reconstructed parametrization. |
| Texture | `textureVideoBitDepth` / `textureInputBitDepth` | `10` / `8` | — |
| Motion | `motionGroupSize` | `16` | Inter path only. |
| Normals | `encodeNormals` | `0` | **Normals are not coded**; the decoder/shader derives them. |
| General | `lossless`, `losslessInter` | `0` | Lossy. |
| Attributes | `attributeExtractionEnable`, `scalableEnableFlag`, `jointTextDisp` | `0` | Off. |

---

## 3. Not exercised

Tools available in TMM17 but unused by this configuration, and therefore not covered by the web
SDK or the verification tests:

- Multi-submesh / multi-tile atlases, submesh segmentation, zippering.
- ORTHO (projection) texture parametrization, patch scaling / temporal stabilization, RAW subpatches.
- Arithmetic-coded displacements (`encodeDisplacements=1`) and no-displacement mode (`0`).
- Linear-lifting transform and all of its sub-tools: adaptive prediction/update weights, valence
  update weights, directional lifting, per-LoD displacement quantization, LoD-adaptive subdivision.
- Non-midpoint subdivision (LOOP / NORMAL / PYTHAG).
- Coded normals (octahedral or otherwise), extra video attributes, scalable texture, joint
  texture+displacement coding.
- Lossless mode, Draco base-mesh codec paths, spatial scalability (`maxLayersMinus1`).
- Metrics tooling (`pcc`, `ibsm`, `pcqm`) — the verification uses its own RMSE comparison instead.
