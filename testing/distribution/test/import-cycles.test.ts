import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * No package's modules import one another in a circle as they load. A module in a cycle can run before
 * a module it imports has, and read a binding that isn't there yet; and every module in a cycle is tied
 * to the rest, so none can be read or moved alone. What the build erases (`import type`, `export type`)
 * loads nothing, and a dynamic `import()` loads later; `import { type T }` loads its module, as the
 * `import {}` verbatimModuleSyntax leaves of it.
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

const folders: string[] = [];
afterAll(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

describe("the packages' modules", () => {
  it('find a cycle of imports that load, and only those', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sl-import-cycles-'));
    folders.push(dir);
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
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    const found = cycles(Object.keys(files).map((name) => join(dir, name)));
    expect(found.map((c) => c.map((f) => relative(dir, f)))).toEqual([
      ['a.ts', 'b.ts'],
      ['e.ts', 'f.tsx'],
    ]);
  });

  it('import no module that, as it loads, imports them back', () => {
    const packages = readdirSync(join(ROOT, 'packages')).flatMap((p) => {
      const src = join(ROOT, 'packages', p, 'src');
      return statSync(src, { throwIfNoEntry: false })?.isDirectory() ? sources(src) : [];
    });
    const files = [...packages, ...sources(join(ROOT, 'packages', 'dashboard', 'ui'))];
    expect(files.length).toBeGreaterThan(500);
    expect(cycles(files).map((c) => c.map((f) => relative(ROOT, f).split('\\').join('/')))).toEqual([]);
  });
});
