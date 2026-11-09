import { describe, expect, it } from 'vitest';
import { findProgram, repairerProblem } from '../src/fix-jobs.js';

/**
 * Whether a repair from a fix can ask its repairer, as the dashboard's Run repair and the
 * terminal UI ask it (fix-jobs.ts): claude must be found as the repair would start it, on the PATH a
 * job gets. Files are made up here (`isFile`), on either system.
 */

const files = (...paths: string[]) => (p: string) => paths.includes(p);

describe('findProgram', () => {
  it('looks for a bare name in each folder of PATH, skipping empty and relative entries', () => {
    const o = { path: '/usr/bin::bin:/opt/claude/bin', platform: 'darwin' as const };
    expect(findProgram('claude', { ...o, isFile: files('/opt/claude/bin/claude') })).toBe(true);
    // An empty or relative entry names the folder the repairer starts in, which is a new one.
    expect(findProgram('claude', { ...o, isFile: files('bin/claude', 'claude') })).toBe(false);
    expect(findProgram('claude', { ...o, path: '', isFile: files('/usr/bin/claude') })).toBe(false);
  });

  it('takes a path where it points: an absolute one only', () => {
    const o = { path: '/usr/bin', platform: 'linux' as const };
    expect(findProgram('/home/dana/.local/bin/claude', { ...o, isFile: files('/home/dana/.local/bin/claude') })).toBe(true);
    expect(findProgram('/home/dana/.local/bin/claude', { ...o, isFile: files('/usr/bin/claude') })).toBe(false);
    expect(findProgram('tools/claude', { ...o, isFile: files('tools/claude', '/usr/bin/tools/claude') })).toBe(false);
  });

  it('on Windows, tries the extensions PATHEXT lists, as npm installs claude.cmd, in quoted folders too', () => {
    const o = { path: 'C:\\Windows;"C:\\Users\\dana\\AppData\\Roaming\\npm"', pathext: '.COM;.EXE;.BAT;.CMD', platform: 'win32' as const };
    expect(findProgram('claude', { ...o, isFile: files('C:\\Users\\dana\\AppData\\Roaming\\npm\\claude.cmd') })).toBe(true);
    expect(findProgram('claude', { ...o, isFile: files('C:\\Windows\\claude.exe') })).toBe(true);
    expect(findProgram('claude', { ...o, isFile: files('C:\\Windows\\claude.ps1') })).toBe(false);
    expect(findProgram('C:\\tools\\claude', { ...o, isFile: files('C:\\tools\\claude.exe') })).toBe(true);
  });
});

describe('repairerProblem', () => {
  const env = { PATH: '/usr/bin:/usr/local/bin' };
  const none = files();
  const claude = files('/usr/local/bin/claude');

  it('says nothing when claude is found, or when the repairer is an API it can’t check without asking', () => {
    expect(repairerProblem('claude-code', false, { env, platform: 'darwin', isFile: claude })).toBeNull();
    expect(repairerProblem('claude-code:claude-opus-5-5', true, { env, platform: 'darwin', isFile: claude })).toBeNull();
    expect(repairerProblem('anthropic', true, { env, platform: 'darwin', isFile: none })).toBeNull();
    expect(repairerProblem('openai:gpt-6-astra', true, { env, platform: 'darwin', isFile: none })).toBeNull();
  });

  it('says why claude can’t be asked, and what to do, as the config has it', () => {
    expect(repairerProblem('claude-code', false, { env, platform: 'darwin', isFile: none })).toBe('This repair asks your own Claude Code, and claude was not found on this machine: install Claude Code, or set SHADOWLAP_CLAUDE to its path, or name another repairer in shadowlap.config.json (repair.repairer).');
    expect(repairerProblem('claude-code', true, { env, platform: 'darwin', isFile: none })).toBe('shadowlap.config.json names Claude Code as the repairer, and claude was not found on this machine: install Claude Code, or set SHADOWLAP_CLAUDE to its path, or have the config name another repairer.');
  });

  it('looks where SHADOWLAP_CLAUDE points instead, as the repair does', () => {
    const named = { ...env, SHADOWLAP_CLAUDE: '/opt/claude' };
    expect(repairerProblem('claude-code', false, { env: named, platform: 'darwin', isFile: files('/opt/claude') })).toBeNull();
    expect(repairerProblem('claude-code', false, { env: named, platform: 'darwin', isFile: claude })).toBe('This repair asks your own Claude Code, and /opt/claude, which SHADOWLAP_CLAUDE names, was not found: point SHADOWLAP_CLAUDE at Claude Code, or name another repairer in shadowlap.config.json (repair.repairer).');
  });

  it('reads Windows variables whatever the case of their names', () => {
    expect(repairerProblem('claude-code', false, { env: { Path: 'C:\\npm', PATHEXT: '.CMD' }, platform: 'win32', isFile: files('C:\\npm\\claude.cmd') })).toBeNull();
  });
});
