import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'path';
import { MOD_VERSION } from './src/version';

function syncVersion() {
  return {
    name: 'sync-mod-version',
    buildStart() {
      for (const file of ['manifest.json', 'package.json']) {
        const p = path.resolve(__dirname, file);
        const content = readFileSync(p, 'utf-8');
        const updated = content.replace(/("version":\s*)"[^"]*"/, `$1"${MOD_VERSION}"`);
        if (updated !== content) writeFileSync(p, updated);
      }
    },
  };
}

export default defineConfig({
  esbuild: { keepNames: true },
  build: {
    lib: {
      entry: path.resolve(__dirname, 'src/main.ts'),
      formats: ['iife'],
      name: 'SubwayInducedDemand',
      fileName: () => 'index.js',
    },
    outDir: 'dist',
    minify: false,
    rollupOptions: { output: { entryFileNames: 'index.js' } },
  },
  plugins: [
    syncVersion(),
    viteStaticCopy({ targets: [{ src: 'manifest.json', dest: '.' }] }),
  ],
});
