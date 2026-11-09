import { useEffect, useRef, useState } from 'react';
import { messageOf } from '../../../engine/src/message-of.js';

/** How long the builder waits after the last change to what it asks before it reads. */
export const SETTLE_MS = 300;

export interface SettledRead<T> {
  /** The answer to what is asked now; null until it comes. */
  answer: T | null;
  /** The last answer that came, to what was asked then. */
  last: T | null;
  /** Something is asked whose answer hasn't come. */
  pending: boolean;
  /** Why the last read failed; the last answer stays. */
  error: string | null;
  retry: () => void;
}

/**
 * A read of the check builder's, asked about 300 ms after what it asks (`key`, JSON, or null for
 * nothing) last changed, at most one in flight, since the pool can't stop one, and the newest sent
 * when the last answers. An answer to an older key is dropped, so `answer` is always the key's own:
 * until it comes, it is pending. A failed read says so and keeps the last answer. The draft's
 * preview and the suggested checks are both read so. `read` is the one at the time the read is sent.
 */
export function useSettledRead<T>(key: string | null, read: (key: string) => Promise<T>): SettledRead<T> {
  const [got, setGot] = useState<{ key: string | null; answer: T | null; error: string | null }>({ key: null, answer: null, error: null });
  const [tries, setTries] = useState(0);
  const flying = useRef(false);
  const waiting = useRef(false);
  const want = useRef<string | null>(null);
  const alive = useRef(true);
  const reader = useRef(read);
  useEffect(() => {
    reader.current = read;
  });
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    want.current = key;
    const send = () => {
      const k = want.current;
      if (k === null || flying.current) return;
      flying.current = true;
      const done = (next: (g: typeof got) => typeof got) => {
        flying.current = false;
        if (!alive.current) return;
        if (want.current === k) setGot(next);
        else if (!waiting.current) send();
      };
      reader.current(k).then(
        (answer) => done(() => ({ key: k, answer, error: null })),
        (err: unknown) => done((g) => ({ ...g, error: messageOf(err) })),
      );
    };
    waiting.current = true;
    const t = setTimeout(() => {
      waiting.current = false;
      send();
    }, SETTLE_MS);
    return () => {
      clearTimeout(t);
      waiting.current = false;
    };
  }, [key, tries]);
  const own = got.key === key;
  return { answer: own ? got.answer : null, last: got.answer, pending: key !== null && !own, error: got.error, retry: () => setTries((t) => t + 1) };
}
