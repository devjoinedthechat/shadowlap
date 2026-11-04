import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isObject, shadowlapHome, writeFileAtomic } from '@shadowlap/engine';

/**
 * When each golden's checks were last seen to change, kept for this machine in Shadowlap's folder
 * (shadowlapHome): a run recorded before then is judged by today's checks (run-outcome.ts). The
 * config file's time says when it was last written, not whose checks the write changed, so the
 * dashboard keeps a key for each golden's `expect` as it read it, and when it saw the key change: by
 * the config's write that changed it, as near as the file's time tells. A golden first seen has no
 * such time: its checks came with it, when it was packed.
 *
 * The file is a cache a dashboard reads once and writes when a key changes, in one step; one that
 * can't be read or written is as none, and only costs the times it held.
 */

export const CHECKS_SEEN_FILE = 'checks-seen.json';
const FORMAT = 1;
/** The most projects the file keeps, the one least lately changed going first. */
const PROJECTS = 200;

/** A golden's checks as last seen: a key for its `expect`, and when it was seen to change (null: not since it was first seen). */
export interface SeenChecks {
  key: string;
  at: number | null;
}

type Projects = Map<string, Map<string, SeenChecks>>;

/** The file as read, by its path: read once per process, then kept in step with what is written. */
const files = new Map<string, Projects>();

function read(file: string): Projects {
  const out: Projects = new Map();
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return out;
  }
  if (!isObject(data) || data.format !== FORMAT || !isObject(data.projects)) return out;
  for (const [dir, goldens] of Object.entries(data.projects)) {
    if (!isObject(goldens)) continue;
    const seen = new Map<string, SeenChecks>();
    for (const [path, v] of Object.entries(goldens)) {
      if (isObject(v) && typeof v.key === 'string' && (v.at === null || (typeof v.at === 'number' && Number.isFinite(v.at)))) seen.set(path, { key: v.key, at: v.at });
    }
    out.set(dir, seen);
  }
  return out;
}

const fileOf = (env: NodeJS.ProcessEnv) => join(shadowlapHome(env), CHECKS_SEEN_FILE);

function projectsOf(env: NodeJS.ProcessEnv): { file: string; projects: Projects } {
  const file = fileOf(env);
  let projects = files.get(file);
  if (!projects) files.set(file, (projects = read(file)));
  return { file, projects };
}

/** Each golden's checks as last seen in the project, by the golden's folder. */
export function seenChecks(dir: string, env: NodeJS.ProcessEnv = process.env): ReadonlyMap<string, SeenChecks> {
  return projectsOf(env).projects.get(dir) ?? new Map();
}

/** Keeps each golden's checks as seen now in the project, the goldens no longer there left out, and writes the file. */
export function keepSeenChecks(dir: string, seen: ReadonlyMap<string, SeenChecks>, env: NodeJS.ProcessEnv = process.env): void {
  const { file, projects } = projectsOf(env);
  projects.delete(dir);
  projects.set(dir, new Map(seen));
  while (projects.size > PROJECTS) projects.delete(projects.keys().next().value!);
  const out: Record<string, Record<string, SeenChecks>> = {};
  for (const [d, goldens] of projects) out[d] = Object.fromEntries(goldens);
  try {
    writeFileAtomic(file, `${JSON.stringify({ format: FORMAT, projects: out }, null, 2)}\n`);
  } catch {
    // a folder that can't be written: the times are kept for as long as this dashboard runs
  }
}
