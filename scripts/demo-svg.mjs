#!/usr/bin/env node
// Renders site/demo.svg, an animated terminal session (record → clean replay → fork with a diff), and
// site/demo-static.svg, the same session fully drawn (for the README and anywhere animation is unwanted),
// captured from the real CLI against the scripted mock API, so the picture is never out of date.
// Usage: node scripts/demo-svg.mjs   (after `npm run build`)
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'packages', 'cli', 'bin', 'shadowlap.js');
const agent = join(root, 'testing', 'reference-agent', 'dist', 'main.js');
const mockServer = join(root, 'testing', 'reference-agent', 'dist', 'mock-server.js');

// ---- capture a real session ----
const mock = spawn(process.execPath, [mockServer], { stdio: ['ignore', 'pipe', 'inherit'] });
const mockUrl = await new Promise((resolveUrl, reject) => {
  let buf = '';
  mock.stdout.on('data', (c) => {
    buf += c;
    const m = /http:\/\/[^\s]+/.exec(buf);
    if (m) resolveUrl(m[0]);
  });
  mock.on('exit', () => reject(new Error('mock server exited')));
});
const cwd = mkdtempSync(join(tmpdir(), 'shadowlap-demo-'));
const env = { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mockUrl, NO_COLOR: '1', SHADOWLAP_TELEMETRY: '0' };
// The agent's log lines and Shadowlap's report both go to stderr; the agent's stdout is its JSON result, not part of the story.
const fp = (args, extra = {}) => {
  const r = spawnSync(process.execPath, [cli, ...args], { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (r.error) throw r.error;
  return r.stderr ?? '';
};

// A fixed date keeps the recording reproducible; the fork comes from a changed system prompt,
// which is the scene the README's quickstart walks through.
const record = fp(['run', '--', process.execPath, agent], { AGENT_DATE: '2026-09-16' });
const runId = /Recorded (\S+):/.exec(record)?.[1];
if (!runId) throw new Error(`no run id in:\n${record}`);
const replay = fp(['replay', runId], { AGENT_DATE: '2026-09-16' });
const fork = fp(['replay', runId], { AGENT_DATE: '2026-09-16', AGENT_SYSTEM_SUFFIX: 'Be brief.' });
mock.kill();
rmSync(cwd, { recursive: true, force: true });

// ---- turn the transcript into scenes: a typed command, then output lines ----
const short = runId.slice(0, 10);
const tidy = (text) =>
  text
    .replace(new RegExp(runId, 'g'), short)
    .replace(new RegExp(process.execPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+' + agent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), 'node agent.js')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => !/^\[shadowlap\] (recording|replaying) run/.test(l) && !/^\s*shadowlap show /.test(l));
const agentLines = (text) => {
  const lines = tidy(text);
  const i = lines.findIndex((l) => /^[●✓✗⑂]/.test(l));
  // Shadowlap's report only: the agent's own log lines are noise here, except a write the fork refused.
  const agent = lines.slice(0, i).filter((l) => /ShadowlapWriteBlocked/.test(l)).map((l) => l.replace(/ \(use --writes.*\)$/, ''));
  const report = lines.slice(i).filter((l) => l && !/recorded calls? (not reached|left unused)/.test(l));
  return [...agent, ...report];
};
const scenes = [
  { cmd: 'shadowlap run -- node agent.js', lines: agentLines(record) },
  { cmd: `shadowlap replay ${short}`, lines: agentLines(replay) },
  { cmd: `AGENT_SYSTEM_SUFFIX="Be brief." shadowlap replay ${short}`, lines: agentLines(fork) },
];

// ---- layout ----
const COLS = 126;
const FONT = 12.5;
const CW = FONT * 0.6; // monospace advance
const LH = FONT * 1.5;
const PAD = 18;
const HEAD = 30;
const W = Math.round(COLS * CW + PAD * 2);
const palette = { bg: '#0f1012', bar: '#15171a', text: '#e6e4dd', dim: '#8b8f96', prompt: '#62d1de', ok: '#7ecf8a', err: '#ff7b72', warn: '#e6c060', add: '#7ecf8a', del: '#ff7b72', cyan: '#62d1de' };
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function colorOf(line) {
  if (/^●/.test(line)) return palette.ok;
  if (/^✓/.test(line)) return palette.ok;
  if (/^✗/.test(line)) return palette.err;
  if (/^⑂/.test(line)) return palette.warn;
  if (/^\s+!/.test(line)) return palette.warn;
  if (/^\s+-\s/.test(line)) return palette.del;
  if (/^\s+\+\s/.test(line)) return palette.add;
  if (/^\s+~ \$/.test(line) || /^\s+hint:/.test(line)) return palette.cyan;
  if (/^\[/.test(line) || /^\s+compared with|^\s+shadowlap normalize/.test(line)) return palette.dim;
  return palette.text;
}

// ---- timing: every element fades in at its own moment; the whole thing loops ----
const TYPE = 0.045; // per character
const LINE = 0.09; // per output line
const PAUSE = 2.4; // after each scene
const HOLD = 4.5; // at the end
// A line longer than the terminal wraps at a word boundary; the continuation is indented and keeps the line's color.
function wrap(line) {
  if (line.length <= COLS) return [line];
  const indent = (/^\s*/.exec(line)?.[0].length ?? 0) + 4;
  const out = [];
  let rest = line;
  let first = true;
  while (rest.length > COLS) {
    let cut = rest.lastIndexOf(' ', COLS);
    if (cut < COLS / 2) cut = COLS;
    out.push(rest.slice(0, cut));
    rest = ' '.repeat(indent) + rest.slice(cut).trimStart();
    first = false;
  }
  out.push(rest);
  void first;
  return out;
}
let t = 0.6;
const items = [];
for (const s of scenes) {
  items.push({ kind: 'cmd', text: s.cmd, at: t });
  t += s.cmd.length * TYPE + 0.5;
  for (const l of s.lines) {
    const parts = wrap(l);
    for (const part of parts) items.push({ kind: 'line', text: part, color: colorOf(l), at: t });
    t += l ? LINE : LINE / 2;
  }
  items.push({ kind: 'gap', text: '', at: t });
  t += PAUSE;
}
const TOTAL = t + HOLD;
const K = (at) => Math.min(0.9999, at / TOTAL).toFixed(4);
const appear = (at) => `<animate attributeName="opacity" values="0;0;1;1" keyTimes="0;${K(Math.max(0, at - 0.001))};${K(at)};1" dur="${TOTAL.toFixed(1)}s" repeatCount="indefinite"/>`;


let svgLines = '';
let row = 0;
for (const it of items) {
  const y = HEAD + PAD + row * LH + FONT;
  if (it.kind === 'cmd') {
    let x = PAD;
    let chars = `<tspan fill="${palette.prompt}">$ </tspan>`;
    x += 2 * CW;
    const spans = [...it.text].map((ch, i) => `<tspan x="${(x + i * CW).toFixed(1)}" opacity="0">${esc(ch)}${appear(it.at + i * TYPE)}</tspan>`).join('');
    svgLines += `<text x="${PAD}" y="${y.toFixed(1)}" fill="${palette.text}" opacity="0">${chars}${spans}${appear(it.at)}</text>\n`;
    // caret while typing
    row++;
  } else if (it.kind === 'line') {
    if (it.text) svgLines += `<text x="${PAD}" y="${y.toFixed(1)}" fill="${it.color}" opacity="0" xml:space="preserve">${esc(it.text)}${appear(it.at)}</text>\n`;
    row++;
  } else {
    row++;
  }
}

const H = Math.round(HEAD + PAD + row * LH + PAD);
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace" font-size="${FONT}">
  <title>shadowlap: record, replay, fork</title>
  <rect width="${W}" height="${H}" rx="8" fill="${palette.bg}"/>
  <rect width="${W}" height="${HEAD}" rx="8" fill="${palette.bar}"/>
  <rect y="${HEAD - 8}" width="${W}" height="8" fill="${palette.bar}"/>
  <circle cx="18" cy="15" r="5" fill="#ff5f57"/><circle cx="36" cy="15" r="5" fill="#febc2e"/><circle cx="54" cy="15" r="5" fill="#28c840"/>
  <text x="${W / 2}" y="19" text-anchor="middle" fill="${palette.dim}" font-size="11">shadowlap · record once, replay for free, fork what changed</text>
${svgLines}</svg>
`;
const out = join(root, 'site', 'demo.svg');
writeFileSync(out, svg);
// The static version: every line visible, no animation.
const staticSvg = svg.replace(/<animate [^>]*\/>/g, '').replace(/ opacity="0"/g, '');
writeFileSync(join(root, 'site', 'demo-static.svg'), staticSvg);
console.log(`wrote ${out} and demo-static.svg: ${scenes.length} scenes, ${items.length} lines, ${TOTAL.toFixed(1)} s loop, ${(svg.length / 1024).toFixed(0)} KB`);
