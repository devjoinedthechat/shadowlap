import type { Effect } from '@shadowlap/engine';
import { toolNameEffect } from '@shadowlap/engine';
import { type BaseUrlWarning, type FoundTool, type Framework } from './init-report.js';
import { callArguments, inCommentAt, kwarg, lineOf, positional, pyCalls, pyDecoratedDefs, pyImports, pyOrigin, rel, type PyImports } from './init-source.js';

/**
 * The tools `shadowlap init` finds in a project, as each framework defines them (a decorator, a class,
 * a list handed to an agent), with the effect each declares or the one its name suggests, and the
 * model clients whose base URL is written into the code, which bypass Shadowlap.
 */

/** The decorators each Python framework makes a tool with, by the module they come from. */
const PY_TOOL_DECORATORS: ReadonlyArray<[RegExp, readonly string[], Framework['id']]> = [
  [/^claude_agent_sdk(\.|$)/, ['tool'], 'claude-agent-sdk-python'],
  [/^strands(\.|$)/, ['tool'], 'strands'],
  [/^smolagents(\.|$)/, ['tool'], 'smolagents'],
  [/^agno\.tools(\.|$)/, ['tool'], 'agno'],
  [/^agent_framework(\.|$)/, ['tool', 'ai_function'], 'agent-framework'],
  [/^langchain(_core)?\.(tools|agents)(\.|$)/, ['tool'], 'langchain-python'],
  [/^crewai(\.tools)?$|^crewai_tools$/, ['tool'], 'crewai'],
];

/** The classes a Python tool is a subclass of, by the module they come from: LangChain's and CrewAI's `BaseTool`. */
const PY_TOOL_CLASSES: ReadonlyArray<[RegExp, readonly string[], Framework['id']]> = [
  [/^langchain(_core)?\.tools(\.|$)/, ['BaseTool', 'StructuredTool'], 'langchain-python'],
  [/^crewai(\.tools)?(\.|$)|^crewai_tools$/, ['BaseTool'], 'crewai'],
];

/** A first guess at a tool's effect from its name (toolNameEffect). Unknown names get `write`: it never re-runs after a fork. */
export function suggestEffect(name: string): { effect: Effect; why: string } {
  const said = toolNameEffect(name);
  if (said) return { effect: said.effect, why: said.effect === 'write' ? `"${said.word}" changes something` : said.effect === 'read' ? `"${said.word}" only looks` : `"${said.word}" depends only on its input` };
  return { effect: 'write', why: 'no hint in the name; write is the safe guess, it never re-runs after a fork' };
}

/** Keys that hold an AI SDK tool without naming it: `tools: weather` is no tool called "tools". */
const NOT_TOOL_KEYS = new Set(['tools', 'tool', 'execute', 'description', 'inputSchema', 'parameters', 'outputSchema']);

/** Adds a tool found, once by name and framework: a wrapped definition, which declares its effect, wins over a mention. */
type PushTool = (name: string, index: number, via: string, effect: Effect | null, extra?: { decorator?: string; className?: string }) => void;

/** Tool definitions in one file, by the patterns each framework uses. */
export function scanTools(text: string, file: string): FoundTool[] {
  const found: FoundTool[] = [];
  const push: PushTool = (name, index, via, effect, extra = {}) => {
    const s = suggestEffect(name);
    const tool: FoundTool = { name, file, line: lineOf(text, index), via, effect, suggested: effect ?? s.effect, why: effect ? 'declared' : s.why, ...(extra.decorator ? { decorator: extra.decorator } : {}), ...(extra.className ? { className: extra.className } : {}) };
    const same = found.findIndex((t) => t.name === name && t.via === via);
    if (same < 0) found.push(tool);
    else if (!found[same]!.effect && effect) found[same] = tool; // a wrapped definition wins over a mention
  };
  if (file.endsWith('.py')) pyTools(text, push);
  else jsTools(text, push);
  return found;
}

/** The framework a Python decorator or base class names, by where it was imported from (`table`), or null. */
type PyFramework = (decorator: string, table: typeof PY_TOOL_DECORATORS) => Framework['id'] | null;

/**
 * Python's tools: decorated functions, each decorator by where it comes from, and tools defined as
 * classes, LangChain's and CrewAI's BaseTool, named by their `name` attribute. Their effects, given
 * where they're used (with_effect(search_web, "read")), are read for the whole project: see
 * declaredEffects.
 */
function pyTools(text: string, push: PushTool): void {
  const imports = pyImports(text);
  const framework: PyFramework = (decorator, table) => {
    const head = /^@?([\w.]+)/.exec(decorator)?.[1];
    const o = head ? pyOrigin(imports, head) : null;
    return o ? (table.find(([module, names]) => module.test(o.module) && names.includes(o.name))?.[2] ?? null) : null;
  };
  for (const d of pyDecoratedDefs(text)) decoratedTool(text, imports, d, framework, push);
  for (const m of text.matchAll(/^class[ \t]+(\w+)[ \t]*\(([^)]*)\)[ \t]*:/gm)) {
    const via = m[2]!
      .split(',')
      .map((b) => framework(b.trim().replace(/\[[\s\S]*$/, ''), PY_TOOL_CLASSES))
      .find(Boolean);
    if (!via) continue;
    const after = text.slice(m.index + m[0].length);
    const body = /^[^\n]*\n((?:[ \t]+[^\n]*\n|[ \t]*\n)*)/.exec(after)?.[1] ?? '';
    const indent = /^([ \t]+)\S/m.exec(body)?.[1] ?? '    ';
    const named = new RegExp(`^${indent}name[ \\t]*(?::[^=\\n]+)?=[ \\t]*["']([^"'\\n]+)["']`, 'm').exec(body);
    if (named) push(named[1]!, m.index, via, null, { className: m[1]! });
  }
}

/** A decorated function as a tool, by its decorators: Shadowlap's own, an adapter's, or a framework's. */
function decoratedTool(text: string, imports: PyImports, d: { index: number; name: string; decorators: string[] }, framework: PyFramework, push: PushTool): void {
  const all = d.decorators.join('\n');
  // Shadowlap's own: `@tool(effect="read")`, imported from shadowlap or (in a snippet) from nowhere.
  const declared = d.decorators
    .map((x) => {
      const o = pyOrigin(imports, /^@([\w.]+)/.exec(x)![1]!);
      return (o ? o.module === 'shadowlap' && o.name === 'tool' : /^@tool\(/.test(x)) ? /\beffect\s*=\s*["'](pure|read|write)["']/.exec(x)?.[1] : undefined;
    })
    .find(Boolean);
  const adapted = /@function_tool\([^)]*effect\s*=\s*["'](pure|read|write)["']/.exec(all);
  const own = d.decorators.map((x) => ({ x, via: framework(x, PY_TOOL_DECORATORS) })).find((h) => h.via);
  if (declared) push(d.name, d.index, 'shadowlap', declared as Effect);
  else if (adapted) push(d.name, d.index, 'openai-agents-python', adapted[1] as Effect);
  else if (own?.via === 'claude-agent-sdk-python') {
    // The model knows it by the decorator's first argument: @tool("lookup_order", "Look an order up", {...}).
    const named = /^@[\w.]+\(\s*["']([\w.-]+)["']/.exec(own.x);
    if (named) push(named[1]!, d.index, own.via, null);
  }
  // Strands and smolagents keep their own @tool over Shadowlap's: the wrap names the one found.
  else if (own) push(d.name, d.index, own.via!, null, own.via === 'strands' || own.via === 'smolagents' ? { decorator: own.x.split('(')[0] ?? own.x } : {});
  // Pydantic AI: `@agent.tool` passes a RunContext first, `@agent.tool_plain` doesn't; the wrap keeps the one found.
  else if (text.includes('pydantic_ai') && /@\w+\.tool(?:_plain)?\b/.test(all)) {
    const decorator = d.decorators.find((x) => /^@\w+\.tool(?:_plain)?\b/.test(x))?.split('\n')[0]?.trim();
    push(d.name, d.index, 'pydantic-ai', null, decorator ? { decorator } : {});
  }
  else if (/@function_tool\b/.test(all)) push(d.name, d.index, 'openai-agents-python', null);
  else if (/@(?:tool|langchain_core\.tools\.tool)\b/.test(all) && /langchain|crewai/.test(text)) push(d.name, d.index, /crewai/.test(text) ? 'crewai' : 'langchain-python', null);
}

/** JavaScript's and TypeScript's tools: the Shadowlap SDK's, and each framework's, with the effect an adapter declares for one it wraps. */
function jsTools(text: string, push: PushTool): void {
  const inComment = (index: number) => inCommentAt(text, index, false);
  // @shadowlap/sdk: tool('name', { effect: 'read' }, impl)
  if (text.includes('@shadowlap/sdk')) for (const m of text.matchAll(/\btool\(\s*['"`]([\w.-]+)['"`]\s*,\s*\{[^}]*?effect:\s*['"`](pure|read|write)['"`]/g)) push(m[1]!, m.index, 'shadowlap', m[2] as Effect);
  const adapted = text.includes('@shadowlap/adapters');
  /**
   * The effect an adapter declares for a tool, if it is wrapped: `tool(withEffect({ … }, 'read'))`,
   * `withEffect(tool(…), 'read')`, or the AI SDK's `withEffects({ … }, { name: 'read' })`.
   * `callStart` is where the framework call begins, `callOpen` just past its parenthesis, `nameEnd`
   * just past the tool's name.
   */
  const wrappedEffect = (callStart: number, callOpen: number, nameEnd: number, name: string): Effect | null => {
    if (!adapted) return null;
    const before = text.slice(Math.max(0, callStart - 40), callStart);
    const inner = text.slice(callOpen, callOpen + 40);
    if (/withEffect(?:V0)?\(\s*$/.test(before) || /^\s*withEffect(?:V0)?\(/.test(inner)) {
      // The effect follows the definition: `}, 'read'` or `}, { effect: 'write', … }`, maybe after a comment.
      const after = /[})]\s*,\s*(?:\/\/[^\n]*\n\s*)*(?:['"`](pure|read|write)['"`]|\{\s*effect:\s*['"`](pure|read|write)['"`])/.exec(text.slice(nameEnd, nameEnd + 4000));
      if (after) return (after[1] ?? after[2]) as Effect;
    }
    // withEffects({ ... }, { name: 'read' }) for the AI SDK
    const map = new RegExp(`['"\`]?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]?\\s*:\\s*(?:['"\`](pure|read|write)['"\`]|\\{\\s*effect:\\s*['"\`](pure|read|write)['"\`])`).exec(text.slice(callStart));
    return map ? ((map[1] ?? map[2]) as Effect) : null;
  };
  if (/from\s+['"]ai['"]/.test(text)) {
    for (const m of text.matchAll(/(?:^|[\s,{])['"]?([A-Za-z_][\w-]*)['"]?\s*:\s*tool\(\s*\{/gm)) if (!inComment(m.index + m[0].indexOf('tool('))) push(m[1]!, m.index + m[0].indexOf(m[1]!), 'ai-sdk', wrappedEffect(m.index, m.index + m[0].length, m.index + m[0].length, m[1]!));
    // A tool kept in a constant, `const searchDocs = tool({ … })`, then given as `tools: { searchDocs }`
    // or `tools: { search_docs: searchDocs }`: the model knows it by the key that names it there.
    for (const m of text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*tool\(\s*\{/g)) {
      if (inComment(m.index + m[0].lastIndexOf('tool('))) continue;
      const variable = m[1]!;
      const keys = [...text.matchAll(new RegExp(`(?:^|[\\s,{])['"]?([A-Za-z_][\\w-]*)['"]?\\s*:\\s*${variable.replace(/\$/g, '\\$')}(?![\\w$(])`, 'gm'))].map((k) => k[1]!);
      const name = keys.find((k) => k !== variable && !NOT_TOOL_KEYS.has(k)) ?? variable;
      push(name, m.index + m[0].indexOf(variable), 'ai-sdk', wrappedEffect(m.index, m.index + m[0].length, m.index + m[0].length, name));
    }
  }
  const byName = (call: RegExp, key: 'name' | 'id', via: string) => {
    for (const m of text.matchAll(call)) {
      if (inComment(m.index)) continue;
      const window = text.slice(m.index, m.index + 1500);
      const named = new RegExp(`\\b${key}:\\s*['"\`]([\\w.-]+)['"\`]`).exec(window);
      if (named) push(named[1]!, m.index, via, wrappedEffect(m.index, m.index + m[0].length, m.index + named.index + named[0].length, named[1]!));
    }
  };
  if (text.includes('@openai/agents')) byName(/\btool\(/g, 'name', 'openai-agents');
  if (text.includes('@mastra/core')) byName(/\bcreateTool\(/g, 'id', 'mastra');
  if (text.includes('@langchain/core/tools')) byName(/\btool\(/g, 'name', 'langchain');
  if (/betaZodTool|betaTool/.test(text)) byName(/\bbeta(?:Zod)?Tool\(/g, 'name', 'anthropic-tool-runner');
  // The Claude Agent SDK's tools for an in-process MCP server: tool('lookup_order', 'Look an order up', schema, handler).
  // Their effects are given where the server is made, withEffects('orders', [...], { lookup_order: 'read' }): see declaredEffects.
  if (text.includes('@anthropic-ai/claude-agent-sdk')) for (const m of text.matchAll(/\btool\(\s*(['"`])([\w.-]+)\1\s*,\s*['"`]/g)) if (!inComment(m.index)) push(m[2]!, m.index, 'claude-agent-sdk', null);
}

/**
 * Effects given where tools are used rather than where they're defined, read across the project:
 * `with_effect(search_web, "read")` and `with_effect(SendEmail(), "write")` (LangChain, CrewAI) in the
 * tool's own file or one that imports it, and the Claude Agent SDK's `withEffects('orders', [...],
 * { lookup_order: 'read' })` (`with_effects` in Python), whose map names each tool.
 */
export function declaredEffects(tools: FoundTool[], texts: ReadonlyArray<readonly [string, string]>, cwd: string): void {
  const declare = (t: FoundTool, effect: Effect) => Object.assign(t, { effect, suggested: effect, why: 'declared' });
  for (const [path, text] of texts) {
    const file = rel(cwd, path);
    const py = file.endsWith('.py');
    if (py && text.includes('with_effect(')) {
      const imports = pyImports(text);
      for (const m of text.matchAll(/\bwith_effect\(\s*(\w+)\s*(?:\(\s*\))?\s*,\s*["'](pure|read|write)["']/g)) {
        if (inCommentAt(text, m.index, true)) continue;
        const t = tools.find((x) => !x.effect && x.file.endsWith('.py') && (x.className ?? x.name) === m[1] && (x.file === file || imports.has(m[1])));
        if (t) declare(t, m[2] as Effect);
      }
    }
    const map = py ? /\bwith_effects\(\s*["'][\w.-]+["']\s*,[\s\S]{0,2000}?\{([^}]*)\}\s*\)/g : /\bwithEffects\(\s*['"`][\w.-]+['"`]\s*,[\s\S]{0,2000}?\{([^}]*)\}\s*\)/g;
    if (!(py ? text.includes('shadowlap.adapters.claude_agent_sdk') : text.includes('@shadowlap/adapters/claude-agent-sdk'))) continue;
    for (const m of text.matchAll(map)) {
      for (const pair of m[1]!.matchAll(/['"`]?([\w.-]+)['"`]?\s*:\s*(?:['"`](pure|read|write)['"`]|\{\s*['"`]?effect['"`]?\s*:\s*['"`](pure|read|write)['"`])/g)) {
        const t = tools.find((x) => !x.effect && x.name === pair[1] && x.via === (py ? 'claude-agent-sdk-python' : 'claude-agent-sdk'));
        if (t) declare(t, (pair[2] ?? pair[3]) as Effect);
      }
    }
  }
}

/** The Python agents that take plain functions as tools, by the module they come from, and the framework each is. */
const PY_TOOL_LISTS: ReadonlyArray<[RegExp, readonly string[], Framework['id']]> = [
  [/^pydantic_ai(\.|$)/, ['Agent'], 'pydantic-ai'],
  [/^google\.adk(\.|$)/, ['Agent', 'LlmAgent'], 'google-adk'],
  [/^agent_framework(\.|$)/, ['Agent', 'ChatAgent'], 'agent-framework'],
  [/^agno\.(agent|team)(\.|$)/, ['Agent', 'Team'], 'agno'],
  [/^llama_index\.core\.agent(\.|$)/, ['FunctionAgent', 'ReActAgent', 'CodeActAgent'], 'llamaindex'],
];

/**
 * Plain functions given to an agent as its tools, `Agent(tools=[search_web, send_email])` (Pydantic
 * AI, Google ADK, Microsoft Agent Framework, Agno, LlamaIndex's agents, and a MAF client's
 * `as_agent(tools=[…])`), and LlamaIndex's `FunctionTool.from_defaults(fn=send_email)`: each is
 * found where its function is defined, in the same file or the one it is imported from, and only
 * then; a name that resolves to no `def` (another agent, a tool object) is passed over.
 */
export function scanToolLists(texts: ReadonlyArray<readonly [string, string]>, cwd: string, found: readonly FoundTool[]): FoundTool[] {
  const py = texts.filter(([f]) => f.endsWith('.py'));
  const defs = new Map<string, Array<{ file: string; text: string; index: number }>>();
  for (const [path, text] of py) for (const m of text.matchAll(/^(?:async[ \t]+)?def[ \t]+(\w+)[ \t]*\(/gm)) defs.set(m[1]!, [...(defs.get(m[1]!) ?? []), { file: rel(cwd, path), text, index: m.index }]);
  const out: FoundTool[] = [];
  for (const [path, text] of py) {
    const file = rel(cwd, path);
    const imports = pyImports(text);
    const given: Array<[string, Framework['id']]> = [];
    const fromList = (value: { text: string; at: number } | undefined, via: Framework['id']) => {
      if (!value?.text.startsWith('[')) return;
      for (const item of callArguments(text, value.at + 1, true) ?? []) {
        const fn = /^(\w+)$/.exec(item.text) ?? /^(?:Tool|FunctionTool)\(\s*(?:func(?:tion)?\s*=\s*)?(\w+)\s*[,)]/.exec(item.text) ?? /^FunctionTool\.from_defaults\(\s*(?:(?:async_)?fn\s*=\s*)?(\w+)\s*[,)]/.exec(item.text);
        if (fn) given.push([fn[1]!, via]);
      }
    };
    for (const [module, names, via] of PY_TOOL_LISTS) for (const call of pyCalls(text, imports, module, names)) fromList(kwarg(callArguments(text, call.open, true) ?? [], 'tools'), via);
    if ([...imports.values()].some((i) => /^agent_framework(\.|$)/.test(i.module))) {
      for (const m of text.matchAll(/\.(?:as_agent|create_agent)\s*\(/g)) if (!inCommentAt(text, m.index, true)) fromList(kwarg(callArguments(text, m.index + m[0].length, true) ?? [], 'tools'), 'agent-framework');
    }
    if ([...imports.values()].some((i) => /^llama_index(\.|$)/.test(i.module))) {
      for (const m of text.matchAll(/\bFunctionTool\.from_defaults\s*\(/g)) {
        if (inCommentAt(text, m.index, true)) continue;
        const args = callArguments(text, m.index + m[0].length, true) ?? [];
        const fn = kwarg(args, 'fn') ?? kwarg(args, 'async_fn') ?? positional(args)[0];
        if (fn && /^\w+$/.test(fn.text)) given.push([fn.text, 'llamaindex']);
      }
    }
    for (const [name, via] of given) {
      // Defined here, or imported from the one other file that defines it.
      const candidates = defs.get(name) ?? [];
      const def = candidates.find((d) => d.file === file) ?? (imports.has(name) && candidates.length === 1 ? candidates[0] : undefined);
      if (!def || [...found, ...out].some((t) => t.name === name && t.file === def.file)) continue;
      const s = suggestEffect(name);
      out.push({ name, file: def.file, line: lineOf(def.text, def.index), via, effect: null, suggested: s.effect, why: s.why });
    }
  }
  return out;
}

/** Model clients constructed with a literal base URL: `shadowlap run` cannot redirect them. */
export function scanBaseUrls(text: string, file: string): BaseUrlWarning[] {
  const out: BaseUrlWarning[] = [];
  const re = file.endsWith('.py') ? /\bbase_url\s*=\s*["'](https?:\/\/[^"']+)["']/g : /\bbaseURL\s*:\s*['"`](https?:\/\/[^'"`$]+)['"`]/g;
  for (const m of text.matchAll(re)) {
    // `baseURL: process.env.OPENAI_BASE_URL ?? '…'` is fine; only a bare literal bypasses the environment.
    const lineStart = text.lastIndexOf('\n', m.index) + 1;
    const line = text.slice(lineStart, text.indexOf('\n', m.index) === -1 ? undefined : text.indexOf('\n', m.index));
    if (/process\.env|os\.environ|getenv|BASE_URL/.test(line)) continue;
    const before = text.slice(Math.max(0, m.index - 300), m.index);
    const client = /Anthropic/.test(before) ? 'anthropic' : /OpenAI/.test(before) ? 'openai' : /GoogleGenAI|genai/.test(before) ? 'gemini' : null;
    out.push({ file, line: lineOf(text, m.index), url: m[1]!, client });
  }
  return out;
}
