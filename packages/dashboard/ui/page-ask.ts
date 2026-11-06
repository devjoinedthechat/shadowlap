/**
 * A dialog the palette asks a page for: the page opens it as it next shows, or at once where it
 * shows already. A module of its own, so neither the palette nor the page loads the other's code.
 */
export interface PageAsk {
  /** Asks for the dialog: its page opens it, now or as it next shows. */
  ask(): void;
  /** Whether it was asked for and its page hasn't opened it yet; taking it forgets it. */
  take(): boolean;
  /** Calls `open` each time it is asked for while its page shows; returns what stops it. */
  on(open: () => void): () => void;
}

function pageAsk(name: string): PageAsk {
  const event = `shadowlap:${name}`;
  let asked = false;
  return {
    ask() {
      asked = true;
      window.dispatchEvent(new Event(event));
    },
    take() {
      const was = asked;
      asked = false;
      return was;
    },
    on(open) {
      const on = () => {
        asked = false;
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
