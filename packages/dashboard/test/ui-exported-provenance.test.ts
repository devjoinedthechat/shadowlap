import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store, unpackRun } from '@shadowlap/engine';
import { exportHtml, type StaticPayload } from '../src/index.js';
import { createExportedClient } from '../ui/api.js';
import { normalizeMeta, normalizeRunDetail } from '../ui/normalize.js';
import { ProvenanceView } from '../ui/run/ProvenanceView.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { Meta, RunDetail } from '../ui/types.js';

/**
 * An exported copy's Provenance said "A copy made now … applies the redaction rules in
 * shadowlap.config.json", with a Settings link the copy can't open. It now says how the copy itself
 * was made, with how many rules, and links nowhere. Drawn from a real export's data, as the copy
 * draws it.
 */
const GOLDEN = fileURLToPath(new URL('../../../testing/golden/reference-agent', import.meta.url));
/** Oct 22 this year, at noon UTC: the same day in every time zone the tests run in, and no year to name. */
const EXPORTED_AT = Date.UTC(new Date().getFullYear(), 9, 22, 12);

let store: Store;
let runId: string;
let uiDir: string;

beforeAll(() => {
  store = Store.open(':memory:');
  runId = unpackRun(store, GOLDEN).imported[0]!;
  uiDir = mkdtempSync(join(tmpdir(), 'sl-export-prov-ui-'));
  mkdirSync(join(uiDir, 'assets', 'fonts'), { recursive: true });
  writeFileSync(join(uiDir, 'assets', 'app.css'), '.app{}\n');
  writeFileSync(join(uiDir, 'assets', 'app.js'), 'console.log(1);\n');
  writeFileSync(join(uiDir, 'assets', 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
});
afterAll(() => {
  store.close();
  rmSync(uiDir, { recursive: true, force: true });
});

/** The data an exported file embeds, read back as the copy reads it. */
function exported(redact: Array<{ pattern: string; replace: string }>): StaticPayload {
  const { html } = exportHtml({ store, runIds: [runId], uiDir, redact, now: EXPORTED_AT });
  const json = /<script type="application\/json" id="shadowlap-data">([\s\S]*?)<\/script>/.exec(html)![1]!;
  return JSON.parse(json) as StaticPayload;
}

/** The Provenance view of the copy's run, drawn as the copy draws it, and its "Leaving this machine" part. */
function leaving(data: StaticPayload): { text: string; html: string } {
  const meta = normalizeMeta(data.responses['meta'] as Meta);
  const run = normalizeRunDetail(data.responses[`runs/${runId}`] as RunDetail);
  const app = { client: createExportedClient(data), meta, exported: true, toast: () => undefined, runs: [] } as unknown as AppState;
  const html = renderToStaticMarkup(createElement(AppContext.Provider, { value: app }, createElement(ProvenanceView, { run })));
  const part = /<h3>Leaving this machine<\/h3>(<p[^>]*>[\s\S]*?<\/p>)/.exec(html)![1]!;
  return { html: part, text: part.replace(/<[^>]+>/g, '').replace(/&#x27;|’/g, '’') };
}

describe('an exported copy’s Provenance', () => {
  it('says when the copy was made and how many redaction rules it applied, and links nowhere', () => {
    const one = leaving(exported([{ pattern: 'email', replace: '<EMAIL>' }]));
    expect(one.text).toBe('Exported Oct 22 with 1 redaction rule applied.');
    expect(one.html).not.toContain('href');
    const none = leaving(exported([]));
    expect(none.text).toBe('Exported Oct 22 with no redaction rules: it holds what was recorded.');
    expect(none.html).not.toContain('#/settings');
  });
});
