import { createRequire } from 'node:module';
import { basename } from 'node:path';

/**
 * What the sidecar knows of the preloads in a run's agent processes, and of the SDK versions they
 * call it with.
 *
 * `shadowlap run`, `replay` and `test` load a preload into every Node and Python process of the
 * agent: the network guard and in-process capture. Each says it loaded, once per process, with
 * `POST /v1/hello`. A process whose preload never loaded says nothing, and neither does its guard:
 * a Go or Bun agent, `python -I`, a launcher that reset the environment. So a run that made model or
 * tool calls and heard no hello is one the guard never watched, which its summary says, and which
 * `--guard block` fails.
 */

export type GuardMode = 'warn' | 'block' | 'off';

/** One process's hello. */
export interface Hello {
  runtime: string;
  runtimeVersion: string;
  pid: number;
  ppid: number;
  guard: GuardMode;
  capture: boolean;
}

/** What a run's preloads came to, as `endRun` reports it and the run keeps it (`RunMeta.preloads`). */
export interface PreloadReport {
  /** The guard the CLI started the agent with. */
  guard: GuardMode;
  /** Processes whose preload said it loaded, by runtime: `{ node: 2, python: 1 }`. */
  hellos: Record<string, number>;
  /** Why no preload loaded, when the run made model or tool calls and none did; else null. */
  missing: string | null;
  /** The processes that said they run with no guard, when the run has one (unguardedLine); else null. */
  unguarded: string | null;
  /** The run failed for it: under `--guard block`, nothing stopped a connection that bypassed Shadowlap. */
  failed: boolean;
}

/** The runtime the Claude Agent SDK's fence says hello for: the Claude Code CLI, which loads no preload. */
export const CLAUDE_CODE_RUNTIME = 'claude-code';

/**
 * The summary's line for processes of the agent that said they run with no network guard while the
 * run has one, under `guard`, or null when none did: the Claude Code CLI the Claude Agent SDK runs,
 * which loads no preload (its fence says so for it), and a Node or Python process whose guard could
 * not start. Nothing watched their connections, so under `--guard block` the run fails.
 */
export function unguardedLine(hellos: Iterable<Hello>, guard: GuardMode): string | null {
  if (guard === 'off') return null;
  const off = [...hellos].filter((h) => h.guard === 'off');
  if (!off.length) return null;
  const claude = off.filter((h) => h.runtime === CLAUDE_CODE_RUNTIME).length;
  const others = countHellos(off.filter((h) => h.runtime !== CLAUDE_CODE_RUNTIME));
  const parts = [
    ...(claude ? [`the Claude Code CLI the Claude Agent SDK runs, which loads no Shadowlap preload, so the connections Claude Code makes itself (WebFetch, an HTTP MCP server) are not watched`] : []),
    ...Object.entries(others).map(([runtime, n]) => `${n} ${runtime === 'node' ? 'Node' : runtime === 'python' ? 'Python' : runtime} process${n === 1 ? '' : 'es'} whose preload loaded with the guard off`),
  ];
  const what = parts.join('; and ');
  return guard === 'block'
    ? `The network guard could not watch every process of the agent: ${what}. Under --guard block nothing stops such a connection, so the run fails. Replay it with --guard warn to accept connections the guard can't watch.`
    : `The network guard could not watch every process of the agent: ${what}. A connection one of them made that bypassed Shadowlap went unseen.`;
}

/** More hellos than this in one run are counted, not kept: a fork bomb of short processes says nothing more. */
export const MAX_HELLOS = 1_000;

const RUNTIME = /^[a-z][a-z0-9-]{0,19}$/;

/** A hello's body, checked and bounded, or null for one that isn't. */
export function parseHello(body: unknown): Hello | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const runtime = typeof b.runtime === 'string' && RUNTIME.test(b.runtime) ? b.runtime : null;
  const pid = typeof b.pid === 'number' && Number.isSafeInteger(b.pid) && b.pid > 0 ? b.pid : null;
  if (!runtime || pid === null) return null;
  return {
    runtime,
    runtimeVersion: typeof b.runtimeVersion === 'string' ? b.runtimeVersion.slice(0, 40) : '',
    pid,
    ppid: typeof b.ppid === 'number' && Number.isSafeInteger(b.ppid) ? b.ppid : 0,
    guard: b.guard === 'block' || b.guard === 'off' ? b.guard : 'warn',
    capture: b.capture === true,
  };
}

/** Processes per runtime, each process once. */
export function countHellos(hellos: Iterable<Hello>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const h of hellos) out[h.runtime] = (out[h.runtime] ?? 0) + 1;
  return out;
}

/** A command's words as names: the file name without a Windows extension, lowercased. */
const word = (w: string) => basename(w).toLowerCase().replace(/\.(exe|cmd|bat)$/, '');

/** The Python flags among a command's words that skip the sitecustomize the preload is (`-I`, `-E`, `-S`, also combined, as `-Es`). */
function pythonSkips(argv: readonly string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    if (!/^python[\d.]*w?$/.test(word(argv[i]!))) continue;
    for (let j = i + 1; j < argv.length; j++) {
      const a = argv[j]!;
      if (!a.startsWith('-') || a === '-' || a.startsWith('--')) break;
      if (a === '-X' || a === '-W') {
        j++;
        continue;
      }
      // -c and -m end Python's own options: what follows belongs to the program.
      const m = /^-([A-Za-z]+)$/.exec(a);
      if (!m) break;
      const flag = [...m[1]!].find((c) => c === 'I' || c === 'E' || c === 'S');
      if (flag) return `-${flag}`;
      if (/[cm]/.test(m[1]!)) break;
    }
  }
  return null;
}

/**
 * Why no preload loaded, as far as the agent's command shows it: a runtime that loads none (Bun,
 * Deno), Python told to skip its sitecustomize, a launcher that resets the environment, or
 * `opentelemetry-instrument`, whose own sitecustomize comes first. Null when it shows nothing.
 */
export function shownCause(command: readonly string[]): string | null {
  // A shell's command (`sh -c "bun agent.ts"`) is read word by word too.
  const argv = command.flatMap((a) => a.split(/\s+/)).filter(Boolean);
  const words = argv.map(word);
  if (words.some((w) => w === 'bun' || w === 'bunx')) return 'The command runs Bun, which loads no Node preload';
  if (words.includes('deno')) return 'The command runs Deno, which loads no Node preload';
  const skip = pythonSkips(argv);
  if (skip === '-I') return 'The command runs Python with -I, which leaves out PYTHONPATH, where Shadowlap puts its sitecustomize';
  if (skip === '-E') return 'The command runs Python with -E, which ignores PYTHONPATH, where Shadowlap puts its sitecustomize';
  if (skip === '-S') return 'The command runs Python with -S, which skips the site module that loads sitecustomize';
  if (words.includes('opentelemetry-instrument')) return 'The command runs opentelemetry-instrument, whose own sitecustomize comes first on PYTHONPATH and loads no other';
  const env = words.indexOf('env');
  if (env !== -1 && argv.slice(env + 1).some((a) => a === '-i' || a === '-' || a === '--ignore-environment')) return 'The command runs env -i, which starts the agent without NODE_OPTIONS and PYTHONPATH';
  if (words.includes('sudo')) return 'The command runs sudo, which resets the environment, NODE_OPTIONS and PYTHONPATH with it';
  const container = words.findIndex((w) => w === 'docker' || w === 'podman');
  if (container !== -1 && argv.slice(container + 1).some((a) => a === 'run' || a === 'exec')) return 'The agent runs in a container, which gets none of the environment shadowlap gives it';
  return null;
}

/** The likely causes, when the command shows none. */
const LIKELY =
  'Likely the agent runs on a runtime with no preload (Go, Rust, Java, Bun, Deno), a launcher reset its environment (env -i, sudo, docker exec), a script set NODE_OPTIONS or PYTHONPATH anew, or Python ran with -I, -E or -S';

/** The summary's line for a run that made model or tool calls with no preload loaded, under `guard`. */
export function missingPreload(argv: readonly string[], calls: { api: number; tool: number }, guard: GuardMode): string {
  const made = [calls.api ? `${calls.api} model call${calls.api === 1 ? '' : 's'}` : '', calls.tool ? `${calls.tool} tool call${calls.tool === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ');
  const cause = shownCause(argv) ?? LIKELY;
  const head = `No Shadowlap preload loaded in the agent's processes, though the run made ${made}`;
  return guard === 'block'
    ? `${head}: under --guard block nothing stopped a connection that bypassed Shadowlap, so the run fails. ${cause}. Run the agent on Node or Python with the environment shadowlap gives it, or with --guard warn to accept a run the guard can't watch; shadowlap doctor says more.`
    : `${head}: the network guard never watched it, so a connection that bypassed Shadowlap went unseen, and in-process capture never ran. ${cause}. shadowlap doctor says more.`;
}

// ------------------------------------------------------------------------------- SDK versions

const require = createRequire(import.meta.url);

/** This sidecar's version, the CLI's: they are released together. */
export const SIDECAR_VERSION: string = (require('../package.json') as { version: string }).version;

/** `node/0.1.0` or `python/0.1.0`, as the SDKs send it in `x-shadowlap-sdk`, or null. */
export function parseSdkHeader(value: string | undefined): { family: string; version: string; majorMinor: string } | null {
  const m = /^([a-z][a-z0-9-]{0,19})\/((\d{1,6})\.(\d{1,6})(?:\.\d{1,9})?(?:[-+][0-9A-Za-z.-]{1,40})?)$/.exec(value?.trim() ?? '');
  return m ? { family: m[1]!, version: m[2]!, majorMinor: `${Number(m[3])}.${Number(m[4])}` } : null;
}

/** The major.minor of a version: `0.1`. */
export const majorMinor = (version: string): string => /^(\d+)\.(\d+)/.exec(version)?.slice(1, 3).map(Number).join('.') ?? version;

/** The line for an SDK whose major.minor differs from this CLI's, or null when it matches. */
export function sdkMismatch(header: string | undefined, own: string = SIDECAR_VERSION): string | null {
  const sdk = parseSdkHeader(header);
  if (!sdk || sdk.majorMinor === majorMinor(own)) return null;
  const mine = majorMinor(own);
  const install = sdk.family === 'python' ? `pip install 'shadowlap==${mine}.*'` : sdk.family === 'node' ? `npm install @shadowlap/sdk@${mine}` : null;
  const name = sdk.family === 'python' ? 'Python SDK' : sdk.family === 'node' ? 'Node SDK' : `${sdk.family} SDK`;
  return `The agent's Shadowlap ${name} is ${sdk.version} and this CLI is ${own}: they work together at the same major.minor version. ${install ? `Install the SDK that matches the CLI (${install}), or the CLI that matches the SDK.` : 'Use the SDK and CLI of the same version.'}`;
}
