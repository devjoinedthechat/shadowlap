/**
 * Settings changed from outside its tabs (the job drawer added the normalizers a calibration
 * proposed): an open tab reads its data again.
 */

const listeners = new Set<() => void>();

export function settingsChanged(): void {
  for (const l of listeners) l();
}

export function onSettingsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
