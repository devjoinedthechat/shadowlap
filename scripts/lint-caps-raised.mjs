// What a pull request may do to lint-caps.json (scripts/lint-caps.mjs): lower a ceiling or take one
// off, never add one or raise one. `node scripts/lint-caps.mjs --write --add` can do both, as it must
// for a function renamed or moved, so CI holds every pull request to this, against where the request
// left its base branch (their merge base), as the request's diff reads it. Prints each ceiling added
// or raised and ends with 1; needs Node and git alone.
//
//   node scripts/lint-caps-raised.mjs origin/main     # the working tree's list against where it left main
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LIST = 'lint-caps.json';

/** Each ceiling a list holds, by where it is and its rule: `a.ts › run: complexity`, or `a.ts: max-lines` for a file's length. */
function ceilings(list) {
  const out = new Map();
  for (const [rule, files] of Object.entries(list)) {
    for (const [file, held] of Object.entries(files)) {
      if (typeof held === 'number') out.set(`${file}: ${rule}`, held);
      else for (const [fn, n] of Object.entries(held)) out.set(`${file} › ${fn}: ${rule}`, n);
    }
  }
  return out;
}

/** Each ceiling `now` adds to `before` or raises above it, in words. One lowered or taken off is no finding. */
export function raised(before, now) {
  const was = ceilings(before);
  const found = [];
  for (const [where, n] of ceilings(now)) {
    const old = was.get(where);
    if (old === undefined) found.push(`${where} ${n}, added`);
    else if (n > old) found.push(`${where} ${n}, raised from ${old}`);
  }
  return found;
}

/**
 * Each ceiling the working tree's lint-caps.json, in the repository at `root`, adds or raises since
 * its HEAD left `ref`. A list that wasn't there then held nothing. Throws, with git's words, when git
 * can't find `ref` or where HEAD left it (a shallow clone has no history to find it in).
 */
export function raisedSince(root, ref) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const base = git('merge-base', ref, 'HEAD').trim();
  const before = git('ls-tree', '--name-only', base, '--', LIST).trim() ? JSON.parse(git('show', `${base}:${LIST}`)) : {};
  return raised(before, JSON.parse(readFileSync(join(root, LIST), 'utf8')));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [ref, ...rest] = process.argv.slice(2);
  if (!ref || rest.length) {
    process.stderr.write('usage: node scripts/lint-caps-raised.mjs <ref>\n');
    process.exit(2);
  }
  let found;
  try {
    found = raisedSince(ROOT, ref);
  } catch (err) {
    const said = typeof err?.stderr === 'string' && err.stderr.trim() ? err.stderr.trim() : String(err?.message ?? err);
    process.stderr.write(`Could not read ${LIST} where HEAD left ${ref}: ${said}\n`);
    process.exit(2);
  }
  if (found.length) {
    process.stderr.write(
      `${LIST} adds or raises ${found.length === 1 ? 'a ceiling' : `${found.length} ceilings`} since ${ref}:\n${found.map((f) => `  - ${f}`).join('\n')}\n` +
        'A pull request may lower a ceiling or take one off, never add one or raise one: make the function smaller instead. A function renamed or moved shows here as added, under its new name: say so in the pull request, for review.\n',
    );
    process.exit(1);
  }
  process.stdout.write(`${LIST} adds no ceiling and raises none since ${ref}\n`);
}
