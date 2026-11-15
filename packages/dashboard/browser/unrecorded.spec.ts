import { expect, test } from '@playwright/test';
import type { ToolsSettings } from '../ui/settings-api.js';
import { openPage, patched, seriousViolations, startJob } from './dashboard.js';
import { DIALOG } from './routes.js';

/**
 * Tools shadowlap never recorded, in a real browser over the demo store: a replay the CLI refused for
 * one ends its drawer on Run again, allowing it, which its toast offers too, asks first in a dialog
 * warning in red that a write acts on your systems, and runs the same job again with the tool
 * allowed (`POST /api/jobs/:id/again`, answered here, so nothing runs); and Settings → Tools declares
 * one a read, its write answered here, so the demo's file, which every test shares, is never written.
 */

// A route may still be reading the server's answer as a test ends; the page's close takes it away, and that is no failure.
test.afterEach(({ page }) => page.unrouteAll({ behavior: 'ignoreErrors' }));

/** The CLI's refusal of a replay whose model called Bash, unrecorded, as `unrecordedRefusal` words it with the command it suggests the flag on. */
const refusal = (run: string) => [
  `shadowlap: ${run.slice(0, 10)} holds model calls of a tool shadowlap never recorded, which writes: a replay serves the model's answers again, so it would run it again for real.`,
  '    Bash  2 calls from model call #3 · a Claude Code built-in that runs a command',
  '  So Shadowlap records it and a replay serves it: run the query through withFence from @shadowlap/adapters/claude-agent-sdk (with_fence in shadowlap.adapters.claude_agent_sdk), which records Bash and fences it on replay.',
  `  If running it again is safe, declare it a read in shadowlap.config.json, "tools": { "unrecorded": { "Bash": "read" } }, or let this replay run it: shadowlap replay ${run} --allow-unrecorded Bash`,
];

test('a refused replay offers Run again, allowing its tool, in its drawer and its toast, which asks first and runs the job again with it allowed', async ({ page }) => {
  const sent: unknown[] = [];
  await page.route(/\/api\/jobs\/[^/]+\/again$/, (route) => {
    sent.push(route.request().postDataJSON());
    return route.fulfill({ status: 202, json: { id: 'feedfacefeedfac2', kind: 'action', title: 'Replaying', args: [], worktree: null, runId: null, opensRun: false, startedAt: Date.now(), done: true, stopped: false, code: 0, newRunId: null, lines: [], total: 0 } });
  });
  const { end, run } = await startJob(page);
  await page.locator('#jx').click();
  end(refusal(run), { code: 2 });
  // Hidden, its toast offers the way on.
  const toast = page.locator('.toast');
  await expect(toast).toContainText('refused · an unrecorded tool writes · exit 2');
  await expect(toast.locator('.tbtn')).toHaveText('Run again, allowing Bash');
  await page.locator('.status .jobchip').click();
  const offer = page.locator('section.drawer .jfoot button', { hasText: 'Run again, allowing Bash' });
  await offer.click();
  const dialog = page.locator(DIALOG);
  await expect(dialog.locator('h3')).toHaveText('Run again, allowing Bash?');
  await expect(dialog.locator('.dwarn')).toContainText('acts on your systems for real');
  await expect(dialog.locator('.cmdline')).toContainText(`shadowlap replay ${run} --allow-unrecorded Bash`);
  expect(await seriousViolations(page)).toEqual([]);
  await dialog.getByRole('button', { name: 'Run again', exact: true }).click();
  await expect.poll(() => sent).toEqual([{ allowUnrecorded: ['Bash'] }]);
});

test('Settings → Tools declares a tool shadowlap doesn’t record a read, and says a pure tool marked untrusted is, with no serious axe violation', async ({ page }) => {
  const declared: unknown[] = [];
  await page.route((url) => url.pathname === '/api/settings/tools', (route) =>
    patched<ToolsSettings>(route, (t) => {
      const pure = t.live.find((x) => x.effect === 'pure');
      return { ...t, unrecorded: [{ name: 'Write', effect: 'write' }], live: t.live.map((x) => (x === pure ? { ...x, trust: 'untrusted', from: 'config', where: 'shadowlap.config.json' } : x)) };
    }),
  );
  await page.route((url) => url.pathname === '/api/settings/tools/unrecorded', (route) => {
    const body = route.request().postDataJSON() as { tool: string; effect: string; expect: string };
    declared.push(body);
    return route.fulfill({ json: { tool: body.tool, effect: body.effect, was: null, changed: true, version: body.expect, line: `"tools": { "unrecorded": { "${body.tool}": "${body.effect}" } }` } });
  });
  await openPage(page, '/settings/tools', 'main#view .trusttab');
  // The pure tool marked untrusted is planted in: it says so, and offers its mark back.
  const pure = page.locator('main#view .trusttab tbody tr', { has: page.locator('.eff.pure') }).filter({ has: page.locator('.trust.u') });
  await expect(pure).toHaveCount(1);
  await expect(pure.locator('.trustbtn')).toHaveText('Mark trusted');
  const block = page.locator('main#view .unrec');
  await expect(block.locator('li')).toHaveText(['Writedeclared a writeDeclare read']);
  await block.locator('input').fill('Bash');
  await block.locator('form button', { hasText: 'Declare read' }).click();
  await expect.poll(() => declared.length).toBe(1);
  expect(declared[0]).toMatchObject({ tool: 'Bash', effect: 'read' });
  await expect(page.locator('.toast')).toContainText('Wrote "tools": { "unrecorded": { "Bash": "read" } } to shadowlap.config.json');
  expect(await seriousViolations(page)).toEqual([]);
});
