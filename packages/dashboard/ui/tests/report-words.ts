import { noteText, UNGUARDED_FIX } from '../run/note-words.js';
import type { GoldenReport, HintKey } from '../types.js';

/**
 * The one sentence of why under a golden's report, by the key the server gives it
 * (golden-report.ts `HintKey`): what each button does, and what it costs, is its hover. A fix the
 * sentence can't leave out follows a colon; doctor's fix for a process the guard can't watch is
 * doctor's own words (`UNGUARDED_FIX`). Tests' chunk only: nothing here ships with another page.
 */
export function hintWords(hint: HintKey, o: { named?: boolean } = {}): string {
  switch (hint.key) {
    case 'normalizer':
      return 'Normalizers apply at match time, so older goldens keep working.';
    case 'switch':
      return 'A golden recorded before the switch diverges on it: update it once the switch is what you meant.';
    case 'rules-added':
      return hint.update ? `The normalizer for ${hint.path} is in shadowlap.config.json now and masks the value, but the request also carries what the recording never had: update the golden.` : `The normalizer for ${hint.path} is in shadowlap.config.json now: run the golden again to see it pass.`;
    case 'bisect':
      return 'Find breaking commit names the one where it started.';
    case 'gate':
      return "Neither verdict holds at the gate's stated risk yet: more attempts settle it, not a change to the agent.";
    case 'judge':
      return judgeWords(hint);
    case 'judge-key':
      return `The test runs this golden live, and the judge check ${hint.name} had no key to ask ${hint.model} with: set ${hint.keys[0] ?? 'its key'}${hint.keys.length > 1 ? ` (or ${hint.keys.slice(1).join(' or ')})` : ''} where the tests run, in CI as a secret, and run it again.`;
    case 'undecided':
      return 'A check could not be decided, as its line above says, so the golden is neither passed nor failed: settle what it lacks and run it again.';
    case 'crash':
      return o.named ? 'The agent stopped part way at the commit above: revert it or fix the code, then run the tests.' : 'The agent stopped part way, so its checks say little.';
    case 'check':
      return 'The agent did what its checks rule out: fix the agent, not the golden.';
    case 'no-calls':
      return 'The replay made no calls: does the agent still start, and does it use the Shadowlap environment?';
    case 'unguarded':
      return `A process the network guard can’t watch ran while the golden replayed, and under --guard block that fails it: ${noteText(UNGUARDED_FIX)}`;
    case 'no-preload':
      return 'No Shadowlap preload loaded in the agent’s processes while the golden replayed, so under --guard block the network guard never watched it: run the agent on Node or Python with the environment shadowlap gives it (shadowlap doctor says what keeps a preload from loading), or test with --guard warn.';
    case 'blocked':
      return `The agent connected to ${hint.hosts.join(', ')} directly, past Shadowlap, and CI replays offline, so the network guard blocked it: wrap the call as a tool so it is recorded, or allow it with SHADOWLAP_GUARD_ALLOW=${hint.hosts.join(',')}.`;
    case 'injection':
      return 'The agent obeyed an instruction planted in what it reads: fix the agent, not the golden.';
    case 'injection-inconclusive':
      return INJECTION_UNSAID[hint.why];
    case 'provider':
      return hint.why === 'unavailable' ? INJECTION_UNSAID.unanswered : 'Attempts the provider cut short could have ended either way: run it again once the provider answers.';
    case 'error':
      return 'The golden could not be replayed.';
    case 'checks-changed':
      return 'Run tests judges its checks as they are now.';
    case 'edit-check':
      return 'The check, added since, fails the golden’s own recording: edit the check, or update the golden if the agent should now do this.';
  }
}

/** Why a judge check wasn't judged offline, in main's first sentence: what Update golden does about it is its hover. */
function judgeWords(hint: Extract<HintKey, { key: 'judge' }>): string {
  if (hint.held === 'older') return `The verdict its pack holds for the judge check ${hint.name} was given to an older form of the judge’s request, which a replay no longer sends, and the test replays offline, so the judge can’t be asked.`;
  if (hint.held === 'material') return `The verdict its pack holds for the judge check ${hint.name} was given on other material than the replay reads now, as its line above says, and the test replays offline, so the judge can’t be asked.`;
  return `Its pack holds no verdict for the judge check ${hint.name}, and the test replays offline.`;
}

/** An injection gate that showed too little to say, by what kept it from saying. `--inconclusive warn` stays in the lines as printed. */
const INJECTION_UNSAID: Record<Extract<HintKey, { key: 'injection-inconclusive' }>['why'], string> = {
  unanswered: 'A model call that got no answer says nothing about the agent: run it again once the provider answers.',
  'no-reads': 'Nothing it reads is marked untrusted, so nothing was planted: mark a read untrusted, then run it again.',
  stopped: 'It stopped before its attempts were done: run it again with room to finish.',
  nothing: 'Nothing it ran showed what the agent does with a planted instruction: run it again.',
};

/**
 * A report's hint: a crash whose first bad commit stands says what to do with the commit, and Find
 * breaking commit is named only where the report draws it (`findsCommit`, lead.ts `drawsFindCommit`).
 */
export function reportHint(r: Pick<GoldenReport, 'hint' | 'parts'>, o: { findsCommit?: boolean } = {}): string | null {
  if (!r.hint || (r.hint.key === 'bisect' && !o.findsCommit)) return null;
  return hintWords(r.hint, { named: r.parts.some((p) => p.kind === 'commit') });
}
