import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError, type CallDetail, type CallRow, type JobView } from '../ui/api.js';
import { EDIT_LIMIT, EditAndFork, editBody, editStart } from '../ui/run/EditAndFork.js';
import { Inspector } from '../ui/run/Inspector.js';
import { AppContext, type AppState } from '../ui/state.js';
import { render, type Rendered } from './ui-render.js';

/**
 * Edit and fork, from the inspector: a tool's recorded result, or what a person answered, opens to
 * edit as JSON or as text; what isn't JSON can't be sent; and Fork uploads it and starts the fork,
 * whose command the server builds. A model call has nothing to edit: --override doesn't change one.
 */

const RUN = '01M5GRX8K406H4KHQ7DEKYWTSZ';

function detail(o: { callNo?: number; kind?: 'tool' | 'api'; name?: string; key?: 'o' | 'u' | null; disabled?: string | null; result?: unknown; label?: string } = {}): CallDetail {
  const key = o.key === undefined ? 'o' : o.key;
  return {
    call: { callNo: o.callNo ?? 16, kind: o.kind ?? 'tool', name: o.name ?? 'lookup_policy', origin: 'live', outcome: 'ok' },
    result: { result: o.result === undefined ? { region: 'EU', limit: 100 } : o.result },
    actions: key ? [{ key, label: 'Override this tool’s result', opensRun: true, disabled: o.disabled ?? null, group: 'call', prompt: { label: o.label ?? 'Result for #16 lookup_policy, as JSON:' } }] : [{ key: 'i', label: 'Inject an instruction', opensRun: true, disabled: null, group: 'call', prompt: { label: 'Instruction:' } }],
  } as unknown as CallDetail;
}

interface Sent {
  uploads: Array<{ name: string; text: string }>;
  jobs: Array<{ kind: string; fields: Record<string, unknown> }>;
}

function app(sent: Sent, over: Partial<AppState> = {}): AppState {
  return {
    exported: false,
    actionsOff: null,
    hasKind: (k: string) => k === 'override',
    guard: (fn: () => void) => fn(),
    watchJob: (p: Promise<JobView>) => void p,
    client: {
      upload: async (file: Blob, name: string) => {
        sent.uploads.push({ name, text: await file.text() });
        return { uploadId: '01M5UPLOAD0000000000000000', name, bytes: file.size };
      },
      startJob: async (kind: string, fields: Record<string, unknown>) => {
        sent.jobs.push({ kind, fields });
        return { id: 'j1' } as JobView;
      },
    },
    ...over,
  } as unknown as AppState;
}

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
});

const open = async (d: CallDetail, sent: Sent, over: Partial<AppState> = {}) => {
  r = await render(createElement(AppContext.Provider, { value: app(sent, over) }, createElement('main', { id: 'view', tabIndex: -1 }, createElement(EditAndFork, { runId: RUN, detail: d, live: false }))));
  return r;
};

describe('what the editor opens with and sends', () => {
  it('opens a result as JSON laid out to edit, a string as text, and a person’s answer as its words', () => {
    expect(editStart(detail(), false)).toEqual({ mode: 'json', text: '{\n  "region": "EU",\n  "limit": 100\n}' });
    expect(editStart(detail({ result: 'no such order' }), false)).toEqual({ mode: 'text', text: 'no such order' });
    expect(editStart(detail({ result: { text: 'Refund it, please.' } }), true)).toEqual({ mode: 'text', text: 'Refund it, please.' });
  });

  it('sends JSON as written, text as one JSON string, and refuses what isn’t JSON or is too large', () => {
    expect(editBody('json', '{"limit": 40}', false)).toEqual({ body: '{"limit": 40}' });
    expect(editBody('text', 'say "no"', false)).toEqual({ body: '"say \\"no\\""' });
    expect(editBody('json', '{"limit": 40,}', false)).toMatchObject({ error: expect.stringMatching(/^Not JSON: /) });
    expect(editBody('text', 'x'.repeat(EDIT_LIMIT), false)).toEqual({ error: 'At most 2 MB.' });
    expect(editBody('text', '  ', true)).toEqual({ error: 'Write what the person answers.' });
  });
});

describe('Edit and fork in the inspector', () => {
  it('opens the result to edit and forks with it: an upload, then the fork the server builds', async () => {
    const sent: Sent = { uploads: [], jobs: [] };
    const page = await open(detail(), sent);
    await page.click(page.byText('button', 'Edit and fork…'));
    const dialog = page.one('[role="dialog"]');
    expect(dialog.textContent).toContain('Edit #16 lookup_policy’s result and fork');
    const field = page.one('.editfork textarea');
    // The field takes the focus, ready to edit.
    expect(page.focused()).toBe(field);
    await page.type(field, '{"region": "EU", "limit": 40}');
    await page.click(page.byText('.dlg-ok', 'Fork'));
    await page.until('the fork to start', () => sent.jobs.length === 1);
    expect(sent.uploads).toEqual([{ name: 'result-16.json', text: '{"region": "EU", "limit": 40}' }]);
    expect(sent.jobs).toEqual([{ kind: 'override', fields: { runId: RUN, callNo: 16, uploadId: '01M5UPLOAD0000000000000000' } }]);
    expect(page.all('[role="dialog"]')).toEqual([]);
  });

  it('can’t fork with what isn’t JSON, and says why', async () => {
    const sent: Sent = { uploads: [], jobs: [] };
    const page = await open(detail(), sent);
    await page.click(page.byText('button', 'Edit and fork…'));
    const field = page.one('.editfork textarea');
    await page.type(field, '{"limit": 40,');
    const ok = page.byText('.dlg-ok', 'Fork');
    expect(ok.disabled).toBe(true);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(page.one('#editforkWhy').textContent).toMatch(/^Not JSON: /);
    // As text, the same words go as one string.
    await page.click(page.byText('.editmode button', 'Text'));
    expect(ok.disabled).toBe(false);
  });

  it('answers a person differently with words, and offers nothing on a model call', async () => {
    const sent: Sent = { uploads: [], jobs: [] };
    const page = await open(detail({ callNo: 1, name: 'user_input', key: 'u', result: { text: 'Refund it.' } }), sent);
    await page.click(page.byText('button', 'Edit and fork…'));
    expect(page.one('[role="dialog"]').textContent).toContain('Answer #1 differently and fork');
    expect(page.all('.editmode')).toEqual([]);
    await page.type(page.one('.editfork textarea'), 'Cancel it instead.');
    await page.click(page.byText('.dlg-ok', 'Fork'));
    await page.until('the fork to start', () => sent.jobs.length === 1);
    expect(sent.uploads).toEqual([{ name: 'answer-1.txt', text: 'Cancel it instead.' }]);
    await page.unmount();
    r = null;
    const model = await open(detail({ kind: 'api', name: 'POST /v1/messages', key: null }), sent);
    expect(model.all('button')).toEqual([]);
  });

  it('asks to confirm someone else’s command when the server names it, and only then forks with the yes, from the same upload', async () => {
    const sent: Sent = { uploads: [], jobs: [] };
    const why = `01M5GRX8K4 came from an imported pack: this runs the command it was recorded with (node agent.mjs), under shadowlap replay ${RUN} --override '16=…'. Confirm it to run it`;
    // What the server gives with its question, to say yes to the lines it named.
    const confirm = '5ca1ab1e'.repeat(4);
    const asked: Array<Record<string, unknown>> = [];
    const base = app(sent);
    const client = {
      ...(base.client as object),
      startJob: async (kind: string, fields: Record<string, unknown>) => {
        asked.push(fields);
        if (fields.yes !== confirm) throw new ApiError(409, why, confirm);
        sent.jobs.push({ kind, fields });
        return { id: 'j1' } as JobView;
      },
    };
    const page = await open(detail(), sent, { client } as unknown as Partial<AppState>);
    await page.click(page.byText('button', 'Edit and fork…'));
    await page.type(page.one('.editfork textarea'), '{"region": "EU", "limit": 40}');
    await page.click(page.byText('.dlg-ok', 'Fork'));
    await page.until('the question', () => page.all('[role="dialog"]').some((d) => d.textContent.includes('Run a command from an imported pack?')));
    // Nothing ran yet; the dialog shows the command the server named.
    expect(sent.jobs).toEqual([]);
    expect(page.one('[role="dialog"]').textContent).toContain(`${why}.`);
    // Confirmed, the same upload goes with the yes: the question's confirm.
    await page.click(page.byText('.dlg-ok', 'Run'));
    await page.until('the fork to start', () => sent.jobs.length === 1);
    expect(sent.uploads).toHaveLength(1);
    expect(asked).toEqual([
      { runId: RUN, callNo: 16, uploadId: '01M5UPLOAD0000000000000000' },
      { runId: RUN, callNo: 16, uploadId: '01M5UPLOAD0000000000000000', yes: confirm },
    ]);
    expect(page.all('[role="dialog"]')).toEqual([]);
  });

  it('sends nothing more when the question is cancelled', async () => {
    const sent: Sent = { uploads: [], jobs: [] };
    const asked: unknown[] = [];
    const base = app(sent);
    const client = { ...(base.client as object), startJob: async (_kind: string, fields: Record<string, unknown>) => (asked.push(fields), Promise.reject(new ApiError(409, '01M5GRX8K4 came from the team store: this runs the command it was recorded with (node agent.mjs), under shadowlap replay x. Confirm it to run it', 'feed'.repeat(8)))) };
    const page = await open(detail(), sent, { client } as unknown as Partial<AppState>);
    await page.click(page.byText('button', 'Edit and fork…'));
    await page.click(page.byText('.dlg-ok', 'Fork'));
    await page.until('the question', () => page.all('[role="dialog"]').some((d) => d.textContent.includes('Run a command from the team store?')));
    await page.click(page.byText('.dlg-cancel', 'Cancel'));
    expect(page.all('[role="dialog"]')).toEqual([]);
    expect(asked).toHaveLength(1);
  });

  it('is off, saying why, where the fork menu’s override is', async () => {
    const page = await open(detail({ disabled: 'A capture has no command: replay it with yours first' }), { uploads: [], jobs: [] });
    const button = page.byText('button', 'Edit and fork…');
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('title')).toBe('A capture has no command: replay it with yours first');
  });

  it('says so first when the run came from someone else’s pack', async () => {
    const page = await open(detail({ label: 'This run came from an imported pack (goldens/refund); replaying it runs: node agent.mjs. Result for #16 lookup_policy, as JSON:' }), { uploads: [], jobs: [] });
    await page.click(page.byText('button', 'Edit and fork…'));
    expect(page.one('.warnline').textContent).toBe('This run came from an imported pack (goldens/refund); replaying it runs: node agent.mjs. ');
  });
});

describe('Edit and fork in the inspector, on every tab', () => {
  it('is under the call’s name on every tab, not only beside the result on Response', async () => {
    const d = detail();
    const call = { ...d.call, effect: 'read', scope: null, model: null, usage: null, latencyMs: 2, fingerprint: 'f16', occurrence: 1, startedAt: 1, endedAt: 2, implHash: null, headers: {}, provider: null } as unknown as CallRow;
    for (const tab of ['conversation', 'response', 'request', 'details'] as const) {
      r = await render(createElement(AppContext.Provider, { value: app({ uploads: [], jobs: [] }) }, createElement(Inspector, { runId: RUN, call, calls: [call], detail: { ...d, call: { ...d.call, ...call }, conversation: null, request: { args: { region: 'EU' } }, response: null, notes: [], forkTitle: 'At #16' } as unknown as CallDetail, error: null, tab, onTab: () => undefined, onStep: () => undefined, change: null, live: false })));
      const buttons = r.all('.insp button').filter((b) => b.textContent === 'Edit and fork…');
      expect(buttons, tab).toHaveLength(1);
      expect(buttons[0].closest('.isumrow'), tab).not.toBeNull();
      await r.unmount();
      r = null;
    }
  });
});
