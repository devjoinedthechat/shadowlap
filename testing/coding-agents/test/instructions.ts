// What the coding agents' instructions are made of, read the way the tests need them: the skill, the
// Cursor rule and the section docs/agents.md gives to paste, and the shadowlap commands each names.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CURSOR_RULE } from '../../../packages/dashboard/src/agent-skill.js';
import { agentsSection } from '../../../packages/dashboard/src/settings.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

export const PLUGIN_DIR = 'coding-agents/claude-code';
export const SKILL_FILE = `${PLUGIN_DIR}/skills/debug-agent/SKILL.md`;

/**
 * A Markdown file's frontmatter, kept to flat `key: value` lines (a YAML subset every reader parses
 * the same way: no lists, no nesting, no line breaks in a value), and its body.
 */
export function frontmatter(text: string): { fields: Map<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) throw new Error('no frontmatter: the file must start with a --- line');
  const fields = new Map<string, string>();
  for (const line of m[1]!.split('\n')) {
    const kv = /^([a-z][a-zA-Z-]*): (\S(?:.*\S)?)$/.exec(line);
    if (!kv) throw new Error(`not a "key: value" line: ${JSON.stringify(line)}`);
    const value = kv[2]!;
    // A plain YAML scalar can't start with an indicator, or hold ": " or " #", which would end it early.
    if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(value) || value.includes(': ') || value.includes(' #')) throw new Error(`${kv[1]}: a value YAML would read otherwise: ${value}`);
    if (fields.has(kv[1]!)) throw new Error(`${kv[1]} appears twice`);
    fields.set(kv[1]!, value);
  }
  return { fields, body: text.slice(m[0].length) };
}

/** The instructions a coding agent gets, where each comes from. */
export function instructions(): Array<{ where: string; text: string }> {
  const pasted = agentsSection(read('docs/agents.md'));
  if (pasted === null) throw new Error('docs/agents.md has no section to paste under "## Instructions to give it"');
  return [
    { where: SKILL_FILE, text: frontmatter(read(SKILL_FILE)).body },
    { where: CURSOR_RULE.source, text: frontmatter(read(CURSOR_RULE.source)).body },
    { where: 'docs/agents.md, the section to paste', text: pasted },
  ];
}

/**
 * Every `shadowlap …` command in some Markdown: inline code that starts with one (a span may wrap
 * onto the next line, as Markdown allows), and each line of a shell block that does. A span that
 * only names flags (`--repeat 5`) adds to a command; it isn't one.
 */
export function commandsIn(markdown: string): string[] {
  const found: string[] = [];
  const fences = /^```([\w-]*)[^\n]*\n([\s\S]*?)^```/gm;
  for (const m of markdown.matchAll(fences)) {
    if (!['', 'sh', 'bash', 'shell', 'console'].includes(m[1]!)) continue;
    for (const line of m[2]!.split('\n')) if (/^(\$ )?shadowlap\s/.test(line.trim())) found.push(line.trim().replace(/^\$ /, ''));
  }
  const prose = markdown.replace(fences, '');
  for (const m of prose.matchAll(/`([^`]+)`/g)) {
    const span = m[1]!.replace(/\s+/g, ' ').trim();
    if (span.startsWith('shadowlap ')) found.push(span);
  }
  return found;
}

/** A command line's words, as a POSIX shell splits it: single and double quotes group, and go. */
export function words(line: string): string[] {
  const out: string[] = [];
  let word = '';
  let started = false;
  let quote: string | null = null;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) out.push(word);
      word = '';
      started = false;
    } else {
      word += ch;
      started = true;
    }
  }
  if (quote) throw new Error(`an unclosed ${quote} in: ${line}`);
  if (started) out.push(word);
  return out;
}
