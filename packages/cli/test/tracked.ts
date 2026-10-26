import { execFileSync } from 'node:child_process';

/**
 * Makes `dir` a git repository whose index holds `paths`, as a checkout holds the goldens it
 * committed: `shadowlap test` runs a golden's recorded command without asking for a pack the
 * repository tracks, or one this machine recorded, and asks of any other (golden-consent.ts).
 * Added whatever ignores them: a store kept in `dir` itself gives it a `.gitignore` of everything.
 */
export function trackInGit(dir: string, ...paths: string[]): void {
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['add', '-f', '--', ...paths], { cwd: dir, stdio: 'ignore' });
}
