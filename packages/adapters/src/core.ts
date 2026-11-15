import { tool, type Effect, type ToolOptions } from '@shadowlap/sdk';

/**
 * Shared machinery for the framework adapters. Each adapter does one thing: wrap a framework's
 * tool implementation so `effect` is declared once and the call goes through `tool()` from
 * `@shadowlap/sdk`, with only the framework's *input* recorded, never its context objects
 * (run contexts, abort signals, tracing handles are not JSON and not part of the call's identity).
 * Adapters have no framework dependencies: they type the shapes they touch structurally.
 */

export type EffectSpec<A = unknown, R = unknown> = Effect | ToolOptions<A, R>;

/**
 * The tool's options, its implementation hash taken from `source`: the function the person wrote,
 * not the adapter's wrapper around it, which reads the same for every tool. A `source` given in
 * the spec wins.
 */
export function toOptions<A, R>(spec: EffectSpec<A, R>, name: string, source?: ToolOptions<A, R>['source']): ToolOptions<A, R> {
  const withSource = (options: ToolOptions<A, R>): ToolOptions<A, R> => (source === undefined || options.source !== undefined ? options : { ...options, source });
  if (spec === 'pure' || spec === 'read' || spec === 'write') return withSource({ effect: spec });
  if (spec && typeof spec === 'object' && 'effect' in spec) return withSource(spec);
  throw new TypeError(`tool ${name}: effect must be "pure", "read", "write" or { effect, onFork }`);
}

const isAsyncGeneratorFunction = (fn: unknown): boolean => Object.prototype.toString.call(fn) === '[object AsyncGeneratorFunction]';

/**
 * Wraps a multi-argument implementation. The first argument is the recorded input; the rest are
 * passed through untouched. A fresh shadowlap wrapper is created per call so trailing arguments
 * stay bound to that call under concurrency; its implementation hash is the user's function's.
 * An async generator function (a streaming tool) stays one: see `tool()`.
 *
 * `calledAs` names a call from its trailing arguments when the framework tells the model the tool's
 * name only as it calls it (Mastra names a tool by its key in the agent's `tools`, not its `id`): the
 * call is recorded under the name the model called, which is what a replay checks the model's tool
 * calls against. `name` stands when it says nothing.
 */
export function wrapFirstArg<A, Rest extends unknown[], R>(name: string, spec: EffectSpec<A, R>, impl: (input: A, ...rest: Rest) => R | Promise<R>, calledAs?: (...rest: Rest) => string | undefined): (input: A, ...rest: Rest) => Promise<R> {
  const options = toOptions(spec, name, impl);
  const named = (rest: Rest) => calledAs?.(...rest) || name;
  if (isAsyncGeneratorFunction(impl)) {
    const stream = impl as unknown as (input: A, ...rest: Rest) => AsyncGenerator<R, unknown, undefined>;
    return ((input: A, ...rest: Rest) =>
      tool<A, R>(named(rest), options, async function* (i: A) {
        return yield* stream(i, ...rest);
      })(input)) as unknown as (input: A, ...rest: Rest) => Promise<R>;
  }
  return (input: A, ...rest: Rest) => tool<A, R>(named(rest), options, (i) => impl(i, ...rest))(input);
}
