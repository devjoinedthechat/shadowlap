import { useState } from 'react';
import { pullArgs, pullNameProblem, pullNames, PULL_MAX, typedNames } from '../../../src/store-pull.js';
import { JOB_KINDS } from '../../api.js';
import { Copy } from '../../components/Copy.js';
import { Dialog, pressWayOn } from '../../components/Dialog.js';
import { Switch } from '../../components/Switch.js';
import { commandText } from '../../goldens.js';
import { useApp } from '../../state.js';

/**
 * Pull runs…, from Settings → Store's Last sync: the runs named as the store lists them (ids, or their
 * first 4 characters or more), every teammate's run when none is named, and with its switch on the
 * runs pull requests' CI jobs pushed to their own folders, which stay on this machine. The command
 * follows the fields, as the job runs it (`pullArgs`); the job's drawer opens the runs it brought.
 */
export function PullRunsDialog({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const [text, setText] = useState('');
  const [prs, setPrs] = useState(false);
  const names = pullNames(text);
  const problem = names.length > PULL_MAX ? `At most ${PULL_MAX} runs at once` : (typedNames(text).map(pullNameProblem).find((p) => p !== null) ?? null);
  return (
    <Dialog
      title="Pull runs"
      lead="Brings the runs you name from the team store, with their ancestors, and merges labels and notes."
      doc="pushPull"
      command={commandText(pullArgs(names, prs))}
      ok="Pull"
      okWhy={problem}
      onOk={() => app.guard(() => app.watchJob(app.client.startJob(JOB_KINDS.pull, { runIds: names, includePr: prs })))}
      onClose={onClose}
      className="pulldlg"
    >
      <div className="form one">
        <label>
          Runs
          <input
            type="text"
            spellCheck={false}
            autoComplete="off"
            placeholder="every teammate’s run"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                pressWayOn(e.currentTarget);
              }
            }}
          />
        </label>
      </div>
      <Copy className={problem ? 'fieldnote err' : 'fieldnote'}>{problem ? `${problem}.` : 'Run ids, or their first 4 characters or more, as the store lists them.'}</Copy>
      <Switch on={prs} onChange={setPrs}>
        Pull requests’ runs too
      </Switch>
    </Dialog>
  );
}
