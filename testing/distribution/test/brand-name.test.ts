// The name is written all lowercase, shadowlap, wherever people read it: the dashboard, the CLI's
// output, the docs, a pull request's comment, a docstring, also at the start of a sentence. These
// checks keep a capital one from coming back in any tracked file.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SELF = 'testing/distribution/test/brand-name.test.ts';
/** A golden's recorded content: what an agent read and said when it was recorded, kept as it was. */
const RECORDED = /^testing\/golden\/[^/]+\/blobs\//;

/**
 * The name written with a capital, as a word of its own, in a line, also right after an escape in a
 * string (`'# Notes\nShadowlap …'`). Names that only contain it keep their case
 * (ShadowlapInjectedTimeout, SHADOWLAP_HOME), and so do the store's folder and the config file spelled
 * in another case on purpose, as the tests of case-folding file systems do: `.Shadowlap/packs`,
 * `agents/Shadowlap.Config.json`.
 */
function capitalNames(line: string): string[] {
  return [...line.matchAll(/(?:(?<=\\[ntr])|(?<![\w.]))Shadowlap\b(?!\.Config)/g)].map((m) => m[0]);
}

describe('the name', () => {
  it('is all lowercase in every tracked file', () => {
    const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter((f) => f && f !== SELF && !RECORDED.test(f));
    const found: string[] = [];
    for (const file of files) {
      let text: string;
      try {
        text = readFileSync(join(ROOT, file), 'utf8');
      } catch {
        continue; // a file the index has and the checkout doesn't
      }
      if (text.includes('\0')) continue; // binary
      text.split('\n').forEach((line, i) => {
        if (capitalNames(line).length) found.push(`${file}:${i + 1} ${line.trim().slice(0, 120)}`);
      });
    }
    expect(found).toEqual([]);
  });

  it('finds a capital one in a sentence, a heading or a string, and not in names that contain it', () => {
    expect(capitalNames('Shadowlap records it. ### Shadowlap: 1 of 1 golden passed · "Shadowlap’s proxy" · <title>Shadowlap</title>')).toHaveLength(4);
    expect(capitalNames(String.raw`'# Notes\nShadowlap records and replays agent runs.' · "a\tShadowlap"`)).toHaveLength(2);
    expect(capitalNames('ShadowlapInjectedTimeout · viaShadowlap · SHADOWLAP_HOME · .Shadowlap/packs · agents/Shadowlap.Config.json · shadowlap')).toEqual([]);
  });
});
