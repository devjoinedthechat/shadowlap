/**
 * Turns for the goldens of a `shadowlap test` session, so their attempts interleave: one attempt runs
 * at a time, and a golden that wants another waits behind every golden already waiting. A golden takes
 * a turn before each attempt and gives it back once the attempt has ended, then asks again, so the
 * goldens still open go round in the order they first asked: the first attempt of each, then the
 * second of each still undecided, and so on.
 *
 * Why: a gate takes its attempts to be independent draws of the agent's pass rate. Failures that come
 * in bursts (a provider slow for a minute, a rate limit, a shared service down) break that, and a
 * burst that lands on one golden's attempts in a row can fail a healthy golden on its own; spread
 * over the goldens in turn, the same burst costs each of them an attempt or two. The engine's tests
 * work out how much that matters (gate-dependence.test.ts in packages/cli/test).
 */
export class Turns {
  private holder = false;
  private readonly waiting: Array<() => void> = [];
  private closed = false;

  /** Waits for this golden's turn; resolves with what gives it back. After `close`, every turn is given at once. */
  take(): Promise<() => void> {
    return new Promise((resolve) => {
      const go = () => {
        this.holder = true;
        let given = false;
        resolve(() => {
          if (given) return;
          given = true;
          this.holder = false;
          this.next();
        });
      };
      if (this.closed || !this.holder) go();
      else this.waiting.push(go);
    });
  }

  /** Lets every golden waiting go, and every later one at once: a session that stops lets each golden see it has stopped. */
  close(): void {
    this.closed = true;
    for (const go of this.waiting.splice(0)) go();
  }

  private next(): void {
    if (this.holder) return;
    this.waiting.shift()?.();
  }
}
