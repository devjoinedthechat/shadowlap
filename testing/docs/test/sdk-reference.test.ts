// docs/sdk.md, docs/frameworks.md, docs/testing.md, docs/engine.md and the README import names from
// the SDKs, the adapters, the test helpers and the engine, and nothing generates those samples from the
// code: a function renamed or dropped would leave a sample that fails on the first line someone
// copies. These checks hold every name the docs import to what the packages export.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const pages = [...readdirSync(join(root, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`), 'README.md'];
const read = (path: string) => readFileSync(join(root, path), 'utf8');

/** A TypeScript package's module as the docs import it, by its source file. */
const TS_MODULES: Record<string, string> = {
  '@shadowlap/sdk': 'packages/sdk/src/index.ts',
  '@shadowlap/adapters': 'packages/adapters/src/index.ts',
  '@shadowlap/adapters/ai-sdk': 'packages/adapters/src/ai-sdk.ts',
  '@shadowlap/adapters/openai-agents': 'packages/adapters/src/openai-agents.ts',
  '@shadowlap/adapters/mastra': 'packages/adapters/src/mastra.ts',
  '@shadowlap/adapters/anthropic': 'packages/adapters/src/anthropic.ts',
  '@shadowlap/adapters/langchain': 'packages/adapters/src/langchain.ts',
  '@shadowlap/adapters/claude-agent-sdk': 'packages/adapters/src/claude-agent-sdk.ts',
  '@shadowlap/test': 'packages/test/src/index.ts',
  '@shadowlap/engine': 'packages/engine/src/index.ts',
};

/** `import { a, b as c, type T } from '@shadowlap/…'` in the docs: the module and the runtime names. */
function tsImports(): Array<{ where: string; module: string; names: string[] }> {
  const out: Array<{ where: string; module: string; names: string[] }> = [];
  for (const page of pages) {
    for (const m of read(page).matchAll(/import\s*\{([^}]+)\}\s*from\s*'(@shadowlap\/[^']+)'/g)) {
      const names = m[1]!
        .split(',')
        .map((n) => n.trim())
        .filter((n) => n && !n.startsWith('type '))
        .map((n) => n.split(/\s+as\s+/)[0]!.trim());
      out.push({ where: page, module: m[2]!, names });
    }
  }
  return out;
}

/** `from shadowlap… import a, b` in the docs: the module and the names. */
function pythonImports(): Array<{ where: string; module: string; names: string[] }> {
  const out: Array<{ where: string; module: string; names: string[] }> = [];
  for (const page of pages) {
    for (const m of read(page).matchAll(/^\s*from\s+(shadowlap(?:\.[a-z_]+)*)\s+import\s+([^\n#]+)/gm)) {
      const names = m[2]!
        .replace(/[()]/g, '')
        .split(',')
        .map((n) => n.trim().split(/\s+as\s+/)[0]!.trim())
        .filter(Boolean);
      out.push({ where: page, module: m[1]!, names });
    }
  }
  return out;
}

/** A Python module's source, by its dotted name. */
function pythonSource(module: string): string {
  const parts = module.split('.');
  const base = join(root, 'sdks', 'python', ...parts);
  try {
    return readFileSync(join(base, '__init__.py'), 'utf8');
  } catch {
    return readFileSync(`${base}.py`, 'utf8');
  }
}

/** Whether a module defines or re-exports a name at its top level. */
function pythonHas(source: string, name: string): boolean {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^(?:async\\s+def|def|class)\\s+${n}\\b|^${n}\\s*(?::[^=\\n]+)?=|^from\\s+\\S+\\s+import\\s+[^\\n]*\\b${n}\\b`, 'm').test(source);
}

describe('the SDK imports the docs show', () => {
  it('finds them', () => {
    // A guard against the extraction itself breaking and passing everything.
    expect(tsImports().length).toBeGreaterThan(10);
    expect(pythonImports().length).toBeGreaterThan(5);
  });

  it('are exported by the TypeScript packages', async () => {
    const missing: string[] = [];
    for (const { where, module, names } of tsImports()) {
      const file = TS_MODULES[module];
      if (!file) {
        missing.push(`${where}: no package ${module}`);
        continue;
      }
      const exported = (await import(pathToFileURL(join(root, file)).href)) as Record<string, unknown>;
      for (const name of names) if (!(name in exported)) missing.push(`${where}: ${module} has no ${name}`);
    }
    expect(missing).toEqual([]);
  });

  it('are defined by the Python package', () => {
    const missing: string[] = [];
    for (const { where, module, names } of pythonImports()) {
      let source: string;
      try {
        source = pythonSource(module);
      } catch {
        missing.push(`${where}: no module ${module}`);
        continue;
      }
      for (const name of names) if (!pythonHas(source, name)) missing.push(`${where}: ${module} has no ${name}`);
    }
    expect(missing).toEqual([]);
  });

  it('match the Python package\'s public names in docs/sdk.md\'s list', () => {
    // Every public name of the Python SDK that docs/sdk.md says it has is in its __all__.
    const all = /__all__\s*=\s*\[([^\]]+)\]/.exec(pythonSource('shadowlap'))![1]!.match(/"([^"]+)"/g)!.map((s) => s.slice(1, -1));
    const sdk = read('docs/sdk.md');
    for (const name of ['ShadowlapInjectedTimeout', 'ShadowlapInjectedHTTPError', 'ShadowlapInjectedFailure', 'current_scope', 'user_input_async']) {
      expect(sdk, name).toContain(name);
      expect(all, name).toContain(name);
    }
  });
});
