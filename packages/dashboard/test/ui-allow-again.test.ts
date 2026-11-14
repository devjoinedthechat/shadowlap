import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunRecord } from '@shadowlap/engine';
import { unrecordedRefusal } from '../../cli/src/unrecorded.js';
import { ApiError } from '../ui/api.js';
import { AllowAgain, allowedCommand } from '../ui/allow-again.js';
import { jobStatus, unrecordedAllow } from '../ui/jobs.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { JobView } from '../ui/types.js';
import { render, type Rendered } from './ui-render.js';

/**
 * A job the CLI refused because its run's model called a tool Shadowlap never recorded that writes,
 * or may: its drawer offers Run again, allowing the tools the CLI named in the flag it suggested,
 * which asks first, saying a write acts on your systems, then starts the same job again with them
 * allowed, answering the yes its kind asks in place.
 */

const RUN = '01K0UNKNOWN0000000000000000';
const run = { runId: RUN, meta: {} } as unknown as RunRecord;
const tool = (name: string, effect: 'write' | 'unknown') => ({ name, count: 2, firstCallNo: 3, effect, why: effect === 'write' ? 'a Claude Code built-in that runs a command' : 'its name says nothing of what it does', fix: 'wrap' as const });
/** The CLI's refusal of a replay, as its job's lines hold it (usageError's `shadowlap: ` first). */
const refusal = (tools: ReturnType<typeof tool>[]) => `shadowlap: ${unrecordedRefusal(run, tools, new Set(), ['shadowlap', 'replay', RUN])!}`.split('\n');
const replayed = (o: Partial<JobView> = {}): JobView => ({ id: 'j1', kind: 'action', title: 'Replaying', args: ['replay', RUN], done: true, code: 2, stopped: false, lines: [], ...o }) as unknown as JobView;

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
});

describe('a job the CLI refused for tools its run never recorded', () => {
  it('names the tools the CLI’s refusal lets run, from the flag it suggests, a test session’s too, and none where it suggests no flag', () => {
    expect(unrecordedAllow(refusal([tool('Bash', 'write'), tool('frobnicate', 'unknown')]))).toEqual(['Bash', 'frobnicate']);
    // `shadowlap test`'s refusal ends on the flag alone (cli unrecorded-goldens.ts, as unrecorded-tools.test.ts pins it).
    expect(unrecordedAllow(['shadowlap: a golden holds model calls of a tool Shadowlap never recorded, which writes: a replay would run it again for real, so no golden was run.', '  Or let the test run it: --allow-unrecorded Bash'])).toEqual(['Bash']);
    // A command that takes no flag gets no suggestion: nothing to allow from here.
    expect(unrecordedAllow(`shadowlap: ${unrecordedRefusal(run, [tool('Bash', 'write')], new Set(), null)!}`.split('\n'))).toBeNull();
    expect(unrecordedAllow(['✓ reproduced'])).toBeNull();
    expect(jobStatus(replayed(), refusal([tool('Bash', 'write')]))).toEqual({ text: 'refused · an unrecorded tool writes · exit 2', tone: 'err' });
    expect(allowedCommand(['replay', RUN, '--', 'node', 'agent.mjs'], ['Bash'])).toBe(`shadowlap replay ${RUN} --allow-unrecorded Bash -- node agent.mjs`);
  });

  it('offers Run again, allowing them, which asks first, warns that a write acts on your systems, and runs the same job again', async () => {
    const sent: Array<[string, Record<string, unknown>]> = [];
    const watched: JobView[] = [];
    let ask = true;
    const app = {
      client: {
        jobAgain: async (id: string, fields: Record<string, unknown>) => {
          sent.push([id, fields]);
          // A command someone else recorded asks its yes first, as the job's kind asks it.
          if (ask && fields.yes === undefined) throw new ApiError(409, 'This run was recorded on another machine: confirm its command', 'yes-1');
          return replayed({ id: 'j2', done: false, code: null });
        },
      },
      actionsOff: null,
      hasKind: () => true,
      guard: (fn: () => void) => (fn(), true),
      watchJob: (p: Promise<JobView>) => void p.then((j) => watched.push(j)),
      toast: () => undefined,
    } as unknown as AppState;
    r = await render(createElement(AppContext.Provider, { value: app }, createElement(AllowAgain, { job: replayed(), lines: refusal([tool('Bash', 'write')]) })));
    const button = r.one('button');
    expect([button.textContent, button.hasAttribute('data-way')]).toEqual(['Run again, allowing Bash', true]);
    await r.click(button);
    expect(r.one('.dialog h3').textContent.replace(/\u00a0/g, ' ')).toBe('Run again, allowing Bash?');
    expect(r.one('.dialog .dwarn').textContent.replace(/\u00a0/g, ' ')).toBe('A tool that writes acts on your systems for real: allowed, Bash runs again, and nothing undoes what it does.');
    expect(r.one('.dialog .cmdline').textContent).toBe(`$shadowlap replay ${RUN} --allow-unrecorded Bash`);
    await r.click(r.byText('.dialog button', 'Run again'));
    await r.until('the yes it asks', () => r!.all('.dialog').length === 1 && /another machine/.test(r!.one('.dialog').textContent));
    ask = false;
    await r.click(r.byText('.dialog button', 'Run again'));
    await r.until('the job again', () => watched.length === 1);
    expect(sent).toEqual([
      ['j1', { allowUnrecorded: ['Bash'] }],
      ['j1', { allowUnrecorded: ['Bash'], yes: 'yes-1' }],
    ]);
  });

  it('offers nothing for a job that ended well, was stopped, or whose kind the server doesn’t run', async () => {
    const app = { client: { jobAgain: async () => replayed() }, actionsOff: null, hasKind: (k: string) => k !== 'blame', guard: (fn: () => void) => (fn(), true), watchJob: () => undefined, toast: () => undefined } as unknown as AppState;
    const lines = refusal([tool('Bash', 'write')]);
    for (const job of [replayed({ code: 0 }), replayed({ stopped: true }), replayed({ kind: 'blame' })]) {
      r = await render(createElement(AppContext.Provider, { value: app }, createElement(AllowAgain, { job, lines })));
      expect(r.all('button')).toHaveLength(0);
      await r.unmount();
      r = null;
    }
  });
});
