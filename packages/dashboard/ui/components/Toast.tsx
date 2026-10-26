import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../state.js';
import { ACTION_TOAST_MS, TOAST_MS, toastKey, UNDO_KEY, type ToastAction } from '../toast.js';

/**
 * One toast at a time, at the bottom: a newer one replaces it. Call `useApp().toast(text)`, or for a
 * refusal or a failure `toast(text, 'error')`: a red dot, read out at once, and it stays until
 * dismissed or for 8 seconds (`toast.ts`). A notice with an action (`toast(text, 'notice', { label:
 * 'Undo', run, returnTo })`) has its button and the undo key (u), and stays seven seconds; using
 * either closes the toast and hands the focus back to `returnTo`. Each is said in a live region that
 * is always on the page (a status for a notice, an alert for an error), so a screen reader hears its
 * text arrive rather than an element that came with it.
 */
export function ToastHost() {
  const { toastText } = useApp();
  const [shown, setShown] = useState<typeof toastText>(null);
  const box = useRef<HTMLDivElement>(null);

  /** Takes the toast away; the focus, when it was in it or the toast was acted on, back where the change was made. */
  const leave = useCallback((t: NonNullable<typeof toastText>, acted: boolean) => {
    const inside = !!box.current && !!document.activeElement && box.current.contains(document.activeElement);
    setShown((s) => (s?.id === t.id ? null : s));
    if (!inside && !acted) return;
    const back = t.action?.returnTo;
    const to = back && back.isConnected ? back : document.querySelector<HTMLElement>('main#view');
    to?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (!toastText) return;
    setShown(toastText);
    const t = setTimeout(() => leave(toastText, false), toastText.action && toastText.kind === 'notice' ? ACTION_TOAST_MS : TOAST_MS[toastText.kind]);
    return () => clearTimeout(t);
  }, [toastText, leave]);

  const act = useCallback(
    (t: NonNullable<typeof toastText>, action: ToastAction) => {
      leave(t, true);
      action.run();
    },
    [leave],
  );

  // The undo key does what the toast on screen offers, while it is there.
  useEffect(() => {
    const action = shown?.kind === 'notice' ? shown.action : undefined;
    if (!shown || !action) return;
    const run = () => (act(shown, action), true);
    toastKey.current = run;
    return () => {
      if (toastKey.current === run) toastKey.current = null;
    };
  }, [shown, act]);

  const action = shown?.kind === 'notice' ? shown.action : undefined;
  return (
    <>
      <div className="toasts" role="status" aria-live="polite" aria-atomic="true">
        {shown && shown.kind !== 'error' ? (
          <div className="toast" key={shown.id} ref={box}>
            <i />
            {shown.text}
            {action ? (
              <>
                <button type="button" className="tact" aria-keyshortcuts={UNDO_KEY} title={`${action.label} (${UNDO_KEY})`} onClick={() => act(shown, action)}>
                  {action.label}
                </button>
                <kbd className="tkey" aria-hidden="true">
                  {UNDO_KEY}
                </kbd>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="toasts" role="alert" aria-atomic="true">
        {shown?.kind === 'error' ? (
          <div className="toast err" key={shown.id} ref={box}>
            <i />
            <span>{shown.text}</span>
            <button type="button" className="tx" aria-label="Dismiss" title="Dismiss" onClick={() => leave(shown, true)}>
              ×
            </button>
          </div>
        ) : null}
      </div>
    </>
  );
}
