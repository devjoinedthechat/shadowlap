import { useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { JOB_KINDS, type RecordedHit } from '../api.js';
import { AboutLine, FitHint, useFitAbouts } from '../components/About.js';
import { fontOf, widthIn } from '../components/Copy.js';
import { Modal } from '../components/Dialog.js';
import { Icon } from '../components/Icon.js';
import { isMac } from '../dom.js';
import { RECORDED_MIN_CHARS } from '../../src/links.js';
import { dropRowScope, rowScopeNow, type RowScope, type RowStep } from '../list-keys.js';
import { ACTIONS } from '../labels.js';
import { callName, plural, shortId } from '../format.js';
import { testsBusy } from '../goldens.js';
import { blameAsksOnItsPage, blameEntries, highlight, INDEXING_RETRY_MS, indexingNote, limitRecorded, matchPalette, palettePlaceholder, pickRefusal, runsById, runsToAskFor, snippetParts, words } from '../palette.js';
import { addPaletteSource, onPaletteSourcesChanged, paletteSources } from '../palette-sources.js';
// The pages' actions and Tests, so a fresh palette lists them before their pages have loaded.
import '../palette-actions.js';
import { href, type Route } from '../route.js';
import { navigate } from '../router.js';
import { normalizeRuns } from '../normalize.js';
import { isAttempt, kindWord, runSource, type RunLike } from '../runs.js';
import { pendingHidden, withoutPending } from '../pending-delete.js';
import { rowStep } from '../run/row-step.js';
import { lastViewOf } from '../runs-view.js';
import { goKeyColumn, keyColumn } from '../shortcuts.js';
import { singleKeysOn } from '../single-keys.js';
import { useApp, type AppState, type PaletteCommand } from '../state.js';
import { announce } from '../toast.js';
import { useMedia } from '../hooks.js';
import { Id } from '../components/Id.js';
import { paletteTestsAsk, startTestsJob } from '../tests-ask.js';

/**
 * Search or jump to (⌘K, Ctrl K, or / away from a run and Runs): This run, Go to, Actions, Runs, Fixes,
 * Tests, Projects, and, from three characters, what runs recorded. Every typed word must match.
 *
 * It is a combobox, as ARIA's pattern has it: the field keeps the focus, ↑ and ↓ move the active
 * option (`aria-activedescendant`), each group of options is a group of the listbox, and closing it
 * (Esc, a click outside, or a pick) hands the focus back to where it was when it opened. A row with a
 * key of its own shows it while single-key shortcuts are on. Opened on a row in focus (⌘K in a list),
 * it offers that row's actions under its name, and ⌫ in its empty field goes back to everything.
 */
export function Palette({ route }: { route: Route }) {
  const app = useApp();
  const { palette, setPalette } = app;
  if (!palette) return null;
  return <PaletteDialog route={route} close={() => setPalette(false)} />;
}

/** Whether words fit a field whole, in its own type at the width it has; true where the page can't measure. */
function fitsField(el: HTMLElement, text: string): boolean {
  if (typeof getComputedStyle !== 'function') return true;
  const cs = getComputedStyle(el);
  const width = widthIn(fontOf(cs));
  return !width || width(text) <= el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
}

/**
 * The field's words: what it searches, or "Search or jump to", as its button says, on a touch screen
 * or where those words don't fit the field whole, measured in its own type again as the window's
 * size changes.
 */
function useFieldWords(input: RefObject<HTMLInputElement | null>, words: string): string {
  const touch = useMedia('(hover: none) and (pointer: coarse)');
  const [fits, setFits] = useState(true);
  useLayoutEffect(() => {
    const measure = () => setFits(!input.current || fitsField(input.current, words));
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [input, words]);
  return touch || !fits ? 'Search or jump to' : words;
}

/**
 * The row whose actions the palette opened on, for as long as it stays on them, and the field's words
 * for them: its name where that fits the field whole, measured again as the window's size changes,
 * else "this row".
 */
function useRowScope(input: RefObject<HTMLInputElement | null>) {
  const [scope, setScope] = useState(rowScopeNow);
  useEffect(() => dropRowScope, []);
  const own = scope ? `Actions for ${scope.name}` : null;
  const [fits, setFits] = useState(true);
  useLayoutEffect(() => {
    if (!own) return;
    const measure = () => setFits(!input.current || fitsField(input.current, own));
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [input, own]);
  return { scope, setScope, scopeWords: own && (fits ? own : 'Actions for this row') };
}

/** What runs recorded, from three characters, through the server's search. It answers from what its index holds; while that is behind, the palette asks again, so matches arrive as it catches up. */
function useRecordedHits(app: AppState, q: string): { hits: RecordedHit[]; note: string | null } {
  const [hits, setHits] = useState<RecordedHit[]>([]);
  // While the server's index is behind: how many runs it has yet to read.
  const [indexing, setIndexing] = useState<{ runs: number; of: number } | null>(null);
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
  return { hits, note: q.trim().length >= RECORDED_MIN_CHARS ? indexingNote(indexing) : null };
}

/** A run's id, typed in full or its start, that no run in the list (the newest 500) has: the server looks it up among every run, as Runs' filter does. */
function useRunsById(app: AppState, q: string): PaletteCommand[] {
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
        (page) => alive && setById(runsById(prefix, normalizeRuns(page.runs).filter((r) => !isAttempt(r))).map((r) => runCommand(r))),
        () => alive && setById([]),
      );
    }, 150);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [q, app.client, app.exported, app.runs]);
  return byId;
}

/** A row's actions as the palette lists them, a run's next step among them (`step`): every typed word in the label or the hint. */
function scopedRows(scope: RowScope, q: string, step: RowStep): PaletteCommand[] {
  const typed = words(q);
  return scope
    .items(step)
    .filter((x) => typed.every((w) => `${x.label} ${x.hint}`.toLowerCase().includes(w)))
    .map((x) => ({ ...x, group: 'Actions' }));
}

/** Each group of options in its order, numbered as ↑ and ↓ count them. */
function inGroups<T extends { group: string }>(shown: readonly T[]): Array<{ name: string; items: Array<{ x: T; n: number }> }> {
  const groups: Array<{ name: string; items: Array<{ x: T; n: number }> }> = [];
  shown.forEach((x, n) => {
    const last = groups[groups.length - 1];
    if (last && last.name === x.group) last.items.push({ x, n });
    else groups.push({ name: x.group, items: [{ x, n }] });
  });
  return groups;
}

/** The row's keys, at its right: its own while single keys are on, else ↵ on the row Enter opens. */
function RowKeys({ own, active }: { own: string | undefined; active: boolean }) {
  if (own && singleKeysOn())
    return (
      <span className="palk" aria-hidden="true">
        {own.split(' ').map((c) => (
          <kbd key={c}>{c}</kbd>
        ))}
      </span>
    );
  return active ? (
    <span className="kbd" aria-hidden="true">
      ↵
    </span>
  ) : null;
}

/** One row of the listbox. */
function PaletteRow({ x, n, q, at, paused, id, moved, pick }: { x: PaletteCommand & { snippet?: string }; n: number; q: string; at: number; paused: boolean; id: string; moved: Dispatch<SetStateAction<number>>; pick: (n: number) => void }) {
  const mark = highlight(x.label, q);
  return (
    <div
      id={id}
      role="option"
      aria-selected={n === at}
      aria-disabled={paused || !!x.wait || undefined}
      className={`palit${n === at ? ' on' : ''}${paused || x.wait ? ' waits' : ''}`}
      // The field keeps the focus: a click picks without taking it.
      onMouseDown={(e) => e.preventDefault()}
      onMouseMove={() => moved(n)}
      onClick={() => pick(n)}
    >
      <span className={`pl${x.mono ? ' mono' : ''}`}>
        {mark ? (
          <>
            {mark[0]}
            <mark>{mark[1]}</mark>
            {mark[2]}
          </>
        ) : x.group === 'Runs' ? (
          // A run's id in its list form, but where the search word is marked in it.
          <Id id={x.label} list />
        ) : (
          x.label
        )}
      </span>
      <RowHint x={x} q={q} />
      {paused ? <span className="paltag">paused</span> : null}
      <RowKeys own={x.key} active={n === at} />
    </div>
  );
}

// Run blame for the newest failures nobody blamed: the job, or what it asks first (your command on a capture, the check, a yes) on the run's own page.
addPaletteSource(({ app, route, go }) => {
  const refused = (runId: string, err: unknown) => (blameAsksOnItsPage(err) ? go(href.run(runId)) : app.watchJob(Promise.reject(err)));
  return blameEntries(withoutPending(app.runs ?? [], pendingHidden()), route.page === 'run' ? route.id : null).map(({ run, entry }) => ({
    ...entry,
    run: () =>
      run.next?.capture
        ? go(href.run(run.runId))
        : void app.client.startJob(JOB_KINDS.blame, { runId: run.runId }).then(
            (job) => app.watchJob(Promise.resolve(job)),
            (err: unknown) => refused(run.runId, err),
          ),
  }));
});

function PaletteDialog({ route, close }: { route: Route; close: () => void }) {
  const app = useApp();
  const [q, setQ] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const { scope, setScope, scopeWords } = useRowScope(input);
  const [i, setI] = useState(0);
  // The ring on the row is the keyboard's: the pointer's place shows by the ground alone.
  const [byKeys, setByKeys] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  // Each hint fitted to the rest of its row, once laid out: an about line at whole words, a command at its end.
  useFitAbouts(list);

  // The field takes the focus; closing hands it back to what had it, as a dialog does (`Modal`). A
  // phone's sidebar it was opened from closes behind it, so it opens centred on the page.
  const { setSideOpen } = app;
  useEffect(() => {
    input.current?.focus();
  }, []);
  useEffect(() => setSideOpen(false), [setSideOpen]);
  // A source whose answer lands while the palette is open (Tests, loaded from any page) is read again.
  const [sourcesChanged, setSourcesChanged] = useState(0);
  useEffect(() => onPaletteSourcesChanged(() => setSourcesChanged((n) => n + 1)), []);

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
          [ACTIONS.addProject.label, href.newProject()],
        ];
    for (const [label, to] of pages) out.push({ group: 'Go to', label, hint: '', key: goKeyColumn(to), run: () => navigate(lastViewOf(to)) });
    // Not a second session while one runs: the row stays, dimmed, and says why, as Tests' own button
    // does (until the server's list comes, a start reads its refusal). One that would run goldens live
    // asks first, over whatever page is open, as Tests' Run tests does, with the command read from
    // Tests once the server asks (paletteTestsAsk).
    const testsWait = testsBusy(app.jobs.map((w) => w.job), 'run the tests', app.meta?.project?.id ?? null);
    if (!app.actionsOff && app.hasKind(JOB_KINDS.tests)) out.push({ group: 'Actions', label: ACTIONS.runTests.label, hint: testsWait ?? 'shadowlap test goldens/*', job: true, ...(testsWait ? { wait: testsWait } : {}), run: () => startTestsJob(app, JOB_KINDS.tests, {}, paletteTestsAsk(app)) });
    out.push({ group: 'Actions', label: ACTIONS.keyboardShortcuts.label, hint: 'every key, by where it works', key: keyColumn('help'), run: () => app.setHelp(true) });
    for (const source of paletteSources()) {
      try {
        out.push(...source({ app, route, go: navigate }).filter((x) => x.group !== 'Actions' || !app.actionsOff));
      } catch {
        // a source that fails leaves its group out
      }
    }
    const runs = withoutPending(app.runs ?? [], pendingHidden()).filter((r) => !isAttempt(r)).sort((a, b) => b.startedAt - a.startedAt);
    for (const r of runs) out.push(runCommand(r));
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- built when the palette opens, and again only when a source says more arrived: the run list moving under it would move the selection
  }, [sourcesChanged]);

  const { hits, note } = useRecordedHits(app, scope ? '' : q);
  const byId = useRunsById(app, scope ? '' : q);

  const shown = useMemo(() => {
    if (scope) return scopedRows(scope, q, rowStep(app.actionsOff, app.toast, { client: app.client, guard: app.guard, watchJob: app.watchJob }));
    const matched = matchPalette(items, q);
    const recorded: Array<PaletteCommand & { snippet?: string }> = hits.map((h) => ({
      group: 'In recorded data',
      label: `${shortId(h.runId)} #${h.callNo}`,
      mono: true,
      hint: `${callName(h.kind, h.name)} · ${h.field}`,
      snippet: h.snippet,
      run: () => navigate(href.run(h.runId, h.callNo)),
    }));
    return [...matched, ...byId, ...recorded] as Array<PaletteCommand & { snippet?: string }>;
  }, [items, q, hits, byId, scope, app.actionsOff, app.toast, app.client, app.guard, app.watchJob]);

  const at = Math.min(i, Math.max(0, shown.length - 1));
  useEffect(() => {
    list.current?.querySelector('.palit.on')?.scrollIntoView({ block: 'nearest' });
  }, [at, shown.length]);
  useSayCount(q, shown.length);

  const offline = app.conn === 'offline';
  const pick = (n: number) => pickRow(shown[n], { offline, toast: app.toast, close });
  const fieldWords = useFieldWords(input, palettePlaceholder({ exported: app.exported, actions: !app.actionsOff, offline }));

  const groups = inGroups(shown);
  const optionId = (n: number) => `palopt-${n}`;
  return (
    <Modal requestClose={close} scrimClass="palscrim">
      <div className="palette" role="dialog" aria-modal="true" aria-label="Search or jump to">
        <label className="palin">
          <Icon name="search" />
          <span className="sr">Search or jump to</span>
          <input
            ref={input}
            type="text"
            placeholder={scopeWords ?? fieldWords}
            autoComplete="off"
            spellCheck={false}
            value={q}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={shown.length > 0}
            aria-controls={shown.length ? 'palList' : undefined}
            aria-activedescendant={shown.length ? optionId(at) : undefined}
            aria-describedby={offline ? 'palOff' : undefined}
            onChange={(e) => {
              setQ(e.target.value);
              setI(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setByKeys(true);
                setI(Math.min(shown.length - 1, at + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setByKeys(true);
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
              } else if (e.key === 'Backspace' && !q && scope) {
                e.preventDefault();
                dropRowScope();
                setScope(null);
              }
            }}
          />
          <span className="kbd" aria-hidden="true">
            Esc
          </span>
        </label>
        {offline ? <OfflineLine /> : null}
        <div className={`pallist${byKeys ? ' kb' : ''}`} ref={list}>
          {shown.length ? (
            <div id="palList" role="listbox" aria-label="Results">
              {groups.map((g) => (
                <div key={g.name} role="group" aria-label={scope ? scope.name : g.name}>
                  <div className="palg" aria-hidden="true">
                    {scope ? <code className="rnm">{scope.name}</code> : g.name}
                  </div>
                  {g.items.map(({ x, n }) => (
                    <PaletteRow key={`${x.group}:${x.label}:${n}`} x={x} n={n} q={q} at={at} paused={offline && x.job === true} id={optionId(n)} pick={pick} moved={(m) => {
                      setByKeys(false);
                      setI(m);
                    }} />
                  ))}
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
          {scope ? (
            <span>
              <kbd>⌫</kbd>everything
            </span>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}

/** Runs a picked row, closing the palette. Without the server, a job's row stays in its place, dimmed: picked, it says why nothing runs; so does one waiting on a job. */
function pickRow(x: PaletteCommand | undefined, o: { offline: boolean; toast: (text: string) => void; close: () => void }): void {
  if (!x) return;
  const refused = pickRefusal(x, o.offline);
  if (refused) return o.toast(refused);
  o.close();
  x.run();
}

/**
 * Each word typed says how many rows it found, in the one polite live region: as the words change,
 * not as later rows (recorded data, an older run) arrive. None found says so in the list's own
 * status, so it isn't said twice; opening the palette says nothing.
 */
function useSayCount(q: string, count: number): void {
  const typedOnce = useRef(false);
  useEffect(() => {
    if (!typedOnce.current) {
      typedOnce.current = true;
      return;
    }
    if (count) announce(plural(count, 'result'));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- said as the words change, not as later rows arrive
  }, [q]);
}

/** Why a job's row waits, said once under the field, which it describes: each such row keeps its hint and says paused. */
function OfflineLine() {
  return (
    <p className="paloff" id="palOff">
      <span className="cdot" aria-hidden="true" />
      Offline: actions paused until the dashboard server is back.
    </p>
  );
}

/** A row's hint at its right: a run's about line, what a recorded hit matched, or any other hint. */
function RowHint({ x, q }: { x: PaletteCommand & { snippet?: string }; q: string }) {
  // A run's about line as its hint, fitted to the rest of the row, the search word marked where it still is.
  if (x.about) return <AboutLine about={x.about as { text: string; from: 'user' }} className="ph2" mark={words(q).find((w) => x.about!.text.toLowerCase().includes(w)) ?? null} />;
  // Any other hint (a command, a list) is cut only at its end after a whole word: an id in it is whole or left out.
  if (!x.snippet && x.hint) return <FitHint text={x.hint} short={x.short ?? null} className="ph2" />;
  return (
    <span className="ph2">
      {x.hint}
      {x.snippet ? (
        <>
          {' · '}
          {snippetParts(x.snippet).map((p, k) => (p.match ? <mark key={k}>{p.text}</mark> : <span key={k}>{p.text}</span>))}
        </>
      ) : null}
    </span>
  );
}

/**
 * A run in the palette's Runs group: its id, its about line as the hint (decision 10), fitted to the
 * rest of the row. It matches its kind, command and labels too, which don't show. A server that sends
 * no about line gets the old hint: what it is and its command, and its labels.
 */
function runCommand(r: RunLike & { runId: string; labels: readonly string[] }): PaletteCommand {
  const unseen = `${kindWord(r)} · ${runSource(r)}${r.labels.length ? ` · ${r.labels.join(', ')}` : ''}`;
  return {
    group: 'Runs',
    label: shortId(r.runId),
    mono: true,
    ...(r.about ? { hint: r.about.text, about: r.about, match: unseen } : { hint: unseen }),
    run: () => navigate(href.run(r.runId)),
  };
}
