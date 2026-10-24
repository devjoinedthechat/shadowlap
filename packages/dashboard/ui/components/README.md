# Dashboard components

The parts every screen is built from. The stylesheet is `ui/app.css` (the design system: tokens on
`:root`, dark only, class names shared by every screen); a component renders those classes, so a
new screen ports its markup by class and reaches for these instead of drawing its own.

The page's Content-Security-Policy allows no inline `style` attribute in markup and no inline
script. React's `style` prop is fine (it sets styles through the DOM, not markup); a colour or a size
that comes from data goes there, everything else is a class.

## Layout

| Component | File | Use it for |
|---|---|---|
| `Page` | `Page.tsx` | Every scrolling page. Gives back the scrollbar's width (`--sbw`) so the content's right edge stays under the top bar's. |
| `useActiveTabInView` | `hooks.ts` | A ref for a strip of tabs that scrolls sideways on a phone (Settings' tabs, a run's views): it shows the active tab on mount and when the tab shown changes, scrolling the strip alone (`stripScroll` in `place.ts`). |
| `PageHeader` | `bits.tsx` | The eyebrow, the title, one line under it, and the page's actions on the right (`.ph`). |
| `Eyebrow` | `bits.tsx` | The small capitals above a title; `tone="fork"` or `"err"`. |
| `EmptyState` | `bits.tsx` | Nothing here yet: what it is, and the command that makes it (`.panel.stepempty`). |
| `StepList` | `bits.tsx` | Numbered setup steps, each with the CLI command that does it (`ol.setup`); a step is `done`, `cur` or `todo`. |

## Overlays

| Component | File | Notes |
|---|---|---|
| `Dialog` | `Dialog.tsx` | Title, one line, a body, Cancel and the action (`tone`: `lime`, `danger`, `solid`). Esc or a click on the dimmed page cancels. It opens on its first field, else its action, but on Cancel when the action is red or `initialFocus="cancel"` asks for it (`dialogFocus` in `focus.ts`), so Enter twice never does what can't be undone. A body taller than the window scrolls, with the title and the buttons in view. |
| `PromptDialog`, `ConfirmDialog` | `Dialog.tsx` | One field before an action runs (or one of a few `choices`, with "Something else…"; a choice with `text` asks for a few words more, as "error, with a message" does), with the command it runs, which can follow the answer; a yes or no with the command it runs. |
| `DatasetDialog` | `DatasetDialog.tsx` | Runs as an eval dataset: a format and which calls become examples, as the `export-dataset` job. A run's Share menu and the Runs page's bulk bar both open it; pass `rules` when the page knows how many redaction rules the copy applies. |
| `Popover`, `MenuItem`, `useMenu` | `Popover.tsx` | A menu hanging from its button (`.pop`), kept on screen by `placePop` (`place.ts`) and placed again as it or the window changes size (`keepPlaced`), its first item focused once it shows, ↑ ↓ between items (passing over buttons hidden until hovered), closed by Esc, a click outside or the opener. `useMenu()` holds the open state and the anchor. |
| `JobDrawer` | `Drawer.tsx` | The CLI run the dashboard started: title, output, outcome and exit code, files to download, links to what it made. A Replay that diverged adds **Calibrate** (the calibrate job on its recording) beside Open run. It ends on one primary action: a link the command marks `secondary` (each failing golden's run, beside Tests) shows as a plain link above the buttons. A job of another project than the page shows says which, and its links switch to that project first. Start a job with `useApp().watchJob(client.startJob(kind, fields))` or `client.action(...)`. |
| `ToastHost` | `Toast.tsx` | One toast at a time: `useApp().toast(text)`, gone after 2.6 seconds. A refusal or a failure is `toast(errorText(err), 'error')` (`toast.ts`): a red dot, read out at once (`role=alert`), and it stays until dismissed or for 8 seconds. |
| `HoverCardLayer`, `tipText`, `tipCard` | `HoverCard.tsx` | Hover cards in one style, a title and coloured rows. Put `data-tip={tipCard(title, rows)}` on any element; one layer follows the pointer. |

Esc closes the topmost layer: a menu, then a dialog, then a panel, then the phone sidebar. A new
overlay registers itself with `useLayer(kind, open, close)` from `state.tsx`.

A dialog belongs to the project the page showed when it opened. When the dashboard switches to
another project elsewhere (another tab) and the page stays, the dialog closes, since its action would
land in the other project, and the switch's toast says nothing was done; `keepOnSwitch` keeps one
that holds only what was typed into it (a rule, a server's command), which then acts on the project
shown (`dialogOnSwitch` in `projects-api.ts`). A dialog that starts a job for its project names that
project in the job, so a server switched since refuses it.

## Data

| Component | File | Notes |
|---|---|---|
| `Strip` | `Strip.tsx` | A run's calls by origin; past 360 calls a cell stands for a range and takes its most notable origin, and hovering it counts each origin. Flags the fork and the lost call; a live run grows a pending cell. |
| `MiniStrip` | `Strip.tsx` | The small strip in tables (`.ms`), grouped past 60 cells. |
| `GridStrip` | `Strip.tsx` | A row of a family on one scale (`.gs`), for the Overview's grid. |
| `RunIcon`, `EventIcon`, `Glyph` | `RunIcon.tsx` | One set of icons, each with its words on hover: recording now (pulsing), recording, failed, replay, fork, capture, test, and for events Fixes, project, settings and training. |
| `Icon`, `Sprite`, `Brand`, `Tile` | `Icon.tsx` | The icon sprite (drawn once by the app) and the logo. |
| `Org`, `Legend` | `bits.tsx` | An origin's colour and word; a legend of the origins present. |
| `Tag`, `Badge`, `Pips`, `Kbd` | `bits.tsx` | A run's kind beside its id; a status badge; one square per attempt; a key. |
| `Chips`, `Tabs`, `Seg` | `bits.tsx` | Filter chips with counts (empty ones can hide); underlined tabs with counts; a segmented switch. |
| `Kpi`, `DeltaPill` | `bits.tsx` | A number with its label and a line, with its change against last week. |
| `CmdLine`, `CommandLine`, `CodeBlock`, `CopyButton` | `bits.tsx` | A shell command; one long enough to wrap, which breaks only between its words (`shellWords` in `format.ts`); a file with Copy in its header; copy and say so. |
| `SortTh`, `ShowMore`, `rowOpen` | `Table.tsx` | A sorting header for `table.t`, "Show 50 more", and a row that opens a page unless a control inside it was clicked. |
| `JsonTree` | `Json.tsx` | A JSON value as a folding tree that draws a branch only when it is opened. |

## State and logic

`state.tsx` holds what every screen shares (`useApp()`): the client, `meta`, the run list, the
connection, `actionsOff` (why actions cannot run here, for a disabled control's title: the server's
`readOnlyReason` when it sends one), `hasKind` (whether the server runs a job kind), `guard` (runs an
action, or says actions are paused while the server is unreachable), toasts, jobs and the palette's
This run entries. It is a store read through `useSyncExternalStore`: a component re-renders when a
field it reads changes (while rendering, in an effect or in a handler), and for no other, so the
shell's poll every two seconds redraws only what reads what moved. `useAppSelector(app => app.runs)`
reads one field outright. A test renders a component with an app of its own through `AppContext`.

`api.ts` is the one module that talks to the server. Its types live in `types.ts` (the server's,
widened with optional fields other slices add), and every answer passes through `normalize.ts` as it
arrives, so the views read one shape: a field a slice names its own way (`sentAgain`, `lostAt`,
`attemptOf`, `{target, count, action}` hosts, `group: null`, a choice's `text`, the fix a run belongs
to as `{id, status, title}` or as the fixes read model's `{role, fix, blame}`) is turned into the
views' shape there, once. A new field goes in `types.ts` as optional, and in `normalize.ts` when its shape needs it.

The logic behind the components has no DOM and is unit-tested: `route.ts` (routes and links),
`palette.ts` (matching, the Actions group's order, and which hits from recorded data show: a run's own before its attempts'), `strip.ts` (cells and grouping), `origins.ts`, `runs.ts` (what a run is and
how it ended, the Forks view's lines, the run an exported copy opens on), `recorded.ts` (a replayed
call's recorded duration), `cache.ts` (where the cache stopped hitting, and what the Context view
says about it), `scopes.ts` (scopes and their chips), `backoff.ts` and
`connection.ts` (offline, the retry schedule, the `?state=offline` preview), `live.ts` (following a
recording, and which ended between two loads of the run list, for the shell's toast), `actions.ts` (the fork menu and each action's dialog words), `jobs.ts` (a job's title and status, where a Replay diverged, the recording Calibrate takes), `place.ts`,
`focus.ts` (what a dialog focuses first), `shell/top.ts` (the top bar's pill, a run's parent in its
crumbs, the live chip), `parents.ts` (each run's parent, from the run details loaded so far, so the
crumbs never load a run twice),
`normalize.ts`, `format.ts`, and on the run page `run/banner.ts` (which banner, and what it says),
`run/metrics.ts`, `run/model.ts` and `run/calls.ts`; for Compare, `compare/model.ts` (what the four
change cards say, which calls after the fork the other run made too, the prefix line, which runs the
pickers offer); for Training, `training.ts` (what a pairs filter
shows, what Score a model sends, and the palette's Training actions). Tests has `goldens.ts`: the
verdict's line, a check's name in the table, the reports as the CLI prints them, which buttons a
failure gets and what the Update golden dialog says; `tests-palette.ts` lists the goldens in the
palette from any page.

A page adds palette entries (its Fixes, its goldens, its actions) with `addPaletteSource` from
`palette-sources.ts`. A source runs when the palette opens; one that loads what it lists answers
with what it has and calls `paletteSourcesChanged()` when more arrives, and an open palette reads
its sources again. Pages a later version fills in each have their own file under `pages/`.

The Overview's panels are in `overview/` (`panels.tsx`, with what they say in `overview/model.ts`),
and the Runs page's parts in `runspage/`: the calendar (`Calendar.tsx`, its logic in
`calendar-model.ts`), the table, the bulk bar (`bulk.ts`: its toasts, Dataset's limit, ids sent in batches, the Delete command),
the import dialog (`imports.ts` reads a file's first
bytes for the engine's `guessImportFormat`, and dates the sample trace in `sample-otel.ts` to end now), Find the commit (`find-commit.ts`, what it asks bisect
for) and authors; `runspage/query.ts` builds the page's requests and reads the
filter its address holds (`#/runs?q=…&types=failed&sort=spent&from=…&to=…`, written by `links.runs`
in `src/links.ts`), so any screen can link to a filtered list, and Back and Forward go through the
views Runs showed. `teamstore.ts` has `useTeamStore()`, the team store as `GET /api/store` reports it, for any
screen that changes with one (the top bar's *team* label among them); it reads again when the change
feed's `team` counter moves (a push, a pull, a step of the setup). The store's setup is a page of its
own, `#/setup/store` (`pages/settings/StoreSetup.tsx`, with its palette entry), its steps worked out in
`store-logic.ts` from `src/store-steps.ts` (which Needs a look reads too) and its requests in
`store-api.ts` (`client.storeSetup`).

Fixes keeps its parts in `fixes/`: a fix's page and its Blame, Repair and Verify steps, the Forks
view's blame and verify bundles (`Bundles.tsx`), Run blame (`RunBlame.tsx`, which asks for the check
when the server can't find it), what the breadcrumb and the palette know about fixes (`data.ts`),
why an action can't start while a repair or an apply holds the project's working tree
(`tree.ts`: `useTreeBusy(use, verb)` gives the reason, or null; any button that runs the agent can
read it as Run blame, Repair from here, Apply the patch and the Tests actions do, and
`useServerJobs()` is the job list it reads, every tab's, for a page that waits on other jobs too,
as Tests waits on a test job with `testsBusy` from `goldens.ts`; `useTestsWait(verb)` reads both, and
`TestsJobButton` is a button that starts a Tests job from another page, a test replay's banner, and
waits as the Tests page's own do), and the logic they share, DOM-free
and tested (`model.ts`: chips, steps, the Blame step's row of calls, the change cut to what changed,
report.md read as blocks, the drawer's outcome words, which jobs hold which tree).

A page that shows what a feature keeps in its own tables reloads on that table's count in
`feeds` (`useApp().feeds.fixes`), which moves when `/api/changes` lists the table under `other`, as
it reloads on `tick` when runs or calls change; `feeds.jobs` moves when a job starts, ends or reports.
A run's page and what hangs from it (its offers, its family, its fix bundles) reload on `runsTick`,
which moves only when the run list loads again, and while a run records, on its own count in
`live` (`runRefresh`, `familyRefresh` in connection.ts): another run recording asks them for nothing.
