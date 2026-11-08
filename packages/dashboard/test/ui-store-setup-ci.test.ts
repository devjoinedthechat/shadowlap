import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PushFromCiStep } from '../ui/pages/settings/StoreSetupCi.js';
import type { SetupStepState } from '../ui/pages/settings/store-logic.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { StoreSetupView } from '../ui/store-api.js';
import { render, type Rendered } from './ui-render.js';

/**
 * The store's setup, step 3, as the design has it on GitHub Actions: Turn on Push from CI or Skip
 * for now, each recorded with the setup and written to the config (`ciPush`), then a line saying
 * where the workflow is written; GitLab CI keeps its step to paste and I added it.
 */

const steps = [
  { ci: 'github', name: 'GitHub Actions', file: '.github/workflows/agent.yml', text: '', oidc: true, notes: [], command: 'shadowlap store ci --provider github', workflow: { href: '#/settings/ci', credentials: null, printed: null } },
  { ci: 'gitlab', name: 'GitLab CI', file: '.gitlab-ci.yml', text: 'goldens:\n  script: npx shadowlap test goldens/* --push', oidc: true, notes: [], command: 'shadowlap store ci --provider gitlab', workflow: null },
] as const;

const viewOf = (ci: 'added' | 'skipped' | null, ciProvider: 'github' | 'gitlab' | null = null) => ({ setup: { startedAt: 1, ci, ciProvider, finishedAt: null }, ci: steps }) as unknown as StoreSetupView;
const app = { actionsOff: null, conn: 'ok', exported: false, toast: () => undefined } as unknown as AppState;

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
});

function show(view: StoreSetupView, state: SetupStepState, ci: 'github' | 'gitlab', save = vi.fn()) {
  const step = view.ci!.find((x) => x.ci === ci) ?? null;
  return render(createElement(AppContext.Provider, { value: app }, createElement(PushFromCiStep, { view, state, ci, setCi: () => undefined, step, saving: false, off: null, save, copy: () => undefined })));
}

describe('the store’s setup, step 3', () => {
  it('asks two things on GitHub, each written to the config as Push from CI', async () => {
    const save = vi.fn();
    r = await show(viewOf(null), 'cur', 'github', save);
    expect(r.one('p').textContent).toBe('CI pushes every test run, its report and each fix it opens, so the store covers every pull request. Your workflow on Settings → CI adds the push step, and CI needs its own access to the bucket, with short-lived credentials where your CI allows it.');
    expect(r.all('.actions button').map((b) => [b.textContent, b.getAttribute('class')])).toEqual([
      ['Turn on Push from CI', 'btn lime'],
      ['Skip for now', 'btn quiet'],
    ]);
    expect(r.all('pre.codebox')).toHaveLength(0);
    await r.click(r.byText('.actions button', 'Turn on Push from CI'));
    expect(save).toHaveBeenLastCalledWith({ ci: 'added', ciProvider: 'github', ciPush: true }, 'Push from CI is on · Your workflow changes with it');
    await r.click(r.byText('.actions button', 'Skip for now'));
    expect(save).toHaveBeenLastCalledWith({ ci: 'skipped', ciProvider: 'github', ciPush: false }, 'Skipped for now · Push from CI is off');
  });

  it('says where the workflow is written once on, and where the switch is once skipped', async () => {
    r = await show(viewOf('added', 'github'), 'done', 'github');
    expect(r.one('p').textContent).toBe('Push from CI is on: Your workflow on Settings → CI pushes every test run, its report and each fix it opens, so the store covers every pull request. Write the workflow →');
    expect(r.one('p a.more').getAttribute('href')).toBe('#/settings/ci');
    await r.unmount();
    r = await show(viewOf('skipped', 'github'), 'done', 'github');
    expect(r.one('p').textContent).toBe('Skipped. Turn on Push from CI any time on Settings → Store.');
  });

  it('keeps GitLab CI’s step to paste, with Copy, I added it and Skip for now', async () => {
    const save = vi.fn();
    r = await show(viewOf(null), 'cur', 'gitlab', save);
    expect(r.one('pre.codebox').textContent).toBe(steps[1].text);
    expect(r.all('.actions button').map((b) => b.textContent)).toEqual(['Copy', 'I added it', 'Skip for now']);
    await r.click(r.byText('.actions button', 'I added it'));
    expect(save).toHaveBeenLastCalledWith({ ci: 'added', ciProvider: 'gitlab' }, 'Push from CI added');
    await r.unmount();
    r = await show(viewOf('skipped', 'gitlab'), 'done', 'gitlab');
    expect(r.one('p').textContent).toBe('Skipped. Add it any time; the step is in Settings → Store.');
  });
});
