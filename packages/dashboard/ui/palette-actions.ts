import { JOB_KINDS } from './api.js';
import { mergeTreeJobs, treeBusy, type TreeJob } from './fixes/model.js';
import { ACTIONS } from './labels.js';
import { knownFixes } from './fixes/data.js';
import { addPaletteSource, type PaletteContext, paletteSourcesChanged } from './palette-sources.js';
import { href } from './route.js';
import { lastRunsHref } from './runs-view.js';
import { migratePaletteRows } from './migrate-command.js';
import { APPLY_ASK, IMPORT_ASK, MIGRATE_ASK, NORMALIZER_ASK, PREVIEW_ASK, PR_COMMENT_ASK, REDACTION_ASK, SECURITY_TEST_ASK, type PageAsk } from './page-ask.js';
import { SETTINGS_TABS, type SettingsTab } from './pages/settings/tabs.js';
import type { StoreSetupView } from './store-api.js';
import type { MigrateRetiring } from './types.js';
import { knownGoldens, onTestsChanged, prCommentPaletteCommands, testsPaletteCommands } from './tests-palette.js';
import { onTrainingCountsChange, trainingPalette } from './training.js';
import { stepWords } from '../src/store-steps.js';
import type { SecurityRow } from '../src/injection-security.js';
import { shortId } from './format.js';

/**
 * The palette's Actions and Tests that belong to pages, listed on a fresh dashboard before any of
 * those pages has opened: the Tests group and Update goldens…, Migrate <a> to <b> while a model
 * retires, Rescan coverage, Preview pull request comment, Import capture…, Export pairs… and Score
 * model…, Calibrate, Preview model switch… and Preview changed prompt, the team store's setup, the
 * Settings tabs by what they hold, Apply fix, Add normalizer… and Add redaction rule…, and Run
 * injection test… on goldens' recordings. They load with the palette, so a page's code waits for
 * its page. A row whose dialog lives on its page opens the page and asks there (`page-ask.ts`).
 * Each answers nothing in an exported copy, which runs nothing.
 */

// Tests, with Update goldens… while goldens diverged: an open palette reads it again once the goldens land.
addPaletteSource(({ app, go }) => testsPaletteCommands(app, go, { update: app.hasKind(JOB_KINDS.testUpdate) }));
onTestsChanged(paletteSourcesChanged);

/** The jobs the server last listed (every tab's and the terminal's): whether a repair holds the working tree. */
let listedJobs: TreeJob[] | null = null;
let listing: Promise<void> | null = null;

/**
 * Why a job that `use`s the project's working tree would wait now, as the jobs last listed and this
 * tab's own say, or null. The list is read again as the palette opens, once at a time, and an open
 * palette reads its sources again when what it says changed.
 */
function treeWait(app: PaletteContext['app'], use: 'reads' | 'writes', verb: string): string | null {
  const held = () => treeBusy(mergeTreeJobs(listedJobs, app.jobs), use, verb, app.meta?.project?.path ?? null);
  const before = held();
  if (!app.actionsOff) {
    listing ??= app.client.jobs().then(
      (list) => {
        listedJobs = list;
        listing = null;
      },
      () => {
        listing = null;
      },
    );
    void listing.then(() => {
      if (held() !== before) paletteSourcesChanged();
    });
  }
  return before;
}

// Migrate <a> to <b> for each model the goldens call that retires with a replacement: Migrate opens
// and asks there, as its start page's button does. What retires is Migrate's own read, kept for the
// next time and asked again as the palette opens once it is older than RETIRING_FRESH: the palette
// builds its rows again whenever any source's answer lands, and each read reads the goldens on the
// pool. Migrate verifies from the working tree, so like Preview changed prompt it waits while a job
// holds the tree, dimmed, saying why; it is left out on a read-only dashboard. Added before Rescan
// coverage, it lists before it among the actions ACTION_ORDER doesn't name, as the design lists them.
let retiringRead: readonly MigrateRetiring[] = [];
let readingRetiring = false;
let retiringAt = 0;
const RETIRING_FRESH = 15_000;
const retiringKey = (list: readonly MigrateRetiring[]): string => list.map((n) => `${n.model}>${n.replacements[0] ?? ''}:${n.goldens.join(',')}`).join(' ');
addPaletteSource(({ app, go }) => {
  if (app.exported || app.actionsOff || !app.hasKind(JOB_KINDS.migrate)) return [];
  if (!readingRetiring && Date.now() - retiringAt >= RETIRING_FRESH) {
    readingRetiring = true;
    retiringAt = Date.now();
    void app.client.migrateStart().then(
      (v) => {
        readingRetiring = false;
        const was = retiringKey(retiringRead);
        retiringRead = v.retiring;
        if (retiringKey(v.retiring) !== was) paletteSourcesChanged();
      },
      () => {
        readingRetiring = false;
      },
    );
  }
  if (!retiringRead.length) return [];
  const held = treeWait(app, 'reads', 'migrate');
  return migratePaletteRows(retiringRead, held, (model) =>
    app.guard(() => {
      MIGRATE_ASK.ask(model);
      go(href.changeSession('migrate'));
    }),
  );
});

// Rescan coverage reads the imported runs and the goldens on disk again, as Not covered's button
// does: the server never holds a scan for another job, so it waits only as every action does. It is
// left out on a read-only dashboard. Added after Migrate <a> to <b> and before Preview pull request
// comment, it lists between them among the actions ACTION_ORDER doesn't name, as the design lists
// them.
addPaletteSource(({ app }) => {
  if (app.exported || !app.hasKind(JOB_KINDS.coverage)) return [];
  return [{ group: 'Actions', label: ACTIONS.rescanCoverage.label, hint: 'shadowlap coverage', job: true, run: () => app.guard(() => app.watchJob(app.client.startJob(JOB_KINDS.coverage, {}))) }];
});

// Preview pull request comment, once the goldens have a session: Settings → CI opens its preview.
addPaletteSource(({ app, go }) => prCommentPaletteCommands(app, go, () => PR_COMMENT_ASK.ask()));

// Export pairs… and Score model…, while there are pairs and a task is ready.
addPaletteSource((ctx) => trainingPalette(ctx, JOB_KINDS));
onTrainingCountsChange(paletteSourcesChanged);

// Import capture…: Runs opens its dialog when it next shows.
addPaletteSource(({ app, go }) =>
  app.exported || !app.hasKind(JOB_KINDS.importCapture)
    ? []
    : [
        {
          group: 'Actions',
          label: ACTIONS.importCapture.label,
          // The dialog's sources, short enough to show whole on a desktop's row; the file formats match unseen.
          hint: 'a file, or a Langfuse, LangSmith, Phoenix or Logfire trace',
          match: 'HAR nock VCR LiteLLM OpenTelemetry OTLP',
          job: true,
          run: () =>
            app.guard(() => {
              IMPORT_ASK.ask();
              go(lastRunsHref());
            }),
        },
      ],
);

// Calibrate replays the agent from the project's working tree: like its button on Matching, the
// palette's entry waits while a repair or an apply holds the tree, dimmed, saying why. It is left out
// on a read-only dashboard.
addPaletteSource(({ app }) => {
  if (app.exported || !app.hasKind(JOB_KINDS.calibrate)) return [];
  const held = treeWait(app, 'reads', 'calibrate');
  return [{ group: 'Actions', label: ACTIONS.calibrate.label, hint: held ?? 'propose normalizers', job: true, ...(held ? { wait: held } : {}), run: () => app.guard(() => app.watchJob(app.client.startJob(JOB_KINDS.calibrate, {}))) }];
});

// Preview model switch… and Preview changed prompt while the project has goldens: Preview opens and
// asks there, on every golden. The changed prompt replays the agent from the working tree, so like
// Calibrate it waits while a repair or an apply holds the tree, dimmed, saying why.
addPaletteSource(({ app, go }) => {
  if (app.exported || !app.hasKind(JOB_KINDS.decisions) || !knownGoldens()) return [];
  const held = treeWait(app, 'reads', 'preview the change');
  const asks = (way: 'model' | 'code') => () =>
    app.guard(() => {
      PREVIEW_ASK.ask(way);
      go(href.changeSession('decisions'));
    });
  return [
    { group: 'Actions', label: ACTIONS.previewModelSwitch.label, hint: 'shadowlap decisions goldens/* --model <model>', job: true, run: asks('model') },
    { group: 'Actions', label: ACTIONS.previewChangedPrompt.label, hint: held ?? 'shadowlap decisions goldens/* --from-code --samples 1', job: true, ...(held ? { wait: held } : {}), run: asks('code') },
  ];
});

// The way to the team store's setup: Set up the team store while the project has none, Continue
// setting up the store while a setup is under way. What the setup's route says is read each time
// the palette opens, and kept for the next time.
let lastSetup: StoreSetupView | null = null;
addPaletteSource(({ app, go }) => {
  if (app.exported || !app.hasKind(JOB_KINDS.storeSet)) return [];
  void app.client.storeSetup.view().then(
    (v) => {
      const was = lastSetup;
      lastSetup = v;
      if (!was || was.active !== v.active || !was.store !== !v.store) paletteSourcesChanged();
    },
    () => undefined,
  );
  const v = lastSetup;
  if (!v) return [];
  if (!v.store) return [{ group: 'Actions', label: ACTIONS.setUpTeamStore.label, hint: 'your team’s runs, in a bucket you own', run: () => go(href.storeSetup()) }];
  if (v.active && v.next) return [{ group: 'Actions', label: ACTIONS.continueTeamStoreSetup.label, hint: `step ${v.next.step} of 4: ${stepWords(v.next.title)}`, run: () => go(href.storeSetup()) }];
  return [];
});

/** Each Settings tab by what it holds, found once something is typed: `settings` finds every one. */
const SETTINGS_FOUND: Record<SettingsTab, { hint: string; match: string }> = {
  matching: { hint: 'normalizers, dates and times, calibrate', match: 'settings' },
  redaction: { hint: 'what leaves your machine', match: 'settings' },
  ci: { hint: 'your workflow, the pull request comment, fix on failure, alerts', match: 'settings alerts' },
  gates: { hint: 'a gate’s figures, its odds, the golden’s entry', match: 'settings gate fork history inconclusive' },
  agents: { hint: 'Claude Code, Cursor, Codex', match: 'settings' },
  tools: { hint: 'what a fork runs again, and what brings outside text in', match: 'settings trusted untrusted security prompt injection mcp' },
  project: { hint: 'spending, its store, its size, clean up old runs', match: 'settings spending ask before spending cost threshold budget' },
  store: { hint: 'the team store', match: 'settings' },
};

// Settings by what each tab holds: typed only, as the tabs are a click away in the sidebar.
addPaletteSource(({ app, go }) =>
  app.exported ? [] : SETTINGS_TABS.map((t) => ({ group: 'Settings' as const, label: t.label, ...SETTINGS_FOUND[t.key], typed: true, run: () => go(href.settings(t.key)) })),
);

// Apply fix for each fix ready to apply (verified, not applied, and not shipped with its merged pull
// request), typed only, found by its label too: its page opens and asks there, as its button does.
// Like the button, it waits while a job holds the working tree, dimmed, saying why.
addPaletteSource(({ app, go }) => {
  if (app.exported || app.actionsOff || !app.hasKind(JOB_KINDS.applyFix)) return [];
  const verified = knownFixes().filter((f) => f.bucket === 'ready');
  const held = verified.length ? treeWait(app, 'writes', 'apply the patch') : null;
  return verified.map((f) => ({
    group: 'Actions' as const,
    label: ACTIONS.applyFix.label,
    hint: held ?? f.title,
    match: `fix patch ${f.label ?? ''}`,
    typed: true,
    job: true,
    ...(held ? { wait: held } : {}),
    run: () =>
      app.guard(() => {
        APPLY_ASK.ask(f.fixId);
        go(href.fixes(f.fixId));
      }),
  }));
});

// A rule added from the palette: its tab opens and asks in its own dialog. Typed only; left out
// where nothing is written.
addPaletteSource(({ app, go }) => {
  if (app.exported || app.actionsOff) return [];
  const asks = (tab: SettingsTab, ask: PageAsk) => () =>
    app.guard(() => {
      ask.ask();
      go(href.settings(tab));
    });
  return [
    { group: 'Actions', label: ACTIONS.addNormalizerRule.label, hint: 'shadowlap normalize add', match: 'matching mask', typed: true, run: asks('matching', NORMALIZER_ASK) },
    { group: 'Actions', label: ACTIONS.addRedactionRule.label, hint: 'shadowlap redact add', match: 'redaction mask', typed: true, run: asks('redaction', REDACTION_ASK) },
  ];
});

// Run injection test… on up to three goldens' recordings that read something untrusted, newest
// first, but the one whose page shows (This run's row offers it there): typed only, from Tests →
// Security's read, read again as the palette opens and kept for the next time. Tests opens, and its
// row asks as its button does. A recording no golden holds gets no row.
let security: readonly SecurityRow[] = [];
let securityAt = 0;
const securityKey = (rows: readonly SecurityRow[]) => rows.map((g) => `${g.path}:${g.recording}`).join(' ');
addPaletteSource(({ app, route, go }) => {
  if (app.exported || app.actionsOff || !app.hasKind(JOB_KINDS.injection)) return [];
  // Once as it opens: the call a changed answer brings reads no more.
  if (Date.now() - securityAt > 2000) {
    securityAt = Date.now();
    void app.client.injectionSecurity().then(
      (read) => {
        const was = securityKey(security);
        security = read.goldens;
        if (securityKey(security) !== was) paletteSourcesChanged();
      },
      () => undefined,
    );
  }
  const here = route.page === 'run' ? route.id.toUpperCase() : null;
  return security
    .filter((g) => !here || !g.recording.startsWith(here))
    .slice(0, 3)
    .map((g) => ({
      group: 'Actions' as const,
      label: ACTIONS.runInjectionTest.label,
      hint: `shadowlap injection ${g.runId ? shortId(g.runId) : g.path}`,
      match: `security prompt injection untrusted ${g.name}`,
      typed: true,
      job: true,
      run: () =>
        app.guard(() => {
          SECURITY_TEST_ASK.ask(g.path);
          go(href.tests());
        }),
    }));
});
