/** Small browser helpers. Nothing runs at import time. */

export function copyText(text: string): Promise<boolean> {
  const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (!clip) return Promise.resolve(false);
  return clip.writeText(text).then(
    () => true,
    () => false,
  );
}

export function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

/** ⌘K on a Mac, Ctrl K elsewhere. */
export function paletteKeyLabel(): string {
  return isMac() ? '⌘K' : 'Ctrl K';
}

/** Whether the keyboard event is typing into a field, where single-key shortcuts must not fire. */
export function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}
