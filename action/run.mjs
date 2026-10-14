// The GitHub Action's work: find the recordings, run `shadowlap test` on them, and report through the
// job summary, annotations and step outputs. Inputs arrive as environment variables from action.yml,
// so this runs the same on a laptop: SHADOWLAP_CLI=... RECORDINGS='goldens/*' node action/run.mjs
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const env = process.env;
const input = (name, fallback = '') => (env[`INPUT_${name}`] ?? fallback).trim();
const bool = (name, fallback) => {
  const v = input(name, String(fallback)).toLowerCase();
  if (!['true', 'false'].includes(v)) fail(`input ${name.toLowerCase().replace(/_/g, '-')} must be true or false, not "${v}"`);
  return v === 'true';
};
function fail(message) {
  process.stdout.write(`::error title=Shadowlap::${message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}\n`);
  process.exit(1);
}

const cli = env.SHADOWLAP_CLI;
if (!cli || !existsSync(cli)) fail(`the Shadowlap CLI was not found at ${cli ?? '(unset)'}`);
const workdir = resolve(input('WORKING_DIRECTORY', '.') || '.');
const writes = input('WRITES', 'block');
if (!['block', 'stub', 'allow'].includes(writes)) fail(`input writes must be block, stub or allow, not "${writes}"`);
const guard = input('GUARD', 'block');
if (!['block', 'warn', 'off'].includes(guard)) fail(`input guard must be block, warn or off, not "${guard}"`);

/** A pattern with `*` or `?` in its last path segment, matched against that directory; anything else as given. */
function expand(pattern) {
  if (/[*?]/.test(dirname(pattern))) fail(`only the last part of a recordings path may contain a wildcard: ${pattern}`);
  if (!/[*?]/.test(basename(pattern))) return [pattern];
  const dir = resolve(workdir, dirname(pattern));
  if (!existsSync(dir)) return [];
  const re = new RegExp(`^${basename(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
  return readdirSync(dir)
    .filter((name) => re.test(name) && statSync(join(dir, name)).isDirectory())
    .sort()
    .map((name) => join(dirname(pattern), name));
}
const patterns = input('RECORDINGS', 'goldens/*').split(/[\n\s]+/).filter(Boolean);
const packs = [...new Set(patterns.flatMap(expand))].filter((p) => existsSync(join(resolve(workdir, p), 'run.json')));
if (packs.length === 0) fail(`no recordings found for ${patterns.join(' ')} in ${workdir}. A recording is a directory written by shadowlap pack, with a run.json inside.`);

const out = mkdtempSync(join(env.RUNNER_TEMP ?? tmpdir(), 'shadowlap-'));
const json = join(out, 'shadowlap-report.json');
const markdown = join(out, 'shadowlap-report.md');
const junit = input('JUNIT') ? resolve(workdir, input('JUNIT')) : join(out, 'shadowlap-junit.xml');
const args = [cli, 'test', ...packs, '--json', json, '--markdown', markdown, '--junit', junit, '--writes', writes, '--guard', guard];
if (bool('ONLINE', false)) args.push('--online');
if (bool('ANNOTATIONS', true)) args.push('--annotations');

process.stdout.write(`shadowlap test ${packs.join(' ')}\n`);
const r = spawnSync(process.execPath, args, { cwd: workdir, stdio: 'inherit', env: { ...env, SHADOWLAP_TELEMETRY: env.SHADOWLAP_TELEMETRY ?? '0' } });
if (!existsSync(json)) fail(`shadowlap test did not finish (exit ${r.status ?? r.signal}); its output is above`);

const report = JSON.parse(readFileSync(json, 'utf8'));
const outputs = { passed: report.passed, failed: report.failed, 'report-json': json, 'report-markdown': markdown, junit };
if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join(''));
if (bool('SUMMARY', true) && env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, readFileSync(markdown, 'utf8'));

if (report.failed && bool('FAIL_ON_DIVERGENCE', true)) process.exit(1);
