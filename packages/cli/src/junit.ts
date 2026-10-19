import { safeText } from '@shadowlap/engine';

/** Minimal JUnit XML for CI systems that render test reports. */

export interface JunitCase {
  name: string;
  classname: string;
  timeSeconds: number;
  failure?: { message: string; details: string };
  /** Neither passed nor failed: an inconclusive verdict CI lets through. */
  skipped?: { message: string };
  systemOut?: string;
}

/**
 * Text as XML 1.0 can carry it. An agent's output is recorded as it printed it, escape codes from a
 * coloured logger included, and XML has no way to write most control characters, not even escaped:
 * one makes every parser refuse the whole report. They show as escapes (`\x1b`), as the Markdown
 * report shows them; what XML has no character for at all (a lone surrogate, U+FFFE, U+FFFF)
 * becomes U+FFFD. A Windows line break is a line break.
 */
function xmlText(s: string): string {
  return safeText(s.replace(/\r\n/g, '\n')).replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]|[￾￿]/g, '�');
}

function esc(s: string): string {
  return xmlText(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function cdata(s: string): string {
  return `<![CDATA[${xmlText(s).replace(/\]\]>/g, ']]]]><![CDATA[>')}]]>`;
}

export function junitXml(suiteName: string, cases: JunitCase[]): string {
  const failures = cases.filter((c) => c.failure).length;
  const skipped = cases.filter((c) => c.skipped && !c.failure).length;
  const time = cases.reduce((t, c) => t + c.timeSeconds, 0);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="${esc(suiteName)}" tests="${cases.length}" failures="${failures}" errors="0"${skipped ? ` skipped="${skipped}"` : ''} time="${time.toFixed(3)}">`,
  ];
  for (const c of cases) {
    lines.push(`  <testcase name="${esc(c.name)}" classname="${esc(c.classname)}" time="${c.timeSeconds.toFixed(3)}">`);
    if (c.failure) lines.push(`    <failure message="${esc(c.failure.message)}">${cdata(c.failure.details)}</failure>`);
    else if (c.skipped) lines.push(`    <skipped message="${esc(c.skipped.message)}"/>`);
    if (c.systemOut) lines.push(`    <system-out>${cdata(c.systemOut)}</system-out>`);
    lines.push('  </testcase>');
  }
  lines.push('</testsuite>', '');
  return lines.join('\n');
}
