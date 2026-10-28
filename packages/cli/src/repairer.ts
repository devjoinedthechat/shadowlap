import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { estimateCost, safeLine, type Anchor, type Block, type Conversation, type Price, type ProposedEdit, type Usage } from '@shadowlap/engine';
import { installedGlobally } from './installed.js';
import { killTree } from './kill-tree.js';
import { startCommand } from './start-command.js';

/**
 * The model `shadowlap repair` asks for candidate fixes: the only model call in the repair loop that is
 * not the agent's own. It is the user's, configured rather than built in, from any vendor: Anthropic
 * through the official SDK; anything that speaks OpenAI's Chat Completions (OpenAI, OpenRouter,
 * Ollama, vLLM) over plain HTTP; or the user's own Claude Code, run in print mode. It proposes; it
 * never decides what is kept.
 */

export interface Repairer {
  provider: 'anthropic' | 'openai' | 'claude-code';
  model: string;
  /** Overrides the provider's base URL (ANTHROPIC_BASE_URL or OPENAI_BASE_URL otherwise). */
  baseUrl?: string;
}

/** The default when only `anthropic` is named: the current Opus. */
export const DEFAULT_ANTHROPIC_REPAIRER = 'claude-opus-5-5';

/**
 * The longest answer a repairer is asked for, in tokens, whichever it is: the Anthropic request's
 * `max_tokens`, an OpenAI-compatible one's `max_completion_tokens`, and Claude Code's
 * `CLAUDE_CODE_MAX_OUTPUT_TOKENS`. What asking it could cost is worked out from it (repairerMost).
 */
export const REPAIRER_ANSWER_TOKENS = 16_000;

/** The turns Claude Code may take for a repair (its `--max-turns`): each an answer of up to REPAIRER_ANSWER_TOKENS. */
export const CLAUDE_CODE_TURNS = 2;

/**
 * `anthropic`, `anthropic:claude-fable-5-1`, `openai:gpt-6-astra`, `claude-code` or
 * `claude-code:claude-opus-5-5`. Plain `claude-code` leaves the model to Claude Code's own setting.
 */
/**
 * A model name as a provider writes one: `claude-opus-5-5`, `gpt-6-astra`,
 * `us.anthropic.claude-opus-4-5:0`, `models/gemini-2.5-pro`, `openai/gpt-4o`. It never starts like a
 * flag and holds no space, quote, backslash or shell metacharacter, so it can't turn into a flag or
 * a command when it reaches `claude --model`, a batch file's arguments on Windows, or an HTTP body.
 */
const MODEL = /^[A-Za-z0-9][\w.:/@-]{0,199}$/;

export function parseRepairer(spec: string): Repairer {
  const m = /^(anthropic|openai|claude-code)(?::(.+))?$/.exec(spec.trim());
  if (!m) throw new Error(`a repairer is provider:model, such as anthropic:${DEFAULT_ANTHROPIC_REPAIRER}, openai:<model> or claude-code, got "${spec}"`);
  const provider = m[1] as Repairer['provider'];
  const model = m[2]?.trim();
  if (!model && provider === 'openai') throw new Error('an openai repairer needs a model: openai:<model>');
  if (model && !MODEL.test(model)) throw new Error(`a repairer's model is a model name, such as ${DEFAULT_ANTHROPIC_REPAIRER}, got "${model}"`);
  return { provider, model: model || (provider === 'anthropic' ? DEFAULT_ANTHROPIC_REPAIRER : '') };
}

/**
 * Why the repairer could not be asked, or its answer could not be used. `what` says it in a few
 * words (`claude was not found`), as a fix's Repair step shows it; the message adds what to do about
 * it, or the detail a log needs (`claude was not found: install Claude Code, or set …`).
 */
export class RepairerError extends Error {
  constructor(
    readonly what: string,
    detail?: string | null,
  ) {
    super(detail ? `${what}: ${detail}` : what);
    this.name = 'RepairerError';
  }
}

export interface RepairerAnswer {
  diagnosis: string;
  edits: ProposedEdit[];
  /** The model that answered: a server-side fallback can differ from the one asked. */
  served: string;
  usage: Usage;
  /** USD, or null when the model has no price. */
  cost: number | null;
}

const SCHEMA = {
  type: 'object',
  properties: {
    diagnosis: { type: 'string', description: 'Why the agent chose wrong, in general terms.' },
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          anchor: { type: 'integer', description: 'The number of the span to rewrite.' },
          replace: { type: 'string', description: 'The whole new text of that span.' },
          strategy: { type: 'string', description: 'The change in a few words, as a commit title.' },
          why: { type: 'string', description: 'Why it makes the right choice clear in general.' },
        },
        required: ['anchor', 'replace', 'strategy', 'why'],
        additionalProperties: false,
      },
    },
  },
  required: ['diagnosis', 'candidates'],
  additionalProperties: false,
} as const;

/** One failing run's evidence for the repairer: where it was lost, and a path from there that passed. */
export interface RepairCase {
  step: number;
  steps: number;
  callNo: number;
  /** When the run was lost gradually around two calls, or between two, and no one call lost it: their places. `step` is the first, where it is shown. */
  range?: { fromStep: number; toStep: number; gradual?: true };
  /** The conversation the model saw at the blamed call. */
  conversation: Conversation | null;
  recorded: Block[];
  rescued: Block[];
  /** How the run fails the oracle. */
  failures: string[];
  /** The rescue was a stronger model, not asking the same one again. */
  rescuedBy: string | null;
}

export interface RepairPromptInput {
  oracle: string[];
  system: string;
  tools: Array<{ name: string; description: string }>;
  cases: RepairCase[];
  anchors: Anchor[];
  candidates: number;
}

const SYSTEM = `You improve AI agents by rewriting the instructions they are given: the system prompt and the descriptions of their tools.

You will see runs of an agent that failed, the model call where each run was lost, what the agent did there, and what it did in a run from the same point that passed. Find what in the instructions let the agent make the wrong choice, and propose rewrites that make the right choice clear for every case like these, including cases you have not seen.`;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)} … (${s.length - n} more characters)` : s);

function describeBlock(b: Block | Conversation['turns'][number]['blocks'][number]): string | null {
  switch (b.type) {
    case 'text':
      return b.text.trim() ? clip(b.text.trim(), 1500) : null;
    case 'tool_call':
      return `→ ${b.name}(${clip(JSON.stringify(b.input ?? {}), 600)})`;
    case 'tool_result':
      return `${b.isError ? '(error) ' : ''}${clip(b.content, 1500)}`;
    default:
      return null;
  }
}

/** The conversation at the blamed call, latest last, without the system prompt (shown on its own). */
function renderConversation(c: Conversation | null, turns = 16): string {
  if (!c) return '  (not available)';
  const body = c.turns.filter((t, i) => !(t.role === 'system' && c.turns.slice(0, i).every((x) => x.role === 'system')));
  const shown = body.slice(-turns);
  const lines = shown.flatMap((t) => {
    const parts = t.blocks.map(describeBlock).filter((x): x is string => x !== null);
    return parts.length ? [`  ${t.role}: ${parts.join('\n    ')}`] : [];
  });
  return [...(body.length > shown.length ? [`  (${body.length - shown.length} earlier turns not shown)`] : []), ...lines].join('\n');
}

const answer = (blocks: Block[]) => blocks.map(describeBlock).filter(Boolean).join(' ') || '(nothing)';

export function buildRepairPrompt(input: RepairPromptInput): { system: string; user: string } {
  const sections: string[] = [];
  sections.push(`## What a run must do\n\n${input.oracle.map((o) => `- ${o}`).join('\n')}`);
  sections.push(`## The agent's instructions\n\nSystem prompt:\n${input.system || '(none)'}\n\nTools:\n${input.tools.map((t) => `- ${t.name}: ${t.description || '(no description)'}`).join('\n') || '(none)'}`);
  input.cases.forEach((c, i) => {
    sections.push(
      [
        `## Failed run ${i + 1} of ${input.cases.length}: ${c.range ? `lost ${c.range.gradual ? 'gradually, around' : 'between'} model calls ${c.range.fromStep} and ${c.range.toStep} of ${c.steps}, where no one call lost it; shown at model call ${c.step}` : `lost at model call ${c.step} of ${c.steps}`}`,
        `It fails because: ${c.failures.join('; ')}.`,
        `The conversation up to that call:\n${renderConversation(c.conversation)}`,
        `What the agent did there: ${answer(c.recorded)}`,
        `What it did there in a run that passed${c.rescuedBy ? ` (with the model ${c.rescuedBy})` : ''}: ${answer(c.rescued)}`,
      ].join('\n\n'),
    );
  });
  sections.push(
    `## Text you may rewrite\n\nEach span appears exactly once in the agent's source, in the file named. A candidate replaces one whole span with new text.\n\n${input.anchors.map((a) => `[${a.id}] ${a.surface}, in ${a.file}: ${a.text}`).join('\n')}`,
  );
  sections.push(
    `## Rules\n\n- Fix the rule, not the case. Never mention names, ids, amounts, dates or any other detail of these conversations: a fix that names them is rejected, and it would not hold for the next case.\n- Change as little as you can. Keep what a span says unless it is wrong.\n- Give up to ${input.candidates} candidates, each a different strategy: for example, stating the rule plainly in the system prompt, saying in a tool's description when not to use it, or saying which tool to use instead.\n- A span on one line stays on one line. A span from a code file goes into a string there, so write it without quotation marks, apostrophes or backslashes; a span from a Markdown or text file is prose.\n- A placeholder in a span, such as {limit}, \${limit}, {{ limit }} or %(limit)s, is filled in when the agent builds its prompt. Keep each one exactly as it is written, as many times as the span has it, and write no placeholder of your own, nor any brace: a rewrite that adds one is rejected.\n- In \`strategy\`, name the change in a few words, as a commit title would.`,
  );
  return { system: SYSTEM, user: sections.join('\n\n') };
}

/** Models that accept `effort` and structured outputs, and those that take the server-side refusal fallback. */
const EFFORT = /^claude-(fable|mythos|opus-5|opus-4-[5-8]|sonnet-5|sonnet-4-6)/;
const FALLBACK = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

function parsed(raw: unknown): { diagnosis: string; edits: ProposedEdit[] } {
  const o = raw as { diagnosis?: unknown; candidates?: unknown };
  if (!o || typeof o !== 'object' || !Array.isArray(o.candidates)) throw new RepairerError('the repairer did not answer with candidates');
  const edits = o.candidates.flatMap((c: unknown): ProposedEdit[] => {
    const x = c as Record<string, unknown>;
    if (!x || typeof x.anchor !== 'number' || typeof x.replace !== 'string') return [];
    return [{ anchor: x.anchor, replace: x.replace, strategy: typeof x.strategy === 'string' ? safeLine(x.strategy).slice(0, 120) : 'rewrite', why: typeof x.why === 'string' ? x.why : '' }];
  });
  return { diagnosis: typeof o.diagnosis === 'string' ? o.diagnosis : '', edits };
}

function jsonIn(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    try {
      if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    } catch {
      // braces around something else
    }
    throw new RepairerError('the repairer did not answer with JSON');
  }
}

/** How long the repairer has to answer, unless `--repairer-timeout` or `repair.timeout` says otherwise. */
export const DEFAULT_REPAIRER_TIMEOUT_MS = 10 * 60_000;

/** A limit as a person reads it: `10 minutes`, `90 seconds`, `1 second`. */
export function describeLimit(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s >= 120 && s % 60 === 0) return `${s / 60} minutes`;
  return `${s} second${s === 1 ? '' : 's'}`;
}

/** Why a repairer that took longer than it may gave no candidates, and what to do about it. */
export const repairerTimedOut = (ms: number) => new RepairerError(`it did not answer within ${describeLimit(ms)}`, 'give it longer with --repairer-timeout <seconds>, or repair.timeout in shadowlap.config.json');

/**
 * Asks the repairer for candidates, and gives up once `o.timeoutMs` has passed (10 minutes by
 * default): a request still open is aborted, and a Claude Code still running is stopped, so a
 * repairer that hangs never holds the repair, or a CI job, until something else kills it. `o.signal`
 * aborts it the same way, as Ctrl-C does.
 */
export async function askRepairer(r: Repairer, prompt: { system: string; user: string }, prices?: Record<string, Price>, o: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<RepairerAnswer> {
  const timeoutMs = o.timeoutMs ?? DEFAULT_REPAIRER_TIMEOUT_MS;
  const abort = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, timeoutMs);
  const stop = () => abort.abort();
  o.signal?.addEventListener('abort', stop, { once: true });
  if (o.signal?.aborted) abort.abort();
  try {
    if (abort.signal.aborted) throw new RepairerError('it was stopped before it answered');
    const asked = r.provider === 'claude-code' ? askClaudeCode(r, prompt, prices, abort.signal) : r.provider === 'anthropic' ? askAnthropic(r, prompt, prices, abort.signal, timeoutMs) : askOpenAI(r, prompt, prices, abort.signal);
    return await asked;
  } catch (err) {
    if (timedOut) throw repairerTimedOut(timeoutMs);
    if (abort.signal.aborted) throw new RepairerError('it was stopped before it answered');
    throw err;
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener('abort', stop);
  }
}

/**
 * Variables Claude Code sets for the processes it runs, describing its own session. A `claude`
 * started with them believes it is nested in that session; they are dropped, and nothing else is.
 */
const CLAUDE_SESSION_VARS = ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_BRIDGE_SESSION_ID', 'CLAUDE_CODE_REMOTE_SESSION_ID', 'CLAUDE_PID', 'CLAUDE_AGENT_SDK_VERSION'];

/**
 * How Claude Code is started for a repair, where the only input is injectable content (a recorded
 * agent's prompts and tool output): print mode, no tools of any kind, no MCP server, no hook, no
 * project or user settings, and the answer held to the schema. The system prompt is read from
 * `systemFile`, replacing the default, so no CLAUDE.md reaches it. The prompt itself goes on stdin.
 *
 * - `--tools ''` removes every built-in tool, and `--disallowed-tools mcp__*` every MCP tool, so a
 *   candidate the model proposes is text and nothing it says runs a command or reads a file.
 * - `--strict-mcp-config` with no `--mcp-config` loads no MCP server, so none a project's `.mcp.json`
 *   or the user's config names connects.
 * - `--setting-sources ''` loads no user, project or local settings, so a hook, a permission rule or
 *   a plugin one of them carries never runs on this content (checked against https://code.claude.com/docs:
 *   settings and CLAUDE.md arrive through those sources, and an empty list is how to load none).
 *   Managed policy settings, set by an administrator rather than by this content, still apply, and
 *   the user's own sign-in (an API key or an OAuth login, read from the environment or the keychain,
 *   not from settings) is untouched, so the repair is still billed to the account they chose.
 *
 * Neither flag holds a line break on the command line, which on Windows an npm-installed `claude` (a
 * batch file, run through cmd.exe) could not carry.
 */
export function claudeCodeArgs(systemFile: string, model: string | null): string[] {
  return [
    '-p',
    '--output-format',
    'json',
    '--tools',
    '',
    '--disallowed-tools',
    'mcp__*',
    '--strict-mcp-config',
    '--setting-sources',
    '',
    '--max-turns',
    '2',
    '--system-prompt-file',
    systemFile,
    '--json-schema',
    JSON.stringify(SCHEMA),
    ...(model ? ['--model', model] : []),
  ];
}

/**
 * The user's own Claude Code, in print mode: `claude -p` with the prompt on stdin, no tools, and the
 * answer held to the schema. It runs in an empty directory, so no project's instructions reach the
 * prompt; its system prompt is a file beside that directory. Shadowlap never sees how Claude Code is
 * signed in; it runs the binary the user installed, through cmd.exe when that is a batch file.
 */
async function askClaudeCode(r: Repairer, prompt: { system: string; user: string }, prices: Record<string, Price> | undefined, signal: AbortSignal): Promise<RepairerAnswer> {
  const bin = process.env.SHADOWLAP_CLAUDE || 'claude';
  const env = { ...process.env };
  for (const v of CLAUDE_SESSION_VARS) delete env[v];
  // Each of its turns answers within the limit the budget check counts on, or a lower one already set.
  const set = Number(process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS);
  env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(Number.isInteger(set) && set > 0 && set < REPAIRER_ANSWER_TOKENS ? set : REPAIRER_ANSWER_TOKENS);
  const dir = mkdtempSync(join(tmpdir(), 'shadowlap-repairer-'));
  const cwd = join(dir, 'work');
  mkdirSync(cwd);
  const systemFile = join(dir, 'system-prompt.md');
  writeFileSync(systemFile, prompt.system);
  const start = startCommand(bin, claudeCodeArgs(systemFile, r.model || null), { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  const code = await new Promise<number>((resolveCode, reject) => {
    const child = spawn(start.command, start.args, start.options);
    // Past the time limit, or on Ctrl-C: stopped, with what it started (on Windows, cmd.exe's tree).
    const end = () => {
      killTree(child, 'SIGTERM');
      setTimeout(() => killTree(child, 'SIGKILL'), 3_000).unref();
    };
    if (signal.aborted) end();
    else signal.addEventListener('abort', end, { once: true });
    child.on('close', () => signal.removeEventListener('abort', end));
    child.stdout!.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr!.on('data', (d: Buffer) => (stderr += d.toString()));
    // Not found, or found and not runnable (no execute bit, a directory): either way it can't be asked.
    child.on('error', (err: NodeJS.ErrnoException) => reject(err.code === 'ENOENT' ? new RepairerError(`${bin} was not found`, 'install Claude Code, or set SHADOWLAP_CLAUDE to its path') : new RepairerError(`${bin} could not be run`, `${err.message}; check that it is Claude Code's binary and that you may run it, or set SHADOWLAP_CLAUDE to the one to run`)));
    // On 'close', not 'exit': the last of stdout can arrive after the process exits, through
    // cmd.exe most of all, and the report is read whole.
    child.on('close', (c) => resolveCode(c ?? 1));
    // A claude that exits before reading its prompt (a bad flag, say) closes stdin under us: its
    // exit and stderr say why, not an EPIPE.
    child.stdin!.on('error', () => {});
    child.stdin!.end(prompt.user);
  }).finally(() => rmSync(dir, { recursive: true, force: true }));
  let d: { is_error?: boolean; result?: string; structured_output?: unknown; modelUsage?: Record<string, unknown>; total_cost_usd?: number; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } };
  try {
    d = JSON.parse(stdout) as typeof d;
  } catch {
    throw new RepairerError(`Claude Code did not answer with its JSON report (exit ${code})`, stderr.trim() ? safeLine(stderr.trim().split('\n').at(-1)!) : null);
  }
  if (d.is_error) throw new RepairerError('Claude Code answered with an error', safeLine(String(d.result ?? 'no detail')));
  const out = parsed(d.structured_output ?? jsonIn(d.result ?? ''));
  const served = Object.keys(d.modelUsage ?? {})[0] ?? (r.model || 'claude-code');
  const u = d.usage ?? {};
  const usage: Usage = { inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0, ...(u.cache_read_input_tokens ? { cacheReadInputTokens: u.cache_read_input_tokens } : {}), ...(u.cache_creation_input_tokens ? { cacheCreationInputTokens: u.cache_creation_input_tokens } : {}) };
  // Claude Code's own estimate, at API prices, whatever it is signed in with.
  return { ...out, served, usage, cost: typeof d.total_cost_usd === 'number' ? d.total_cost_usd : estimateCost(served, usage, prices) };
}

// The SDK is imported from where this CLI is installed, so a global CLI needs a global SDK beside it:
// one in the project's node_modules is never found.
const SDK_MISSING = () => new RepairerError('the Anthropic SDK is not installed', `an anthropic repairer needs it, and Shadowlap does not install it for everyone: npm install${installedGlobally() ? ' -g' : ''} @anthropic-ai/sdk`);
const REFUSED = () => new RepairerError('the Anthropic API refused the credentials', 'set ANTHROPIC_API_KEY, or run ant auth login');

/** Why the SDK sent nothing: it refuses before it sends when it finds no key, token or profile to sign in with. */
function unsent(err: unknown): RepairerError {
  const said = err instanceof Error ? err.message : String(err);
  if (/could not resolve authentication method/i.test(said)) return new RepairerError('no Anthropic credentials', 'set ANTHROPIC_API_KEY, or run ant auth login');
  return new RepairerError('the Anthropic SDK could not send the request', said);
}

/**
 * Why the repairer can't be asked, found out before a repair spends anything on blame, or null. An
 * Anthropic repairer is asked of the Models API (`GET /v1/models/<model>`, which reads no prompt and
 * spends no tokens) with the credentials it would ask with: the SDK finds none to sign in with, or
 * the API refuses them. Anything else (a gateway with no Models API, a model it doesn't list, a
 * server out of reach) tells nothing for certain, so it is null, and asking finds out. Other
 * repairers are found out when they are asked.
 */
export async function cannotAsk(r: Repairer): Promise<RepairerError | null> {
  if (r.provider !== 'anthropic') return null;
  let sdk: typeof import('@anthropic-ai/sdk');
  try {
    sdk = await import('@anthropic-ai/sdk');
  } catch {
    return SDK_MISSING();
  }
  const Anthropic = sdk.default;
  try {
    const client = new Anthropic(r.baseUrl ? { baseURL: r.baseUrl } : {});
    await client.models.retrieve(r.model, {}, { maxRetries: 0, timeout: 15_000 });
    return null;
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return REFUSED();
    if (err instanceof Anthropic.APIError) return null;
    return unsent(err);
  }
}

async function askAnthropic(r: Repairer, prompt: { system: string; user: string }, prices: Record<string, Price> | undefined, signal: AbortSignal, timeoutMs: number): Promise<RepairerAnswer> {
  // Neither a dependency nor a peer of the CLI: installed by those who ask Claude for fixes, and by nobody else.
  let sdk: typeof import('@anthropic-ai/sdk');
  let helpers: typeof import('@anthropic-ai/sdk/helpers/beta/json-schema');
  try {
    sdk = await import('@anthropic-ai/sdk');
    helpers = await import('@anthropic-ai/sdk/helpers/beta/json-schema');
  } catch {
    throw SDK_MISSING();
  }
  const Anthropic = sdk.default;
  const { betaJSONSchemaOutputFormat } = helpers;
  // Credentials come from the environment (ANTHROPIC_API_KEY, or a profile from `ant auth login`).
  const client = new Anthropic(r.baseUrl ? { baseURL: r.baseUrl } : {});
  let message;
  try {
    message = await client.beta.messages.parse({
      model: r.model,
      max_tokens: REPAIRER_ANSWER_TOKENS,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
      output_config: { ...(EFFORT.test(r.model) ? { effort: 'high' as const } : {}), format: betaJSONSchemaOutputFormat(SCHEMA) },
      // On a policy decline the API answers from a fallback model in the same call.
      ...(FALLBACK.has(r.model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
    }, { signal, timeout: timeoutMs });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw REFUSED();
    if (err instanceof Anthropic.NotFoundError) throw new RepairerError(`the Anthropic API has no model ${r.model}`);
    if (err instanceof Anthropic.APIError) throw new RepairerError(`the Anthropic API answered ${(err.status as number | undefined) ?? 'with an error'}`, err.message);
    throw unsent(err);
  }
  if (message.stop_reason === 'refusal') throw new RepairerError('the repairer declined to answer');
  if (message.stop_reason === 'max_tokens') throw new RepairerError('the repairer ran out of tokens before it finished its answer');
  const text = message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  const out = parsed(message.parsed_output ?? jsonIn(text));
  const u = message.usage;
  const usage: Usage = { inputTokens: u.input_tokens, outputTokens: u.output_tokens, ...(u.cache_read_input_tokens ? { cacheReadInputTokens: u.cache_read_input_tokens } : {}), ...(u.cache_creation_input_tokens ? { cacheCreationInputTokens: u.cache_creation_input_tokens } : {}) };
  return { ...out, served: message.model, usage, cost: estimateCost(message.model, usage, prices) };
}

async function askOpenAI(r: Repairer, prompt: { system: string; user: string }, prices: Record<string, Price> | undefined, signal: AbortSignal): Promise<RepairerAnswer> {
  const base = (r.baseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  const key = process.env.OPENAI_API_KEY;
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({
      model: r.model,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'repair_candidates', strict: true, schema: SCHEMA } },
      // The answer's limit, which the budget check counts on: a server that ignores it is one no budget prices.
      max_completion_tokens: REPAIRER_ANSWER_TOKENS,
    }),
  }).catch((err: unknown) => {
    throw new RepairerError(`could not reach ${base}`, (err as Error).message);
  });
  const body = (await res.json().catch(() => null)) as {
    model?: string;
    error?: { message?: string };
    choices?: Array<{ finish_reason?: string; message?: { content?: string | null; refusal?: string | null } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
  } | null;
  if (!res.ok) throw new RepairerError(`${base} answered ${res.status}${res.status === 401 ? ' (set OPENAI_API_KEY)' : ''}`, body?.error?.message ?? null);
  const choice = body?.choices?.[0];
  if (choice?.message?.refusal) throw new RepairerError('the repairer declined to answer');
  if (choice?.finish_reason === 'length') throw new RepairerError('the repairer ran out of tokens before it finished its answer');
  const out = parsed(jsonIn(choice?.message?.content ?? ''));
  const cached = body?.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const usage: Usage = { inputTokens: (body?.usage?.prompt_tokens ?? 0) - cached, outputTokens: body?.usage?.completion_tokens ?? 0, ...(cached ? { cacheReadInputTokens: cached } : {}) };
  const served = body?.model ?? r.model;
  return { ...out, served, usage, cost: estimateCost(served, usage, prices) };
}
