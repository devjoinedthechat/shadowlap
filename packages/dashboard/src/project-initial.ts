/**
 * The letter on a project's badge, as the server's list of projects and the page's sidebar show it:
 * `Ü` for a folder macOS named `U` and a combining diaeresis. No imports: the page's bundle imports
 * this too.
 */
export const projectInitial = (name: string) => (/[\p{L}\p{N}]/u.exec(name.normalize('NFC'))?.[0] ?? '?').toUpperCase();
