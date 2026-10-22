import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ciWorkflows, CI_DEFAULTS, type CiWorkflowOptions } from '../src/ci-workflows.js';
import type { Client } from '../ui/api.js';
import { SettingsPage } from '../ui/pages/Settings.js';
import { AppContext, type AppState } from '../ui/state.js';
import { render, type Rendered } from './ui-render.js';

/**
 * Settings → CI as the page renders the server's answer: the steps as a job of their own runs them,
 * the failures a golden counts, an inconclusive one in amber, and the Inconclusive goldens control,
 * which asks the server again with the choice.
 */

const goldens = [
  { path: 'goldens/refund-flow-budget', live: ['fork' as const], keys: ['ANTHROPIC_API_KEY'] },
  { path: 'goldens/refund-over-limit', live: ['fork' as const], keys: ['ANTHROPIC_API_KEY'] },
];

function app(ciWorkflowsCall: (o?: Partial<CiWorkflowOptions>) => Promise<unknown>): AppState {
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
    toast: () => undefined,
    registerLayer: () => () => undefined,
  } as unknown as AppState;
}

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
});

describe('Settings → CI', () => {
  it('lists what fails a golden, the injection gate too, and an inconclusive one in amber', async () => {
    const ask = vi.fn(async (o: Partial<CiWorkflowOptions> = {}) => ciWorkflows({ ...CI_DEFAULTS, ...o }, { preview: null, failing: 0, at: null, repository: null, branch: null, goldens }));
    r = await render(createElement(AppContext.Provider, { value: app(ask as unknown as Client['ciWorkflows']) }, createElement(SettingsPage, { tab: 'alerts' })));
    await r.until('the panels', () => r!.all('#alerts .cilist').length > 1);
    const fails = r.all('#alerts .teamside .cilist li');
    expect(fails.map((li) => li.querySelector('code')?.textContent)).toEqual(['diverged', 'live call', 'exit ≠ 0', 'check failed', 'injection', 'inconclusive']);
    expect(fails.map((li) => li.querySelector('i')?.getAttribute('class'))).toEqual(['err', 'err', 'err', 'err', 'err', 'warn']);
    // The two fork goldens' key, in the needs and in the test step's env.
    expect(r.all('#alerts .cimain .cilist li').map((li) => li.textContent)).toContain('2 goldens run live (fork)ANTHROPIC_API_KEY');
    expect(r.all('#alerts .codebox')[0]!.textContent).toContain('  env:\n    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}');
    // Fix on failure as a job of its own: its branch, then Node 22, before the action.
    expect(r.all('.cip .codebox')[0]!.textContent).toContain('- uses: actions/checkout@v7\n  with:\n    ref: ${{ github.head_ref || github.ref }}\n- uses: actions/setup-node@v7\n');
  });

  it('asks the server again when Inconclusive goldens is set to warn, which takes the row away and adds the input', async () => {
    const ask = vi.fn(async (o: Partial<CiWorkflowOptions> = {}) => ciWorkflows({ ...CI_DEFAULTS, ...o }, { preview: null, failing: 0, at: null, repository: null, branch: null }));
    r = await render(createElement(AppContext.Provider, { value: app(ask as unknown as Client['ciWorkflows']) }, createElement(SettingsPage, { tab: 'alerts' })));
    await r.until('the panels', () => r!.all('#alerts .cilist').length > 1);
    const seg = r.one('#alerts .seg[aria-label="Inconclusive goldens"]');
    expect(seg.querySelectorAll('button').map((b) => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([
      ['Fail', 'true'],
      ['Warn', 'false'],
    ]);
    await r.click(r.byText('#alerts .seg[aria-label="Inconclusive goldens"] button', 'Warn'));
    await r.until('the answer for warn', () => r!.all('#alerts .teamside .cilist li').length === 5);
    expect(ask).toHaveBeenLastCalledWith(expect.objectContaining({ inconclusive: 'warn' }));
    expect(r.all('#alerts .codebox')[0]!.textContent).toContain('    inconclusive: warn\n');
    expect(r.byText('#alerts .seg[aria-label="Inconclusive goldens"] button', 'Warn').getAttribute('aria-pressed')).toBe('true');
  });
});
