import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SUGGEST_LIMITS, checkFolder, countGoldens, describeFolder, displayPath, listPacks, projectRoots, readPack, suggestFolders } from '../src/projects/index.js';

const dirs: string[] = [];
/** A temporary folder by its real path as the system names it, the way the project list keeps folders (on Windows, RUNNER~1 written out in full). */
function tempDir(prefix: string): string {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function files(root: string, tree: Record<string, string>): string {
  for (const [path, content] of Object.entries(tree)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    if (path.endsWith('/')) mkdirSync(join(root, path), { recursive: true });
    else writeFileSync(join(root, path), content);
  }
  return root;
}

/** A home folder like the mock's: three agents, a nested one, Downloads, and things never listed. */
function sampleHome(): string {
  const home = tempDir('sl-home-');
  files(home, {
    'research-agent/pyproject.toml': '[project]\nname = "research-agent"\n',
    'research-agent/uv.lock': '',
    'code/invoice-bot/package.json': '{"name":"invoice-bot"}',
    'code/invoice-bot/pnpm-lock.yaml': '',
    'support-agent/pyproject.toml': '[project]\n',
    'support-agent/package.json': '{}',
    'triage-bot/package.json': '{"name":"triage-bot"}',
    'triage-bot/package-lock.json': '{}',
    'Downloads/report.pdf': '',
    '.ssh/id_ed25519': 'secret',
    '.config/agent/package.json': '{}',
    'Library/Preferences/x.plist': '',
    'node_modules/left-pad/package.json': '{}',
    'notes.txt': 'not a folder',
  });
  return home;
}

describe('describeFolder', () => {
  const home = tempDir('sl-kinds-');
  const kind = (tree: Record<string, string>, name: string) => describeFolder(files(join(home, name), tree), { home });

  it('names the language, the package manager and the project files', () => {
    expect(kind({ 'pyproject.toml': '', 'uv.lock': '' }, 'uv')).toEqual({
      kind: 'Python · uv',
      label: 'Python · uv · pyproject.toml',
      languages: ['python'],
      managers: ['uv'],
      files: ['pyproject.toml', 'uv.lock'],
      why: null,
    });
    expect(kind({ 'package.json': '{}', 'package-lock.json': '{}' }, 'npm')).toMatchObject({ kind: 'Node · npm', label: 'Node · npm · package.json' });
    expect(kind({ 'package.json': '{}', 'pnpm-lock.yaml': '' }, 'pnpm')).toMatchObject({ kind: 'Node · pnpm', files: ['package.json', 'pnpm-lock.yaml'] });
    expect(kind({ 'requirements.txt': 'anthropic==0.69.0\n' }, 'pip')).toMatchObject({ kind: 'Python · pip', label: 'Python · pip · requirements.txt' });
    expect(kind({ 'Cargo.toml': '', 'Cargo.lock': '' }, 'rust')).toMatchObject({ kind: 'Rust · cargo' });
    expect(kind({ 'go.mod': 'module x\n' }, 'go')).toMatchObject({ kind: 'Go', label: 'Go · go.mod' });
  });

  it('goes by the manifest when there is no lockfile', () => {
    expect(kind({ 'package.json': '{"packageManager":"yarn@4.5.0"}' }, 'corepack')).toMatchObject({ kind: 'Node · yarn' });
    expect(kind({ 'package.json': '{}' }, 'bare-node')).toMatchObject({ kind: 'Node · npm' });
    expect(kind({ 'pyproject.toml': '[tool.poetry]\nname = "x"\n' }, 'poetry')).toMatchObject({ kind: 'Python · poetry' });
    expect(kind({ Pipfile: '' }, 'pipenv')).toMatchObject({ kind: 'Python · pipenv' });
  });

  it('lists both languages of a mixed project, Python first', () => {
    expect(kind({ 'package.json': '{}', 'pyproject.toml': '' }, 'mixed')).toMatchObject({ kind: 'Python · Node', label: 'Python · Node · pyproject.toml · package.json', managers: ['pip', 'npm'] });
  });

  it('explains a folder without project files, and one that is not a folder', () => {
    const downloads = files(join(home, 'Downloads'), { 'report.pdf': '', 'agent.py': 'print(1)' });
    expect(describeFolder(downloads, { home })).toEqual({
      kind: null,
      label: 'No project files',
      languages: [],
      managers: [],
      files: [],
      why: 'No pyproject.toml, package.json or requirements file in ~/Downloads. Pick the folder your agent’s code is in.',
    });
    expect(describeFolder(join(downloads, 'report.pdf'), { home }).why).toBe('~/Downloads/report.pdf isn’t a folder.');
    expect(describeFolder(join(home, 'nowhere'), { home }).why).toBe('~/nowhere doesn’t exist.');
    // A directory named like a manifest is not one.
    expect(kind({ 'package.json/': '' }, 'dir-not-file').kind).toBeNull();
  });
});

describe('suggestFolders', () => {
  const home = sampleHome();
  const outside = files(tempDir('sl-outside-'), { 'secret-project/package.json': '{}' });
  symlinkSync(join(outside, 'secret-project'), join(home, 'link-out'));
  symlinkSync(join(home, 'research-agent'), join(home, 'link-in'));
  symlinkSync(join(home, '.config', 'agent'), join(home, 'link-hidden'));

  it('lists the home folder with nothing typed: folders only, projects first, never hidden or system ones', () => {
    const s = suggestFolders('', { home });
    expect(s.listed).toBe('~/');
    expect(s.note).toBeNull();
    expect(s.folders.map((f) => [f.display, f.folder.kind])).toEqual([
      ['~/research-agent', 'Python · uv'],
      ['~/support-agent', 'Python · Node'],
      ['~/triage-bot', 'Node · npm'],
      ['~/code', null],
      ['~/Downloads', null],
    ]);
    // Paths are real paths; names are what the folder is called.
    expect(s.folders[0]).toMatchObject({ path: join(home, 'research-agent'), name: 'research-agent', added: false, projectId: null });
  });

  it('completes a typed name, matches at the start first, and descends into a typed folder', () => {
    expect(suggestFolders('~/tri', { home }).folders.map((f) => f.display)).toEqual(['~/triage-bot']);
    expect(suggestFolders('~/AGENT', { home }).folders.map((f) => f.display)).toEqual(['~/research-agent', '~/support-agent']);
    const code = suggestFolders('~/code/', { home });
    expect(code.listed).toBe('~/code/');
    expect(code.folders.map((f) => [f.display, f.folder.label])).toEqual([['~/code/invoice-bot', 'Node · pnpm · package.json']]);
    // Without ~, a path is read from the home folder too.
    expect(suggestFolders('code/inv', { home }).folders.map((f) => f.display)).toEqual(['~/code/invoice-bot']);
    expect(suggestFolders(`${home}/code/`, { home }).folders.map((f) => f.display)).toEqual(['~/code/invoice-bot']);
  });

  it('never leaves the home folder: not by .., an absolute path or a link', () => {
    for (const q of ['~/../', '/', '/etc/', `${outside}/`, '~/code/../../']) {
      const s = suggestFolders(q, { home });
      expect(s.folders, q).toEqual([]);
      expect(s.note, q).toBe('Only folders in your home folder are listed.');
    }
    expect(suggestFolders('~/link-out/', { home }).folders).toEqual([]);
    expect(suggestFolders('~root/', { home }).note).toBe('Only your own home folder is listed.');
  });

  it('answers the same for a path elsewhere whether it exists or not', () => {
    const there = suggestFolders(`${outside}/`, { home });
    const notThere = suggestFolders(`${outside}-nope/`, { home });
    expect(notThere).toEqual({ ...there, query: `${outside}-nope/` });
    expect(checkFolder(`${outside}-nope`, { home })).toEqual(checkFolder(outside, { home }));
    expect(checkFolder(`${outside}-nope`, { home })).toMatchObject({ code: 'outside' });
  });

  it('reaches a configured root through the link it was given as', () => {
    const real = files(tempDir('sl-linked-root-'), { 'agent/package.json': '{}' });
    const alias = join(tempDir('sl-alias-'), 'work');
    symlinkSync(real, alias);
    const s = suggestFolders(`${alias}/`, { home, roots: [alias] });
    expect(s.folders.map((f) => [f.name, f.path])).toEqual([['agent', join(real, 'agent')]]);
    expect(checkFolder(join(alias, 'agent'), { home, roots: [alias] })).toMatchObject({ ok: true, path: join(real, 'agent') });
  });

  it('follows a link only to a folder inside the home folder, and shows such a folder once', () => {
    const names = suggestFolders('~/', { home }).folders.map((f) => f.name);
    expect(names).not.toContain('link-out');
    expect(names).not.toContain('link-hidden');
    expect(names.filter((n) => n === 'research-agent' || n === 'link-in')).toEqual(['research-agent']);
    // Typed by its own name, the link is listed as the folder it points at.
    expect(suggestFolders('~/link-in', { home }).folders.map((f) => [f.name, f.path, f.display])).toEqual([['link-in', join(home, 'research-agent'), '~/research-agent']]);
  });

  it('takes a system folder’s name for an ordinary folder deeper down', () => {
    const deeper = files(tempDir('sl-deeper-'), { 'code/library/package.json': '{}', 'code/Applications/agent/pyproject.toml': '', 'Library/agent/package.json': '{}', 'code/node_modules/x/package.json': '{}' });
    expect(suggestFolders('~/code/', { home: deeper }).folders.map((f) => f.name)).toEqual(['library', 'Applications']);
    expect(checkFolder('~/code/library', { home: deeper })).toMatchObject({ ok: true, path: join(deeper, 'code', 'library') });
    expect(checkFolder('~/code/Applications/agent', { home: deeper }).ok).toBe(true);
    expect(checkFolder('~/Library/agent', { home: deeper })).toMatchObject({ ok: false, code: 'system' });
    expect(checkFolder('~/code/node_modules/x', { home: deeper })).toMatchObject({ ok: false, code: 'system' });
  });

  it('reaches into a hidden or system folder only through a root configured there', () => {
    const own = files(tempDir('sl-own-roots-'), {
      '.work/agent/package.json': '{}',
      '.ssh/id_ed25519': 'secret',
      'Library/Mobile Documents/com~apple~CloudDocs/projects/agent/pyproject.toml': '',
      'Library/Preferences/x.plist': '',
    });
    const icloud = join(own, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'projects');
    const roots = ['~/.work', icloud];
    expect(projectRoots({ home: own, configured: roots }).roots).toEqual([own, join(own, '.work'), icloud]);
    expect(suggestFolders('~/.work/', { home: own, roots }).folders.map((f) => f.display)).toEqual(['~/.work/agent']);
    expect(checkFolder('~/.work/agent', { home: own, roots })).toMatchObject({ ok: true });
    expect(suggestFolders(`${icloud}/`, { home: own, roots }).folders.map((f) => f.name)).toEqual(['agent']);
    expect(checkFolder(join(icloud, 'agent'), { home: own, roots }).ok).toBe(true);
    // The rest of those folders stays out.
    expect(suggestFolders('~/.ssh/', { home: own, roots }).note).toBe('Hidden folders aren’t listed.');
    expect(suggestFolders('~/Library/', { home: own, roots }).folders).toEqual([]);
    expect(checkFolder('~/Library/Preferences', { home: own, roots, requireProjectFiles: false })).toMatchObject({ ok: false, code: 'system' });
    // Without the roots, nothing in them.
    expect(checkFolder('~/.work/agent', { home: own })).toMatchObject({ ok: false, code: 'hidden' });
  });

  it('lists nothing inside hidden or system folders', () => {
    expect(suggestFolders('~/.ssh/', { home })).toMatchObject({ folders: [], note: 'Hidden folders aren’t listed.' });
    expect(suggestFolders('~/.config/', { home })).toMatchObject({ folders: [], note: 'Hidden folders aren’t listed.' });
    expect(suggestFolders('~/Library/', { home })).toMatchObject({ folders: [], note: '~/Library holds system files, not projects.' });
    expect(suggestFolders('~/node_modules/', { home }).folders).toEqual([]);
    expect(suggestFolders('~/.s', { home }).folders).toEqual([]);
    expect(suggestFolders('~/nowhere/', { home })).toMatchObject({ folders: [], note: 'There’s no folder at ~/nowhere.' });
  });

  it('says nothing about what a hidden folder holds, or whether a file is there', () => {
    const same = (a: string, b: string) => {
      const x = suggestFolders(a, { home });
      expect(x.folders, a).toEqual([]);
      expect(suggestFolders(b, { home }), `${a} and ${b}`).toEqual({ ...x, query: b, note: x.note?.replace(a.replace(/\/$/, ''), b.replace(/\/$/, '')) ?? null, listed: x.listed?.replace(a, b) ?? null });
      return x;
    };
    // A key that is there, and one that isn't: the same answer, without looking.
    expect(same('~/.ssh/id_ed25519/', '~/.ssh/id_rsa/').note).toBe('Hidden folders aren’t listed.');
    expect(same('~/.ssh/id_ed25519', '~/.ssh/id_rsa').note).toBe('Hidden folders aren’t listed.');
    // Through a link into a hidden folder, too.
    expect(same('~/link-hidden/package.json/', '~/link-hidden/nothing/').note).toBe('Hidden folders aren’t listed.');
    expect(same('~/Library/Preferences/x.plist/', '~/Library/Preferences/y.plist/').note).toBe('~/Library/Preferences/x.plist holds system files, not projects.');
    // A file in a folder that is listed gets the answer nothing there gets.
    expect(same('~/Downloads/report.pdf/', '~/Downloads/taxes-2025.pdf/').note).toBe('There’s no folder at ~/Downloads/report.pdf.');
    expect(same('~/notes.txt/', '~/notes.md/').note).toBe('There’s no folder at ~/notes.txt.');
    const check = (typed: string) => checkFolder(typed, { home });
    for (const [there, notThere] of [
      ['~/.ssh/id_ed25519', '~/.ssh/id_rsa'],
      ['~/link-hidden/package.json', '~/link-hidden/nothing'],
      ['~/Downloads/report.pdf', '~/Downloads/taxes-2025.pdf'],
      ['~/notes.txt', '~/notes.md'],
    ] as const) {
      const a = check(there);
      expect(a.ok, there).toBe(false);
      expect(check(notThere), there).toEqual(a.ok ? a : { ...a, why: a.why.replace(there, notThere) });
    }
    expect(check('~/.ssh/id_ed25519')).toMatchObject({ code: 'hidden' });
    expect(check('~/Downloads/report.pdf')).toEqual({ ok: false, code: 'missing', why: 'There’s no folder at ~/Downloads/report.pdf.' });
  });

  it('matches a name typed on a keyboard to one macOS keeps decomposed', () => {
    const accents = files(tempDir('sl-nfd-'), { 'Bu\u0308cher-agent/package.json': '{}', 'other/package.json': '{}' });
    const s = suggestFolders('~/Bü', { home: accents });
    expect(s.folders.map((f) => f.name.normalize('NFC'))).toEqual(['Bücher-agent']);
    expect(suggestFolders('~/bu\u0308', { home: accents }).folders).toHaveLength(1);
    expect(checkFolder(s.folders[0]!.path, { home: accents })).toMatchObject({ ok: true });
  });

  it('marks folders already added, and caps what it returns', () => {
    const s = suggestFolders('', { home, opened: [{ id: 'triage-bot', path: join(home, 'triage-bot') }] });
    expect(s.folders.find((f) => f.name === 'triage-bot')).toMatchObject({ added: true, projectId: 'triage-bot' });
    const two = suggestFolders('', { home, limit: 2 });
    expect(two.folders).toHaveLength(2);
    expect(two.truncated).toBe(true);
    expect(suggestFolders('', { home, limit: 10_000 }).folders.length).toBeLessThanOrEqual(SUGGEST_LIMITS.maxResults);
    expect(suggestFolders('x'.repeat(SUGGEST_LIMITS.queryChars + 1), { home }).note).toBe('That path is too long to look up.');
  });

  it('reaches configured roots, and offers them with nothing typed', () => {
    const work = files(tempDir('sl-work-'), { 'agent-one/pyproject.toml': '', 'agent-one/uv.lock': '' });
    const empty = suggestFolders('', { home, roots: [work] });
    expect(empty.folders.at(-1)).toMatchObject({ path: work, display: work });
    const inside = suggestFolders(`${work}/`, { home, roots: [work] });
    expect(inside.folders.map((f) => [f.name, f.folder.kind])).toEqual([['agent-one', 'Python · uv']]);
    // Without the root, the same path lists nothing.
    expect(suggestFolders(`${work}/`, { home }).folders).toEqual([]);
  });
});

describe('projectRoots', () => {
  it('keeps the home folder and vetted roots, and says why the others were left out', () => {
    // The home folder one level into a temporary folder, so the folder holding it is an ordinary
    // one on every system: Linux's temporary folder (/tmp) is a system folder itself.
    const home = join(tempDir('sl-roots-'), 'home');
    mkdirSync(home);
    const work = tempDir('sl-roots-work-');
    const r = projectRoots({ home, configured: [work, '/', '/etc', 'relative/path', join(work, 'missing'), dirname(home), `${home}/sub`, work] });
    expect(r.roots).toEqual([home, work]);
    expect(r.refused).toEqual([
      { path: '/', why: 'a system folder' },
      { path: '/etc', why: expect.stringMatching(/a system folder|no such folder/) },
      { path: 'relative/path', why: 'a root is an absolute path, or one starting with ~/' },
      { path: join(work, 'missing'), why: 'no such folder' },
      { path: dirname(home), why: 'it holds your home folder' },
      { path: `${home}/sub`, why: 'no such folder' },
    ]);
  });
});

describe('checkFolder', () => {
  const home = sampleHome();

  it('accepts a folder with project files under the home folder, by its real path', () => {
    const r = checkFolder('~/research-agent', { home });
    expect(r).toMatchObject({ ok: true, path: join(home, 'research-agent') });
    expect(r.ok && r.folder.kind).toBe('Python · uv');
    expect(checkFolder(join(home, 'code', 'invoice-bot'), { home }).ok).toBe(true);
    expect(checkFolder('code/invoice-bot', { home }).ok).toBe(true);
  });

  it('refuses what the dashboard may not add, saying why', () => {
    const outside = files(tempDir('sl-check-out-'), { 'package.json': '{}' });
    expect(checkFolder('~/Downloads', { home })).toEqual({ ok: false, code: 'no-project-files', why: 'No pyproject.toml, package.json or requirements file in ~/Downloads. Pick the folder your agent’s code is in.' });
    expect(checkFolder('~/nowhere', { home })).toEqual({ ok: false, code: 'missing', why: 'There’s no folder at ~/nowhere.' });
    expect(checkFolder('~/notes.txt', { home })).toEqual({ ok: false, code: 'missing', why: 'There’s no folder at ~/notes.txt.' });
    expect(checkFolder(outside, { home })).toMatchObject({ ok: false, code: 'outside' });
    expect(checkFolder('~/../', { home })).toMatchObject({ ok: false, code: 'outside' });
    expect(checkFolder('~/.config/agent', { home })).toMatchObject({ ok: false, code: 'hidden' });
    expect(checkFolder('~/node_modules/left-pad', { home })).toMatchObject({ ok: false, code: 'system' });
    expect(checkFolder('', { home })).toMatchObject({ ok: false, code: 'invalid' });
    expect(checkFolder('~/x\0y', { home })).toMatchObject({ ok: false, code: 'invalid' });
    // A configured root lets it in.
    expect(checkFolder(outside, { home, roots: [outside] }).ok).toBe(true);
    // Without the project-files rule, a plain folder passes.
    expect(checkFolder('~/Downloads', { home, requireProjectFiles: false }).ok).toBe(true);
  });
});

describe('countGoldens', () => {
  it('counts packs under goldens/, one or two levels down', () => {
    const root = files(tempDir('sl-goldens-'), {
      'goldens/refund-over-limit/run.json': '{}',
      'goldens/refund-in-limit/run.json': '{}',
      'goldens/flows/escalate/run.json': '{}',
      'goldens/notes/readme.md': '',
      'goldens/.hidden/run.json': '{}',
    });
    expect(countGoldens(root)).toBe(3);
    expect(countGoldens(tempDir('sl-nogoldens-'))).toBe(0);
  });

  it('lists each pack with the runs it holds, and never reads through a link out of the project', () => {
    const root = files(tempDir('sl-packs-'), {
      'goldens/refund/run.json': JSON.stringify({ format: 'shadowlap-pack', version: 1, runs: [{ runId: 'R1' }, { runId: 'R0' }] }),
      'goldens/flows/escalate/run.json': '{ not json',
    });
    expect(listPacks(root).sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: 'goldens/flows/escalate', runIds: [] },
      { path: 'goldens/refund', runIds: ['R1', 'R0'] },
    ]);
    expect(readPack(join(root, 'goldens', 'refund'))).toEqual(['R1', 'R0']);
    expect(readPack(join(root, 'goldens'))).toBeNull();
    // A goldens link that stays in the project is followed; one that leads out isn't.
    const inside = files(tempDir('sl-packs-in-'), { 'packs/a/run.json': JSON.stringify({ runs: [{ runId: 'A' }] }) });
    symlinkSync(join(inside, 'packs'), join(inside, 'goldens'));
    expect(listPacks(inside)).toEqual([{ path: 'goldens/a', runIds: ['A'] }]);
    const outside = tempDir('sl-packs-out-');
    symlinkSync(join(root, 'goldens'), join(outside, 'goldens'));
    expect(listPacks(outside)).toEqual([]);
    expect(countGoldens(outside)).toBe(0);
  });
});

describe('displayPath', () => {
  it('shows a folder under the home folder with ~', () => {
    const home = tempDir('sl-display-');
    expect(displayPath(join(home, 'a', 'b'), home)).toBe('~/a/b');
    expect(displayPath(home, home)).toBe('~');
    expect(displayPath('/elsewhere/x', home)).toBe('/elsewhere/x');
  });
});
