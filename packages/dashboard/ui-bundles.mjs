// The dashboard's two browser bundles, as esbuild options: build-ui.mjs builds them, and the bundle
// size test builds them in memory to hold them to their budgets.
//
// - `served`: what the dashboard serves, from ui/main.tsx. app.js is the first script, with the
//   shell and what the pages share; each page's own code is a chunk (chunks/) that loads when the
//   page first opens (ui/pages/lazy.tsx), and so is each part of a page that waits until it first
//   shows (`onShow`, ui/components/OnShow.tsx). app.css is every style.
// - `copy`: what an exported copy inlines (src/static.ts), from an entry of its own,
//   ui/main-copy.tsx, with only the pages a copy shows: its runs, a run's page and Compare between
//   them. One script, copy.js, since a file opened from a disk, an artifact store or a pull request
//   comment has no server to load a chunk from. Its styles are the served build's app.css, and its
//   licences go at its end: it is a copy on its own.
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
    copy: { ...common, entryPoints: { copy: join(ui, 'main-copy.tsx') }, splitting: false, legalComments: 'eof' },
  };
}
