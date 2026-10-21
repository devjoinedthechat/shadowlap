#!/usr/bin/env node
// The README's terminal, from the real CLI: the demo project's refund agent (scripts/demo-store/
// project/agent.mjs) recorded, replayed and blamed; then its prompt is fixed, which a comment line
// at the prompt marks, and the run replayed again, so it forks with the diff. The models are the
// demo's scripted ones (scripts/demo-store/models.mjs) on the mock Anthropic API in testing/, so no
// key is needed and nothing leaves this machine. Each command runs in a pseudo-terminal (`script`,
// on macOS and Linux), so the colours are the CLI's own.
//
//   npm run build && node scripts/demo-svg.mjs
//
// It writes .github/assets/readme/terminal.svg, which types each command and shows what it printed,
// on a loop, and terminal-static.svg, the same session drawn whole, for where motion is unwanted.
// Both come again in 80 columns, terminal-medium.svg and terminal-medium-static.svg, for a tablet or
// a narrow window, and in 47, terminal-narrow.svg and terminal-narrow-static.svg, for a phone, which
// shows them at about 10 px. A command too long for the width goes on in a second line after a
// backslash, as a shell takes it, and a longer line breaks at the end of a clause.
//
// A line is shown as the CLI printed it, or left out; none is changed. Left out: the progress a
// command prints while it works (`[shadowlap] recording run …`, blame's probes and their attempts),
// the commands it suggests next (`shadowlap show …`), and the detail under a result (blame's
// statistics, probe table and cost; where a fork diverged, its unused calls and the run it was
// compared with). Any other line stops the script, so a change in what the CLI prints is looked at
// before it is drawn. Run ids carry the time they were made; the rest comes out the same on every run.
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

// The check the README's blame asks too: the project's refund-check.json, issue_refund never called for $240.
const EXPECT = '@refund-check.json';
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
  scenes.push({ args: recordArgs, work: 0.35, lines: excerpt('run', recorded, [/^Refunded \$240 for A-1042 /, /^● Recorded \w{26}: /], [/^\[shadowlap\] recording run /, SHOW]) });

  const replayArgs = ['replay', id];
  scenes.push({ args: replayArgs, work: 0.2, lines: excerpt('replay', await inTerminal(replayArgs), [/^Refunded \$240 for A-1042 /, /^✓ Replay clean: /], [/^\[shadowlap\] replaying run /, SHOW]) });

  // Asked again at the decision, the model escalates every other time: the rescue blame looks for.
  models.control.refund = 'alternate';
  const blameArgs = ['blame', id, '--expect', EXPECT];
  const blamed = await inTerminal(blameArgs);
  models.control.refund = 'refund';
  scenes.push({
    args: blameArgs,
    work: 0.5,
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
  writeFileSync(agent, source.replace(prompt, "'You are a support agent. Follow the refund policy: escalate every refund above the limit.'"));
  // The edit is made in an editor, between two commands: a comment line at the prompt says what it was.
  scenes.push({ text: '# agent.mjs: escalate refunds above the limit', work: 0, lines: [] });
  const forkArgs = ['replay', id, '--expect', EXPECT];
  scenes.push({
    args: forkArgs,
    work: 0.3,
    lines: excerpt(
      'the replay after the fix',
      await inTerminal(forkArgs),
      [/^Escalated: the refund of \$240 /, /^⑂ Forked at call \d+: /, /^ {2}~ \$\.system$/, /^ {6}- "/, /^ {6}\+ "/, /^✓ \d+ checks? passed/, /^ {2}✓ issue_refund with \{"amount":240\} called 0 times$/],
      [/^\[shadowlap\] replaying run /, /^ {2}\d+ recorded calls? left unused after the fork: /, /^✗ Diverged at call \d+ /, /^ {2}compared with run \w+…, call \d+$/, SHOW],
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

// Pacing, in seconds: the prompt waiting, typing, the command working, its lines arriving (all at
// once, as a block), a moment before the next command, and the whole session held at the end. It is
// typed fast, so all of it is on screen within six seconds of the picture loading and stays there for
// twenty-two before the loop starts again: a reader who scrolls to it late still sees the whole
// session. The first command is typed already, so the picture is never empty: a page that shows its
// first frame, or a capture of one, shows a command at work.
const P = { idle: 0.15, perChar: 0.01, enter: 0.1, perLine: 0, readBase: 0.25, readPerLine: 0.03, end: 22, fade: 0.4 };

/** When each command shows, is typed and prints, and when each of its lines arrives. */
const timeline = [];
let t = 0;
/** What a scene types at the prompt: a shadowlap command, or a comment line. */
const typed = (scene) => scene.text ?? `shadowlap ${scene.args.map(quote).join(' ')}`;
for (const [i, scene] of scenes.entries()) {
  const text = typed(scene);
  const typeAt = i ? t + P.idle : t;
  const typedAt = i ? typeAt + text.length * P.perChar : t;
  const outAt = typedAt + P.enter + scene.work;
  const lines = [];
  let at = outAt;
  for (const line of scene.lines) {
    lines.push({ line, at });
    if (line.length) at += P.perLine;
  }
  timeline.push({ text, showAt: t, typeAt, typedAt, outAt, lines });
  t = at + P.readBase + P.readPerLine * scene.lines.filter((l) => l.length).length;
}
// The next prompt waits under the last command until the loop starts again.
const last = t - P.readBase;
const TOTAL = t + P.end + P.fade;
const pct = (s) => `${Math.min(100, (s / TOTAL) * 100).toFixed(3)}%`;
const fadeAt = pct(TOTAL - P.fade);

/**
 * A line of runs broken into rows of at most `width` columns, as a narrow terminal would show it, the
 * rows after the first indented two past the line's own indent. A row ends, by preference, where a
 * clause does (a comma, semicolon or colon and the space after it) outside brackets and quotes, then
 * at a space outside them, each only when that leaves the row at least half full; then at a comma
 * between JSON values, then at any space. Rows are kept shorter when that spares the last one from
 * holding a word or two alone. Nothing is left out or changed: the rows hold the line's characters in
 * order, in their own colours.
 */
function wrapRuns(runs, width) {
  const chars = runs.flatMap((r) => [...r.text].map((ch) => ({ ch, fg: r.fg, bold: r.bold, dim: r.dim })));
  if (chars.length <= width) return [runs];
  const indent = chars.findIndex((c) => c.ch !== ' ') + 2;
  // How deep in brackets or a quoted string each character is.
  const depth = [];
  let level = 0;
  let quoted = false;
  for (const [i, { ch }] of chars.entries()) {
    if (ch === '"' && chars[i - 1]?.ch !== '\\') quoted = !quoted;
    else if (!quoted && '([{'.includes(ch)) level++;
    else if (!quoted && ')]}'.includes(ch)) level = Math.max(0, level - 1);
    depth.push(level + (quoted ? 1 : 0));
  }
  /** Where each row starts and ends, none but the last longer than `limit`. */
  const spans = (limit) => {
    const out = [];
    let start = 0;
    while (start < chars.length) {
      const lead = out.length ? indent : 0;
      let end = chars.length;
      if (end - start > width - lead) {
        const room = Math.min(width, limit) - lead;
        // The last break of each kind within the row's room.
        const last = { clause: -1, space: -1, json: -1, any: -1 };
        for (let e = start + 1; e <= start + room && e < chars.length; e++) {
          const prev = chars[e - 1].ch;
          if (chars[e].ch === ' ') {
            last.any = e;
            if (!depth[e]) {
              last.space = e;
              if (',;:'.includes(prev)) last.clause = e;
            }
          } else if (prev === ',' && chars[e].ch === '"') last.json = e;
        }
        const full = (e) => e - start >= room / 2;
        end = [last.clause, last.space].find(full) ?? [last.json, last.any].find((e) => e > start) ?? start + room;
      }
      out.push({ start, end, lead });
      start = end;
      while (start < chars.length && chars[start].ch === ' ') start++;
    }
    return out;
  };
  const tail = (rows) => rows.at(-1).end - rows.at(-1).start;
  let rows = spans(width);
  for (let limit = width - 1; rows.length > 1 && tail(rows) < 16 && limit >= Math.ceil(width * 0.7); limit--) {
    const tried = spans(limit);
    if (tried.length === rows.length && tail(tried) > tail(rows)) rows = tried;
  }
  return rows.map(({ start, end, lead }) => {
    const row = lead ? [{ text: ' '.repeat(lead), fg: null, bold: false, dim: false }] : [];
    for (const c of chars.slice(start, end)) {
      const prev = row.at(-1);
      if (prev && prev.fg === c.fg && prev.bold === c.bold && prev.dim === c.dim) prev.text += c.ch;
      else row.push({ text: c.ch, fg: c.fg, bold: c.bold, dim: c.dim });
    }
    return row;
  });
}

/**
 * A command as a shell shows it typed across lines: broken before a flag (else at a space) where it
 * would pass `columns`, each row but the last ending in a backslash, the rows after the first behind
 * the > prompt and indented two. A comment line stays whole.
 */
function commandRows(text, columns) {
  if (text.startsWith('#')) return [text];
  const rows = [];
  let rest = text;
  let lead = '';
  while (2 + lead.length + rest.length > columns) {
    const window = rest.slice(0, columns - 2 - lead.length - 2 + 1);
    let cut = window.lastIndexOf(' --');
    if (cut <= 0) cut = window.lastIndexOf(' ');
    if (cut <= 0) break;
    rows.push(`${lead}${rest.slice(0, cut)} \\`);
    rest = rest.slice(cut + 1);
    lead = '  ';
  }
  rows.push(`${lead}${rest}`);
  return rows;
}

/** The session as rows of at most `columns` columns, and the picture's size. */
function layout(columns) {
  const rows = [];
  for (const [i, cmd] of timeline.entries()) {
    if (i) rows.push({ kind: 'blank' });
    // A command on several rows is typed a row at a time, in the time the whole of it takes.
    const parts = commandRows(cmd.text, columns);
    const perChar = (cmd.typedAt - cmd.typeAt) / parts.reduce((n, part) => n + part.length, 0);
    let at = cmd.typeAt;
    for (const [j, part] of parts.entries()) {
      const end = j === parts.length - 1;
      const typedAt = end ? cmd.typedAt : at + part.length * perChar;
      rows.push({ kind: 'cmd', text: part, prompt: j ? '>' : '$', showAt: j ? at : cmd.showAt, typeAt: at, typedAt, outAt: end ? cmd.outAt : typedAt });
      at = typedAt;
    }
    for (const { line, at } of cmd.lines) {
      if (!line.length) rows.push({ kind: 'blank' });
      else for (const runs of wrapRuns(line, columns)) rows.push({ kind: 'out', runs, at });
    }
  }
  rows.push({ kind: 'blank' });
  rows.push({ kind: 'cmd', text: '', showAt: last, typeAt: last, typedAt: last, outAt: Infinity });
  const width = (r) => (r.kind === 'cmd' ? 2 + r.text.length + 1 : r.kind === 'out' ? plain(r.runs).length : 0);
  const cols = Math.max(...rows.map(width)) + 1;
  return { rows, cols, W: Math.round(PX * 2 + cols * CW), H: Math.round(PY * 2 + rows.length * LH) };
}

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

function render({ rows, W, H }, animated) {
  const css = [];
  const body = [];
  let n = 0;
  const keyframes = (frames) => {
    const k = `k${n++}`;
    css.push(`.${k}{animation:${k} ${TOTAL.toFixed(2)}s infinite}@keyframes ${k}{${frames}}`);
    return k;
  };
  // Rows that arrive together share one animation.
  const appearing = new Map();
  const appear = (at) => {
    if (!appearing.has(at)) appearing.set(at, `a ${keyframes(`0%{opacity:0;animation-timing-function:step-end}${pct(at)}{opacity:1;animation-timing-function:step-end}${fadeAt}{opacity:1;animation-timing-function:linear}100%{opacity:0}`)}`);
    return appearing.get(at);
  };
  rows.forEach((r, i) => {
    const top = PY + i * LH;
    const y = (top + 14.5).toFixed(1);
    if (r.kind === 'out') body.push(`<text y="${y}"${animated ? ` class="${appear(r.at)}"` : ''}>${spans(r.runs, 0)}</text>`);
    if (r.kind !== 'cmd') return;
    body.push(`<text y="${y}"${animated ? ` class="${appear(r.showAt)}"` : ''}><tspan x="${PX}" fill="${C.prompt}">${esc(r.prompt ?? '$')}</tspan>${spans([{ text: r.text, fg: null, bold: false, dim: false }], 2)}</text>`);
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
  const transcript = scenes.map((s) => [`$ ${typed(s)}`, ...s.lines.map(plain)].join('\n')).join('\n\n');
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

// The README's column on a wide screen; 80 columns for a tablet or a narrow window, where GitHub's
// column is narrower and the README picks the medium picture; and 47 for a phone.
const wide = layout(Infinity);
const medium = layout(80);
const narrow = layout(47);
mkdirSync(outDir, { recursive: true });
const files = [
  ['terminal.svg', render(wide, true)],
  ['terminal-static.svg', render(wide, false)],
  ['terminal-medium.svg', render(medium, true)],
  ['terminal-medium-static.svg', render(medium, false)],
  ['terminal-narrow.svg', render(narrow, true)],
  ['terminal-narrow-static.svg', render(narrow, false)],
];
for (const [name, svg] of files) writeFileSync(join(outDir, name), svg);
const shown = timeline.at(-1).lines.at(-1).at;
console.log(`wrote ${files.map(([name, svg]) => `${relative(root, join(outDir, name))} (${(Buffer.byteLength(svg) / 1024).toFixed(0)} KB)`).join(', ')}: ${scenes.length} commands, ${wide.rows.length} rows of ${wide.cols} columns (medium: ${medium.rows.length} of ${medium.cols}, narrow: ${narrow.rows.length} of ${narrow.cols}), a ${TOTAL.toFixed(1)} s loop, the whole session shown from ${shown.toFixed(1)} s to ${(TOTAL - P.fade).toFixed(1)} s`);
