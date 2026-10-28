import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Store, unpackRun } from '@shadowlap/engine';
import { fitAbout } from '../src/about.js';
import { App } from '../src/app.js';
import { markTerms } from '../src/components/SearchResults.js';
import { blameCheck, expectError, fixActions } from '../src/fix-actions.js';
import { queryTerms, readSearch, searchArgs } from '../src/search.js';
import { renderAt } from './terminal.js';

const GOLDEN = fileURLToPath(new URL('../../../testing/golden/reference-agent/', import.meta.url));
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const plain = (frame: string | undefined) => (frame ?? '').replace(/\x1b\[[0-9;]*m/g, '');

async function frameWhere(lastFrame: () => string | undefined, ok: (frame: string) => boolean, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let frame = plain(lastFrame());
  while (!ok(frame) && Date.now() < deadline) {
    await tick();
    frame = plain(lastFrame());
  }
  return frame;
}

/** The golden recording (a pack's, so its command is someone else's), and a recording of our own that failed a check. */
function stores() {
  const s = Store.open(':memory:');
  const golden = unpackRun(s, GOLDEN).imported[0];
  const own = s.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd: '.' }, meta: { checks: [{ status: 'failed', ok: false, label: 'send_email called 1 time', detail: 'called 2 times' }] } });
  for (const c of s.getCalls(golden)) {
    const { end, attempts, ...start } = c;
    void attempts;
    s.appendCallStart({ ...start, runId: own.runId });
    if (end) s.appendCallEnd(c, { ...end, runId: own.runId });
  }
  s.endRun(own.runId, 'completed');
  return { s, golden, own: own.runId };
}

/** A stand-in for the CLI: prints `out` and the arguments it was given, then exits with `code`. */
function cli(out: string, code = 0) {
  const asked: string[][] = [];
  const spawnCli = (args: string[]) => {
    asked.push(args);
    return spawn(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(out)}); process.exitCode = ${code}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  };
  return { asked, spawnCli };
}

describe('what a run was about', () => {
  it('names each run by what it was about, in the list and under a run’s header', async () => {
    const { s, own } = stores();
    const runs = renderAt(<App store={s} columns={120} rows={20} />, 120, 20);
    const list = await frameWhere(runs.lastFrame, (f) => f.includes('2 runs'));
    // The golden's user asked for research: its about line is that request, not `node …/main.js`.
    expect(list).toMatch(/recording\s+Research request/);
    runs.unmount();
    const one = renderAt(<App store={s} runId={own} columns={120} rows={20} />, 120, 20);
    const frame = await frameWhere(one.lastFrame, (f) => /^ Research request/m.test(f.split('\n')[1] ?? ''));
    expect(frame.split('\n')[1]).toMatch(/^ Research request .*✗ check failed: send_email called 1 time, but called 2 times/);
    one.unmount();
    s.close();
  });

  it('fits an about line by cutting its middle at whole words, never a change', () => {
    expect(fitAbout({ text: 'Ticket T-8812: the order arrived damaged', from: 'user' }, 30)).toBe('Ticket T-8812: … damaged');
    expect(fitAbout({ text: 'override #16', from: 'change' }, 5)).toBe('override #16');
    expect(fitAbout({ text: 'short', from: 'user' }, 30)).toBe('short');
  });
});

describe('the Fixes flow from the terminal', () => {
  it('blames under the check the dashboard would: the run’s --expect, its fix’s, its exit; asks for one a failed check needs', () => {
    const { s, own, golden } = stores();
    const run = s.getRun(own)!;
    // It failed a check nothing names: blaming on the exit alone would look for another failure.
    expect(blameCheck(s, run)).toBeNull();
    const [b] = fixActions(s, run, { failing: true, recording: false });
    expect([b.key, b.needsExpect, b.disabled ?? null]).toEqual(['B', true, null]);
    expect(b.build('{"tools":{"send_email":1}}')).toEqual(['blame', own, '--expect', '{"tools":{"send_email":1}}']);
    expect(expectError('', true)).toContain('say what a passing run does');
    // Its replay's --expect, then the fix it fails in, then an exit with an error.
    expect(blameCheck(s, { ...run, meta: { ...run.meta, expect: { tools: { send_email: 1 } } } })).toEqual({ expect: { tools: { send_email: 1 } }, from: 'replay' });
    s.insertFix({ fixId: 'fx-1', title: 't', labels: [], check: { expect: { tools: { send_email: 0 } }, key: 'k', oracle: [], text: 'x' }, status: 'open', openedAt: 1, verifiedAt: null, appliedAt: null, data: {} });
    s.addFixLink('fx-1', 'failing', own);
    expect(blameCheck(s, run)).toEqual({ expect: { tools: { send_email: 0 } }, from: 'fix' });
    expect(blameCheck(s, { ...s.getRun(golden)!, status: 'failed', meta: {} })).toEqual({ expect: null, from: 'exit' });
    // Not for a run that passed, or one still recording.
    expect(fixActions(s, s.getRun(golden)!, { failing: false, recording: false })[0].disabled).toBe('for a run that failed');
    expect(fixActions(s, run, { failing: true, recording: true })[0].disabled).toBe('once the recording finishes');
    expect(expectError('')).toBeNull();
    expect(expectError('{"tools":{}}')).toBeNull();
    expect(expectError('[1]')).toContain('a JSON object');
    expect(expectError('{oops')).toContain('takes JSON');
    s.close();
  });

  it('blames a failed run from the fork menu: the command shown, run, and the run read again when it closes', async () => {
    const { s, own } = stores();
    const { asked, spawnCli } = cli('  fix fx-01M · Ask before emailing twice · opened · shadowlap fix show fx-01M\n');
    const { lastFrame, stdin, unmount } = renderAt(<App store={s} runId={own} spawnCli={spawnCli} columns={120} rows={30} />, 120, 30);
    await frameWhere(lastFrame, (f) => f.includes('How this run stands'));
    stdin.write(':');
    let frame = await frameWhere(lastFrame, (f) => f.includes('Fixes'));
    expect(frame).toMatch(/B\s+Find the call it was lost at\s+blame/);
    stdin.write('B');
    frame = await frameWhere(lastFrame, (f) => f.includes('It runs shadowlap blame'));
    expect(frame).toContain(`It runs shadowlap blame ${own}, and asks models live, which costs.`);
    stdin.write('{"tools":{"send_email":1}}');
    await frameWhere(lastFrame, (f) => f.includes('› {"tools":{"send_email":1}}'));
    stdin.write('\r');
    await frameWhere(lastFrame, (f) => f.includes('done'));
    expect(asked).toEqual([['blame', own, '--expect', '{"tools":{"send_email":1}}']]);
    // What blame wrote, read when the job's pane closes.
    s.updateRunMeta(own, { blame: { at: Date.now(), outcome: 'blamed', callNo: 9, confidence: 'high', range: { from: 9, to: 9 }, rescuedRunId: null, fields: [], oracle: [], probes: [], spent: 0 } } as never);
    stdin.write('\x1b');
    frame = await frameWhere(lastFrame, (f) => f.includes('lost at model call #9'));
    expect(frame).toContain('── lost here · blame, high confidence');
    unmount();
    s.close();
  });

  it('asks a yes of its own before blaming a run from someone else’s pack, and passes it on', async () => {
    const { s, golden } = stores();
    s.updateRunMeta(golden, { checks: [{ status: 'failed', ok: false, label: 'answers', detail: null }] });
    const { asked, spawnCli } = cli('');
    const { lastFrame, stdin, unmount } = renderAt(<App store={s} runId={golden} spawnCli={spawnCli} columns={120} rows={30} />, 120, 30);
    await frameWhere(lastFrame, (f) => f.includes('How this run stands'));
    stdin.write(':');
    await frameWhere(lastFrame, (f) => f.includes('Fixes'));
    stdin.write('B');
    await frameWhere(lastFrame, (f) => f.includes('It runs shadowlap blame'));
    // It failed a check nothing names: an empty check is refused, a named one goes on.
    stdin.write('\r');
    await frameWhere(lastFrame, (f) => f.includes('not run: say what a passing run does'));
    expect(asked).toEqual([]);
    stdin.write(':');
    await frameWhere(lastFrame, (f) => f.includes('Fixes'));
    stdin.write('B');
    await frameWhere(lastFrame, (f) => f.includes('It needs a check'));
    stdin.write('{"tools":{}}');
    await frameWhere(lastFrame, (f) => f.includes('› {"tools":{}}'));
    stdin.write('\r');
    await frameWhere(lastFrame, (f) => f.includes('Type yes to run it:'));
    expect(asked).toEqual([]);
    stdin.write('yes');
    await frameWhere(lastFrame, (f) => f.includes('› yes'));
    stdin.write('\r');
    await frameWhere(lastFrame, (f) => f.includes('done') || f.includes('exited'));
    expect(asked).toEqual([['blame', golden, '--expect', '{"tools":{}}', '--yes']]);
    unmount();
    s.close();
  });
});

describe('search across what runs said', () => {
  it('runs shadowlap search, lists its matches and opens one at its call, on the tab it was found on', async () => {
    const { s, golden } = stores();
    const hit = { runId: golden, callNo: 4, kind: 'tool', name: 'search_web', field: 'arguments', snippet: 'search_web query shadowlap replay', runStartedAt: Date.now() };
    const { asked, spawnCli } = cli(JSON.stringify([hit]));
    const { lastFrame, stdin, unmount } = renderAt(<App store={s} spawnCli={spawnCli} columns={120} rows={20} />, 120, 20);
    await frameWhere(lastFrame, (f) => f.includes('2 runs'));
    stdin.write('s');
    await frameWhere(lastFrame, (f) => f.includes('search what runs said:'));
    stdin.write('shadowlap replay');
    await frameWhere(lastFrame, (f) => f.includes('search what runs said: shadowlap replay'));
    stdin.write('\r');
    let frame = await frameWhere(lastFrame, (f) => f.includes('1 match for “shadowlap replay”'));
    expect(asked).toEqual([searchArgs('shadowlap replay')]);
    expect(frame).toMatch(/> 01\w+\s+#4\s+search_web\s+arguments\s+search_web query shadowlap replay/);
    stdin.write('\r');
    frame = await frameWhere(lastFrame, (f) => /> #4\s/.test(f) && f.includes('"query"'));
    expect(frame).toContain('"query": "shadowlap replay"'); // the request tab: where the words were
    unmount();
    s.close();
  });

  it('reads what search printed: matches, none, or why it failed; and marks the words searched for', () => {
    expect(readSearch('[]', '', 1)).toEqual({ hits: [] });
    // With --json no match is `[]`; an exit 1 without it is a failure (a crash, a missing module).
    expect(readSearch('', 'Error: Cannot find module x\n', 1)).toEqual({ error: 'Error: Cannot find module x' });
    expect(searchArgs('-1 refund')).toEqual(['search', '--json', '-n', '50', '--', '-1 refund']);
    expect(readSearch('', 'shadowlap search: the store is locked\n', 2)).toEqual({ error: 'shadowlap search: the store is locked' });
    expect(queryTerms('refund "EU limit" policy')).toEqual(['eu limit', 'refund', 'policy']);
    expect(markTerms('the Refund policy here', ['refund'], 'green').map((s) => [s.text, s.bold === true])).toEqual([
      ['the ', false],
      ['Refund', true],
      [' policy here', false],
    ]);
  });
});

describe('notes', () => {
  it('adds a note on a call with N, marks the call, and shows it with the call and on the verdict', async () => {
    const { s, own } = stores();
    const { lastFrame, stdin, unmount } = renderAt(<App store={s} runId={own} callNo={9} columns={120} rows={40} />, 120, 40);
    await frameWhere(lastFrame, (f) => /> #9\s/.test(f));
    stdin.write('N');
    await frameWhere(lastFrame, (f) => f.includes('Note on #9'));
    stdin.write('the refund limit is per order');
    await frameWhere(lastFrame, (f) => f.includes('› the refund limit is per order'));
    stdin.write('\r');
    let frame = await frameWhere(lastFrame, (f) => f.includes('noted on'));
    expect(s.getRun(own)!.meta?.notes?.map((n) => [n.callNo, n.text])).toEqual([[9, 'the refund limit is per order']]);
    expect(frame).toMatch(/> #9\*\s/);
    stdin.write('4');
    frame = await frameWhere(lastFrame, (f) => f.includes('notes on #9'));
    expect(frame).toContain('the refund limit is per order · ');
    stdin.write('v');
    frame = await frameWhere(lastFrame, (f) => f.includes('Notes'));
    expect(frame).toContain('#9  the refund limit is per order');
    unmount();
    s.close();
  });
});
