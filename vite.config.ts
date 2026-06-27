import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import viteTsConfigPaths from 'vite-tsconfig-paths'
import { fileURLToPath, URL } from 'node:url'
import { readFileSync } from 'node:fs'
import tailwindcss from '@tailwindcss/vite'
import { nitro } from 'nitro/vite'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'))

const config = defineConfig({
  define: {
    __BUILD_VERSION__: JSON.stringify(
      process.env.BUILD_VERSION ?? new Date().toISOString().slice(0, 10)
    ),
    // Always the semantic app version from package.json (unlike __BUILD_VERSION__, which
    // falls back to a build date in dev). Used for the About section.
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // The Supertonic TTS worker dynamically imports onnxruntime-web (via
  // Transformers.js), so it needs ES module output (the default 'iife' can't
  // code-split).
  worker: {
    format: 'es',
  },
  // Transformers.js + onnxruntime-web ship their own WASM and do runtime dynamic
  // imports; Vite's dep pre-bundling mangles that. Exclude them so the worker
  // loads their ESM directly (the standard Transformers.js + Vite setup).
  optimizeDeps: {
    exclude: ['@huggingface/transformers'],
  },
  plugins: [
    devtools(),
    nitro({
      runtimeConfig: { port: 7739 },
      rollupConfig: { external: [/^@sentry\//] },
    }),
    // this is the plugin that enables path aliases
    viteTsConfigPaths({
      projects: ['./tsconfig.json'],
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
})

export default config
