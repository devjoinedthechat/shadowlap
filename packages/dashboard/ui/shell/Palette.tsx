import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { JOB_KINDS, type SearchHit } from '../api.js';
import { Icon } from '../components/Icon.js';
import { isMac } from '../dom.js';
import { callName, shortId } from '../format.js';
import { highlight, limitRecorded, matchPalette, RECORDED_MIN_CHARS, snippetParts } from '../palette.js';
import { paletteSources } from '../palette-sources.js';
import { href, type Route } from '../route.js';
import { navigate } from '../router.js';
import { isAttempt, kindWord, runSource } from '../runs.js';
import { useApp, useLayer, type PaletteCommand } from '../state.js';

/**
 * Search or jump to (⌘K, Ctrl K, or / away from a run): This run, Go to, Actions, Runs, Fixes,
 * Tests, Projects, and, from three characters, what runs recorded. Every typed word must match.
 */
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
  const [hits, setHits] = useState<SearchHit[]>([]);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), []);

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
    if (!app.actionsOff && app.hasKind(JOB_KINDS.tests))
      out.push({ group: 'Actions', label: 'Run the tests', hint: 'shadowlap test goldens/*', run: () => app.guard(() => app.watchJob(app.client.startJob(JOB_KINDS.tests, {}))) });
    out.push({ group: 'Actions', label: 'Keyboard shortcuts', hint: '?', run: () => app.setHelp(true) });
    for (const source of paletteSources()) {
      try {
        out.push(...source({ app, route, go }).filter((x) => x.group !== 'Actions' || !app.actionsOff));
      } catch {
        // a source that fails leaves its group out
      }
    }
    const runs = [...(app.runs ?? [])].filter((r) => !isAttempt(r)).sort((a, b) => b.startedAt - a.startedAt);
    for (const r of runs)
      out.push({
        group: 'Runs',
        label: shortId(r.runId),
        mono: true,
        hint: `${kindWord(r)} · ${runSource(r)}${r.labels.length ? ` · ${r.labels.join(', ')}` : ''}`,
        run: () => go(href.run(r.runId)),
      });
    return out;
    // Built when the palette opens: the run list moving under it would move the selection.
  }, []);

  // What runs recorded, from three characters, through the server's search.
  useEffect(() => {
    const t = q.trim();
    if (t.length < RECORDED_MIN_CHARS || app.exported) {
      setHits([]);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      app.client.search(t).then(
        (h) => alive && setHits(limitRecorded(h)),
        () => alive && setHits([]),
      );
    }, 220);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [q, app.client, app.exported]);

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
    return [...matched, ...recorded] as Array<PaletteCommand & { snippet?: string }>;
  }, [items, q, hits]);

  const at = Math.min(i, Math.max(0, shown.length - 1));
  useEffect(() => {
    list.current?.querySelector('.palit.on')?.scrollIntoView({ block: 'nearest' });
  }, [at, shown.length]);

  const pick = (n: number) => {
    const x = shown[n];
    if (!x) return;
    close();
    x.run();
  };

  let group: string | null = null;
  return (
    <div className="scrim palscrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <label className="palin">
          <Icon name="search" />
          <span className="sr">Search</span>
          <input
            ref={input}
            type="text"
            placeholder={app.exported ? 'Search runs and pages' : 'Search runs, pages, actions and what runs recorded'}
            autoComplete="off"
            spellCheck={false}
            value={q}
            role="combobox"
            aria-expanded="true"
            aria-controls="palList"
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
              } else if (e.key === 'Enter') {
                e.preventDefault();
                pick(at);
              }
            }}
          />
          <span className="kbd">Esc</span>
        </label>
        <div className="pallist" id="palList" role="listbox" ref={list} tabIndex={-1}>
          {shown.length === 0 ? <div className="empty">Nothing matches “{q.trim()}”.</div> : null}
          {shown.map((x, n) => {
            const head = x.group !== group ? <div className="palg">{x.group}</div> : null;
            group = x.group;
            const mark = highlight(x.label, q);
            return (
              <Fragment key={`${x.group}:${x.label}:${n}`}>
                {head}
                <button type="button" role="option" aria-selected={n === at} className={`palit${n === at ? ' on' : ''}`} onMouseMove={() => n !== at && setI(n)} onClick={() => pick(n)}>
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
                  <span className="ph2">
                    {x.hint}
                    {x.snippet ? (
                      <>
                        {' · '}
                        {snippetParts(x.snippet).map((p, k) => (p.match ? <mark key={k}>{p.text}</mark> : <span key={k}>{p.text}</span>))}
                      </>
                    ) : null}
                  </span>
                  {n === at ? <span className="kbd">↵</span> : null}
                </button>
              </Fragment>
            );
          })}
        </div>
        <div className="palfoot">
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
