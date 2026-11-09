import { Fragment as Join, useEffect, useState, type ReactNode } from 'react';
import { messageOf } from '../../../engine/src/message-of.js';
import { ApiError } from '../api.js';
import type { ChecksConfig, ChecksSaved } from '../checks-api.js';
import { Dialog } from '../components/Dialog.js';
import { namedIn } from '../components/Id.js';
import { ErrorState } from '../components/States.js';
import { goldenName } from '../format.js';
import { useLoad } from '../hooks.js';
import { removeTitle, type RemoveProps } from '../run/check-part.js';
import { useApp } from '../state.js';
import { errorText } from '../toast.js';
import { Change } from './Change.js';
import { baseOf, labelsOf, mergeFragments, NOT_AS_WRITTEN, unitsOf, unitWithLabel, type Fragment } from './model.js';

/**
 * Remove on a golden's check, from Tests' Checks cell (tests/check-entries.tsx), a part of its own:
 * it asks first, with the lines that leave shadowlap.config.json against the version it read, and
 * writes the golden's entry without the check through the builder's route, which refuses a file
 * changed since. It finds the check by its label in the entry as it reads it; an entry that doesn't
 * yield it closes the dialog, saying to edit it there. A file changed since is read again, the change
 * shown against it under the refusal's words and the way on reading Remove again. Once it is written,
 * its toast offers Undo, which the server holds (`was`): it puts the entry back as the removal found it.
 */
export function RemoveCheck({ golden, check, onClose, onChanged }: RemoveProps) {
  const { client, toast } = useApp();
  const cfg = useLoad(() => client.checks.goldens({ golden }), golden);
  const name = goldenName(golden);
  const title = namedIn(removeTitle(golden), name);
  const entry = cfg.data?.goldens.find((g) => g.path === golden) ?? null;
  const gone = !!cfg.data && unitWithLabel(baseOf(entry), check) < 0;
  useEffect(() => {
    if (!gone) return;
    toast(NOT_AS_WRITTEN);
    onClose();
  }, [gone, toast, onClose]);
  if (gone) return null;
  if (!cfg.data || !entry) {
    return (
      <Dialog title={title} doc="checks" tone="danger" initialFocus="cancel" className="ckrm" ok="Remove check" okWhy={cfg.error ? 'Its golden’s checks didn’t load' : 'Loading its golden’s checks…'} onClose={onClose}>
        {cfg.error ? <ErrorState retry={cfg.reload}>{messageOf(cfg.error)}</ErrorState> : <p className="cb-note">Loading the golden’s checks…</p>}
      </Dialog>
    );
  }
  return <Asked golden={golden} check={check} cfg={cfg.data} readError={cfg.error ? messageOf(cfg.error) : null} reread={cfg.reload} title={title} onClose={onClose} onChanged={onChanged} />;
}

interface AskedProps extends RemoveProps {
  cfg: ChecksConfig;
  /** Why reading the file again failed, said above its lines with Retry. */
  readError: string | null;
  reread: () => void;
  title: ReactNode;
}

/** The dialog once the file is read: the check's lines going, against the version read, and the write. */
function Asked({ golden, check, cfg, readError, reread, title, onClose, onChanged }: AskedProps) {
  const [conflict, setConflict] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);
  const write = useRemove(golden, onChanged);
  const entry = cfg.goldens.find((g) => g.path === golden)!;
  const units = unitsOf(baseOf(entry));
  const at = unitWithLabel(baseOf(entry), check);
  const rest = mergeFragments(units.filter((_, i) => i !== at));
  const remove = async () => {
    setWarn(null);
    const why = await write(cfg, rest);
    if (!why) return true;
    if (why.conflict) {
      setConflict(why.text);
      reread();
    } else setWarn(why.text);
    return false;
  };
  return (
    <Dialog
      title={title}
      lead={leadOf(labelsOf(units[at]!), goldenName(golden), Object.keys(rest).length > 0)}
      doc="checks"
      className="ckrm"
      warn={warn ? { text: warn, tone: 'amber' } : null}
      ok={conflict ? 'Remove again' : 'Remove check'}
      tone="danger"
      initialFocus="cancel"
      okWhy={readError ? 'shadowlap.config.json couldn’t be read again: Retry it above its lines' : null}
      okSub="Only if shadowlap.config.json is as this page read it: a change made since is never overwritten"
      onOk={remove}
      onClose={onClose}
    >
      <Change bare cfg={cfg} error={readError} retry={reread} golden={entry} merged={rest} changed conflict={conflict} judgeAdded={false} runId={null} />
    </Dialog>
  );
}

/**
 * The write: the golden's entry without the check, against the version read. Null once written, after
 * its toast with Undo; else why not, a file changed since apart.
 */
function useRemove(golden: string, onChanged: () => void) {
  const { client, toast } = useApp();
  const undo = async (was: string) => {
    try {
      await client.checks.undo(was);
    } catch (err) {
      toast(errorText(err), 'error');
      return;
    }
    onChanged();
    toast(`Back in shadowlap.config.json · ${golden}`);
  };
  return async (cfg: ChecksConfig, rest: Fragment): Promise<{ text: string; conflict: boolean } | null> => {
    let saved: ChecksSaved;
    try {
      saved = await client.checks.save({ golden, version: cfg.version, read: cfg.read, entry: { expect: Object.keys(rest).length ? rest : null } });
    } catch (err) {
      return { text: messageOf(err), conflict: err instanceof ApiError && err.status === 409 && /since this page read it/.test(err.message) };
    }
    onChanged();
    const was = saved.was;
    toast(`Check removed · ${goldenName(golden)}`, 'notice', was ? { label: 'Undo', undo: true, run: () => void undo(was) } : undefined);
    return null;
  };
}

/**
 * Remove's lead: the check's labels in code, joined to "Removes" so the first never starts a line,
 * then what stays of the golden's checks, where something does.
 */
function leadOf(labels: readonly string[], name: string, left: boolean): ReactNode {
  return (
    <>
      Removes{' '}
      {labels.map((l, i) => (
        <Join key={`${l}:${i}`}>
          {i ? (i === labels.length - 1 ? ' and ' : ', ') : null}
          <CheckCode label={l} />
        </Join>
      ))}
      {` from ${name}’s entry in shadowlap.config.json`}
      {left ? '; its other checks stay.' : labels.length > 1 ? ', its only checks.' : ', its only check.'}
    </>
  );
}

/** A check set as code in prose: it breaks only between its phrases, each whole where its line holds it (checks.css). Its text is the check as the CLI labels it. */
function CheckCode({ label }: { label: string }) {
  return (
    <code className="ckl">
      {checkPhrases(label).map((p, i) => (
        <Join key={i}>
          {i ? ' ' : null}
          <span className="ckp">{p}</span>
        </Join>
      ))}
    </code>
  );
}

/** A check's words, split at its spaces outside a quotation, brackets or a tool's arguments. */
function wordsOf(label: string): string[] {
  const words: string[] = [];
  let cur = '';
  let quote = false;
  let depth = 0;
  for (const ch of label) {
    if (ch === ' ' && !quote && !depth) {
      words.push(cur);
      cur = '';
      continue;
    }
    if (ch === '"') quote = !quote;
    else if (!quote && '{[('.includes(ch)) depth++;
    else if (!quote && '}])'.includes(ch)) depth--;
    cur += ch;
  }
  return [...words, cur];
}

/**
 * Where a check set as code in prose may break (§16 Line breaks rule 6): after its rule's head
 * (`every issue_refund call:`, `when lookup_order has`), after the colon that ends a condition and
 * after a comma, and before an `and` in a condition or a judge's `answers`; never inside a quotation,
 * brackets or a tool's arguments. Joined by spaces, its phrases are the label again.
 */
export function checkPhrases(label: string): string[] {
  const words = wordsOf(label);
  const out: string[][] = [[]];
  let cond = words[0] === 'when';
  words.forEach((w, i) => {
    const p = out[out.length - 1]!;
    if (p.length && (w === 'answers' || (cond && w === 'and'))) out.push([w]);
    else p.push(w);
    if (/[:,]$/.test(w)) {
      if (w.endsWith(':')) cond = false;
      out.push([]);
    } else if (cond && i === 2 && w === 'has') out.push([]);
  });
  return out.filter((p) => p.length).map((p) => p.join(' '));
}
