import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { askWords, type Spending } from '../../../../engine/src/estimates/spending.js';
import { parseSpending, SPENDING_PICKS, spendingField, spendingWords } from '../../../../engine/src/estimates/spending-row.js';
import { useActionWait } from '../../components/ActionButton.js';
import { Words } from '../../components/Copy.js';
import { SegmentedControl } from '../../components/Segmented.js';
import { coarsePointer } from '../../dom.js';
import { showSpending, showSpendingFacts, spendingNow, takeSpendingFocus, useSpending, useSpendingFacts, type SpendingClient } from '../../spending.js';
import { useApp } from '../../state.js';
import { errorText } from '../../toast.js';

/**
 * Keeps a threshold (`PUT /api/user/spending`), shown at once; answers what it was, for Undo. One
 * the server refuses puts back what showed, and throws why. Here with the row, the one control that
 * keeps one, so the first look doesn't load it.
 */
export async function saveSpending(client: SpendingClient, v: Spending): Promise<Spending> {
  const api = client?.estimates;
  if (!api) throw new Error('Spending is kept by the dashboard server, which this page has none of');
  const before = spendingNow();
  showSpending(v);
  try {
    const kept = await api.setSpending(v);
    showSpending(kept.askAbove);
    showSpendingFacts(kept);
    return kept.was;
  } catch (err) {
    showSpending(before);
    throw err;
  }
}

/** Until the server has said the threshold, the row has nothing to change from. */
const UNREAD = 'Spending is read from the dashboard server first';

/**
 * Spending, on Settings → Project, under the project's facts: when a billed job asks before it starts.
 * Its words follow the value, a line a sentence; a dollar field ("no limit" when empty) and four picks
 * beside it, Always ask, $0.50, $2 and Never ask. A pick, or an amount typed (kept on Enter or on
 * leaving the field), is kept at once by the server, per user and never in the config, and a toast says
 * so with Undo. An amount that isn't one puts the field back and says what one is. The row says the
 * new value where it stands, so the focus stays where it was. Change, on an ask's footer, lands here:
 * the field, or on a touch screen the pick pressed, so no keyboard opens over the row. It waits as
 * every server action does, the value still shown; an exported copy has no row. It says when the value
 * is the default nobody set, and, in amber, what the server ignored in the file and why: a settings.json
 * it can't read, or a relative SHADOWLAP_HOME, unless the page shows it already (`shown`).
 */
export function SpendingRow({ shown = [] }: { shown?: readonly string[] }) {
  const app = useApp();
  const v = useSpending();
  const facts = useSpendingFacts();
  const why = useActionWait(v === undefined ? UNREAD : null);
  const [text, setText] = useState<string | null>(null);
  const row = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const known = v !== undefined;
  useEffect(() => {
    if (!known || !takeSpendingFocus()) return;
    const to = (coarsePointer() ? row.current?.querySelector<HTMLElement>('[aria-pressed="true"]') : null) ?? field.current;
    to?.focus({ preventScroll: true });
    to?.scrollIntoView({ block: 'nearest' });
  }, [known]);
  if (app.exported) return null;
  const said = (to: Spending) => `${askWords(to)} · on this machine`;
  const keep = (next: Spending, from: HTMLElement | null) => {
    setText(null);
    if (v === undefined || next === v) return;
    app.guard(() => {
      saveSpending(app.client, next).then(
        (was) => {
          const undo = () => void saveSpending(app.client, was).then(() => app.toast(said(was)), (err: unknown) => app.toast(errorText(err), 'error'));
          app.toast(said(next), 'notice', { label: 'Undo', undo: true, run: undo, returnTo: from });
        },
        (err: unknown) => app.toast(errorText(err), 'error'),
      );
    });
  };
  const typed = () => {
    if (text === null) return;
    const got = parseSpending(text);
    if (got.ok) return keep(got.value, field.current);
    setText(null);
    app.toast(got.why);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') typed();
  };
  const active = () => (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  return (
    <div className="setrow spend" id="spending" ref={row}>
      <div>
        <b>Spending</b>
        <span className="spendsay">
          {known
            ? spendingWords(v).map((line) => (
                <span key={line} className="ln">
                  <Words>{line}</Words>
                </span>
              ))
            : null}
          {known && facts && !facts.set ? <span className="ln">The default, until you change it.</span> : null}
          {/* What the server ignored in the file and why: a broken settings.json, a relative SHADOWLAP_HOME. */}
          {(facts?.problems ?? []).filter((p) => !shown.includes(p)).map((p) => (
            <span key={p} className="ln spendbad">
              {p}
            </span>
          ))}
        </span>
      </div>
      <div className="spendset">
        <label className="spendf">
          <span aria-hidden="true">$</span>
          <input
            ref={field}
            className="inp"
            id="askAbove"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            aria-label="Ask before spending more than, in dollars"
            placeholder="no limit"
            readOnly={!!why}
            title={why ?? undefined}
            value={text ?? (known ? spendingField(v) : '')}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            onBlur={typed}
          />
        </label>
        <SegmentedControl label="Ask before spending" action why={why} items={SPENDING_PICKS.map((p) => ({ key: String(p.value), label: p.label }))} value={known ? String(v) : ''} onChange={(k) => keep(SPENDING_PICKS.find((p) => String(p.value) === k)!.value, active())} />
      </div>
    </div>
  );
}
