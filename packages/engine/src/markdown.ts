/**
 * Text from a run, a model or a tool, made safe to put in the Markdown GitHub renders: a pull
 * request's body, a comment, a job summary. The text comes from what an agent read and a model
 * wrote, which can be anyone's words, and the bot that posts it is trusted by whoever reads it.
 *
 * GitHub would read in it an image or a link (`![x](…)`, `[x](…)`, a footnote), a code span that
 * swallows what follows (`` ` ``), an escape (`\`), raw HTML (`<img>`, `<details>`, a comment),
 * math (`$…$`), emphasis, which hides the marks it reads, and once it has rendered the text, a
 * mention, which notifies whoever it names (`@name`, `@org/team`), an issue or pull request it
 * cross-references (`#12`, `owner/repo#12`, `GH-12`), and a URL, a `www.` address or an email
 * address it links. The marks are written as character references, which show as the characters
 * they stand for and start nothing; in the others, an empty HTML comment goes after the `@`, the
 * `#`, the scheme's `:` or the `www`, which splits the text GitHub looks for them in and shows
 * nothing. So the text shows as it is, in a paragraph, a heading, a table cell or an HTML block
 * alike, and makes nothing else.
 *
 * One line: line breaks and control characters become spaces. Characters that reorder or hide what
 * is shown (bidirectional controls, zero-width characters) are left out. A table cell's `|` is
 * escaped, and so is a mark that would start a block where the text starts a line (a heading, a
 * quote, a list, a rule). action/markdown.mjs, which the GitHub Action runs as plain JavaScript, is
 * the same.
 */
export function markdownText(text: string): string {
  return String(text)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/\\/g, '&#92;')
    .replace(/\[/g, '&#91;')
    .replace(/\]/g, '&#93;')
    .replace(/`/g, '&#96;')
    .replace(/\$/g, '&#36;')
    .replace(/<(?=[A-Za-z/!?])/g, '&lt;')
    .replace(/\*/g, '&#42;')
    .replace(/~/g, '&#126;')
    // An underscore inside a word (`issue_refund`) emphasizes nothing; one at a word's edge would.
    .replace(/(?<![A-Za-z0-9])_|_(?![A-Za-z0-9])/g, '&#95;')
    .replace(/\|/g, '\\|')
    .replace(/@(?=[A-Za-z0-9])/g, '@<!-- -->')
    // Not the `#` of a character reference written above: `&#92;`.
    .replace(/(?<!&)#(?=\d)/g, '#<!-- -->')
    .replace(/\b(GH-)(?=\d)/gi, '$1<!-- -->')
    .replace(/\b([A-Za-z][A-Za-z0-9+.-]*):(?=\/\/)/g, '$1:<!-- -->')
    .replace(/\b(www)(?=\.)/gi, '$1<!-- -->')
    // Last, so a `#` it writes as a reference is already split from the digits after it.
    .replace(/^(\s*)([#>+=-]|\d+(?=[.)]))/, (_m, space: string, mark: string) => `${space}${[...mark].map((ch) => `&#${ch.charCodeAt(0)};`).join('')}`);
}

/**
 * Text as a code span, `like this`, in which GitHub renders nothing: its own backticks can't end it
 * (the fence is longer than any run of them inside). In a table `cell`, its `|` is escaped, which
 * a table needs even in a code span; elsewhere a code span shows the backslash, so it isn't.
 */
export function markdownCode(text: string, { cell = false }: { cell?: boolean } = {}): string {
  const one = String(text).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ');
  const longest = Math.max(0, ...[...one.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  const pad = one.startsWith('`') || one.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${cell ? one.replace(/\|/g, '\\|') : one}${pad}${fence}`;
}

/** Lines in a fenced code block, in which GitHub renders nothing: the fence is longer than any run of backticks inside. */
export function markdownFence(text: string, lang = ''): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${lang}\n${text.replace(/\s+$/, '')}\n${fence}`;
}
