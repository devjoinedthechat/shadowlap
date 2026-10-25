// CommonJS copies of the packages an agent and its tests load: the SDK, the adapters and
// @shadowlap/test. Node loads the ES modules with require() from 20.19 and 22.12, but a test runner
// with a module loader of its own, as Jest is on Node 22, can't, and neither can the code it tests.
// Each package's files are compiled as one TypeScript program with the package's own settings, as
// CommonJS: what doesn't type-check as CommonJS (import.meta, a top-level await) fails the build, as
// a type error fails tsc -b. Each file goes to dist/cjs as a .cjs file, its relative imports pointed
// at the other .cjs files, with a source map that names the file in src (its sources not inline, as
// in the ES build), and its declarations are copied beside it as .d.cts; each package's `require`
// condition names them. Run after tsc -b (npm run build), whose declarations the copies take and
// whose packages they import.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The packages, each with the source files its CommonJS copy has: every one but those that need import.meta. */
const PACKAGES = {
  'packages/sdk': () => true,
  'packages/adapters': () => true,
  'packages/test': (file) => ['recording.ts', 'slot.ts'].includes(file),
};

/** `./x.js` and `../x.js` as the .cjs (or, in declarations, .d.cts) they are in the copy. */
const relativeJs = /(['"])(\.\.?\/[^'"]+?)\.js\1/g;
const toCjs = (text) => text.replace(relativeJs, (_, q, p) => `${q}${p}.cjs${q}`);

function files(dir, prefix = '') {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(dir, join(prefix, e.name)) : e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') ? [join(prefix, e.name)] : []));
}

/** Prints the errors as tsc does, and ends the build. */
function fail(diagnostics) {
  const host = { getCanonicalFileName: (f) => f, getCurrentDirectory: () => ROOT, getNewLine: () => '\n' };
  process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, host));
  process.stderr.write(`\nbuild-cjs: ${diagnostics.length} error${diagnostics.length === 1 ? '' : 's'} in the CommonJS copies\n`);
  process.exit(1);
}

/** The package's own compiler settings (its tsconfig.json and the base it extends), as a CommonJS build into dist/cjs. */
function cjsOptions(pkg) {
  const parsed = ts.getParsedCommandLineOfConfigFile(join(ROOT, pkg, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => fail([d]) });
  if (!parsed) throw new Error(`${pkg}/tsconfig.json could not be read`);
  if (parsed.errors.length) fail(parsed.errors);
  return {
    ...parsed.options,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    // ES module syntax in a file compiled as CommonJS is what this build is for.
    verbatimModuleSyntax: false,
    rootDir: join(ROOT, pkg, 'src'),
    outDir: join(ROOT, pkg, 'dist', 'cjs'),
    sourceMap: true,
    inlineSources: false,
    declaration: false,
    declarationMap: false,
    composite: false,
    incremental: false,
    tsBuildInfoFile: undefined,
    noEmit: false,
    noEmitOnError: true,
  };
}

let written = 0;
for (const [pkg, keep] of Object.entries(PACKAGES)) {
  const src = join(ROOT, pkg, 'src');
  const dist = join(ROOT, pkg, 'dist');
  const kept = files(src).filter(keep);
  const program = ts.createProgram(
    kept.map((f) => join(src, f)),
    cjsOptions(pkg),
  );
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) fail(diagnostics);
  const emitted = program.emit(undefined, (fileName, text) => {
    // x.js and x.js.map as x.cjs and x.cjs.map, pointing at each other and at the other copies.
    const out = fileName.replace(/\.js(\.map)?$/, '.cjs$1');
    mkdirSync(dirname(out), { recursive: true });
    if (out.endsWith('.map')) writeFileSync(out, JSON.stringify({ ...JSON.parse(text), file: basename(out, '.map') }));
    else writeFileSync(out, toCjs(text).replace(/^\/\/# sourceMappingURL=(.+)\.js\.map$/m, '//# sourceMappingURL=$1.cjs.map'));
  });
  if (emitted.diagnostics.length) fail(emitted.diagnostics);
  for (const file of kept) {
    const types = join(dist, file.replace(/\.ts$/, '.d.ts'));
    if (!existsSync(types)) throw new Error(`${relative(ROOT, types)} is missing: run tsc -b first`);
    const out = join(dist, 'cjs', file.replace(/\.ts$/, '.d.cts'));
    if (!existsSync(out.replace(/\.d\.cts$/, '.cjs'))) throw new Error(`${relative(ROOT, out)}: the program wrote no CommonJS copy of ${file}`);
    writeFileSync(out, toCjs(readFileSync(types, 'utf8')).replace(/\n\/\/# sourceMappingURL=.*$/, ''));
    written++;
  }
}
console.log(`CommonJS copies of ${written} modules written to dist/cjs in ${Object.keys(PACKAGES).length} packages, type-checked as CommonJS`);
