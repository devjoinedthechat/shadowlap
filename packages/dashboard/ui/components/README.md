# Dashboard components

The parts every screen is built from. The stylesheet is `ui/app.css`, which joins a file per area
from `ui/css/` (the design system: tokens on `:root` in `tokens.css`, dark only, each with its one
job; the parts below in `components.css`; what several pages draw besides in `base.css`; class names
shared by every screen); a component renders those classes, so a new screen ports its markup by
class and reaches for these instead of drawing its own.

The page's Content-Security-Policy allows no inline `style` attribute in markup and no inline
script. React's `style` prop is fine (it sets styles through the DOM, not markup); a colour or a size
that comes from data goes there, everything else is a class.

## The page's language

Every page speaks the run page's language: it opens quietly, with a muted kind, its title and its
facts, and lays its parts out as full-width sections between hairlines. These are its parts, built
once; a page draws them and never its own. Pages move onto them one by one: `Badge`, `Tag`, `Kpi`,
`CmdLine`, `CommandLine`, `CodeBlock` and `CopyButton` below stay until the last page
that draws one has.

| Component | File | Use it for |
|---|---|---|
| `PageHeader`, `Eyebrow` | `bits.tsx` | One header on every page (`.ph`): the eyebrow, a muted line for what the page is (the project and a noun for what it shows, or a thing's kind and its name; never lime), the title at 24/600 in the display face, at most one short line of context, the actions at the top right (under the title on a phone, the lime one first), then `facts`. |
| `ChangesHead` | `changes/Head.tsx` | Changes' head on each of its tabs: `PageHeader` with the project and `diffs`, the title and its one line, then the tabs (`.stabs`), one word each, with the command each matches on hover. It has no button: each tab's next step keeps the lime. It notes the tab it shows for the project (`changes-tab.ts`); an exported copy's Compare has a `PageHeader` of its own. |
| `Facts`, `Fact` | `Facts.tsx` | A page's facts under its header (`.metrics.pfacts`): each figure in the display face, its words muted, money last and quieter (`money`), a figure that leads somewhere a link in ink (`href`). What it is made of and what it was before (`tip`, `was`) are on its hover, never beside it. Three across on a phone, two when there are two or four. |
| `Row` | `Row.tsx` | A row of a list in a section (`.srow`): its hover 12px past its text on both sides, and where you are (`sel`) on the selected ground, which wins over the pointer's; a link with `href`. A table's row takes the same with `className="sel"`. |
| `Section` | `Section.tsx` | A part of a page in place of a card (`.panel.sec`): a hairline above, its heading (14px, 600) and a muted sub, its rows full width between hairlines, a row's hover 12px past its text on both sides (`--bleed`). Sections are 32px apart, two side by side (`.grid2.secs`) 40px. Only what is not the page keeps a box: a dialog, a drawer, a menu, code. |
| `Status`, `statusTone` | `Status.tsx` | Every status: a 7px dot and a word in the word's colour, passed included (`.st`): `ok` passed, `err` failed, `warn` inconclusive or a look needed, `mu` not applicable, `done` a finished step (ink, no verdict), `live`, and a fork's `stub` and `block`. `statusTone(word)` gives a verdict word's tone, an injection test's too (obeyed and caused `err`, influenced `warn`, ignored and not caused `mu`), not `fixes/model.ts`'s `verdictTone`, a fix step's. Nothing else draws a status. |
| `VerdictLine` | `VerdictLine.tsx` | A verdict as a plain line, never a tinted box (`.verdict`): its word in its colour, what it says in ink at 17/600 (its heading names the word too, for a screen reader), its facts muted under it, its next step at the right, 24px under it; a report's own a step smaller (`report`). |
| `SegmentedControl` (`Seg`) | `Segmented.tsx` | A choice of a few (Chart or Table, a transport, a provider): plain options, the chosen one ink on a raised ground with a hairline ring, no panel and no ink pill (`.seg`). |
| `Switch` | `Switch.tsx` | On and off, never two options: a button with the switch role (`.switch`), its track 28 by 16, its taps 44 by 24; the page toasts what changed. |
| `CodeBox` | `CodeBox.tsx` | Every command box (`command`, one or several), block of code (`code`) and file of code (`file`), each with one Copy and no other, named by what it copies (Copy command, Copy commands, Copy whole command, or `what`), copying the whole thing and never the `$` (`full` where the box shows it shortened); a box that shows a change has none (`change`). |
| `Link` | `Link.tsx` | A link in ink at 500, underlined on hover, at its line's size (`.more`; `quiet`, a reference in a quiet line, `.dlink`); `to` ends one that names where it goes in →; `tip` gives one that says more on hover its card (`tipCard`). |
| `Id` | `Id.tsx` | A run's id in mono, never broken (`code.rnm`), its about line on hover, a link with `href`. In a list of runs (`list`) its first six characters quieter, drawn by its own ground, so the text stays the id as it is: one text that copies, searches and reads whole. |
| `Term`, `glossed` | `Term.tsx` | A word the glossary defines (`ui/glossary.ts`, one table), defined where it first shows on a page: a dotted underline, its definition on hover and to a screen reader (`aria-describedby`), and the focus; later uses read as plain words. The first of each word in the page's order is the one defined, a dialog's and a drawer's apart from the page's, and never one in a control or a place with a hover card of its own. `glossed(text)` marks the terms in a status word, a legend or a bound. |
| `AttemptsCell`, `AttemptList` | `AttemptsCell.tsx` | A gate's attempts in a cell: the tally and its bound as the server words them, each kept whole, the interval's 64px bar (`IntervalBar`) against the gate's two marks, and its attempts on request, each a run that opens: a line each, or past six a cell each, a picture whose cells say their attempt on hover, under it lines for the first three not judged or failed. A row that draws the list elsewhere holds the toggle (`open`, `onToggle`). |
| `EmptyState`, `EmptyLine` | `States.tsx` | Nothing here yet: a section under a hairline (`.panel.stepempty`), its heading, one sentence (set as `Copy` sets UI copy with `copy`, never a message the server wrote), the one `step` that gets there (the page's lime) with the command for a terminal quiet under it, its `$` never copied, or with no step the command in its box. A list that matches nothing says so in a line from the left (`EmptyLine`). |
| `Skeleton` | `States.tsx` | Still loading: `lines` quiet bars under the part's heading, or the part's own markup (`children`) with every text a bar along its line and every mark its shape, nothing to press. A screen reader hears what is loading. |
| `ErrorState` | `States.tsx` | What couldn't be read: one line in the error tone, its word first ("couldn’t load"), a sentence, and `retry` at its end, which waits while the server can't be reached (`.loaderr`). |
| `NotFoundPage`, `notFoundWords` | `../pages/NotFound.tsx`, `../not-found-words.ts` | A route an id doesn't name: the page's header, `<project> · not found`, `Nothing here`, the line and the list that holds its kind. |
| `SetUpStep` | `../pages/set-up-step.tsx` | A page's empty state in a project with no runs: the lime `Set up <project>` link to the Overview, where the setup is. |
| `FoldSum` | `../pages/setup-steps.tsx` | A done setup step folded to its line: its facts, each kept whole, then the command it found, broken only between its arguments. |
| `Copy`, `glue`, `Words`, `LongWord` | `Copy.tsx`, `typeset.ts`, `typeset-lines.ts` | A piece of UI copy set by the line-break rules `typeset.ts` states, at render time and at the width of the block it sits in (`typeset-lines.ts` decides as the mock's pass did): its sentences found in its own text, the elements among its words (a link, code, a key, a term) each kept whole; each glued (`glue`: a number with its unit, a tally, a separator with the word before it, a small word with the word after it); each that fits a line kept whole on it, one of two lines balanced on a line of its own unless it should flow on, a short tail with no stop kept with the sentence before it; a block of two lines balanced, its one sentence broken after a clause, a longer one pretty, its last line a third full. `phrases`, for a dialog's lead, a row's value, a card or a setup step, also breaks before a phrase. A long name is whole where its line holds it (`LongWord`). `Words` glues a line no `Copy` sets. Never data: an answer, a prompt, code or an id. |
| `Code`, `Command`, `CodeText` | `Copy.tsx`, `typeset.ts`, `cmdline.ts` | Inline code whole up to 32 characters, a longer path, host or name whole where its line holds it and else broken only after a slash, a dot or a hyphen (`Code`); a command breaking only between its arguments, its head whole, a long argument whole where its line holds it with its flag, its lines balanced and its `$` never copied (`Command`, `commandParts`); code shown as text breaking at its spaces and after its commas and opening braces, a field keeping its number and an operator the word before it (`CodeText`, `codePieces`). |
| `Decision` | `Decision.tsx`, `../decisions.ts` | One model call's decision beside the other's, in Compare's opened row and a preview's cell: its words, tools and effects, how its turn ended. |
| `JsonDiff` | `JsonDiff.tsx`, `../json-diff.ts` | Two JSON values as one structural diff, a line a key, changed words marked: one list, or side by side (`split`). Loads through `onShow` (`HEAVY`). |
| `DiffHead` | `DiffNotes.tsx` | Names a diff's two sides over it: − the recording's, with its run's `Id`, and + this run's. |
| `DiffNotes` | `DiffNotes.tsx` | Says under a diff, from Show diff's answer, what changed, what fixes each path, and every normalizer's command in one `CodeBox`. |

## Layout

| Component | File | Use it for |
|---|---|---|
| `Page` | `Page.tsx` | Every scrolling page. Gives back the scrollbar's width (`--sbw`) so the content's right edge stays under the top bar's. |
| `useActiveTabInView` | `hooks.ts` | A ref for a strip of tabs that scrolls sideways on a phone (Settings' tabs, a run's views): it shows the active tab on mount and when the tab shown changes, scrolling the strip alone (`stripScroll` in `place.ts`). |
| `useScrollStop` | `hooks.ts` | A ref for a pane that scrolls and holds no control of its own (a dialog's body, the shortcuts on a phone): it takes the focus while it scrolls, so the keyboard can scroll it too. Its `axis`, `'x'`, is for one that scrolls sideways (a results matrix's band). |
| `StepList` | `bits.tsx` | Numbered setup steps on a rail, each an h2 with the command that does it (`ol.setup`); a step is `done`, `cur` or `todo`. |

## Code that waits until it shows

| Component | File | Use it for |
|---|---|---|
| `onShow` | `OnShow.tsx` | A part of a page heavy enough to wait for a script of its own until it first shows, as a run's views but Calls do. `test/ui-bundle-size.test.ts` holds the structural diff (`JsonDiff.tsx`), the results matrix (`ResultsMatrix.tsx`), the check builder (`ui/checks/`) and each Changes tab (`ui/changes/`, but its `Head.tsx`) to it, failing when one of them is in the first look or loads with a page. The diff's walk (`json-diff.ts`) may load with Compare alone, a heavy page itself. Declare a part beside the page that shows it, never in `pages/lazy.tsx`. A part an exported copy never draws, such as Share's menu, the palette, the job's drawer, or the page that says another project holds what a link names (which the page list shows too), is handed in by the served entry instead (`ui/served-parts.ts`, from `ui/pages/served.tsx`), so a copy's script holds none of it, and `test/ui-exported-copy.test.ts` pins what keeps it undrawn there. `preload()` a part on a sign it is about to show (the pointer or the focus on the tabs that switch to it), never as its page opens: what opening a page loads is held to the page's budget. |
| `LoadFailed` | `bits.tsx` | What a part shows where its script didn't come (`onShow`'s `failed`; a page's in `pages/lazy.tsx`, under its title): an `ErrorState` whose Retry loads the page again, since a browser never asks twice for a script that failed. Retry waits while the server can't be reached (`guard`). A part that opens on a press says the same (`loadFailedText`) in an error toast instead (`pages/served.tsx`). |

Share's menu, a part only the served dashboard hands in, brings the words of its rows with it
(`ui/run/share.ts`). What a run's header, steps and keys say of a copy, such as Pack's command, what
a pack holds and Push, is in `ui/run/share-steps.ts`, so opening a run loads none of the menu's words.
The fork menu (`ui/run/ForkMenu.tsx`) and the header's … with Delete run's helper (`ui/run/MoreMenu.tsx`)
are such parts too: a copy forks nothing and draws none of the header's actions.

## Overlays

Whatever opens over a page stands on one surface (`--pop`, one edge and its shadow, `--shadow-pop`; a 1px outline in forced colours) and in one of three slots beside the app (`ui/overlays/slots.tsx`): a menu or a picker in `#menu`, a modal in `#layer`, the job's drawer in `#dock`. One never destroys another, except that opening a modal closes a menu and opening a menu closes the last. The stores (`ui/overlays/menu-store.ts`, `modal-store.ts`) remember what opened each and give the focus back to it however it closes (`focusBack` in `ui/overlays/focus-back.ts`), to its counterpart if the page drew it anew; their keys run in the capture phase (`overlayKeys`), so no key of the page's fires while one is open. Another page closes what is open over the last, without asking, the focus going to the new page (`closeLeftBehind`, the router's). What stays at the window's foot reads `modalOpen()` and `menuSheetRect()` (a phone's sheet) and hears a menu or a modal open and close with `onOverlayChange()`. A new overlay is one of these parts, never a scrim or a `.pop` of its own.

| Component | File | Notes |
|---|---|---|
| `Modal` | `Dialog.tsx` | What a modal stands on: a scrim in the layer slot, the app behind it inert, Tab kept in it, the focus back on what opened it. `requestClose` is what Esc and a press that starts and ends on the scrim ask of it, and what tells it its page has gone. The palette and the shortcuts draw on it directly. |
| `Dialog` | `Dialog.tsx` | One anatomy, its slots in order: `title`, `lead` and its `doc` link (`docs-links.ts`), `warn` (amber or red), `facts`, the fields as children, `factsUnder`, `runs`, `command` (`CommandRow`), `cost` (`CostLine`), Cancel then the way on (`tone`: `lime`, `danger`, `plain`; `alt`, a second way on, lime). `onOk` returning false, or a promise of false, keeps it open. It always fits: its header and footer pinned, its body scrolling, a sheet on a phone. Esc or a press on the scrim cancels, and where its fields changed, or `dirty` says something else did (a file dropped), asks first in the footer ("Discard what you changed?"); Cancel never asks. The focus starts by rule (`dialogFocus` in `focus.ts`, `firstFocus` in `ui/overlays/focus-back.ts`): on Cancel when the action is red or `initialFocus="cancel"` asks for it, so Enter twice never does what can't be undone; else on its first field, not on a touch screen; else on its action, on a touch screen on Cancel while the action waits; a drop zone before them all. |
| `DialogFacts`, `DialogSteps`, `DialogTip` | `DialogFacts.tsx` | Label and value rows between hairlines, a quiet part under the value, an amber or red row; numbered What happens; words with a card of their own. Not the page's `Facts`, a row of figures. |
| `CostLine`, `CommandRow` | `CostLine.tsx`, `CommandRow.tsx` | What a dialog bills, price first, breaking after a dot, holding the body's foot while it scrolls; given the job's `estimate`, the engine's line for it in place of `price` and `parts` (undefined while it is worked out). Its `$` row, a chain a line a command, the box's one Copy. |
| `JobButton`, `useBilledPress`, `AskNote` | `JobButton.tsx`, `AskNote.tsx` | A billed job's button: its card says its price and whether a press starts it (`tipEst`), and a press follows Spending (`pressBilled` in `ui/spending.ts`), starting with the estimate it showed or asking. `useBilledPress` is the same rule for a control that draws its own button; a menu row or a palette source calls `pressBilled` itself. `AskNote` is an ask's footer where the threshold is why it asks: `Asks above $0.50 · Change`. |
| `UpdateGoldenDialog`, `GoodCommitField` | `UpdateGolden.tsx`, `GoodCommit.tsx` | Update golden, on Tests, a test replay's page and the apply drawer, from `update-plan.ts`; Find breaking commit's radio list and its field for any other commit, in all three of its dialogs. |
| `PromptDialog`, `ConfirmDialog` | `Dialog.tsx` | One field before an action runs (or one of a few `choices`, with "Something else…"; a choice with `text` asks for a few words more, as "error, with a message" does; `suggestions`, answers it offers as you type, as the bulk bar's Label offers the labels runs carry), with the command it runs, which can follow the answer; a yes or no with the command it runs. Both take `footNote` (an `AskNote`); `PromptDialog`'s `onAnswer` is told the answer as it changes, as Switch model's Cost line follows the model typed. |
| `MigrateAsk` | `MigrateAsk.tsx` | Migrate's one ask, on Needs a look's retire row and a preview's next step: what it asks again, its command, that the provider bills it. |
| `ModelField`, `useModelChoices` | `ModelField.tsx` | A model to switch to, typed: it offers the runs' models, then the providers', by family, and notes a provider it can't list. |
| `NewPreviewMenu`, `PreviewWayButtons`, `usePreviewDialog` | `NewPreviewMenu.tsx` | New preview's menu and its three ways, on every golden, picked runs or one run, each priced, opening its dialog (`changes/NewPreview.tsx`). |
| `DatasetDialog` | `DatasetDialog.tsx` | Runs as an eval dataset: a format and which calls become examples, as the `export-dataset` job. A run's Share menu and the Runs page's bulk bar both open it; pass `rules` when the page knows how many redaction rules the copy applies. |
| `Popover`, `MenuItem`, `useMenu` | `Popover.tsx` | A menu hanging from its button (`.pop`, `narrow` for the second of its two widths, `curmark` for a check before each row), placed by the room there is (`placeMenu` in `place.ts`) and again as it or the window changes size, its first item focused, a sheet on a phone. Arrows round its ends, Home, End, PageUp, PageDown, a typed letter, → to a row's second button (`.prow`, `.px`), Tab and Esc to close, `onKeys` for keys of its own. A button that opens one says so as it is drawn (`aria-haspopup`), so ↓ and ↑ open it from the first press. A row is one line: `<b>` what it does, `<small>` what it runs; what it is for and its command go on its hover card (`data-tip`). `MenuItem`'s `checked` makes it the picked one of a choice (`menuitemradio`). `useMenu()` holds the open state and the anchor. |
| `Picker`, `matchPicks`, `pickMove` | `Picker.tsx` | A combobox: a filter over a listbox, the field naming the option the arrows light (`aria-activedescendant`), the one picked checked, "Nothing matches." when the filter leaves none, at its button's width, a sheet on a phone. The lit row moves by a class alone, so a key draws no row of a long list again. `RunPicker` (`ui/compare/`) is one over runs, by id, about line or label: Compare's, the redaction preview's. |
| `JobDrawer` | `Drawer.tsx` | The CLI run the dashboard started, docked across the content's foot in the dock slot, the content making room (`--dock-h`, `body.docked`): the -ing title, the log, then the past tense, the outcome in the verdict's colour and its way on. It folds two seconds after its end; Esc or its chevron hides a running job behind the status bar's chip (`shell/JobChip.tsx`). Its code loads as the first job shows (`onShow`), handed in by the served entry (`ui/served-parts.ts`), since an exported copy runs no job; `job-store.ts` holds the list it reads, and `jobs.ts` and `job-ending.ts` how a job ended. A link the command marks `secondary` reads as a plain link before the way on. A Replay that diverged adds **Calibrate**. A job of another project than the page shows says which, and its links switch to that project first. A feature adds to its way on through `addJobFooter`. Start a job with `useApp().watchJob(client.startJob(kind, fields))` or `client.action(...)`. |
| `ToastHost` | `Toast.tsx` | One toast at a time, centred on the content over what sits at its foot (`toast-place.ts`): `useApp().toast(text)`, gone after 5 seconds. A refusal or a failure is `toast(errorText(err), 'error')` (`toast.ts`): a red dot, read out at once (`role=alert`), a ×, 8 seconds. Any other is said in one polite region (`announce`). A toast can carry one action, `toast(text, 'notice', { label, run, returnTo })`: a button, 8 seconds, held while the pointer or the focus is on it. Only one with `undo: true` answers ⌘Z and `u`; `focus` gives it the focus; `onGone` is told when it goes, however it goes. |
| `ActionButton`, `useActionWait`, `useOfflineLink` | `ActionButton.tsx` | What every action on the server is drawn with: while `actionsOff`, the server out of reach or its own `why` holds it, it keeps its place and focus, `aria-disabled`, never lime or red, its card and a press's toast saying why, with `whyAct` as the way out. `disabled` is for what isn't waiting on anything. `useActionWait` is the same reason for what isn't a button; `useOfflineLink` holds a link to an attempt. `Switch` and `SegmentedControl` take `action` for the same wait. |
| `HoverCardLayer`, `tipText`, `tipCard` | `HoverCard.tsx` | Hover cards in one style, a title, lines, coloured rows, a command and a billed job's price (`est`, under its sentence: `≈$0.027 · starts at once`). Put `data-tip={tipCard(title, rows, line, command, est)}` on any element; one layer listens for all of them. A card is anchored to its element (`placeTip` in `place.ts`), never over the menu its button opened or a dialog's footer. A pointer waits 400 ms, the keyboard's focus shows one at once, a tap toggles one on a fact that is no link or button and in no row that acts on a tap (`data-acts`, which `rowOpen` sets), and its element points at it (`aria-describedby`). It goes when its element or its page does. An element with a card and no action of its own takes the focus where it stands on its own; in a row or a chart a mark with no words is an image named by its card (`markTipTargets`). |

Esc closes the menu, else the top modal, in the stores' keys; then a panel (`usePanel` from `ui/overlays/slots.tsx`), the phone sidebar and a hover card, in the shell's.

A dialog belongs to the project the page showed when it opened. When the dashboard switches to
another project elsewhere (another tab) and the page stays, the dialog closes, since its action would
land in the other project, and the switch's toast says nothing was done; `keepOnSwitch` keeps one
that holds only what was typed into it (a rule, a server's command), which then acts on the project
shown (`dialogOnSwitch` in `projects-api.ts`). A dialog that starts a job for its project names that
project in the job, so a server switched since refuses it.

## Data

| Component | File | Notes |
|---|---|---|
| `RunStrip`, `StripKey`, `StripBar` | `../run/RunStrip.tsx`, `../run/StripKey.tsx` | The run page's strip: a recording's or a capture's calls by kind (`../run/kinds.ts`), any other run's by origin. Where the calls don't fit a cell of 6px (24px to a finger), a cell is a range, by the strip's measured width, in what most of its calls are, with a notch at its rarer notable call; hovering it counts each kind or origin. Flags the fork and the lost call; a live run grows a pending cell. One Tab stop, a listbox: ← → select at once, a range at a time where grouped. Its key is the call filter (`../run/call-filter.ts`), with counts and rows balanced where it wraps, beside Filter calls. |
| `MiniStrip` | `Strip.tsx` | The small strip in tables (`.ms`): past 60 calls a cell is a range, in the origin most of its calls have, with a notch at its rarer notable call, as the run page's strip draws it. |
| `RunIcon`, `EventIcon`, `Glyph` | `RunIcon.tsx` | One set of icons, each with its words on hover: recording now (pulsing), recording, failed, replay, fork, capture, test, and for events Fixes, project, settings and training. |
| `Icon`, `Sprite`, `Brand`, `Tile` | `Icon.tsx` | The icon sprite (drawn once by the app) and the logo. |
| `Org`, `Legend`, `SrSpace` | `bits.tsx` | An origin's colour and word; a legend of the origins present; a space a screen reader says between two words a margin draws apart, as a chip's word and its count (`.srsp`). |
| `Said` | `bits.tsx` | A line telling of a change, said by a live region drawn empty before its words (`.said`); `alert` for a refusal; the drawn line aria-hidden. |
| `Tag`, `Badge`, `Kbd` | `bits.tsx` | A run's kind beside its id; a tinted status badge, until its pages draw `Status`; a key. |
| `Chips` | `bits.tsx` | Filter chips with counts (empty ones can hide). |
| `Tabs` | `Tabs.tsx` | Underlined tabs with counts, as the pattern has them: one Tab stop, ← → round the ends, Home and End, a count read apart. `idPrefix` and `panelId` tie them to their `tabpanel`; each tab takes a card (`tip`) and a key (`mark`, `shortcut(id)`). Pages switched with links stay `nav.stabs`. |
| `shortcut(id)` | `../shortcuts.ts` | What a control spreads to say its key: `aria-keyshortcuts`, which its hover card reads, and `data-shortcut`, by which the key finds it. Gone while single keys are off. Every key is in that one table, which the shortcuts sheet draws. |
| `useListKeys` | `../list-keys.ts` | One hook for every list: hand it the rows as data, `keyOf`, `root`, `open`, and `pick`, `actions` or `show` where they apply; spread `data-rowkey` on each row and draw the one it returns `.krow`. j and k, ↓ ↑, Enter, x, ⌘K and Esc follow, a page's lists as one sequence. |
| `Kpi` | `bits.tsx` | A number with its label and a line, as Training draws its scores. |
| `CmdLine`, `CommandLine`, `CodeBlock`, `CopyButton` | `bits.tsx` | A shell command; one long enough to wrap, which breaks only between its words (`shellWords` in `format.ts`); a file with Copy in its header; copy and say so (`CodeBox.tsx`'s, the one copy button, its icon alone where `name` names it). Each page moves its boxes to `CodeBox` as it ports. |
| `SortTh`, `ShowMore`, `rowOpen` | `Table.tsx` | A sorting header for `table.t`, "Show 50 more", and what a row spreads to open a page unless a control inside it was clicked. |
| `JsonTree` | `Json.tsx` | A JSON value as a folding tree that draws a branch only when it is opened. |
| `ResultsMatrix` | `ResultsMatrix.tsx` | The results matrix (`../matrix.ts`), one design for an injection test (its untrusted reads by payload) and the error-path presets (a run by preset): each cell a bar in its tone, the word, the tally with its noun and the bound kept whole. Fitted to its room (`../matrix-fit.ts`): balanced bands where it has one row, one band that scrolls under heads that stay put where it has several, turned under 560px where turned it fits. Past eight reads, a row for each tool (`groupRows`). Its script loads on its own: draw it through `FindingPanel` or `ResultsMatrixPart`, never by importing it. |
| `FindingPanel` | `FindingPanel.tsx` | What a finding's Show results opens in the inspector's place (the `results` a page gives `../run/InspectorPanel.tsx`): the matrix's name, what was tried, where and when, and the command; the matrix with its key, or a sentence where no attempt ran; the rule and the checks on one line; the receipt. |
| `ResultsToggle` | `ResultsToggle.tsx` | The finding's Show results, its `which` naming them (`../run/panel-state.ts`). It holds none of their code, so a finding brings no matrix into a page's script. |
| `MatrixKey`, `toneSwatch` | `MatrixKey.tsx` | One key for every matrix: what matters first, its figures in the stat style; what showed nothing quieter, on a line of its own unless it is one entry; a count of zero left out (`keyLines`, and `resultsKey` for a results matrix's counts). An entry with a card takes the focus. |
| `Receipt` | `Receipt.tsx` | The receipt at a matrix's foot, under a hairline: what it cost, then, quieter, what it asked, each line of parts joined by dots. |
| `Conversation`, `useChange`, `useFormatJson` | `Conversation.tsx` | A call's conversation in the inspector and a preview's cell: the first two and last six messages, the rest folded; Jump to change; Format JSON. |
| `RunKey`, `useMarkRun`, `useRunLabels` | `RunKey.tsx` | The good/bad key (`runkey.ts`): two toggles that label a run `good` or `bad` in one press, never both, with the change said in a toast with Undo; and a run's labels as a page shows them while the server catches up. |

## State and logic

`state.tsx` holds what every screen shares (`useApp()`): the client, `meta`, the run list, the
connection, `actionsOff` (why actions cannot run here, which `ActionButton` and `useActionWait` read for a waiting
control's card: the server's `readOnlyReason` when it sends one), `hasKind` (whether the server runs a job kind), `guard` (runs an
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
`focus.ts` (what a dialog focuses first), `shell/top.ts` (a run's parent in its
crumbs, Changes' crumbs by tab, the help menu's key, and the live chip), `shell/status.ts` (the status bar's parts, which give
way first, and when it names read-only), `parents.ts` (each run's parent, from the run details loaded so far, so the
crumbs never load a run twice),
`normalize.ts`, `format.ts`, and on the run page `run/banner.ts` (which banner, and what it says),
`run/metrics.ts`, `run/model.ts` and `run/calls.ts`; for Compare, `compare/model.ts` (what changed, a line a changed fact, the
line a run, the prefix line and what made the fork, the changed request's lines, which runs the
pickers offer), `compare/paths.ts` (a row's words and the words that differ marked) and `compare/args.ts` (where a row's arguments break); for Changes, `changes-tab.ts` (the tab and the pair last shown, per project, outside `changes/` so the shell can hold it) and `changes/model.ts` (each Verdicts row's colour, kind line and link, a chip's empty line, how far Show more reads); for Training, `training.ts` (what a pairs filter
shows, what Score a model sends, and the palette's Training actions). Tests has `goldens.ts`: the
verdict's line, a check's name in the table, the reports as the CLI prints them, which buttons a
failure gets and what the Update golden dialog says; `tests-palette.ts` lists the goldens in the
palette from any page.

Palette entries come from sources added with `addPaletteSource` from `palette-sources.ts`. A
page's actions and Tests are added in `palette-actions.ts`, which loads with the palette, so a fresh
dashboard lists them before their pages have opened; a row whose dialog is on its page opens the
page and asks there (`page-ask.ts`; Apply fix asks by the fix's id). A source runs when the palette opens; one that loads what it lists answers
with what it has and calls `paletteSourcesChanged()` when more arrives, and an open palette reads
its sources again. Pages a later version fills in each have their own file under `pages/`.

The Overview's sections are in `overview/` (`NeedsLook.tsx` with its rows' steps in `steps.tsx`, `panels.tsx` and
`Usage.tsx`, their words kept whole where a line wraps by `words.tsx`, with what they say in `overview/model.ts`;
a person's name, which every page says, in `person.ts`), and the Runs page's parts in `runspage/`: the header's actions (`RunsActions.tsx`: Pull, Import
capture… and Push local runs while runs are only here), the filter field (`FilterField.tsx`: its
terms on hover, how many runs match, `onCommit` for Enter), the row of days (`DaysRow.tsx`, a bar a
week on a phone, its days picked by `day-picks.ts`) and the calendar it opens (`Calendar.tsx`, its
logic in `calendar-model.ts`), the table (`RunsTable.tsx`, `RunsTableEmpty` the line an empty list
says), the bulk bar (`BulkBar.tsx`, on `ActionButton`, Pack and Export dataset… saying why they wait;
`bulk.ts`: Dataset's limit, ids sent in batches, the Delete command; `run-words.ts`: its toasts and
`labelSuggestions` for Label, which a run's page says too, so it loads none of `bulk.ts`), the import dialog (`imports.ts` reads a file's first
bytes for the engine's `guessImportFormat`, and dates the sample trace in `sample-otel.ts` to end now), Find the commit (`find-commit.ts`, what it asks bisect
for) and authors. The bulk bar's Delete waits out its toast with Undo (`delete-runs.ts`); meanwhile
`ui/pending-delete.ts` keeps the runs off every list and sends the delete as the page or the
project goes. `runspage/query.ts` builds the page's requests and reads the
filter its address holds (`#/runs?q=…&types=failed&sort=spent&from=…&to=…`, written by `links.runs`
in `src/links.ts`), so any screen can link to a filtered list. `runspage/history.ts` writes it:
`commitRuns` as a step Back undoes (a chip, a sort, days, Enter), `replaceRuns` in place (the words
as they settle). `runspage/scroll.ts` gives each view back where its list was left, and
`ui/runs-view.ts` keeps the view Runs showed last, which the nav's Runs, the crumbs, `g r` and a
cold Esc open. `teamstore.ts` has `useTeamStore()`, the team store as `GET /api/store` reports it, for any
screen that changes with one (the status bar's part that names it among them); it reads again when the change
feed's `team` counter moves (a push, a pull, a step of the setup). The store's setup is a page of its
own, `#/setup/store` (`pages/settings/StoreSetup.tsx`; its palette rows are added in `palette-actions.ts`), its steps worked out in
`store-logic.ts` from `src/store-steps.ts` (which Needs a look reads too) and its requests in
`store-api.ts` (`client.storeSetup`).

Spending lives in `spending.ts`: the threshold as the server keeps it (`/api/user/spending`), read
at the start and as the window has the focus, and until then unknown, when a press is held to
Always ask (`heldTo`). Only the Spending row (`pages/settings/SpendingRow.tsx`) and an ask's footer
redraw with it (`useSpending`); a press reads it as it is pressed. What a billed job would cost
comes from the server's estimate reads (`estimates-api.ts`), each through its page's hook:
`useRunEstimates` and `useDialogEstimate` (`run/estimates.ts`), `useFixEstimates`
(`fixes/estimates.ts`), `useTestsEstimates` (`tests-estimates.ts`) and `useBisectEstimate`
(`runspage/bisect-estimate.ts`). A job's start sends the estimate it showed (`sentEstimate`), which
the server keeps for its drawer.

Fixes keeps its parts in `fixes/`: a fix's page and its Blame, Repair and Verify steps, the Forks
view's blame and verify bundles (`Bundles.tsx`), Run blame (`RunBlame.tsx`, which asks for the check
when the server can't find it; its dialogs in `RunBlameAsks.tsx`, a part only the served dashboard
hands in, loaded the first time one asks), a fix's step on a list row (`RowStep.tsx`, on Fixes and Needs a look:
its words in `lead.ts`, its dialogs in `LeadDialog.tsx`, loaded as one first shows, which reads
`FixDialogs.tsx` and `verify-asks.tsx` and none of the fix's page), what the breadcrumb and the
palette know about fixes (`data.ts`),
why an action can't start while a repair or an apply holds the project's working tree
(`tree.ts`: `useTreeBusy(use, verb)` gives the reason, or null; any button that runs the agent can
read it as Run blame, Run repair, Apply fix and the Tests actions do, and
`useServerJobs()` is the job list it reads, every tab's, for a page that waits on other jobs too,
as Tests waits on a test job with `testsBusy` from `goldens.ts`; `useTestsWait(verb)` reads both, and
`TestsJobButton` is a button that starts a Tests job from another page, a test replay's banner, and
waits as the Tests page's own do, its `card` and `estimate` read from `useTestsEstimates`; beside it
`TestsAskHost` (its own file), which the shell draws once, asks the question a Tests job waits on
before it runs goldens live, wherever it started, as `startTestsJob` in `tests-ask.ts` keeps the
server's 409 until Spending or the person answers it, and a billed job's ask with no 409 behind it,
the palette's Run blame, whose `start` its button runs; `FixJobButton` starts a fix's jobs by
Spending, from `useFixEstimates`, `form` for one that asks for something first), and the logic they share, DOM-free
and tested (`model.ts`: chips, steps, the Blame step's row of calls, the change cut to what changed,
report.md read as blocks, the drawer's outcome words, which jobs hold which tree).

A page that shows what a feature keeps in its own tables reloads on that table's count in
`feeds` (`useApp().feeds.fixes`), which moves when `/api/changes` lists the table under `other`, as
it reloads on `tick` when runs or calls change; `feeds.jobs` moves when a job starts, ends or reports.
A run's page and what hangs from it (its offers, its family, its fix bundles) reload on `runsTick`,
which moves only when the run list loads again, and while a run records, on its own count in
`live` (`runRefresh`, `familyRefresh` in connection.ts): another run recording asks them for nothing.
