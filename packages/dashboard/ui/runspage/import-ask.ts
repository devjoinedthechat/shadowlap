/**
 * The palette's way to Runs' import dialog: Runs opens it as it next shows, or at once where it
 * shows already. A module of its own, so neither the palette nor Runs loads the other's code for it.
 */

const IMPORT_ASKED = 'shadowlap:import';
let asked = false;

/** Asks for the dialog: Runs opens it, now or as it next shows. */
export function askImport(): void {
  asked = true;
  window.dispatchEvent(new Event(IMPORT_ASKED));
}

/** Whether the dialog was asked for and Runs hasn't opened it yet; asking again forgets it. */
export function takeImportAsked(): boolean {
  const was = asked;
  asked = false;
  return was;
}

/** Calls `open` each time the dialog is asked for while Runs shows; returns what stops it. */
export function onImportAsked(open: () => void): () => void {
  const on = () => {
    asked = false;
    open();
  };
  window.addEventListener(IMPORT_ASKED, on);
  return () => window.removeEventListener(IMPORT_ASKED, on);
}
