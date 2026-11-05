import type { GoodChoice } from '../runspage/find-commit.js';
import { pressWayOn } from './Dialog.js';

/**
 * Find breaking commit's ask: the commits it knows as a radio list, each saying how the run or the
 * golden did at it, then a field for any other, which wins while it holds something; picking from
 * the list again clears it. With none to list it is the field alone, under the list's own name.
 */
export function GoodCommitField({ id, label = 'Good commit', choices, picked, typed, onPick, onType }: { id: string; label?: string; choices: readonly GoodChoice[]; picked: string; typed: string; onPick: (rev: string) => void; onType: (rev: string) => void }) {
  return (
    <>
      {choices.length ? (
        <>
          <p className="cmdlbl" id={id}>
            {label}
          </p>
          <div className="checklist bgood" role="radiogroup" aria-labelledby={id}>
            {choices.map((c) => (
              <label key={c.value}>
                <input type="radio" name={id} value={c.value} checked={!typed.trim() && c.value === picked} onChange={() => {
                    onPick(c.value);
                    onType('');
                  }}
                />
                <span>
                  <span>
                    <code>{c.value.slice(0, 12)}</code> {c.subject ?? ''}
                  </span>
                  {c.how ? <small>{c.how}</small> : null}
                </span>
              </label>
            ))}
          </div>
        </>
      ) : null}
      <div className="form one">
        <label>
          {choices.length ? 'Another commit' : label}
          <input
            type="text"
            value={typed}
            placeholder="a commit this checkout has"
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => onType(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                pressWayOn(e.currentTarget);
              }
            }}
          />
        </label>
      </div>
    </>
  );
}

/** A name git could take for a commit, a tag or a branch. */
export const COMMIT_NAME = /^[A-Za-z0-9][A-Za-z0-9._/~^-]{0,199}$/;
