import type { TestsView } from '../api.js';
import { Badge } from '../components/bits.js';
import { tipText } from '../components/HoverCard.js';
import { commandText, sessionLine } from '../goldens.js';

/** Tests' verdict: how the goldens' last results came out, and the session that tested them. */
export function Verdict({ view, running }: { view: TestsView; running: boolean }) {
  const v = view.verdict;
  if (!v) {
    const command = commandText(view.commands.run);
    // No golden replayed yet, though its error-path presets may have run: then it has been tested, and says so.
    const presets = view.rows.filter((r) => r.presets).length;
    const one = view.goldens === 1;
    return (
      <div className="verdict tv n">
        <Badge tone="n">{presets ? 'not replayed yet' : 'not run yet'}</Badge>
        <div>
          <h2>{presets ? (one ? 'One golden, not replayed yet' : `${view.goldens} goldens, none replayed yet`) : one ? 'One golden, not tested yet' : `${view.goldens} goldens, none tested yet`}</h2>
          <p>
            {presets ? `Error-path presets ran on ${presets === view.goldens ? (one ? 'it' : 'every one') : `${presets} of them`}. ` : null}
            {view.rows.some((r) => r.mode === 'fork') ? 'Run tests replays each one, those marked fork live from where they fork' : 'Run tests replays each one offline'}: <SessionCommand text={command} />
          </p>
        </div>
      </div>
    );
  }
  const line = sessionLine(view, running)!;
  const failing = v.state === 'failing';
  // Inconclusive goldens, and none failing: amber, neither passing nor failing.
  const unsure = v.state === 'inconclusive';
  return (
    <div className={`verdict tv ${failing ? 'no' : unsure ? 'warn' : 'ok'}`}>
      <Badge tone={failing ? 'no' : unsure ? 'y' : 'ok'}>{failing ? `${v.failing} failing` : unsure ? `${v.inconclusive} inconclusive` : 'passing'}</Badge>
      <div>
        <h2>{v.title}</h2>
        <p>
          <SessionCommand text={line.command} /> · {line.rest}
          {line.since ? (
            <>
              {' · '}
              <span className="tsince" data-tip={line.sinceTip ? tipText(line.sinceTip) : undefined}>
                {line.since}
              </span>
            </>
          ) : null}
        </p>
      </div>
    </div>
  );
}

/** The session's command on the verdict's line: on one line, cut short with its whole text on hover when it is longer than the line. */
function SessionCommand({ text }: { text: string }) {
  return (
    <code className="vcmd" data-tip={tipText(text)}>
      {text}
    </code>
  );
}
