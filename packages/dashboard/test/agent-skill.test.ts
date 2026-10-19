import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { SKILL_PUBLISHED, skillOffer } from '../src/agent-skill.js';
import { startDashboard } from '../src/index.js';
import { codingAgentsSettings } from '../src/settings.js';

/**
 * Settings → Coding agents offers the plugin and the Cursor rule only once they are published: an
 * install the page offers has to complete. The offer travels in the tab's read model, so the page
 * needs nothing else to decide.
 */
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('the skill on Settings → Coding agents', () => {
  it('offers no install until the owner has published it', () => {
    expect(SKILL_PUBLISHED).toBe(false);
    expect(skillOffer('0.1.0')).toEqual({ published: false, plugin: 'shadowlap@shadowlap', command: '/shadowlap:debug-agent', install: null });
    const cwd = mkdtempSync(join(tmpdir(), 'sl-skill-'));
    dirs.push(cwd);
    // The tab's read model carries it, at this dashboard's own version.
    expect(codingAgentsSettings({ cwd }).skill).toEqual(skillOffer());
    expect(codingAgentsSettings({ cwd }).skill.install).toBeNull();
  });

  it('once published, installs the plugin and the rule of the release it is', () => {
    expect(skillOffer('0.2.0', true).install).toEqual({
      claudeCode: ['claude plugin marketplace add devjoinedthechat/shadowlap@v0.2.0', 'claude plugin install shadowlap@shadowlap'],
      cursor: ['mkdir -p .cursor/rules', 'curl -fsSL https://raw.githubusercontent.com/devjoinedthechat/shadowlap/v0.2.0/coding-agents/cursor/shadowlap.mdc -o .cursor/rules/shadowlap.mdc'],
    });
    expect(skillOffer('0.2.0-rc.1', true).install?.claudeCode[0]).toBe('claude plugin marketplace add devjoinedthechat/shadowlap@v0.2.0-rc.1');
    // A version with no release tag to pin to offers nothing it couldn't complete.
    expect(skillOffer('', true)).toMatchObject({ published: true, install: null });
    expect(skillOffer('main; rm -rf /', true).install).toBeNull();
    const cwd = mkdtempSync(join(tmpdir(), 'sl-skill-'));
    dirs.push(cwd);
    expect(codingAgentsSettings({ cwd }, { skill: skillOffer('0.2.0', true) }).skill.published).toBe(true);
  });
});

describe('GET /api/settings/agents', () => {
  it('carries the offer, for the tab to show Install the skill once it is published', async () => {
    const project = realpathSync(mkdtempSync(join(tmpdir(), 'sl-skill-route-')));
    dirs.push(project);
    mkdirSync(join(project, '.shadowlap'));
    const dbPath = join(project, '.shadowlap', 'shadowlap.db');
    const store = Store.open(dbPath);
    const dash = await startDashboard({ store, dbPath, project: { path: project } });
    try {
      const res = await fetch(`${dash.url}/api/settings/agents`, { headers: { 'x-shadowlap-token': dash.token } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { skill: unknown; section: string | null };
      expect(body.skill).toEqual(skillOffer());
      expect(body.section).toMatch(/shadowlap replay/);
    } finally {
      await dash.close();
      store.close();
    }
  });
});
