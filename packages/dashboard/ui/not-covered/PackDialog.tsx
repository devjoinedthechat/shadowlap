import { useState } from 'react';
import { PACK_EXPECT_EXAMPLE } from '../../../engine/src/coverage-words.js';
import { quoteArgv } from '../../../engine/src/text.js';
import { JOB_KINDS } from '../api.js';
import { Dialog } from '../components/Dialog.js';
import { namedIn } from '../components/Id.js';
import { useTestsWait } from '../fixes/tree.js';
import { shortId } from '../format.js';
import { ACTIONS, confirmWords } from '../labels.js';
import { guardedWayOn, useApp } from '../state.js';
import { errorText } from '../toast.js';
import type { CoverageGroupView } from '../types.js';
import { coverageSaid, endOf, packCommand } from './model.js';
import './job-footer.js';

/*
 * Pack as golden's and Pack with checks…' dialog, a part of its own that Tests' Not covered and the
 * Overview's Needs a look open: the behaviour's whole path as a strip, the agent's command (the one
 * a run here sent the same first request with, where the scan found one), for checks what the agent
 * must do now, then the command. Its confirm is the yes the server asks for a command it runs
 * (`confirmed`), as the dialog showed it; the pack waits for a test session, an update or another
 * pack (`pack it`). Its drawer ends on Run test (job-footer.tsx).
 */

export interface PackDialogProps {
  group: CoverageGroupView;
  /** Pack with checks…: a golden that forks where the agent parts from production, judged by the checks given. */
  fork: boolean;
  onClose: () => void;
}

/** The behaviour's whole path in the call strip's language, a step a swatch and its name, its ending kept with its last step: one image, named in words. */
function Strip({ g }: { g: CoverageGroupView }) {
  const end = endOf(g);
  const step = (name: string, i: number) => (
    <span key={i} className="cvc">
      <i className={g.writes.includes(name) ? 'k-write' : 'k-read'} />
      <code>{name}</code>
    </span>
  );
  return (
    <span className="cvs">
      <span className="cvk flat" role="img" aria-label={coverageSaid(g, true)}>
        <span className="cvb">
          {g.path.slice(0, -1).map(step)}
          <span className="cvcl">
            {g.path.slice(-1).map((name) => step(name, g.path.length - 1))}
            <span className="cvc end">
              <i className={end.swatch} />
              {end.words}
            </span>
          </span>
        </span>
      </span>
    </span>
  );
}

export function PackDialog({ group: g, fork, onClose }: PackDialogProps) {
  const app = useApp();
  const [command, setCommand] = useState(() => (g.pack?.command ? quoteArgv(g.pack.command) : ''));
  const [expect, setExpect] = useState('');
  const [refused, setRefused] = useState<string | null>(null);
  const wait = useTestsWait('pack it');
  const key8 = g.key.slice(0, 8);
  const newest = shortId(g.runId ?? g.runIds[0] ?? '');
  const ok = confirmWords(fork ? ACTIONS.packWithChecks.label : ACTIONS.packBehaviour.label);
  const fields = () => ({ key: g.key, ...(command.trim() ? { command: command.trim() } : {}), ...(fork ? { fork: true, expect: expect.trim() } : {}), confirmed: true });
  // The server's refusal keeps the dialog open with what was typed, its words over the facts.
  const start = (): Promise<boolean> =>
    app.client.startJob(JOB_KINDS.coveragePack, fields()).then(
      (job) => {
        app.watchJob(Promise.resolve(job));
        return true;
      },
      (err: unknown) => {
        setRefused(errorText(err));
        return false;
      },
    );
  return (
    <Dialog
      title={namedIn(fork ? `Pack ${key8} with checks?` : `Pack ${key8} as golden?`, key8)}
      lead={
        fork ? (
          `Packs ${newest} as a golden that forks where your agent parts from it, judged by your checks.`
        ) : (
          <>
            Packs {newest} into <code>goldens/</code> once it reproduces offline.
          </>
        )
      }
      doc={fork ? 'keepNoLonger' : 'packCoverage'}
      className="cvdlg"
      warn={refused ? { text: refused } : null}
      facts={[
        {
          label: 'Changes',
          value: 'your working tree',
          quiet: (
            <>
              a golden’s folder under <code>goldens/</code>
              {fork ? ', and its entry in shadowlap.config.json with your checks' : null}
            </>
          ),
        },
        { label: 'Tools', value: 'answered from the capture', quiet: 'a tool with no result there runs live, writes stubbed' },
      ]}
      command={packCommand(g.key, { fork, expect, command })}
      cost={{ price: 'Free', parts: ['replays offline'] }}
      ok={ok}
      okWhy={wait}
      onOk={() => guardedWayOn(app.guard, start)}
      onClose={onClose}
    >
      <div className="cvbox">
        <Strip g={g} />
      </div>
      <div className="form one cvform">
        <label>
          The agent’s command
          <input type="text" className="cvin" spellCheck={false} value={command} placeholder="python agent.py {message}" onChange={(e) => setCommand(e.target.value)} />
          <span className="cvmsg">
            {'{message}'} stands for {newest}’s first message
          </span>
        </label>
        {fork ? (
          <label>
            What the agent must do now (--expect)
            <input type="text" className="cvin" spellCheck={false} value={expect} placeholder={PACK_EXPECT_EXAMPLE} onChange={(e) => setExpect(e.target.value)} />
          </label>
        ) : null}
      </div>
    </Dialog>
  );
}
