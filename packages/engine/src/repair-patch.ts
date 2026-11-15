import { dataStrings, yamlPlainProblem, type DataString } from './data-strings.js';
import { checkEdit, findAnchors, longestRewrite, placeholders, REPAIR_FILE_LIMIT, templateSyntax, type Anchor, type Placeholder, type RepairReport, type SourceFile, type Surface } from './repair.js';
import { sourceStrings, type SourceString } from './source-strings.js';
import { safeLine } from './text.js';

/**
 * What a repair's patch may change. `shadowlap fix apply` hands a patch to `git apply`, and the store
 * it comes from can be someone else's (a teammate's bucket, a copied file), so a patch is held to the
 * one rewrite its accepted candidate makes (`repairPatchProblem`). A patch a pull brought is held to
 * the rewrites repair itself makes, in the working tree it goes into (`rewriteHere`): text inside a
 * string of JavaScript, TypeScript or Python source, inside a string value of YAML, JSON or TOML, or
 * of a prose file, but never in a file or a value that runs (a CI pipeline, a script, package.json's
 * scripts), where repair places its anchors too (`repairNeverRewritesAt`), and a rewrite of it that
 * `checkEdit` would let repair try. A teammate's machine or the bucket can be someone else's, so a
 * fix from there can do no more than one repair made here could.
 */

/**
 * Every file a patch names, as `git apply` reads its headers: both sides of `diff --git`, the `---`
 * and `+++` lines, renames and copies; `/dev/null` (a file made or deleted) is left out. A hunk's
 * lines are skipped by its counts, so a removed line that starts with `--` is not taken for a header.
 */
export function patchFiles(patch: string): string[] {
  const files = new Set<string>();
  const add = (name: string, prefix: boolean) => {
    const n = name.replace(/\t.*$/, '').trim();
    if (n && n !== '/dev/null') files.add(prefix ? n.replace(/^[ab]\//, '') : n);
  };
  const lines = patch.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(l);
    if (hunk) {
      let old = hunk[1] === undefined ? 1 : Number(hunk[1]);
      let now = hunk[2] === undefined ? 1 : Number(hunk[2]);
      while ((old > 0 || now > 0) && i + 1 < lines.length) {
        const h = lines[++i]!;
        if (h.startsWith('\\')) continue;
        if (!h.startsWith('+')) old--;
        if (!h.startsWith('-')) now--;
      }
      continue;
    }
    const git = /^diff --git (.+)$/.exec(l);
    if (git) {
      // `a/<name> b/<name>`: the same name on both sides, spaces and all, unless it was renamed.
      const both = git[1]!;
      const n = (both.length - 5) / 2;
      if (Number.isInteger(n) && both.startsWith('a/') && both.slice(2 + n, 5 + n) === ' b/' && both.slice(2, 2 + n) === both.slice(5 + n)) add(both.slice(2, 2 + n), false);
      else for (const side of both.split(/ (?=b\/)/)) add(side, true);
      continue;
    }
    const named = /^(?:---|\+\+\+) (.+)$/.exec(l);
    if (named) add(named[1]!, true);
    const moved = /^(?:rename|copy) (?:from|to) (.+)$/.exec(l);
    if (moved) add(moved[1]!, false);
  }
  return [...files];
}

/** A path `git apply` reads as written: relative, inside the repository, outside `.git`, with nothing it would unquote or trim. */
function plainRepoPath(file: string): boolean {
  return (
    file.length > 0 &&
    file === file.trim() &&
    !/[\u0000-\u001f\u007f-\u009f"\\]/.test(file) &&
    !file.startsWith('/') &&
    !/^[a-z]:/i.test(file) &&
    file.split('/').every((s) => s !== '' && s !== '.' && s !== '..' && s.toLowerCase() !== '.git')
  );
}

const fileList = (files: string[]) => (files.length > 1 ? `${files.slice(0, -1).join(', ')} and ${files.at(-1)!}` : (files[0] ?? 'nothing'));

/**
 * What `file` (a path relative to the repository, with forward slashes) is when a repair never
 * rewrites it, whatever a report says, or null. A repair rewrites the text the agent sends the model where the
 * agent's source holds it. A recording holds a copy of that text, and a pack's run.json holds the
 * command its replay runs, which `shadowlap test` runs without asking for a pack the repository
 * tracks: so no file of a recording (a pack's run.json, calls.jsonl and blobs, or anything in
 * `__recordings__`) is ever rewritten, nor shadowlap's config, which says what runs and where runs
 * go, nor anything in its own folder or in git's, whose config can hold a credential. Each name is
 * read as Windows reads it too: in any case, without the dots and spaces it drops from the end, and
 * never as a stream of a file (`run.json::$DATA`) or a short name (`RUN~1.JSO`), either of which
 * names another file there.
 */
export function repairNeverRewrites(file: string): string | null {
  const parts = file.split('/');
  if (parts.some((p) => p.includes(':'))) return 'a stream of a file, which Windows writes as the file itself';
  if (parts.some((p) => /~\d/.test(p))) return 'a name with a ~ and a digit, which Windows can read as the short name of another file';
  const names = parts.map((p) => p.replace(/[. ]+$/, '').toLowerCase());
  const name = names.at(-1) ?? '';
  if (names.includes('.git')) return "a file in git's own folder, where the repository and its config are, which can hold a credential";
  if (names.includes('.shadowlap')) return "a file in shadowlap's own folder, where its store and repairs are";
  if (names.includes('__recordings__')) return 'a file in a folder of recordings';
  if (name === 'shadowlap.config.json') return "shadowlap's config, which says what runs and where runs go";
  if (name === 'run.json') return "a pack's run.json, which holds the command a replay of the recording runs";
  if (name === 'calls.jsonl' || (names.at(-2) === 'blobs' && /^[0-9a-f]{64}$/.test(name))) return "a recording's file";
  return null;
}

/**
 * Why a repair's patch is not the change its accepted candidate makes, or null when it is (or when
 * there is no patch). `shadowlap fix apply` hands the patch to `git apply`, and a store can come from
 * elsewhere (a teammate's bucket, a copied file), so it is held to what `unifiedDiff` writes for that
 * one rewrite and nothing more: the candidate's file alone, changed in place (no file made, deleted,
 * renamed or copied, no mode or binary change), in one hunk whose removed side turns into its added
 * side by the candidate's rewrite of its text, once, and by nothing else.
 */
export function repairPatchProblem(report: Pick<RepairReport, 'patch' | 'candidates' | 'accepted'>): string | null {
  const patch = report.patch;
  if (patch === null) return null;
  const c = report.candidates.find((x) => x.id === report.accepted);
  if (!c) return 'no accepted candidate comes with it';
  const file = c.file;
  if (!plainRepoPath(file)) return `its accepted candidate names "${safeLine(file)}", which is not a plain path inside the repository`;
  const never = repairNeverRewrites(file);
  if (never) return `its accepted candidate rewrites ${safeLine(file)}, ${never}: a repair rewrites only the text the agent sends the model, where the agent's source holds it`;
  const runs = fileThatRuns(file);
  if (runs) return `its accepted candidate rewrites ${safeLine(file)}, ${runs}: a repair never rewrites a file that runs`;
  if (!rewriteKind(file)) return `its accepted candidate rewrites ${safeLine(file)}, ${kindWords(file)}: a repair rewrites text only in ${REWRITTEN_TEXT}`;
  // Nothing larger than a repair makes is read any further: the text a candidate rewrites is in a
  // file repair read, and its rewrite is held to longestRewrite. The patch holds the lines around
  // the rewrite before and after it, a mark in front of each, which at most doubles them (empty lines).
  if (c.before.length > REPAIR_FILE_LIMIT) return `its accepted candidate's text is ${c.before.length} characters, longer than any file a repair reads`;
  if (c.after.length > longestRewrite(c.before.length)) return `its accepted candidate's rewrite is ${c.after.length} characters, longer than a repair keeps for the ${c.before.length} it replaces`;
  if (patch.length > 2 * (2 * REPAIR_FILE_LIMIT + c.after.length) + 4 * file.length + 256) return `it is ${patch.length} characters, more than a repair writes for its accepted candidate`;
  const files = patchFiles(patch);
  if (files.some((f) => f !== file)) return `it changes ${fileList(files.map(safeLine))}, where its accepted candidate changes ${file} alone`;
  if (!c.before) return 'its accepted candidate rewrites no text';
  if (c.before === c.after) return 'its accepted candidate changes nothing';
  const hunk = hunkOf(patch, file);
  if (typeof hunk === 'string') return hunk;
  // The hunk holds three lines of context around the lines that differ, so a long text whose last
  // line alone was rewritten is not all in it: what has to be in it is the part of the rewrite that
  // differs, with what the text and its rewrite share at either end left out.
  let p = 0;
  while (p < c.before.length && p < c.after.length && c.before[p] === c.after[p]) p++;
  let s = 0;
  while (s < c.before.length - p && s < c.after.length - p && c.before[c.before.length - 1 - s] === c.after[c.after.length - 1 - s]) s++;
  const from = c.before.slice(p, c.before.length - s);
  const to = c.after.slice(p, c.after.length - s);
  return rewrites(hunk.was, hunk.is, from, to) ? null : `the lines it changes in ${file} are not its accepted candidate's rewrite`;
}

/**
 * The lines the one hunk of a patch to `file` takes away (`was`) and puts in their place (`is`),
 * context and all, as `unifiedDiff` writes it; or why the patch is not that. A line's break is in its
 * text but where the hunk says there is no newline at the end of the file.
 */
function hunkOf(patch: string, file: string): { was: string; is: string } | string {
  const lines = patch.split('\n');
  if (lines.pop() !== '') return 'it does not end with a line break';
  const head = [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`];
  if (head.some((h, i) => lines[i] !== h)) return `its header is not the one a repair writes for ${file}: a repair never makes, deletes, renames or copies a file, nor changes its mode`;
  const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@$/.exec(lines[3] ?? '');
  if (!hunk) return 'it holds no hunk a repair writes';
  let old = hunk[1] === undefined ? 1 : Number(hunk[1]);
  let now = hunk[2] === undefined ? 1 : Number(hunk[2]);
  const sides: Record<'-' | '+', Array<{ text: string; eol: boolean }>> = { '-': [], '+': [] };
  let last: ' ' | '-' | '+' | null = null;
  let i = 4;
  for (; i < lines.length; i++) {
    const l = lines[i]!;
    if (l === '\\ No newline at end of file' && last) {
      for (const side of last === ' ' ? (['-', '+'] as const) : [last]) sides[side].at(-1)!.eol = false;
      last = null;
      continue;
    }
    if (old <= 0 && now <= 0) break;
    const kind = l[0];
    if (kind !== ' ' && kind !== '-' && kind !== '+') return 'a line in its hunk is neither context, removed nor added';
    if (kind !== '+') {
      sides['-'].push({ text: l.slice(1), eol: true });
      old--;
    }
    if (kind !== '-') {
      sides['+'].push({ text: l.slice(1), eol: true });
      now--;
    }
    last = kind;
  }
  if (old !== 0 || now !== 0) return 'its hunk holds a different number of lines than its header says';
  if (i < lines.length) return 'it holds more than the one hunk a repair writes';
  const text = (side: '-' | '+') => sides[side].map((x) => x.text + (x.eol ? '\n' : '')).join('');
  return { was: text('-'), is: text('+') };
}

/**
 * Whether `is` is `was` with `from` replaced by `to` at one place, found in time that grows with the
 * texts' length alone: they come from a store someone else may write, and trying every place `from`
 * appears in turn, comparing the whole text each time, grew with the square of the patch (43 seconds
 * for a crafted megabyte). Before that place the texts agree, so it is at most where they first
 * differ; after it they agree too, which bounds it from below.
 */
function rewrites(was: string, is: string, from: string, to: string): boolean {
  if (is.length - to.length !== was.length - from.length) return false;
  let start = 0;
  while (start < was.length && start < is.length && was.charCodeAt(start) === is.charCodeAt(start)) start++;
  let end = 0;
  while (end < was.length && end < is.length && was.charCodeAt(was.length - 1 - end) === is.charCodeAt(is.length - 1 - end)) end++;
  const lo = Math.max(0, was.length - from.length - end);
  const hi = Math.min(start, was.length - from.length);
  if (lo > hi) return false;
  // What `from` and `to` share at either end was left out, so when neither is empty they differ in
  // their first character, and the place can only be where the texts first differ.
  if (from && to) return lo <= start && start <= hi && was.startsWith(from, start) && is.startsWith(to, start);
  // Text only added, or only taken away: any place between lo and hi where that text is will do.
  return occursBetween(from ? was : is, from || to, lo, hi);
}

/** Whether `piece` (not empty) appears in `text` starting anywhere from `lo` to `hi`, by Knuth-Morris-Pratt: one pass, however the text repeats. */
function occursBetween(text: string, piece: string, lo: number, hi: number): boolean {
  const back = new Int32Array(piece.length);
  for (let i = 1, k = 0; i < piece.length; i++) {
    while (k > 0 && piece.charCodeAt(i) !== piece.charCodeAt(k)) k = back[k - 1]!;
    if (piece.charCodeAt(i) === piece.charCodeAt(k)) k++;
    back[i] = k;
  }
  const stop = Math.min(text.length, hi + piece.length);
  for (let i = lo, k = 0; i < stop; i++) {
    while (k > 0 && text.charCodeAt(i) !== piece.charCodeAt(k)) k = back[k - 1]!;
    if (text.charCodeAt(i) === piece.charCodeAt(k)) k++;
    if (k === piece.length) return true;
  }
  return false;
}

// ---- Where a repair rewrites text ----------------------------------------------------------------

/** Where a repair rewrites text, as a reason that refuses a rewrite elsewhere says it. */
const REWRITTEN_TEXT = 'a string of JavaScript, TypeScript or Python source, a string value of YAML, JSON or TOML, or a Markdown, plain text, prompt or Jinja file';

/**
 * What a repair rewrites in a file: the text inside its strings (`js`, `python`), inside its string
 * values (`yaml`, `json`, `toml`), or any of its text (`prose`).
 */
export type RewriteKind = 'js' | 'python' | 'yaml' | 'json' | 'toml' | 'prose';

/**
 * What a repair rewrites in `file`, by its name, or null for a file it rewrites nothing in. The text
 * an agent sends its model is in a string of its code, a string value of its config (CrewAI keeps
 * its prompts in YAML, and a model's name can be in JSON or TOML), or a prose or template file it
 * reads. In another language's source shadowlap can't tell a string from code, so a repair rewrites
 * none of it. MDX is left out too: it is JSX, whose code runs when it is built.
 */
export function rewriteKind(file: string): RewriteKind | null {
  const syntax = templateSyntax(file);
  if (syntax === 'js' || syntax === 'python') return syntax;
  const data = /\.(ya?ml|json|toml)$/i.exec(file)?.[1]!.toLowerCase();
  if (data) return data === 'yml' ? 'yaml' : (data as RewriteKind);
  return /\.(?:md|markdown|txt|rst|prompt|j2|jinja2?)$/i.test(file) ? 'prose' : null;
}

/** A file's kind as a reason names it: `a .go file`, or `a file with no extension`. */
function kindWords(file: string): string {
  const name = file.slice(file.lastIndexOf('/') + 1);
  const ext = /\.([^.]+)$/.exec(name.slice(1))?.[1];
  return ext ? `a .${safeLine(ext).slice(0, 20)} file` : 'a file with no extension';
}

/** A path's names as Windows reads them too: in lower case, without the dots and spaces it drops from a name's end. */
const namesOf = (file: string) => file.split('/').map((p) => p.replace(/[. ]+$/, '').toLowerCase());

/**
 * Why a repair rewrites nothing in a dot-file or a dot-folder: tools keep their own config there, and
 * much of it runs. CI pipelines (`.github/`, `.gitlab-ci.yml`, `.circleci/`, `.buildkite/`,
 * `.travis.yml`) run their steps, Claude Code runs the hooks in `.claude/settings.json`, an MCP
 * client the command `.mcp.json` names, git the hooks `.pre-commit-config.yaml` installs, and editors
 * the tasks in `.vscode/` and `.devcontainer/`. One rule holds for all of them, and for those to come,
 * but for the prompts of a Claude Code subagent, skill or command (`claudePrompt`).
 */
const DOT = 'a dot-file or a file in a dot-folder, where tools keep config that runs: CI pipelines, Claude Code hooks, MCP servers, pre-commit hooks';

/**
 * The other files that run what they hold, whatever their format, each with why. A rewrite of any of
 * their text could change what runs, so a repair rewrites none of it, and a pull leaves out a fix
 * whose patch does.
 */
const RUNNER_FILES: ReadonlyArray<{ is: (name: string, names: readonly string[]) => boolean; what: string }> = [
  { is: (f) => f === 'action.yml' || f === 'action.yaml', what: 'a GitHub Action, which runs what it says where a workflow uses it' },
  { is: (f) => /^azure-pipelines.*\.ya?ml$/.test(f), what: 'an Azure Pipelines pipeline, whose scripts run commands' },
  { is: (f) => f === 'bitbucket-pipelines.yml', what: "Bitbucket Pipelines' pipeline, whose scripts run commands" },
  { is: (f) => f === 'jenkinsfile' || f.endsWith('.jenkinsfile'), what: 'a Jenkins pipeline, which is Groovy code' },
  { is: (f) => f === 'taskfile.yml' || f === 'taskfile.yaml', what: 'a Taskfile, whose tasks run commands' },
  { is: (f) => f === 'dockerfile' || f === 'containerfile' || f.startsWith('dockerfile.') || f.endsWith('.dockerfile'), what: 'a Dockerfile, whose instructions run as its image is built' },
  { is: (f) => f === 'makefile' || f === 'gnumakefile' || f.endsWith('.mk'), what: 'a Makefile, whose recipes run commands' },
  { is: (f) => f.endsWith('.sh'), what: 'a shell script' },
  { is: (f) => f.endsWith('.ps1'), what: 'a PowerShell script' },
  { is: (f, n) => /^(?:requirements|constraints).*\.txt$/.test(f) || (f.endsWith('.txt') && n.at(-2) === 'requirements'), what: "pip's requirements, whose packages run code as they install" },
];

/** What `file` is when it runs what it holds: in a dot-file or a dot-folder (DOT) but a Claude Code prompt, or one of RUNNER_FILES; else null. */
export function fileThatRuns(file: string): string | null {
  const names = namesOf(file);
  if (file.split('/').some((p) => p.startsWith('.')) && !claudePrompt(file)) return DOT;
  return RUNNER_FILES.find((r) => r.is(names.at(-1) ?? '', names))?.what ?? null;
}

/** The folders of `.claude/` whose Markdown the Claude Agent SDK reads as prompts: subagents, skills and slash commands. */
const CLAUDE_PROMPTS = new Set(['agents', 'skills', 'commands']);

/**
 * Whether `file` is a Claude Code subagent, skill or slash command: Markdown (`.md`) somewhere in
 * `.claude/agents/`, `.claude/skills/` or `.claude/commands/`, and in no other dot-folder. The Claude
 * Agent SDK reads them from the project and sends their bodies to the model, so a repair rewrites
 * there, in the body alone (`inProse`). Every other file in `.claude/` stays a dot-file's: a skill's
 * scripts, `.claude/settings.json`.
 */
function claudePrompt(file: string): boolean {
  const parts = file.split('/');
  const dot = parts.findIndex((p) => p.startsWith('.'));
  const names = namesOf(file);
  return dot >= 0 && names[dot] === '.claude' && CLAUDE_PROMPTS.has(names[dot + 1] ?? '') && dot + 2 < parts.length && !parts.slice(dot + 1).some((p) => p.startsWith('.')) && /\.md$/i.test(file);
}

const CLAUDE_FILE = 'a Claude Code subagent, skill or command';
const CLAUDE_FRONTMATTER = "a Claude Code subagent's, skill's or command's frontmatter, whose tools, model and hooks say what it runs";
const CLAUDE_RUN = 'a shell command Claude Code runs as it reads the file (!`…`)';

/**
 * Where the body of a Claude Code subagent, skill or command starts in `text`, past its YAML
 * frontmatter; 0 for one with none. The frontmatter opens with `---` at the start (white space
 * before it aside) and closes with the next line that is `---` alone, its line break included. It is
 * read as widely as any reader of it: one that never closes holds the whole file.
 */
function claudeBody(text: string): number {
  const open = /^\s*---/.exec(text);
  if (!open) return 0;
  const line = text.indexOf('\n', open[0].length);
  const close = line < 0 ? null : /^---\r?$/m.exec(text.slice(line + 1));
  if (!close) return text.length;
  const end = line + 1 + close.index + close[0].length;
  return text[end] === '\n' ? end + 1 : end;
}

/**
 * The shell commands Claude Code runs as it reads a skill or command, sending what they print in
 * their place: each `` !`…` ``, and each fenced block opened with `!` (```` ```! ````). Each is read
 * as widely as any reader of it, to the furthest place it could end, and from the character before
 * it to the one after, so that no rewrite beside one changes it either.
 */
function claudeRuns(text: string): Holes {
  const runs: Array<{ start: number; end: number }> = [];
  const upTo = (from: number, mark: string) => {
    const at = text.indexOf(mark, from);
    return at < 0 ? text.length : at + mark.length;
  };
  for (const m of text.matchAll(/!(`+)/g)) {
    const from = m.index + m[0].length;
    runs.push({ start: m.index - 1, end: Math.max(upTo(from, '`'), upTo(from, m[1]!)) + 1 });
  }
  for (const m of text.matchAll(/^[ \t]*(`{3,}|~{3,})[ \t]*!/gm)) {
    const close = new RegExp(`^[ \\t]*${m[1]!.charAt(0)}{${m[1]!.length},}[ \\t]*\\r?$`, 'gm');
    close.lastIndex = upTo(m.index, '\n');
    const end = close.exec(text);
    runs.push({ start: m.index - 1, end: end ? end.index + end[0].length + 1 : text.length });
  }
  return runs.map((r) => ({ start: Math.max(0, r.start), end: Math.min(text.length, r.end) }));
}

/** A compose file: `compose.yaml`, `docker-compose.yml`, and their overrides (`docker-compose.prod.yml`). */
const COMPOSE = /^(?:docker-)?compose(?:\.[^/]+)?\.ya?ml$/;
/** package.json's keys that name packages to install, whose install scripts run. */
const NPM_PACKAGES = new Set(['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies', 'bundleDependencies', 'overrides', 'resolutions']);
/** The keys under which a Kubernetes container runs a command. */
const KUBE_RUNS = new Set(['command', 'args', 'exec', 'lifecycle']);
const under = (p: readonly string[], ...keys: string[]) => keys.every((k, i) => p[i] === k);

/**
 * The values that run, in files whose other string values a repair may rewrite, by the file and the
 * key path, each with why. npm runs package.json's scripts, and the packages its dependencies name
 * run their own as they install, as a Python package's dependencies run code as they build. A Python
 * package's scripts become commands, its entry points name code other programs load, and its build
 * system says what runs to build it. A compose file's command, entrypoint and health check run in
 * its container, and so can an anchored value, through an alias; a Kubernetes manifest's command,
 * args, exec and lifecycle in its containers, while its other values (a ConfigMap's data, where
 * prompts live in production) are text.
 */
const RUNNING_VALUES: ReadonlyArray<{ file: (name: string) => boolean; runs: (path: readonly string[], value: DataString) => boolean; what: string }> = [
  { file: (f) => f === 'package.json', runs: (p) => p[0] === 'scripts', what: "package.json's scripts, which npm runs" },
  { file: (f) => f === 'package.json', runs: (p) => NPM_PACKAGES.has(p[0] ?? ''), what: "package.json's dependencies, whose packages run code as they install" },
  { file: (f) => f === 'pyproject.toml', runs: (p) => under(p, 'project', 'scripts') || under(p, 'project', 'gui-scripts'), what: "pyproject.toml's scripts, each a command installing the package makes" },
  { file: (f) => f === 'pyproject.toml', runs: (p) => under(p, 'project', 'entry-points'), what: "pyproject.toml's entry points, which name code other programs load" },
  { file: (f) => f === 'pyproject.toml', runs: (p) => under(p, 'tool', 'poetry', 'scripts'), what: "Poetry's scripts in pyproject.toml, each a command installing the package makes" },
  { file: (f) => f === 'pyproject.toml', runs: (p) => under(p, 'project', 'dependencies') || under(p, 'project', 'optional-dependencies') || under(p, 'dependency-groups'), what: "pyproject.toml's dependencies, whose packages run code as they install" },
  { file: (f) => f === 'pyproject.toml', runs: (p) => under(p, 'tool', 'poetry', 'dependencies') || under(p, 'tool', 'poetry', 'dev-dependencies') || (under(p, 'tool', 'poetry', 'group') && p[4] === 'dependencies'), what: "Poetry's dependencies in pyproject.toml, whose packages run code as they install" },
  { file: (f) => f === 'pyproject.toml', runs: (p) => p[0] === 'build-system', what: "pyproject.toml's build-system, which says what runs to build the package" },
  { file: (f) => COMPOSE.test(f), runs: (p, v) => p.includes('command') || p.includes('entrypoint') || p.some((k, i) => k === 'healthcheck' && p[i + 1] === 'test') || v.anchored === true, what: "a compose file's command, entrypoint or health check, which run in its container, or an anchored value an alias can make one" },
  { file: (f) => /\.ya?ml$/.test(f), runs: (p, v) => v.kube === true && p.some((k) => KUBE_RUNS.has(k)), what: "a Kubernetes manifest's command, args, exec or lifecycle, which run in its containers" },
];

/** Each file read once however many spans of it are checked: its strings in code, its string values in YAML, JSON or TOML, its placeholders in prose. */
const stringsOf = new WeakMap<SourceFile, SourceString[]>();
const valuesOf = new WeakMap<SourceFile, DataString[]>();
const placeholdersOf = new WeakMap<SourceFile, Placeholder[]>();
const claudeOf = new WeakMap<SourceFile, { body: number; runs: Holes }>();

type Holes = ReadonlyArray<{ start: number; end: number }>;

/** The placeholders in a prose file. */
function proseHoles(file: SourceFile): Holes {
  let found = placeholdersOf.get(file);
  if (!found) placeholdersOf.set(file, (found = placeholders(file.content, templateSyntax(file.path))));
  return found;
}

/**
 * The placeholders in a prose file, or why a repair never rewrites the text from `offset` to `end`
 * of a Claude Code subagent, skill or command (`claudePrompt`): in its frontmatter, or in or beside
 * a shell command it runs. With `replace`, the rewrite may change neither: the file's frontmatter
 * stays as it is, and so do its commands, none added.
 */
function inProse(file: SourceFile, at: { offset: number; end: number; replace: string | undefined }): Holes | string {
  if (!claudePrompt(file.path)) return proseHoles(file);
  let read = claudeOf.get(file);
  if (!read) claudeOf.set(file, (read = { body: claudeBody(file.content), runs: claudeRuns(file.content) }));
  const { offset, end, replace } = at;
  if (offset < read.body) return `is in ${CLAUDE_FRONTMATTER}: a repair never rewrites what runs`;
  if (read.runs.some((r) => r.start < end && offset < r.end)) return `is in ${CLAUDE_RUN}: a repair never rewrites what runs`;
  if (replace !== undefined) {
    const was = file.content;
    const text = was.slice(0, offset) + replace + was.slice(end);
    if (text.slice(0, claudeBody(text)) !== was.slice(0, read.body)) return `is in the body of ${CLAUDE_FILE}, and its rewrite would change the frontmatter, whose tools, model and hooks say what it runs`;
    const commands = (t: string) => claudeRuns(t).map((r) => t.slice(r.start, r.end)).join('\0');
    if (commands(text) !== commands(was)) return `is in the body of ${CLAUDE_FILE}, and its rewrite would add ${CLAUDE_RUN}`;
  }
  return proseHoles(file);
}

/** The places of code in the string of `file` that the text from `offset` to `end` is inside, or why it isn't inside one. */
function inString(file: SourceFile, kind: 'js' | 'python', offset: number, end: number): Holes | string {
  let strings = stringsOf.get(file);
  if (!strings) stringsOf.set(file, (strings = sourceStrings(file.content, kind)));
  // The innermost string it starts in: one in a template literal's ${…} starts after the template literal.
  const str = strings.filter((s) => s.start <= offset && offset < s.end).at(-1);
  if (!str) return 'is outside any string: in code, a repair rewrites only text inside a string';
  if (end > str.end) return 'runs past the end of the string it starts in: a repair rewrites text inside one string';
  const inside = placeholders(file.content.slice(str.start, str.end), kind).map((p) => ({ start: str.start + p.start, end: str.start + p.end }));
  return [...str.code.map(([start, stop]) => ({ start, end: stop })), ...inside];
}

/**
 * The placeholders in the string value of `file` that the text from `offset` to `end` is inside, or
 * why a repair never rewrites it: outside one, past its end (in YAML, over its lines), or a value
 * that runs. With `replace`, a YAML plain value's rewrite may not read as YAML's own syntax.
 */
function inValue(file: SourceFile, kind: 'yaml' | 'json' | 'toml', at: { offset: number; end: number; replace: string | undefined }): Holes | string {
  let values = valuesOf.get(file);
  if (!values) valuesOf.set(file, (values = dataStrings(file.content, kind)));
  const { offset, end, replace } = at;
  const value = values.filter((v) => v.start <= offset && offset < v.end).at(-1);
  if (!value) return 'is outside any string value: in YAML, JSON or TOML, a repair rewrites only text inside one string value';
  if (end > value.end) return kind === 'yaml' && file.content.slice(offset, end).includes('\n') ? "runs over lines of a YAML value: a rewrite there stays on one line, since YAML reads a line's indentation" : 'runs past the end of the string value it starts in: a repair rewrites text inside one string value';
  const name = namesOf(file.path).at(-1) ?? '';
  const runs = RUNNING_VALUES.find((r) => r.file(name) && r.runs(value.path, value));
  if (runs) return `is in ${runs.what}: a repair never rewrites what runs`;
  const was = file.content.slice(value.start, value.end);
  if (replace !== undefined && value.plain) {
    const problem = yamlPlainProblem(was.slice(0, offset - value.start) + replace + was.slice(end - value.start));
    if (problem && problem !== yamlPlainProblem(was)) return `is a plain YAML value its rewrite ${problem}`;
  }
  return placeholders(was, templateSyntax(file.path)).map((p) => ({ start: value.start + p.start, end: value.start + p.end }));
}

/**
 * Why a repair never rewrites the `length` characters at `offset` of `file`, or null when it may.
 * The file may not run what it holds (`fileThatRuns`), and has to be of a kind a repair rewrites text
 * in (`rewriteKind`). In code the text has to be inside one string; in YAML, JSON or TOML inside one
 * string value that doesn't run (`RUNNING_VALUES`), and in YAML on one line of it; in a Claude Code
 * subagent, skill or command, in its body, beside no shell command it runs (`inProse`). In any file it
 * holds a placeholder only whole: a rewrite never starts or ends inside a template literal's `${…}`,
 * an f-string's `{…}` or a Jinja expression, whose code `checkEdit` would otherwise let it change.
 * With `replace`, a YAML plain value's rewrite is held to text too (`yamlPlainProblem`). Read as what
 * follows "the text": `is outside any string`.
 */
export function repairNeverRewritesAt(file: SourceFile, offset: number, length: number, replace?: string): string | null {
  const runs = fileThatRuns(file.path);
  if (runs) return `is in ${runs}: a repair never rewrites what runs`;
  const kind = rewriteKind(file.path);
  if (!kind) return `is in ${kindWords(file.path)}: a repair rewrites text only in ${REWRITTEN_TEXT}`;
  const at = { offset, end: offset + length, replace };
  const end = at.end;
  const code = kind === 'prose' ? inProse(file, at) : kind === 'js' || kind === 'python' ? inString(file, kind, offset, end) : inValue(file, kind, at);
  if (typeof code === 'string') return code;
  const cut = code.find((p) => p.start < end && offset < p.end && (p.start < offset || p.end > end));
  return cut ? `starts or ends inside ${safeLine(file.content.slice(cut.start, cut.end)).slice(0, 80)}: a rewrite keeps each placeholder whole` : null;
}

/**
 * The anchors a repair may rewrite: the spans `findAnchors` finds, but none in a file a repair never
 * rewrites (`repairNeverRewrites`) or at text it never rewrites (`repairNeverRewritesAt`), numbered
 * from 1. A copy of a span in such a place still keeps it from passing for its source's only one.
 */
export function rewritableAnchors(surfaces: readonly Surface[], files: readonly SourceFile[]): Anchor[] {
  const byPath = new Map(files.map((f) => [f.path, f]));
  return findAnchors(surfaces, files)
    .filter((a) => !repairNeverRewrites(a.file) && !repairNeverRewritesAt(byPath.get(a.file)!, a.offset, a.text.length))
    .map((a, i) => ({ ...a, id: i + 1 }));
}

/**
 * Where a repair switches the model `from` to `to`, or why it switches none: its name quoted once in
 * the project's files (`'from'`, `"from"` or `` `from` ``), at text a repair rewrites, and rewritten
 * as `checkEdit` lets a repair rewrite text. A name kept in a string of code, or in a string value of
 * a JSON, TOML or YAML config, is switched where it is.
 */
export function modelSwitch(files: readonly SourceFile[], from: string, to: string): { file: string; offset: number } | { why: string } {
  const name = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const quoted = files.flatMap((f) => [...f.content.matchAll(new RegExp(`(['"\`])${name}\\1`, 'g'))].map((m) => ({ file: f, offset: m.index + 1 })));
  if (quoted.length !== 1) return { why: `the model name ${from} appears ${quoted.length ? `${quoted.length} times` : 'nowhere'} in the source as a string` };
  const { file, offset } = quoted[0]!;
  if (repairNeverRewrites(file.path) ?? repairNeverRewritesAt(file, offset, from.length, to)) return { why: `the model name ${from} is in ${file.path}, where a repair rewrites no text` };
  const anchor: Anchor = { id: 1, surface: 'model', text: from, file: file.path, offset, prev: file.content[offset - 1] ?? '', next: file.content[offset + from.length] ?? '' };
  const check = checkEdit({ anchor: 1, replace: to, strategy: '', why: '' }, [anchor], new Set());
  return check.ok ? { file: file.path, offset } : { why: check.reason };
}

/** Where `lines`, whole lines of text, are in `text`: each place a line of it starts, and at its end when the last has no line break. Two at most. */
function linesAt(text: string, lines: string): number[] {
  const at: number[] = [];
  for (let i = text.indexOf(lines); i >= 0 && at.length < 2; i = text.indexOf(lines, i + 1)) {
    if ((i === 0 || text[i - 1] === '\n') && (lines.endsWith('\n') || i + lines.length === text.length)) at.push(i);
  }
  return at;
}

const lf = (s: string) => s.replace(/\r\n/g, '\n');

/**
 * Where `text` holds `before` such that rewriting it to `after` there makes `result`, or -1. The text
 * the two share at either end bounds it: before the first place they differ, and after where the
 * text they share at the end begins, less the length of `before`. Where `before` and what is around it
 * repeat, the rewrite at more than one place makes the same `result`, and any of them will do; the
 * first few are tried, each in one pass.
 */
function placeOf(text: string, result: string, before: string, after: string): number {
  let first = 0;
  while (first < text.length && text.charCodeAt(first) === result.charCodeAt(first)) first++;
  let same = 0;
  while (same < text.length && same < result.length && text.charCodeAt(text.length - 1 - same) === result.charCodeAt(result.length - 1 - same)) same++;
  let at = text.indexOf(before, Math.max(0, text.length - same - before.length));
  // Up to `first` the two are the same, so a place there only needs `after` and what follows `before`.
  for (let tries = 0; at >= 0 && at <= first && tries < 8; tries++, at = text.indexOf(before, at + 1)) {
    if (text.length - before.length + after.length === result.length && result.startsWith(after, at) && result.endsWith(text.slice(at + before.length))) return at;
  }
  return -1;
}

/**
 * Why the change a repair's patch makes to `content`, its file's text in this working tree, is not a
 * rewrite repair itself would make there: `{ problem }`, with null for one it would make. Null when
 * the patch's lines are not in `content` once: it is in already, or the file changed since.
 *
 * A pull brings a teammate's patch, which their machine or the bucket could have written, so it goes
 * in only as a fix repair could have proposed here: one rewrite of the candidate's text, where
 * `git apply` would put it (the one place the hunk's lines are, line endings aside), that is text a
 * repair rewrites there (`repairNeverRewritesAt`), rewritten as `checkEdit` lets a repair rewrite
 * text. A teammate's file can differ from this one beyond the hunk, so what the text is (in a string,
 * code or a comment) is read here, never taken from the patch.
 */
export function rewriteHere(report: Pick<RepairReport, 'patch' | 'candidates' | 'accepted'>, content: string): { problem: string | null } | null {
  const problem = repairPatchProblem(report);
  if (problem) return { problem };
  const c = report.candidates.find((x) => x.id === report.accepted);
  const hunk = report.patch !== null && c ? hunkOf(report.patch, c.file) : null;
  if (!c || !hunk || typeof hunk === 'string') return null;
  // As `git apply` reads the file where git converts line endings: CRLF as LF, on both sides.
  const text = lf(content);
  const was = lf(hunk.was);
  if (!was) return { problem: `its hunk holds no line of ${c.file}, where a repair's holds the lines its rewrite changes` };
  const at = linesAt(text, was);
  if (!at.length) return null;
  if (at.length > 1) return { problem: `the lines it changes are in ${c.file} more than once here, so where it goes is not one place` };
  const result = text.slice(0, at[0]) + lf(hunk.is) + text.slice(at[0]! + was.length);
  const before = lf(c.before);
  const after = lf(c.after);
  const offset = placeOf(text, result, before, after);
  if (offset < 0) return { problem: `here, the text its accepted candidate rewrites is not where its patch changes ${c.file}` };
  const where = repairNeverRewritesAt({ path: c.file, content: text }, offset, before.length, after);
  if (where) return { problem: `here, the text its accepted candidate rewrites in ${c.file} ${where}` };
  if (after !== after.trim()) return { problem: "its accepted candidate's rewrite starts or ends with white space, which a repair trims" };
  const anchor = { id: 1, surface: c.surface, text: before, file: c.file, offset, prev: text[offset - 1] ?? '', next: text[offset + before.length] ?? '' };
  const check = checkEdit({ anchor: 1, replace: after, strategy: c.strategy, why: c.why }, [anchor], new Set());
  return { problem: check.ok ? null : `its accepted candidate's rewrite is one a repair sets aside: ${check.reason}` };
}
