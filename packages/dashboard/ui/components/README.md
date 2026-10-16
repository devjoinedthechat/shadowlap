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
| `PageHeader` | `bits.tsx` | The eyebrow, the title, one line under it, and the page's actions on the right (`.ph`). |
| `Eyebrow` | `bits.tsx` | The small capitals above a title; `tone="fork"` or `"err"`. |
| `EmptyState` | `bits.tsx` | Nothing here yet: what it is, and the command that makes it (`.panel.stepempty`). |
| `StepList` | `bits.tsx` | Numbered setup steps, each with the CLI command that does it (`ol.setup`); a step is `done`, `cur` or `todo`. |

## Overlays

| Component | File | Notes |
|---|---|---|
| `Dialog` | `Dialog.tsx` | Title, one line, a body, Cancel and the action (`tone`: `lime`, `danger`, `solid`). Esc or a click on the dimmed page cancels. |
| `PromptDialog`, `ConfirmDialog` | `Dialog.tsx` | One field before an action runs (or one of a few `choices`, with "Something else…"; a choice with `text` asks for a few words more, as "error, with a message" does); a yes or no with the command it runs. |
| `Popover`, `MenuItem`, `useMenu` | `Popover.tsx` | A menu hanging from its button (`.pop`), kept on screen by `placePop` (`place.ts`), ↑ ↓ between items, closed by Esc, a click outside or the opener. `useMenu()` holds the open state and the anchor. |
| `JobDrawer` | `Drawer.tsx` | The CLI run the dashboard started: title, output, outcome and exit code, files to download, links to what it made. Start a job with `useApp().watchJob(client.startJob(kind, fields))` or `client.action(...)`. |
| `ToastHost` | `Toast.tsx` | One toast at a time: `useApp().toast(text)`. |
| `HoverCardLayer`, `tipText`, `tipCard` | `HoverCard.tsx` | Hover cards in one style, a title and coloured rows. Put `data-tip={tipCard(title, rows)}` on any element; one layer follows the pointer. |

Esc closes the topmost layer: a menu, then a dialog, then a panel, then the phone sidebar. A new
overlay registers itself with `useLayer(kind, open, close)` from `state.tsx`.

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
| `CmdLine`, `CodeBlock`, `CopyButton` | `bits.tsx` | A shell command; a file with Copy in its header; copy and say so. |
| `SortTh`, `ShowMore`, `rowOpen` | `Table.tsx` | A sorting header for `table.t`, "Show 50 more", and a row that opens a page unless a control inside it was clicked. |
| `JsonTree` | `Json.tsx` | A JSON value as a folding tree that draws a branch only when it is opened. |

## State and logic

`state.tsx` holds what every screen shares (`useApp()`): the client, `meta`, the run list, the
connection, `actionsOff` (why actions cannot run here, for a disabled control's title: the server's
`readOnlyReason` when it sends one), `hasKind` (whether the server runs a job kind), `guard` (runs an
action, or says actions are paused while the server is unreachable), toasts, jobs and the palette's
This run entries.

`api.ts` is the one module that talks to the server. Its types live in `types.ts` (the server's,
widened with optional fields other slices add), and every answer passes through `normalize.ts` as it
arrives, so the views read one shape: a field a slice names its own way (`sentAgain`, `lostAt`,
`attemptOf`, `{target, count, action}` hosts, `group: null`, a choice's `text`, the fix a run belongs
to as `{id, status, title}` or as the fixes read model's `{role, fix, blame}`) is turned into the
views' shape there, once. A new field goes in `types.ts` as optional, and in `normalize.ts` when its shape needs it.

The logic behind the components has no DOM and is unit-tested: `route.ts` (routes and links),
`palette.ts` (matching), `strip.ts` (cells and grouping), `origins.ts`, `runs.ts` (what a run is and
how it ended, the Forks view's lines, the run an exported copy opens on), `recorded.ts` (a replayed
call's recorded duration), `cache.ts` (where the cache stopped hitting, and what the Context view
says about it), `scopes.ts` (scopes and their chips), `backoff.ts` and
`connection.ts` (offline, the retry schedule, the `?state=offline` preview), `live.ts` (following a
recording), `actions.ts` (the fork menu and each action's dialog words), `jobs.ts`, `place.ts`,
`normalize.ts`, `format.ts`, and on the run page `run/banner.ts` (which banner, and what it says),
`run/metrics.ts`, `run/model.ts` and `run/calls.ts`.

A page adds palette entries (its Fixes, its goldens, its actions) with `addPaletteSource` from
`palette-sources.ts`. Pages a later version fills in each have their own file under `pages/`.

The Overview's panels are in `overview/` (`panels.tsx`, with what they say in `overview/model.ts`),
and the Runs page's parts in `runspage/`: the calendar (`Calendar.tsx`, its logic in
`calendar-model.ts`), the table, the bulk bar, the import dialog (`imports.ts` guesses a file's
format), Find the commit and authors; `runspage/query.ts` builds the page's requests and reads the
filter a link to Runs asks for (`#/runs?q=…&type=failed`), so any screen can link to a filtered
list. `teamstore.ts` has `useTeamStore()`, the team store as `GET /api/store` reports it, for any
screen that changes with one.
