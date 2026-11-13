import { type CallRecord, type ConfigEvent, CONFIG_FILE, configuredTrust, editConfigFile, isObject, messageOf, parseToolTrust, RuleError, type StoreOf, type ToolTrust, type Trust, TRUST_FROM, trustOf, type TrustSource } from '@shadowlap/engine';

/**
 * Settings → Tools' Trust column: each tool the recordings called, with its trust and where that
 * comes from (toolTrust), and Mark untrusted and Mark trusted, which write one tool's
 * `tools.<name>.trust` in shadowlap.config.json against the version the page read, as Settings'
 * other edits are. The rest of the file stays as it was, `tools.unrecorded` included; the whole of
 * `tools` is then checked as a recording checks it (parseToolTrust), refused in its words.
 */

/** The `tools` entry's one line that marks a tool, as Settings → Tools shows it and its toasts quote it. */
export function trustLine(name: string, trust: Trust): string {
  return `"tools": { ${JSON.stringify(name)}: { "trust": "${trust}" } }`;
}

/** A tool as Settings → Tools' Trust column shows it: trusted or untrusted, from where, and the config line that marks it the other way. */
export interface ToolTrustRow {
  name: string;
  trust: 'trusted' | 'untrusted';
  from: TrustSource | null;
  /** Where the mark comes from, in the column's words: `MCP openWorldHint · <server>`, `SDK`, `shadowlap.config.json`, or `recorded with its config’s mark` where the recording machine's config set it and this file says nothing; null for a tool trusted by default. */
  where: string | null;
  calls: number;
  /** Its calls are what a person typed (`meta.input`): never planted in. */
  input: boolean;
  /** The `tools` entry's line that marks it the other way, for the column's button. */
  flip: string;
}

/** Where a tool's mark comes from, in Settings → Tools' words (TRUST_FROM's, with the MCP server named). */
function trustWhere(from: TrustSource | null, o: { server: string | null; inFile: boolean }): string | null {
  if (from === 'mcp') return o.server ? `${TRUST_FROM.mcp} · ${o.server}` : TRUST_FROM.mcp;
  if (from === 'sdk') return TRUST_FROM.sdk;
  if (from === 'config') return o.inFile ? CONFIG_FILE : 'recorded with its config’s mark';
  return null;
}

/**
 * Every tool the store's recordings called, with its trust: the config's `tools`, else what its calls
 * were recorded with (the recording machine's config, the SDK's `trust`, an MCP server's
 * openWorldHint; untrusted wins when they differ), else trusted.
 */
export function toolTrust(store: StoreOf<'readModels'>, tools: ToolTrust | undefined): { tools: ToolTrustRow[] } {
  const rows = store.query(
    `SELECT name, COUNT(*) AS calls,
       MAX(CASE WHEN json_extract(meta, '$.trust') = 'untrusted' THEN 1 ELSE 0 END) AS untrusted,
       MAX(CASE WHEN json_extract(meta, '$.trust') = 'untrusted' AND json_extract(meta, '$.trustFrom') = 'config' THEN 1 ELSE 0 END) AS untrustedByConfig,
       MAX(CASE WHEN json_extract(meta, '$.trust') = 'trusted' AND json_extract(meta, '$.trustFrom') = 'config' THEN 1 ELSE 0 END) AS trustedByConfig,
       MAX(CASE WHEN json_extract(meta, '$.mcp') IS NOT NULL THEN 1 ELSE 0 END) AS mcp, MAX(json_extract(meta, '$.mcp.server')) AS server,
       MAX(CASE WHEN json_extract(meta, '$.input') = 1 THEN 1 ELSE 0 END) AS input, MAX(json_extract(meta, '$.http')) AS http
     FROM call_events WHERE phase = 'start' AND kind = 'tool' GROUP BY name ORDER BY name`,
  );
  return {
    tools: rows.map((r) => {
      const name = String(r.name);
      const server = typeof r.server === 'string' && r.server ? r.server : null;
      const http = typeof r.http === 'string' ? r.http : null;
      const recorded: Pick<CallRecord['meta'], 'trust' | 'trustFrom'> = Number(r.untrustedByConfig) ? { trust: 'untrusted', trustFrom: 'config' } : Number(r.untrusted) ? { trust: 'untrusted' } : Number(r.trustedByConfig) ? { trust: 'trusted', trustFrom: 'config' } : {};
      const meta: CallRecord['meta'] = { ...recorded, ...(Number(r.mcp) ? { mcp: { transport: 'stdio' as const, server: server ?? '' } } : {}), ...(http ? { http } : {}) };
      const t = trustOf({ kind: 'tool', name, meta }, tools);
      const where = trustWhere(t.from, { server, inFile: configuredTrust(tools, name, http) !== undefined });
      return { name, trust: t.trust, from: t.from, where, calls: Number(r.calls), input: Number(r.input) === 1, flip: trustLine(name, t.trust === 'untrusted' ? 'trusted' : 'untrusted') };
    }),
  };
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
