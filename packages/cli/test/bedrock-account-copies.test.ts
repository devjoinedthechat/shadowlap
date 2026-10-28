import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { packRun, Store, unpackRun, type Normalizer } from '@shadowlap/engine';
import { exportHtml } from '@shadowlap/dashboard';
import { Sidecar } from '@shadowlap/sidecar';
import { runToHar } from '../src/export-har.js';

/**
 * A Bedrock call names an AWS account in two places a redaction rule didn't reach: the model's ARN in
 * its path (an application inference profile), and its guardrail's ARN, a header parameter kept for
 * the call's identity. A rule that masks the account id (`\b\d{12}\b`) masks it there too, in every
 * copy that applies the rules (a pack, an HTML copy and its share link, a HAR), as it masks it in a
 * body; and a replay of the pack reads the live call through the same rule, so it still replays.
 */

const ACCOUNT = '123456789012';
const MODEL = `arn:aws:bedrock:us-east-1:${ACCOUNT}:application-inference-profile/abc123`;
const guardrail = (id: string) => `arn:aws:bedrock:us-east-1:${ACCOUNT}:guardrail/${id}`;
const RULES: Normalizer[] = [{ pattern: '/\\b\\d{12}\\b/', replace: '<ACCOUNT>' }];
const ANSWER = '{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"text","text":"answered under the guardrail"}],"stop_reason":"end_turn","usage":{"input_tokens":3,"output_tokens":4}}';

let upstream: Server;
let upstreamUrl = '';
let root: string;
let uiDir: string;
beforeAll(async () => {
  upstream = createServer((req, res) => {
    req.resume();
    req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end(ANSWER));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  root = mkdtempSync(join(tmpdir(), 'sl-bedrock-account-'));
  // A stand-in for the built UI, so the HTML copy doesn't depend on a bundle.
  uiDir = join(root, 'ui');
  mkdirSync(join(uiDir, 'assets', 'fonts'), { recursive: true });
  writeFileSync(join(uiDir, 'assets', 'app.css'), '.app { color: red }\n');
  writeFileSync(join(uiDir, 'assets', 'app.js'), 'console.log(1);\n');
  writeFileSync(join(uiDir, 'assets', 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
});
afterAll(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

/** The agent's Bedrock call: its model's ARN in the path, its guardrail's in a header, signed as boto3 signs it. */
async function invoke(sidecar: Sidecar, runId: string, gr: string): Promise<{ status: number; origin: string | null }> {
  const res = await fetch(`${sidecar.url}/r/${runId}/bedrock/model/${encodeURIComponent(MODEL)}/invoke`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/20261026/us-east-1/bedrock/aws4_request, SignedHeaders=host;x-amz-date, Signature=abc',
      'x-amzn-bedrock-guardrailidentifier': gr,
      'x-amzn-bedrock-guardrailversion': '1',
    },
    body: JSON.stringify({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 16, messages: [{ role: 'user', content: 'Which plan is this account on?' }] }),
  });
  await res.text();
  return { status: res.status, origin: res.headers.get('x-shadowlap-origin') };
}

/** Every file under `dir`, read as text. */
function filesOf(dir: string): Array<{ file: string; text: string }> {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((f) => join(dir, f))
    .filter((f) => statSync(f).isFile())
    .map((file) => ({ file, text: readFileSync(file).toString('latin1') }));
}

describe('a Bedrock call’s account id, under a rule that masks it', () => {
  it('is gone from every copy that applies the rules, and the pack still replays, and forks on another guardrail', async () => {
    const store = Store.open(':memory:');
    const recorder = await Sidecar.start({ store, upstreams: { bedrock: upstreamUrl } });
    let runId: string;
    try {
      const run = recorder.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '.' } });
      runId = run.runId;
      expect(await invoke(recorder, runId, guardrail('gr-1'))).toEqual({ status: 200, origin: 'live' });
      recorder.endRun(runId, 'completed');
      await recorder.settled(runId);
    } finally {
      await recorder.close();
    }
    // The recording itself holds it, in the call's name, its guardrail and the model it ended with.
    const [held] = store.getCalls(runId);
    expect(held.name).toContain(ACCOUNT);
    expect(JSON.stringify(held.meta.fingerprintHeaders)).toContain(ACCOUNT);

    // A pack.
    const pack = join(root, 'pack');
    packRun(store, runId, pack, { redact: RULES });
    for (const { file, text } of filesOf(pack)) expect(text, file).not.toContain(ACCOUNT);
    // An HTML copy, as the dashboard's download and every share link make it.
    const { html } = exportHtml({ store, runIds: [runId], uiDir, version: 'test', redact: RULES });
    expect(html).not.toContain(ACCOUNT);
    expect(html).toContain('application-inference-profile');
    // A HAR, its request's URL and headers too.
    const har = JSON.stringify(runToHar(store, store.getRun(runId)!, store.getCalls(runId), { redact: RULES }).har);
    expect(har).not.toContain(ACCOUNT);
    expect(har).toContain(encodeURIComponent(`arn:aws:bedrock:us-east-1:<ACCOUNT>:application-inference-profile/abc123`));
    store.close();

    // The pack, replayed offline in another store: the same call replays, another guardrail forks.
    for (const [gr, origin] of [
      ['gr-1', 'replayed'],
      ['gr-2', 'live'],
    ] as const) {
      const other = Store.open(':memory:');
      unpackRun(other, pack);
      const replayer = await Sidecar.start({ store: other, upstreams: { bedrock: upstreamUrl } });
      try {
        const replay = replayer.startRun({ mode: 'replay', parentRunId: runId, command: { argv: ['agent'], cwd: '.' } });
        expect((await invoke(replayer, replay.runId, guardrail(gr))).origin, gr).toBe(origin);
        const { summary } = replayer.endRun(replay.runId, 'completed');
        if (origin === 'replayed') expect(summary.divergence, gr).toBeNull();
        else expect(summary.divergence, gr).toMatchObject({ callNo: 1, kind: 'api' });
      } finally {
        await replayer.close();
        other.close();
      }
    }
  }, 60_000);
});
