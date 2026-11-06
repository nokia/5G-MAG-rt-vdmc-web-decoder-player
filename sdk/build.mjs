/**
 * © 2026 Nokia
 *
 * Licensed under the 5G-MAG Public License (v1.0)
 */

import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sdkDir = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(sdkDir, 'src');

// Standalone: inline three, the addon utils, the decoder worker and the WASM binary so the
// bundle is a single self-contained file with no bare imports and no runtime fetch — required
// for offline hosts (e.g. an Android WebView) and for the module worker, which cannot resolve
// a bare "three".
const standalone = process.argv.includes('--standalone');

const outputFile = resolve(sdkDir, 'dist', standalone ? 'vdmc_decoder.standalone.js' : 'vdmc_decoder.js');
const workerEntry = resolve(sdkDir, 'wasm/vdmc_worker.js');

const entryLines = [
  "export { VDMCMeshStream } from './VDMCMeshStream.js';",
  "export { VDMCPlayer } from './VDMCPlayer.js';",
  "export { VDMCMesh } from './VDMCMesh.js';",
];
if (standalone) {
  // Re-export the bundled three so an offline host uses the SAME instance the SDK does, plus
  // OrbitControls, the controls the viewer commonly needs and cannot fetch offline.
  entryLines.push("export * as THREE from 'three';");
  entryLines.push("export { OrbitControls } from 'three/addons/controls/OrbitControls.js';");
}
const publicEntry = entryLines.join('\n');

function replaceExact(source, from, to, label, path) {
  if (!source.includes(from)) {
    throw new Error(`Could not find ${label} in ${path}; refusing to emit an incompatible bundle`);
  }
  return source.replace(from, to);
}

// --------------------------------------------------------------------------- worker pass
// esbuild does not follow `new Worker(new URL(…, import.meta.url))`, so the decoder worker is
// never part of the main bundle's module graph. Bundle it separately and inline the result.
async function buildWorkerSource() {
  // Base64 the WASM once so the glue can set `wasmBinary` directly and never fetch decode.wasm.
  const wasmBytes = await readFile(resolve(sdkDir, 'wasm/decode.wasm'));
  const wasmInlinePrologue =
    `const __VDMC_WASM_B64 = ${JSON.stringify(wasmBytes.toString('base64'))};\n` +
    'const __VDMC_WASM_BYTES = (() => {\n' +
    '  const bin = atob(__VDMC_WASM_B64);\n' +
    '  const bytes = new Uint8Array(bin.length);\n' +
    '  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);\n' +
    '  return bytes;\n' +
    '})();\n';

  const inlineWasm = {
    name: 'vdmc-inline-wasm',
    setup(buildApi) {
      buildApi.onLoad({ filter: /[\\/]wasm[\\/]vdmc_decode\.js$/ }, async ({ path }) => {
        let source = await readFile(path, 'utf8');
        source = replaceExact(
          source,
          'var wasmBinary;',
          'var wasmBinary = __VDMC_WASM_BYTES;',
          'the Emscripten WASM binary slot',
          path,
        );
        // The worker runs from a blob: URL, which cannot be used as a base URL. The returned
        // name is only compared against `wasmBinaryFile`; the inlined bytes are used instead.
        source = replaceExact(
          source,
          "return new URL('decode.wasm', import.meta.url).href;",
          "return 'decode.wasm';",
          'the Emscripten WASM URL',
          path,
        );
        return { contents: wasmInlinePrologue + source, loader: 'js', resolveDir: dirname(path) };
      });
    },
  };

  const result = await build({
    entryPoints: [workerEntry],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    legalComments: 'eof',
    write: false,
    plugins: [inlineWasm],
  });
  return result.outputFiles[0].text;
}

const workerBlobPrologue = standalone
  ? `const __VDMC_WORKER_SRC = ${JSON.stringify(await buildWorkerSource())};\n` +
    'let __vdmcWorkerUrlCache = null;\n' +
    'function __vdmcWorkerUrl() {\n' +
    '  __vdmcWorkerUrlCache ??= URL.createObjectURL(\n' +
    "    new Blob([__VDMC_WORKER_SRC], { type: 'text/javascript' }));\n" +
    '  return __vdmcWorkerUrlCache;\n' +
    '}\n'
  : '';

// --------------------------------------------------------------------------- main pass
const bundleCompatibility = {
  name: 'vdmc-bundle-compatibility',
  setup(buildApi) {
    if (!standalone) return;

    buildApi.onLoad({ filter: /[\\/]VDMCDecoder\.js$/ }, async ({ path }) => {
      const source = await readFile(path, 'utf8');
      return {
        contents: workerBlobPrologue + replaceExact(
          source,
          "new URL('../wasm/vdmc_worker.js', import.meta.url)",
          '__vdmcWorkerUrl()',
          'the decoder worker URL',
          path,
        ),
        loader: 'js',
        resolveDir: dirname(path),
      };
    });
  },
};

// Redistribution notices that must travel with the emitted file. `legalComments: 'eof'`
// additionally collects the @license blocks of everything esbuild inlines.
const banner = [
  '/**',
  ' * V-DMC Web Decoder SDK',
  ' * Copyright 2026 Nokia. Licensed under the 5G-MAG Public License (v1.0);',
  ' * see LICENSE and NOTICE in the distribution, or',
  ' * https://www.5g-mag.com/reference-tools. Distributed on an "AS IS" BASIS,',
  ' * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.',
  ' *',
  ' * Third-party components (full notices in NOTICE):',
  ' *  - MPEG V-DMC reference decoder, compiled to WebAssembly.',
  ' *    Copyright (c) 2022, ISO/IEC. BSD 3-Clause. No patent rights are granted.',
  standalone ? ' *    The .wasm binary is embedded in this file.' : ' *    Loaded from the sibling wasm/ directory.',
  standalone ? ' *  - Three.js and its examples/jsm addons. Copyright 2010-2023 Three.js Authors, MIT.' : null,
  standalone ? ' *    Bundled into this file; @license blocks are reproduced at the end of the file.' : null,
  ' */',
].filter(Boolean).join('\n');

await build({
  stdin: {
    contents: publicEntry,
    loader: 'js',
    resolveDir: srcDir,
    sourcefile: 'vdmc_decoder.entry.js',
  },
  bundle: true,
  external: standalone ? [] : ['three', 'three/*'],
  format: 'esm',
  outfile: outputFile,
  platform: 'browser',
  banner: { js: banner },
  legalComments: 'eof',
  plugins: [bundleCompatibility],
});
