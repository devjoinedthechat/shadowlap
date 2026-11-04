import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * The packages' sources, held to two things.
 *
 * No module imports another that, as it loads, imports it back. A module in a cycle can run before a
 * module it imports has, and read a binding that isn't there yet; and every module in a cycle is tied
 * to the rest, so none can be read or moved alone. What the build erases (`import type`, `export
 * type`) loads nothing, and a dynamic `import()` loads later; `import { type T }` loads its module, as
 * the `import {}` verbatimModuleSyntax leaves of it.
 *
 * No helper is copied from one package to another, the dashboard's pages counted apart from its
 * server: a helper two of them need lives where both can import it, so the copies can't drift. The
 * engine holds those of the packages built on it, and the pages bundle its modules that import
 * nothing; the server and its pages share modules of the dashboard's own that import nothing.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The TypeScript files under a folder, its declaration files and its build aside. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'dist' || name === 'node_modules' ? [] : sources(path);
    return /\.tsx?$/.test(name) && !name.endsWith('.d.ts') ? [path] : [];
  });
}

/** Every package's sources, the dashboard's pages among them. */
function packageSources(): string[] {
  const packages = readdirSync(join(ROOT, 'packages')).flatMap((p) => {
    const src = join(ROOT, 'packages', p, 'src');
    return statSync(src, { throwIfNoEntry: false })?.isDirectory() ? sources(src) : [];
  });
  return [...packages, ...sources(join(ROOT, 'packages', 'dashboard', 'ui'))];
}

/** The file a relative specifier names, as NodeNext and a bundler find it: `./x.js` is `./x.ts` or `./x.tsx`. */
function resolved(from: string, specifier: string): string | null {
  const base = resolve(dirname(from), specifier);
  const stem = base.replace(/\.(m?js|jsx)$/, '');
  return [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, join(base, 'index.ts')].find((f) => statSync(f, { throwIfNoEntry: false })?.isFile()) ?? null;
}

/** The modules a file loads as it loads: its relative imports and re-exports that the build keeps. */
function loads(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, false);
  const specifiers = source.statements.flatMap((s) => {
    if (ts.isImportDeclaration(s)) return s.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword ? [] : [s.moduleSpecifier];
    return ts.isExportDeclaration(s) && !s.isTypeOnly && s.moduleSpecifier ? [s.moduleSpecifier] : [];
  });
  return specifiers.flatMap((m) => {
    const to = ts.isStringLiteral(m) && m.text.startsWith('.') ? resolved(file, m.text) : null;
    return to ? [to] : [];
  });
}

/** Each cycle among `files`: the files that load one another, each set sorted (Tarjan's strongly connected components). */
function cycles(files: readonly string[]): string[][] {
  const edges = new Map(files.map((f) => [f, loads(f)]));
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const out: string[][] = [];
  const visit = (v: string) => {
    index.set(v, index.size);
    low.set(v, index.get(v)!);
    stack.push(v);
    for (const w of edges.get(v) ?? []) {
      if (!edges.has(w)) continue;
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (stack.includes(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) !== index.get(v)) return;
    const component = stack.splice(stack.indexOf(v));
    if (component.length > 1 || edges.get(v)!.includes(v)) out.push(component.sort());
  };
  for (const f of files) if (!index.has(f)) visit(f);
  return out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/** The package a file under `root` is part of, the dashboard's pages apart from its server: `packages/cli`, `packages/dashboard/ui`. */
const packageOf = (root: string, file: string) => {
  const rel = relative(root, file).split('\\').join('/');
  return rel.startsWith('packages/dashboard/ui/') ? 'packages/dashboard/ui' : rel.split('/').slice(0, 2).join('/');
};

const printer = ts.createPrinter({ removeComments: true });

/** Each function a file defines at its top level (`function f`, `const f = () =>`), as TypeScript prints it: no comments, no `export`, so only its name and what it does count. */
function helpers(file: string): Array<{ name: string; text: string }> {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  return source.statements.flatMap((s) => {
    const fn = ts.isVariableStatement(s) && s.declarationList.declarations.length === 1 ? s.declarationList.declarations[0] : undefined;
    const named = ts.isFunctionDeclaration(s) && s.name && s.body ? s.name.text : fn && ts.isIdentifier(fn.name) && fn.initializer && (ts.isArrowFunction(fn.initializer) || ts.isFunctionExpression(fn.initializer)) ? fn.name.text : null;
    return named ? [{ name: named, text: printer.printNode(ts.EmitHint.Unspecified, s, source).replace(/^export (default )?/, '') }] : [];
  });
}

/** Each helper defined the same way in more than one package: its name and the packages that define it, `plural: packages/cli, packages/engine`. */
function copied(root: string, files: readonly string[]): string[] {
  const where = new Map<string, { name: string; packages: Set<string> }>();
  for (const file of files) {
    for (const h of helpers(file)) {
      const seen = where.get(h.text) ?? { name: h.name, packages: new Set<string>() };
      seen.packages.add(packageOf(root, file));
      where.set(h.text, seen);
    }
  }
  return [...where.values()]
    .filter((h) => h.packages.size > 1)
    .map((h) => `${h.name}: ${[...h.packages].sort().join(', ')}`)
    .sort();
}

/**
 * The copies kept, each for its reason. The adapters install the SDK and nothing else, so they keep
 * their own isObject rather than the engine's (as eslint.config.mjs says). The SDK's one entry point
 * is the API its users import, where the adapters' loader and type test don't belong. And
 * `@shadowlap/test` keeps a copy of the argsMatch the engine's checks use, since the CommonJS copy
 * of its recording.ts loads only its own files.
 */
const KEPT = ['argsMatch: packages/engine, packages/test', 'isAsyncGeneratorFunction: packages/adapters, packages/sdk', 'isObject: packages/adapters, packages/engine', 'load: packages/adapters, packages/sdk'];

const folders: string[] = [];
afterAll(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

/** A folder of the test's own with `files` in it. */
function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'sl-package-sources-'));
  folders.push(dir);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

describe("the packages' modules", () => {
  it('find a cycle of imports that load, and only those', () => {
    const files: Record<string, string> = {
      // A value import each way.
      'a.ts': "import { b } from './b.js';\nexport const a = (): number => b;\n",
      'b.ts': "import { a } from './a.js';\nexport const b = 1;\nexport const twice = (): number => a() * 2;\n",
      // `import type` is erased: d loads c, and c loads nothing.
      'c.ts': "import type { D } from './d.js';\nexport const c = (d: D): D => d;\n",
      'd.ts': "import { c } from './c.js';\nexport type D = number;\nexport const d = c(1);\n",
      // `import { type F }` is kept as `import {}`, and a re-export loads what it names.
      'e.ts': "import { type F } from './f.js';\nexport const e = (f: F): F => f;\n",
      'f.tsx': "export { e } from './e.js';\nexport type F = string;\n",
      // A dynamic import loads later.
      'g.ts': "export const g = () => import('./h.js');\n",
      'h.ts': "import { g } from './g.js';\nexport const h = g;\n",
    };
    const dir = folder(files);
    const found = cycles(Object.keys(files).map((name) => join(dir, name)));
    expect(found.map((c) => c.map((f) => relative(dir, f)))).toEqual([
      ['a.ts', 'b.ts'],
      ['e.ts', 'f.tsx'],
    ]);
  });

  it('import no module that, as it loads, imports them back', () => {
    const files = packageSources();
    expect(files.length).toBeGreaterThan(500);
    expect(cycles(files).map((c) => c.map((f) => relative(ROOT, f).split('\\').join('/')))).toEqual([]);
  });
});

describe("the packages' helpers", () => {
  it('find one defined the same way in two packages, whatever its comments, layout or export, and only that', () => {
    const files: Record<string, string> = {
      'packages/one/src/a.ts': '/** Twice. */\nexport const twice = (n: number) => n * 2;\nfunction half(n: number) { return n / 2; }\n',
      'packages/two/src/b.ts': 'const twice = (n: number) =>\n  // the same, laid out otherwise\n  n * 2;\nexport function half(n: number) {\n  return n / 3;\n}\n',
      // The dashboard's pages are a package apart from its server; a helper in one package alone is no copy.
      'packages/dashboard/src/c.ts': 'export const pad = (n: number) => String(n).padStart(2, "0");\nconst same = (n: number) => n;\n',
      'packages/dashboard/ui/d.tsx': 'const pad = (n: number) => String(n).padStart(2, "0");\n',
      'packages/one/src/e.ts': 'const same = (n: number) => n;\nconst renamed = (n: number) => n * 2;\n',
      'packages/one/src/f.ts': 'const same = (n: number) => n;\n',
    };
    const dir = folder(files);
    expect(copied(dir, Object.keys(files).map((name) => join(dir, name)))).toEqual(['pad: packages/dashboard, packages/dashboard/ui', 'same: packages/dashboard, packages/one', 'twice: packages/one, packages/two']);
  });

  it('copy none from one package to another, but those kept for the reason given', () => {
    expect(copied(ROOT, packageSources())).toEqual(KEPT);
  });
});
