import { Fragment, useId, useMemo, useState } from 'react';
import { Icon } from './Icon.js';

/**
 * Markdown as the page draws it, from blocks and as React elements, never as HTML, so the text stays
 * text: a repair's report.md (the pull request it hands over, with its sections folded) and a
 * migration's pull request body. Headings, paragraphs, block quotes, code fences, tables and lists,
 * with code in backticks and links to an http(s) address; anything else is drawn as the text it is.
 */

export type MdBlock =
  | { kind: 'h'; level: number; text: string }
  | { kind: 'p'; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'code'; lang: string; lines: string[] }
  | { kind: 'table'; head: string[]; rows: string[][] }
  | { kind: 'ul'; items: string[] };

const BLOCK_START = /^(#{1,6}\s|```|\s*\||\s*[-*]\s+|\s*>)/;
const QUOTE = /^\s*>\s?/;

/** Splits a table row on its pipes, leaving `\|` inside a cell as a pipe. */
function cells(line: string): string[] {
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === '\\' && body[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (ch === '|') {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** A run of lines that each start a block of one kind: a table's rows, a list's items, a quote's lines. */
function runOf(lines: readonly string[], at: number, starts: (line: string) => boolean): string[] {
  const out: string[] = [];
  for (let i = at; i < lines.length && starts(lines[i]!); i++) out.push(lines[i]!);
  return out;
}

/** Markdown as blocks the page draws as React elements. Never HTML: the text stays text. */
export function parseMarkdown(md: string): MdBlock[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = /^```([\w-]*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) body.push(lines[i++]!);
      i++;
      out.push({ kind: 'code', lang: fence[1] ?? '', lines: body });
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      out.push({ kind: 'h', level: h[1]!.length, text: h[2]!.trim() });
      i++;
      continue;
    }
    if (line.trimStart().startsWith('|')) {
      const rows = runOf(lines, i, (l) => l.trimStart().startsWith('|')).map(cells);
      i += rows.length;
      const sep = rows[1]?.every((c) => /^:?-{2,}:?$/.test(c)) ? 1 : -1;
      out.push({ kind: 'table', head: rows[0] ?? [], rows: rows.filter((_, k) => k !== 0 && k !== sep) });
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = runOf(lines, i, (l) => /^\s*[-*]\s+/.test(l));
      i += items.length;
      out.push({ kind: 'ul', items: items.map((l) => l.replace(/^\s*[-*]\s+/, '')) });
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted = runOf(lines, i, (l) => QUOTE.test(l));
      i += quoted.length;
      out.push({ kind: 'quote', text: quoted.map((l) => l.replace(QUOTE, '').trim()).filter(Boolean).join(' ') });
      continue;
    }
    const para = [line.trim()];
    i++;
    while (i < lines.length && lines[i]!.trim() && !BLOCK_START.test(lines[i]!)) para.push(lines[i++]!.trim());
    out.push({ kind: 'p', text: para.join(' ') });
  }
  return out;
}

/** A table header of report.md as plain words, for the label a narrow panel shows above each value. */
export const plainCell = (text: string): string => text.replace(/`/g, '').trim();

/** A cell that reads as one token (a run id, a role, an outcome, a count) and so stays on one line while longer cells wrap. */
export function cellKeepsWhole(text: string): boolean {
  const t = plainCell(text);
  return t.length <= 16 && !/\s/.test(t);
}

/**
 * Text cut where JSON in a narrow cell may wrap before it has to break a word: after each `,`, `:`,
 * `(` and `{` of a long word (`issue_refund({"order_id":"A-1042",…`). Words of plain text wrap at
 * their spaces as they are.
 */
export function breakPoints(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (const piece of text.split(/(\s+)/)) {
    if (piece.length <= 12 || /\s/.test(piece)) {
      cur += piece;
      continue;
    }
    const [first = '', ...rest] = piece.split(/(?<=[,:({])/);
    cur += first;
    for (const part of rest) {
      out.push(cur);
      cur = part;
    }
  }
  out.push(cur);
  return out;
}

/** A piece of a line: code, a link (its words and an http(s) address), or plain text. */
export type InlinePart = { code: boolean; text: string; href?: string };

/** Plain text cut where it links: `[words](https://…)`. A link to anything but an http(s) address stays the text it is. */
function linkParts(text: string): InlinePart[] {
  const out: InlinePart[] = [];
  const re = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > at) out.push({ code: false, text: text.slice(at, m.index) });
    out.push({ code: false, text: m[1]!, href: m[2]! });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ code: false, text: text.slice(at) });
  return out;
}

/** A line of Markdown cut where it sets code in backticks, and where its text links. */
export function inlineParts(text: string): InlinePart[] {
  const out: InlinePart[] = [];
  const re = /`([^`]+)`/g;
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > at) out.push(...linkParts(text.slice(at, m.index)));
    out.push({ code: true, text: m[1]! });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push(...linkParts(text.slice(at)));
  return out;
}

/** Text with its `code` set in code and its links as links. `breaks` lets a narrow table cell wrap JSON after its commas and colons (`breakPoints`). */
function Inline({ text, breaks = false }: { text: string; breaks?: boolean }) {
  const words = (t: string) => (breaks ? breakPoints(t).map((w, i) => (i ? <Fragment key={i}><wbr />{w}</Fragment> : <Fragment key={i}>{w}</Fragment>)) : t);
  return (
    <>
      {inlineParts(text).map((p, i) =>
        p.code ? (
          <code key={i}>{words(p.text)}</code>
        ) : p.href ? (
          <a key={i} href={p.href} target="_blank" rel="noopener noreferrer">
            {p.text}
          </a>
        ) : (
          <span key={i}>{words(p.text)}</span>
        ),
      )}
    </>
  );
}

function Block({ b }: { b: MdBlock }) {
  switch (b.kind) {
    case 'h':
      return b.level <= 2 ? (
        <h3>
          <Inline text={b.text} />
        </h3>
      ) : (
        <h4>
          <Inline text={b.text} />
        </h4>
      );
    case 'p':
      return (
        <p>
          <Inline text={b.text} />
        </p>
      );
    case 'quote':
      return (
        <blockquote>
          <p>
            <Inline text={b.text} />
          </p>
        </blockquote>
      );
    case 'ul':
      return (
        <ul>
          {b.items.map((x, i) => (
            <li key={i}>
              <Inline text={x} />
            </li>
          ))}
        </ul>
      );
    case 'code':
      return (
        <pre className="fxcode">
          {b.lines.map((l, i) => (
            <span key={i} className={b.lang === 'diff' ? (l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : undefined) : undefined}>
              {l}
              {'\n'}
            </span>
          ))}
        </pre>
      );
    case 'table':
      return (
        <div className="fxtable">
          <table>
            <thead>
              <tr>
                {b.head.map((h, i) => (
                  <th key={i}>
                    <Inline text={h} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((c, j) => (
                    // Where the panel is narrow, a row stands as its headers and values (`data-h`), so no column is out of view.
                    <td key={j} data-h={plainCell(b.head[j] ?? '')} className={cellKeepsWhole(c) ? 'nw' : undefined}>
                      <Inline text={c} breaks />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

/** The blocks, a section the page shows around them already gathered under its heading (`fold`). */
type MdPart = { fold: null; b: MdBlock } | { fold: string; blocks: MdBlock[] };

/**
 * The blocks with each section `titles` names (`### What failed`) gathered under its heading, up to
 * the next heading. A repair report's last line, what the repair cost, is in no section.
 */
function foldedBlocks(blocks: readonly MdBlock[], titles: readonly string[]): MdPart[] {
  const out: MdPart[] = [];
  let into: MdBlock[] | null = null;
  for (const [i, b] of blocks.entries()) {
    if (b.kind === 'h') into = null;
    const foot = i === blocks.length - 1 && b.kind === 'p' && b.text.startsWith('Cost:');
    if (into && !foot) into.push(b);
    else if (b.kind === 'h' && titles.includes(b.text)) {
      into = [];
      out.push({ fold: b.text, blocks: into });
    } else out.push({ fold: null, b });
  }
  return out;
}

/**
 * Markdown boxed as a preview of the pull request it is the body of (`.prbody.md`), drawn from
 * blocks, never as HTML. Repair's report.md passes `folds`: the sections its step shows around it
 * already (What failed and Candidates, by heading) start closed, the heading, a summary of the
 * section (`1 run · lost at model call #5`) and a caret that opens it. A migration's body passes none.
 */
export function Markdown({ text, folds = {} }: { text: string; folds?: Readonly<Record<string, string>> }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div className="prbody md">
      {foldedBlocks(blocks, Object.keys(folds)).map((p, i) => (p.fold === null ? <Block key={i} b={p.b} /> : <Fold key={p.fold} title={p.fold} summary={folds[p.fold] ?? ''} blocks={p.blocks} />))}
    </div>
  );
}

/** A section that opens on request: `Show what failed`. */
function Fold({ title, summary, blocks }: { title: string; summary: string; blocks: readonly MdBlock[] }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const name = `${title.charAt(0).toLowerCase()}${title.slice(1)}`;
  return (
    <>
      <h4 className="mdh">
        <span>{title}</span>
        <span className="mds">{summary}</span>
        <button type="button" className="xbtn" aria-expanded={open} aria-controls={open ? id : undefined} aria-label={`${open ? 'Hide' : 'Show'} ${name}`} onClick={() => setOpen(!open)}>
          <Icon name="caret" />
        </button>
      </h4>
      {open ? (
        <div id={id}>
          {blocks.map((b, i) => (
            <Block key={i} b={b} />
          ))}
        </div>
      ) : null}
    </>
  );
}
