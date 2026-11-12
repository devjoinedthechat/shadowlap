/**
 * A dialog the palette asks a page for: the page opens it as it next shows, or at once where it
 * shows already. A module of its own, so neither the palette nor the page loads the other's code.
 */
export interface PageAsk {
  /** Asks for the dialog: its page opens it, now or as it next shows. `key` names what it is for, such as a fix's id. */
  ask(key?: string): void;
  /** Whether it was asked for, for `key`, and its page hasn't opened it yet; taking it forgets it. */
  take(key?: string): boolean;
  /** Calls `open` each time it is asked for, for `key`, while its page shows; returns what stops it. */
  on(open: () => void, key?: string): () => void;
}

function pageAsk(name: string): PageAsk {
  const event = `shadowlap:${name}`;
  let asked: string | null = null;
  return {
    ask(key = '') {
      asked = key;
      window.dispatchEvent(new CustomEvent(event, { detail: key }));
    },
    take(key = '') {
      const was = asked === key;
      if (was) asked = null;
      return was;
    },
    on(open, key = '') {
      const on = (e: Event) => {
        if ((e as CustomEvent<string>).detail !== key) return;
        asked = null;
        open();
      };
      window.addEventListener(event, on);
      return () => window.removeEventListener(event, on);
    },
  };
}

/** Runs' Import capture… dialog. */
export const IMPORT_ASK = pageAsk('import');
/** Settings › Matching's Add normalizer… dialog. */
export const NORMALIZER_ASK = pageAsk('normalizer');
/** Settings › Redaction's Add redaction rule… dialog. */
export const REDACTION_ASK = pageAsk('redaction');
/** A fix's Apply fix dialog, asked for by the fix's id. */
export const APPLY_ASK = pageAsk('apply');
/** Changes › Preview's way the palette names, asked for by the way (`model`, `code`): its dialog on every golden. */
export const PREVIEW_ASK = pageAsk('preview');

/** Changes › Migrate's dialog for a retiring model, asked for by the model it switches from: Migrate <a> to <b>. */
export const MIGRATE_ASK = pageAsk('migrate');
