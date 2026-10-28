import { palette as p } from './ui.js';

/**
 * The progress blame, verify and repair print on stderr, a line at a time. In a terminal, attempt
 * lines one after another (`attempt 3  ✓ passed · …`, `target    01J…  attempt 2  ✗ …`, `good  01J…
 * baseline 4  ✓ …`) fold into one line that counts them, rewritten as each comes, and the next line
 * of any other kind, a probe's verdict or a run's, takes its place: the steps and their verdicts stay
 * in view, and every attempt is a run in the store all the same. Blame's pairs, when it checks a
 * pinned call (`pair 2, #5  ✓ …`), fold alike into one line that counts each call's. Written anywhere
 * else (CI's log, a file, the dashboard's jobs), or with `fold` false (-v), every line is kept as it
 * comes.
 */
export interface ProgressLog {
  log: (line: string) => void;
  /** Clears the folded line, before a report or an error is printed. */
  done: () => void;
}

/** An attempt's line: its indent, then a role and run (verify's), then `attempt n` or `baseline n` and its mark. */
const ATTEMPT = /^(\s*)(?:\S+\s+\S+\s+)?(?:attempt|baseline) \d+ {2}(\S)/;
/** One attempt of a pair blame's check of a pinned call runs: its indent, `pair n, #k` and its mark. */
const PAIR = /^(\s*)pair (\d+), #(\d+) {2}(\S)/;
/** The colours a line carries, which say nothing of what it is. */
const COLOURS = /\x1b\[[0-9;]*m/g;
const CLEAR = '\r\x1b[2K';

interface Counts {
  passed: number;
  failed: number;
  undecided: number;
}

interface Tally extends Counts {
  kind: 'attempt' | 'pair';
  indent: string;
  /** For pairs: the most pairs a line has named, and each call's attempts, by its number. */
  pairs: number;
  calls: Map<number, Counts>;
}

const counted = (c: Counts) => [`${c.passed} passed`, ...(c.failed ? [`${c.failed} failed`] : []), ...(c.undecided ? [`${c.undecided} not decided`] : [])].join(', ');

function add(c: Counts, mark: string | undefined): void {
  if (mark === '✓') c.passed++;
  else if (mark === '?') c.undecided++;
  else c.failed++;
}

export function progressLog(stream: NodeJS.WriteStream = process.stderr, fold = true): ProgressLog {
  const folding = fold && stream.isTTY === true && process.env.TERM !== 'dumb';
  if (!folding) return { log: (line) => void stream.write(`${line}\n`), done: () => {} };

  // Where the folded line shows, anything else written meanwhile, to stderr or to stdout on the same
  // terminal (a warning), goes above it, and the line comes back under it.
  const streams = [stream, ...(process.stdout !== stream && process.stdout.isTTY ? [process.stdout] : [])];
  const writes = new Map<NodeJS.WriteStream, NodeJS.WriteStream['write']>();
  const raw = (text: string) => (writes.get(stream) ?? stream.write).call(stream, text);
  let tally: Tally | null = null;
  let shown = false;

  const text = (t: Tally) => {
    const n = t.passed + t.failed + t.undecided;
    const line =
      t.kind === 'pair'
        ? `${t.indent}${t.pairs} pair${t.pairs === 1 ? '' : 's'}: ${[...t.calls]
            .sort(([a], [b]) => a - b)
            .map(([callNo, c]) => `#${callNo} ${counted(c)}`)
            .join(' · ')}`
        : `${t.indent}${n} attempt${n === 1 ? '' : 's'}: ${counted(t)}`;
    // Never wider than the terminal, which would wrap it onto a line \r can't take back.
    const width = (stream.columns || 80) - 1;
    return p.dim(line.length > width ? line.slice(0, Math.max(width - 1, 0)) + '…' : line);
  };
  const clear = () => {
    if (!shown) return;
    raw(CLEAR);
    shown = false;
  };
  const show = () => {
    if (!tally) return;
    raw(`${CLEAR}${text(tally)}`);
    shown = true;
  };
  const hook = () => {
    if (writes.size) return;
    for (const s of streams) {
      // eslint-disable-next-line @typescript-eslint/unbound-method -- kept to be put back as it was, and called on its own stream
      const write = s.write;
      writes.set(s, write);
      s.write = (chunk: unknown, ...rest: unknown[]) => {
        const again = shown;
        clear();
        const ok = (write as (...args: unknown[]) => boolean).call(s, chunk, ...rest);
        if (again && String(chunk).endsWith('\n')) show();
        return ok;
      };
    }
  };
  const unhook = () => {
    for (const [s, write] of writes) s.write = write;
    writes.clear();
  };

  return {
    log(line: string) {
      const plain = line.replace(COLOURS, '');
      const attempt = ATTEMPT.exec(plain);
      const pair = attempt ? null : PAIR.exec(plain);
      if (attempt || pair) {
        const kind = pair ? 'pair' : 'attempt';
        const indent = (attempt ?? pair)![1]!;
        if (!tally || tally.indent !== indent || tally.kind !== kind) tally = { kind, indent, passed: 0, failed: 0, undecided: 0, pairs: 0, calls: new Map() };
        if (pair) {
          const callNo = Number(pair[3]);
          const call = tally.calls.get(callNo) ?? { passed: 0, failed: 0, undecided: 0 };
          tally.calls.set(callNo, call);
          tally.pairs = Math.max(tally.pairs, Number(pair[2]));
          add(call, pair[4]);
        }
        add(tally, pair ? pair[4] : attempt![2]);
        hook();
        show();
        return;
      }
      clear();
      raw(`${line}\n`);
      // A line nearer the margin starts what comes next (a probe, a candidate): its attempts count afresh.
      const indent = /^\s*/.exec(plain)![0];
      if (tally && indent.length < tally.indent.length) tally = null;
    },
    done() {
      clear();
      unhook();
      tally = null;
    },
  };
}
