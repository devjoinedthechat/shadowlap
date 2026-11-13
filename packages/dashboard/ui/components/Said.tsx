import { useEffect, useState } from 'react';

/**
 * A line that tells of a change (nothing found for the words typed, a wait that starts, a paste
 * refused), said by a live region on the page before its words: one drawn with its words already in
 * it may never be heard. Drawn hidden and empty from the first, it takes `words` only once it has been
 * drawn; the line the page draws for them is for the eye (aria-hidden), as the offline bar's is. Its
 * anchor (`.said`) keeps it where the line is read. `alert`: a refusal, said at once.
 */
export function Said({ words, alert = false }: { words: string | null; alert?: boolean }) {
  const [drawn, setDrawn] = useState(false);
  useEffect(() => setDrawn(true), []);
  return (
    <span className="said">
      <span className="sr" role={alert ? 'alert' : 'status'}>
        {drawn && words ? words : ''}
      </span>
    </span>
  );
}
