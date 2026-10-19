#!/usr/bin/env node
// The README's terminal, from the real CLI: the demo project's refund agent (scripts/demo-store/
// project/agent.mjs) recorded, replayed and blamed, then replayed again once its prompt is fixed, so
// it forks with the diff. The models are the demo's scripted ones (scripts/demo-store/models.mjs) on
// the mock Anthropic API in testing/, so no key is needed and nothing leaves this machine. Each command
// runs in a pseudo-terminal (`script`, on macOS and Linux), so the colours are the CLI's own.
//
//   npm run build && node scripts/demo-svg.mjs
//
// It writes .github/assets/readme/terminal.svg, which types each command and shows what it printed,
// on a loop, and terminal-static.svg, the same session drawn whole, for where motion is unwanted.
//
// A line is shown as the CLI printed it, or left out; none is changed. Left out: the progress a
// command prints while it works (`[shadowlap] recording run …`, blame's probes and their attempts),
// the commands it suggests next (`shadowlap show …`), and the detail under a result (blame's
// statistics, probe table and cost; a fork's unused calls and the run it was compared with). Any
// other line stops the script, so a change in what the CLI prints is looked at before it is drawn.
// Run ids carry the time they were made; the rest comes out the same on every run.
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(root, 'packages', 'cli', 'bin', 'shadowlap.js');
const kit = join(root, 'scripts', 'demo-store');
const outDir = join(root, '.github', 'assets', 'readme');

for (const built of ['packages/cli/dist/index.js', 'testing/mock-anthropic/dist/index.js']) {
  if (!existsSync(join(root, built))) {
    console.error(`demo-svg: ${built} is missing; run npm run build first`);
    process.exit(1);
  }
}
if (process.platform === 'win32') {
  console.error('demo-svg: the session runs in a pseudo-terminal made by `script`, on macOS or Linux');
  process.exit(1);
}

const { startMockAnthropic } = await import('@shadowlap-testing/mock-anthropic');
const { createModels } = await import(pathToFileURL(join(kit, 'models.mjs')).href);

// ---- the project: the demo's support agents, in a git repository of their own ----

const work = mkdtempSync(join(tmpdir(), 'shadowlap-terminal-'));
const project = join(work, 'support-agent');
cpSync(join(kit, 'project'), project, { recursive: true });
symlinkSync(join(root, 'node_modules'), join(project, 'node_modules'), 'dir');
writeFileSync(join(project, '.gitignore'), 'node_modules\n.shadowlap/\n');

const models = createModels();
const anthropic = await startMockAnthropic({ script: models.anthropic });

// Nothing of this machine's own setup reaches the session: no provider keys or endpoints, no CI
// markers, no git configuration. Colour stays on: the terminal is a real one.
const LEAKS = /^(SHADOWLAP_|ANTHROPIC_|OPENAI_|GOOGLE_|GEMINI_|AWS_|AZURE_|LANGFUSE_|LANGSMITH_|OTEL_|GIT_|GITHUB_|GITLAB_|BITBUCKET_|BUILDKITE|CIRCLECI|JENKINS_URL|TF_BUILD|CI$|NODE_OPTIONS|PYTHONPATH|NO_COLOR|FORCE_COLOR)/;
const ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !LEAKS.test(k))),
  TERM: 'xterm-256color',
  SHADOWLAP_TELEMETRY: '0',
  SHADOWLAP_HOME: join(work, 'home'),
  SHADOWLAP_UPSTREAM_ANTHROPIC: anthropic.url,
  SHADOWLAP_AUTHOR: 'dana@example.com',
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: '1',
};
const DANA = { GIT_AUTHOR_NAME: 'Dana', GIT_AUTHOR_EMAIL: 'dana@example.com', GIT_COMMITTER_NAME: 'Dana', GIT_COMMITTER_EMAIL: 'dana@example.com' };
const git = (...args) => execFileSync('git', args, { cwd: project, env: { ...ENV, ...DANA }, stdio: ['ignore', 'pipe', 'pipe'] });

/** A word as a shell would need it typed. */
const quote = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** Runs the CLI in a pseudo-terminal and returns what the terminal showed: stdout and stderr in the order they came. */
function inTerminal(args) {
  const argv = [process.execPath, CLI, ...args];
  // BSD script (macOS) takes the command as arguments; util-linux script takes one shell line.
  const scriptArgs = process.platform === 'linux' ? ['-qec', argv.map(quote).join(' '), devNull] : ['-q', devNull, ...argv];
  return new Promise((done, fail) => {
    const child = spawn('script', scriptArgs, { cwd: project, env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => (text += d));
    child.stderr.on('data', (d) => (text += d));
    child.on('error', fail);
    // The terminal first echoes the end of input `script` passes on: ^D and two backspaces.
    child.on('close', () => done(text.replace(/^(?:\^D\x08\x08|\x04)+/, '').replace(/\r\n?/g, '\n')));
  });
}

/** Terminal output as lines of runs, each with the colour and weight its escape codes gave it. */
function parseTerminal(text) {
  const lines = [];
  let line = [];
  let style = { fg: null, bold: false, dim: false };
  let buf = '';
  const flush = () => {
    if (buf) line.push({ text: buf, ...style });
    buf = '';
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\x1b') {
      const m = /^\x1b\[([0-9;]*)([A-Za-z])/.exec(text.slice(i, i + 24));
      if (m) {
        if (m[2] === 'm') {
          flush();
          for (const code of (m[1] || '0').split(';').map(Number)) {
            if (code === 0) style = { fg: null, bold: false, dim: false };
            else if (code === 1) style = { ...style, bold: true };
            else if (code === 2) style = { ...style, dim: true };
            else if (code === 22) style = { ...style, bold: false, dim: false };
            else if (code >= 30 && code <= 37) style = { ...style, fg: code };
            else if (code === 39) style = { ...style, fg: null };
          }
        }
        i += m[0].length - 1;
        continue;
      }
    }
    if (ch === '\n') {
      flush();
      lines.push(line);
      line = [];
      continue;
    }
    buf += ch;
  }
  flush();
  if (line.length) lines.push(line);
  return lines;
}
const plain = (line) => line.map((r) => r.text).join('');

/**
 * The lines of one command's output to show: those `keep` matches, in order, with one blank line where
 * the terminal had one between two of them. A line `drop` matches is left out; any other line stops
 * the script, and so does a `keep` that matched nothing.
 */
function excerpt(name, text, keep, drop) {
  const shown = [];
  const found = new Set();
  let gap = false;
  for (const line of parseTerminal(text)) {
    const s = plain(line);
    if (!s.trim()) {
      gap = shown.length > 0;
      continue;
    }
    const k = keep.findIndex((re) => re.test(s));
    if (k < 0) {
      if (drop.some((re) => re.test(s))) continue;
      throw new Error(`demo-svg: ${name} printed a line the picture has no rule for:\n  ${s}\n\nall it printed:\n${text}`);
    }
    found.add(k);
    if (gap) shown.push([]);
    gap = false;
    shown.push(line);
  }
  const missing = keep.filter((_, i) => !found.has(i));
  if (missing.length) throw new Error(`demo-svg: ${name} printed nothing for ${missing.join(', ')}:\n${text}`);
  return shown;
}

// ---- the session ----

const EXPECT = '{"tools":{"issue_refund":0}}';
const SHOW = /^ {2}shadowlap show \w+$/;
const scenes = [];
try {
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'Start the support agent');

  // The model refunds the $240 order its policy says needs a manager.
  models.control.refund = 'refund';
  const recordArgs = ['run', '--', 'node', 'agent.mjs', 'A-1042'];
  const recorded = await inTerminal(recordArgs);
  const runId = /recording run (\w{26})/.exec(recorded)?.[1];
  if (!runId) throw new Error(`demo-svg: no run was recorded:\n${recorded}`);
  const id = runId.slice(0, 10);
  scenes.push({ args: recordArgs, work: 0.7, lines: excerpt('run', recorded, [/^Refunded \$240 for A-1042 /, /^● Recorded \w{26}: /], [/^\[shadowlap\] recording run /, SHOW]) });

  const replayArgs = ['replay', id];
  scenes.push({ args: replayArgs, work: 0.35, lines: excerpt('replay', await inTerminal(replayArgs), [/^Refunded \$240 for A-1042 /, /^✓ Replay clean: /], [/^\[shadowlap\] replaying run /, SHOW]) });

  // Asked again at the decision, the model escalates every other time: the rescue blame looks for.
  models.control.refund = 'alternate';
  const blameArgs = ['blame', id, '--expect', EXPECT];
  const blamed = await inTerminal(blameArgs);
  models.control.refund = 'refund';
  scenes.push({
    args: blameArgs,
    work: 1.4,
    lines: excerpt(
      'blame',
      blamed,
      [/^⑂ The run was lost at model call #\d+ /, /^ {2}Confidence: /, /^ {2}At #\d+ +the recording /, /^ +a rescued fork /],
      [
        // its progress, as it works
        /^⑂ Blaming \w+ /,
        /^ {2}each probe: /,
        /^ {2}at most \d+ probes /,
        /^ {2}replaying \w+ as recorded/,
        /^ {2}✓ replays as recorded and fails/,
        /^ {2}model call #\d+ \(/,
        /^ {4}attempt \d+ /,
        /^ {4}(rescued|lost)\b/,
        // the detail under its result, and what to run next
        /^ {2}The re-asked call #\d+: /,
        /^ {2}Probes /,
        /^ {4}#\d+ /,
        /^ {2}\d+ attempts · /,
        /^ {2}oracle: /,
        /^ {2}rescued fork: shadowlap diff /,
        /^ {2}fix fx-\w+ · /,
      ],
    ),
  });

  // The fix blame's rescue points to, in the agent's prompt: the one the demo's repair proposes and verifies.
  const agent = join(project, 'agent.mjs');
  const source = readFileSync(agent, 'utf8');
  const prompt = "'You are a support agent. Follow the refund policy.'";
  if (!source.includes(prompt)) throw new Error(`demo-svg: agent.mjs no longer has the prompt ${prompt}`);
  writeFileSync(agent, source.replace(prompt, "'You are a support agent. Follow the refund policy: escalate every refund above the limit it sets.'"));
  const forkArgs = ['replay', id, '--expect', EXPECT];
  scenes.push({
    args: forkArgs,
    work: 0.5,
    lines: excerpt(
      'the replay after the fix',
      await inTerminal(forkArgs),
      [/^Escalated: the refund of \$240 /, /^⑂ Forked at call \d+: /, /^✗ Diverged at call \d+ /, /^ {2}~ \$\.system$/, /^ {6}- "/, /^ {6}\+ "/, /^✓ \d+ checks? passed/, /^ {2}✓ issue_refund called 0 times$/],
      [/^\[shadowlap\] replaying run /, /^ {2}\d+ recorded calls? left unused after the fork: /, /^ {2}compared with run \w+…, call \d+$/, SHOW],
    ),
  });
} finally {
  await anthropic.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

// ---- the picture: rows of text on the dashboard's ink, one column per character ----

const FONT = 13;
const CW = FONT * 0.6;
const LH = 20;
const PX = 26;
const PY = 22;
const C = { bg: '#0e0f0b', edge: '#25261d', fg: '#eeede6', dim: '#8d8b7b', prompt: '#76745f', cursor: '#c4f233', 30: '#55564a', 31: '#ff6b5e', 32: '#c4f233', 33: '#f2c94c', 34: '#7aa7ff', 35: '#c49bff', 36: '#6fcfe0', 37: '#eeede6' };
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fillOf = (run) => (run.fg ? C[run.fg] : run.dim ? C.dim : C.fg);

// Pacing, in seconds: the prompt waiting, typing, the command working, its lines arriving, time to read.
const P = { first: 0.5, idle: 0.45, perChar: 0.034, enter: 0.3, perLine: 0.07, readBase: 1.5, readPerLine: 0.24, end: 4, fade: 0.5 };

const rows = [];
let t = P.first;
for (const [i, scene] of scenes.entries()) {
  if (i) rows.push({ kind: 'blank' });
  const text = `shadowlap ${scene.args.map(quote).join(' ')}`;
  const typeAt = t + P.idle;
  const typedAt = typeAt + text.length * P.perChar;
  const outAt = typedAt + P.enter + scene.work;
  rows.push({ kind: 'cmd', text, showAt: t, typeAt, typedAt, outAt });
  let at = outAt;
  for (const line of scene.lines) {
    if (!line.length) {
      rows.push({ kind: 'blank' });
      continue;
    }
    rows.push({ kind: 'out', runs: line, at });
    at += P.perLine;
  }
  t = at + P.readBase + P.readPerLine * scene.lines.filter((l) => l.length).length;
}
// The next prompt waits under the last command until the loop starts again.
const last = t - P.readBase;
rows.push({ kind: 'blank' });
rows.push({ kind: 'cmd', text: '', showAt: last, typeAt: last, typedAt: last, outAt: Infinity });
const TOTAL = t + P.end + P.fade;

const width = (r) => (r.kind === 'cmd' ? 2 + r.text.length + 1 : r.kind === 'out' ? plain(r.runs).length : 0);
const COLS = Math.max(...rows.map(width)) + 1;
const W = Math.round(PX * 2 + COLS * CW);
const H = Math.round(PY * 2 + rows.length * LH);
const pct = (s) => `${Math.min(100, (s / TOTAL) * 100).toFixed(3)}%`;
const fadeAt = pct(TOTAL - P.fade);

/** Text at its exact column: each word of ASCII in a tspan, any other character in one of its own, spaces skipped. */
function spans(runs, startCol) {
  let col = startCol;
  let out = '';
  for (const run of runs) {
    const fill = fillOf(run);
    const attrs = `${fill === C.fg ? '' : ` fill="${fill}"`}${run.bold ? ' font-weight="700"' : ''}`;
    for (const tok of run.text.match(/ +|[\x21-\x7e]+|[^ \x21-\x7e]/g) ?? []) {
      if (!tok.startsWith(' ')) out += `<tspan x="${(PX + col * CW).toFixed(1)}"${attrs}>${esc(tok)}</tspan>`;
      col += tok.length;
    }
  }
  return out;
}

function render(animated) {
  const css = [];
  const body = [];
  let n = 0;
  const keyframes = (frames) => {
    const k = `k${n++}`;
    css.push(`.${k}{animation:${k} ${TOTAL.toFixed(2)}s infinite}@keyframes ${k}{${frames}}`);
    return k;
  };
  const appear = (at) => `a ${keyframes(`0%{opacity:0;animation-timing-function:step-end}${pct(at)}{opacity:1;animation-timing-function:step-end}${fadeAt}{opacity:1;animation-timing-function:linear}100%{opacity:0}`)}`;
  rows.forEach((r, i) => {
    const top = PY + i * LH;
    const y = (top + 14.5).toFixed(1);
    if (r.kind === 'out') body.push(`<text y="${y}"${animated ? ` class="${appear(r.at)}"` : ''}>${spans(r.runs, 0)}</text>`);
    if (r.kind !== 'cmd') return;
    body.push(`<text y="${y}"${animated ? ` class="${appear(r.showAt)}"` : ''}><tspan x="${PX}" fill="${C.prompt}">$</tspan>${spans([{ text: r.text, fg: null, bold: false, dim: false }], 2)}</text>`);
    // The cursor: animated, it types the command over a cover of the line's own ink; drawn whole, it waits at the last prompt.
    const x0 = PX + 2 * CW;
    const cursor = `<rect x="${x0.toFixed(1)}" y="${top + 3}" width="${CW.toFixed(1)}" height="${LH - 6}" fill="${C.cursor}"/>`;
    if (!animated) {
      if (!r.text) body.push(cursor);
      return;
    }
    const L = `${(r.text.length * CW).toFixed(1)}px`;
    const gone = Math.min(r.outAt, TOTAL - P.fade);
    const k = keyframes(
      `0%{opacity:0;transform:translateX(0);animation-timing-function:step-end}${pct(r.showAt)}{opacity:1;transform:translateX(0);animation-timing-function:step-end}${pct(r.typeAt)}{opacity:1;transform:translateX(0);animation-timing-function:steps(${Math.max(1, r.text.length)},end)}${pct(r.typedAt)}{opacity:1;transform:translateX(${L});animation-timing-function:step-end}${pct(gone)}{opacity:${r.text ? 0 : 1};transform:translateX(${L});animation-timing-function:linear}100%{opacity:0;transform:translateX(${L})}`,
    );
    body.push(`<g class="c ${k}">${cursor}<rect x="${(x0 + CW).toFixed(1)}" y="${top}" width="${(W - PX - x0 - CW).toFixed(1)}" height="${LH}" fill="${C.bg}"/></g>`);
  });
  const transcript = scenes.map((s) => [`$ shadowlap ${s.args.map(quote).join(' ')}`, ...s.lines.map(plain)].join('\n')).join('\n\n');
  const style = [
    `text{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono","DejaVu Sans Mono",monospace;font-size:${FONT}px;fill:${C.fg};white-space:pre}`,
    ...(animated ? [...css, '@media (prefers-reduced-motion:reduce){.a{animation:none!important;opacity:1!important}.c{display:none}}'] : []),
  ].join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title desc">
<title id="title">Shadowlap in a terminal: a refund agent recorded, replayed exactly, blamed to the model call that lost the run, and replayed with the fix</title>
<desc id="desc">${esc(transcript)}</desc>
<style>
${style}
</style>
<rect width="${W}" height="${H}" rx="12" fill="${C.bg}"/>
<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="11.5" fill="none" stroke="${C.edge}"/>
${body.join('\n')}
</svg>
`;
}

mkdirSync(outDir, { recursive: true });
const files = [
  ['terminal.svg', render(true)],
  ['terminal-static.svg', render(false)],
];
for (const [name, svg] of files) writeFileSync(join(outDir, name), svg);
console.log(`wrote ${files.map(([name, svg]) => `${relative(root, join(outDir, name))} (${(Buffer.byteLength(svg) / 1024).toFixed(0)} KB)`).join(' and ')}: ${scenes.length} commands, ${rows.length} rows of ${COLS} columns, a ${TOTAL.toFixed(1)} s loop`);
