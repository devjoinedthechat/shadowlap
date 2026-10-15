import { useEffect, useState } from 'react';
import { useApp } from '../state.js';

/** One toast at a time, at the bottom: a newer one replaces it. Call `useApp().toast(text)`. */
export function ToastHost() {
  const { toastText } = useApp();
  const [shown, setShown] = useState<{ id: number; text: string } | null>(null);
  useEffect(() => {
    if (!toastText) return;
    setShown(toastText);
    const t = setTimeout(() => setShown((s) => (s?.id === toastText.id ? null : s)), 2600);
    return () => clearTimeout(t);
  }, [toastText]);
  if (!shown) return null;
  return (
    <div className="toast" role="status" key={shown.id}>
      <i />
      {shown.text}
    </div>
  );
}
