/** The toast for a report the server sent as a file and the page saved: its name, then whether the project's redaction rules masked it. Share's copies and a golden's Security report alike. */
export const savedWords = (r: { filename: string; redacted: boolean }, also = ''): string => `Saved ${r.filename}${also} · ${r.redacted ? 'redaction rules applied' : 'no redaction rules to apply'}`;
