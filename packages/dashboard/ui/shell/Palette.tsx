import { useEffect, useMemo, useRef, useState } from 'react';
import { JOB_KINDS, type RecordedHit } from '../api.js';
import { AboutLine, FitHint, useFitAbouts } from '../components/About.js';
import { Icon } from '../components/Icon.js';
import { isMac } from '../dom.js';
import { callName, shortId } from '../format.js';
import { jobRunning } from '../jobs.js';
import { highlight, INDEXING_RETRY_MS, indexingNote, limitRecorded, matchPalette, palettePlaceholder, PAUSED_HINT, RECORDED_MIN_CHARS, runsById, runsToAskFor, snippetParts, words } from '../palette.js';
import { onPaletteSourcesChanged, paletteSources } from '../palette-sources.js';
import { href, type Route } from '../route.js';
import { navigate } from '../router.js';
import { normalizeRuns } from '../normalize.js';
import { isAttempt, kindWord, runSource, type RunLike } from '../runs.js';
import { useApp, useLayer, type PaletteCommand } from '../state.js';

/**
 * Search or jump to (⌘K, Ctrl K, or / away from a run): This run, Go to, Actions, Runs, Fixes,
 * Tests, Projects, and, from three characters, what runs recorded. Every typed word must match.
 *
 * It is a combobox, as ARIA's pattern has it: the field keeps the focus, ↑ and ↓ move the active
 * option (`aria-activedescendant`), each group of options is a group of the listbox, and closing it
 * (Esc, a click outside, or a pick) hands the focus back to where it was when it opened.
 */

/** The jobs that run the goldens: while one runs, the palette offers no second session. */
const TEST_KINDS: ReadonlySet<string> = new Set<string>([JOB_KINDS.tests, JOB_KINDS.testUpdate, JOB_KINDS.normalizeAndTest]);

export function Palette({ route }: { route: Route }) {
  const app = useApp();
  const { palette, setPalette } = app;
  if (!palette) return null;
  return <PaletteDialog route={route} close={() => setPalette(false)} />;
}

function PaletteDialog({ route, close }: { route: Route; close: () => void }) {
  const app = useApp();
  useLayer('dialog', true, close);
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const [hits, setHits] = useState<RecordedHit[]>([]);
  // While the server's index is behind: how many runs it has yet to read.
  const [indexing, setIndexing] = useState<{ runs: number; of: number } | null>(null);
  const list = useRef<HTMLDivElement>(null);
  // Each hint fitted to the rest of its row, once laid out: an about line at whole words, a command at its end.
  useFitAbouts(list);
  const input = useRef<HTMLInputElement>(null);

  // The field takes the focus; closing hands it back to what had it, as a dialog does, when that is
  // still on the page (a pick that changed the page leaves it on the page's own).
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    input.current?.focus();
    return () => {
      if (before?.isConnected) before.focus();
    };
  }, []);
  // A source whose answer lands while the palette is open (Tests, loaded from any page) is read again.
  const [sourcesChanged, setSourcesChanged] = useState(0);
  useEffect(() => onPaletteSourcesChanged(() => setSourcesChanged((n) => n + 1)), []);

  const go = (to: string) => navigate(to);
  const items = useMemo<PaletteCommand[]>(() => {
    const out: PaletteCommand[] = [...app.runCommands];
    const pages: Array<[string, string]> = app.exported
      ? [
          ['Runs', href.runs()],
          ['Compare', href.compare()],
        ]
      : [
          ['Overview', href.overview()],
          ['Runs', href.runs()],
          ['Compare', href.compare()],
          ['Fixes', href.fixes()],
          ['Tests', href.tests()],
          ['Training', href.training()],
          ['Settings', href.settings()],
          ['Add a project', href.newProject()],
        ];
    for (const [label, to] of pages) out.push({ group: 'Go to', label, hint: '', run: () => go(to) });
    // Not a second session while one started here runs: Tests' own button says so meanwhile.
    if (!app.actionsOff && app.hasKind(JOB_KINDS.tests) && !jobRunning(app.jobs, TEST_KINDS))
      out.push({ group: 'Actions', label: 'Run the tests', hint: 'shadowlap test goldens/*', job: true, run: () => app.guard(() => app.watchJob(app.client.startJob(JOB_KINDS.tests, {}))) });
    out.push({ group: 'Actions', label: 'Keyboard shortcuts', hint: '?', run: () => app.setHelp(true) });
    for (const source of paletteSources()) {
      try {
        out.push(...source({ app, route, go }).filter((x) => x.group !== 'Actions' || !app.actionsOff));
      } catch {
        // a source that fails leaves its group out
      }
    }
    const runs = [...(app.runs ?? [])].filter((r) => !isAttempt(r)).sort((a, b) => b.startedAt - a.startedAt);
    for (const r of runs) out.push(runCommand(r, go));
    return out;
    // Built when the palette opens, and again only when a source says more arrived: the run list
    // moving under it would move the selection.
  }, [sourcesChanged]);

  // What runs recorded, from three characters, through the server's search. It answers from what its
  // index holds; while that is behind, the palette asks again, so matches arrive as it catches up.
  useEffect(() => {
    const t = q.trim();
    if (t.length < RECORDED_MIN_CHARS || app.exported) {
      setHits([]);
      setIndexing(null);
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const ask = () =>
      app.client.search(t).then(
        (a) => {
          if (!alive) return;
          setHits(limitRecorded(a.hits));
          setIndexing(a.indexing ?? null);
          if (a.indexing) timer = setTimeout(() => void ask(), INDEXING_RETRY_MS);
        },
        () => {
          if (!alive) return;
          setHits([]);
          setIndexing(null);
        },
      );
    timer = setTimeout(() => void ask(), 220);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [q, app.client, app.exported]);
  const note = q.trim().length >= RECORDED_MIN_CHARS ? indexingNote(indexing) : null;

  // A run's id, typed in full or its start, that no run in the list (the newest 500) has: the server
  // looks it up among every run, as Runs' filter does.
  const [byId, setById] = useState<PaletteCommand[]>([]);
  useEffect(() => {
    const prefix = app.exported ? null : runsToAskFor(q, app.runs);
    if (!prefix) {
      setById([]);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      app.client.runsPage({ q: prefix, limit: 20 }).then(
        // An attempt whose run isn't in the page is listed like any run, as the run list lists it.
        (page) => alive && setById(runsById(prefix, normalizeRuns(page.runs).filter((r) => !isAttempt(r))).map((r) => runCommand(r, go))),
        () => alive && setById([]),
      );
    }, 150);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [q, app.client, app.exported, app.runs]);

  const shown = useMemo(() => {
    const matched = matchPalette(items, q);
    const recorded: Array<PaletteCommand & { snippet?: string }> = hits.map((h) => ({
      group: 'In recorded data',
      label: `${shortId(h.runId)} #${h.callNo}`,
      mono: true,
      hint: `${callName(h.kind, h.name)} · ${h.field}`,
      snippet: h.snippet,
      run: () => go(href.run(h.runId, h.callNo)),
    }));
    return [...matched, ...byId, ...recorded] as Array<PaletteCommand & { snippet?: string }>;
  }, [items, q, hits, byId]);

  const at = Math.min(i, Math.max(0, shown.length - 1));
  useEffect(() => {
    list.current?.querySelector('.palit.on')?.scrollIntoView({ block: 'nearest' });
  }, [at, shown.length]);

  // Without the server, a job's entry stays in its place, dimmed: picked, it says why nothing runs.
  const offline = app.conn === 'offline';
  const pick = (n: number) => {
    const x = shown[n];
    if (!x) return;
    if (offline && x.job) return app.toast('Actions are paused until the dashboard server is back.');
    close();
    x.run();
  };

  // Each group of options in its order, numbered as ↑ and ↓ count them.
  const groups: Array<{ name: string; items: Array<{ x: (typeof shown)[number]; n: number }> }> = [];
  shown.forEach((x, n) => {
    const last = groups[groups.length - 1];
    if (last && last.name === x.group) last.items.push({ x, n });
    else groups.push({ name: x.group, items: [{ x, n }] });
  });
  const optionId = (n: number) => `palopt-${n}`;
  return (
    <div className="scrim palscrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Search or jump to">
        <label className="palin">
          <Icon name="search" />
          <span className="sr">Search or jump to</span>
          <input
            ref={input}
            type="text"
            placeholder={palettePlaceholder({ exported: app.exported, actions: !app.actionsOff, offline })}
            autoComplete="off"
            spellCheck={false}
            value={q}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={shown.length > 0}
            aria-controls={shown.length ? 'palList' : undefined}
            aria-activedescendant={shown.length ? optionId(at) : undefined}
            onChange={(e) => {
              setQ(e.target.value);
              setI(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setI(Math.min(shown.length - 1, at + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setI(Math.max(0, at - 1));
              } else if (e.key === 'Home' && shown.length && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                setI(0);
              } else if (e.key === 'End' && shown.length && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                setI(shown.length - 1);
              } else if (e.key === 'Enter') {
                e.preventDefault();
                pick(at);
              }
            }}
          />
          <span className="kbd" aria-hidden="true">
            Esc
          </span>
        </label>
        <div className="pallist" ref={list}>
          {shown.length ? (
            <div id="palList" role="listbox" aria-label="Results">
              {groups.map((g) => (
                <div key={g.name} role="group" aria-label={g.name}>
                  <div className="palg" aria-hidden="true">
                    {g.name}
                  </div>
                  {g.items.map(({ x, n }) => {
                    const mark = highlight(x.label, q);
                    const paused = offline && x.job === true;
                    return (
                      <div
                        key={`${x.group}:${x.label}:${n}`}
                        id={optionId(n)}
                        role="option"
                        aria-selected={n === at}
                        aria-disabled={paused || undefined}
                        className={`palit${n === at ? ' on' : ''}${paused ? ' waits' : ''}`}
                        // The field keeps the focus: a click picks without taking it.
                        onMouseDown={(e) => e.preventDefault()}
                        onMouseMove={() => n !== at && setI(n)}
                        onClick={() => pick(n)}
                      >
                        <span className={`pl${x.mono ? ' mono' : ''}`}>
                          {mark ? (
                            <>
                              {mark[0]}
                              <mark>{mark[1]}</mark>
                              {mark[2]}
                            </>
                          ) : (
                            x.label
                          )}
                        </span>
                        {paused ? (
                          // A job's entry while the server can't be reached: paused, in place of its hint.
                          <span className="ph2">{PAUSED_HINT}</span>
                        ) : x.about ? (
                          // A run's about line as its hint, fitted to the rest of the row, the search word marked where it still is.
                          <AboutLine about={x.about as { text: string; from: 'user' }} className="ph2" mark={words(q).find((w) => x.about!.text.toLowerCase().includes(w)) ?? null} />
                        ) : x.snippet || !x.hint ? (
                          <span className="ph2">
                            {x.hint}
                            {x.snippet ? (
                              <>
                                {' · '}
                                {snippetParts(x.snippet).map((p, k) => (p.match ? <mark key={k}>{p.text}</mark> : <span key={k}>{p.text}</span>))}
                              </>
                            ) : null}
                          </span>
                        ) : (
                          // Any other hint (a command, a list) is cut only at its end after a whole word: an id in it is whole or left out.
                          <FitHint text={x.hint} className="ph2" />
                        )}
                        {n === at ? (
                          <span className="kbd" aria-hidden="true">
                            ↵
                          </span>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          ) : (
            <div className="empty" role="status">
              {note ? 'Nothing matches yet.' : `Nothing matches “${q.trim()}”.`}
            </div>
          )}
          {note ? (
            <div className="palnote" role="status">
              {note}
            </div>
          ) : null}
        </div>
        <div className="palfoot" aria-hidden="true">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd>move
          </span>
          <span>
            <kbd>↵</kbd>open
          </span>
          <span>
            <kbd>{isMac() ? '⌘' : 'Ctrl'}</kbd>
            <kbd>K</kbd>close
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * A run in the palette's Runs group: its id, its about line as the hint (decision 10), fitted to the
 * rest of the row. It matches its kind, command and labels too, which don't show. A server that sends
 * no about line gets the old hint: what it is and its command, and its labels.
 */
function runCommand(r: RunLike & { runId: string; labels: readonly string[] }, go: (to: string) => void): PaletteCommand {
  const unseen = `${kindWord(r)} · ${runSource(r)}${r.labels.length ? ` · ${r.labels.join(', ')}` : ''}`;
  return {
    group: 'Runs',
    label: shortId(r.runId),
    mono: true,
    ...(r.about ? { hint: r.about.text, about: r.about, match: unseen } : { hint: unseen }),
    run: () => go(href.run(r.runId)),
  };
}
