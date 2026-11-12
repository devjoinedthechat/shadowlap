import { consentAsked, type LiveGolden } from '../actions.js';
import { JOB_KINDS } from '../api.js';
import { ACTIONS } from '../labels.js';
import { askQuestion, type TestsAsk, type TestsJobApp } from '../tests-ask.js';

/**
 * How Revert's dialog starts its job, and answers what the server asks before it runs. No DOM here:
 * the tests drive it with a stand-in app.
 */

/** A question asking a yes to a command someone else recorded: the dialog gives way to ConsentDialog for it. */
export interface CommandAsk {
  why: string;
  confirm: string;
}

/** What the dialog asked: the golden whose test runs live and why, as its rows said (none where it said nothing runs live), and the `$` row. */
export interface RevertAsked {
  golden: string;
  rev: string;
  live: LiveGolden['why'];
  command: string | null;
}

/** The server names only what the dialog said already: the same golden, live for no reason the dialog didn't give. */
function askedAlready(live: readonly LiveGolden[], asked: RevertAsked): boolean {
  const kinds = new Set(asked.live.map((w) => w.kind));
  return kinds.size > 0 && live.every((g) => g.path === asked.golden && g.why.every((w) => kinds.has(w.kind)));
}

/** Tests' question for a revert whose test the dialog said runs offline: the server's rows say why it runs live. */
const liveAsk = (asked: RevertAsked): TestsAsk => ({
  title: `${ACTIONS.revert.label} ${asked.rev}?`,
  name: asked.rev,
  lead: 'Undoes the commit in your working tree, uncommitted, then tests the golden, which runs live.',
  doc: 'goldensThatFork',
  ok: ACTIONS.revert.label,
  ...(asked.command ? { commands: [asked.command] } : {}),
});

/**
 * Starts the revert, and says once the server has answered whether the dialog is done (true) or
 * gives way to ConsentDialog (false): false at once while the job can't start (offline), so the
 * dialog stays open. The dialog answers one question itself: the server's about a golden whose test
 * runs live (liveAsk, a 409 carrying `live`), where its rows said so for the same reasons, its yes
 * going at once. A live question the dialog didn't ask (the golden's settings changed since the page
 * read them) waits as Tests' question (tests-ask.ts), in the server's rows. Any other question asking
 * a yes is to a command someone else recorded: `consent` hands it to ConsentDialog, whose Run alone
 * sends the yes. Anything else, and a question after a yes, is the job's refusal, in its drawer.
 */
export function startRevert(app: TestsJobApp, fields: Record<string, unknown>, asked: RevertAsked, consent: (q: CommandAsk) => void): false | Promise<boolean> {
  let done: Promise<boolean> = Promise.resolve(true);
  const sent = app.guard(() => {
    done = app.client.startJob(JOB_KINDS.revert, fields).then(
      (job) => (app.watchJob(Promise.resolve(job)), true),
      (err: unknown) => {
        const q = fields.yes === undefined ? consentAsked(err) : null;
        if (q && !q.live) return (consent({ why: q.why, confirm: q.confirm }), false);
        if (q?.live && askedAlready(q.live, asked)) app.watchJob(app.client.startJob(JOB_KINDS.revert, { ...fields, yes: q.confirm }));
        else if (q?.live) askQuestion({ ...liveAsk(asked), why: q.why, confirm: q.confirm, live: q.live, kind: JOB_KINDS.revert, fields, app });
        else app.watchJob(Promise.reject(err));
        return true;
      },
    );
  });
  return sent ? done : false;
}
