import { compactPath, projectOfStore } from '../format.js';
import type { Meta } from '../api.js';

/**
 * The project at the top of the sidebar: its name and folder. The switcher (other projects, Add
 * project…, Remove) replaces this component; it gets the same meta.
 */

export function projectOf(meta: Meta | null): { name: string; path: string } | null {
  if (meta?.project) return meta.project;
  return meta?.dbPath ? projectOfStore(meta.dbPath) : null;
}

export function ProjectBlock({ meta }: { meta: Meta | null }) {
  const p = projectOf(meta);
  if (meta?.static) {
    return (
      <div className="proj is-static">
        <span className="pa">S</span>
        <span className="pn">
          <b>Exported copy</b>
          <small>{meta.runIds?.length ?? 0} runs · nothing runs from here</small>
        </span>
      </div>
    );
  }
  const name = p?.name ?? 'this store';
  return (
    <div className="proj is-static" title={p?.path ?? meta?.dbPath ?? undefined}>
      <span className="pa">{name.charAt(0).toUpperCase()}</span>
      <span className="pn">
        <b>{name}</b>
        <small>{p ? compactPath(p.path, 30) : meta?.dbPath ? compactPath(meta.dbPath, 30) : '…'}</small>
      </span>
    </div>
  );
}
