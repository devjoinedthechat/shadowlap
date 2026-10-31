import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sheet, sheetFiles } from './css-sheet.js';

/**
 * The stylesheet is a file per area of the dashboard (ui/css/), joined by ui/app.css's @imports in an
 * order that keeps every rule after the ones it overrides: app.css holds nothing else, each area file
 * is joined once and imports nothing itself, and what a file loads (the fonts) is where its path says.
 */

const APP = new URL('../ui/app.css', import.meta.url);
const CSS = new URL('../ui/css/', import.meta.url);
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '');

describe('the stylesheet’s files', () => {
  it('joins every area file once, from app.css, which holds nothing but its imports', () => {
    const joined = sheetFiles().map((f) => fileURLToPath(f));
    const files = readdirSync(CSS)
      .filter((f) => f.endsWith('.css'))
      .map((f) => fileURLToPath(new URL(f, CSS)));
    expect([...joined].sort()).toEqual([...files].sort());
    expect(new Set(joined).size).toBe(joined.length);
    expect(joined[0]).toMatch(/tokens\.css$/);
    const rest = strip(readFileSync(APP, 'utf8')).replace(/^@import\s+[^;]+;\s*$/gm, '');
    expect(rest.trim()).toBe('');
  });

  it('imports nothing from an area file, and loads each font from where it is', () => {
    for (const file of sheetFiles()) {
      const text = strip(readFileSync(file, 'utf8'));
      expect(text, fileURLToPath(file)).not.toMatch(/@import/);
      for (const m of text.matchAll(/url\(\s*['"]?(?!data:)([^'")]+)['"]?\s*\)/g)) expect(existsSync(new URL(m[1], file)), `${fileURLToPath(file)}: ${m[1]}`).toBe(true);
    }
    expect(strip(sheet())).toMatch(/@font-face/);
  });
});
