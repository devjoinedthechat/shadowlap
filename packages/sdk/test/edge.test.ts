import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

/**
 * An Edge runtime (Vercel's, Cloudflare Workers) or a browser bundle has none of Node's modules, and
 * may have no `process` or `Buffer` either. The SDK's default entry, which those load, imports no
 * Node module until a call goes to the sidecar, so it loads there, and outside shadowlap every
 * wrapper calls straight through. Here a Node whose module resolver refuses every builtin, with
 * `process` and `Buffer` taken away, imports the built package as such a runtime would.
 */

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const run = promisify(execFile);

function script(dir: string, name: string, text: string): string {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

async function inEdge(body: string): Promise<{ stdout: string; stderr: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'shadowlap-edge-'));
  script(
    dir,
    'refuse-builtins.mjs',
    `export async function resolve(specifier, context, next) {
      if (specifier.startsWith('node:') || ${JSON.stringify((await import('node:module')).builtinModules)}.includes(specifier)) {
        throw new Error('no Node module here: ' + specifier);
      }
      return next(specifier, context);
    }`,
  );
  const register = script(dir, 'register.mjs', `import { register } from 'node:module';\nregister('./refuse-builtins.mjs', import.meta.url);\n`);
  const app = script(
    dir,
    'app.mjs',
    `const out = (value) => console.log(JSON.stringify(value));
    delete globalThis.process;
    delete globalThis.Buffer;
    const sdk = await import(${JSON.stringify(pathToFileURL(join(DIST, 'index.js')).href)});
    ${body}`,
  );
  return run(process.execPath, ['--import', pathToFileURL(register).href, app], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', SHADOWLAP_HOME: process.env.SHADOWLAP_HOME } });
}

describe('the SDK where Node modules do not exist', () => {
  it('loads, and every wrapper calls straight through', async () => {
    const { stdout } = await inEdge(`
      const ran = [];
      const search = sdk.tool('search_web', { effect: 'read' }, async ({ query }) => (ran.push(query), { hits: [query] }));
      const pages = sdk.tool('pages', { effect: 'read' }, async function* ({ n }) { for (let i = 0; i < n; i++) yield i; });
      const streamed = [];
      for await (const page of pages({ n: 3 })) streamed.push(page);
      out({
        active: sdk.isActive(),
        result: await search({ query: 'refunds' }),
        ran,
        streamed,
        scoped: sdk.scope('researcher', () => 'inside'),
        now: typeof (await sdk.now()),
        uuid: /^[0-9a-f-]{36}$/.test(await sdk.uuid()),
        answer: await sdk.userInput('Order? ', () => 'A-1042'),
        version: sdk.VERSION,
      });
    `);
    expect(JSON.parse(stdout.trim().split('\n').pop()!)).toEqual({
      active: false,
      result: { hits: ['refunds'] },
      ran: ['refunds'],
      streamed: [0, 1, 2],
      scoped: 'inside',
      now: 'number',
      uuid: true,
      answer: 'A-1042',
      version: (await import('../src/version.js')).VERSION,
    });
  });

  it('is what that runtime would refuse to load if it imported a Node module (the check itself works)', async () => {
    await expect(inEdge(`await import('node:http'); out('loaded');`)).rejects.toThrow(/no Node module here: node:http/);
  });
});
