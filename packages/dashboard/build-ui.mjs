// Builds the dashboard's browser app into dist/ui: type-checks ui/, bundles ui/main.tsx with esbuild
// (React included, so the page needs nothing from the network), and copies the HTML shell, favicon
// and the vendored fonts. Usage: node packages/dashboard/build-ui.mjs [--watch]
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
// The docs pages Settings reads at runtime ship in dist/docs.
import './copy-docs.mjs';

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

const options = {
  entryPoints: [join(ui, 'main.tsx')],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'browser',
  outfile: join(out, 'assets', 'app.js'),
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  jsx: 'automatic',
  legalComments: 'linked',
  define: { 'process.env.NODE_ENV': watch ? '"development"' : '"production"' },
  loader: { '.woff2': 'file' },
  assetNames: 'fonts/[name]',
  logLevel: 'warning',
};
if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('watching ui/');
} else {
  const result = await esbuild.build({ ...options, metafile: true });
  const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
  console.log(`dashboard ui built into ${out} (${(bytes / 1024).toFixed(0)} KB)`);
}
