/** Minimal JUnit XML for CI systems that render test reports. */

export interface JunitCase {
  name: string;
  classname: string;
  timeSeconds: number;
  failure?: { message: string; details: string };
  systemOut?: string;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function cdata(s: string): string {
  return `<![CDATA[${s.replace(/\]\]>/g, ']]]]><![CDATA[>')}]]>`;
}

export function junitXml(suiteName: string, cases: JunitCase[]): string {
  const failures = cases.filter((c) => c.failure).length;
  const time = cases.reduce((t, c) => t + c.timeSeconds, 0);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="${esc(suiteName)}" tests="${cases.length}" failures="${failures}" errors="0" time="${time.toFixed(3)}">`,
  ];
  for (const c of cases) {
    lines.push(`  <testcase name="${esc(c.name)}" classname="${esc(c.classname)}" time="${c.timeSeconds.toFixed(3)}">`);
    if (c.failure) lines.push(`    <failure message="${esc(c.failure.message)}">${cdata(c.failure.details)}</failure>`);
    if (c.systemOut) lines.push(`    <system-out>${cdata(c.systemOut)}</system-out>`);
    lines.push('  </testcase>');
  }
  lines.push('</testsuite>', '');
  return lines.join('\n');
}
