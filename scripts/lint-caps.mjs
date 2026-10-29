// The files over a lint cap today, each held to what it is today. eslint.config.mjs caps every
// function's complexity, length and nesting and every file's length (CAPS), and lets the files that
// were over a cap when it came (lint-caps.json) be what they are, and no more. This checks that the
// list is exact, as `npm run lint` runs it: a file that shrank lowers its ceiling, and one back within
// the cap leaves the list. --write makes those changes. It never adds a file or raises a ceiling,
// as code that grew past one is made smaller; --add does, for a cap made stricter.
//
// Usage: node scripts/lint-caps.mjs [--write [--add]]
import { readFileSync, writeFileSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { CAPS, IGNORED, TEST_FILES } from '../eslint.config.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const LIST = `${root}lint-caps.json`;
const write = process.argv.includes('--write');
const add = process.argv.includes('--add');

/** A finding's number: the complexity, or the lines or depth in parentheses. */
const counted = (message) => Number((/complexity of (\d+)/.exec(message) ?? /\((\d+)\)\. Maximum/.exec(message) ?? [])[1]);

/** Each file over a cap, by rule, with its worst: ESLint's own rules, every limit at 0. */
async function measure() {
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: true,
    overrideConfig: [
      { ignores: IGNORED },
      {
        files: ['**/*.{ts,tsx,mts,cts,js,mjs,cjs}'],
        languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
        rules: Object.fromEntries(Object.entries(CAPS).map(([rule, options]) => [rule, ['error', { ...options, max: 0 }]])),
      },
      { files: TEST_FILES, rules: { 'max-lines-per-function': 'off' } },
    ],
  });
  const over = Object.fromEntries(Object.keys(CAPS).map((rule) => [rule, {}]));
  for (const result of await eslint.lintFiles(['.'])) {
    const file = relative(root, result.filePath).split(sep).join('/');
    for (const m of result.messages) {
      if (m.fatal) throw new Error(`${file} could not be read: ${m.message}`);
      const n = counted(m.message);
      if (!(m.ruleId in CAPS) || !Number.isFinite(n)) continue;
      if (n > CAPS[m.ruleId].max) over[m.ruleId][file] = Math.max(over[m.ruleId][file] ?? 0, n);
    }
  }
  return over;
}

const listed = JSON.parse(readFileSync(LIST, 'utf8'));
const now = await measure();
const next = {};
const changes = [];
const grown = [];
for (const [rule, cap] of Object.entries(CAPS)) {
  const held = listed[rule] ?? {};
  next[rule] = {};
  for (const [file, ceiling] of Object.entries(held)) {
    const at = now[rule][file];
    if (at === undefined) changes.push(`${file}: within the ${rule} cap of ${cap.max} now, so off the list`);
    else if (at < ceiling) changes.push(`${file}: ${rule} ${at}, under its ceiling of ${ceiling}`);
    else if (at > ceiling) grown.push(`${file}: ${rule} ${at}, past its ceiling of ${ceiling}`);
    if (at !== undefined) next[rule][file] = add ? at : Math.min(at, ceiling);
  }
  for (const [file, at] of Object.entries(now[rule])) {
    if (file in held) continue;
    grown.push(`${file}: ${rule} ${at}, past the cap of ${cap.max}`);
    if (add) next[rule][file] = at;
  }
  next[rule] = Object.fromEntries(Object.entries(next[rule]).sort(([a], [b]) => (a < b ? -1 : 1)));
}

if (write) {
  writeFileSync(LIST, `${JSON.stringify(next, null, 2)}\n`);
  for (const line of add ? [...changes, ...grown] : changes) console.log(line);
  if (grown.length && !add) {
    console.error(`\nlint-caps.json lowers no further than this: ${grown.length} past a ceiling or a cap, which ESLint refuses. Make them smaller.`);
    process.exitCode = 1;
  }
} else if (changes.length || grown.length) {
  for (const line of [...changes, ...grown]) console.error(line);
  if (changes.length) console.error('\nlint-caps.json is not exact: `node scripts/lint-caps.mjs --write` lowers it.');
  process.exitCode = 1;
} else {
  console.log(`lint-caps.json is exact: ${Object.values(next).reduce((n, files) => n + Object.keys(files).length, 0)} ceilings.`);
}
