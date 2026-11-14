import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectRegistry } from '@shadowlap/engine';
import type { MatchingSettings, ProjectSettings } from '../src/settings.js';
import { pageSig } from '../ui/focus.js';
import { SettingsPage } from '../ui/pages/Settings.js';
import { ruleScope } from '../ui/pages/settings/logic.js';
import { parseRoute } from '../ui/route.js';
import { AppContext, type AppState } from '../ui/state.js';
import { render, type Rendered } from './ui-render.js';

/**
 * Settings as one shell: CI at `#/settings/ci`, with `#/settings/alerts` and `#/settings/plan` kept
 * as typed and opening CI and Project; the header naming the project; the tabs as links under one
 * hairline; a rule's scope in words; Project's facts as code under the line that says what
 * Shadowlap is here.
 */

const g = globalThis as unknown as { location: unknown; history: unknown };
const saved = { location: g.location, history: g.history };

/** The address bar, as the router reads and rewrites it. */
function addressBar(hash: string): { hash: string } {
  const location = { hash, pathname: '/', search: '' };
  Object.assign(g, { location, history: { state: null, replaceState: (_s: unknown, _t: string, url: string) => (location.hash = url.slice(url.indexOf('#'))) } });
  return location;
}

const config = { file: 'shadowlap.config.json', path: '/work/research-agent/shadowlap.config.json', exists: true, version: 'v1', error: null };
const form = { kinds: ['api', 'tool'], patterns: ['email', 'uuid'], defaultReplace: '<REDACTED>' };

function matching(rules: MatchingSettings['rules'] = []): MatchingSettings {
  return { config, rules, form, clock: { mode: 'auto', explicit: false, error: null }, calibrate: { runId: 'R1', source: 'newest', command: 'shadowlap calibrate R1', argv: ['calibrate', 'R1'], recordings: [{ runId: 'R1' }] } } as unknown as MatchingSettings;
}

const project = {
  name: 'research-agent',
  store: { path: '/work/research-agent/.shadowlap/shadowlap.db', bytes: 2048, free: 0 },
  shown: { store: '~/research-agent/.shadowlap/shadowlap.db' },
  runs: 12,
  attempts: 0,
  running: 0,
  abandoned: 0,
  address: '127.0.0.1:4777',
  cleanup: { olderThanDays: 30 },
} as unknown as ProjectSettings;

function app(o: { matching?: MatchingSettings; version?: string | null; warnings?: string[] } = {}): AppState {
  const never = () => new Promise<never>(() => undefined);
  const settings = { matching: async () => o.matching ?? matching(), project: async () => project, redaction: never, codingAgents: never, tools: never, store: never, spending: never };
  // The project list, with what the server ignored of this machine's settings; none from a server that serves one store.
  const projects = { list: async () => (o.warnings ? { items: [], notice: null, warnings: o.warnings } : null) };
  return {
    client: { settings, projects, startJob: async () => ({}), storeSetup: { view: never }, teamStore: async () => null, jobs: async () => [], ciWorkflows: never },
    meta: { version: 'version' in o ? o.version : '0.1.0', project: { id: 'research-agent', name: 'research-agent', path: '/work/research-agent' } },
    runs: [],
    feeds: {},
    jobs: [],
    actionsOff: null,
    hasKind: () => true,
    guard: (fn: () => void) => fn(),
    watchJob: () => undefined,
    toast: () => undefined,
  } as unknown as AppState;
}

const page = (tab: string | null, value: AppState = app()) => render(createElement(AppContext.Provider, { value }, createElement(SettingsPage, { tab })));

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
  Object.assign(g, saved);
});

describe('Settings’ addresses', () => {
  it('keeps an older name as typed and opens its tab: alerts opens CI, plan opens Project', async () => {
    for (const [typed, shown] of [
      ['alerts', 'CI'],
      ['plan', 'Project'],
      ['ci', 'CI'],
    ] as const) {
      const bar = addressBar(`#/settings/${typed}`);
      r = await page(typed);
      await r.wait(0);
      expect(r.one('.stabs a[aria-current="page"]').textContent).toBe(shown);
      expect(bar.hash).toBe(`#/settings/${typed}`);
      await r.unmount();
      r = null;
    }
  });

  it('puts Matching’s own address in place of a bare #/settings and of a tab that isn’t one', async () => {
    for (const [hash, tab] of [
      ['#/settings', null],
      ['#/settings/members', 'members'],
    ] as const) {
      const bar = addressBar(hash);
      r = await page(tab);
      await r.until('Matching’s address', () => bar.hash === '#/settings/matching');
      expect(r.one('.stabs a[aria-current="page"]').textContent).toBe('Matching');
      await r.unmount();
      r = null;
    }
  });

  it('counts an older name and the tab’s own key as one page to the focus', () => {
    expect(pageSig(parseRoute('#/settings/alerts'))).toBe(pageSig(parseRoute('#/settings/ci')));
    expect(pageSig(parseRoute('#/settings/plan'))).toBe(pageSig(parseRoute('#/settings/project')));
    expect(pageSig(parseRoute('#/settings'))).toBe(pageSig(parseRoute('#/settings/matching')));
    expect(pageSig(parseRoute('#/settings/ci'))).not.toBe(pageSig(parseRoute('#/settings/project')));
  });
});

describe('Settings’ shell', () => {
  it('heads the page with the project, keeps its tabs as links, and draws one hairline under them', async () => {
    addressBar('#/settings/matching');
    r = await page('matching');
    await r.until('Matching', () => r!.all('.settab section').length > 0);
    expect(r.one('.ph .eyebrow').textContent).toBe('research-agent · project settings');
    expect(r.one('.ph h1').textContent).toBe('Settings');
    expect(r.one('.ph p').textContent.replace(/\u00a0/g, ' ')).toBe('How this project records, replays and shares.');
    // Links, as an address each, never the tabs pattern: eight, the one shown marked as the page.
    expect(r.all('nav.stabs a').map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Matching', '#/settings/matching'],
      ['Redaction', '#/settings/redaction'],
      ['CI', '#/settings/ci'],
      ['Gates', '#/settings/gates'],
      ['Coding agents', '#/settings/agents'],
      ['Tools', '#/settings/tools'],
      ['Project', '#/settings/project'],
      ['Store', '#/settings/store'],
    ]);
    expect(r.all('[role="tab"], [role="tablist"]')).toHaveLength(0);
    // Its sections are Sections: no box, the first one's line the tabs' own.
    const first = r.one('.settab').children[0];
    expect([first.tagName.toLowerCase(), first.className]).toEqual(['section', 'panel sec set']);
    expect(r.one('.settab section h2').textContent).toBe('Matching');
  });

  it('names a setting’s control by its row’s label and describes it by its line', async () => {
    addressBar('#/settings/matching');
    r = await page('matching');
    await r.until('Matching', () => r!.all('.settab .seg').length > 0);
    const seg = r.one('.settab .seg');
    expect([seg.getAttribute('aria-label'), seg.getAttribute('aria-labelledby'), seg.getAttribute('aria-describedby')]).toEqual([null, 'clock-name', 'clock-help']);
    expect(r.one('#clock-name').textContent).toBe('Dates and times');
    expect(r.byText('.settab .setrow .btn', 'Calibrate').getAttribute('aria-describedby')).toBe('calibrate-help');
  });

  it('says every rule’s scope in words, a call’s name as code, and a missing path or pattern in words', async () => {
    const rules = [
      { n: 1, rule: { kind: 'tool', name: 'send_email', path: 'body.id', pattern: 'uuid', replace: '<UUID>' }, scope: 'tool · send_email', path: 'body.id', pattern: 'uuid', patternType: 'named', replace: '<UUID>', error: null, remove: [] },
      { n: 2, rule: { replace: '<X>' }, scope: 'every call', path: null, pattern: null, patternType: 'whole', replace: '<X>', error: null, remove: [] },
      { n: 3, rule: { kind: 'api', pattern: '/req_[a-z0-9]+/', replace: '<REQ>' }, scope: 'api', path: null, pattern: '/req_[a-z0-9]+/', patternType: 'regex', replace: '<REQ>', error: null, remove: [] },
    ] as unknown as MatchingSettings['rules'];
    addressBar('#/settings/matching');
    r = await page('matching', app({ matching: matching(rules) }));
    await r.until('the rules', () => r!.all('table.ruletable tbody tr').length === 3);
    const cells = r.all('table.ruletable tbody tr').map((tr) => tr.querySelectorAll('td').slice(0, 3).map((td) => td.textContent));
    expect(cells).toEqual([
      ['tool calls to send_email', 'body.id', 'uuid'],
      ['every call', 'any string', 'the whole value'],
      ['API calls', 'any string', '/req_[a-z0-9]+/'],
    ]);
    expect(r.all('table.ruletable td .rscope code').map((c) => c.textContent)).toEqual(['send_email']);
    expect(r.all('table.ruletable code.rx')).toHaveLength(1);
  });
});

describe('a rule’s scope', () => {
  it('reads every kind alike, a name after “to”, and a name with no kind as calls to it', () => {
    expect(ruleScope({})).toEqual({ words: 'every call', name: null });
    expect(ruleScope({ kind: 'api' })).toEqual({ words: 'API calls', name: null });
    expect(ruleScope({ kind: 'tool', name: 'send_email' })).toEqual({ words: 'tool calls', name: 'send_email' });
    expect(ruleScope({ kind: 'clock' })).toEqual({ words: 'clock calls', name: null });
    expect(ruleScope({ kind: 'random' })).toEqual({ words: 'random calls', name: null });
    expect(ruleScope({ name: 'lookup' })).toEqual({ words: 'calls', name: 'lookup' });
  });
});

describe('Settings → Project', () => {
  it('names Shadowlap first, then the project’s facts with what is data as code, and every count of attempts', async () => {
    addressBar('#/settings/project');
    r = await page('project');
    await r.until('Project', () => r!.all('.settab dl.kvs dt').length > 0);
    const dl = r.one('.settab dl.kvs');
    expect(dl.querySelectorAll('dt').map((d) => d.textContent)).toEqual(['Shadowlap', 'Name', 'Store', 'Runs', 'Size', 'Dashboard']);
    const dd = dl.querySelectorAll('dd');
    expect(dd[0].textContent.replace(/\u00a0/g, ' ')).toBe('0.1.0 · open source, Apache-2.0 · no account, no limits on runs');
    expect(dd.slice(1, 3).map((d) => d.querySelector('code')?.textContent)).toEqual(['research-agent', '~/research-agent/.shadowlap/shadowlap.db']);
    expect(dd[3].textContent.replace(/\u00a0/g, ' ')).toBe('12 and 0 attempts');
    expect(dd[5].querySelector('code')?.textContent).toBe('127.0.0.1:4777');
    // Clean up old runs says what it does on its card: what it would free first, then it asks.
    const clean = r.byText('.settab .setfoot .btn', 'Clean up old runs');
    expect(JSON.parse(clean.getAttribute('data-tip')!)).toMatchObject({ t: 'Clean up old runs', s: 'Shows what it would free, then asks before deleting', cmd: '$ shadowlap gc --older-than 30 --dry-run' });
  });

  it('says what the server ignored of this machine’s settings, and why, under This machine', async () => {
    // A relative SHADOWLAP_HOME, as the project list's registry words it.
    const { warnings } = new ProjectRegistry({ env: { SHADOWLAP_HOME: 'shadowlap-home' }, home: '/home/example' });
    expect(warnings).toHaveLength(1);
    addressBar('#/settings/project');
    r = await page('project', app({ warnings }));
    await r.until('This machine', () => r!.all('.settab dl.kvs dt').length === 7);
    expect(r.all('.settab dl.kvs dt').at(-1)!.textContent).toBe('This machine');
    expect(r.all('.settab dl.kvs dd.setwarn .ln').map((l) => l.textContent)).toEqual(warnings);
  });

  it('says what Shadowlap is here without a version when the dashboard has none', async () => {
    addressBar('#/settings/project');
    r = await page('project', app({ version: null }));
    await r.until('Project', () => r!.all('.settab dl.kvs dd').length > 0);
    expect(r.all('.settab dl.kvs dd')[0].textContent.replace(/\u00a0/g, ' ')).toBe('open source, Apache-2.0 · no account, no limits on runs');
  });
});
