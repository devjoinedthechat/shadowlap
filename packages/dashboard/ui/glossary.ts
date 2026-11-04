/**
 * The glossary: a word a newcomer can't guess, that stays because it is the CLI's own (a fork's
 * fenced, blocked and stubbed writes, an injected failure, blame's rescued and lost, verify's kept,
 * an injection test's influenced and canary, pass^5, a gate's bound) or the dashboard's receipt (not
 * re-spent, not waited). The first time a page shows one, `Term` (components/Term.tsx) gives it a
 * dotted underline and its definition in the hover card, on hover, on focus and to a screen reader;
 * its later uses on the page read as plain words. Left plain on purpose: text the CLI writes, shown
 * as it writes it (a report, report.md, a gate's rule), log lines, a run's about line and a word in
 * another sense (a release or a task blocked). No DOM here: the tests import it.
 */

export const GLOSSARY = {
  golden: 'A recorded run kept as a test: CI replays it on every commit (live from its fork for a fork golden) and judges it by its checks.',
  fenced: 'Writes a fork kept from their tools: blocked or stubbed.',
  blocked: 'A write after the fork that never ran: the agent got an error back.',
  stubbed: 'A write after the fork that never ran: the agent got a stand-in result back.',
  injected: 'A call answered with a failure you set, an HTTP status or a tool error, not by its provider.',
  rescued: 'Blame’s verdict on a model call: answered again from there, the run can pass.',
  lost: 'Blame’s verdict on a model call: answered again from there, the run still fails. A run lost at #5 could be rescued at #5 and not after it.',
  kept: 'Verify’s word for a run that passed before the change and still passes with it.',
  influenced: 'A write that happened only with the planted text in place and carried no canary: weaker evidence than a write that carried one.',
  'pass^5': 'The chance that five attempts in a row all pass, estimated from the attempts so far.',
  'not re-spent': 'What the replayed calls cost when they were recorded: spend the replays didn’t repeat.',
  'not waited': 'How long the replayed calls took when they were recorded: time this replay didn’t wait.',
  canary: 'A marker unique to each attempt’s payload: a tool call that carries it proves the planted text caused it.',
  bound: 'The tally’s bound on the pass rate, at the confidence in brackets, exact under the gate that stopped it: the rates its attempts are consistent with, not a promise about later runs. The gate’s rule gives the verdict its meaning.',
} as const;

export type GlossaryTerm = keyof typeof GLOSSARY;

/** Whether a word is one the glossary defines. */
export const isTerm = (k: string): k is GlossaryTerm => Object.hasOwn(GLOSSARY, k);

/**
 * A gate's bound as the CLI prints it, its spaces plain or no-break: `rate >= 0.73 (95%)`,
 * `rate <= 0.71 (95%)`, `rate 0.67 to 0.91 (95%)`. Its card is headed by the bound itself.
 */
export const BOUND = /rate(?:[ \u00a0](?:>=|<=))?[ \u00a0]\d\.\d+(?:[ \u00a0]to[ \u00a0]\d\.\d+)?[ \u00a0]\(\d+(?:\.\d+)?%\)/;

/** The words the glossary finds in a line: its terms, `goldens` as golden, each kept whole (no part of a longer word or name). */
const WORDS = /(^|[^\w-])(goldens?|fenced|blocked|stubbed|injected|rescued|lost|kept|influenced|pass\^5|not[ \u00a0]re-spent|not[ \u00a0]waited|canary)(?![\w-])/g;

/** A piece of a line: plain text, or a term the glossary defines with the word as the line writes it. */
export type GlossPiece = string | { term: GlossaryTerm; text: string };

/**
 * A status word, a legend or a figure's words, its terms found: plain text between them, each term
 * with its key and its words as written. A bound is one term, `bound`. Nothing is found inside a
 * longer word ("blockedness", "re-kept") or a name (`lost-at`).
 */
export function glossPieces(text: string): GlossPiece[] {
  const marks: Array<{ at: number; end: number; term: GlossaryTerm }> = [];
  for (const m of text.matchAll(WORDS)) {
    const word = m[2]!;
    const at = m.index + m[1]!.length;
    const key = word.startsWith('golden') ? 'golden' : word.replace(/\u00a0/g, ' ');
    if (isTerm(key)) marks.push({ at, end: at + word.length, term: key });
  }
  for (const m of text.matchAll(new RegExp(BOUND.source, 'g'))) marks.push({ at: m.index, end: m.index + m[0].length, term: 'bound' });
  marks.sort((a, b) => a.at - b.at);
  const out: GlossPiece[] = [];
  let from = 0;
  for (const k of marks) {
    if (k.at < from) continue;
    if (k.at > from) out.push(text.slice(from, k.at));
    out.push({ term: k.term, text: text.slice(k.at, k.end) });
    from = k.end;
  }
  if (from < text.length) out.push(text.slice(from));
  return out;
}

/** What a term's hover card says: its title (the word, or the bound as written) and its definition. */
export function termCard(term: GlossaryTerm, text: string): { t: string; s: string } {
  return { t: term === 'bound' ? text.replace(/\u00a0/g, ' ') : term, s: GLOSSARY[term] };
}
