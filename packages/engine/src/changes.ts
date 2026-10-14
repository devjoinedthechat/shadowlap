/** What differs between two runs as a whole. No Node imports: the dashboard's browser code uses it too. */

export interface RunChanges {
  /** Whether the set of system prompts the runs sent differs. */
  systemPrompt: boolean;
  /** Tools offered by name, and whether definitions of tools both offered differ. */
  tools: { added: string[]; removed: string[]; redefined: boolean };
  models: { a: string[]; b: string[] };
  code: { a: string | null; b: string | null };
}

/** The changes as short phrases, or none when prompts, tools, models and code are all the same. */
export function describeChanges(c: RunChanges): string[] {
  const out: string[] = [];
  if (c.systemPrompt) out.push('system prompt changed');
  const t = [...c.tools.added.map((x) => `+${x}`), ...c.tools.removed.map((x) => `−${x}`)];
  if (t.length) out.push(`tools ${t.join(' ')}`);
  if (c.tools.redefined) out.push('a tool definition changed');
  if (c.models.a.join() !== c.models.b.join()) out.push(`model ${c.models.a.join(', ') || 'none'} → ${c.models.b.join(', ') || 'none'}`);
  if ((c.code.a ?? '') !== (c.code.b ?? '')) out.push(`code ${c.code.a ?? 'unknown'} → ${c.code.b ?? 'unknown'}`);
  return out;
}
