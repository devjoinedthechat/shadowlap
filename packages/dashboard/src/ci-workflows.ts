import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { Store } from '@shadowlap/engine';
import { ACTION, ALERT_FAILURES, alertsMessage, alertsNeeds, alertsSecret, alertsYaml, FIX_BUDGETS, fixOnFailureNeeds, fixOnFailureNever, fixOnFailureYaml, REPAIRERS, WORKFLOW_FILE } from './ci-yaml.js';
import { fixDetail, fixList } from './fixes.js';

/**
 * The read model behind Settings → CI (`GET /api/ci/workflows`): the two panels' workflow steps,
 * what each needs, and a preview of what lands, for the options the panels are set to. The YAML
 * comes from ci-yaml.ts, as docs/ci.md shows it; nothing here is stored, since the steps go into the
 * repository's own workflow file.
 */

export interface CiWorkflowOptions {
  /** Fix on failure is on: when it is off, the panel dims its settings and a failed check just fails the build. */
  fix: boolean;
  /** Dollars per failing golden: `2.00`. */
  budget: string;
  /** As `repair --repairer` takes it: `claude-code`, `anthropic`, `openai:gpt-5`. */
  repairer: string;
  /** Alerts post only for the main branch. */
  onlyMain: boolean;
  /** The repository secret that holds the Slack webhook URL. */
  secret: string;
}

export const CI_DEFAULTS: CiWorkflowOptions = { fix: false, budget: '2.00', repairer: 'claude-code', onlyMain: true, secret: 'SLACK_WEBHOOK_URL' };

/** A row of an "it needs" or "it never" list, or a failure with its tag: what it is, and the value on the right. */
export interface CiListRow {
  label: string;
  value: string;
}

/** The pull request a fix opens, as GitHub shows it: from the newest verified fix in this store, or an example. */
export interface PullRequestPreview {
  title: string;
  /** Who opens it: the workflow's token. */
  author: string;
  base: string;
  branch: string;
  /** `target 3 of 3 · held-out 2 of 2 · good 5 of 5`. */
  verify: string | null;
  /** `lost at model call #5 · confidence high`. */
  blame: string | null;
  /** The file the fix changes and its lines: `prompts/refund.md +1 −0`. */
  change: string | null;
  /** What it cost of the budget: `≈$0.84 of $2.00`. */
  spent: string;
  /** Where it comes from: a fix verified here, or none yet (then the rows are an example). */
  fixId: string | null;
  example: boolean;
}

export interface CiWorkflowsView {
  /** Where the steps go: `.github/workflows/agent.yml`. */
  file: string;
  action: string;
  fixOnFailure: {
    on: boolean;
    budget: string;
    repairer: string;
    budgets: Array<{ value: string; label: string }>;
    repairers: Array<{ value: string; label: string }>;
    /** What the panel says while it is off. */
    offNote: string;
    yaml: string;
    needs: CiListRow[];
    never: CiListRow[];
    preview: PullRequestPreview;
  };
  alerts: {
    onlyMain: boolean;
    /** The secret's name as GitHub allows it (letters, digits and `_`). */
    secret: string;
    yaml: string;
    needs: CiListRow[];
    /** What counts as a failure, each with its tag. */
    failures: CiListRow[];
    /** The message as Slack shows it. */
    message: { app: string; text: string; link: string; at: number | null };
  };
  /** The goldens the steps replay: the project's, as `recordings` takes them. */
  recordings: string;
  /** `owner/repo` from the project's git remote, or null. */
  repository: string | null;
}

const BOOL: Record<string, boolean> = { on: true, off: false, true: true, false: false, '1': true, '0': false, yes: true, no: false };
const REPAIRER = /^(claude-code|anthropic|openai)(:[A-Za-z0-9._\-/]{1,80})?$/;

/** The panels' options from the query string; anything left out takes its default. */
export function parseCiOptions(q: URLSearchParams): CiWorkflowOptions | { error: string } {
  const out: CiWorkflowOptions = { ...CI_DEFAULTS };
  for (const [key, name] of [['fix', 'fix'], ['onlyMain', 'onlyMain']] as const) {
    const raw = q.get(key);
    if (raw === null || raw === '') continue;
    const v = BOOL[raw.toLowerCase()];
    if (v === undefined) return { error: `${name} is on or off` };
    out[key] = v;
  }
  const budget = q.get('budget');
  if (budget !== null && budget !== '') {
    const n = Number(budget.replace(/^\$/, ''));
    if (!Number.isFinite(n) || n <= 0 || n > 1000) return { error: 'budget is an amount in dollars, such as 2.00' };
    out.budget = n.toFixed(2);
  }
  const repairer = q.get('repairer');
  if (repairer !== null && repairer !== '') {
    if (!REPAIRER.test(repairer)) return { error: 'repairer is claude-code, anthropic or openai, with :<model> after it if you like' };
    out.repairer = repairer;
  }
  const secret = q.get('secret');
  if (secret !== null) out.secret = alertsSecret(secret.slice(0, 100));
  return out;
}

const dollars = (n: number) => `$${n.toFixed(2)}`;
const rows = (list: ReadonlyArray<readonly [string, string]>): CiListRow[] => list.map(([label, value]) => ({ label, value }));

/** The example a panel shows before any fix was verified here: the mock's own. */
function examplePreview(budget: string): PullRequestPreview {
  return {
    title: 'Escalate refunds above the policy limit',
    author: 'github-actions',
    base: 'main',
    branch: 'shadowlap/fix-refund-limit',
    verify: 'target 3 of 3 · held-out 2 of 2 · good 5 of 5',
    blame: 'lost at model call #5 · confidence high',
    change: 'prompts/refund.md +1 −0',
    spent: `≈$0.84 of $${budget}`,
    fixId: null,
    example: true,
  };
}

/**
 * The pull request the newest verified fix in this store would be, opened by CI: its commit title,
 * branch, verify's counts, where blame found the run was lost, the file it changes and what it cost.
 * Null when no fix here has an accepted repair.
 */
export function fixPreview(store: Store, budget: string): PullRequestPreview | null {
  const verified = fixList(store, { status: 'verified' }).fixes.sort((a, b) => (b.verifiedAt ?? 0) - (a.verifiedAt ?? 0));
  for (const row of verified) {
    const fix = fixDetail(store, row.fixId);
    const repair = fix?.repair;
    if (!fix || !repair?.accepted) continue;
    const spent = repair.cost.blame + (repair.cost.repairer ?? 0) + repair.cost.verify;
    const patch = repair.files.find((f) => f.name === 'fix.patch')?.note.replace(/^1 file · /, '') ?? null;
    return {
      title: repair.title,
      author: 'github-actions',
      base: 'main',
      branch: repair.output.branch ?? `shadowlap/fix-${fix.fixId.replace(/^fx-/, '')}`,
      verify: repair.roles.length ? repair.roles.map((r) => `${r.role} ${r.held} of ${r.of}`).join(' · ') : null,
      blame: fix.blame?.lostAt ? `lost at model call #${fix.blame.lostAt} · confidence ${fix.blame.confidence}` : null,
      change: repair.change ? `${repair.change.file}${patch ? ` ${patch}` : ''}` : patch,
      spent: `≈${dollars(spent)} of $${budget}`,
      fixId: fix.fixId,
      example: false,
    };
  }
  return null;
}

/** Where the project's git metadata is: its `.git` folder, or the one a worktree's `.git` file names. */
function gitDir(project: string): string | null {
  const dotGit = join(project, '.git');
  try {
    if (statSync(dotGit).isDirectory()) return dotGit;
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
    return m ? resolve(project, m[1]!.trim()) : null;
  } catch {
    return null;
  }
}

/**
 * The project's GitHub repository (`owner/repo`, from the `origin` remote, else the first remote on
 * github.com) and the branch checked out, read from its git files without running git. Nulls when
 * either can't be told.
 */
export function gitFacts(project: string | null): { repository: string | null; branch: string | null } {
  if (!project) return { repository: null, branch: null };
  const dir = gitDir(project);
  if (!dir) return { repository: null, branch: null };
  let branch: string | null = null;
  try {
    branch = /^ref:\s*refs\/heads\/(.+)$/m.exec(readFileSync(join(dir, 'HEAD'), 'utf8'))?.[1]?.trim() ?? null;
  } catch {
    // no HEAD to read
  }
  // A worktree keeps its config in the repository it belongs to.
  let common = dir;
  try {
    const c = readFileSync(join(dir, 'commondir'), 'utf8').trim();
    common = isAbsolute(c) ? c : resolve(dir, c);
  } catch {
    // not a worktree
  }
  let repository: string | null = null;
  try {
    const config = readFileSync(join(common, 'config'), 'utf8');
    const remotes = [...config.matchAll(/\[remote "([^"]+)"\]([^[]*)/g)].map((m) => ({ name: m[1]!, url: /^\s*url\s*=\s*(.+)$/m.exec(m[2]!)?.[1]?.trim() ?? '' }));
    const onGithub = (url: string) => /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url)?.[1] ?? null;
    const origin = remotes.find((r) => r.name === 'origin' && onGithub(r.url));
    const any = origin ?? remotes.find((r) => onGithub(r.url));
    repository = any ? onGithub(any.url) : null;
  } catch {
    // no config to read
  }
  return { repository, branch };
}

/**
 * Both panels for the options given. `context` is what the store and the project say: the pull
 * request preview (null: the example), the goldens failing now (the Slack message's count, 1 when
 * none fail), when the tests last ran, the repository and the branch checked out, and the goldens
 * the steps replay.
 */
export function ciWorkflows(o: CiWorkflowOptions, context: { preview: PullRequestPreview | null; failing: number; at: number | null; repository: string | null; branch: string | null; recordings?: string }): CiWorkflowsView {
  const recordings = context.recordings ?? 'goldens/*';
  const branch = o.onlyMain ? 'main' : context.branch && context.branch !== 'main' ? context.branch : 'your-branch';
  const repo = context.repository ?? 'owner/repo';
  const message = alertsMessage({ failed: Math.max(1, context.failing), branch, runUrl: `github.com/${repo}/actions/runs/…` });
  return {
    file: WORKFLOW_FILE,
    action: ACTION,
    fixOnFailure: {
      on: o.fix,
      budget: o.budget,
      repairer: o.repairer,
      budgets: FIX_BUDGETS.map((b) => ({ value: b, label: `$${Number(b)}` })),
      repairers: REPAIRERS.map((r) => ({ ...r })),
      offNote: 'Off: a failed check fails the build, and nobody opens a fix.',
      yaml: fixOnFailureYaml({ budget: o.budget, repairer: o.repairer, recordings }),
      needs: rows(fixOnFailureNeeds(o.repairer)),
      never: rows(fixOnFailureNever(o.budget)),
      preview: context.preview ? { ...context.preview, spent: context.preview.spent.replace(/ of \$[\d.]+$/, ` of $${o.budget}`) } : examplePreview(o.budget),
    },
    alerts: {
      onlyMain: o.onlyMain,
      secret: alertsSecret(o.secret),
      yaml: alertsYaml({ onlyMain: o.onlyMain, secret: o.secret, recordings }),
      needs: rows(alertsNeeds(o.secret)),
      failures: rows(ALERT_FAILURES),
      message: { app: 'GitHub Actions', text: message.text, link: message.link, at: context.at },
    },
    recordings,
    repository: context.repository,
  };
}
