// What a release tag must agree with before anything is published (release.yml): every published
// package, the Python SDK and the version the Node SDK sends carry the tag's version, and CHANGELOG.md
// has a section for it, which becomes the release's notes. Prints each disagreement and ends with 1.
//
//   node scripts/release-check.mjs v0.1.0                    # the checks
//   node scripts/release-check.mjs v0.1.0 --notes notes.md   # and the version's section, for the notes
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * The section of a changelog for `version`: its `## [x.y.z]` heading and what follows, up to the next
 * `## ` heading, without the link references; null when it has none, or nothing under its heading.
 */
export function changelogSection(text, version) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^## /.test(l) && l.slice(3).trim().split(/\s/)[0].replace(/[[\]]/g, '') === version);
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  const section = lines.slice(start, end).filter((l) => !/^\[[^\]]+\]: /.test(l));
  return section.slice(1).some((l) => l.trim()) ? section.join('\n').trim() + '\n' : null;
}

/** Each way the repository at `root` disagrees with a release of `version`. */
export function releaseProblems(root, version) {
  const problems = [];
  const read = (path) => readFileSync(join(root, path), 'utf8');
  for (const dir of readdirSync(join(root, 'packages'), { withFileTypes: true }).filter((e) => e.isDirectory())) {
    const pkg = JSON.parse(read(join('packages', dir.name, 'package.json')));
    if (!pkg.private && pkg.version !== version) problems.push(`packages/${dir.name} (${pkg.name}) is ${pkg.version}`);
  }
  const py = /^version = "([^"]*)"$/m.exec(read('sdks/python/pyproject.toml'))?.[1];
  if (py !== version) problems.push(`the Python SDK (sdks/python/pyproject.toml) is ${py ?? 'unversioned'}`);
  const pyInit = /^__version__ = "([^"]*)"$/m.exec(read('sdks/python/shadowlap/__init__.py'))?.[1];
  if (pyInit !== version) problems.push(`the Python SDK's __version__ is ${pyInit ?? 'missing'}`);
  const node = /^export const VERSION = '([^']*)';$/m.exec(read('packages/sdk/src/version.ts'))?.[1];
  if (node !== version) problems.push(`the version the Node SDK sends (packages/sdk/src/version.ts) is ${node ?? 'missing'}`);
  if (!changelogSection(read('CHANGELOG.md'), version)) problems.push(`CHANGELOG.md has no section for ${version} (a "## [${version}] - <date>" heading with the release's changes under it)`);
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [tag = '', flag, notes] = process.argv.slice(2);
  const version = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag)?.[1];
  if (!version || (flag !== undefined && (flag !== '--notes' || !notes))) {
    process.stderr.write('usage: node scripts/release-check.mjs v<semver> [--notes <file>]\n');
    process.exit(2);
  }
  const problems = releaseProblems(ROOT, version);
  if (problems.length) {
    process.stderr.write(`The tag ${tag} doesn't match the repository:\n${problems.map((p) => `  - ${p}`).join('\n')}\nSet the version with node scripts/set-version.mjs ${version}, and give it a section in CHANGELOG.md.\n`);
    process.exit(1);
  }
  if (notes) writeFileSync(notes, changelogSection(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'), version));
  process.stdout.write(`${tag}: every package is ${version}, and CHANGELOG.md has its section\n`);
}
