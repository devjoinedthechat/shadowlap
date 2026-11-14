import { useRef, useState } from 'react';
import type { PairGroupView, TrainingView } from '../../api.js';
import { Chips } from '../../components/bits.js';
import { asWords, CodeText, Copy, Words } from '../../components/Copy.js';
import { Section } from '../../components/Section.js';
import { plural, shortId } from '../../format.js';
import { useListKeys } from '../../list-keys.js';
import { navigate } from '../../router.js';
import { filterGroups, type PairChip } from '../../training.js';
import { TabEmpty } from './TabEmpty.js';

/**
 * Training → Pairs, in sections as the design draws it (pairsTab): no heading to repeat the tab, the
 * confidence chips with what a pair is beside them, then the pairs, a group per call; where they
 * come from and what confidence means side by side. Confidence is said in words, never a badge. j
 * and k walk the groups, then where they come from, and Enter opens one.
 */
export function PairsTab({ view }: { view: TrainingView }) {
  const [chip, setChip] = useState<PairChip>('all');
  const groupsBox = useRef<HTMLDivElement>(null);
  const sourcesBox = useRef<HTMLDivElement>(null);
  const p = view.pairs;
  const groups = p.empty ? [] : filterGroups(p.groups, chip);
  const groupInFocus = useListKeys({ rows: groups, keyOf: (g) => g.key, root: groupsBox, open: (g) => navigate(g.href) });
  const sourceInFocus = useListKeys({ rows: p.empty ? [] : p.sources, keyOf: (s) => s.key, root: sourcesBox, open: (s) => navigate(s.href) });
  if (p.empty) return <TabEmpty empty={p.empty} />;
  return (
    <>
      <section className="panel sec pairsec">
        <div className="tbar pbar">
          <Chips
            label="Confidence"
            value={chip}
            onChange={setChip}
            items={[
              { key: 'all', label: 'All', count: p.counts.all },
              { key: 'high', label: 'High', count: p.counts.high },
              { key: 'medium', label: 'Medium', count: p.counts.medium },
            ]}
          />
          <span className="sub">one answer that lost the run, one that went on to pass</span>
        </div>
        <div className="pgroups" ref={groupsBox}>
          {groups.map((g) => (
            <PairGroup key={g.key} g={g} focused={groupInFocus === g.key} />
          ))}
          {groups.length ? null : <div className="empty">No pairs here.</div>}
        </div>
      </section>
      <div className="grid2 secs">
        <Section title="Where they come from" sub="attempts already in the store">
          <div className="srcs" ref={sourcesBox}>
            {p.sources.map((s) => (
              <a key={s.key} href={s.href} data-rowkey={s.key} className={sourceInFocus === s.key ? 'krow' : undefined}>
                <span className={`sn${s.made ? '' : ' zero'}`}>{s.made}</span>
                <span>
                  <b>{s.label}</b>
                  <span className="rsub">{asWords(s.why)}</span>
                </span>
                {s.made && s.confidence ? <span className="conf">{s.confidence}</span> : null}
              </a>
            ))}
          </div>
        </Section>
        <Section title="Confidence" sub="how sure a pair is">
          <div className="lrows">
            {p.confidence.map((c) => (
              <div key={c.level}>
                <span className="ct">{c.level === 'high' ? 'High' : 'Medium'}</span>
                <span>
                  <b>{c.title}</b>
                  <span className="rsub">{asWords(c.sub)}</span>
                </span>
              </div>
            ))}
          </div>
          <Copy className="pfootnote">{p.footnote}</Copy>
        </Section>
      </div>
    </>
  );
}

/**
 * Pairs from the same call share their conversation and rejected answer, so they show as one group,
 * headed by the run they are about at that call, where they came from and how sure they are. Then
 * the answers as a pair, a row each on one grid so they line up: its label in words, the answer as
 * the model gave it, and at the row's end what it was, with the attempt it came from. No colour:
 * neither answer is a verdict. A verify or `--repeat` answer came from an attempt at that run: each
 * links its own attempt. When the run never made that call (the change verified added a step before
 * it), the attempt heads the group, and says which run it replayed.
 */
function PairGroup({ g, focused }: { g: PairGroupView; focused: boolean }) {
  const ownAttempt = g.rejected.runId !== g.runId;
  return (
    <div className={`pgroup${focused ? ' krow' : ''}`} data-rowkey={g.key}>
      <div className="pg1">
        <a className="more prun" href={g.href} title={g.attemptOf ? 'Open the attempt at this call' : 'Open the run at this call'}>
          <code>{shortId(g.runId)}</code>
          <span>#{g.callNo}</span>
        </a>
        {g.attemptOf ? (
          <span className="pgof" title="The run it replayed never got here: the attempt took another path before this call">
            attempt of{' '}
            <a href={g.attemptOf.href}>
              <code>{shortId(g.attemptOf.runId)}</code>
            </a>
          </span>
        ) : null}
        {g.fix ? (
          <a className="chip" href={g.fix.href} title={`Open fix: ${g.fix.label}`}>
            {g.fix.label}
          </a>
        ) : null}
        <span className="pgsrc">
          {g.from} · {g.confidence} confidence
        </span>
        <span className="sp" />
        <span className="pgn">{plural(g.count, 'pair')}</span>
      </div>
      {/* the run's own words, as written, a dot kept with the part before it */}
      {g.context ? (
        <p className="pctx">
          <Words glued={false}>{g.context.replace(/ · /g, '\u00a0· ')}</Words>
        </p>
      ) : null}
      <div className="pans">
        <div className="pa rej">
          <span className="pak">Rejected</span>
          <CodeText className="pat">{g.rejected.text}</CodeText>
          <span className="paw">
            {g.rejected.what}
            {ownAttempt ? <AttemptLink id={g.rejected.runId} href={g.rejected.href} /> : null}
          </span>
        </div>
        {g.chosen.map((c, i) => (
          <div key={`${c.runId}:${c.callNo}`} className="pa cho">
            <span className="pak">{i ? '' : 'Chosen'}</span>
            <CodeText className="pat">{c.text}</CodeText>
            <span className="paw">
              {c.what}
              <AttemptLink id={c.runId} href={c.href} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** An answer's attempt, after what it was: its id, opening it at the call. */
function AttemptLink({ id, href }: { id: string; href: string }) {
  return (
    <>
      {' · '}
      <a className="rlink" href={href} title="Open the attempt at this call">
        <code>{shortId(id)}</code>
      </a>
    </>
  );
}
