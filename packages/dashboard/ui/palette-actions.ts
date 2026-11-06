import { JOB_KINDS } from './api.js';
import { mergeTreeJobs, treeBusy, type TreeJob } from './fixes/model.js';
import { ACTIONS } from './labels.js';
import { addPaletteSource, paletteSourcesChanged } from './palette-sources.js';
import { href } from './route.js';
import { IMPORT_ASK, NORMALIZER_ASK, REDACTION_ASK, type PageAsk } from './page-ask.js';
import { SETTINGS_TABS, type SettingsTab } from './pages/settings/tabs.js';
import type { StoreSetupView } from './store-api.js';
import { onTestsChanged, testsPaletteCommands } from './tests-palette.js';
import { onTrainingCountsChange, trainingPalette } from './training.js';
import { stepWords } from '../src/store-steps.js';

/**
 * The palette's Actions and Tests that belong to pages, listed on a fresh dashboard before any of
 * those pages has opened: the Tests group and Update goldens…, Import capture…, Export pairs… and
 * Score model…, Calibrate, the team store's setup, the Settings tabs by what they hold, and Add
 * normalizer… and Add redaction rule…. They load with the palette, so a page's code waits for its
 * page. A row whose dialog lives on its page opens the page and asks there (`page-ask.ts`). Each
 * answers nothing in an exported copy, which runs nothing.
 */

// Tests, with Update goldens… while goldens diverged: an open palette reads it again once the goldens land.
addPaletteSource(({ app, go }) => testsPaletteCommands(app, go, { update: app.hasKind(JOB_KINDS.testUpdate) }));
onTestsChanged(paletteSourcesChanged);

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
              go(href.runs());
            }),
        },
      ],
);

/** The jobs the server last listed (every tab's and the terminal's): whether a repair holds the working tree. */
let listedJobs: TreeJob[] | null = null;

// Calibrate replays the agent from the project's working tree: like its button on Matching, the
// palette's entry waits while a repair or an apply holds the tree, and is left out until then, as
// it is on a read-only dashboard. The list is read again as the palette opens; an open palette
// reads its sources again when what it says changed.
addPaletteSource(({ app }) => {
  if (app.exported || !app.hasKind(JOB_KINDS.calibrate)) return [];
  const folder = app.meta?.project?.path ?? null;
  const held = () => treeBusy(mergeTreeJobs(listedJobs, app.jobs), 'reads', 'calibrate', folder);
  const before = held();
  if (!app.actionsOff) {
    app.client.jobs().then(
      (list) => {
        listedJobs = list;
        if (held() !== before) paletteSourcesChanged();
      },
      () => undefined,
    );
  }
  if (before) return [];
  return [{ group: 'Actions', label: ACTIONS.calibrate.label, hint: 'propose normalizers', job: true, run: () => app.guard(() => app.watchJob(app.client.startJob(JOB_KINDS.calibrate, {}))) }];
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
  alerts: { hint: 'gates, the pull request comment, fix on failure, alerts', match: 'settings alerts' },
  agents: { hint: 'Claude Code, Cursor, Codex', match: 'settings' },
  tools: { hint: 'what a fork runs again, and what brings outside text in', match: 'settings trusted untrusted security prompt injection mcp' },
  project: { hint: 'spending, its store, its size, clean up old runs', match: 'settings spending ask before spending cost threshold budget' },
  store: { hint: 'the team store', match: 'settings' },
};

// Settings by what each tab holds: typed only, as the tabs are a click away in the sidebar.
addPaletteSource(({ app, go }) =>
  app.exported ? [] : SETTINGS_TABS.map((t) => ({ group: 'Settings' as const, label: t.label, ...SETTINGS_FOUND[t.key], typed: true, run: () => go(href.settings(t.key)) })),
);

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
