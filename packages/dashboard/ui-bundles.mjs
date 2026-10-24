// The dashboard's two browser bundles, as esbuild options: build-ui.mjs builds them, and the bundle
// size test builds them in memory to hold them to their budgets.
//
// - `served`: what the dashboard serves. app.js is the first script, with the shell and what the
//   pages share; each page's own code is a chunk (chunks/) that loads when the page first opens
//   (ui/pages/lazy.tsx). app.css is every style.
// - `standalone`: what an exported copy inlines (src/static.ts). One script, every page in it, since a
//   file opened from a disk, an artifact store or a pull request comment has no server to load a
//   chunk from. Its licences go at its end: it is a copy on its own.
import { join } from 'node:path';

/** @param {{ ui: string; out: string; watch?: boolean }} o */
export function uiBundles({ ui, out, watch = false }) {
  const common = {
    entryPoints: { app: join(ui, 'main.tsx') },
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: 'browser',
    outdir: join(out, 'assets'),
    minify: !watch,
    sourcemap: watch ? 'inline' : false,
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': watch ? '"development"' : '"production"' },
    loader: { '.woff2': 'file' },
    assetNames: 'fonts/[name]',
    logLevel: 'warning',
  };
  return {
    served: { ...common, splitting: true, chunkNames: 'chunks/[name]-[hash]', legalComments: 'linked' },
    standalone: { ...common, entryPoints: { standalone: join(ui, 'main.tsx') }, splitting: false, legalComments: 'eof' },
  };
}
