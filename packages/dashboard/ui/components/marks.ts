import { createContext, type ReactNode } from 'react';

/**
 * What the inspector's text goes through as it draws, and what it says of the call a replay changed.
 * An injection attempt's page marks its canary and its planted text (injection/marks.tsx builds them
 * from the attempt's read); on any other run, and in a copy, the text draws as it is and the words
 * stay the inspector's own.
 */
export interface Marks {
  /** The text with each thing marked in a `<mark>`. */
  mark: (text: string) => ReactNode;
  /** Whether a value holds a marked thing: the JSON tree opens such a branch and shows such a string whole. */
  holds: (value: unknown) => boolean;
  /** The changed turn's label, in place of `changed in this replay`. */
  changed: string | null;
  /** The Response tab's head for a call, in place of `The recorded result:`; null where the inspector's own stands. */
  head: (callNo: number) => ReactNode;
}

export const NO_MARKS: Marks = { mark: (text) => text, holds: () => false, changed: null, head: () => null };

export const MarksContext = createContext<Marks>(NO_MARKS);
