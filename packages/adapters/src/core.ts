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

/**
 * Wraps a multi-argument implementation. The first argument is the recorded input; the rest are
 * passed through untouched. A fresh Shadowlap wrapper is created per call so trailing arguments
 * stay bound to that call under concurrency; its implementation hash is the user's function's.
 */
export function wrapFirstArg<A, Rest extends unknown[], R>(name: string, spec: EffectSpec<A, R>, impl: (input: A, ...rest: Rest) => R | Promise<R>): (input: A, ...rest: Rest) => Promise<R> {
  const options = toOptions(spec, name, impl);
  return (input: A, ...rest: Rest) => tool<A, R>(name, options, (i) => impl(i, ...rest))(input);
}
