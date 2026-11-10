import { defineConfig, type Plugin } from 'vite';
import type { OutputAsset } from 'rollup';
import react from '@vitejs/plugin-react';

/**
 * Inline the entry script and stylesheet into index.html, so `dist/index.html` is the
 * whole app in one file (the simulation worker is already inlined as a blob).
 */
function singleFile(): Plugin {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return {
    name: 'twin-single-file',
    enforce: 'post',
    generateBundle(_opts, bundle) {
      const html = bundle['index.html'] as OutputAsset | undefined;
      if (!html) return;
      let src = String(html.source);
      for (const [name, f] of Object.entries(bundle)) {
        if (f.type === 'chunk' && f.isEntry) {
          const code = f.code.replace(/<\/script/gi, '<\\/script');
          src = src.replace(new RegExp(`<script type="module" crossorigin src="(\\./)?${esc(name)}"></script>`), () => `<script type="module">${code}</script>`);
          delete bundle[name];
        } else if (f.type === 'asset' && name.endsWith('.css')) {
          src = src.replace(new RegExp(`<link rel="stylesheet" crossorigin href="(\\./)?${esc(name)}">`), () => `<style>${String(f.source)}</style>`);
          delete bundle[name];
        }
      }
      html.source = src;
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), singleFile()],
  worker: { format: 'iife' },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 4000,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
  server: { port: 5173, host: true },
});
