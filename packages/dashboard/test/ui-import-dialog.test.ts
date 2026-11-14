import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { FILE_FORMATS, traceSources } from '../src/routes/imports.js';
import { ImportDialog } from '../ui/runspage/ImportDialog.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { ImportSources } from '../ui/types.js';
import { render, type FakeElement, type Rendered } from './ui-render.js';

/**
 * Import capture in bulk: from Langfuse, Phoenix and Logfire the traces that started in a window,
 * each field checked as the CLI checks it, and Logfire's one trace looked for as far back as Looks
 * back says; several LiteLLM or OpenTelemetry files at once, each uploaded, then one import of them
 * all. What the server says of the stores is its own answer (`traceSources`), with example keys.
 */

const SOURCES: ImportSources = { formats: FILE_FORMATS, traces: traceSources({ LANGFUSE_PUBLIC_KEY: 'pk-lf-EXAMPLE', LANGFUSE_SECRET_KEY: 'sk-lf-EXAMPLE', LOGFIRE_READ_TOKEN: 'pylf_v1_us_EXAMPLE' }), uploadLimit: 64 * 1024 * 1024 };

function app(started: Array<[string, Record<string, unknown>]>, uploads: string[]): AppState {
  return {
    client: {
      importSources: async () => SOURCES,
      upload: async (_file: Blob, name: string) => (uploads.push(name), { uploadId: `U${uploads.length}`, name }),
      startJob: async (kind: string, fields: Record<string, unknown>) => (started.push([kind, fields]), { id: 'j1' }),
    },
    meta: { project: { id: 'support-agent', name: 'support-agent', path: '/work/support-agent' } },
    watchJob: () => undefined,
    toast: () => undefined,
  } as unknown as AppState;
}

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
});

const text = (el: FakeElement) => el.textContent.replace(/\u00a0/g, ' ');
const field = (label: string) => r!.all('.dialog label').find((l) => text(l).startsWith(label))!.querySelector('input')!;
const command = () => text(r!.one('.dialog .cmdline')).replace(/^\$/, '');
const ok = () => r!.one('.dialog .dlg-ok');

async function open(started: Array<[string, Record<string, unknown>]> = [], uploads: string[] = []): Promise<Rendered> {
  const page = await render(createElement(AppContext.Provider, { value: app(started, uploads) }, createElement(ImportDialog, { onClose: () => undefined })));
  await page.until('the sources', () => page.all('.dialog .impsrc button').length === 5);
  return page;
}

describe('Import capture from a trace store', () => {
  it('imports the traces that started in a window, each field checked as the CLI checks it, with the command it runs', async () => {
    const started: Array<[string, Record<string, unknown>]> = [];
    r = await open(started);
    await r.click(r.byText('.dialog .impsrc button', 'Langfuse'));
    await r.until('the trace pane', () => r!.all('.dialog .impmode button').length === 2);
    await r.click(r.byText('.dialog .impmode button', 'Traces in a window'));
    expect(r.all('.dialog label').map((l) => text(l).trim())).toEqual(['Host', 'Since', 'Until', 'At most', 'Trace name']);
    // Nothing typed: the CLI's own window, the last 30 days.
    expect(command()).toBe('shadowlap import langfuse --since 30d');
    await r.type(field('Since'), 'last week');
    expect(text(r.one('.dialog .fieldnote.err'))).toBe('--since: a date (2026-09-30), a time (2026-09-30T14:00Z), or how long ago (30d, 12h), not "last week"');
    expect(ok().disabled).toBe(true);
    await r.type(field('Since'), '7d');
    await r.type(field('At most'), '50');
    await r.type(field('Trace name'), 'refund flow');
    expect(command()).toBe("shadowlap import langfuse --since 7d --limit 50 --trace-name 'refund flow'");
    expect(r.all('.dialog dt').map(text)).toContain('Imports');
    await r.click(ok());
    await r.until('the job', () => started.length === 1);
    expect(started).toEqual([['import', { format: 'langfuse', window: { since: '7d', limit: '50', traceName: 'refund flow' } }]]);
  });

  it('looks for a Logfire trace as far back as Looks back says, and LangSmith’s by its id alone', async () => {
    const started: Array<[string, Record<string, unknown>]> = [];
    const id = '4a2db41deabc4aec332fb9fbfa0fc3e2';
    r = await open(started);
    await r.click(r.byText('.dialog .impsrc button', 'Logfire'));
    await r.until('the trace pane', () => r!.all('.dialog .impmode button').length === 2);
    await r.type(field('Trace id'), id);
    await r.type(field('Looks back'), '90d');
    expect(command()).toBe(`shadowlap import logfire ${id} --since 90d`);
    await r.click(ok());
    await r.until('the job', () => started.length === 1);
    expect(started[0]).toEqual(['import', { format: 'logfire', traceId: id, window: { since: '90d' } }]);
    await r.click(r.byText('.dialog .impsrc button', 'LangSmith'));
    expect(r.all('.dialog .impmode')).toHaveLength(0);
    expect(r.all('.dialog label').map((l) => text(l).trim())).toEqual(['Host', 'Trace id']);
  });
});

describe('Import capture from several files', () => {
  const file = (name: string, body: string) => new File([body], name, { type: 'application/json' });

  it('takes several OpenTelemetry files together, uploads each, and imports them as one', async () => {
    const started: Array<[string, Record<string, unknown>]> = [];
    const uploads: string[] = [];
    r = await open(started, uploads);
    await r.fire(r.one('.dialog label.drop'), 'drop', { dataTransfer: { files: [file('traces.json', '{"resourceSpans":[]}'), file('logs.json', '{"resourceLogs":[]}')] } } as never);
    await r.until('the files', () => r!.all('.dialog .capfile code').length === 2);
    expect(r.all('.dialog .capfile code').map(text)).toEqual(['traces.json', 'logs.json']);
    expect(r.all('.dialog .capfile option').map(text)).toEqual(['LiteLLM', 'OpenTelemetry']);
    expect(command()).toBe('shadowlap import otel traces.json logs.json');
    await r.click(ok());
    await r.until('the job', () => started.length === 1);
    expect(uploads).toEqual(['traces.json', 'logs.json']);
    expect(started).toEqual([['import', { format: 'otel', uploadIds: ['U1', 'U2'] }]]);
  });

  it('says why several files of another format can’t go in together', async () => {
    r = await open();
    await r.fire(r.one('.dialog label.drop'), 'drop', { dataTransfer: { files: [file('a.har', '{"log":{"entries":[]}}'), file('b.har', '{"log":{"entries":[]}}')] } } as never);
    await r.until('the refusal', () => r!.all('.dialog .fieldnote.err').length === 1);
    expect(text(r.one('.dialog .fieldnote.err'))).toBe('Several files go in together only as LiteLLM captures or as OpenTelemetry exports: import a HAR file on its own.');
    expect(ok().disabled).toBe(true);
  });
});
