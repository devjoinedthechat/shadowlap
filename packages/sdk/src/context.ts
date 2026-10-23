/**
 * `AsyncLocalStorage` without importing Node's module at load time, so the SDK loads where Node's
 * modules don't exist. The Node entry point registers Node's (src/node.ts); elsewhere the runtime
 * may have one of its own.
 */

/** The part of `AsyncLocalStorage` the SDK uses. */
export interface ContextStore<T> {
  getStore(): T | undefined;
  run<R>(store: T, fn: () => R): R;
}
export type ContextStoreClass = new <T>() => ContextStore<T>;

const STORE_CLASS = Symbol.for('shadowlap.sdk.asyncLocalStorage');

/**
 * `AsyncLocalStorage`, when this runtime has it without an import: the Node entry point registers
 * Node's (src/node.ts); an Edge runtime may have it as a global; a Node from 20.16 or 22.3 hands it
 * over through `process.getBuiltinModule`. Null when none of them does.
 */
function contextStoreClass(): ContextStoreClass | null {
  const g = globalThis as { [STORE_CLASS]?: ContextStoreClass; AsyncLocalStorage?: ContextStoreClass; process?: { getBuiltinModule?: (id: string) => unknown } };
  if (g[STORE_CLASS]) return g[STORE_CLASS];
  if (typeof g.AsyncLocalStorage === 'function') return g.AsyncLocalStorage;
  const hooks = g.process?.getBuiltinModule?.('node:async_hooks') as { AsyncLocalStorage?: ContextStoreClass } | undefined;
  return hooks?.AsyncLocalStorage ?? null;
}

/** Registers the runtime's `AsyncLocalStorage` (the Node entry point does, from its static import). */
export function useContextStore(cls: ContextStoreClass): void {
  (globalThis as { [STORE_CLASS]?: ContextStoreClass })[STORE_CLASS] ??= cls;
}

/** A store shared across copies of this module through a global symbol; null where the runtime has no `AsyncLocalStorage`. */
export function sharedStore<T>(key: symbol): ContextStore<T> | null {
  const g = globalThis as Record<symbol, ContextStore<T> | undefined>;
  const found = g[key];
  if (found) return found;
  const cls = contextStoreClass();
  return cls ? (g[key] = new cls<T>()) : null;
}

