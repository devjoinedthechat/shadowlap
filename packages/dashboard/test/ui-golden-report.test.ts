import { describe, expect, it } from 'vitest';
import { UNGUARDED_FIX } from '../../cli/src/doctor.js';
import { hintWords, reportHint } from '../ui/tests/report-words.js';

/**
 * A golden's report as Tests draws it under its row: the one sentence of why under its next steps,
 * by the key the server gives it (ui/tests/report-words.ts). What each button does and costs is its
 * hover, so no hint runs on to a second sentence; a fix it can't leave out follows a colon.
 */
describe('a report’s hint', () => {
  it('says why in one sentence for each kind of golden that didn’t pass', () => {
    expect(hintWords({ key: 'normalizer' })).toBe('Normalizers apply at match time, so older goldens keep working.');
    expect(hintWords({ key: 'bisect' })).toBe('Find breaking commit names the one where it started.');
    expect(hintWords({ key: 'check' })).toBe('The agent did what its checks rule out: fix the agent, not the golden.');
    expect(hintWords({ key: 'crash' })).toBe('The agent stopped part way, so its checks say little.');
    expect(hintWords({ key: 'injection' })).toBe('The agent obeyed an instruction planted in what it reads: fix the agent, not the golden.');
    expect(hintWords({ key: 'gate' })).toBe("Neither verdict holds at the gate's stated risk yet: more attempts settle it, not a change to the agent.");
    expect(hintWords({ key: 'error' })).toBe('The golden could not be replayed.');
    for (const key of ['normalizer', 'bisect', 'check', 'crash', 'injection', 'gate', 'undecided', 'no-calls', 'no-preload', 'error'] as const) expect(hintWords({ key }).split(/[.?](?: |$)/).filter(Boolean)).toHaveLength(1);
  });

  it('says what to do with a crash’s first bad commit once it is named', () => {
    expect(reportHint({ hint: { key: 'crash' }, parts: [{ kind: 'commit', found: {} as never }] })).toBe('The agent stopped part way at the commit above: revert it or fix the code, then run the tests.');
    expect(reportHint({ hint: null, parts: [] })).toBeNull();
  });

  it('says a judge check wasn’t judged in its first sentence, leaving Update golden to its hover', () => {
    expect(hintWords({ key: 'judge', held: 'none', name: 'polite' })).toBe('Its pack holds no verdict for the judge check polite, and the test replays offline.');
    expect(hintWords({ key: 'judge', held: 'older', name: 'polite' })).toMatch(/^The verdict its pack holds for the judge check polite was given to an older form of the judge’s request, .* so the judge can’t be asked\.$/);
    expect(hintWords({ key: 'judge-key', name: 'polite', model: 'claude-x', keys: ['ANTHROPIC_API_KEY', 'CLAUDE_KEY'] })).toBe('The test runs this golden live, and the judge check polite had no key to ask claude-x with: set ANTHROPIC_API_KEY (or CLAUDE_KEY) where the tests run, in CI as a secret, and run it again.');
  });

  it('keeps each guard case’s fix after a colon, doctor’s own words for a process it can’t watch', () => {
    expect(hintWords({ key: 'unguarded' }).replace(/’/g, "'")).toBe(`A process the network guard can't watch ran while the golden replayed, and under --guard block that fails it: ${UNGUARDED_FIX}`);
    const preload = hintWords({ key: 'no-preload' });
    expect(preload).toMatch(/^No Shadowlap preload loaded in the agent’s processes while the golden replayed, .*: run the agent/);
    expect(preload).toContain('shadowlap doctor');
    expect(preload).toContain('--guard warn');
    expect(hintWords({ key: 'blocked', hosts: ['api.stripe.com', 'hooks.slack.com'] })).toBe('The agent connected to api.stripe.com, hooks.slack.com directly, past Shadowlap, and CI replays offline, so the network guard blocked it: wrap the call as a tool so it is recorded, or allow it with SHADOWLAP_GUARD_ALLOW=api.stripe.com,hooks.slack.com.');
  });

  it('says what kept an injection gate from saying, by its reason, and what to do', () => {
    expect(hintWords({ key: 'injection-inconclusive', why: 'unanswered' })).toBe('A model call that got no answer says nothing about the agent: run it again once the provider answers.');
    expect(hintWords({ key: 'injection-inconclusive', why: 'no-reads' })).toBe('Nothing it reads is marked untrusted, so nothing was planted: mark a read untrusted, then run it again.');
    expect(hintWords({ key: 'injection-inconclusive', why: 'stopped' })).toBe('It stopped before its attempts were done: run it again with room to finish.');
    expect(hintWords({ key: 'injection-inconclusive', why: 'nothing' })).toBe('Nothing it ran showed what the agent does with a planted instruction: run it again.');
  });

  it('says a normalizer already in the config needs a re-run, or an update where the request carries more', () => {
    expect(hintWords({ key: 'rules-added', path: '$.metadata.user_id', update: false })).toBe('The normalizer for $.metadata.user_id is in shadowlap.config.json now: run the golden again to see it pass.');
    expect(hintWords({ key: 'rules-added', path: '$.metadata.user_id', update: true })).toMatch(/: update the golden\.$/);
  });
});
