// CommonJS copies of the packages an agent and its tests load: the SDK, the adapters and
// @shadowlap/test. Node loads the ES modules with require() from 20.19 and 22.12, but a test runner
// with a module loader of its own, as Jest is on Node 22, can't, and neither can the code it tests.
// Each source file is transpiled on its own with TypeScript into dist/cjs as a .cjs file, its
// relative imports pointed at the other .cjs files, and its declarations copied beside it as
// .d.cts; each package's `require` condition names them. Run after tsc -b (npm run build).
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The packages, each with the source files its CommonJS copy has: every one but those that need import.meta. */
const PACKAGES = {
  'packages/sdk': (file) => true,
  'packages/adapters': (file) => true,
  'packages/test': (file) => ['recording.ts', 'slot.ts'].includes(file),
};

/** `./x.js` and `../x.js` as the .cjs (or, in declarations, .d.cts) they are in the copy. */
const relativeJs = /(['"])(\.\.?\/[^'"]+?)\.js\1/g;

function files(dir, prefix = '') {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(dir, join(prefix, e.name)) : e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') ? [join(prefix, e.name)] : []));
}

let written = 0;
for (const [pkg, keep] of Object.entries(PACKAGES)) {
  const src = join(ROOT, pkg, 'src');
  const dist = join(ROOT, pkg, 'dist');
  for (const file of files(src).filter(keep)) {
    const source = readFileSync(join(src, file), 'utf8');
    const { outputText, diagnostics } = ts.transpileModule(source, {
      fileName: file,
      reportDiagnostics: true,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, isolatedModules: true, sourceMap: false, removeComments: false },
    });
    if (diagnostics?.length) throw new Error(`${pkg}/src/${file}: ${ts.flattenDiagnosticMessageText(diagnostics[0].messageText, '\n')}`);
    const out = join(dist, 'cjs', file.replace(/\.ts$/, '.cjs'));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, outputText.replace(relativeJs, (_, q, p) => `${q}${p}.cjs${q}`));
    const types = join(dist, file.replace(/\.ts$/, '.d.ts'));
    if (!existsSync(types)) throw new Error(`${relative(ROOT, types)} is missing: run tsc -b first`);
    writeFileSync(out.replace(/\.cjs$/, '.d.cts'), readFileSync(types, 'utf8').replace(relativeJs, (_, q, p) => `${q}${p}.cjs${q}`).replace(/\n\/\/# sourceMappingURL=.*$/, ''));
    written++;
  }
}
console.log(`CommonJS copies of ${written} modules written to dist/cjs in ${Object.keys(PACKAGES).length} packages`);
