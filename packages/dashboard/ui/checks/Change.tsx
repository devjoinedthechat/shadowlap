import { useEffect, useRef } from 'react';
import type { ChecksConfig, GoldenEntry } from '../checks-api.js';
import { CodeBox } from '../components/CodeBox.js';
import { Copy } from '../components/Copy.js';
import { ErrorState } from '../components/States.js';
import { goldenName } from '../format.js';
import { packRunCommand } from '../run/share.js';
import { changeLines, entryAfter, entryOf, versionWords, type Fragment } from './model.js';

/**
 * The change: the golden's entry in shadowlap.config.json as a save writes it, its lines going and
 * coming against the file as read, the version it is saved against, and what the save does beyond
 * the entry. A file changed since says so above the box, which then shows the file as it is now.
 */
export interface ChangeProps {
  cfg: ChecksConfig;
  /** Why reading the file again failed, said under the heading with Retry, which Save's why points to. */
  error: string | null;
  retry: () => void;
  golden: GoldenEntry | null;
  merged: Fragment;
  changed: boolean;
  /** The 409's words, after the file was read again. */
  conflict: string | null;
  /** A judge added or changed in this session. */
  judgeAdded: boolean;
  /** The run a golden can be packed from, with no golden yet. */
  runId: string | null;
}

export function Change({ cfg, error, retry, golden, merged, changed, conflict, judgeAdded, runId }: ChangeProps) {
  const warn = useRef<HTMLParagraphElement | null>(null);
  useEffect(() => {
    if (conflict) warn.current?.scrollIntoView({ block: 'center' });
  }, [conflict]);
  const head = (
    <>
      <p className="cb-k">
        <span className="k">The change</span>
      </p>
      {error ? <ErrorState retry={retry}>{error}</ErrorState> : null}
    </>
  );
  if (!golden) {
    return (
      <section className="cb-sec">
        {head}
        <p className="cb-note">
          {cfg.agent ? <code>{cfg.agent}</code> : 'This agent'} has no golden yet. Pack a run you consider correct, then add the check to it.
        </p>
        <CodeBox command={runId ? packRunCommand(runId, 'goldens/<name>') : 'shadowlap pack <run> goldens/<name>'} />
      </section>
    );
  }
  const at = entryOf(golden);
  const notes = [
    golden.mode.label === 'fork · history' ? 'Its gate against history starts its baseline again from this change.' : null,
    judgeAdded && golden.mode.label === 'replay' ? 'Its next offline test reads the judge inconclusive until Update golden asks it once.' : null,
    golden.pattern && golden.key ? `It gets an entry of its own, with the other keys of ${golden.key} copied: the pattern stays for its other goldens, and ${goldenName(golden.path)} no longer follows later edits to it.` : null,
    cfg.relaid ? 'Saving also lays out the rest of shadowlap.config.json anew, as the dashboard writes the file.' : null,
  ].filter((n): n is string => !!n);
  return (
    <section className="cb-sec">
      {head}
      {conflict ? (
        <p ref={warn} className="cb-warn" role="alert">
          {conflict}
        </p>
      ) : null}
      {!changed ? (
        <Copy className="cb-note">{cfg.version === 'absent' ? 'Nothing to write yet: no shadowlap.config.json is made.' : `Nothing to write yet: shadowlap.config.json, ${versionWords(cfg.version)}, stays as it is.`}</Copy>
      ) : (
        <>
          <CodeBox
            file="shadowlap.config.json"
            change
            className="cb-file"
            lines={changeLines({ key: at.key, before: at.before, after: entryAfter(at.from, merged), indent: cfg.indent, order: cfg.order, exists: cfg.exists, hasTests: cfg.hasTests })}
            actions={
              <span className="cb-ver">
                {versionWords(cfg.version)} · <span className="nw">saved only if unchanged</span>
              </span>
            }
          />
          {notes.map((n) => (
            <Copy key={n} className="cb-note">
              {n}
            </Copy>
          ))}
        </>
      )}
    </section>
  );
}
