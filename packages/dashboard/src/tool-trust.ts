import { type ConfigEvent, editConfigFile, isObject, messageOf, parseToolTrust, RuleError, type Trust } from '@shadowlap/engine';

/**
 * Settings → Tools' Mark untrusted and Mark trusted: one tool's `tools.<name>.trust` in
 * shadowlap.config.json, written against the version the page read, as Settings' other edits are.
 * The rest of the file stays as it was, `tools.unrecorded` included; the whole of `tools` is then
 * checked as a recording checks it (parseToolTrust), refused in its words.
 */

/** The `tools` entry's one line that marks a tool, as Settings → Tools shows it and its toasts quote it. */
export function trustLine(name: string, trust: Trust): string {
  return `"tools": { ${JSON.stringify(name)}: { "trust": "${trust}" } }`;
}

/** What a trust write answers: the mark now written (null: none), the one the file held before (`was`), whether the file changed, its version, and the line written or taken out. */
export interface ToolTrustWrite {
  tool: string;
  trust: Trust | null;
  was: Trust | null;
  changed: boolean;
  version: string;
  /** The line written, or the one taken out when `trust` is null; null when there was none to take out. */
  line: string | null;
  event: ConfigEvent | null;
}

/** `tools` checked as a recording reads it, refused in its words. */
function checked(tools: unknown): void {
  try {
    parseToolTrust(tools);
  } catch (err) {
    throw new RuleError(messageOf(err));
  }
}

/**
 * Sets `tools.<tool>.trust` (`trust`), or takes the tool's key out (null), and `tools` with it when
 * nothing is left: how an Undo puts back a file that had no mark. `expect` is the version the page
 * read (ConfigConflictError when the file is no longer that).
 */
export function setToolTrust(dir: string, tool: string, trust: Trust | null, o: { expect: string; wait?: number }): ToolTrustWrite {
  const { file, result: was, changed } = editConfigFile(dir, o, (data): Trust | null => {
    const tools = data.tools ?? {};
    checked(tools);
    const map = tools as Record<string, unknown>;
    const entry = Object.hasOwn(map, tool) ? map[tool] : undefined;
    const before = isObject(entry) && (entry.trust === 'trusted' || entry.trust === 'untrusted') ? entry.trust : null;
    // Defined, never assigned: a tool's name is the agent's and is never a key of Object's own.
    if (trust === null) delete map[tool];
    else Object.defineProperty(map, tool, { value: { trust }, enumerable: true, writable: true, configurable: true });
    if (Object.keys(map).length) data.tools = map;
    else delete data.tools;
    checked(data.tools);
    return before;
  });
  const shown = trust ?? was;
  return {
    tool,
    trust,
    was,
    changed,
    version: file.version,
    line: shown ? trustLine(tool, shown) : null,
    event: changed ? { kind: 'tool.trust', ref: tool, data: { trust, was } } : null,
  };
}
