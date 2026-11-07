import { decisionLine, decisionStepState, judgedOutcome, judgeOpen, RANK_LABELS, samplesWords, type DecisionRank, type DecisionRun, type DecisionStep, type DecisionStepState } from '@shadowlap/engine';

/**
 * A preview's matrix as Changes and a run's Decisions view draw it: a row per run, a cell per model
 * call, each worded on the server from the engine's words (`samplesWords`, `decisionLine`,
 * `RANK_LABELS`), since a page can't load the engine's decisions module. Pure functions of a kept
 * run's part of a session.
 */

/**
 * One model call in a run's row of the matrix: its rank (the most consequential change any sample
 * showed; 0 the same, null not asked), the rank most of its samples show (`majority`, which flags
 * the run), how often it changed, for a cell drawn split, and how the judge checks that read a
 * text-only change came out (`judge`).
 */
export interface DecisionCell {
  callNo: number;
  step: number;
  rank: number | null;
  majority: number | null;
  changed: number;
  answered: number;
  /**
   * For a text-only change a judge check reads (judgedOutcome): `inconclusive` when the step waits on
   * a judge (the words of a sample could not be judged, and its samples don't flag it without them),
   * else `changed` when a check comes out otherwise for the new words (the cell ranks 2), `unchanged`
   * when every one came out as recorded; null when no check read it.
   */
  judge: 'changed' | 'inconclusive' | 'unchanged' | null;
  /**
   * What came of it (decisionStepState): ranked; `unsettled`, waiting on its control, drawn as not
   * asked; `noise`, within the model's own variation; the same; not asked; `left` as recorded. Every
   * call of a run refused whole is not asked.
   */
  state: DecisionStepState;
  /** The most consequential change any sample showed, ranked or not: what a cell within the model's own variation shows. */
  sampled: number | null;
  /** Each sample's rank (0 the same): a cell whose samples differ is drawn split, a band a sample. */
  ranks: number[];
  /** The request as recorded, asked as often: how many of its answers decided otherwise. Null without the control. */
  control: { changed: number; answered: number } | null;
  /** The change in a few words, its most consequential one's (`send_email is no longer called`); null where nothing changed. */
  detail: string | null;
  /** What it decided, for its card and its label: `send_email is no longer called · in 1 of 3 samples, 0 of 3 as recorded`. */
  words: string;
}

/**
 * What a run's row ends on: the change that flags it, in its colour, else its most consequential
 * change, quiet, and why that doesn't flag it, on the same line.
 */
export interface RowEnding {
  /** `#27 send_email is no longer called`, `the same decisions`, `not asked: …`, `nothing asked`. */
  text: string;
  /** What follows it, quieter: `· within the model's own variation`, `· in 1 of 2, not flagged`; empty for nothing. */
  then: string;
  /** Its colour: `w` a write flags the run (red), `s` a stop, hand-over or judged change (amber), `y` one not asked (amber); null quiet. */
  tone: 'w' | 's' | 'y' | null;
  /** The model call it names; null for none. */
  callNo: number | null;
  /** The steps that wait on a judge. */
  waits: number;
  /** Why, on its card: why the run or its steps could not be asked; null for nothing more. */
  why: string | null;
}

/** A run's row of the matrix: titled by its short id, its golden for a chip, its cells in call order, and what it ends on. */
export interface DecisionRow {
  runId: string;
  golden: string | null;
  /** The run's short id: a row is named by its run, with its about line, as everywhere. */
  title: string;
  rank: number | null;
  /** Whether a write or stop change most of a step's samples show flags it. */
  flagged: boolean;
  cells: DecisionCell[];
  ending: RowEnding;
}

const firstLine = (text: string) => text.split('\n')[0] ?? '';
/** The rank a step's change shows in any sample: the control's `sampled`, else its own rank. */
const sampledOf = (s: Pick<DecisionStep, 'rank' | 'sampled'>): number | null => s.sampled ?? s.rank;
const detailOf = (s: Pick<DecisionStep, 'changes' | 'rank' | 'sampled'>): string | null => {
  const r = sampledOf(s);
  return s.changes[0]?.detail ?? (r ? RANK_LABELS[r as DecisionRank] : null);
};

/** A step's words, the CLI's words in the frame of a cell: what changed and how often, else why it wasn't asked. */
function stepWords(s: DecisionStep, state: DecisionStepState, o: { refused: string | null; fromCode: boolean }): string {
  if (o.refused) return `not asked: ${firstLine(o.refused)}`;
  const detail = detailOf(s) ?? '';
  const several = s.samples.asked > 1;
  switch (state) {
    case 'left':
      return `left as recorded: ${o.fromCode ? 'the working tree sends its prompt unchanged' : `made with ${s.model.recorded ?? 'its recorded model'}`}`;
    case 'not-asked':
      return `not asked: ${s.error ?? 'no answer came'}`;
    case 'unsettled': {
      const c = s.control!;
      const asRecorded = c.answered ? `${c.answered} of ${c.asked} answered as recorded` : 'as recorded, no answer';
      return `${detail} · inconclusive: in ${s.samples.changed} of ${s.samples.answered} samples; ${asRecorded}${c.error ? ` (${c.error})` : ''}: too few to tell from the model's own variation`;
    }
    case 'noise':
      return `${detail} · within the model's own variation: ${samplesWords(s)}`;
    case 'same':
      return `the same${several ? ' in every sample' : ''}: ${decisionLine(s.recorded, 44)}`;
    default:
      return `${detail}${several ? ` · ${samplesWords(s)}` : ''}${!several && judgeOpen(s) ? ' · its words not judged' : ''}`;
  }
}

/** A step's cell. */
export function decisionCell(s: DecisionStep, o: { refused: string | null; fromCode: boolean }): DecisionCell {
  const state: DecisionStepState = o.refused ? 'not-asked' : decisionStepState(s);
  const answered = s.samples.answered;
  return {
    callNo: s.callNo,
    step: s.step,
    rank: s.rank ?? (answered ? 0 : null),
    majority: s.majority ?? (answered === 1 ? s.rank : null) ?? (answered ? 0 : null),
    changed: s.samples.changed,
    answered,
    judge: judgedOutcome(s),
    state,
    sampled: sampledOf(s),
    ranks: [...s.samples.ranks],
    control: s.control ? { changed: s.control.changed, answered: s.control.answered } : null,
    detail: state === 'same' || state === 'left' || state === 'not-asked' ? null : detailOf(s),
    words: stepWords(s, state, o),
  };
}

/** The step a row's ending names: the one that flags it (its majority), else its most consequential change in any sample. */
function topStep(run: DecisionRun, flagged: boolean): DecisionStep | null {
  const best = (of: (s: DecisionStep) => number | null) => {
    let top: DecisionStep | null = null;
    for (const s of run.decisions) {
      const v = of(s);
      if (v && (!top || v < of(top)!)) top = s;
    }
    return top;
  };
  return (flagged ? best((s) => s.majority) : null) ?? best((s) => (decisionStepState(s) === 'unsettled' ? null : sampledOf(s)));
}

/** What a run's row ends on (RowEnding): what flags it, else its biggest change and why it doesn't flag, else what it came to. */
export function rowEnding(run: DecisionRun): RowEnding {
  const end = (text: string, more: Partial<RowEnding> = {}): RowEnding => ({ text, then: '', tone: null, callNo: null, waits: 0, why: null, ...more });
  if (run.refused) return end(`not asked: ${firstLine(run.refused)}`, { tone: 'y', why: run.refused });
  if (!run.asked) {
    const err = run.decisions.find((s) => s.error);
    return err ? end('nothing asked', { why: err.error }) : end('the change leaves its requests as recorded');
  }
  const flagged = run.majority !== null && run.majority <= 2;
  const waits = run.decisions.filter((s) => judgeOpen(s)).length;
  const top = topStep(run, flagged);
  if (!top || sampledOf(top) === 5) {
    const words = run.decisions.filter((s) => s.rank === 5);
    const judged = words.some((s) => s.judge?.length && !judgeOpen(s));
    return end(`the same decisions${words.length ? `, other words at ${words.length} step${words.length === 1 ? '' : 's'}${judged && !waits ? ', judged as recorded' : ''}` : ''}`, { waits });
  }
  const text = `#${top.callNo} ${detailOf(top) ?? ''}`;
  if (decisionStepState(top) === 'noise') return end(text, { then: "· within the model's own variation", callNo: top.callNo, waits });
  const minority = !flagged && top.samples.asked > 1 && top.rank !== null && top.rank <= 2;
  return end(text, { then: minority ? `· ${samplesWords(top, { short: true })}` : '', tone: flagged ? (top.majority === 1 ? 'w' : 's') : null, callNo: top.callNo, waits });
}

/** A run's row: its model calls in call order, each with its rank and words, and what it ends on. */
export function decisionRow(run: DecisionRun, o: { fromCode?: boolean } = {}): DecisionRow {
  const opts = { refused: run.refused, fromCode: !!o.fromCode };
  const cells = [...run.decisions].sort((a, b) => a.callNo - b.callNo).map((s) => decisionCell(s, opts));
  return { runId: run.runId, golden: run.golden, title: run.runId.slice(0, 10), rank: run.rank, flagged: run.majority !== null && run.majority <= 2, cells, ending: rowEnding(run) };
}
