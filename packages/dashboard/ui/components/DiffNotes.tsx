import type { ReactNode } from 'react';
import type { ChangedPath, PathFix, RequestDiff } from '../../src/request-diff.js';
import { GLUED_SEPARATOR, shortId } from '../format.js';
import type { JsonLine } from '../json-diff.js';
import { sentence } from '../normalize.js';
import { CodeBox } from './CodeBox.js';
import { Code, Copy } from './Copy.js';
import { Id } from './Id.js';
import { JsonDiffPart } from './JsonDiffPart.js';

/**
 * What Show diff says around the structural diff (JsonDiff.tsx), from the server's answer
 * (src/request-diff.ts): the heads that name both sides, and under the diff the sentence, a line for
 * each changed path with what fixes it, what matching masks and what no line of the body shows, then
 * every normalizer's command in one box; the whole answer drawn with the diff between (`DiffAnswer`),
 * and the line where there is no answer (`NoDiffAnswer`). No run page's state, so a test's report and
 * Compare can draw them beside their own diffs. The words are UI copy (`Copy`), each path in `Code`;
 * the server decides every fix, never the browser.
 */

type Normalizing = Extract<PathFix, { kind: 'normalizer' }>;

/** The two sides' heads: `− Recorded request #17 · 01K5CQ4N7G` and `+ This run’s request #17`, `result` where a tool's result is shown. */
export function DiffHead({ diff, as: H = 'h2' }: { diff: Pick<RequestDiff, 'what' | 'at' | 'against'>; as?: 'h2' | 'h3' | 'h4' }) {
  const { what, at, against } = diff;
  return (
    <div className="jdh">
      <H>
        <span className="js del" aria-hidden="true">
          −
        </span>
        Recorded {what} #{against?.callNo ?? at}
        {GLUED_SEPARATOR}
        {against ? <Id id={shortId(against.runId)} /> : 'the recording'}
      </H>
      <H>
        <span className="js add" aria-hidden="true">
          +
        </span>
        This run’s {what} #{at}
      </H>
    </div>
  );
}

/** A fork's flag as code, or the fork where the run keeps none. */
const flagOf = (flag: string | null): ReactNode => (flag ? <Code>{flag}</Code> : 'the fork');

/** Words the engine wrote, ended as a sentence. */
const stop = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);

/** Paths named in a sentence: `a`, `a` and `b`, `a`, `b` and `c`; past three, the first two and how many more. */
function pathList(paths: readonly string[]): ReactNode {
  const shown = paths.length > 3 ? paths.slice(0, 2) : paths;
  const rest = paths.length - shown.length;
  const named = shown.map((p, i) => <Code key={i}>{p}</Code>);
  if (rest) return [...named.flatMap((c, i) => (i ? [', ', c] : [c])), ` and ${rest} other paths`];
  return named.flatMap((c, i) => (i === 0 ? [c] : [i === named.length - 1 ? ' and ' : ', ', c]));
}

/** A test's one value made anew, said whole: where, what it looks like, whether it may be real, and what its normalizer leaves to do. */
function oneValue(path: string, fix: Normalizing, updates: boolean): ReactNode {
  return (
    <>
      {fix.op === 'added' ? <>A value the recording never had, at <Code>{path}</Code>, looks like {fix.looks}</> : <>Only a value changed at <Code>{path}</Code>, and it looks like {fix.looks}</>}
      {fix.certain ? ': the agent makes a new one on every run.' : ', though it may be a real change: look at it before masking it.'} A normalizer masks it before matching
      {updates ? '; the request still carries the field the recording lacks, so the golden is updated after it.' : ', and older recordings match too.'}
    </>
  );
}

/** A tool's result shown, or the request after a tool whose result a fork changed: the sentence that says so. */
function toolLead(d: RequestDiff, tool: NonNullable<RequestDiff['tool']>, lines: readonly JsonLine[]): ReactNode {
  const next = d.what === 'result' ? d.next : d.at;
  // Where the next request changed too, as a result's own view says it (a forced fork's divergence names no path).
  const after =
    next !== null ? (
      <>
        {' '}
        The next model call, #{next}, is the first request that changed{d.path && d.type !== 'forced' ? <>, at <Code>{d.path}</Code></> : null}.
      </>
    ) : null;
  if (d.type === 'forced') {
    return (
      <>
        The result of #{tool.callNo} <Code>{tool.name}</Code> came from {flagOf(d.flag)}.{after}
      </>
    );
  }
  if (d.what === 'result') {
    const planted = d.flag?.startsWith('--inject-result ');
    if (!planted && !d.flag?.startsWith('--override ')) {
      return (
        <>
          The result of #{d.at} <Code>{d.call.name}</Code> changed{d.flag ? <>, by {flagOf(d.flag)}</> : null}.{after}
        </>
      );
    }
    return (
      <>
        The tool result at #{d.at} was {planted ? 'planted with ' : 'overridden ('}
        {flagOf(d.flag)}
        {planted ? '.' : ').'}
        {after}
      </>
    );
  }
  const added = lines.filter((l) => l.sign === '+');
  const one = added.length === 1 && !lines.some((l) => l.sign === '-') && added[0]!.key && !added[0]!.key.startsWith('[') ? added[0]! : null;
  const tail = d.paths.some((p) => p.fix?.kind === 'normalizer') ? '' : ' Not a date or an id, so no normalizer is suggested.';
  if (one) {
    return (
      <>
        One field added at <Code>{one.path}</Code>: <Code>{tool.name}</Code>’s <Code>{one.key!}</Code> now reaches the model.{tail}
      </>
    );
  }
  const at = d.path ?? lines.find((l) => l.sign !== ' ')?.path ?? null;
  return (
    <>
      The result of #{tool.callNo} <Code>{tool.name}</Code> changed{at ? <> at <Code>{at}</Code></> : null}
      {d.flag ? <> ({flagOf(d.flag)})</> : null}.{tail}
    </>
  );
}

/** The request shown is where the run first left its recording, by the fork's flag where it keeps one. */
const firstChanged = (d: RequestDiff): ReactNode => (
  <>
    The request at #{d.at} is the first that changed{d.flag ? <>, by {flagOf(d.flag)}</> : null}.
  </>
);

/**
 * The words alone, where both sides are the same: a fork that asked its call again as recorded says
 * so; a tool failed in its place says where its result came from; any other fork forced live (a model
 * switched in the URL path, a refused intervention) names the request it left the recording at.
 */
function sameLead(d: RequestDiff): ReactNode {
  if (d.type !== 'forced') return `The ${d.what}’s body is as recorded.`;
  const tool = d.tool && d.tool.callNo !== d.at ? d.tool : null;
  if (d.askedAgain) {
    return (
      <>
        No {d.what} changed: {flagOf(d.flag)} asked #{tool?.callNo ?? d.at} again, live, as recorded.
      </>
    );
  }
  if (tool) {
    return (
      <>
        The result of #{tool.callNo} <Code>{tool.name}</Code> came from {flagOf(d.flag)}.
      </>
    );
  }
  return firstChanged(d);
}

/**
 * A call picked past where the run left its recording (`picked`): what it is against, never that it
 * was the first to change, nor what changed it.
 */
const pickedLead = (d: RequestDiff): string => `The ${d.what} at #${d.at} ${d.same ? 'is the same as' : 'differs from'} the recording’s${d.against ? ` #${d.against.callNo}` : ''}.`;

/** The sentence over the lines: what changed and, on a fork, what changed it. None where the lines alone say it. */
function leadOf(d: RequestDiff, lines: readonly JsonLine[], picked = false): ReactNode {
  if (picked) return pickedLead(d);
  if (d.same) return sameLead(d);
  if (d.test) {
    const only = d.paths.length === 1 && d.paths[0]!.fix?.kind === 'normalizer' ? d.paths[0]! : null;
    if (only) return oneValue(only.path, only.fix as Normalizing, d.updates);
    if (!d.paths.length || d.paths.some((p) => p.fix?.kind === 'normalizer')) return null;
    return <>The request changed at {pathList(d.paths.map((p) => p.path))}.</>;
  }
  if (d.what === 'result') return toolLead(d, d.tool ?? { callNo: d.at, name: d.call.name }, lines);
  if (d.tool && d.tool.callNo !== d.at) return toolLead(d, d.tool, lines);
  return firstChanged(d);
}

/** A changed path's line: what it looks like and that a normalizer masks it, or that Update golden re-records it; none for a change the fork meant. */
function pathLine(p: ChangedPath): ReactNode {
  const fix = p.fix;
  if (!fix) return null;
  if (fix.kind === 'update') {
    return (
      <>
        <Code>{p.path}</Code> is what your code or config changed: <span className="nw">Update golden</span> re-records it.
      </>
    );
  }
  if (fix.op === 'changed' && fix.certain) {
    return (
      <>
        <Code>{p.path}</Code> looks like {fix.looks}, made anew on every run: a normalizer masks it.
      </>
    );
  }
  // The engine's words, as the CLI prints them: an id that may be real, or a value the recording never had.
  return fix.message.startsWith(`${p.path} `) ? (
    <>
      <Code>{p.path}</Code>
      {stop(fix.message.slice(p.path.length))}
    </>
  ) : (
    sentence(fix.message)
  );
}

/** Each normalizer's command, a path's or a hint's, once: the box's lines, in the order they are said. */
export function diffCommands(d: Pick<RequestDiff, 'paths' | 'hints'>): string[] {
  const all = [...d.paths.flatMap((p) => (p.fix?.kind === 'normalizer' ? [p.fix.command] : [])), ...d.hints.flatMap((h) => (h.command ? [h.command] : []))];
  return [...new Set(all)];
}

/** A change outside the body that no hint of the engine's names: a header or a query parameter a fork's flag changed. */
function unnamed(d: Pick<RequestDiff, 'outside' | 'hints'>): string[] {
  return d.outside.filter((path) => {
    const name = path.replace(/^(headers|query)\./, '');
    return !d.hints.some((h) => h.message.includes(name));
  });
}

/**
 * What Show diff says under the diff: the sentence (none where the lines say it all), a line for each
 * changed path with what fixes it, one for each change matching masks, the engine's hints on what no
 * line of the body shows (the headers, the query, the clock), then every normalizer's command in one
 * box. `lines`, the walk JsonDiff drew: a fork's one added field is said by its key. `picked`: the call
 * shown is one picked past where the run left its recording (pickedLead).
 */
export function DiffNotes({ diff: d, lines, picked = false }: { diff: RequestDiff; lines: readonly JsonLine[]; picked?: boolean }) {
  const lead = leadOf(d, lines, picked);
  const single = d.test && d.paths.length === 1 && d.paths[0]!.fix?.kind === 'normalizer';
  const said = [
    ...(lead ? [lead] : []),
    ...(single ? [] : d.paths.map(pathLine).filter((l): l is NonNullable<ReactNode> => l !== null)),
    ...d.masked.map((p) => (
      <>
        <Code>{p}</Code> changed too, and matching masks it.
      </>
    )),
    ...unnamed(d).map((p) => (
      <>
        <Code>{p}</Code> changed too, outside the request’s body.
      </>
    )),
    ...d.hints.map((h) => sentence(h.message)),
  ];
  const commands = diffCommands(d);
  if (!said.length && !commands.length) return null;
  return (
    <div className="hint">
      {said.map((s, i) => (
        <Copy key={i} as="div">
          {s}
        </Copy>
      ))}
      {commands.length ? <CodeBox command={commands.length === 1 ? commands[0]! : commands} /> : null}
    </div>
  );
}

/**
 * Show diff's answer drawn: the heads, the structural diff (a script of its own, JsonDiffPart.tsx) and
 * the notes under it; where both sides are the same, the words alone. A run's finding and a golden's
 * report on Tests draw it, `as` the heads' level there; `picked`, a call picked past where the run
 * left its recording (DiffNotes).
 */
export function DiffAnswer({ diff, as, picked = false }: { diff: RequestDiff; as?: 'h2' | 'h3' | 'h4'; picked?: boolean }) {
  // The server says whether the two sides are the same (`same`): no render reads both bodies to find out.
  if (diff.same) return <DiffNotes diff={diff} lines={[]} picked={picked} />;
  return (
    <>
      <DiffHead diff={diff} {...(as ? { as } : {})} />
      <JsonDiffPart was={diff.was} now={diff.now} leftOut={diff.leftOut}>
        {(lines) => <DiffNotes diff={diff} lines={lines} picked={picked} />}
      </JsonDiffPart>
    </>
  );
}

/** Show diff's line where the server has no answer, the run keeping no call `at` to compare: `This run` on its page, `The replay` in a golden's report. */
export function NoDiffAnswer({ who, at }: { who: 'This run' | 'The replay'; at: number | undefined }) {
  return <Copy as="div" className="hint">{`${who} kept no call #${at ?? ''} to compare.`}</Copy>;
}
