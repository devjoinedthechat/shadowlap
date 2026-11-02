// Builds the dashboard's browser app into dist/ui: type-checks ui/ and bundles it with esbuild (React
// included, so the page needs nothing from the network) twice, as ui-bundles.mjs says: ui/main.tsx
// split into a first script and a chunk per page for the dashboard to serve, and ui/main-copy.tsx,
// what an exported copy shows, whole in one script for the copy to inline. It copies the HTML shell,
// favicon and the vendored fonts.
// Usage: node packages/dashboard/build-ui.mjs [--watch]
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
// The docs pages Settings reads at runtime ship in dist/docs.
import './copy-docs.mjs';
import { uiBundles } from './ui-bundles.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ui = join(here, 'ui');
const out = join(here, 'dist', 'ui');
const watch = process.argv.includes('--watch');

const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
execFileSync(process.execPath, [tsc, '-p', join(ui, 'tsconfig.json')], { stdio: 'inherit' });

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'assets'), { recursive: true });
cpSync(join(ui, 'index.html'), join(out, 'index.html'));
cpSync(join(ui, 'favicon.svg'), join(out, 'assets', 'favicon.svg'));
cpSync(join(ui, 'fonts'), join(out, 'assets', 'fonts'), { recursive: true });

const { served, copy } = uiBundles({ ui, out, watch });
if (watch) {
  const ctx = await esbuild.context(served);
  await ctx.watch();
  console.log('watching ui/');
} else {
  const first = await esbuild.build({ ...served, metafile: true });
  // The exported copy's script, copy.js: its styles and fonts are the served build's (app.css).
  const whole = await esbuild.build({ ...copy, metafile: true });
  const kb = (bytes) => `${(bytes / 1024).toFixed(0)} KB`;
  const outs = first.metafile.outputs;
  const scripts = Object.keys(outs).filter((file) => file.endsWith('.js'));
  // The first look: app.js and the chunks it imports up front; the rest load as their pages open.
  const upFront = new Set();
  const load = (file) => {
    if (upFront.has(file)) return;
    upFront.add(file);
    for (const i of outs[file].imports) if (i.kind === 'import-statement') load(i.path);
  };
  load(scripts.find((file) => file.endsWith('/app.js')));
  const bytes = (files) => files.reduce((n, file) => n + outs[file].bytes, 0);
  const one = Object.entries(whole.metafile.outputs).find(([file]) => file.endsWith('/copy.js'))?.[1].bytes ?? 0;
  console.log(`dashboard ui built into ${out}: the first look ${kb(bytes([...upFront]))} in ${upFront.size} scripts, the pages' own ${kb(bytes(scripts.filter((f) => !upFront.has(f))))} in ${scripts.length - upFront.size} more; an exported copy's script ${kb(one)}`);
}
