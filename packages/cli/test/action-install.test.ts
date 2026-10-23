import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * The Action's install step, as action.yml runs it: it installs the CLI the step names from npm,
 * with fix-on-failure the Anthropic SDK beside it at the version the release's lockfile holds, and
 * says when the step names another CLI than the action's own release. npm here is a stand-in that
 * writes down what it was asked to install.
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const ACTION = readFileSync(join(ROOT, 'action.yml'), 'utf8');
const RELEASE = (JSON.parse(readFileSync(join(ROOT, 'packages', 'cli', 'package.json'), 'utf8')) as { version: string }).version;
const SDK = (JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as { packages: Record<string, { version: string }> }).packages['node_modules/@anthropic-ai/sdk']!.version;

/** A step's `run:` script, by the step's name. */
function stepScript(name: string): string {
  const lines = ACTION.split('\n');
  const at = lines.findIndex((l) => l.trim().startsWith(`- name: ${name}`));
  const run = lines.findIndex((l, i) => i > at && /^\s+run: \|$/.test(l));
  const indent = /^\s*/.exec(lines[run + 1]!)![0].length;
  const body: string[] = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() && /^\s*/.exec(line)![0].length < indent) break;
    body.push(line.slice(indent));
  }
  return body.join('\n');
}

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** What npm was asked to install: its arguments but the command, the options and the folder. */
const packages = (asked: string[]) => asked.filter((a) => a !== 'install' && !a.startsWith('-') && !a.includes('shadowlap-cli'));

function install(version: string, fixOnFailure: boolean): { code: number | null; out: string; asked: string[]; cli: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sl-action-install-'));
  dirs.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  // Each argument on a line of its own, as npm was given them.
  writeFileSync(join(bin, 'npm'), `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > "${join(dir, 'npm-args')}"\n`);
  chmodSync(join(bin, 'npm'), 0o755);
  writeFileSync(join(dir, 'output'), '');
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, VERSION: version, FIX_ON_FAILURE: String(fixOnFailure), GITHUB_ACTION_PATH: ROOT, RUNNER_TEMP: dir, GITHUB_OUTPUT: join(dir, 'output') };
  const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', stepScript('Install shadowlap')], { env, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, asked: readFileSync(join(dir, 'npm-args'), 'utf8').trim().split('\n'), cli: readFileSync(join(dir, 'output'), 'utf8') };
}

// The step runs in bash on every runner; npm's stand-in here is a shell script, which Windows doesn't start by name.
describe.skipIf(process.platform === 'win32')("the Action's install step", () => {
  it('installs the CLI the step names, and with fix-on-failure the SDK this release was tested with, never the newest', () => {
    const plain = install(RELEASE, false);
    expect(plain.code, plain.out).toBe(0);
    expect(packages(plain.asked)).toEqual([`shadowlap@${RELEASE}`]);
    expect(plain.cli).toMatch(/^cli=.*shadowlap-cli\/node_modules\/shadowlap\/bin\/shadowlap\.js\n$/);
    const fixing = install(RELEASE, true);
    expect(fixing.code, fixing.out).toBe(0);
    expect(packages(fixing.asked)).toEqual([`shadowlap@${RELEASE}`, `@anthropic-ai/sdk@${SDK}`]);
    expect(SDK).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("warns when the step names another CLI than the action's own release, and says which to set", () => {
    expect(install(RELEASE, false).out).not.toContain('::warning');
    const other = install('0.0.9', false);
    expect(other.code, other.out).toBe(0);
    expect(other.out).toContain(`::warning title=Shadowlap::this action is v${RELEASE} but installs shadowlap 0.0.9; set version: ${RELEASE}, or leave it out\n`);
    expect(other.asked).toContain('shadowlap@0.0.9');
  });

  it("installs the action's own release when the step names no version, and runs no package's install script", () => {
    const own = install('', true);
    expect(own.code, own.out).toBe(0);
    expect(packages(own.asked)).toEqual([`shadowlap@${RELEASE}`, `@anthropic-ai/sdk@${SDK}`]);
    expect(own.out).not.toContain('::warning');
    // The job may hold provider keys and tokens: no lifecycle script of any package runs beside them.
    expect(own.asked).toContain('--ignore-scripts');
    expect(install(RELEASE, false).asked).toContain('--ignore-scripts');
  });
});

describe.skipIf(process.platform === 'win32')("the Action's build from its own source", () => {
  it('runs npm with none of the job\'s secrets, keys or tokens, only what npm and Node need', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sl-action-build-'));
    dirs.push(dir);
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    // A stand-in for npm that writes down how it was called and the environment it got.
    const log = join(dir, 'npm-log');
    writeFileSync(join(bin, 'npm'), `#!/bin/sh\n{ echo "npm $*"; env; echo ---; } >> "${log}"\n`);
    chmodSync(join(bin, 'npm'), 0o755);
    const source = join(dir, 'action');
    mkdirSync(source);
    writeFileSync(join(dir, 'output'), '');
    const secrets = { ANTHROPIC_API_KEY: 'sk-ant-secret', OPENAI_API_KEY: 'sk-secret', GH_TOKEN: 'ghp_secret', GITHUB_TOKEN: 'ghs_secret', INPUT_GITHUB_TOKEN: 'github_pat_secret', SHADOWLAP_JOB_TOKEN: 'ghs_job_secret', AWS_SECRET_ACCESS_KEY: 'aws-secret', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc-secret', MY_OWN_SECRET: 'mine' };
    const env = { ...process.env, ...secrets, PATH: `${bin}${delimiter}${process.env.PATH}`, HOME: dir, RUNNER_TEMP: dir, GITHUB_OUTPUT: join(dir, 'output'), HTTPS_PROXY: 'http://proxy.example:3128' };
    const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', stepScript('Build shadowlap from the action')], { cwd: source, env, encoding: 'utf8' });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    const runs = readFileSync(log, 'utf8').split('---\n').filter(Boolean);
    expect(runs.map((x) => x.split('\n')[0])).toEqual(['npm ci --no-audit --no-fund', 'npm run build']);
    for (const run of runs) {
      for (const [name, value] of Object.entries(secrets)) {
        expect(run, name).not.toContain(`${name}=`);
        expect(run, name).not.toContain(value);
      }
      expect(run).toContain(`HOME=${dir}\n`);
      expect(run).toMatch(/^PATH=/m);
      // What npm needs to reach the registry stays.
      expect(run).toContain('HTTPS_PROXY=http://proxy.example:3128\n');
    }
    expect(readFileSync(join(dir, 'output'), 'utf8')).toBe(`cli=${realpathSync(source)}/packages/cli/bin/shadowlap.js\n`);
  });
});
