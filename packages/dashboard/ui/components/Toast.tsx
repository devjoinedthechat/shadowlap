import { useEffect, useState } from 'react';
import { useApp } from '../state.js';
import { TOAST_MS } from '../toast.js';

/**
 * One toast at a time, at the bottom: a newer one replaces it. Call `useApp().toast(text)`, or for a
 * refusal or a failure `toast(text, 'error')`: a red dot, read out at once, and it stays until
 * dismissed or for 8 seconds (`toast.ts`).
 */
export function ToastHost() {
  const { toastText } = useApp();
  const [shown, setShown] = useState<typeof toastText>(null);
  useEffect(() => {
    if (!toastText) return;
    setShown(toastText);
    const t = setTimeout(() => setShown((s) => (s?.id === toastText.id ? null : s)), TOAST_MS[toastText.kind]);
    return () => clearTimeout(t);
  }, [toastText]);
  if (!shown) return null;
  if (shown.kind === 'error')
    return (
      <div className="toast err" role="alert" key={shown.id}>
        <i />
        <span>{shown.text}</span>
        <button type="button" className="tx" aria-label="Dismiss" title="Dismiss" onClick={() => setShown(null)}>
          ×
        </button>
      </div>
    );
  return (
    <div className="toast" role="status" key={shown.id}>
      <i />
      {shown.text}
    </div>
  );
}
