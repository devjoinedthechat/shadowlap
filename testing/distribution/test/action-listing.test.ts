// action.yml is what the GitHub Marketplace lists, once the owner publishes a release of it there.
// The listing takes the action's name, its description and its badge from the file, and refuses or
// flags ones it can't show: a description over 125 characters, a badge colour or icon it doesn't
// have. These checks keep the file listable.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const action = readFileSync(join(ROOT, 'action.yml'), 'utf8');

/** A top-level `key: value` of action.yml, or one under `branding:`, unquoted. */
function field(key: string, under?: string): string | undefined {
  const text = under ? action.slice(action.indexOf(`\n${under}:\n`) + under.length + 3).split(/\n(?! )/)[0] : action;
  const m = new RegExp(`^${under ? ' {2}' : ''}${key}: (.*)$`, 'm').exec(text);
  return m?.[1]?.replace(/^"(.*)"$/, '$1');
}

/** The colours a Marketplace badge can have (GitHub's metadata syntax, `branding.color`). */
const COLORS = ['white', 'black', 'yellow', 'blue', 'green', 'orange', 'red', 'purple', 'gray-dark'];
/** Feather icons GitHub leaves out of `branding.icon`, besides the brand icons. */
const OMITTED = ['coffee', 'columns', 'divide-circle', 'divide-square', 'divide', 'frown', 'hexagon', 'key', 'meh', 'mouse-pointer', 'smile', 'tool', 'x-octagon'];

describe('the action as the Marketplace lists it', () => {
  it('has a name and a description that fits the listing, leading with the job it does', () => {
    expect(field('name')).toBe('shadowlap test');
    const description = field('description')!;
    expect(description.length).toBeLessThanOrEqual(125);
    expect(description.startsWith('Change safety for agents: ')).toBe(true);
  });

  it('has a badge GitHub can draw', () => {
    expect(COLORS).toContain(field('color', 'branding'));
    const icon = field('icon', 'branding')!;
    expect(icon).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(OMITTED).not.toContain(icon);
  });
});
