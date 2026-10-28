import { useEffect, useRef, useState } from 'react';
import { CmdLine, PageHeader } from '../components/bits.js';
import { Icon } from '../components/Icon.js';
import { Page } from '../components/Page.js';
import { messageOf } from '../../../engine/src/message-of.js';
import { expectProject, type AddProjectView } from '../projects-api.js';
import { codeParts } from '../projects.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import { useApp } from '../state.js';

/**
 * Add a project (#/new): pick the folder your agent's code is in. Typing filters the folders the
 * server suggests (one level at a time, within the home folder and configured roots, never hidden
 * or system folders); each says what kind of project it holds, those already added are disabled,
 * and a folder without project files says why it can't be added. The button names the folder and
 * stays disabled until one with project files is picked. Nothing runs here: after adding, the
 * dashboard switches to the project and its setup opens.
 */
/** The project files a refusal names, shown as code as the mock writes them. */
const PROJECT_FILES = ['pyproject.toml', 'package.json'];

export function NewProjectPage() {
  const app = useApp();
  const { client, guard, toast, actionsOff, meta } = app;
  const [query, setQuery] = useState('');
  const [pick, setPick] = useState<string | null>(null);
  const [view, setView] = useState<AddProjectView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [busy, setBusy] = useState(false);
  const asked = useRef(0);
  /** Typing waits a moment before asking; a click asks at once. */
  const wait = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const oneStore = !!meta && !meta.static && !meta.project?.id;

  // Suggestions for what is typed, and the picked folder checked; the latest answer wins.
  useEffect(() => {
    if (oneStore) return;
    const n = ++asked.current;
    const timer = setTimeout(() => {
      client.projects.folders(query, pick).then(
        (v) => {
          if (n !== asked.current) return;
          setView(v);
          setError(null);
        },
        (err: unknown) => {
          if (n !== asked.current) return;
          const status = (err as { status?: number }).status;
          if (status === 404 || status === 405) setUnsupported(true);
          else setError(messageOf(err));
        },
      );
    }, wait.current);
    return () => clearTimeout(timer);
  }, [client, query, pick, oneStore]);

  // Ready to type a path, where a keyboard is at hand; a phone keeps its keyboard down until asked.
  useEffect(() => {
    if (matchMedia('(pointer: fine)').matches) input.current?.focus();
  }, []);

  if (unsupported || oneStore)
    return (
      <Page>
        <PageHeader eyebrow="projects" title="Add a project" text="A project is a folder with your agent’s code, and it keeps its own store." />
        <section className="panel stepempty">
          <h3>Start the dashboard in that folder</h3>
          <p>This dashboard serves one store: start one with shadowlap dashboard to add and switch projects.</p>
          <CmdLine>{'cd <folder> && shadowlap dashboard'}</CmdLine>
        </section>
      </Page>
    );

  const add = () => {
    const path = view?.button.path;
    if (!path || view.button.disabled) return;
    guard(() => {
      setBusy(true);
      client.projects.add(path).then(
        async (out) => {
          toast(out.message);
          expectProject(out.project.id);
          await app.reload();
          navigate(href.overview());
        },
        (err: unknown) => {
          setBusy(false);
          setError(messageOf(err));
        },
      );
    });
  };

  const fieldError = error ?? view?.error ?? null;
  const next = view?.next;
  return (
    <Page>
      <PageHeader eyebrow="projects" title={view?.title ?? 'Add a project'} text={view?.intro ?? 'Pick the folder your agent’s code is in. Nothing runs until you click.'} />
      <div className="newgrid">
        <section className="panel">
          <div className="pbody">
            <label className="pathin">
              <span className="k">{view?.field.label ?? 'Folder'}</span>
              <input
                ref={input}
                id="newPath"
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder={view?.field.placeholder ?? '~/path/to/your/agent'}
                value={query}
                onChange={(e) => {
                  wait.current = 120;
                  setQuery(e.target.value);
                  setPick(null);
                }}
                onKeyDown={(e) => {
                  // Enter takes the typed path as the folder: checked as typed, then where it leads.
                  if (e.key !== 'Enter') return;
                  e.preventDefault();
                  if (view && !view.button.disabled && pick) add();
                  else if (query.trim()) {
                    wait.current = 0;
                    setPick(query.trim());
                  }
                }}
              />
            </label>
            <div className="folders" role="listbox" aria-label="Folders">
              {view === null ? null : view.folders.length ? (
                view.folders.map((f) => (
                  <button
                    key={f.path}
                    type="button"
                    className="fold"
                    role="option"
                    aria-selected={f.selected}
                    disabled={f.disabled}
                    onClick={() => {
                      wait.current = 0;
                      // A folder without project files opens: its subfolders are listed, where the
                      // agent's code may be (~/code/invoice-bot), and why it can't be added shows.
                      if (!f.kind) setQuery(`${f.display}/`);
                      setPick(f.path);
                    }}
                    title={f.path}
                  >
                    <Icon name="folder" />
                    <span>
                      <b>{f.display}</b>
                      <small>{f.note}</small>
                    </span>
                    {f.selected ? <i className="tick">✓</i> : null}
                  </button>
                ))
              ) : (
                <div className="empty">{view.empty}</div>
              )}
            </div>
            {fieldError ? (
              <p className="fieldnote err">
                {codeParts(fieldError, PROJECT_FILES).map((p, i) => (p.code ? <code key={i}>{p.text}</code> : <span key={i}>{p.text}</span>))}
              </p>
            ) : null}
          </div>
          <footer className="pfoot addfoot">
            <a className="btn quiet" href={view?.cancel.href ?? href.overview()}>
              {view?.cancel.label ?? 'Cancel'}
            </a>
            <button className="btn lime" type="button" disabled={!view || view.button.disabled || busy || !!actionsOff} title={actionsOff ?? view?.button.title ?? undefined} onClick={add}>
              <span>{view?.button.label ?? 'Add project'}</span>
            </button>
          </footer>
        </section>
        <section className="panel nextsteps">
          <header>
            <h2>{next?.title ?? 'What happens next'}</h2>
          </header>
          <ol>
            {(next?.steps ?? []).map((s) => (
              <li key={s.title}>
                <b>{s.title}</b>
                <span>{s.text}</span>
              </li>
            ))}
          </ol>
          {next ? <p className="muted nextnote">{next.note}</p> : null}
        </section>
      </div>
    </Page>
  );
}
