import { tool } from '@shadowlap/sdk';
import { toOptions, type EffectSpec } from './core.js';

/**
 * LangChain / LangGraph (`@langchain/core` tools): wraps the tool instance's `_call`, the step
 * after LangChain has validated the input against the schema and before it wraps the output in a
 * `ToolMessage`. So the recorded input is the parsed arguments (never LangGraph's ToolCall envelope
 * or its call id), the recorded output is what the tool function returned, and LangChain builds
 * the `ToolMessage` itself on replay exactly as it does live.
 *
 *   import { tool } from '@langchain/core/tools';
 *   import { withEffect } from '@shadowlap/adapters/langchain';
 *
 *   const searchWeb = withEffect(tool(search, { name: 'search_web', schema }), 'read');
 *   const node = new ToolNode([searchWeb]);
 *
 * Outputs must be JSON: strings, objects, or `[content, artifact]` for `responseFormat:
 * "content_and_artifact"`. A tool that returns a LangGraph `Command`, LangGraph's way for a tool to
 * update the graph's state, or a message such as a `ToolMessage`, is recorded in a tagged JSON form
 * (a message as its `toDict()`) and rebuilt on replay from the agent's own `@langchain/langgraph` and
 * `@langchain/core`, so the graph gets a `Command` back and its state update happens again. While
 * recording, the graph gets the tool's own object.
 */

interface LangChainToolInternals {
  name: string;
  _call: (input: unknown, ...rest: unknown[]) => Promise<unknown>;
  /** The function a tool made with `tool()` or `DynamicStructuredTool` calls from its `_call`. */
  func?: (...args: never[]) => unknown;
}

export function withEffect<T extends { name: string }>(instance: T, spec: EffectSpec): T {
  const target = instance as unknown as LangChainToolInternals;
  if (typeof target._call !== 'function') {
    throw new TypeError(`withEffect: "${instance.name}" is not a LangChain tool (no _call); wrap the result of tool() or a StructuredTool instance`);
  }
  // Hashed by the person's function: `func` for tool() and DynamicStructuredTool, a subclass's own _call.
  const options = toOptions(spec, instance.name, typeof target.func === 'function' ? target.func : target._call);
  const original = target._call.bind(instance);
  target._call = async (input: unknown, ...rest: unknown[]) => {
    // The live result of this call: the graph gets the tool's own object while recording, and the
    // object rebuilt from the recording on replay.
    const live: unknown[] = [];
    const result = await tool(instance.name, options, async () => {
      const value = await original(input, ...rest);
      live.push(value);
      return encode(value);
    })(input);
    return live.length > 0 ? live[0] : decode(result);
  };
  return instance;
}

const TAG = '__shadowlap__';

type Json = Record<string, unknown>;
const isObject = (x: unknown): x is Json => typeof x === 'object' && x !== null;
/** LangGraph's own test for a Command (and a Send): by name, so another copy of the package passes too. */
const isCommand = (x: unknown): x is { graph?: unknown; update?: unknown; resume?: unknown; goto?: unknown } => isObject(x) && x.lg_name === 'Command';
const isSend = (x: unknown): x is { node: string; args: unknown } => isObject(x) && x.lg_name === 'Send';
/** @langchain/core's own test for a message. */
const isMessage = (x: unknown): x is { toDict(): unknown } => isObject(x) && typeof x._getType === 'function' && typeof x.toDict === 'function';

/** A tool's result as it is recorded: a Command or a message tagged, with what is inside it; anything else as it is. */
function encode(value: unknown): unknown {
  return isCommand(value) || isMessage(value) ? encodeValue(value) : value;
}

function encodeValue(value: unknown): unknown {
  if (isMessage(value)) return { [TAG]: 'message', message: value.toDict() };
  if (isSend(value)) return { [TAG]: 'send', node: value.node, args: encodeValue(value.args) };
  if (isCommand(value)) return { [TAG]: 'command', graph: value.graph, update: encodeValue(value.update), resume: encodeValue(value.resume), goto: encodeValue(value.goto) };
  if (Array.isArray(value)) return value.map(encodeValue);
  if (isObject(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encodeValue(v)]));
  return value;
}

/** Whether a recorded value holds a tagged Command, Send or message anywhere. */
const tagged = (value: unknown): boolean => (Array.isArray(value) ? value.some(tagged) : isObject(value) && (typeof value[TAG] === 'string' || Object.values(value).some(tagged)));

interface LangGraphClasses {
  Command: new (args: Json) => unknown;
  Send: new (node: string, args: unknown) => unknown;
}
interface MessageClasses {
  mapStoredMessageToChatMessage: (stored: unknown) => unknown;
  RemoveMessage: new (fields: { id: string }) => unknown;
}

/** The tagged form back as the objects it was made from; a value with no tags as it is. */
async function decode(value: unknown): Promise<unknown> {
  if (!tagged(value)) return value;
  const needs = { graph: false };
  (function scan(v: unknown): void {
    if (Array.isArray(v)) v.forEach(scan);
    else if (isObject(v)) {
      if (v[TAG] === 'command' || v[TAG] === 'send') needs.graph = true;
      Object.values(v).forEach(scan);
    }
  })(value);
  const messages = (await importPeer('@langchain/core/messages')) as unknown as MessageClasses;
  const graph = needs.graph ? ((await importPeer('@langchain/langgraph')) as unknown as LangGraphClasses) : undefined;
  const rebuild = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(rebuild);
    if (!isObject(v)) return v;
    switch (v[TAG]) {
      case 'message': {
        const stored = v.message as { type?: string; data?: { id?: string } };
        return stored.type === 'remove' && typeof stored.data?.id === 'string' ? new messages.RemoveMessage({ id: stored.data.id }) : messages.mapStoredMessageToChatMessage(stored);
      }
      case 'send':
        return new graph!.Send(v.node as string, rebuild(v.args));
      case 'command': {
        const args: Json = { update: rebuild(v.update), resume: rebuild(v.resume), goto: rebuild(v.goto) };
        if (v.graph !== undefined && v.graph !== null) args.graph = v.graph;
        return new graph!.Command(args);
      }
      default:
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rebuild(x)]));
    }
  };
  return rebuild(value);
}

const load = (name: string): Promise<unknown> => import(/* webpackIgnore: true */ /* @vite-ignore */ name);

/**
 * A module of the agent's framework, as the agent's own code imports it: from where this package
 * is installed, else (a layout that keeps the framework beside the agent rather than beside
 * @shadowlap/adapters, such as a workspace with the adapters hoisted to its root) the ES module
 * entry the agent's entry point, then its working folder, would import.
 */
async function importPeer(specifier: string): Promise<Record<string, unknown>> {
  try {
    return (await load(specifier)) as Record<string, unknown>;
  } catch (err) {
    if (!isObject(err) || (err.code !== 'ERR_MODULE_NOT_FOUND' && err.code !== 'MODULE_NOT_FOUND')) throw err;
    const found = await esmEntryFromAgent(specifier);
    if (found === null) throw new Error(`shadowlap: this recording holds a LangChain message or LangGraph Command, and ${specifier} can't be imported to rebuild it`, { cause: err });
    const { pathToFileURL } = (await load('node:url')) as typeof import('node:url');
    // An ES module import takes the file's URL; the CommonJS copy of this file, whose import() is a
    // require(), takes its path.
    try {
      return (await load(pathToFileURL(found).href)) as Record<string, unknown>;
    } catch {
      return (await load(found)) as Record<string, unknown>;
    }
  }
}

async function esmEntryFromAgent(specifier: string): Promise<string | null> {
  const fs = (await load('node:fs')) as typeof import('node:fs');
  const path = (await load('node:path')) as typeof import('node:path');
  const { createRequire } = (await load('node:module')) as typeof import('node:module');
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
  const subpath = `.${specifier.slice(name.length)}`;
  const entry = process.argv[1];
  for (const from of [entry ? path.resolve(entry) : null, path.join(process.cwd(), 'index.js')]) {
    if (from === null) continue;
    for (const dir of createRequire(from).resolve.paths(name) ?? []) {
      const root = path.join(dir, name);
      let manifest: { exports?: unknown; module?: unknown; main?: unknown };
      try {
        manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as typeof manifest;
      } catch {
        continue;
      }
      const target = esmTarget(isObject(manifest.exports) ? manifest.exports[subpath] : subpath === '.' ? manifest.module ?? manifest.main : undefined);
      if (target) return path.join(root, target);
    }
  }
  return null;
}

/** The file a package's `exports` entry gives an ES module import in Node: the first of its conditions Node's import matches, in the entry's order. */
function esmTarget(entry: unknown): string | null {
  if (typeof entry === 'string') return entry;
  if (!isObject(entry)) return null;
  for (const [condition, target] of Object.entries(entry)) {
    if (condition !== 'node' && condition !== 'import' && condition !== 'default') continue;
    const found = esmTarget(target);
    if (found) return found;
  }
  return null;
}
