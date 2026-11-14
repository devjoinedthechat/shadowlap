import { useState } from 'react';
import { ActionButton } from '../../components/ActionButton.js';
import { Words } from '../../components/Copy.js';
import { useApp } from '../../state.js';
import { CONFIG_FILE, SAVING, useEditor, useFolderGone, useSettingsData } from './common.js';

/**
 * Build, on Settings → Project, under Spending: the command that builds the agent, as `build` in
 * shadowlap.config.json names it. Repair, fix apply, verify's checkout of the code before a change,
 * migrate apply and bisect run it where no `--build` is given, from a terminal and from here alike, so
 * a compiled agent is never replayed from an old build. Save writes the field against the version the
 * row read, with Undo; an empty field takes the key out. A file whose `build` can't be run says why,
 * in the CLI's words, the field there to put it right. Until it has read the file, and in an exported
 * copy, there is no row.
 */

/** The line the file holds for it, as a toast names it. */
const buildLine = (command: string) => `"build": ${JSON.stringify(command)}`;

export function BuildRow() {
  const app = useApp();
  const { client } = app;
  const { data, reload } = useSettingsData(() => client.settings.build(), 'settings:build');
  const editor = useEditor(data?.config.version ?? null, reload);
  const gone = useFolderGone();
  const [text, setText] = useState<string | null>(null);
  if (app.exported || !data) return null;
  const typed = (text ?? data.build ?? '').trim();
  const changed = typed !== (data.build ?? '');
  const off = app.actionsOff ?? gone ?? (data.config.error ? `Fix ${CONFIG_FILE} first` : editor.busy ? SAVING : null);
  const save = () => {
    if (!changed || off) return;
    void editor
      .run(
        () => client.settings.setBuild(typed || null, data.config.version ?? 'absent'),
        (r) => (r.build ? `Wrote ${buildLine(r.build)} to ${CONFIG_FILE}` : `Took ${buildLine(r.was ?? '')} out of ${CONFIG_FILE}`),
        (r) =>
          r.changed
            ? {
                edit: () => client.settings.setBuild(r.was, r.version),
                ok: r.was ? `Put ${buildLine(r.was)} back in ${CONFIG_FILE}` : `Took ${buildLine(r.build ?? '')} out of ${CONFIG_FILE}`,
              }
            : null,
      )
      .then((r) => r && setText(null));
  };
  return (
    <div className="setrow buildrow" id="build">
      <div>
        <b>Build</b>
        <span>
          <Words>The command that builds the agent. Repair, fix apply, verify’s checkout of the code before a change, migrate apply and bisect run it where no --build is given, so a compiled agent never replays an old build.</Words>
        </span>
        {data.problem ? (
          <span className="warn">
            <Words>{data.problem}</Words>
          </span>
        ) : null}
      </div>
      <form
        className="buildset"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <input className="inp" type="text" spellCheck={false} autoComplete="off" aria-label="The command that builds the agent" placeholder="npm run build" readOnly={!!off} title={off ?? undefined} value={text ?? data.build ?? ''} onChange={(e) => setText(e.target.value)} />
        <ActionButton className="btn" why={off ?? (changed ? null : 'Type the command that builds the agent, or empty the field for none')} tip={typed ? `Build the agent with ${typed}` : 'Build nothing'} sub={`Writes ${CONFIG_FILE}, with Undo`} command={typed ? buildLine(typed) : undefined} onClick={save}>
          Save
        </ActionButton>
      </form>
    </div>
  );
}
