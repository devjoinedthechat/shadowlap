import { useEffect, useRef, useState } from 'react';
import { messageOf } from '../../../engine/src/message-of.js';

/** How long the builder waits after the last change to a draft before it is judged. */
export const SETTLE_MS = 300;

/** A draft as the builder last drew it judged: the answer to the draft as it stands, the last answer of any draft, and whether the newest is being judged. */
export interface Judging<T> {
  answer: T | null;
  last: T | null;
  pending: boolean;
}

/** As judging stands, with why the last read failed and a way to ask again. */
export type Judged<T> = Judging<T> & { error: string | null; retry: () => void };

interface Got<T> {
  /** The draft the answer is to. */
  key: string | null;
  answer: T | null;
  error: string | null;
}

/**
 * A draft judged beside the server: asked about 300 ms after its last change, at most one read in
 * flight, since the pool can't stop one, and the newest draft sent when the last answers. An answer
 * to an older draft is dropped, so what is drawn is always the draft's own: until it comes, the draft
 * is being judged. A failed read says so and keeps the last answer. `key` is the draft with all that
 * its answer depends on, null for nothing to judge, and `ask` reads the answer to it: the golden
 * mode's recordings (Builder.tsx), a fix's runs (FixMode.tsx) and the rules suggested beside them
 * (Suggested.tsx) alike.
 */
export function useJudged<T>(key: string | null, ask: (key: string) => Promise<T>): Judged<T> {
  const [got, setGot] = useState<Got<T>>({ key: null, answer: null, error: null });
  const [tries, setTries] = useState(0);
  const flying = useRef(false);
  const waiting = useRef(false);
  const want = useRef<string | null>(null);
  const alive = useRef(true);
  // The newest way to ask, so a draft sent later reads with the client the page has then.
  const asking = useRef(ask);
  useEffect(() => {
    asking.current = ask;
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
      const done = (next: (g: Got<T>) => Got<T>) => {
        flying.current = false;
        if (!alive.current) return;
        if (want.current === k) setGot(next);
        else if (!waiting.current) send();
      };
      asking.current(k).then(
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
