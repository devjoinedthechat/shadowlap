import type { Route } from './route.js';
import type { AppState, PaletteCommand } from './state.js';

/**
 * Where the palette's entries come from besides the shell's own (This run, Go to, the runs, and what
 * runs recorded). A page adds its group here when it loads: Fixes adds its fixes, Tests its goldens,
 * Projects the projects to switch to, and a feature its actions ("Import a capture…"). A source runs
 * each time the palette opens, so it reads what it needs from the app state it is handed.
 */

export interface PaletteContext {
  app: AppState;
  route: Route;
  /** Opens a route. */
  go: (hash: string) => void;
}

export type PaletteSource = (ctx: PaletteContext) => PaletteCommand[];

const sources: PaletteSource[] = [];

export function addPaletteSource(source: PaletteSource): void {
  if (!sources.includes(source)) sources.push(source);
}

export function paletteSources(): readonly PaletteSource[] {
  return sources;
}

// A source that loads what it lists (Tests, from any page) answers with what it has, and says when
// more arrived: an open palette then reads every source again.
const changes = new Set<() => void>();

export function paletteSourcesChanged(): void {
  for (const on of changes) on();
}

export function onPaletteSourcesChanged(on: () => void): () => void {
  changes.add(on);
  return () => {
    changes.delete(on);
  };
}
