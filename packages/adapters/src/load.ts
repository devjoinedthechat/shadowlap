/**
 * Loads a module when an adapter first needs it: Node's own, or the agent's framework as its code
 * imports it. The name is held in a variable, and marked for the bundlers that read such marks, so a
 * bundle leaves the import alone, as the SDK's own loader does.
 */
export const load = (name: string): Promise<unknown> => import(/* webpackIgnore: true */ /* @vite-ignore */ name);
