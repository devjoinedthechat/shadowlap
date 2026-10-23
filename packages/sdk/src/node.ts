/**
 * The SDK as Node loads it (the `node` condition of its exports): the same module, with Node's
 * `AsyncLocalStorage` registered from a static import, so `scope()` has it from the first call on
 * every Node the package supports, a Node before 20.16 included. Runtimes without Node's modules
 * load index.js instead, which imports none of them until a call goes to a sidecar.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { useContextStore } from './context.js';

useContextStore(AsyncLocalStorage);

export * from './index.js';
