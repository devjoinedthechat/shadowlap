import { argsDelta, decisionLine, decisionStepState, judgedOutcome, judgeOpen, judgeWords, JUDGED_IN_RECORDED_STATE, minorityChange, RANK_LABELS, samplesWords, stepDelta, STOP_WORDS, unchangedRunWords, unsettledWords, WITHIN_VARIATION, type DecisionRank, type DecisionRun, type DecisionStep, type DecisionStepState, type DecisionView, type Palette } from '@shadowlap/engine';

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
  /** A ranked cell's rank in words, for its card (RANK_LABELS): `a write changed`. */
  rankWords?: string;
  /** The scope its call was made in, where it was one: its card's title names it. */
  scope?: string;
  /** What it says opened, besides the two decisions the report keeps; null where no answer came. */
  open: CellOpen | null;
}

/** A part of the engine's words in the colour a terminal prints it in: `ok` green, `no` red, `y` amber, `dim` quiet. */
export interface Toned {
  text: string;
  tone: 'ok' | 'no' | 'y' | 'dim' | null;
}

/**
 * What an opened cell says besides the two decisions (the report's `recorded` and `now`), in the
 * engine's words, since a page can't load its decisions module.
 */
export interface CellOpen {
  /** How often it changed, for a narrow column: `in 1 of 3, 0 of 3 as recorded, not flagged`; null asked once. */
  short: string | null;
  /** How each side's turn ended (STOP_WORDS): `calls tools`, `answers and stops`. */
  stops: { recorded: string; now: string };
  /** Each changed argument, field by field: `lookup_policy.amount: 240 → —`. */
  args: string[];
  /** Each judge check that read its words: its name, and its verdicts and reason in their colours. */
  judges: Array<{ name: string; words: Toned[] }>;
  /** What it costs either way: `+120 tokens · +$0.002`; empty without the tokens or a price. */
  delta: string;
}

const TONE_MARKS: Record<string, Toned['tone']> = { g: 'ok', r: 'no', y: 'y', d: 'dim' };

/** The engine's words for a palette, cut into their coloured parts: as a terminal prints them, for a page to colour. */
export function toned(words: (p: Palette) => string): Toned[] {
  const tag = (t: string) => (s: string) => `\u0001${t}${s}\u0003`;
  const text = words({ green: tag('g'), red: tag('r'), yellow: tag('y'), dim: tag('d'), bold: (s) => s, cyan: (s) => s });
  const out: Toned[] = [];
  for (let at = 0; at < text.length; ) {
    const a = text.indexOf('\u0001', at);
    if (a < 0) {
      out.push({ text: text.slice(at), tone: null });
      break;
    }
    if (a > at) out.push({ text: text.slice(at, a), tone: null });
    const b = text.indexOf('\u0003', a);
    out.push({ text: text.slice(a + 2, b), tone: TONE_MARKS[text[a + 1]!] ?? null });
    at = b + 1;
  }
  return out;
}

/** The line about later steps, `Later steps are judged in the recorded run's state`, and its card, the engine's whole sentence: Preview's and a run's Decisions view's. */
export const LATER_STEPS = { title: JUDGED_IN_RECORDED_STATE.split(':')[0]!, card: JUDGED_IN_RECORDED_STATE };

/** Each changed argument of a step, field by field: `lookup_policy.amount: 240 → —`. */
const argLines = (s: DecisionStep): string[] => s.changes.filter((c) => c.kind === 'write-arguments' || c.kind === 'read-arguments').flatMap((c) => argsDelta(c.before, c.after).map((d) => `${c.tool ?? ''}.${d}`));

/** A step's opened words: its samples' short form, both stops, its arguments field by field, its judges, its cost either way. */
function cellOpen(s: DecisionStep): CellOpen | null {
  if (!s.now || !s.samples.answered) return null;
  return {
    short: s.samples.asked > 1 ? samplesWords(s, { short: true }) : null,
    stops: { recorded: STOP_WORDS[s.recorded.stop], now: STOP_WORDS[s.now.stop] },
    args: argLines(s),
    judges: (s.judge ?? []).map((j) => ({ name: j.name, words: toned((p) => judgeWords(j, p)) })),
    delta: stepDelta(s),
  };
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
    case 'unsettled':
      return `${detail} · inconclusive: ${unsettledWords(s)}`;
    case 'noise':
      return `${detail} · ${WITHIN_VARIATION}: ${samplesWords(s)}`;
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
    ...(state === 'ranked' && s.rank ? { rankWords: RANK_LABELS[s.rank] } : {}),
    ...(s.scope ? { scope: s.scope } : {}),
    open: o.refused ? null : cellOpen(s),
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
  if (!run.asked) return end(unchangedRunWords(run), { why: run.decisions.find((s) => s.error)?.error ?? null });
  const flagged = run.majority !== null && run.majority <= 2;
  const waits = run.decisions.filter((s) => judgeOpen(s)).length;
  const top = topStep(run, flagged);
  if (!top || sampledOf(top) === 5) {
    const words = run.decisions.filter((s) => s.rank === 5);
    const judged = words.some((s) => s.judge?.length && !judgeOpen(s));
    return end(`${unchangedRunWords(run)}${words.length ? `, other words at ${words.length} step${words.length === 1 ? '' : 's'}${judged && !waits ? ', judged as recorded' : ''}` : ''}`, { waits });
  }
  const text = `#${top.callNo} ${detailOf(top) ?? ''}`;
  if (decisionStepState(top) === 'noise') return end(text, { then: `· ${WITHIN_VARIATION}`, callNo: top.callNo, waits });
  const minority = !flagged && minorityChange(top);
  return end(text, { then: minority ? `· ${samplesWords(top, { short: true })}` : '', tone: flagged ? (top.majority === 1 ? 'w' : 's') : null, callNo: top.callNo, waits });
}

/** A run's row: its model calls in call order, each with its rank and words, and what it ends on. */
export function decisionRow(run: DecisionRun, o: { fromCode?: boolean } = {}): DecisionRow {
  const opts = { refused: run.refused, fromCode: !!o.fromCode };
  const cells = [...run.decisions].sort((a, b) => a.callNo - b.callNo).map((s) => decisionCell(s, opts));
  return { runId: run.runId, golden: run.golden, title: run.runId.slice(0, 10), rank: run.rank, flagged: run.majority !== null && run.majority <= 2, cells, ending: rowEnding(run) };
}

/**
 * A step a run's Decisions view lists: what changed and how often, both decisions a line each, its
 * cost either way and its arguments field by field.
 */
export interface ViewStep {
  callNo: number;
  /** Its rank, 1 to 5; null for a change within the model's own variation, which `within` then says in the engine's words. */
  rank: number | null;
  within: string | null;
  /** The change in a few words: `send_email is no longer called`. */
  detail: string;
  /** How often its samples changed, for a narrow column: `in 1 of 3, 0 of 3 as recorded, not flagged`; null asked once. */
  short: string | null;
  /** A judge could not read the words of a sample, and nothing else flags the step. */
  waits: boolean;
  /** Each side's decision in a line (`quoteLine`). */
  recorded: string;
  now: string;
  /** `+120 tokens · +$0.002`; empty without the tokens or a price. */
  delta: string;
  args: string[];
}

/**
 * A decision in a line of the Decisions view, the column beside the inspector: an answer longer
 * than the line is cut where a sentence ends, when one does before the cut, else after a whole word
 * (`This needs tier-2 approval. …`), so no quote breaks inside a sentence or a word.
 */
export function quoteLine(d: DecisionView | null, width = 64): string {
  const text = d && !d.tools.length ? d.text.replace(/\s+/g, ' ') : '';
  if (!d || text.length <= width) return decisionLine(d, width);
  const cut = text.slice(0, width - 1);
  const m = /^.*[.!?](?= )/.exec(cut) ?? /^.*\S(?= )/.exec(cut);
  return decisionLine(m ? { ...d, text: `${m[0]} …` } : d, width);
}

/** The steps a run's Decisions view lists: its ranked ones, most consequential first, then those within the model's own variation, the most changed first. */
export function viewSteps(run: DecisionRun): ViewStep[] {
  const listed = run.refused ? [] : run.decisions.filter((s) => s.rank !== null || decisionStepState(s) === 'noise');
  return listed
    .sort((a, b) => (a.rank ?? 6) - (b.rank ?? 6) || b.samples.changed - a.samples.changed || a.callNo - b.callNo)
    .map((s) => ({
      callNo: s.callNo,
      rank: s.rank,
      within: s.rank === null ? WITHIN_VARIATION : null,
      detail: detailOf(s) ?? '',
      short: s.samples.asked > 1 ? samplesWords(s, { short: true }) : null,
      waits: judgeOpen(s),
      recorded: quoteLine(s.recorded),
      now: quoteLine(s.now),
      delta: stepDelta(s),
      args: argLines(s),
    }));
}
