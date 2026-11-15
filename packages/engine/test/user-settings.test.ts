import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { shadowlapHomeProblem } from '../src/projects/paths.js';
import { readSpending, USER_SETTINGS_FILE, userSettingsFile, UserSettingsError, writeSpending } from '../src/user-settings.js';

/**
 * Spending is each person's own, on their machine: settings.json in shadowlap's folder for this
 * machine's files (SHADOWLAP_HOME, else ~/.shadowlap), never shadowlap.config.json. Every test here
 * gives that folder, and the home folder it falls back to, a temporary folder of its own.
 */

const dirs: string[] = [];
const fresh = (prefix: string): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A SHADOWLAP_HOME of its own, and a home folder of its own behind it. */
const place = () => {
  const own = fresh('sl-settings-home-');
  return { own, o: { env: { SHADOWLAP_HOME: own }, home: fresh('sl-settings-user-') } };
};

describe('Spending, kept in this machine’s settings', () => {
  it('asks above $0.50 until it is set, and keeps no file for that', () => {
    const { own, o } = place();
    expect(readSpending(o)).toEqual({ askAbove: 0.5, set: false, file: join(own, USER_SETTINGS_FILE), problems: [] });
    expect(existsSync(join(own, USER_SETTINGS_FILE))).toBe(false);
  });

  it('keeps each pick in SHADOWLAP_HOME, owner-only, and says what it was before, for an Undo to write back', () => {
    const { own, o } = place();
    expect(writeSpending(2, o)).toEqual({ askAbove: 2, set: true, file: join(own, 'settings.json'), problems: [], was: 0.5 });
    expect(readSpending(o)).toMatchObject({ askAbove: 2, set: true });
    expect(writeSpending(null, o).was).toBe(2);
    expect(readSpending(o).askAbove).toBeNull();
    expect(writeSpending(0, o).was).toBeNull();
    expect(readSpending(o).askAbove).toBe(0);
    expect(JSON.parse(readFileSync(join(own, 'settings.json'), 'utf8'))).toEqual({ version: 1, spending: { askAbove: 0 } });
    // Kept in whole cents, as a sum that floating point holds a hair off.
    expect(writeSpending(0.1 + 0.2, o).askAbove).toBe(0.3);
    expect(readSpending(o).askAbove).toBe(0.3);
    if (process.platform !== 'win32') expect(statSync(join(own, 'settings.json')).mode & 0o777).toBe(0o600);
  });

  it('keeps what it doesn’t know of the file, a newer shadowlap’s settings among them', () => {
    const { own, o } = place();
    writeFileSync(join(own, 'settings.json'), JSON.stringify({ version: 1, theme: 'dark', spending: { askAbove: 2, note: 'kept' } }));
    writeSpending(0.5, o);
    expect(JSON.parse(readFileSync(join(own, 'settings.json'), 'utf8'))).toEqual({ version: 1, theme: 'dark', spending: { askAbove: 0.5, note: 'kept' } });
  });

  it('refuses a value that is no threshold, and a file it would lose something of', () => {
    const { own, o } = place();
    for (const bad of [0.505, -1, Infinity, Number.NaN]) expect(() => writeSpending(bad, o), String(bad)).toThrow(UserSettingsError);
    // Named as it reads, which JSON would call null.
    expect(() => writeSpending(Infinity, o)).toThrow('Infinity is no threshold: an amount in dollars, such as 0.50, or null to never ask');
    expect(() => writeSpending(Number.NaN, o)).toThrow(/^NaN is no threshold/);
    writeFileSync(join(own, 'settings.json'), '{ not json');
    expect(() => writeSpending(2, o)).toThrow(`${join(own, 'settings.json')} isn’t valid JSON: fix or remove it, and change Spending again`);
    expect(readFileSync(join(own, 'settings.json'), 'utf8')).toBe('{ not json');
    writeFileSync(join(own, 'settings.json'), JSON.stringify({ version: 2, spending: { askAbove: 2 } }));
    expect(() => writeSpending(0.5, o)).toThrow('was written by a newer shadowlap: update this one to change its settings');
    // A newer shadowlap's file is still read.
    expect(readSpending(o).askAbove).toBe(2);
  });

  it('reads the default, and says why, from a file it can’t read or a value it can’t hold', () => {
    const { own, o } = place();
    writeFileSync(join(own, 'settings.json'), '[1, 2]');
    expect(readSpending(o)).toMatchObject({ askAbove: 0.5, set: false, problems: [`${join(own, 'settings.json')} holds no settings: it is JSON, but no object`] });
    writeFileSync(join(own, 'settings.json'), JSON.stringify({ spending: { askAbove: 'lots' } }));
    expect(readSpending(o)).toMatchObject({ askAbove: 0.5, set: false, problems: [`${join(own, 'settings.json')}: spending.askAbove is "lots", which is no threshold (an amount in dollars, such as 0.50, or null to never ask), so it asks above the default $0.50`] });
    // 1e999 is JSON, which reads back as Infinity.
    writeFileSync(join(own, 'settings.json'), '{"spending":{"askAbove":1e999}}');
    expect(readSpending(o)).toMatchObject({ askAbove: 0.5, set: false, problems: [`${join(own, 'settings.json')}: spending.askAbove is Infinity, which is no threshold (an amount in dollars, such as 0.50, or null to never ask), so it asks above the default $0.50`] });
  });

  it('ignores a relative SHADOWLAP_HOME, as the project list does, and keeps the settings in the home folder’s', () => {
    const home = fresh('sl-settings-user-');
    const o = { env: { SHADOWLAP_HOME: 'sl-relative-home' }, home };
    const kept = join(home, '.shadowlap', 'settings.json');
    expect(userSettingsFile(o)).toBe(kept);
    // In the words the project list and every other file kept for this machine say it in.
    const why = shadowlapHomeProblem(o.env, home)!;
    expect(why).toMatch(/^SHADOWLAP_HOME is sl-relative-home, which isn’t an absolute path, so it is ignored/);
    expect(writeSpending(2, o)).toMatchObject({ file: kept, problems: [why] });
    expect(readSpending(o)).toMatchObject({ askAbove: 2, file: kept });
    expect(existsSync(join(process.cwd(), 'sl-relative-home'))).toBe(false);
  });

  it('refuses a folder given as a relative path', () => {
    expect(() => userSettingsFile({ dir: 'settings' })).toThrow(UserSettingsError);
    expect(() => readSpending({ dir: join('relative', 'dir') })).toThrow('isn’t an absolute path');
    const dir = join(fresh('sl-settings-dir-'), 'nested');
    mkdirSync(dir);
    expect(writeSpending(2, { dir }).file).toBe(join(dir, 'settings.json'));
  });
});
