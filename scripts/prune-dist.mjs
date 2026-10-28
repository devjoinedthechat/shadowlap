// Removes what tsc -b built from a source that is gone. tsc writes each module's JavaScript and
// declarations, with their maps, into its project's dist and never deletes them: a module moved or
// deleted in src leaves its old build behind, which the package then ships, and whose map, made
// under the settings of its day, may carry its source inline. npm run build runs this first.
//
// It looks only at what tsc writes, in each project tsc -b builds (the root tsconfig.json's
// references): what the project's sources build now stays, and so does what another step of the
// build writes into dist, each of which writes its folder whole: the CommonJS copies (dist/cjs,
// build-cjs.mjs) and the dashboard's app, docs and coding agents (dist/ui, dist/docs and
// dist/coding-agents, build-ui.mjs). A folder left empty goes too.
//
// Usage: node scripts/prune-dist.mjs [root]
import { existsSync, readdirSync, rmdirSync, rmSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = resolve(process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url)));

/** What tsc writes of a module: its JavaScript, its declarations, and their maps. */
const BUILT = /\.(?:js|d\.ts)(?:\.map)?$/;
/** The folders of dist that another step of the build writes whole. */
const OTHER_STEPS = new Set(['cjs', 'ui', 'docs', 'coding-agents']);

/** A tsconfig as tsc reads it, with what it extends. */
function project(config) {
  const parsed = ts.getParsedCommandLineOfConfigFile(config, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(`${relative(ROOT, config)}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`);
    },
  });
  if (!parsed) throw new Error(`${relative(ROOT, config)} could not be read`);
  return parsed;
}

/** The files under `dir`, and its folders after what they hold. */
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? [...walk(join(dir, e.name)), { dir: join(dir, e.name) }] : [{ file: join(dir, e.name) }]));
}

const removed = [];
const { config: root, error } = ts.readConfigFile(join(ROOT, 'tsconfig.json'), ts.sys.readFile);
if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'));
for (const { path } of root.references ?? []) {
  const config = join(ROOT, path.endsWith('.json') ? path : join(path, 'tsconfig.json'));
  const built = project(config);
  const { outDir, rootDir } = built.options;
  if (!outDir || !existsSync(outDir)) continue;
  const current = new Set(built.fileNames.flatMap((f) => ts.getOutputFileNames(built, f, false)).map((f) => resolve(f)));
  const anotherStep = (path) => {
    const top = relative(outDir, path).split(sep)[0];
    return OTHER_STEPS.has(top) && !(rootDir && existsSync(join(rootDir, top)));
  };
  for (const entry of walk(outDir)) {
    if ('file' in entry) {
      if (!BUILT.test(entry.file) || current.has(entry.file) || anotherStep(entry.file)) continue;
      rmSync(entry.file);
      removed.push(relative(ROOT, entry.file));
    } else if (!anotherStep(entry.dir) && readdirSync(entry.dir).length === 0) {
      rmdirSync(entry.dir);
    }
  }
}
if (removed.length) console.log(`Removed ${removed.length} build output${removed.length === 1 ? '' : 's'} whose source is gone:\n  ${removed.sort().join('\n  ')}`);
