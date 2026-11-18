/**
 * Time for tests that hold how long something takes against something else this machine does in
 * the same test, never against a number of milliseconds, which a slow machine goes past with nothing
 * wrong: such a machine is slow for both alike. Time here is CPU time, which a busy machine does not
 * inflate the way it does wall-clock time.
 */

/** CPU milliseconds this process has spent since `since`, a reading of process.cpuUsage(). */
function cpuSince(since: NodeJS.CpuUsage): number {
  const used = process.cpuUsage(since);
  return (used.user + used.system) / 1000;
}

/**
 * How long one call of each of `work` takes here, in CPU milliseconds. Each is called over and over
 * until a round has taken `atLeast` ms: 50 by default, and 250 on Windows, whose clock counts CPU time
 * in ticks of 15.6 ms, so a round of 50 could be off by a third and one of 250 by a sixteenth. The least
 * of `rounds` rounds is kept: what the work costs, since a pause (a collection, code not
 * yet compiled) only ever adds to a round. The rounds take each in turn, so whatever else the machine
 * does meanwhile reaches all of them alike.
 */
export function timesOf<K extends string>(work: Record<K, () => unknown>, options: { rounds?: number; atLeast?: number } = {}): Record<K, number> {
  const { rounds = 3, atLeast = process.platform === 'win32' ? 250 : 50 } = options;
  const names = Object.keys(work) as K[];
  const least = Object.fromEntries(names.map((name) => [name, Infinity])) as Record<K, number>;
  for (let round = 0; round < rounds; round++) {
    for (const name of names) {
      const started = process.cpuUsage();
      let calls = 0;
      let ms: number;
      do {
        work[name]();
        calls++;
        ms = cpuSince(started);
      } while (ms < atLeast);
      least[name] = Math.min(least[name], ms / calls);
    }
  }
  return least;
}

/** CPU milliseconds one call of `fn` takes, with what it returned: for work that a second call would find done. */
export function cpuOnce<T>(fn: () => T): { out: T; ms: number } {
  const started = process.cpuUsage();
  const out = fn();
  return { out, ms: cpuSince(started) };
}

/** CPU milliseconds the promise `fn` returns takes to settle, with its value: everything this process does meanwhile, its other threads' too. */
export async function cpuOnceAsync<T>(fn: () => Promise<T>): Promise<{ out: T; ms: number }> {
  const started = process.cpuUsage();
  const out = await fn();
  return { out, ms: cpuSince(started) };
}

/** `a` as a multiple of `b`, for a failure's message. */
export const times = (a: number, b: number): string => `${(a / b).toFixed(a / b < 10 ? 2 : 0)} times`;
