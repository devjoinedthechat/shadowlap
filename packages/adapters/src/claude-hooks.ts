/**
 * Claude Code's hooks, as the Claude Agent SDK's fence (claude-agent-sdk.ts) needs to know them:
 * which tools a matcher picks, the query's own PreToolUse and PostToolUse hooks run inside the
 * fence's and their answers put together as Claude Code puts several together, and the PreToolUse
 * hooks of settings files, which Claude Code runs beside the fence, where nothing can run them inside.
 *
 * Claude Code runs every hook that matches a tool call at once. It decides between their permission
 * decisions by precedence (deny, then defer, ask and allow), but it takes `updatedInput` and
 * `updatedToolOutput` from whichever hook answered last, which its documentation leaves open and
 * which a hook's own timing decides. A hook beside the fence can so put back the input of a recorded
 * write the fence turned into a stand-in, and the write runs again for real. Run inside the fence,
 * the query's hooks answer first, in the order they are given, and the fence has the last word.
 */

/** A hook matcher as the SDK takes one: the tools it picks, its callbacks, and their timeout in seconds. */
export interface HookMatcherLike {
  matcher?: string | null;
  hooks: readonly unknown[];
  timeout?: number | null;
}

/** A hook callback as the SDK calls one. */
type Callback = (input: unknown, toolUseID: string | undefined, options: { signal: AbortSignal }) => unknown;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Whether a matcher picks a tool, by Claude Code's rules: none, "" or "*" pick every tool; one made
 * of letters, digits, `_`, `-`, spaces, `,` and `|` is a list of exact names; anything else is a
 * JavaScript regular expression, tested anywhere in the name. One that doesn't compile picks
 * nothing, or with `unsure` every tool, for a caller that must not miss one.
 */
export function matcherPicks(matcher: string | null | undefined, tool: string, unsure: 'none' | 'all' = 'none'): boolean {
  if (matcher === undefined || matcher === null || matcher === '' || matcher === '*') return true;
  if (/^[A-Za-z0-9_ ,|-]+$/.test(matcher)) return matcher.split(/[|,]/).some((m) => m.trim() === tool);
  try {
    return new RegExp(matcher).test(tool);
  } catch {
    return unsure === 'all';
  }
}

/** What one hook answered: its output, or that it ran out of time. */
type Answer = { output: Record<string, unknown> } | { timedOut: number };

/** The SDK's own default for a callback's timeout on PreToolUse and PostToolUse: the command hooks', 600 seconds. */
const DEFAULT_TIMEOUT_S = 600;

/**
 * The callbacks of `matchers` that pick `tool`, run at once as Claude Code runs them, each given the
 * input, the tool use id and a signal that aborts at its matcher's timeout or with `signal`. A
 * callback that throws answers `{}`, as it does under Claude Code: the call goes on as if it had
 * said nothing. An answer that isn't an object, or says `async`, has no say either.
 */
export async function runHooks(matchers: readonly HookMatcherLike[] | undefined, tool: string, input: unknown, toolUseID: string | undefined, signal: AbortSignal | undefined): Promise<Answer[]> {
  const picked = (matchers ?? []).filter((m) => matcherPicks(m.matcher, tool));
  const calls = picked.flatMap((m) => m.hooks.map((hook) => ({ hook: hook as Callback, timeout: typeof m.timeout === 'number' && m.timeout > 0 ? m.timeout : DEFAULT_TIMEOUT_S })));
  return Promise.all(
    calls.map(async ({ hook, timeout }): Promise<Answer> => {
      const controller = new AbortController();
      const abort = () => controller.abort(signal?.reason);
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<Answer>((resolve) => {
        timer = setTimeout(() => {
          controller.abort(new Error(`the hook did not answer within ${timeout} seconds`));
          resolve({ timedOut: timeout });
        }, timeout * 1000);
      });
      try {
        const ran = Promise.resolve()
          .then(() => hook(input, toolUseID, { signal: controller.signal }))
          .then(
            (out): Answer => ({ output: isRecord(out) && out.async !== true ? out : {} }),
            (): Answer => ({ output: {} }),
          );
        return await Promise.race([ran, late]);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    }),
  );
}

export type Decision = 'allow' | 'deny' | 'ask' | 'defer';
const RANK: Record<Decision, number> = { allow: 1, ask: 2, defer: 3, deny: 4 };

/** What several hooks answered, put together as Claude Code puts them together. */
export interface Combined {
  decision?: Decision;
  reason?: string;
  /** PreToolUse: the input the tool runs with, the last hook's (in the order given) that rewrote it. */
  updatedInput?: Record<string, unknown>;
  /** PostToolUse: what the model reads instead of the tool's output, the last hook's that replaced it. */
  output?: { value: unknown };
  /** PostToolUse: the MCP tool output the last hook replaced, under the older field. */
  mcpOutput?: { value: unknown };
  additionalContext?: string;
  /** The fields any event takes: shown to the person, and whether the agent goes on. */
  systemMessage?: string;
  stop?: { reason?: string };
  suppressOutput?: true;
}

/** The decision a hook's answer makes: `permissionDecision`, or the older `decision` (approve, block). */
function decisionOf(out: Record<string, unknown>, specific: Record<string, unknown>): { decision: Decision; reason?: string } | null {
  const d = specific.permissionDecision;
  if (d === 'allow' || d === 'deny' || d === 'ask' || d === 'defer') return { decision: d, ...(typeof specific.permissionDecisionReason === 'string' ? { reason: specific.permissionDecisionReason } : {}) };
  if (out.decision === 'block' || out.decision === 'approve') return { decision: out.decision === 'block' ? 'deny' : 'allow', ...(typeof out.reason === 'string' ? { reason: out.reason } : {}) };
  return null;
}

/**
 * Hooks' answers put together: the most restrictive decision, with its reason (deny, then defer,
 * ask and allow, as Claude Code documents it); the last rewrite of the input or the output, in the
 * order the hooks were given; every context and message, joined; a stop when any asks for one. A
 * hook that ran out of time blocks a PreToolUse call, as it does under Claude Code, and has no say
 * on a PostToolUse one.
 */
export function combine(answers: readonly Answer[], event: 'PreToolUse' | 'PostToolUse'): Combined {
  const out: Combined = {};
  const contexts: string[] = [];
  const messages: string[] = [];
  const decide = (decision: Decision, reason?: string) => {
    if (out.decision && RANK[decision] <= RANK[out.decision]) return;
    out.decision = decision;
    if (reason !== undefined) out.reason = reason;
    else delete out.reason;
  };
  for (const a of answers) {
    if ('timedOut' in a) {
      if (event === 'PreToolUse') decide('deny', `a PreToolUse hook did not answer within its timeout of ${a.timedOut} seconds`);
      continue;
    }
    const o = a.output;
    const specific = isRecord(o.hookSpecificOutput) ? o.hookSpecificOutput : {};
    const d = event === 'PreToolUse' ? decisionOf(o, specific) : null;
    if (d) decide(d.decision, d.reason);
    if (event === 'PreToolUse' && isRecord(specific.updatedInput)) out.updatedInput = specific.updatedInput;
    if (event === 'PostToolUse' && 'updatedToolOutput' in specific) out.output = { value: specific.updatedToolOutput };
    if (event === 'PostToolUse' && 'updatedMCPToolOutput' in specific) out.mcpOutput = { value: specific.updatedMCPToolOutput };
    if (typeof specific.additionalContext === 'string' && specific.additionalContext) contexts.push(specific.additionalContext);
    if (typeof o.systemMessage === 'string' && o.systemMessage) messages.push(o.systemMessage);
    if (o.continue === false) out.stop ??= typeof o.stopReason === 'string' ? { reason: o.stopReason } : {};
    if (o.suppressOutput === true) out.suppressOutput = true;
  }
  if (contexts.length) out.additionalContext = contexts.join('\n');
  if (messages.length) out.systemMessage = messages.join('\n');
  return out;
}

/** A combined answer as a hook returns it to Claude Code: `{}` when it says nothing. */
export function asOutput(c: Combined, event: 'PreToolUse' | 'PostToolUse'): Record<string, unknown> {
  const specific: Record<string, unknown> = {
    ...(c.decision ? { permissionDecision: c.decision } : {}),
    ...(c.decision && c.reason !== undefined ? { permissionDecisionReason: c.reason } : {}),
    ...(c.updatedInput ? { updatedInput: c.updatedInput } : {}),
    ...(c.output ? { updatedToolOutput: c.output.value } : {}),
    ...(c.mcpOutput ? { updatedMCPToolOutput: c.mcpOutput.value } : {}),
    ...(c.additionalContext ? { additionalContext: c.additionalContext } : {}),
  };
  return {
    ...(c.systemMessage ? { systemMessage: c.systemMessage } : {}),
    ...(c.stop ? { continue: false, ...(c.stop.reason ? { stopReason: c.stop.reason } : {}) } : {}),
    ...(c.suppressOutput ? { suppressOutput: true } : {}),
    ...(Object.keys(specific).length ? { hookSpecificOutput: { hookEventName: event, ...specific } } : {}),
  };
}

// ---- settings files ----

/** A PreToolUse entry of a settings file, which Claude Code runs beside the fence. */
export interface SettingsHook {
  /** Where it is: a file, or the query option that holds it. */
  source: string;
  matcher?: string;
}

/**
 * Where Claude Code finds settings for the query, as its options say: the sources it loads
 * (`settingSources`; all three when absent), its working folder, `settings` (a settings object,
 * JSON text or a file, as the CLI's `--settings` takes), `managedSettings`, and the environment the
 * CLI gets (`CLAUDE_CONFIG_DIR`, `HOME`).
 */
export interface SettingsPlaces {
  sources?: readonly string[] | null;
  cwd?: string | null;
  settings?: unknown;
  managedSettings?: unknown;
  env?: Readonly<Record<string, string | undefined>> | null;
  /** The managed settings file an organization deploys: by default where Claude Code reads it on this system; null for none. */
  managedFile?: string | null;
}

/** The managed settings file an organization deploys, where Claude Code reads it on this system. */
function managedFile(platform: string, path: typeof import('node:path')): string {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json';
  if (platform === 'win32') return path.win32.join('C:\\Program Files', 'ClaudeCode', 'managed-settings.json');
  return '/etc/claude-code/managed-settings.json';
}

/** The PreToolUse entries of one settings document, each with a hook. */
function preToolUse(settings: unknown, source: string): SettingsHook[] {
  if (!isRecord(settings) || !isRecord(settings.hooks) || !Array.isArray(settings.hooks.PreToolUse)) return [];
  return settings.hooks.PreToolUse.filter((e): e is Record<string, unknown> => isRecord(e) && Array.isArray(e.hooks) && e.hooks.length > 0).map((e) => ({ source, ...(typeof e.matcher === 'string' ? { matcher: e.matcher } : {}) }));
}

const load = (name: string): Promise<unknown> => import(/* webpackIgnore: true */ /* @vite-ignore */ name);

/**
 * The PreToolUse hooks of the settings Claude Code loads for the query, read as they are now (Claude
 * Code reloads a file that changes): the user's file (in `CLAUDE_CONFIG_DIR`, else `~/.claude`), the
 * project's and the local one in its working folder (the local one at the git repository's root
 * too), the query's `settings` and `managedSettings`, and the managed settings file. A file that
 * can't be read or parsed holds none: Claude Code skips it too.
 */
export async function settingsPreToolUse(places: SettingsPlaces, cwd: string): Promise<SettingsHook[]> {
  const fs = (await load('node:fs')) as typeof import('node:fs');
  const path = (await load('node:path')) as typeof import('node:path');
  const os = (await load('node:os')) as typeof import('node:os');
  const env = { ...process.env, ...(places.env ?? {}) };
  const sources = places.sources ?? ['user', 'project', 'local'];
  const read = (file: string): unknown => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  };
  const files: string[] = [];
  if (sources.includes('user')) files.push(path.join(env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), '.claude'), 'settings.json'));
  if (sources.includes('project')) files.push(path.join(cwd, '.claude', 'settings.json'));
  if (sources.includes('local')) {
    files.push(path.join(cwd, '.claude', 'settings.local.json'));
    // Claude Code keeps the local file at the root of the git repository the folder is in.
    for (let dir = cwd; ; dir = path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, '.git'))) {
        if (dir !== cwd) files.push(path.join(dir, '.claude', 'settings.local.json'));
        break;
      }
      if (path.dirname(dir) === dir) break;
    }
  }
  const managed = places.managedFile === undefined ? managedFile(process.platform, path) : places.managedFile;
  if (managed) files.push(managed);
  const found = files.flatMap((file) => preToolUse(read(file), file));
  // The query's own settings: an object, JSON text, or a file, as `--settings` takes them.
  const given = places.settings;
  if (isRecord(given)) found.push(...preToolUse(given, 'the query\'s settings option'));
  else if (typeof given === 'string' && given.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(given);
    } catch {
      parsed = read(path.resolve(cwd, given));
    }
    found.push(...preToolUse(parsed, isRecord(parsed) && given.trim().startsWith('{') ? 'the query\'s settings option' : path.resolve(cwd, given)));
  }
  if (isRecord(places.managedSettings)) found.push(...preToolUse(places.managedSettings, 'the query\'s managedSettings option'));
  return found;
}
