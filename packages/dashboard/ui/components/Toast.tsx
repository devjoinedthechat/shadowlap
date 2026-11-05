import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isMac, isTyping } from '../dom.js';
import { focusBack, openerOf, type Opener } from '../overlays/focus-back.js';
import { onOverlayChange } from '../overlays/modal-store.js';
import { useSingleKeys } from '../single-keys.js';
import { useApp } from '../state.js';
import { placeToast, retoast } from '../toast-place.js';
import { ACTION_TOAST_MS, actionSaid, announce, setAnnouncer, TOAST_MS, toastKey, UNDO_CHORDS, UNDO_SHORTCUTS, type ToastAction } from '../toast.js';

type Shown = NonNullable<ReturnType<typeof useApp>['toastText']>;

/**
 * ⌘Z, or Ctrl Z, and the undo key do what an Undo on the screen offers, from anywhere but a field
 * being typed in. Ahead of a menu or a dialog: it works over them.
 */
function useUndoKeys(shown: Shown | null, out: boolean, conn: string, act: (t: Shown, action: ToastAction) => void): void {
  useEffect(() => {
    const action = shown?.action;
    if (!shown || !action?.undo || out) return;
    const run = () => (act(shown, action), true);
    toastKey.current = run;
    const key = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.key.toLowerCase() !== 'z' || isTyping(e) || conn === 'expired') return;
      e.preventDefault();
      e.stopPropagation();
      run();
    };
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('keydown', key, true);
      if (toastKey.current === run) toastKey.current = null;
    };
  }, [shown, out, act, conn]);
}

/**
 * One toast at a time, centred on the content over what sits at its foot (`toast-place.ts`), fading in
 * and out: a newer one replaces it at once. Call `useApp().toast(text)`, or for a refusal or a failure
 * `toast(text, 'error')`: a red dot, read out at once, a ×, and it stays for 8 seconds. Any other is
 * said in one polite region that is always on the page, apart from what shows, and goes after 5
 * seconds. With an action (`toast(text, 'notice', { label, run })`) it has a button, and stays 8
 * seconds, held while the pointer or the focus is on the button. Pressing it closes the toast, the
 * focus going back where the change was made. Only an Undo answers ⌘Z and the undo key, never a way
 * on. Esc or Tab on the button hands the focus back, as does a toast that goes while holding it.
 */
export function ToastHost() {
  const { toastText, conn } = useApp();
  const [shown, setShown] = useState<Shown | null>(null);
  const [out, setOut] = useState(false);
  const [said, setSaid] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const from = useRef<Opener | null>(null);
  const live = useRef<Shown | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // One polite live region, there from the start: emptied first, so the same words are said again.
  useEffect(() => {
    let wait: ReturnType<typeof setTimeout> | undefined;
    const say = (text: string) => {
      clearTimeout(wait);
      setSaid('');
      wait = setTimeout(() => setSaid(text), 60);
    };
    setAnnouncer(say);
    return () => {
      clearTimeout(wait);
      setAnnouncer(null);
    };
  }, []);

  const back = useCallback(() => {
    if (from.current) focusBack(from.current);
  }, []);

  /** Takes the toast away; the focus, when it was in it or the toast was acted on, back where the change was made. */
  const leave = useCallback(
    (t: Shown, acted: boolean) => {
      clearTimeout(timer.current);
      if (live.current?.id !== t.id) return;
      live.current = null;
      t.action?.onGone?.(acted);
      if (acted || box.current?.contains(document.activeElement)) back();
      setOut(true);
      const fades = typeof matchMedia === 'function' && !matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (!fades) setShown((s) => (s?.id === t.id ? null : s));
      else setTimeout(() => setShown((s) => (s?.id === t.id ? null : s)), 160);
    },
    [back],
  );

  const wait = useCallback(
    (t: Shown) => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => leave(t, false), t.kind === 'error' ? TOAST_MS.error : t.action ? ACTION_TOAST_MS : TOAST_MS.notice);
    },
    [leave],
  );

  // A newer toast takes the place of the one on the screen at once, taking its time with it, and the
  // focus it held goes back first.
  useEffect(() => {
    const was = live.current;
    if (!toastText) {
      if (was) leave(was, false);
      return;
    }
    if (was?.id === toastText.id) return;
    const a = document.activeElement as HTMLElement | null;
    const held = !!box.current?.contains(a);
    if (was) {
      clearTimeout(timer.current);
      was.action?.onGone?.(false);
      if (held) back();
    }
    const opener = toastText.action?.returnTo ?? (held ? null : a);
    if (opener || !held) from.current = openerOf(opener && opener !== document.body ? opener : null);
    live.current = toastText;
    setOut(false);
    setShown(toastText);
    if (toastText.kind !== 'error') announce(`${toastText.text}${toastText.action ? actionSaid(toastText.action, isMac()) : ''}`);
  }, [toastText, leave, back]);

  // Drawn at its place the first time; a way out that takes the focus keeps the toast while it holds it.
  useLayoutEffect(() => {
    if (!shown || live.current?.id !== shown.id) return;
    if (box.current) placeToast(box.current);
    const b = button.current;
    if (shown.action?.focus && b) {
      b.focus({ preventScroll: true });
      if (document.activeElement === b) return;
    }
    wait(shown);
  }, [shown, wait]);

  // Placed again as what sits under it moves: a dialog or a sheet, the window's size. What sits at
  // the content's foot says so itself (the job's drawer, its chip, the bulk bar).
  useEffect(() => {
    const stop = onOverlayChange(retoast);
    window.addEventListener('resize', retoast);
    return () => {
      stop();
      window.removeEventListener('resize', retoast);
    };
  }, []);

  const act = useCallback(
    (t: Shown, action: ToastAction) => {
      leave(t, true);
      action.run();
    },
    [leave],
  );

  useUndoKeys(shown, out, conn, act);

  const singleKeys = useSingleKeys();
  const body = shown ? (
    <div className={`toast${shown.kind === 'error' ? ' err' : ''}${out ? ' out' : ''}`} key={shown.id} ref={box}>
      <i />
      <span>{shown.text}</span>
      {shown.action ? (
        <button
          type="button"
          className="tbtn"
          ref={button}
          aria-keyshortcuts={shown.action.undo ? (singleKeys ? UNDO_SHORTCUTS : UNDO_CHORDS) : undefined}
          onClick={() => act(shown, shown.action!)}
          onPointerEnter={() => clearTimeout(timer.current)}
          onPointerLeave={() => {
            if (!box.current?.contains(document.activeElement)) wait(shown);
          }}
          onFocus={() => clearTimeout(timer.current)}
          onBlur={() => wait(shown)}
          onKeyDown={(e) => {
            if (e.key !== 'Escape' && e.key !== 'Tab') return;
            e.preventDefault();
            e.stopPropagation();
            back();
          }}
        >
          {shown.action.label}
        </button>
      ) : null}
      {shown.kind === 'error' ? (
        <button type="button" className="tx" aria-label="Dismiss" title="Dismiss" onClick={() => leave(shown, true)}>
          ×
        </button>
      ) : null}
    </div>
  ) : null;
  return (
    <>
      <div className="sr" role="status" aria-live="polite">
        {said}
      </div>
      {shown?.kind !== 'error' ? body : null}
      <div className="toasts" role="alert" aria-atomic="true">
        {shown?.kind === 'error' ? body : null}
      </div>
    </>
  );

}
