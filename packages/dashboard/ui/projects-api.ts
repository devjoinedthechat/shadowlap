import type { AddProjectView, RemoveDialogView, SetupView, SwitcherView } from '../src/projects.js';

/**
 * Projects' part of the API client (`client.projects`): the switcher, Add a project, removing one,
 * and the current project's setup. A dashboard that serves one store (an older server, `--read-only`,
 * the terminal UI's) has none of it: `list()` and `setup()` answer null there, and the pages fall
 * back to what they showed before. Types only from the server's read model (`src/projects.ts`).
 */

export type { AddProjectView, RemoveDialogView, SetupView, SwitcherView };
export type { AddFolderItem, CalibrateStep, FindingRow, InspectStep, OnDiskRow, RecordStep, RemoveMode, StepState, SwitcherItem, TestStep, ToolRow } from '../src/projects.js';

/** The switcher as `GET /api/projects` serves it: the projects, and why the list can't be changed when it can't. */
export interface ProjectsView extends SwitcherView {
  notice: string | null;
  warnings: string[];
}

export interface AddedProject {
  project: { id: string; name: string; path: string };
  again: boolean;
  runs: number;
  /** The toast: `Added ~/research-agent`, or `Added ~/support-agent back · 21 runs`. */
  message: string;
  current: string;
}

export interface RemovedProject {
  removed: string;
  current: string;
  deleted: string[];
  message: string;
}

/** The dialog that asks before a command's first run in a folder. */
export interface RecordConfirmation {
  title: string;
  text: string;
  command: string;
  button: string;
}

/** What recording a typed command runs, and whether it asks first. */
export interface RecordPlanView {
  /** As a terminal shows it: `shadowlap run -- uv run agent.py`. */
  display: string;
  argv: string[];
  confirm: RecordConfirmation | null;
}

export interface ProjectsApi {
  /** The switcher, or null when the server serves one store. */
  list(): Promise<ProjectsView | null>;
  /** Switches: the store, config and folder jobs run in become that project's. */
  select(id: string): Promise<{ current: string; name: string }>;
  /** Folders for a typed path, and the picked one checked. */
  folders(query: string, pick?: string | null): Promise<AddProjectView>;
  /** Adds a folder and switches to it. */
  add(path: string): Promise<AddedProject>;
  /** What the Remove dialog shows for a project. */
  removal(id: string): Promise<RemoveDialogView>;
  remove(id: string, options: { deleteRecordings: boolean; name: string }): Promise<RemovedProject>;
  /** The current project's setup, or null when the server serves one store. */
  setup(): Promise<SetupView | null>;
  /** What recording `command` in the project's folder runs, and the confirmation to show first. Changes nothing. */
  planRecording(project: string, command: string): Promise<RecordPlanView>;
  /** Where the golden would go, checked: inside the project, not over another golden. Changes nothing. */
  checkGolden(project: string, golden: string): Promise<{ path: string; runId: string | null }>;
  /** Skip the rest, or Go to the overview: the project is set up. */
  finish(project: string): Promise<{ project: string; stage: string }>;
}

/** The client's request function, as `createClient` has it: JSON in and out, an `ApiError` with the server's message. */
export type Request = <T>(path: string, init?: RequestInit) => Promise<T>;

// ---- the project this page shows, and a switch made elsewhere

/** The project the page shows, as its meta last named it: every request says it (`x-shadowlap-project`). */
let shown: string | null = null;
const switched = new Set<(current: { id: string; name: string }) => void>();

/** The page now shows this project (its meta arrived): what it asks for is about this one. */
export function showProject(id: string | null | undefined): void {
  shown = id ?? null;
}

/** The header that names the shown project, for a request: a change asked for from a page that shows another project than the current one is refused. */
export function projectHeader(): Record<string, string> {
  return shown ? { 'x-shadowlap-project': shown } : {};
}

/**
 * A request was refused because the dashboard switched to another project elsewhere (another tab):
 * the answer names the current one. Listeners turn the page to it.
 */
export function noteRefusal(status: number, body: unknown): void {
  const current = (body as { current?: { id?: unknown; name?: unknown } } | null)?.current;
  if (status !== 409 || !current || typeof current.id !== 'string' || typeof current.name !== 'string' || current.id === shown) return;
  for (const l of switched) l({ id: current.id, name: current.name });
}

/** Hears a switch made elsewhere, as a refused request reveals it; returns what stops it. */
export function onProjectSwitched(listener: (current: { id: string; name: string }) => void): () => void {
  switched.add(listener);
  return () => {
    switched.delete(listener);
  };
}

/** A server without projects: an older one (no endpoint), or one that serves one store. */
function noProjectsHere(err: unknown): boolean {
  const e = err as { status?: number; message?: string } | null;
  return !!e && (e.status === 404 || e.status === 405) && /^no endpoint|serves one store/.test(e.message ?? '');
}

export function projectsApi(request: Request): ProjectsApi {
  const send = <T>(method: string, path: string, body: unknown): Promise<T> => request<T>(path, { method, body: JSON.stringify(body) });
  const orNull = async <T>(p: Promise<T>): Promise<T | null> => {
    try {
      return await p;
    } catch (err) {
      if (noProjectsHere(err)) return null;
      throw err;
    }
  };
  const id = encodeURIComponent;
  return {
    list: () => orNull(request<ProjectsView>('projects')),
    select: (projectId) => send('POST', `projects/${id(projectId)}/select`, {}),
    folders: (query, pick) => request<AddProjectView>(`projects/folders?q=${id(query)}${pick ? `&pick=${id(pick)}` : ''}`),
    add: (path) => send('POST', 'projects', { path }),
    removal: (projectId) => request<RemoveDialogView>(`projects/${id(projectId)}/remove`),
    remove: (projectId, o) => send('POST', `projects/${id(projectId)}/remove`, { deleteRecordings: o.deleteRecordings, name: o.name }),
    setup: () => orNull(request<SetupView>('setup')),
    planRecording: (project, command) => send('POST', 'setup/record', { project, command }),
    checkGolden: (project, golden) => send('POST', 'setup/golden', { project, golden }),
    finish: (project) => send('POST', 'setup/finish', { project }),
  };
}

/** An exported copy has no projects: the lists are empty, and every change says why. */
export function noProjects(refuse: () => Promise<never>): ProjectsApi {
  return {
    list: () => Promise.resolve(null),
    select: refuse,
    folders: refuse,
    add: refuse,
    removal: refuse,
    remove: refuse,
    setup: () => Promise.resolve(null),
    planRecording: refuse,
    checkGolden: refuse,
    finish: refuse,
  };
}
