import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ciWorkflows, CI_DEFAULTS, type CiWorkflowOptions } from '../src/ci-workflows.js';
import type { Client } from '../ui/api.js';
import { SettingsPage } from '../ui/pages/Settings.js';
import { AppContext, type AppState } from '../ui/state.js';
import { render, type Rendered } from './ui-render.js';

/**
 * Settings → CI as the page renders the server's answer: the steps as a job of their own runs them,
 * the failures a golden counts, an inconclusive one in amber, the design's An inconclusive golden
 * control, which asks the server again with the choice, the keys a row lists, each kept whole, and a
 * config that can't be read.
 */

const goldens = [
  { path: 'goldens/refund-flow-budget', live: ['fork' as const], keys: ['ANTHROPIC_API_KEY'], known: true },
  { path: 'goldens/refund-over-limit', live: ['fork' as const], keys: ['ANTHROPIC_API_KEY'], known: true },
];

function app(ciWorkflowsCall: (o?: Partial<CiWorkflowOptions>) => Promise<unknown>, toast: AppState['toast'] = () => undefined): AppState {
  const client = { ciWorkflows: ciWorkflowsCall, teamStore: async () => null, jobs: async () => [], storeSetup: { view: async () => null } };
  return {
    client,
    meta: { project: { id: 'support-agent', name: 'support-agent', path: '/work/support-agent' } },
    runs: [],
    feeds: {},
    jobs: [],
    actionsOff: null,
    hasKind: () => true,
    guard: (fn: () => void) => fn(),
    watchJob: () => undefined,
    toast,
    registerLayer: () => () => undefined,
  } as unknown as AppState;
}

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
});

describe('Settings → CI', () => {
  it('writes one workflow from its switches: the action once, then a fix pull request and Slack where they are on', async () => {
    const ask = vi.fn(async (o: Partial<CiWorkflowOptions> = {}) => ciWorkflows({ ...CI_DEFAULTS, ...o }, { preview: null, failing: 0, at: null, repository: null, branch: null, goldens }));
    const toast = vi.fn();
    r = await render(createElement(AppContext.Provider, { value: app(ask as unknown as Client['ciWorkflows'], toast) }, createElement(SettingsPage, { tab: 'alerts' })));
    await r.until('the panels', () => r!.all('#workflow .cilist').length > 1);
    // One code block on the tab: your workflow, Slack on and no fix by default.
    expect(r.all('.settab .codebox')).toHaveLength(1);
    const code = () => r!.one('#workflow .codebox').textContent;
    // Checked out without the job's token left in .git/config, which the agent's steps could read.
    expect(code()).toContain('- uses: actions/checkout@v7\n  with:\n    persist-credentials: false\n- uses: actions/setup-node@v7\n');
    expect(code()).toContain('  id: goldens\n  with:\n    version: 0.1.0\n    recordings: goldens/*\n    fail-on-divergence: false\n');
    expect(code()).toContain('- name: Tell Slack');
    expect(r.one('#fix-on-failure').className).toBe('panel set cip off');
    expect(r.one('#alerts').className).toBe('panel set cip');
    const fix = r.one('#workflow .switch[aria-label="Fix pull requests"]');
    expect(fix.getAttribute('aria-checked')).toBe('false');
    await r.click(fix);
    await r.until('the workflow with the fix', () => code().includes('fix-on-failure: true'));
    expect(ask).toHaveBeenLastCalledWith(expect.objectContaining({ fix: true }));
    expect(toast).toHaveBeenCalledWith('Fix pull requests are on · your workflow has the step');
    // The action still runs once: the fix's branch checked out, its inputs beside fail-on-divergence.
    expect(code().match(/- uses: devjoinedthechat\/shadowlap@/g)).toHaveLength(1);
    // A fork's pull request has no branch here: its job checks out the merge ref, as without the fix.
    expect(code()).toContain('- uses: actions/checkout@v7\n  with:\n    ref: ${{ github.event.pull_request.head.repo.full_name == github.repository && github.head_ref || github.ref }}\n    persist-credentials: false\n');
    expect(r.one('#fix-on-failure').className).toBe('panel set cip');
    await r.click(r.one('#workflow .switch[aria-label="Tell Slack"]'));
    await r.until('the workflow without Slack', () => !code().includes('Tell Slack'));
    expect(code()).not.toContain('fail-on-divergence');
    expect(r.one('#alerts').className).toBe('panel set cip off');
    // What was switched is kept while the dashboard is open: back as it was, for the tests after this one.
    await r.click(r.one('#workflow .switch[aria-label="Tell Slack"]'));
    await r.click(r.one('#workflow .switch[aria-label="Fix pull requests"]'));
    await r.until('the workflow as it was', () => code().includes('Tell Slack') && !code().includes('fix-on-failure'));
  });

  it('lists what fails a golden, the injection gate too, and an inconclusive one in amber, with the keys the goldens that run live need', async () => {
    const ask = vi.fn(async (o: Partial<CiWorkflowOptions> = {}) => ciWorkflows({ ...CI_DEFAULTS, ...o }, { preview: null, failing: 0, at: null, repository: null, branch: null, goldens }));
    r = await render(createElement(AppContext.Provider, { value: app(ask as unknown as Client['ciWorkflows']) }, createElement(SettingsPage, { tab: 'alerts' })));
    await r.until('the panels', () => r!.all('#workflow .cilist').length > 1);
    const fails = r.all('#workflow .teamside .cilist li');
    expect(fails.map((li) => li.querySelector('code')?.textContent)).toEqual(['diverged', 'live call', 'exit ≠ 0', 'check failed', 'injection', 'inconclusive']);
    expect(fails.map((li) => li.querySelector('i')?.getAttribute('class'))).toEqual(['err', 'err', 'err', 'err', 'err', 'warn']);
    // The two fork goldens' key, in the needs and in the test step's env.
    expect(r.all('#workflow .cimain .cilist li').map((li) => li.textContent)).toContain('2 goldens run live (fork)ANTHROPIC_API_KEY');
    expect(r.one('#workflow .codebox').textContent).toContain('  env:\n    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}');
  });

  it('asks the server again when An inconclusive golden is set to Warns, in the design’s words, which takes the row away and adds the input to the step', async () => {
    const ask = vi.fn(async (o: Partial<CiWorkflowOptions> = {}) => ciWorkflows({ ...CI_DEFAULTS, ...o }, { preview: null, failing: 0, at: null, repository: null, branch: null }));
    const toast = vi.fn();
    r = await render(createElement(AppContext.Provider, { value: app(ask as unknown as Client['ciWorkflows'], toast) }, createElement(SettingsPage, { tab: 'alerts' })));
    await r.until('the panels', () => r!.all('#workflow .cilist').length > 1);
    const row = () => r!.all('#workflow .setrow').find((x) => x.querySelector('b')?.textContent === 'An inconclusive golden')!;
    expect(row().querySelector('span')!.textContent).toBe('Fails the step, as a failed one does. Run more attempts can settle it.');
    const seg = r.one('#workflow .seg[aria-label="An inconclusive golden in CI"]');
    expect(seg.querySelectorAll('button').map((b) => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([
      ['Fails', 'true'],
      ['Warns', 'false'],
    ]);
    await r.click(r.byText('#workflow .seg[aria-label="An inconclusive golden in CI"] button', 'Warns'));
    await r.until('the answer for warn', () => r!.all('#workflow .teamside .cilist li').length === 5);
    expect(ask).toHaveBeenLastCalledWith(expect.objectContaining({ inconclusive: 'warn' }));
    expect(toast).toHaveBeenCalledWith('An inconclusive golden warns · the step says inconclusive: warn');
    expect(r.one('#workflow .codebox').textContent).toContain('    inconclusive: warn\n');
    expect(row().querySelector('span')!.textContent).toBe('Lets the step pass with a warning: inconclusive: warn. Every report still says inconclusive.');
    expect(row().querySelector('span code')!.textContent).toBe('inconclusive: warn');
    expect(r.byText('#workflow .seg[aria-label="An inconclusive golden in CI"] button', 'Warns').getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps each key of a long list whole, breaking only after a comma', async () => {
    const many = [{ path: 'goldens/a', live: [], keys: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'], known: true }];
    const ask = vi.fn(async (o: Partial<CiWorkflowOptions> = {}) => ciWorkflows({ ...CI_DEFAULTS, ...o }, { preview: null, failing: 0, at: null, repository: null, branch: null, goldens: many }));
    r = await render(createElement(AppContext.Provider, { value: app(ask as unknown as Client['ciWorkflows']) }, createElement(SettingsPage, { tab: 'alerts' })));
    await r.until('the panels', () => r!.all('#workflow .cilist').length > 1);
    // Every golden's keys are what a fix pull request needs: blame and verify run the agent live.
    await r.click(r.one('#workflow .switch[aria-label="Fix pull requests"]'));
    const row = () => r!.all('#workflow .cimain .cilist li').find((li) => li.textContent.startsWith('your agent’s provider keys'));
    await r.until('the keys a fix needs', () => !!row());
    const code = row()!.querySelector('code')!;
    expect(code.textContent).toBe('ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY');
    expect(code.querySelectorAll('span.nw').map((x) => x.textContent)).toEqual(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']);
    await r.click(r.one('#workflow .switch[aria-label="Fix pull requests"]'));
    await r.until('no fix again', () => !row());
  });

  it('says the config can’t be read, as the other tabs do, and what the workflow leaves out', async () => {
    const configError = 'shadowlap.config.json: not valid JSON (Unexpected end of JSON input)';
    const ask = vi.fn(async (o: Partial<CiWorkflowOptions> = {}) => ciWorkflows({ ...CI_DEFAULTS, ...o }, { preview: null, failing: 0, at: null, repository: null, branch: null, goldens: [], configError }));
    r = await render(createElement(AppContext.Provider, { value: app(ask as unknown as Client['ciWorkflows']) }, createElement(SettingsPage, { tab: 'alerts' })));
    await r.until('the panels', () => r!.all('#workflow .cilist').length > 1);
    expect(r.one('.settab .verdict h2').textContent).toBe('Fix shadowlap.config.json to change these settings');
    expect(r.one('.settab .verdict p').textContent).toContain('not valid JSON');
    const unread = r.all('#workflow .cimain .cilist li').find((li) => li.textContent.startsWith('which goldens run live'))!;
    expect(unread.querySelector('i')!.getAttribute('class')).toBe('warn');
    expect(r.one('#workflow .codebox').textContent).toContain("#   shadowlap.config.json can't be read: the keys of the goldens that run live are left out");
    expect(r.one('.cistore span').textContent).toBe('shadowlap.config.json can’t be read, so whether fixes go to a team store isn’t known until it is fixed.');
  });
});
