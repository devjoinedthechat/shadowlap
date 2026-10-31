import { readFileSync } from 'node:fs';

/**
 * The dashboard's stylesheet as one text, as esbuild bundles it into assets/app.css: ui/app.css with
 * each @import replaced by the file it names (ui/css/<area>.css), in their order. The tests that read
 * the styles read this, so a rule is found in whichever file it sits, and "the last rule wins" reads
 * as the browser reads it.
 */

const APP = new URL('../ui/app.css', import.meta.url);
const IMPORT = /^@import\s+(?:url\(\s*)?['"]([^'"]+)['"]\s*\)?\s*;[ \t]*$/gm;

/** The files ui/app.css imports, in their order. */
export function sheetFiles(): URL[] {
  return [...readFileSync(APP, 'utf8').matchAll(IMPORT)].map((m) => new URL(m[1], APP));
}

/** A file's text, each of its imports replaced by that file's. */
function joined(file: URL): string {
  return readFileSync(file, 'utf8').replace(IMPORT, (_line, path: string) => joined(new URL(path, file)));
}

let whole: string | null = null;

/** The whole stylesheet, comments and all. */
export function sheet(): string {
  whole ??= joined(APP);
  return whole;
}

/** A style rule: its selectors, its declarations in order, and the at-rules it sits in, outermost first. */
export interface StyleRule {
  selectors: string[];
  decls: Array<[string, string]>;
  conditions: string[];
}

/** A list split at its top-level commas or semicolons: never inside brackets, parentheses or quotes. */
function splitTop(text: string, sep: ',' | ';'): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) quote = ch === quote ? '' : quote;
    else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === sep && depth === 0) {
      out.push(text.slice(from, i));
      from = i + 1;
    }
  }
  out.push(text.slice(from));
  return out.map((s) => s.trim()).filter(Boolean);
}

/** A rule's declarations, as [property, value] pairs. */
function declarations(body: string): Array<[string, string]> {
  return splitTop(body, ';').flatMap((d): Array<[string, string]> => {
    const at = d.indexOf(':');
    return at > 0 ? [[d.slice(0, at).trim(), d.slice(at + 1).trim()]] : [];
  });
}

/**
 * Every style rule of the stylesheet (or of `text`), those inside @media, @container and @supports
 * too, with the conditions they sit in. Comments are left out; other at-rules (fonts, keyframes) too.
 */
export function styleRules(text = sheet().replace(/\/\*[\s\S]*?\*\//g, ''), conditions: string[] = []): StyleRule[] {
  const out: StyleRule[] = [];
  let depth = 0;
  let start = 0;
  let head = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{' && depth++ === 0) {
      head = text.slice(start, i).trim();
      start = i + 1;
    } else if (text[i] === '}' && --depth === 0) {
      const body = text.slice(start, i);
      start = i + 1;
      if (/^@(media|container|supports)\b/.test(head)) out.push(...styleRules(body, [...conditions, head.replace(/\s+/g, ' ')]));
      else if (!head.startsWith('@')) out.push({ selectors: splitTop(head, ','), decls: declarations(body), conditions });
    }
  }
  return out;
}
