import { act, createElement, useState } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { emptyCounts, NO_TOKENS, retirementOf, Store, type DecisionChange, type DecisionRun, type DecisionStep } from '@shadowlap/engine';
import { DONE, LOOKUP, REFUND, recordRun } from '../../engine/test/training-fixtures.js';
import { previewSession, type PreviewSession } from '../src/decision-view.js';
import { migrateStart } from '../src/migrate-start.js';
import { ApiError, type Client } from '../ui/api.js';
import { MigrateTab } from '../ui/changes/Migrate.js';
import { appliedWhen } from '../ui/changes/MigrateReport.js';
import { minuteStamp } from '../ui/format.js';
import { inlineParts, Markdown, parseMarkdown } from '../ui/components/Markdown.js';
import { NO_GOLDENS } from '../ui/components/NewPreviewMenu.js';
import { migratePaletteRows } from '../ui/migrate-command.js';
import { MIGRATE_ASK } from '../ui/page-ask.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { DecisionSessionView, MigrateStartView, MigrateUse } from '../ui/types.js';
import { styleRules } from './css-sheet.js';
import { render, shownText, type FakeElement, type Rendered } from './ui-render.js';
import { withMigrateDialogs } from './ui-served-now.js';

/**
 * Changes › Migrate: the bare tab on a retiring model, on Switch from and To, with no golden and on
 * the newest migration; Migrate to's one dialog and a sent golden's consent; a migration's report
 * as the server words it, its one next step by state, Apply config change's ask, an id that is no
 * migration's, a cell opened from a run's Decisions view, Migrate to's menu, the palette's row, and
 * the pull request body drawn with its quote and link.
 */

const AT = Date.parse('2026-10-31T09:00:00Z');
const FROM = 'claude-sonnet-4-5';
const TO = 'claude-sonnet-5-5';
/** Not applied; applied with a golden left waiting; applied with none waiting. */
const MG = 'mg-01M5000000000000000000000A';
const WAITS = 'mg-01M5000000000000000000000B';
const UPDATED = 'mg-01M5000000000000000000000C';
const PATCH = '--- a/agent.py\n+++ b/agent.py\n@@ -3 +3 @@\n-MODEL = "claude-sonnet-4-5"\n+MODEL = "claude-sonnet-5-5"\n';
const REMEDY = { field: 'temperature', value: 1, leftOut: true, renamedTo: null, why: `${TO} refuses temperature with thinking on`, source: null, steps: 1 };
const shown = (el: { textContent: string } | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
/** What a line shows, a defined term's hidden definition left out. */
const seen = (el: FakeElement) => shownText(el).replace(/\s+/g, ' ').trim();

const write: DecisionChange = { rank: 1, kind: 'write-removed', tool: 'issue_refund', effect: 'write', before: { amount: 240 }, after: null, detail: 'issue_refund is no longer called' };
const step = (callNo: number, rank: DecisionStep['rank']): DecisionStep => ({
  callNo,
  step: callNo,
  scope: null,
  rank,
  majority: rank,
  changes: rank === 1 ? [write] : [],
  recorded: { stop: 'tools', stopReason: 'tool_use', tools: [], text: '' },
  now: { stop: 'tools', stopReason: 'tool_use', tools: [], text: '' },
  samples: { asked: 2, answered: 2, changed: rank === null ? 0 : 2, ranks: [rank ?? 0, rank ?? 0] },
  model: { recorded: FROM, asked: TO },
  tokens: { before: null, after: null },
  cost: { before: null, after: null, spent: 0 },
  thinkingStripped: 0,
  error: null,
});
const runOf = (runId: string, golden: string, decisions: DecisionStep[]): DecisionRun => {
  const ranks = decisions.map((d) => d.rank).filter((r): r is NonNullable<typeof r> => r !== null);
  return { runId, golden, steps: decisions.length, asked: decisions.length, rank: ranks.length ? (Math.min(...ranks) as DecisionRun['rank']) : null, majority: ranks.length ? (Math.min(...ranks) as DecisionRun['majority']) : null, counts: emptyCounts(), cost: { before: 0.04, after: 0.03, spent: 0.01 }, tokens: { before: NO_TOKENS, after: NO_TOKENS }, thinkingStripped: 0, refused: null, decisions, warnings: [] };
};

/** A grid's column tracks, counted at its top-level spaces: `minmax(170px, 270px) minmax(0, 1fr)` is two. */
function tracks(columns: string): number {
  let depth = 0;
  let n = 1;
  for (const ch of columns.trim()) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ' ' && depth === 0) n++;
  }
  return n;
}

/** How many columns the compact matrix's grid has, at a desk: the last rule for it outside any at-rule. */
function compactColumns(): number {
  let columns: string | null = null;
  for (const rule of styleRules()) if (!rule.conditions.length && rule.selectors.includes('.dmx.compact .dmg')) for (const [prop, value] of rule.decls) if (prop === 'grid-template-columns') columns = value;
  return columns ? tracks(columns) : 0;
}

describe('the compact matrix’s grid', () => {
  it('has a column for each of a row’s two cells, never the full matrix’s three, and one where a row stacks', () => {
    const value = (selector: string, conditions: string[] = []) => {
      let found: string | null = null;
      for (const rule of styleRules()) if (rule.conditions.join(' ') === conditions.join(' ') && rule.selectors.includes(selector)) for (const [prop, v] of rule.decls) if (prop === 'grid-template-columns') found = v;
      return found;
    };
    // The full matrix: a run, its cells, what changed most.
    expect(tracks(value('.dmg')!)).toBe(3);
    // Compact, as a migration's What changes draws it: the run and its cells, so no row's cells flow into the next row's line.
    expect(compactColumns()).toBe(2);
    // Stacked, both are one column, the compact one named so its two columns don't outlast the full one's.
    const stacked = ['@container (max-width: 760px)'];
    expect([value('.dmg', stacked), value('.dmx.compact .dmg', stacked)]).toEqual(['minmax(0, 1fr)', 'minmax(0, 1fr)']);
  });
});

describe('Changes › Migrate', () => {
  let store: Store;
  let a = '';
  let b = '';
  let start: MigrateStartView;
  let unchecked: MigrateStartView;
  let page: Rendered | null = null;
  const sessions = new Map<string, PreviewSession>();
  const notice = retirementOf('anthropic', FROM, { now: AT })!;
  const body = `## Switch ${FROM} to ${TO}\n\nChecked with \`shadowlap migrate --to ${TO}\`.\n\n> ${notice.text} ([source](${notice.source}))\n\n### What changes\n\n- refund #2: issue_refund is no longer called`;

  /** A migration from FROM to TO as `migrate --json` keeps it: one run flagged and verified, one the preview cleared, `temperature` taken out, a golden left behind. */
  const migration = (id: string, runs: DecisionRun[], o: { verify?: Record<string, unknown>; warnings?: string[]; notes?: string[] } = {}) => {
    const [x, y] = runs;
    const decisions = { decisionsId: null, kind: 'decisions', at: AT, change: { model: TO, fields: {}, from: [FROM], fromCode: null, text: `the model ${TO}` }, command: `shadowlap migrate --to ${TO}`, samples: 2, counts: { ...emptyCounts(), 1: 1, same: 3 }, flagged: [x.runId], toVerify: [x.runId], remedies: [REMEDY], runs, cost: { before: 0.04, after: 0.03, spent: 0.01, upstreamRequests: 4, unknownModels: [] }, stopReason: null, judge: null, notes: [], warnings: [], verify: { verdict: 'accepted', rule: 'rate >= 0.6 (95%)', reasons: [], warnings: [], runs: [{ runId: x.runId, golden: 'goldens/refund', role: 'target', outcome: 'kept', verdict: 'passed', passes: 4, attempts: 4, bound: 'rate >= 0.6 (95%)', rule: 'rate >= 0.6 (95%)' }] } };
    if (o.verify) Object.assign(decisions, { verify: o.verify });
    const data = {
      migrateId: id,
      kind: 'migrate',
      at: AT,
      from: [FROM],
      to: TO,
      command: `shadowlap migrate --to ${TO} goldens/refund goldens/lookup --from ${FROM}`,
      decisions,
      changes: { runs: 2, flagged: 1, steps: [{ runId: x.runId, golden: 'goldens/refund', callNo: 2, rank: 1, detail: 'issue_refund is no longer called', recorded: 'issue_refund', now: 'end_turn', arguments: [] }] },
      passes: {
        verdict: 'accepted',
        runs: [
          { runId: x.runId, golden: 'goldens/refund', verdict: 'passed', outcome: 'kept', verified: true, tally: { passes: 4, attempts: 4, bound: 'rate >= 0.6 (95%)', rule: 'rate >= 0.6 (95%)' }, diverges: { callNo: 1, path: '$.model' } },
          { runId: y.runId, golden: 'goldens/lookup', verdict: 'passed', outcome: 'unchanged', verified: false, tally: null, diverges: null, stays: 'fork' },
        ],
      },
      costs: { perRun: { before: 0.04, after: 0.03 }, total: { before: 0.08, after: 0.06 }, tokensPerRun: { before: 1200, after: 900 }, endToEnd: null, checking: { decisions: 0.01, judge: 0, verify: 0.02 } },
      set: { flags: ['--set', 'temperature=null'], fields: [REMEDY], given: {}, byHand: [] },
      configChange: { files: [{ path: 'agent.py', places: 2 }], leftOut: [{ field: 'temperature', path: 'agent.py' }], review: [{ path: 'README.md', line: 12, text: `names ${FROM}` }], patch: PATCH },
      pullRequest: { title: `Switch ${FROM} to ${TO}`, body },
      files: { dir: `.shadowlap/migrations/${id}`, pullRequest: `.shadowlap/migrations/${id}/pull-request.md`, patch: `.shadowlap/migrations/${id}/config.patch` },
      retirements: [notice],
      stopReason: null,
      notes: o.notes ?? [],
      warnings: o.warnings ?? ['1 step got no answer: rate limited'],
    };
    store.putDecisionSession({ sessionId: id, kind: 'migrate', at: AT, change: `the model ${TO}`, actor: 'dev', revision: null, data, runs: runs.map((r) => ({ runId: r.runId, golden: r.golden, rank: r.rank, changed: r.rank === null ? 0 : 1, data: r as unknown as Record<string, unknown> })) });
  };

  beforeAll(() => {
    store = Store.open(':memory:');
    const kept = store as unknown as Parameters<typeof recordRun>[0];
    a = recordRun(kept, [LOOKUP, REFUND, DONE], { model: FROM }).run.runId;
    b = recordRun(kept, [LOOKUP, DONE], { model: FROM }).run.runId;
    const runs = [runOf(a, 'goldens/refund', [step(1, null), step(2, 1)]), runOf(b, 'goldens/lookup', [step(1, null), step(2, null)])];
    const goldens = [
      { path: 'goldens/refund', runId: a, packedAt: 1, mode: 'replay' as const, repeat: 1, passes: 1, checks: [] },
      { path: 'goldens/lookup', runId: b, packedAt: 1, mode: 'replay' as const, repeat: 1, passes: 1, checks: [] },
    ];
    unchecked = migrateStart(store, goldens, AT);
    for (const id of [MG, WAITS, UPDATED]) migration(id, runs);
    store.setMigrationApplied(WAITS, { at: AT + 1_000, by: 'dev', outdated: [{ golden: 'goldens/refund', callNo: 1, path: '$.model' }] });
    store.setMigrationApplied(UPDATED, { at: AT + 1_000, by: 'dev', outdated: [] });
    for (const id of [MG, WAITS, UPDATED]) sessions.set(id, previewSession(store, id)!);
    start = migrateStart(store, goldens, AT);
  });
  afterAll(() => store.close());
  afterEach(async () => {
    await page?.unmount();
    page = null;
    vi.unstubAllGlobals();
  });

  const listed = (id: string): DecisionSessionView => ({ sessionId: id, kind: 'migrate', at: AT, change: `the model ${TO}`, name: `Migration to ${TO}`, runs: 2, goldens: 2, unit: 'run', samples: 2, flagged: 1, actor: null, revision: null, href: `#/changes/migrate/${id}` });
  const started: Array<[string, Record<string, unknown>]> = [];
  const choices = { choices: [{ id: 'claude-opus-5', family: 'claude', group: 'Anthropic' }, { id: 'gpt-5', family: 'openai', group: 'OpenAI' }], notes: [], priced: [] };
  const estimates = { decisionEstimates: () => Promise.resolve({ verify: null, runs: [] }), previewEstimates: () => Promise.resolve({ ways: null }), modelChoices: () => Promise.resolve(choices), migrateEstimate: () => Promise.resolve({ estimate: null, preview: null, scopes: [{ scope: null, calls: 6 }] }), testsEstimates: () => Promise.resolve({ run: null, goldens: {} }) };
  const app = (client: Partial<Client>, o: Partial<AppState> = {}): AppState =>
    ({
      client: {
        jobs: () => Promise.resolve([]),
        // An opened cell's conversation, which these tests don't read.
        call: () => new Promise(() => undefined),
        startJob: (kind: string, fields: Record<string, unknown>) => (started.push([kind, fields]), Promise.resolve({ id: 'j1', kind, title: '', args: [], done: false, code: null })),
        estimates,
        tests: () => Promise.resolve({ rows: [], divergences: [], inconclusive: [] }),
        ...client,
      } as unknown as Client,
      exported: false,
      meta: null,
      tick: 0,
      runsTick: 0,
      feeds: {},
      jobs: [],
      live: [],
      runs: [],
      actionsOff: null,
      hasKind: () => true,
      guard: (fn: () => void) => (fn(), true),
      toast: () => undefined,
      watchJob: () => undefined,
      refresh: () => undefined,
      ...o,
    }) as unknown as AppState;
  const sessionOf = (id: string) => {
    const s = sessions.get(id);
    return s ? Promise.resolve(s) : Promise.reject(new ApiError(404, `No session ${id}`));
  };
  const open = async (view: MigrateStartView, listing: string[], o: { id?: string; run?: string; call?: number; client?: Partial<Client>; app?: Partial<AppState> } = {}) => {
    started.length = 0;
    const client = { migrateStart: () => Promise.resolve(view), decisionSessions: () => Promise.resolve({ sessions: listing.map(listed), goldens: view.goldens }), decisionSession: sessionOf, ...o.client } as unknown as Partial<Client>;
    page = await render(createElement(AppContext.Provider, { value: app(client, o.app) }, withMigrateDialogs(createElement(MigrateTab, { id: o.id ?? null, run: o.run ?? null, call: o.call ?? null }))));
    return page;
  };
  const report = async (id: string, o: Parameters<typeof open>[2] = {}) => {
    const p = await open(start, [MG, WAITS, UPDATED], { id, ...o });
    await p.until('the report', () => !!p.one('.mgverdict') && p.all('.dmr').length === 2);
    return p;
  };
  const facts = (p: Rendered) => p.all('.dialog .dfacts div').map(shown);

  describe('the bare tab', () => {
    it('opens on a retiring model no migration checked: its date, who recommends what, its goldens, Switch to its replacement, the command and Migrate to, lime', async () => {
      const p = await open(unchecked, []);
      await p.until('the start page', () => !!p.one('.mgstart h2'));
      const n = unchecked.retiring[0];
      expect([n.model, n.replacements[0], n.checked]).toEqual([FROM, TO, null]);
      expect(shown(p.one('.mgstart h2'))).toBe(`${FROM} retires on November 30, 2026`);
      expect(shown(p.all('.mgstart p')[0])).toBe(`In 30 days, on the Claude API. Anthropic recommends ${TO}. Used by 2 goldens: refund and lookup.`);
      expect(p.all('.mgstart p')[0].querySelectorAll('code').map(shown)).toEqual(['refund', 'lookup']);
      expect(p.one('.mgform input').props.value).toBe(TO);
      expect(shown(p.one('.mgstart .mgcmd'))).toContain(`shadowlap migrate --to ${TO} goldens/refund goldens/lookup --from ${FROM}`);
      const go = p.byText('.mgstart .actions button', `Migrate to ${TO}`);
      expect([go.className.split(' ').includes('lime'), go.getAttribute('aria-disabled')]).toEqual([true, null]);
      expect(shown(p.one('.mgsrc'))).toMatch(/The date is from the retirement table that ships with shadowlap, read from Anthropic’s model deprecations page; nothing is fetched\.$/);
      expect(p.one('.mgsrc a').getAttribute('href')).toBe(n.source);
    });

    it('has Migrate to wait, saying why, on a field that names no model, the model it switches from or no other, the command following the field', async () => {
      const p = await open(unchecked, []);
      await p.until('the start page', () => !!p.one('.mgform input'));
      const go = () => p.one('.mgstart .actions button');
      for (const [typed, why] of [
        ['', 'Name the model to switch to'],
        [FROM, 'Pick a model other than the one it switches from'],
        ['not a model!', 'That isn’t a model’s name'],
      ] as const) {
        await p.type(p.one('.mgform input'), typed);
        expect([go().getAttribute('aria-disabled'), go().getAttribute('data-why')], typed).toEqual(['true', why]);
      }
      await p.type(p.one('.mgform input'), 'claude-opus-5');
      expect([shown(go()), go().getAttribute('aria-disabled')]).toEqual(['Migrate to claude-opus-5', null]);
      expect(shown(p.one('.mgstart .mgcmd'))).toContain(`shadowlap migrate --to claude-opus-5 goldens/refund goldens/lookup --from ${FROM}`);
    });

    it('asks Migrate to in one priced dialog naming the preview that asked it already, then asks a sent golden’s consent before it runs', async () => {
      const why = 'goldens/refund came from a pack: its command runs on your machine';
      const preview = { sessionId: 'dc-01M5000000000000000000000P', verified: true };
      const startJob = (kind: string, fields: Record<string, unknown>) => (started.push([kind, fields]), fields.yes === undefined ? Promise.reject(new ApiError(409, why, 'c1')) : Promise.resolve({ id: 'j1', kind, title: '', args: [], done: false, code: null }));
      const p = await open(unchecked, [], { client: { startJob, estimates: { ...estimates, migrateEstimate: () => Promise.resolve({ estimate: null, preview, scopes: [{ scope: null, calls: 6 }] }) } } as unknown as Partial<Client> });
      await p.until('the start page', () => !!p.one('.mgstart .actions button'));
      await p.click(p.byText('.mgstart .actions button', `Migrate to ${TO}`));
      await p.until('the dialog', () => p.all('.dialog').length === 1 && facts(p).length === 2);
      expect(shown(p.one('.dialog h3'))).toBe(`Migrate ${FROM} to ${TO}`);
      expect(seen(p.one('.dialog header p'))).toBe(`Asks ${FROM}’s calls again under ${TO}, then verifies end to end the runs the preview can’t clear. Migrate in the docs →`);
      expect(facts(p)).toEqual(['Writesa config change and a pull request body, beside the storeyour files stay as they are', 'Previewdc-01M5000000 asked these alreadymigrate asks and verifies again, its answers not reused']);
      expect(shown(p.one('.dialog .cmdline'))).toContain(`shadowlap migrate --to ${TO} goldens/refund goldens/lookup --from ${FROM}`);
      await p.click(p.one('.dialog .dlg-ok'));
      await p.until('the consent question', () => p.all('.dialog').some((d) => shown(d).includes(why)));
      await p.click(p.byText('.dialog button', 'Run command'));
      expect(started.map(([k, f]) => [k, f.to, f.from, f.goldens, f.yes ?? null])).toEqual([
        ['migrate', TO, [FROM], ['goldens/refund', 'goldens/lookup'], null],
        ['migrate', TO, [FROM], ['goldens/refund', 'goldens/lookup'], 'c1'],
      ]);
    });

    it('keeps Migrate to the scope picked where its goldens called in two, holds it to its Stop at $, prices that, and sends both', async () => {
      const asked: Array<Record<string, unknown> | undefined> = [];
      const ceiling = { kind: 'migrate', usd: 1.8, ceiling: true, always: 'it writes a config change and a pull request body', parts: ['6 calls asked again'] };
      const migrateEstimate = (_to: string, _from: string[], _goldens: string[], _runs: string[], narrow?: Record<string, unknown>) => {
        asked.push(narrow);
        const stops = typeof narrow?.budget === 'number' ? narrow.budget : null;
        return Promise.resolve({ estimate: stops ? { ...ceiling, stops, parts: [...ceiling.parts, 'nothing asked or verified past it'] } : ceiling, preview: null, scopes: [{ scope: 'support-agent', calls: 4 }, { scope: 'customer', calls: 2 }] });
      };
      const startJob = (kind: string, fields: Record<string, unknown>) => (started.push([kind, fields]), Promise.resolve({ id: 'j1', kind, title: '', args: [], done: false, code: null }));
      const p = await open(unchecked, [], { client: { startJob, estimates: { ...estimates, migrateEstimate } } as unknown as Partial<Client> });
      await p.until('the start page', () => !!p.one('.mgstart .actions button'));
      await p.click(p.byText('.mgstart .actions button', `Migrate to ${TO}`));
      await p.until('its scopes', () => p.all('.dialog select option').length === 3);
      expect(p.all('.dialog select option').map(shown)).toEqual(['every scope', 'support-agent', 'customer']);
      await p.type(p.one('.dialog select'), 'support-agent');
      await p.type(p.one('.dialog input[type="number"]'), '1');
      await p.until('its narrowed price', () => asked.some((n) => n?.budget === 1) && shown(p.one('.dialog .dcost')).includes('nothing asked or verified past it'));
      expect(asked.find((n) => n?.budget === 1)).toEqual({ scope: 'support-agent', budget: 1 });
      expect(shown(p.one('.dialog .cmdline'))).toContain(`shadowlap migrate --to ${TO} goldens/refund goldens/lookup --from ${FROM} --scope support-agent --budget 1.00`);
      await p.click(p.one('.dialog .dlg-ok'));
      expect(started.map(([k, f]) => [k, f.scope, f.budget, f.estimate])).toEqual([['migrate', 'support-agent', 1, { usd: 1.8, ceiling: true, stops: 1 }]]);
    });

    it('opens Switch from and To where no model the goldens call retires and no migration was made, To never the model switched from', async () => {
      const use: MigrateUse[] = [
        { model: 'gpt-4o', provider: 'openai', calls: 6, goldens: 2, family: 'openai' },
        { model: 'gpt-4.1', provider: 'openai', calls: 2, goldens: 1, family: 'openai' },
      ];
      const p = await open({ goldens: 2, retiring: [], use }, []);
      await p.until('the start page', () => !!p.one('.mgstart select'));
      expect(shown(p.one('.mgstart h2'))).toBe('Switch models with the evidence');
      expect([p.one('.mgstart select').props.value, p.all('.mgstart select option').map(shown), p.one('.mgform input').props.value]).toEqual(['gpt-4o', ['gpt-4o', 'gpt-4.1'], 'gpt-4.1']);
      expect(shown(p.one('.mgstart .mgcmd'))).toContain('shadowlap migrate --to gpt-4.1 --from gpt-4o');
      // Switching from the model To names moves To to the other.
      await p.type(p.one('.mgstart select'), 'gpt-4.1');
      expect([p.one('.mgform input').props.value, shown(p.one('.mgstart .actions button'))]).toEqual(['gpt-4o', 'Migrate to gpt-4o']);
      expect(shown(p.one('.mgstart .mgcmd'))).toContain('shadowlap migrate --to gpt-4o --from gpt-4.1');
    });

    it('sets the start page’s words as copy: a retiring model’s facts and where its date comes from, and what Migrate does, each sentence set', async () => {
      const p = await open(unchecked, []);
      await p.until('the start page', () => !!p.one('.mgstart .mgsrc'));
      expect(p.all('.mgstart > p').map((x) => [x.className, x.querySelectorAll('ts-s').length > 0])).toEqual([
        ['', true],
        ['muted mgsrc', true],
      ]);
      await page?.unmount();
      const q = await open({ goldens: 2, retiring: [], use: [{ model: 'gpt-4o', provider: 'openai', calls: 6, goldens: 2, family: 'openai' }] }, []);
      await q.until('the start page', () => !!q.one('.mgstart select'));
      expect(q.one('.mgstart > p').querySelectorAll('ts-s').length).toBe(2);
    });

    it('says what to pack first where the project has no golden', async () => {
      const p = await open({ goldens: 0, retiring: [], use: [] }, []);
      await p.until('the empty state', () => !!p.one('.emptyline'));
      expect(shown(p.one('.emptyline'))).toBe(`${NO_GOLDENS} Open Runs`);
      expect(p.one('.emptyline a').getAttribute('href')).toBe('#/runs');
      expect(p.all('.mgstart')).toHaveLength(0);
    });

    it('says why a read failed as every page does, the status where the server sent no sentence of its own, else its sentence, with Retry', async () => {
      const lines = (p: Rendered) => p.all('.loaderr p > span').map(shown);
      const status = 'The dashboard server answered 500 for this page’s data.';
      const late = 'a decision-session job took more than 30 s, so it was stopped';
      let tries = 0;
      let p = await open(unchecked, [], { client: { migrateStart: () => (++tries === 1 ? Promise.reject(new ApiError(500, 'HTTP 500')) : Promise.resolve(unchecked)) } as unknown as Partial<Client> });
      await p.until('the start read’s failure', () => p.all('.loaderr').length === 1);
      expect([lines(p), p.all('.loaderr button').map(shown)]).toEqual([['couldn’t load', status], ['Retry']]);
      await p.click(p.byText('.loaderr button', 'Retry'));
      await p.until('the start page', () => !!p.one('.mgstart h2'));
      await p.unmount();
      page = null;
      // A migration's own read, then the list of migrations beside it.
      p = await open(start, [MG], { id: MG, client: { decisionSession: () => Promise.reject(new ApiError(503, late)) } as unknown as Partial<Client> });
      await p.until('the migration’s failure', () => lines(p)[1] === late);
      await p.unmount();
      page = null;
      p = await open(start, [MG], { id: MG, client: { decisionSessions: () => Promise.reject(new ApiError(500, 'HTTP 500')) } as unknown as Partial<Client> });
      await p.until('the list’s failure', () => p.all('.loaderr').length === 1);
      expect([lines(p), p.all('.loaderr button').map(shown)]).toEqual([['couldn’t load', status], ['Retry']]);
    });

    it('opens the newest migration once a migration checked every retiring model', async () => {
      const asked: string[] = [];
      expect(start.retiring.map((n) => n.checked?.sessionId)).toEqual([UPDATED]);
      const p = await open(start, [UPDATED, WAITS, MG], { client: { decisionSession: (id: string) => (asked.push(id), sessionOf(id)) } as unknown as Partial<Client> });
      await p.until('the report', () => !!p.one('.mgverdict'));
      expect([asked, p.all('.mgstart').length]).toEqual([[UPDATED], 0]);
    });

    it('opens Migrate’s dialog on the palette’s Migrate <a> to <b>', async () => {
      const p = await open(unchecked, []);
      await p.until('the start page', () => !!p.one('.mgstart h2'));
      MIGRATE_ASK.ask(FROM);
      await p.until('the dialog', () => p.all('.dialog').length === 1);
      expect(shown(p.one('.dialog h3'))).toBe(`Migrate ${FROM} to ${TO}`);
    });
  });

  describe('a migration’s report', () => {
    it('draws the verdict, What changes, What still passes with the golden it leaves behind, costs, What to set, the config change, the pull request and the command', async () => {
      const p = await report(MG);
      const m = sessions.get(MG)!.migration!;
      // The verdict: Verdicts' word, the headline, the switch line and the retirement line.
      expect([shown(p.one('.mgverdict .vw')), shown(p.one('.mgverdict h2'))]).toEqual(['accepted', `accepted ${TO} keeps the run it verified passing`]);
      // The retirement as the table words it today.
      expect(p.all('.mgverdict .pline').map(shown)).toEqual([`${FROM} → ${TO}, 2 runs`, m.retirements[0].text]);
      expect(m.retirements[0].text).toMatch(new RegExp(`^${FROM} \\(claude-sonnet-4-5-20250929\\) retires on the Claude API on November 30, 2026`));
      // What changes: the compact matrix, then the write it changes opening its cell.
      expect(p.all('.mgch .dmr')).toHaveLength(2);
      // Compact, a row is its run and its cells and nothing after them, on a grid of as many columns.
      expect(p.all('.mgch .dmx.compact .dmr').map((row) => row.children.map((c) => c.className.split(' ')[0]))).toEqual([
        ['dml', 'dmcw'],
        ['dml', 'dmcw'],
      ]);
      expect(compactColumns()).toBe(2);
      expect(shown(p.one('.mgch header .sub'))).toBe(`the calls made with ${FROM}, asked under ${TO}`);
      expect(p.all('.mgsteps li').map((li) => [li.querySelector('b')!.className, ...['b', 'a', '.mgw', '.mgarg'].map((q) => shown(li.querySelector(q)))])).toEqual([['dsd q1', 'rank 1', 'refund #2', 'issue_refund is no longer called', 'issue_refund → end_turn']]);
      expect(p.one('.mgsteps a').getAttribute('href')).toBe(`#/changes/migrate/${MG}/${a}/2`);
      // What still passes: each run, the golden the config change leaves behind, the rule and how many were verified.
      expect(p.all('.mgpass li .mgn').map(shown)).toEqual(['refund', 'lookup']);
      expect(p.all('.mgpass li .mgw').map(seen)).toEqual(['kept, verified · 4 of 4 passed · rate >= 0.6 (95%)', m.passes.runs[1].words]);
      expect(p.all('.mgpass .mgleft').map(shown)).toEqual(['diverges at #1 on $.model once applied']);
      expect(p.all('.mgpass .mgrule').map(seen)).toEqual(['rate >= 0.6 (95%)', '1 of 2 runs verified end to end']);
      // What it costs, beside What still passes: each line under its label.
      expect([p.one('.mgpass').parentNode!.className, p.one('.mgcost').parentNode === p.one('.mgpass').parentNode]).toEqual(['grid2 secs', true]);
      expect(p.all('.mgcost p').map((x) => [shown(x.querySelector('.k')), seen(x.querySelectorAll('span')[1])])).toEqual([
        ['per run', '≈$0.040 → ≈$0.030 (−25%) · 1,200 → 900 tokens'],
        ['checking it', '≈$0.010 asking, ≈$0.020 verifying'],
      ]);
      // What to set: the field, why with the field it names as code, and the flags verify took, as code.
      expect(shown(p.one('.mgset header .sub'))).toBe(`each field ${TO} refuses, and what it takes instead`);
      expect(p.all('.mgset .mgfield').map((f) => [shown(f.querySelector('b')), f.querySelector('b')!.querySelectorAll('code').map(shown), shown(f.querySelector('p')), f.querySelector('p')!.querySelectorAll('code').map(shown)])).toEqual([['leave temperature out (the requests were sent temperature=1, its default, meanwhile)', ['temperature', 'temperature=1'], `${TO} refuses temperature with thinking on`, ['temperature']]]);
      expect(shown(p.one('.mgset > p.muted'))).toBe('verify takes them as: --set temperature=null');
      expect(shown(p.one('.mgset > p.muted code'))).toBe('--set temperature=null');
      // The config change: files and places, a row a file with its diff folded, what it takes out, the review, git apply and Copy config change.
      expect(shown(p.one('.mgcfg header .sub'))).toBe('agent.py · 2 places');
      const file = () => p.one('.mgcfg .mgfiles > li');
      const diff = () => p.one('.mgcfg .mgfile button');
      expect(p.all('.mgcfg .mgfiles > li')).toHaveLength(1);
      expect([shown(file().querySelector('.mgfile > code')), file().querySelectorAll('.mgstat span').map((x) => [x.className, x.textContent])]).toEqual(['agent.py', [['add', '+1'], ['del', '−1']]]);
      expect([shown(diff()), diff().getAttribute('aria-label'), diff().getAttribute('aria-expanded'), p.all('.mgcfg .fxpatch').length]).toEqual(['Show diff', 'Show diff of agent.py', 'false', 0]);
      // Show diff draws the file's hunks under its row, in the patch's colours, without the lines that only name the file.
      await p.click(diff());
      expect([shown(diff()), diff().getAttribute('aria-label'), diff().getAttribute('aria-expanded'), diff().getAttribute('aria-controls') === p.one('.mgcfg .mgfiles > li > div[id]').getAttribute('id')]).toEqual(['Hide diff', 'Hide diff of agent.py', 'true', true]);
      expect(p.all('.mgcfg .mgfiles .fxpatch span').map((l) => [l.className, l.textContent])).toEqual([
        ['', '  @@ -3 +3 @@'],
        ['del', `− MODEL = "${FROM}"`],
        ['add', `+ MODEL = "${TO}"`],
      ]);
      await p.click(diff());
      expect(p.all('.mgcfg .fxpatch')).toHaveLength(0);
      expect(p.all('.mgcfg .mgalso.inpatch')).toHaveLength(1);
      expect(p.all('.mgcfg .mgrev').map(shown)).toEqual([`Left for review: README.md:12 names ${FROM}`]);
      expect(shown(p.one('.mgcfg .mgcmd'))).toContain(`git apply .shadowlap/migrations/${MG}/config.patch`);
      expect(p.all('.mgcfg .actions button').map(shown)).toEqual(['Copy config change']);
      // The pull request: its title, gh pr create, Copy pull request body and Show body.
      expect(shown(p.one('.mgpr header .sub'))).toBe(`Switch ${FROM} to ${TO}`);
      expect(shown(p.one('.mgpr .mgcmd'))).toContain(`gh pr create --title 'Switch ${FROM} to ${TO}' --body-file .shadowlap/migrations/${MG}/pull-request.md`);
      expect(p.all('.mgpr .actions button').map(shown)).toEqual(['Copy pull request body', 'Show body']);
      // The foot: the warnings, then the command that made it.
      expect(p.all('.mgend .dnotes li').map(shown)).toEqual(['1 step got no answer: rate limited']);
      expect(shown(p.one('.mgend .chcmd'))).toContain(`shadowlap migrate --to ${TO} goldens/refund goldens/lookup --from ${FROM}`);
    });

    it('draws the pull request body under Show body, its retirement quoted and its source a link that opens apart', async () => {
      const p = await report(MG);
      await p.click(p.byText('.mgpr .actions button', 'Show body'));
      expect(p.byText('.mgpr .actions button', 'Hide body').getAttribute('aria-expanded')).toBe('true');
      expect(shown(p.one('.mgpr blockquote p'))).toBe(`${notice.text} (source)`);
      const link = p.one('.mgpr blockquote a');
      expect([link.getAttribute('href'), link.getAttribute('target'), link.getAttribute('rel')]).toEqual([notice.source, '_blank', 'noopener noreferrer']);
    });

    it('reads the migration again as a test result lands, so a golden re-recorded since moves the next step on from Update goldens', async () => {
      const FOLLOWS = 'mg-01M50000000000000000000009';
      migration(FOLLOWS, [runOf(a, 'goldens/refund', [step(1, null), step(2, 1)]), runOf(b, 'goldens/lookup', [step(1, null), step(2, null)])]);
      store.setMigrationApplied(FOLLOWS, { at: AT + 1_000, by: null, outdated: [{ golden: 'goldens/lookup', callNo: 2, path: '$.model' }] });
      const client = { migrateStart: () => Promise.resolve(start), decisionSessions: () => Promise.resolve({ sessions: [listed(FOLLOWS)], goldens: 2 }), decisionSession: (id: string) => Promise.resolve(previewSession(store, id)!) };
      let bump: (n: number) => void = () => undefined;
      function Host() {
        const [tests, setTests] = useState(1);
        bump = setTests;
        return createElement(AppContext.Provider, { value: app(client as unknown as Partial<Client>, { feeds: { decisions: 1, tests } }) }, createElement(MigrateTab, { id: FOLLOWS, run: null, call: null }));
      }
      page = await render(createElement(Host));
      const p = page;
      const next = () => p.all('.mgverdict .actions button').map(shown);
      await p.until('Update goldens', () => next().includes('Update goldens'));
      const ts = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/lookup', '--update'], revision: null, actor: null, startedAt: AT + 2_000 });
      store.addTestResult({ sessionId: ts.sessionId, golden: 'goldens/lookup', ok: true, at: AT + 2_000 });
      await act(async () => bump(2));
      await p.until('Copy pull request body', () => next().includes('Copy pull request body'));
      expect(p.all('.mgverdict .pline').map(shown).filter((l) => l.includes(' to update under '))).toEqual([]);
    });

    it('says once that verify didn’t run, under What still passes, and not again at the foot', async () => {
      const NOT_RUN = 'mg-01M50000000000000000000008';
      const reasons = ['the agent asks for a key'];
      migration(NOT_RUN, [runOf(a, 'goldens/refund', [step(1, null), step(2, 1)]), runOf(b, 'goldens/lookup', [step(1, null), step(2, null)])], { verify: { verdict: 'not-run', rule: null, reasons, warnings: [], runs: [] }, warnings: ['Not verified: the agent asks for a key', '1 step got no answer: rate limited'] });
      sessions.set(NOT_RUN, previewSession(store, NOT_RUN)!);
      const p = await open(start, [NOT_RUN], { id: NOT_RUN });
      await p.until('the report', () => p.all('.mgend .dnotes li').length > 0);
      expect(p.all('.mgpass .mgrule').map(shown)).toContain('Not verified yet: the agent asks for a key.');
      expect(p.all('.mgend .dnotes li').map(shown)).toEqual(['1 step got no answer: rate limited']);
    });

    it('offers one next step: Apply config change, then Update goldens while a golden waits, then Copy pull request body', async () => {
      const step = async (id: string) => {
        const p = await report(id);
        const out = p.all('.mgverdict .actions button').map((x) => [shown(x), x.className.split(' ').includes('lime')]);
        const lines = p.all('.mgverdict .pline').map(shown).filter((l) => l.includes(' to update under '));
        await p.unmount();
        page = null;
        return [out, lines];
      };
      expect(await step(MG)).toEqual([[['Apply config change', true]], []]);
      expect(await step(WAITS)).toEqual([[['Update goldens', true]], [`1 golden to update under ${TO}: refund`]]);
      expect(await step(UPDATED)).toEqual([[['Copy pull request body', true]], []]);
    });

    it('sets its lines as the line rules do: a cost part whole with its dot, a model’s name whole, a step’s change as code shown as text, a note as copy and a warning as written', async () => {
      const NOTED = 'mg-01M50000000000000000000007';
      const note = 'Each step was asked once, and a model varies from one answer to the next: --samples 3 asks each step as recorded as often too.';
      migration(NOTED, [runOf(a, 'goldens/refund', [step(1, null), step(2, 1)]), runOf(b, 'goldens/lookup', [step(1, null), step(2, null)])], { notes: [note] });
      sessions.set(NOTED, previewSession(store, NOTED)!);
      const p = await open(start, [NOTED], { id: NOTED });
      await p.until('the report', () => p.all('.mgend .dnotes li').length === 2);
      // Each part of a cost line whole on its line, its dot kept with it, so no line starts with one.
      expect(p.all('.mgcost p')[0].querySelectorAll('span')[1].querySelectorAll('span.nw').map((x) => x.textContent.replace(/\u00a0/g, ' '))).toEqual(['≈$0.040 → ≈$0.030 (−25%) ·', '1,200 → 900 tokens']);
      // A model's name in the verdict's lines kept whole, where a browser would break it at a hyphen.
      expect(p.all('.mgverdict .pline')[0].querySelectorAll('ts-w').map((w) => w.textContent)).toEqual([FROM, `${TO},`]);
      // A step's change as code shown as text: it breaks after a comma or a brace, never inside a call, an arrow kept with the word before it.
      expect(p.one('.mgsteps .mgarg').className).toBe('ts-ct mgarg');
      // The warning as the server wrote it; the note set as copy, its flag kept whole where a browser would break it at a hyphen.
      expect(p.all('.mgend .dnotes li').map((li) => [shown(li), li.querySelectorAll('ts-w').map((w) => w.textContent)])).toEqual([
        ['1 step got no answer: rate limited', []],
        [note, ['--samples']],
      ]);
    });

    it('says applied once applied, with the golden left waiting where What still passes names it', async () => {
      const p = await report(WAITS);
      expect(shown(p.one('.mgverdict .vw'))).toBe('applied');
      // When, and who only where names show: this store names none.
      expect(p.all('.mgverdict .pline').map(shown)).toContain(`applied ${minuteStamp(AT + 1_000)}`);
      expect(appliedWhen(previewSession(store, WAITS, { shared: true })!.migration!.applied!)).toBe(`applied ${minuteStamp(AT + 1_000)} by dev`);
      expect(shown(p.one('.mgcfg header .sub'))).toBe('agent.py · 2 places · applied');
      expect(p.all('.mgpass .mgleft').map(shown)).toEqual(['diverges at #1 on $.model until updated']);
    });

    it('asks before Apply config change: what it does, what it leaves out, the golden it leaves behind, the patch and the command, then starts migrate-apply', async () => {
      const p = await report(MG);
      await p.click(p.byText('.mgverdict .actions button', 'Apply config change'));
      await p.until('the dialog', () => p.all('.dialog').length === 1);
      expect(shown(p.one('.dialog h3'))).toBe('Apply config change?');
      expect(seen(p.one('.dialog header p'))).toBe('Applies the migration’s config change to your working tree, for you to review before you commit. Migrate in the docs →');
      expect(p.all('.dialog .steps li').map(shown)).toEqual(['1Patch appliedagent.py, with git apply', '2Goldens replayedoffline, any that diverge are named', `3Update goldens nextto re-record it under ${TO}`]);
      // The golden left behind is listed under the patch, so no Diverges row names it.
      expect(facts(p)).toEqual(['Leaves outtemperatureas What to set says']);
      expect(p.all('.dialog .fxpatch')).toHaveLength(1);
      expect(shown(p.one('.dialog .ondisk:not(.steps) .k'))).toBe('Left behind');
      expect(p.all('.dialog .ondisk:not(.steps) ul.plain li').map((li) => [shown(li.querySelector('span')), shown(li.querySelector('code'))])).toEqual([['refund', '#1 · $.model']]);
      expect(shown(p.one('.dialog .cmdline'))).toContain('shadowlap migrate apply mg-01M5000000');
      await p.click(p.one('.dialog .dlg-ok'));
      expect(started).toEqual([['migrate-apply', { migrationId: MG }]]);
    });

    it('says in Apply config change? why no golden diverges where none is left behind, as the server words it, with no Update goldens step', async () => {
      const stays = `1 marked fork passes on its checks, 1 never sends ${FROM}`;
      const clear = async (id: string) => {
        const s = await sessionOf(id);
        return { ...s, migration: { ...s.migration!, apply: { ...s.migration!.apply, leftBehind: [], stays } } };
      };
      const p = await report(MG, { client: { decisionSession: clear } as unknown as Partial<Client> });
      await p.click(p.byText('.mgverdict .actions button', 'Apply config change'));
      await p.until('the dialog', () => p.all('.dialog').length === 1);
      expect(facts(p)).toEqual(['Leaves outtemperatureas What to set says', `Divergesno golden${stays}`]);
      expect(p.all('.dialog .steps li').map(shown)).toEqual(['1Patch appliedagent.py, with git apply', '2Goldens replayedoffline, any that diverge are named']);
      expect(p.all('.dialog .ondisk:not(.steps)')).toHaveLength(0);
    });

    it('opens a call’s cell under What changes from a run’s Decisions view, its links back to the run and to the migration, with no Verify', async () => {
      const p = await report(MG, { run: a, call: 2 });
      await p.until('the cell', () => !!p.one('.dcell .dch h2'));
      expect(shown(p.one('.dcell .dch h2'))).toBe(`#2 · step 2 of ${a}`);
      expect(p.all('.dcell .dacts a').map((x) => x.getAttribute('href'))).toEqual([`#/run/${a}/2/decisions`, `#/changes/migrate/${MG}`]);
      expect(p.all('.dcell .dacts button')).toHaveLength(0);
    });

    it('lists Migrate to with the replacement first, recommended and checked, then the listing, each priced on its card once asked for and asking in the dialog', async () => {
      // The menu places itself in the window.
      vi.stubGlobal('innerWidth', 1440);
      vi.stubGlobal('innerHeight', 900);
      const asked: string[] = [];
      const p = await report(MG, { client: { estimates: { ...estimates, migrateEstimate: (to: string) => (asked.push(to), Promise.resolve({ estimate: null, preview: null, scopes: [] })) } } as unknown as Partial<Client> });
      const menu = p.byText('.chbar button', 'Migrate to');
      expect(shown(menu)).toBe('Migrate to');
      await p.click(menu);
      await p.until('the menu', () => p.all('.fkm [role="menuitemradio"]').length === 3);
      expect(shown(p.one('.fkm .pk'))).toBe(`Migrate ${FROM} to…`);
      expect(p.all('.fkm [role="menuitemradio"]').map((x) => [shown(x.querySelector('b')), x.getAttribute('aria-checked'), !!x.querySelector('small')])).toEqual([
        [TO, 'true', true],
        ['claude-opus-5', 'false', false],
        ['gpt-5', 'false', false],
      ]);
      // No price is read as the menu opens: only the one whose card the pointer or the focus asks for.
      await new Promise((r) => setTimeout(r, 20));
      expect(asked).toEqual([]);
      await p.hover(p.all('.fkm [role="menuitemradio"]')[1]);
      await p.until('its price', () => asked.length === 1);
      await p.focus(p.all('.fkm [role="menuitemradio"]')[2]);
      await p.until('the next price', () => asked.length === 2);
      expect(asked).toEqual(['claude-opus-5', 'gpt-5']);
      expect(JSON.parse(p.all('.fkm [role="menuitemradio"]')[1].getAttribute('data-tip')!)).toMatchObject({ t: 'Migrate to claude-opus-5' });
      await p.click(p.all('.fkm [role="menuitemradio"]')[1]);
      await p.until('the dialog', () => p.all('.dialog').length === 1);
      expect(shown(p.one('.dialog h3'))).toBe(`Migrate ${FROM} to claude-opus-5`);
    });

    it('offers neither Migrate to nor Apply config change in an exported copy', async () => {
      const p = await report(MG, { app: { exported: true } });
      expect([p.all('.chbar button').filter((x) => shown(x).startsWith('Migrate to')).length, p.all('.mgverdict .actions button').length]).toEqual([0, 0]);
    });

    it('says so for an id that is no migration’s, a preview’s included, offering Migrate', async () => {
      for (const id of ['mg-01M50000000000000000000ZZZ', 'dc-01M5000000000000000000000Q']) {
        const preview = { ...sessions.get(MG)!, kind: 'decisions' };
        const p = await open(start, [MG], { id, client: { decisionSession: (x: string) => (x.startsWith('dc-') ? Promise.resolve(preview) : sessionOf(x)) } as unknown as Partial<Client> });
        await p.until('the line', () => !!p.one('.empty.tall'));
        expect([shown(p.one('.empty.tall')), p.one('.empty.tall a').getAttribute('href')]).toEqual([`No migration ${id}. Open Migrate`, '#/changes/migrate']);
        await p.unmount();
        page = null;
      }
    });
  });

  it('lists the palette’s Migrate <a> to <b> per retiring model with a replacement, its command as the hint, waiting while the tree is held', () => {
    const asked: string[] = [];
    const n = unchecked.retiring[0];
    const rows = migratePaletteRows([n, { ...n, model: 'claude-old-1', replacements: [] }], null, (m) => asked.push(m));
    expect(rows.map((r) => [r.group, r.label, r.hint, r.job, r.wait])).toEqual([['Actions', `Migrate ${FROM} to ${TO}`, `shadowlap migrate --to ${TO} goldens/refund goldens/lookup --from ${FROM}`, true, undefined]]);
    rows[0].run();
    expect(asked).toEqual([FROM]);
    const held = 'A repair holds the working tree';
    expect(migratePaletteRows([n], held, () => undefined).map((r) => [r.hint, r.wait])).toEqual([[held, held]]);
  });

  it('draws a pull request body’s code by what it holds: a tool call’s arguments as code shown as text, a command or a name as inline code, an arrow kept with the code before it', async () => {
    page = await render(createElement(Markdown, { text: 'Checked with `shadowlap migrate --to claude-sonnet-5-5`.\n\n- refund #2: issue_refund is no longer called (`issue_refund({"amount":240})` → `end_turn`)' }));
    expect(page.one('p code').className).toBe('ts-cb');
    expect(page.all('li code').map((c) => c.className)).toEqual(['ts-ct', 'ts-code']);
    expect(page.one('li').textContent).toContain('})\u00a0→ end_turn');
  });

  it('reads a pull request body’s quote, and links only to an http(s) address', () => {
    expect(parseMarkdown('> In 30 days.\n> Replaced by x ([source](https://example.com/d))')).toEqual([{ kind: 'quote', text: 'In 30 days. Replaced by x ([source](https://example.com/d))' }]);
    expect(inlineParts('see [the page](https://example.com/a) and `code`')).toEqual([
      { code: false, text: 'see ' },
      { code: false, text: 'the page', href: 'https://example.com/a' },
      { code: false, text: ' and ' },
      { code: true, text: 'code' },
    ]);
    expect(inlineParts('[x](javascript:alert(1))')).toEqual([{ code: false, text: '[x](javascript:alert(1))' }]);
  });
});
