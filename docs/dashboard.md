# Dashboard

`shadowlap dashboard` opens your recordings in a browser: the same store the CLI and the terminal UI use, with more room to read. Follow a failed run to the call that lost it, fork it at any call, and take its fix through blame, repair and verify.

This page walks through each page of the dashboard, then what you can do from it, then the reference:

- **The pages**: [the shell](#the-shell), [Search or jump to](#search-or-jump-to), [Overview](#overview), [Runs](#runs), [a run's page](#a-runs-page), [Changes](#changes), [Fixes](#fixes), [Tests](#tests), [Training](#training), [Settings](#settings), [the team store's setup](#the-team-stores-setup) and [Projects](#projects).
- **What you can do**: [Actions](#actions), [read-only mode](#read-only-mode) and [sending a run to someone](#send-a-run-to-someone).
- **Reference**: [keyboard shortcuts](#keyboard-shortcuts), [limits](#limits), [security and consent](#security-and-consent), [large stores and long runs](#large-stores-and-long-runs), [how the page stays current](#how-the-page-stays-current), the [HTTP API](#http-api), [notes for contributors](#for-contributors) and [troubleshooting](#troubleshooting).

## Start the dashboard

Run it in your project's folder:

```sh
shadowlap dashboard
```

It opens your browser on the dashboard and prints the link, which carries a session token:

```text
Shadowlap dashboard  http://127.0.0.1:4777/#token=…
  /home/you/support-agent/.shadowlap/shadowlap.db · the link carries a session token; keep it to yourself · Ctrl-C stops
```

The dashboard runs until you press Ctrl-C in its terminal. Open a run from the sidebar or from [Runs](#runs), or press ⌘K (Ctrl K) and type its id.

Other ways to start it:

```sh
shadowlap dashboard <run>             # opens a run directly
shadowlap dashboard <run> --call 17   # at a call
shadowlap dashboard --no-open         # print the link instead
shadowlap dashboard --read-only       # look around, change nothing
```

The command takes these flags:

| Flag            | What it does                                                                      | Default |
| --------------- | --------------------------------------------------------------------------------- | ------- |
| `--call <n>`    | With a run, open at this call                                                     | —       |
| `--port <port>` | The port to listen on: `0` for any free one; a taken one falls back to a free one | `4777`  |
| `--no-open`     | Print the link instead of opening a browser                                       | —       |
| `--read-only`   | Show every page and change nothing: see [Read-only mode](#read-only-mode)         | —       |

See [`dashboard`](./cli.md#dashboard) in the CLI reference.

## The shell

Every page shares one frame: a sidebar, a top bar and a status bar. The dashboard is dark only.

At 1000px and below the sidebar is a drawer behind the menu button. Opening it puts the focus on its first item, and the page and the status bar can't be reached until it closes. Esc, a click beside it, a link in it or ⌘K closes it.

### Sidebar

The sidebar holds, from the top:

- **The project**, which opens the [project switcher](#projects).
- **The pages**: Overview, Runs with how many there are, Changes, Fixes and Tests, then Training under a hairline. Changes opens the tab it last showed in the project.
- **Recent runs**, as a tree. Its caret folds it, and the browser keeps it folded until you open it again.
- **Settings**, at its foot, whether the tree shows or not.

The recent runs make a tree as deep as each family goes. A replay or a fork sits a step in, under the run it came from, so a fork of a fork sits under that fork, as the Overview's grid nests it. A lineage deeper than four steps keeps to the fourth, where a run's id and time still fit.

Each run shows its id and when it ran, then its [about line](#a-runs-id-and-its-about-line) and only what needs a look (*lost at #9*). A failure reads as Runs' Status says it (*lost at #9*, *diverged at #3*). A run where a check couldn't be decided reads *inconclusive*, in amber.

A run's icon says what kind of run it is and how it came out, and a screen reader hears it in words. A test replay left inconclusive draws the tests icon in amber (*Test inconclusive*). A recording that a check failed reads *Recording, check failed*.

### Top bar

The top bar shows:

- **Where you are**, as crumbs. A run's crumbs carry its lineage, each with its about line on hover. The run it came from shows its card on hover, and `p` opens it.
- **A live chip** while a run records: *recording · 9 calls*, with the run and its about line on hover. It names the first recording that isn't the page you are on. While the server can't be reached it stays, saying when the recording was last heard of.
- **Search or jump to** (⌘K or Ctrl K), which opens [the palette](#search-or-jump-to). At 1000px and below it shows its icon alone.
- **Help**: Keyboard shortcuts, Docs and Command line. A touch screen leaves out Keyboard shortcuts.

A page that can't show what its address names, such as a run the store doesn't hold, names only its section in its crumbs and its tab's title. At 640px and below the crumbs are left out, and at 1000px and below the live chip.

When a recording ends, a toast says so on whatever page is open, whether it was recorded from a terminal or anywhere else: *Recording finished · 01M53JE2Q0 · 32 calls*, or *interrupted* when it stopped before its end. A run that a dashboard job made says how it ended in the job's drawer instead.

### Status bar

The status bar says, from the left:

- **The store**: its path, whole on hover.
- **The runs**: *48 runs · 12 attempts*.
- **The connection**, only when something is wrong: *offline*, or *link expired*.
- **Read-only**, on a [read-only dashboard](#read-only-mode), with why on hover.
- **Where it runs**: its address and *local only*. With a [team store](./team.md), the store's name and its last sync (*synced 10:14*), or *setting up* while its setup is under way.
- **The version**.

When the window is too narrow, a part gives way whole: the version first, then where it runs, then the store. The runs, the connection and *read-only* stay.

A job off the screen leads its right-hand side: what it is doing (*Forking · running*), how many run from every tab (*2 jobs running*), or what a hidden one did (*Replayed · reproduced · exit 0*). A click opens it. At 1000px and below it floats at the window's foot as a pill.

### Toasts

A toast says what just happened. It stands centred on the page, over the job's drawer, the bulk bar and the footer of a tall dialog, and goes after 5 seconds, or 8 with a button. The pointer or the focus on its button holds it. A refusal or a failure has a red dot and a ×, and stays 8 seconds.

### A run's id and its about line

A run is named by its id on every page: its heading, the crumbs (which carry its lineage), the sidebar, Runs, Compare, Search or jump to and the Overview. One quiet line, the **about line**, says what it was about.

The about line is worked out from the run and never edited. It depends on the kind of run:

| Run | Its about line |
| --- | --- |
| A recording | The first sentence of the first thing the user asked |
| A recording of several agents | What the agent under test was asked first |
| A recording of a batch | Its input, as *inbox 2026-09-30* |
| A test replay | Its golden |
| A replay or a fork | What it changed, with the call written with # (*override #16*, *HTTP 529 #19*, *rescued #5*, *clean replay*) |
| An attempt | What it asked again (*resampled #5, attempt 2*) |
| An import | Its file or trace; an import of several files shortens to *a.jsonl and 1 more* |
| Anything else | Its command |

So in a tree, a child shows only its change.

How the about line fits the room it gets:

- **On one line**, it is fitted to the room it gets at whole words: its first words and its last, with *…* between (*Ticket T-8812 … arrived damaged*). It keeps a ticket or order number rather than a UUID, and gives its place up rather than show part of a word.
- **What a replay or a fork changed** is never shortened, except a field set by its path, which keeps its last parts with the value and the call (*budget_tokens=4096 #17* for *thinking.budget_tokens=4096 #17*).
- **In the sidebar**, a run's status beside it gives way before its about line does: first to its one word (*failed* for *check failed*, *lost* for *lost at #9*), then whole.

The about line quotes what the run recorded. So a copy that leaves the store (an HTML file, a share link) works it out from that copy, with the project's redaction rules applied. Labels stay chips beside it, for meaning and filtering, never a name. Runs' filter matches it.

## Search or jump to

**Search or jump to** (⌘K or Ctrl K) is a palette over the whole dashboard. It offers:

- **Every page**, and **This run's actions**, its next step first.
- **The actions** of every page, from the first time it opens, whichever pages you have visited: Run tests, Import capture…, Calibrate, Export pairs… and Score model… while there is something to export or score, the team store's setup, and Keyboard shortcuts.
- **The runs**: the newest 500, each by its id with its about line as the hint. Any other run is found by its id, typed in full or its first characters.
- **The fixes**, each by its title, with its label and status. Its steps find it too: `blame`, `repair`, `verify`, `apply`.
- **The goldens**, each with its last verdict: *passed*, *failed* or *inconclusive*, a gate's with its tally and bound. When any diverged, **Update goldens** opens its dialog on Tests.
- **What the runs recorded**, from three characters: prompts, responses, tool arguments and results, up to six matches, two per run.

Some rows show only once something is typed:

- **Settings**, after the pages: each tab, found by what it holds. `redact`, `trust`, `alerts`, `settings ci` and `spending` each find theirs.
- **Run blame**, for the three newest failures whose next step it is, by what they were about or `failed`. It is priced as you pick it and goes by [Spending](#spending), asking over any page in *Run blame on* the run. What else it asks first, your command, a check or a yes, it asks on the run's page.
- **Apply fix**, for each verified fix not yet applied, by its label or `fix patch`. It opens the fix's page and asks there.
- **Add normalizer…** and **Add redaction rule…**, which open their Settings tab and its dialog.

A row with a key of its own shows it at its right, while single-key shortcuts are on. On a touch screen, or where its own words don't fit, the field says *Search or jump to*.

**On a list's row**, ⌘K offers that row's actions under its name: on a run's, Open run, its next step, Replay, Compare, Copy ID and Select run. The next step says what the run's lime button says, with no key: `b`, `r` and `c` press it on the run's page only, and Select run keeps its `x`. A link goes where it goes, Run blame and Replay start where you are, and any other step opens the run and presses the button there, so it asks and waits as the button does.

Run blame and Replay start as the run's own buttons would, and Replay isn't offered while the run records. One that asks first, for your command, the check or whether to run someone else's, opens the run to ask. ⌫ in the empty field shows everything, and closing it hands the focus back to the row.

Every typed word must match. An action is found by its name and what it does, never by the command in its hint, so a run's id finds the run, not every action that names it. A word of three or more letters and digits that is part of a listed run's id puts the runs first. A screen reader hears how many rows each word found.

Matches in recordings, forks, tests and captures come first, however many attempts match too. An attempt (`--repeat`, a blame probe, a verify attempt) replays its run's text, so it shows only for a run with no match of its own. The attempts of one run count as that run.

### How search stays current

The dashboard keeps the search index up to date on a thread of its own, with its own connection to the store. No page waits for it, and a search answers at once from what is indexed.

- **While another command writes the store** (`gc`, a pull, an import), the index waits a tenth of a second at most and tries again later.
- **A store in memory**, which no other thread can open, is indexed on the server's own thread, a slice at a time while it answers no request.
- **A run still recording**: a search first takes in what it said since the last search, so its newest calls are found as they arrive.
- **The index's first start** over a store of thousands of runs: until the index has read every run, the palette says how many runs it has yet to read, and asks again until it has.
- **While the server can't be reached**, the palette's field searches runs and pages. A line under it says *Offline: actions paused until the dashboard server is back*. An action that starts a job stays in its place, dimmed, its hint kept, marked *paused*.
- **While another job holds what an action needs**, such as a test session for Run tests or a repair's working tree for Calibrate and Apply fix, the action stays in its place, dimmed, its hint saying why. Picking it says so again.

## Overview

The Overview is this week at a glance, in your own days: this week is the last seven, today included. It leads with outcomes, then shows every run of the week, what needs a look, and what happened.

### Outcomes

Four tiles lead the page, each against last week:

| Tile | What it counts |
| --- | --- |
| **Failures reproduced** | How many failures were reproduced, with how many fixes are still open |
| **Fixes verified** | Fixes verified, with how many changes were rejected before they shipped |
| **Tests passing** | The goldens on disk that pass, each of the others by its newest result, and when they last ran |
| **Spent live** | What was spent live, with what replaying saved after it: not re-spent, and time not waited |

- **Failures reproduced**: blame replays a failure exactly before it probes. A failure is a fix, however many of its runs were blamed, as the fixes funnel counts it.
- **Tests passing** counts each golden as Tests shows it (*5 / 7 · 1 failed · 1 not run yet*). It is amber when the only ones not passing are inconclusive.
- **Spent live**: with a [team store](./team.md), what teammates' pulled runs spent counts too, as the team's. A pack you unpacked and a capture don't count: that traffic was paid for where it ran.

### This week's runs

Every run of the week is a row of calls colored by origin. The rows are grouped under the recording they came from, on one scale, so a fork's replayed prefix lines up under its parent.

- Past 60 calls, a cell stands for a range.
- The cell where a fork left is outlined.
- A recording grows in place. **Watch live** opens a recording in progress.

### Needs a look

**Needs a look** lists what to act on, most urgent first:

| What needs a look | What its line offers |
| --- | --- |
| A [team store](./team.md)'s setup left unfinished | **Continue** opens it |
| An applied fix that doesn't hold | — |
| Failing tests | **Fix**, to the fix that holds the failure, else **Open**, to the failing run |
| [Injection tests](./injection.md) a planted instruction got through (red), or that it influenced or that showed too little to say (amber) | — |
| [Error-path presets](./error-paths.md) that failed | Each opens the attempt that shows it |
| Inconclusive tests, with an amber mark, and presets left inconclusive | **Run more**, **Run again** or **Update**, all to Tests, else **Open** |
| Failures with no fix yet: open fixes | **Fix it**, or **Open** and where to look |
| Failures with no fix yet: failed runs never blamed | **Run blame**, or **Open** where its page leads with another step |
| A [preview of a change](./decisions.md) whose flagged runs no session of that change has settled since (amber) | Opens the first at the call whose decision changed |
| Verified fixes waiting to be applied, but not one whose pull request merged | **Mark applied** for one that has no patch, as its page has it |
| How many behaviours seen in production no golden [covers](./coverage.md) | Opens a run of the newest |
| With a [team store](./team.md), how many runs are only on this machine | **Push** opens Runs with **Local** picked |

What the lines mean:

- **Injection tests**: a golden's injection gate is its test's line, not one of its own.
- **Inconclusive tests**: **Run more** when the gate ran out of attempts, **Run again** when its injection test showed too little to say, and **Update** when a judge check of a golden that replays offline has no verdict yet.
- **Open fixes**: **Open**, with where to look, when blame found that no answer of the model's lost the run.
- **Failed runs never blamed**: a fork that failed counts as much as a recording. Each is listed by its id and what it was about.
- **A preview of a change** is settled by a session of that change that asked its flagged runs again and flagged none, or whose verify accepted them, as a migration to a model after a preview of it.
- **Verified fixes**: one verified with request fields set, as `--set temperature=1`, says to make them in your agent first.
- **Runs only on this machine** are counted as Settings → Store and `shadowlap store show` count them, by run: a run counts once when it, or an attempt filed under it, isn't in the store yet. **Push** opens Runs with those runs alone, each with the `local` tag.

On a read-only dashboard each line says **Open**, since nothing runs there. Past ten of a kind, one line says how many more there are and opens the page that lists them.

### The other panels

Below, the Overview's panels show the rest of the week:

| Panel | Shows |
| --- | --- |
| **Today** | Tests counted as the tile counts them, each golden by its newest result, and the blames that ran today |
| **Calls by origin** | The week's calls by origin |
| **Prompt cache** | Where the prompt cache stopped hitting, by the [Context view](#context-view)'s rule, with the tokens sent again |
| **Fixes** | How far each failure got towards a fix |
| **Spent and not re-spent** | What was spent and not re-spent each day, as a chart or a table |
| **Activity** | The latest activity: see [Activity](#activity) |

On **Today**, the test replays that ran today show on hover, and so do the blames' probes.

### Activity

The activity feed is what happened in the project, newest first, each entry with who did it. Most of it comes from the runs themselves:

- Recordings started and finished, and clean replays.
- Forks, with the flags that made them as the replay kept them on the run (`--fail-at 19=529`, `--model 15:claude-opus-5`).
- The attempts of one `replay --repeat`, as one entry with how many took the same path.
- Captures and packs imported: the runs one import or one pack brought in make one entry.
- Tests passed or failed, a golden once per session, by its result. A golden that may fork reads *5 of 5 attempts passed*. One with a [gate](./gating.md) reads its verdict, tally and bound, with the gate's rule on hover, and opens the replay that failed.
- Blames.

The rest is what commands record as they change the project or write something:

- Normalizers and redaction rules added, by hand or by `calibrate --write`. A redaction rule is named by what it puts in place, never by its pattern.
- Goldens packed (a pack in a goldens folder or named in the config's `tests`), and other packs.
- A golden's checks changed in the [check builder](#making-a-check): *Check added*, *Check removed* or *Checks changed*, with the golden and the checks' labels. It opens Tests.
- The project set up by `init`, when the project has a store already, as it has when the dashboard runs `init`: `init` never creates one.

An entry no page shows, such as a [preview of a change](./decisions.md), is a plain line that opens nothing. A replay that parted from its recording only over a value that changes on every run, such as a UUID or a timestamp, reads as diverged rather than forked. Nobody changed anything, and a normalizer would mask it.

Who did it is the run's author, worked out when the run was made: `SHADOWLAP_AUTHOR` if set, `ci` in CI, else git's `user.email`, else the OS user. The author stays on this machine: packs and HTML files (`export html`, or **Share → HTML report** on a run) leave it out.

## Runs

Runs lists every run in a table, a page at a time, one row per run.

### The table

Each row shows these columns:

| Column | Shows |
| --- | --- |
| Run | The run's id |
| About | What it was about, with its labels as chips |
| By | Who made it, with a [team store](#runs-with-a-team-store) |
| Calls by origin | Its calls, colored by origin |
| Calls | How many calls it made |
| Spent | What it spent |
| Status | Its outcome in one line: what [its checks](#judged-by-checks) say (*check failed at #6*), a fork's writes (*forked · 2 writes blocked*), or a dash |
| When | When it ran |
| *good · bad* | The [good/bad key](#labels-and-notes) |

While the about line would get too little room, what only adds to a row gives way, measured: first the calls by origin, then the labels, then who made it. Only then, and on a tablet or a phone, the about line goes under the id.

Some runs are shown differently:

- **Attempts** (`--repeat`, blame, verify and the [error-path presets](./error-paths.md)) are bundled under the run they came from rather than listed.
- **A golden replayed more than once** in one test session (`repeat`) is one test run too: the attempt its result shows, whose checks count every attempt (*5 of 5*).
- **A run that failed a check** names the check on its status's hover, so the row keeps one line.
- **A test replay that failed** reads *fixed by* and the run that passed, muted, once its golden passes when it runs again: *fixed by 01K5CQ7A3M*. It leaves Failed.
- **A fork no check judges** defines its first *blocked*, *stubbed* or *fenced* on hover, as the glossary does.
- **A run imported from a capture** shows the file it came from where a command would be, and its cost as captured rather than spent: that money was spent where the traffic ran.
- **A run whose recorder stopped before it ended** (killed, or out of memory) reads *interrupted*. It is deleted, packed and pushed like a run that ended.

### Filter, chips and sort

Above the table:

- **Chips by kind**, with their counts: recordings, forks, clean replays, test replays, captures, failed. Failed counts the runs that failed and the captures their import judged failed, but not a test replay [fixed since](#the-table). A run that fails only its family's checks says so in Status, but Failed and the days above the table leave it out.
- **A filter**: every word must be in the run's id, about line, kind, labels, command, source or revision, or in what the run recorded. Beside it, how many runs match: *207 runs match*. Its terms below narrow it further.
- **Sorting** by calls, spend or time.

| Term | Lists |
| --- | --- |
| `label:good` | The runs labelled exactly that. A label with a space in it is quoted, `label:"needs review"`, as its chip writes it |
| `status:failed` | The runs whose Status says so: `passed`, `failed`, `inconclusive`, `not-applicable` or `live`, or a short form (`fail`, `inc`, `na`) |
| `type:fork` | The runs of one kind: `recording`, `fork`, `clean` (or `replay`), `test` or `capture` |
| `tool:issue_refund` | The runs that recorded a call to a tool whose name starts so. Only recorded tool calls count |
| `"refund over limit"` | Quoted words, as a phrase in that order |

A word of 3 characters or more also searches what runs recorded, as whole words. While the index of what they recorded is behind, the table says so: *Still reading what 3 of 200 runs recorded: more matches may follow.*

`status:` reads each run's verdict as its Status does. Where that takes more than the table can wait for, it says how far it got: *The verdicts of 60 of 200 runs are known so far: runs among the rest may match too.* The table fills in as they are worked out, a long run's beside the server. A run whose outcome decides it, such as one that diverged or failed its own check, matches at once. The days above the table, and Find breaking commit, count the same runs.

### Twelve weeks and Find breaking commit

Above the table, the last twelve weeks are a row of bars, a day each. A bar is as tall as the runs that day had of what the chips and the filter match, its failures red at its foot. So with **Failed** picked, it shows when something started failing. On a phone or a touch screen, a bar is a week.

One line beside the bars says what they count: *207 runs in 12 weeks, on this machine, 41 failed.* **Calendar** shows the same weeks as a grid, a column per week, until **Hide calendar**. The dashboard keeps the one you picked while it is open.

- **Pick days**: click a day, drag across several, or Shift-click to extend. A week's bar picks its seven days. The table and the chip counts follow.
- **From the keyboard**: the arrow keys move between days, Enter picks one, Shift+Enter extends, and Escape clears. In the row, ← and → move a bar.
- **From a link**: days that run past the twelve weeks keep to the days inside, and the address says so.

With **Failed** picked and days chosen, **Find breaking commit…** bisects from the first failure of those days, between a commit where it still worked and its own:

- It offers only commits this checkout has. A teammate's runs can name commits of theirs, and a failure whose own commit isn't here is bisected up to HEAD.
- A failure at the repository's first commit (or the oldest a shallow clone has) has nothing before it to search. The dialog says so, and bisects from the first failure of those days that started later, or offers no search when none did.

### Act on several runs

Tick runs to label, pack, export, compare or delete them together. A run ticked and then deleted elsewhere leaves the selection, and **Clear selection** lets go of them all.

- **Delete 2 runs** names the attempts bundled under the runs ticked, which go with them as `shadowlap rm` takes them. It leaves alone a run still recording, one a replay in progress reads from, and one with an attempt still running. Its dialog shows the `shadowlap rm` command: for a long pick, the first ids and how many more, its Copy taking the whole command.
- **Undo** a delete while its toast shows, or press ⌘Z. The runs go from the store only when the toast goes. Leave the page or switch projects first and the delete goes then, its toast left without Undo. A second toast says only what went otherwise: runs left alone, or a failure, and those runs come back.
- **While a delete waits**, its runs are off Runs' table and its counts, the nav, the status bar, the sidebar and **Search or jump to**. The days above the table and the other pages keep them until the delete lands, then catch up.
- **Add label…** suggests the labels runs carry as you type, most used first. It reads the newest 500 runs, so an older label is typed.
- **Pack** and **Export dataset…** wait while every run ticked is still recording, as a copy made then would be cut off.
- **Pack** asks for a folder first. One run goes into `.shadowlap/exports/<id>` unless you name another folder inside the project. Several go into a folder each, named by its id, inside `.shadowlap/exports` or the folder you name, in one job whose drawer lists every folder (at most 100 runs at once).
- **Export dataset…** says how many redaction rules its copy applies, and shows the `shadowlap export dataset` command it runs, with the file it writes. One dataset takes at most 500 runs.

### Runs with a team store

With a [team store](./team.md) set, the table:

- shows who made each run as their avatar, with the name on hover (yours marked *you*);
- shows a teammate's run at what it cost where it was recorded;
- tags `local` the runs only on this machine, and a run whose attempts are;
- offers **Pull** above it, and **Push** for the runs ticked, with the attempts bundled under them; a run still recording goes when it ends;
- offers **Push local runs** above it, in lime, while runs are only on this machine. It runs `shadowlap push --all`, which leaves out a run still recording.

The **Local** chip lists the runs only on this machine, as Needs a look counts them. The status bar names the store and when this machine last pushed or pulled.

### The view is in the address

What the table shows is in the address: the filter's words, the chip, the sort and the days picked, the days the viewer's own (`#/runs?q=refund&types=failed&sort=spent&from=2026-10-20&to=2026-10-22`). So a view of Runs keeps through a reload, can be kept as a bookmark, and opens from the link the dashboard prints, with the view at the end (`#token=…&open=/runs?types=failed`).

- Picking a chip, a sort or days, or pressing Enter in the filter, is a step of its own, which Back goes back through.
- The words typed take the place of the step they were typed in, once they settle. So Back undoes the words and the step after them together.
- Each view comes back scrolled where its list was left.
- `#/runs` alone is every run, as the sidebar's **all** and the Overview open it. The nav's **Runs**, the crumbs, `g r`, Search or jump to's Runs and Esc from a run opened cold open the view Runs showed last while the dashboard is open.

The address says a view one way, a space as `+` (`#/runs?q=refund+label:good`), and Runs writes it so in its place. It reads keys and a chip's word in any case, and a chip's word in the plural too (`#/runs?TYPES=Forks` is `#/runs?types=fork`). A value it can't read, such as a day there isn't, is left out.

### Import a capture or a trace

**Import capture…** is on Runs, and in Search or jump to. Drop or pick a file. The format is guessed from its name and its first bytes, and can be changed:

| File | Read as |
| --- | --- |
| `.har` | HAR |
| `.json`, its name saying otel, otlp or trace | OpenTelemetry |
| `.json`, its name saying cassette or vcr | A VCR cassette |
| Any other `.json` | What it starts with: a HAR log, OTLP spans, a cassette's interactions, a nock recording or a Shadowlap capture; nock when that says nothing |
| `.jsonl` | LiteLLM, unless its name or its first line says OpenTelemetry |
| YAML | Refused, with the reason |

**Use sample: otel-traces.json** picks the trace the dashboard ships, dated to end as you pick it: one agent run as an OpenTelemetry collector exports it, with two model calls and the tool call between them. **Import capture** then brings it in as any file you pick.

You can also give a Langfuse, LangSmith, Phoenix or Logfire host and trace id. The CLI reads the trace with the keys already in the environment the dashboard runs in, and they never pass through the browser.

| Trace store | Trace id | Keys it reads |
| --- | --- | --- |
| Langfuse | A UUID, or 32 hex characters as on the trace's page | `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` |
| LangSmith | A UUID | `LANGSMITH_API_KEY` |
| Phoenix | 32 hex characters, and the project | `PHOENIX_API_KEY`, when your Phoenix asks for one |
| Logfire | 32 hex characters | `LOGFIRE_READ_TOKEN` |

Phoenix's project starts as `PHOENIX_PROJECT` or `PHOENIX_PROJECT_NAME`, else `default`. Logfire is searched back 30 days; an older trace takes [`--since`](./cli.md#traces) in a terminal.

A run imported from Langfuse links back to the trace: **Open in Langfuse ↗** in [its header](#the-header).

The job runs [`shadowlap import`](./cli.md#import) under the name of the file you picked. Its drawer links to each run it made, or past three, to Runs filtered to them. Each run it makes is judged by the project's rules on calls as it is imported, and its Status says that verdict ([Judged by checks](#judged-by-checks)).

## A run's page

A run's page shows one run: its header and findings, a strip of its calls whose key filters them, views of the run beside an inspector for the selected call, and its labels and notes. What you can do from it is under [Actions](#actions).

### The header

The header says each thing once:

| Where | What it says |
| --- | --- |
| The muted line above the id | What kind of run it is (*recording*, *fork @17*, *blame attempt*) |
| The first fact, under the id at the right | How it came out (*check failed at #6*, *passed*, *interrupted*) |
| The id's card | Its command, revision, start and duration, and why it failed |

The id's card shows while the pointer is on the id, or when Tab reaches the id. Esc hides it. On a touch screen it is a line under the facts. It says why the run failed:

- **The check it failed**, in the CLI's words, with the arguments it names and how a tool's calls were fenced, as `send_email called 1 time, but called 2 times (2 blocked)`.
- **The agent's exit.**
- **Where a test diverged.**

How it came out comes first, as Runs' Status says it: *check failed at #6*, its call a link, or *no checks* ([Judged by checks](#judged-by-checks)). An attempt says its verdict there: *passed*, *inconclusive*, *interrupted*, or a preset's *exited 1*. Then come its calls and, quieter, what it spent. A replay or a fork then shows what replaying saved: not re-spent, and the time not waited (each replayed call's duration where it was recorded). What made each fact up is on its hover: replayed, live and fenced calls, upstream requests, input tokens not sent again.

- **A capture** whose file kept no times (nock, VCR) shows no duration. One of the model calls alone says its tool calls were not captured.
- **A recording unpacked from someone's pack** says *recording · from a pack*.
- **A teammate's run pulled from the [team store](./team.md)** is a recording like any. It shows the requests it sent and what it spent where it was recorded, by whom (*≈$0.0030 spent · by maya*, and the same in Provenance's Upstream row). Its replay asks first, as a pack's does.
- **A trace imported from Langfuse** has **Open in Langfuse ↗** after Compare. It opens the trace's page there in a tab of its own, and its hover names the trace and the host. A pack doesn't carry the link.

The id's card says why the run failed, and the agent's exit with its last line. Under the header, the run also says:

- how it forked, what the flag did and what came before it ("answered with HTTP 529 by `--fail-at 19=529` · nothing sent", "tool #16 overridden with `--override 16=@policy.json` · 15 replayed and #16 overridden before it");
- where blame found it lost, with the fork it rescued and its fix;
- which checks it passed, and what was not recorded;
- or that it failed and was not blamed yet.

### The next step

The header's one lime button is the run's next step: the first of these that applies. The server works it out, so a run's page, its row in the lists, Needs a look and Search or jump to say the same.

| The run | Its next step |
| --- | --- |
| Still recording | **Replay**, off until it ends |
| A test replay whose golden passed when it ran again | **Open passing run** |
| A golden's last test replay, its checks changed since | **Run tests** |
| A golden's last test replay, failing a check added since its previous test that its recording fails | **Edit check…** |
| A test that diverged on a value made anew on every run | **Add normalizer and re-run**, **Re-run test** once the rule is in the config |
| A test that diverged on what a patch or a config change changed | **Update golden** |
| A test that diverged on anything else | **Find breaking commit…**, where it can start from that replay |
| A test whose judge check couldn't be judged offline | **Update golden** |
| An injection attempt that obeyed, no golden made from the recording it tested | **Pack with injection gate…** |
| Any other attempt, failed or not | **Compare with parent** |
| A test replay whose agent exited | **Find breaking commit**, until the commit is named |
| A recording whose newest injection test failed | **Open proof** |
| One that stopped early | **Run injection test…** |
| One that showed too little to say | **Re-run injection test**, **Re-run test** for a golden's gate |
| A recording a read is proven to have caused a write in, no golden made from it | **Pack with injection gate…** |
| Error-path presets that failed | **Open proof** |
| A failure a fix holds | **Open fix** |
| A capture its import judged failed | **Open fix** where a fix holds the same failure, else **Run blame** |
| A failure never blamed | **Run blame** |
| A replay that left its recording on a value made anew on every run | **Add normalizer** |
| A fork | **Compare with parent** |
| A recording that didn't fail, no golden made from it | **Pack as golden…** |
| Anything else | **Replay**, as below |

Every other action stays beside it, plain, and no finding offers the step again. Its hover says what it does, what it bills and the command it runs. Search or jump to lists it first under This run. While a job holds what it needs, it goes plain and says why, there too.

The lime button comes last, before **…**, which holds **Delete run**. From 1280px wide, where the buttons won't fit beside the id, the plain ones fold into **…** one at a time: Replay first, then Pack as golden…, Compare, Push and Run blame. Narrower, the buttons go under the header, the lime one first.

What each step does:

- **Run tests** runs the whole session, as Tests' header does, at its estimate. Its hover says the checks changed since this test, which the session judges as they stand, and its finding names the checks gone.
- **Edit check…** opens the [check builder](#making-a-check) on the golden, at the check. The golden's own recording fails it, so either the check is wrong, or the golden needs an update because the agent should do this. An exported copy offers none.
- **Open fix**: its hover names the fix, and the failure's finding says how the fix stands, *fix open* or *fix verified*, where it linked it.
- **Run blame** isn't offered on a run that made no model call, or on one that was stopped: blame needs a run that fails again as recorded. On a capture, it asks for your command first.
- **Compare with parent** leads for a fork, and for an attempt: a blame probe's, a verify's, a `--repeat`'s, an injection test's, a model's scoring, an error-path preset's, or a golden's repeated replay in one test session, whose failure counts towards its golden's result.
- **Update golden**: a change it was made for reads as a changed system prompt, a tool's definition or the model, which go into every request.
- **Find breaking commit** starts on the click, offline and free, from the newest commit its golden passed at. With no such commit, or on a golden marked fork, it asks first and reads **Find breaking commit…**.
- **Run blame beside it**: on a crash, **Run blame** stays plain before **Fork at #n**, with what it runs and bills on hover, until the commit is named or a fix holds the run.
- **A replay it can't start from**: one cut short, or one of a session its golden came out inconclusive in, says nothing of its golden, so the rows after it decide.
- **Open proof** opens the first attempt that shows the verdict. Presets left inconclusive change nothing, since running them again finds the same.
- **Pack as golden…** asks for a folder, `goldens/` and the run's short id in lower case unless you change it. A golden of a fork or a replay of the recording doesn't count as made from it.
  - It packs the golden, then tests it, as one job, for any run. A recording from someone's pack or the team store asks first, since its test runs the command it was recorded with. So does a test that would run the golden live, in the same question.
  - Where another step leads, a plain **Pack as golden…** comes after **Replay** and can fold into **…**. Search or jump to has it too.
- **Pack with injection gate…** does the same, and names the entry to add under `tests`, for the folder as you type it, that gives the golden its gate.
- **Replay** replays the run itself. On a capture it reads **Replay with your command…**, and asks what starts your agent.
- **Replay recording**, on a clean or a test replay, replays the recording it came from, asking for your command where that is a capture.
- **Compare**, plain beside another step, reads **Compare with parent**, **Compare with fork** or **Compare with replay**, with the `shadowlap diff` it matches on hover. With nothing to compare yet it stays, off, and says what would make something.

A fork that failed, by its check or its agent's exit, says how as its first fact, *check failed at #6* or *exited 1*, as any run that failed does. Its findings keep how it forked, and it leads with **Run blame**, or **Open fix** once a fix holds it. Until it is blamed, it counts among the failures not blamed yet.

### Where a run opens

Unless the link names a call, a run opens at the first of these it has:

| Run | Opens at |
| --- | --- |
| A recording still recording | Its newest call, following each new one |
| A run you picked a call on earlier in the session | That call |
| A run blame found lost | The call that lost it, where **Run blame**'s answer moves too |
| A fork, or a test that diverged | Where it forked |
| A run whose outcome names a call (*check failed at #6*) | That call |
| Any other run | Its first call that failed, then its first write, then its last model call, then its first call |

A call that failed is a model call answered with an error, or a tool that threw, never a write fenced after a fork. A run never opens on a clock or random read, which holds a value rather than a step of the agent's.

### Findings

Under the header, one bar holds what the run's page found: how the run forked or failed, what the fork did differently, what Shadowlap did not record and the run's notes. A failure comes first, in red, then what needs a look, in amber, then the rest, each in the order they come.

The bar shows the most telling finding whole. **N findings** at its end opens the rest in place, its hover listing them while closed, and the focus stays on it. A lone finding with more to show, a note's tools or the fork's changes, has **Details** instead. The bar stays open or closed for each run until you reload.

A finding never says what the header's first fact already does, but for the run that fixed a test replay. Where that fact gives the verdict, the finding leads, in ink and with no label, with what the verdict stands on, then the rest:

| Run | The finding leads with | Then |
|---|---|---|
| Failed a check | The check: *send_email called 0 times, but called 1 time* | *not blamed yet*, or how its fix stands |
| A capture its import judged failed | The check that failed | *judged when it was imported*, then how its fix stands |
| A test replay whose agent crashed | The last line the agent printed | *at call 19, 18 of 30 recorded calls replayed* |
| A test that diverged | What the value looks like, or why it came | The request's name and the calls replayed before it |
| A test left inconclusive | The check it couldn't judge, and why, in amber | *18 calls replayed* |
| A test replay its golden passed since | What it failed, muted, with nothing to mend | *fixed by 01K5CQ7A3M*, as Runs' Status says it |
| A golden's last test replay, its checks changed since | What it failed | *checks changed since: …, no longer in shadowlap.config.json · not tested yet*, and nothing to mend |

**A judge's verdict** is a finding of its own for each judge check that gave one, among the rest, in ink. Its label is *verdict*. It leads with ✓ or ✗ and the check, then **#15**, which opens the judge's call. Then come the judge's reason and where the verdict came from, as in *The reply names the escalation · judged live · <$0.001*. Where the run's own finding lists its checks, a judge check's line there carries the same instead.

A blame that placed the failure on no call says how it stands as the finding's label instead: *stopped* or *inconclusive* in amber, *not rescued* in red. A blame that found the call says *lost at #17*, with **Rescued fork →** where the fork that rescued the run is kept. Words the glossary defines, such as *lost*, *stubbed* and *fenced*, are underlined, with their meaning on hover.

**An attempt.** An attempt of blame, verify, `replay --repeat` or a test says it is one: *blame attempt*, *verify attempt*, *repeat attempt* or *test attempt* above its id. A test attempt is a golden one `shadowlap test` session replayed more than once, other than the attempt its result shows. The fork blame rescued a run with is its *rescued fork*.

Its first fact says how it came out. Its finding says what was asked again, which attempt it is of those made, how the writes after it went and, for one that could not be decided, the check that couldn't be. For example:

- *resampled #5, attempt 2 of 4: the model was asked #5 again, the request as recorded · writes stubbed*
- *verify · target, attempt 1 of 12 · code 35034be: the change it verified is in the request (~ $.system)*, or the flag a `--model` or `--set` change was made with
- *replay --repeat 5 at #16, attempt 2 of 5: forced live with `--live-tool lookup_policy`*
- *refund-over-limit, attempt 2 of 8 · test at d2e8a1f: live from where the golden may fork · writes blocked*

A gate that settles makes fewer attempts than its limit, and the count is of the attempts made. The finding wraps rather than cut its words. It links back to the attempt's probe on its fix's Blame step, or to the verdict it counted towards, and to all its attempts in Forks. A test attempt links to Tests. It offers no Run blame, since its failure counts towards what made it.

**An error-path preset's attempt.** Its first fact says how an [error-path preset](./error-paths.md)'s attempt came out, by the verdict of the session that decided it. An earlier session's attempt keeps its own once the presets run again. Its finding names the preset and the golden it ran on, which attempt of the preset it was, and what the preset played in where, wrapping rather than cut:

*tool timeout preset on goldens/list-inbox, attempt 1 of 1: list_inbox (#2) timed out, played in by the preset · writes stubbed*

A golden's finding has **Tests →**.

**A fork.** A replay an injection test, a model's scoring or an error-path preset made keeps its fork's finding. A fork whose only flag is `--writes` forked where its request changed, and its finding says that.

**A test that diverged.** A test that diverged on a value made anew on every run says what the value looks like, and offers what its header doesn't lead with:

- **Add normalizer and re-run**, which adds the rule and runs the golden again. Once the rule is in the config, the finding says *normalizer added* and links the replay that passed.
- **Update golden**, which asks first, as on Tests.

An id that may be a real change leads with neither: only you can tell, so **Find breaking commit…** leads, and both stay in the finding.

Sometimes the rule alone can't make the replay match: the request carries a field the recording never had, as a per-run id added since. The button then reads **Add normalizer and update**, and asks first too, in the Tests screen's dialog with both commands, since the golden is then re-recorded live after the rule. Once the rule is in, **Update golden** stays beside *normalizer added* until a replay of the golden passes.

**Show diff** opens in the inspector's place, beside the calls, so the list keeps its place. Under *Diff at #n* it shows the request that changed, and the normalizer to add when the change is a date or an id. For a test that diverged, it shows the value its finding names as made anew on every run, what it looks like and its normalizer. So the diff never says that no normalizer is suggested where the finding offers one.

**Hide diff**, a call picked, a key from `1` to `4` or Esc gives the inspector back.

### How a run stands

The server works out how a run stands once, for its page and every list:

- **A test of a golden that may fork** is judged by its checks, not where it left the recording. Its finding lists the checks it passed, then where it went live, what that sent and spent, and its writes: *live from #3 · 14 upstream requests · ≈$0.420 · writes fenced*. Or it leads with the check it failed.
- **A run a fix lists among its failing runs** (verify's target) fails that fix's check, here and in Runs, with how the fix stands.
- **A run whose agent exited with an error** reads *failed*; one that failed a check reads *check failed*.
- **A run that stopped before it ended** (Ctrl-C, a kill, a crash, a recorder that went away) reads *interrupted* in grey after what it is (*recording · interrupted*, *fork @3 · interrupted*), ended at its last call. It stopped; it did not fail.

An interrupted run's page says so: a fork's finding says how it forked, and its first fact says *interrupted*. Open while it recorded, the page ends on *Recording interrupted*. Runs, the sidebar, the Forks view (a `--repeat`'s attempts too), Provenance's lineage, the Overview and the activity feed say *interrupted* too.

### Judged by checks

How a run came out by its checks is its page's first fact and Runs' Status, in the same words:

| On its page | In Runs' Status | When |
| --- | --- | --- |
| *check failed at #6* | *check failed at #6* | A check failed: at the call it names, or the first call past what a count allows, which the page links |
| *2 checks passed* | *2 checks passed* | Every check passed or did not apply |
| *inconclusive* | *inconclusive* | A check could not be decided, such as a judge with no recorded verdict, or a check on what the agent printed |
| *not applicable* | *not applicable* | No check applied: a capture none of whose rules on calls had a call to read |
| *diverged at #1* | *diverged at #1* | A test replay left its golden at that call, which the page links |
| *fixed by 01K5CQ7A3M* | *fixed by 01K5CQ7A3M* | A test replay that failed, once its golden passes when it runs again: the run that passed, muted, and out of Failed |
| *exited 1* | *exited 1* | The agent exited with an error and no check failed: the code where its test result kept it, else *exited with an error* |
| *no checks* | A dash, or a fork's writes (*forked · 2 writes blocked*) | No check judges the run, a clean replay among them |

A run blame found lost says the check it failed in both places. The sidebar says where it was lost (*lost at #9*), as blame's finding does, and *check failed* without the call.

A run whose checks all passed or didn't apply lists them in its finding. A check that didn't apply says why, with what the calls had instead on hover. Each judge check's verdict carries the judge's call, its reason and where it came from: a line of that list, or a [finding](#findings) of its own beside any other.

The checks are the first of these the run has:

- **Its own**, as it was made: by `shadowlap test`, `--expect` or an attempt's oracle.
- **A capture's**, by the rules on calls, judged as it was [imported](./cli.md#import). Once the rules change, it is judged again from its calls.
- **Its family's**: a finished run that kept no verdict is judged by the checks of the goldens packed from its recording, or from a replay or a fork of it, as `shadowlap.config.json` gives them.

A family's checks judge the run from its recording, as [`shadowlap check`](./checks.md#try-a-check-on-your-recordings) judges one, so the two say the same. Nothing is replayed. A judge check takes the verdict the recording holds, else it is inconclusive, and so is a check on what the agent printed, which a recording doesn't keep.

A run recorded before the checks that judge it says *by today's checks*: after the word on its page, and to a screen reader in Runs. A golden's checks count from when it was packed, or from a later change to them, which the dashboard keeps for this machine once it has seen them.

Both show the same card on hover: what judged the run, and each check with how it came out and what it found. Judging reads a run's calls beside the server, and what is judged is kept per version of the config. A list judges its rows within the calls it reads for their totals: a longer run's row keeps its own outcome until its page has judged it. A long run's page says nothing of its checks until then.

An [exported copy](./cli.md#export-html) holds each run's own verdict and a capture's from its import. It has no project, so no family's checks judge its runs.

### What a fork did differently

What a fork did differently is a finding in the bar, under **N findings** when another leads. From the call it left its parent at on, it lists what changed.

**Its decisions** come first: the tool calls it made that its parent didn't and the other way round, those it made with other arguments, and how each run ended and its last words. Each shows the call it was in, in either run. They are ranked as [`decisions`](./decisions.md) ranks a changed decision:

1. a write;
2. how the run ends;
3. a read added or removed;
4. a read asked differently;
5. other words.

**Its writes** follow, each with what became of it: *blocked*, *stubbed* or *ran live*. Up to three show one by one. More are grouped by tool and what became of them, each group from its first call (*send_email ×9 blocked, from #950*).

**Show each** lists the writes one by one, a hundred at most; Compare has the rest. Arguments and words are compared after the project's normalizers, so an id or a time made anew is no change. The first four changes show, **Show all** opens the rest, and **Compare →** opens the whole comparison.

An exported copy holds this list when the file holds the fork's parent too (`export html --lineage`, **Share → HTML report**), masked by the redaction rules. Otherwise it leaves it out.

### What Shadowlap did not record

What Shadowlap did not record is a finding in the bar, under **N findings** when another leads: a line each, the most pressing first.

1. **Unrecorded tools**: the tools the model called whose calls the run never recorded.
2. **No preload**: a run whose agent loaded no Shadowlap preload, so the network guard never watched it.
3. **An unguarded process**: a process of the agent the guard could not watch.
4. **WebSockets** that went to a provider live and are in no recording, and those an offline replay refused.
5. **A replay's extra reads**: the clock, random and pure reads it answered live because its recording held no counterpart for them, each opening its call.

**Unrecorded tools.** Each line gives the tool, how often it was called, from which model call (a click opens it), and what it does, as `tools.unrecorded` in `shadowlap.config.json` declares it or a built-in's or its name says. These tools ran in the agent unseen, and a replay runs them for real. So every command that replays the run refuses one that writes, or may (one whose effect nothing tells, *may write*), until it is recorded, declared a read, or allowed with `--allow-unrecorded`.

- **How to record them**: the line says how to have them recorded (a Claude Code built-in through the Claude Agent SDK's fence, an MCP server's tool through `shadowlap mcp`, anything else wrapped). It gives the config's lines that declare them, with **Copy**.
- **A refused replay**: a replay the CLI refuses for one, a fix's rerun among them (it passes no `--allow-unrecorded`), ends its drawer on why, *refused · an unrecorded tool may write · exit 2*, above the CLI's words on what to do.
- **A run that holds its model calls alone** (a capture, a trace): the line names the tools its replay runs live, refusing nothing.
- **An exported copy**, which replays nothing, leaves the unrecorded tools out.

**No preload** shows in red under `--guard block`, which failed the run for it, with what the command shows of why.

**An unguarded process**, such as the Claude Code CLI the Claude Agent SDK runs, shows in the run's own words, with what `shadowlap doctor` says to do (*unguarded*, red under `--guard block` too).

**Extra reads**: Calls tags an extra read *extra*, and its details say so.

### The origin strip

The strip has one cell per call. A recording's cells say what each call was, every other run's where its answer came from. The fork is flagged *fork* in ink, and the call blame named *lost* in red.

A recording's or a capture's cells are drawn by kind, after a word that says every call ran live:

| Kind | Drawn as |
| --- | --- |
| Model call | Off-white, as live |
| Read | Off-white at 40%: a read tool, a clock or random value, a person's input |
| Write | Teal |
| Error | Red: a model call answered with an error, or a tool that threw |

A call the fence answered after a fork is named by what it would have done, never by its error. Every other run's cells are drawn by origin, each in a color of its own:

| Origin | Drawn as |
| --- | --- |
| Replayed | The logo's second green, quieter than the lime of the page's next step |
| Live | Off-white |
| Overridden | Violet |
| Injected | Violet at half strength: a failure Shadowlap answered with instead of the provider, from [`--fail-at`](./interventions.md#inject-a-failure) |
| Failed | A red ring on its red tint, the tint alone where a cell is narrower than 6 px |
| Blocked | A grey hatch edged in grey, as Shadowlap fenced the write; a solid grey where a cell is narrower than 6 px |
| Stubbed | Steel blue |

Each color means one thing across the dashboard. Lime is the primary action and what passed, amber what needs a look or is inconclusive, and red what failed. Where you are, a link and a fork are drawn in ink.

- **Click a cell** to open that call. Its name says the call, its kind and its origin: *#18 issue_refund · write · live*.
- **From the keyboard**, the strip is one stop for Tab, a list whose ← and → open the call before or after at once, Home and End the first and the last. Where the strip groups its calls, the keys go a range at a time, each to the range's most notable call.
- **Where a cell would be narrower than 6 px** (24 px on a touch screen), each cell covers a range of calls, in the color of most of them. Hovering a range counts it.
- **A notch** marks a range's rarer notable call: an error, a write, or what a fork changed or fenced. So 13 errors in 1,200 calls read as 13 marks.

The strip's key is the call filter: *all*, then each kind or origin the run has, its swatch and its count (*all 30*, *model calls 14*, *writes 3*, *replayed 16*). Picking one shows only those calls in Calls, switching to it from another view, and dims the other cells. The pick is kept from run to run where the next run has it.

**Filter calls** (`/`) at the strip's end filters by text, and typing shows Calls too. Esc leaves the field with its words kept.

### Agents

A run of several agents gets a chip per agent, nested ones included, with counts. Picking one dims the strip outside it and narrows every view to it. A run of one agent and no scope shows no chips.

The dashboard names the agents itself, so a run needs no `scope()` to show them. Each conversation is one agent's, named by the first of these that applies:

- **Its scope**, in a run made with [`scope()`](./sdk.md#scopes): `researcher`.
- **An imported trace's agent span**, as [an import keeps it](./cli.md#traces): `supervisor/researcher`.
- **The tool that started it**: a model call asked for a tool, such as Claude Code's `Task` or an agent called as a tool, whose words open the conversation's first request. It is a sub-agent, named for what the tool started (`claude-code/Explore`).
- **Its system prompt**: the conversations sent one system prompt, its numbers aside, are one agent's. It is named for who the prompt says it is (*You are a research assistant* is `research-assistant`), else `agent-2`.

A handoff (`transfer_to_billing`) keeps the conversation and changes its agent: the calls after it are `billing`'s. The names are for reading only: replay matches calls by scope, never by them.

The line beside the chips gives the `shadowlap blame --scope` command for the scope picked. With none picked, it gives it for the one that acts: the scope that hands work to a nested one, or makes the most tool calls, not a model that plays its user. With one other scope that calls no tools, it says so (*Blame only the agent, not the customer it answers*). A run with no scopes has no such line.

### Views of the run

Beside the inspector, six views show the run, and `v` goes through them all:

| View                           | Shows                                                                 |
| ------------------------------ | --------------------------------------------------------------------- |
| [Calls](#calls-view)           | Every call with its kind, name, origin, tokens and time               |
| [Turns](#turns-view)           | Each model call, what it said, and the tool calls that followed it    |
| [Context](#context-view)       | Tokens per model call, split by the cache, and where the cache missed |
| [Timeline](#timeline-view)     | Every call on a clock, agent by agent                                 |
| [Forks](#forks-view)           | The run's family: its recording, and every replay and fork of it      |
| [Provenance](#provenance-view) | The run's record, its lineage, and what a copy would mask             |

How they sit depends on the window's width:

| Width | Calls and the inspector |
| --- | --- |
| From 1,281 px | Side by side, the strip on one row |
| 1,160 to 1,280 px | Side by side, the inspector at least 360 px, the key and the filter under the cells |
| 1,001 to 1,159 px | The inspector under the calls, the list fitted so its head shows |
| Up to 1,000 px | One column: the window scrolls, the cells stay at its top |

From 1,160 px the views keep at least 420 px, or 240 px from 1,281 px while a job's log is open. The page scrolls under its strip when the window is shorter. From 1,001 to 1,159 px the list is fitted so the inspector's head shows under it, between 240 px and half the window, and the page scrolls to the inspector. A call picked in the list below 1,160 px brings the inspector into view under the strip.

Every mark selects its call. The lists draw only the rows in view. So a run of 50,000 calls scrolls, steps with `j` and `k` and switches views as quickly as a short one. A run opened at a call (`#/run/<id>/600`) keeps that call in view while the rows above it are drawn and the rest of its calls come, until you scroll. While a long run is on its way, the page says *Loading the run…*.

### Calls view

Calls lists every call with its kind, name, origin, tokens and time. Each kind of call adds what matters about it:

| Call                                | Shows                                                                         |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| A model call                        | The tools it asked for                                                        |
| A model call that asked for no tool | What it answered, on a second line: the agent's final answer                  |
| A tool call                         | What it returned, on a second line, or that it was blocked, stubbed or failed |
| A clock or random call              | The value it gave                                                             |
| A person's answer the agent read    | Tagged *input* ([what a person types](./sdk.md#what-a-person-types))          |

A replayed call's time is its recorded duration, in grey, because the replay did not wait for it. A clock or random read records none, so its time is blank.

The strip's key and **Filter calls** filter the list. A filter lists what it matches flat. Each row has a fork button.

A call's origin shows in the strip's colors, with an injected or a failed call's swatch drawn as a ring. A tool call's effect shows beside its name: a write in teal.

Each call sits under the call it belongs to, the list still in the run's order:

- **A tool call** sits under the model call that asked for it.
- **Any other call** sits under the latest model call of its own agent and conversation.
- **A sub-agent's calls** sit under the model call whose tool started it: a subagent of Claude Code's `Task` tool, or a scope inside another, as `agent/policy-checker` in `agent`.
- **In a batch**, a run that works through several conversations of one agent, each conversation sits under its first call, named beside it (*conversation 3 of 40*). A sub-agent's conversations are never a batch's.

A call with calls under it has a fold mark that hides them and shows them again; folded, it says how many it holds.

- **←** folds the selected call's group, or goes to the call it sits under.
- **→** opens it, or goes to its first call.
- **`j` and `k`** step over what is folded.

The groups the selected call sits in never stay folded, so a link, the strip or `n` always shows its call.

### Turns view

Turns shows each model call with its tokens and stop reason, what it said, and the tool calls that followed it, grouped by agent.

### Context view

Context shows tokens per model call, as a chart or a table. Input is split into cache read, cache creation (what the call put in the prompt cache) and uncached, with output below. Past 360 model calls, a bar stands for a range of them, drawn at its largest context, and holds a miss when any call in it is one.

A call is flagged where the cache missed: it read less from the cache than the previous model call in the same scope and conversation sent in all, by 1,024 tokens or more. A miss sends the prompt again, and the prompt is cached again, so the calls after it read it from there.

What the misses tell you:

- **A fork's change** costs the call it forked at, and the note says only that call missed.
- **Every call after the first misses**: something early in the prompt changes on every call (a time, an id). It is the most expensive bug an agent has.
- **An agent that never caches its prompt** sends its history again on every turn. So every turn after the first is flagged, and the view says the cache was never read.

### Timeline view

Timeline shows every call on a clock, agent by agent, colored by origin, or on a recording by what each call was, in the strip's key, with the first token of streamed responses marked. It shows how long model calls and tools took, the longest call, and what ran at once.

### Forks view

Forks shows the run's family: its recording, and every replay and fork of it, with a line on what each did.

- **A test replay of a golden that may fork** says where it forked and what it did live (*test · forked at #3 · 25 live · ≈$0.018*). One that diverged where its golden may not says where it diverged.
- **An [error-path preset](./error-paths.md)'s attempt** that failed reads *preset failed*, and one that couldn't say reads *preset inconclusive*, each by the session that decided it.
- **The fork blame rescued a run with** stays a fork of its own.

Attempts are bundled:

| Attempts                       | Bundled                                                                          |
| ------------------------------ | -------------------------------------------------------------------------------- |
| One `replay --repeat`'s        | Together, with how many passed and how many were interrupted                     |
| A golden's in one test session | The same way (*test · refund-over-limit*)                                        |
| Blame's                        | Per probe, under the run they replayed; the probe blame named is marked *blamed* |
| Verify's                       | Per run, under each change it checked, named as the fix's Verify step names it   |

- **Interrupted attempts** show in grey: an attempt stopped before it ended neither passed nor failed.
- **A golden with a gate** says what the gate made of its attempts, as Tests does, with its verdict, tally and bound, and its rule once under them.
- **A verified run** has an icon saying how it came out. A verdict that doesn't count for the fix says so, *doesn't count*, with a plain icon.
- **Under a run several fixes share**, such as a good run every repair kept, each bundle names its fix.

Each bundle says its verdict as a gate's is said: the word, the tally and the bound (*rescued · 2 of 2 · rate >= 0.15 (95%)*). A good run verify kept against its own baseline shows both tallies and the bound on its drop (*kept · 38 of 38, baseline 38 of 38 · drop <= 0.10 (95%)*, under the baseline's rule). Then comes what its attempts spent. A verify's bundle then names the change it checked and how that came out (*fixed · 12 of 12 · rate >= 0.73 (95%) · ≈$0.046 · repair candidate 3 · accepted*).

Each rule they were decided by is stated once in the family. Each bundle opens its fix at that step, a verify at its verdict.

### Provenance view

Provenance is the run's record. It shows:

- **The run**: its about line whole, with where it comes from; its command and revision; times, in local time as every page says them (the instant in UTC on hover); models as recorded; the provider; upstream requests; and origins.
- **The host** that calls made to a host of another's format went through: `openai via openrouter.ai` (a host the config declares), Claude on Microsoft Foundry, OpenAI's API on Amazon Bedrock.
- **The guard** the agent ran under, with the processes whose preload loaded, by runtime (*block · loaded in 2 Node processes*), or that none did. The Claude Code CLI shows as unwatched.
- **Its lineage**, with how each run stands (what a failed one failed, in red; an interrupted one in grey) and its revision.
- **What a copy made at this point applies**, and what it would mask.
- **Each call's fingerprint and blobs.**
- **Its labels and notes.**

**Copy show --json** copies what `shadowlap show <run> --json` prints.

What a copy would mask is counted as Settings → Redaction's preview counts it for a pack: each value once, however many requests send it again. It is counted apart from the dashboard's own work.

- **A path rule on what calls got back**: only `export html` and `dataset` mask there (a pack keeps it for its replay), and Provenance gives their count too.
- **Values a pack leaves as they are**: when the rules also match them (numbers, which a pattern never rewrites), it says how many stay as they are.
- **A slow rule**: when a rule takes too long on the run's text, it says the values weren't counted, with why on hover.
- **Busy previews**: while Settings → Redaction's previews hold every thread it uses, it says they are being counted, and asks again until they are.

### The inspector

The inspector shows the selected call, in four tabs:

| Tab          | Shows                                                                                                |
| ------------ | ---------------------------------------------------------------------------------------------------- |
| Conversation | The conversation exactly as the model saw it at this call, with tool calls and thinking blocks shown |
| Response     | The response as text and tool calls; for a tool call, the recorded result or error                   |
| Request      | The stored request (or tool arguments) as a collapsible tree                                         |
| Details      | Origin, outcome, model, usage, cost and timing, fingerprint, response headers and notes              |

**Conversation** works the same for Anthropic, OpenAI (Chat Completions and Responses) and Gemini requests.

- **Format JSON** lays out tool results that are JSON.
- **Jump to change**, on a fork, opens the message the fork changed, which says *changed in this fork · first sent at #17*.
- **A call that never got an answer** says why in a sentence over it: **Never sent.** for one answered with `--fail-at`, **Refused.** for a request an offline replay didn't have, **Failed.** and what the provider answered for one that failed.
- **A tool call** shows *Its arguments, then its result:*, then the model call of its own conversation that asked for it (in a batch of many conversations, which one), with **Show its conversation**.

**Response**: **Play** replays a streamed response at its recorded pacing (1×, 2×, 4× or instant). *Raw* shows the stream as recorded.

**Details** lists origin, outcome and HTTP status, provider and the host it went through, model, whether it was an extra read, stop reason, token usage by cache tier, cost, latency and first token, size, retries, fingerprint and occurrence, response headers, and notes. It names the call's scope and agent too, and for a sub-agent's call, the call that started it.

On a failed model call, the input tokens are what its request held, `in the request; nothing was sent` where Shadowlap answered it or the replay refused it, and then its cost is `$0`. Its latency says who answered: `answered by Shadowlap`, `refused by the replay` or `answered by the provider`.

### Edit and fork

**Edit and fork…**, under the call's name on every tab, opens a tool's result or what a person answered to edit, as JSON or as text, and forks with it. It is the fork menu's own `--override`, with every call before it replayed.

- **Checked as untrusted data**: what you edit goes to the dashboard as an upload, and is checked before the dashboard builds the command. It must be UTF-8 text: for a tool's result, JSON of at most 2 MB; for a person's answer, at most 65,536 characters.
- **A long result**: one too long to keep on the fork's record goes to the CLI as that file.
- **A model call's answer** can't be edited: `--override` changes a tool's result or what a person answered, nothing else.

### Labels and notes

Label a run with **Add label** in its header (`bug`, `good`, `refund-flow`), or several from Runs. Both offer the labels runs carry as you type, most used first. A label's **×** takes it off at once, with **Undo** in its toast, and the focus moves to **Add label**. Leave notes on a call with **Add note** in its details.

The **good/bad key** labels a run `good` or `bad` in one press:

- two buttons beside a run's labels, and at the end of each row of Runs;
- `+` and `-` on a run's page, and on the row of Runs that has the focus;
- in Search or jump to.

What the two labels mean:

- **`good`** marks a run a fix must not make worse than its own baseline. Run repair takes a fix's good runs from the runs labelled `good`, as `repair --keeps label:good` does, and keeps a change only if each is kept against its baseline.
- **`bad`** names a run that went wrong, for `repair --fixes label:bad`.

A run is never both: marking it good takes bad off, and a press of the label it has takes it off. Each press says what it did in a toast with **Undo**, and ⌘Z (Ctrl Z), or `u` while single keys are on, does the same from anywhere but a field being typed in while the toast shows. Either puts the labels back as they were, and hands the focus back to the key. The toast's words are said in a live region that is always on the page, so a screen reader hears them.

On Runs, the key's column is headed *good · bad*, each word listing the runs labelled so. The filter takes `label:good` for the runs with that label exactly, as the CLI does (a word matches anywhere). A label's chip on Runs lists its runs too.

### What a run's page is worked out from

Besides each call as recorded, the run's endpoint (`/api/runs/<id>`, which the page and an [exported copy](./cli.md#export-html) read) works out the following for the run.

**Conversations.** A run can hold many: an overnight batch works through forty tickets in one process, and a multi-agent run has one per agent.

- **Continuing a conversation**: a model request continues a conversation when it extends that conversation's latest request in the same [scope](./sdk.md). The messages sent last time (Gemini's contents, the Responses API's input items) come first again, with the answer and what followed it appended.
- **What doesn't count**: cache breakpoints, thinking blocks and thought signatures that an agent moves or drops between requests, and a system message that only carries the time.
- **An agent that edits its history** still continues its conversation. One that drops its oldest turns is matched by the tool-use ids it still carries. One that strips a reminder from an earlier message, or completes a prefilled answer, is matched by the last answer it carries right after the history it kept.
- **Starting a conversation**: a request that continues no conversation starts one of its own. So does one that repeats another conversation's request word for word, unless that request failed and this is its retry.
- **A tool call** belongs to the conversation of the model call that asked for it, matched by name and arguments in its scope, with the tool-use id the provider gave.
- **A call no model asked for** goes with the tool that was running when it started (the HTTP request a tool sends). Else it goes with the model call whose tools have not all run yet, else with the next model call (the ticket fetched before it).

A call's *Conversation* is its own conversation as it stood at that call, never another ticket's or another agent's.

**Where the prompt cache stopped hitting.** A model call misses when its cache read is smaller than the previous model call's whole input (uncached, cache creation and cache read) in the same scope and conversation, by at least 1,024 tokens. The tokens sent again are the difference.

- A conversation's first call is never a miss, so a batch doesn't flag the start of every ticket.
- Every call whose cache read is known is judged: Anthropic and OpenAI report it, zero included, and Gemini leaves it out when it read nothing. So an agent that never asks to cache shows each turn's history as sent again.
- A server that reports no cache at all (a local model behind an OpenAI-compatible API) shows no misses.
- The share of input read from the cache counts live model calls.

**Time not waited.** A replayed call is answered from the recording at once. The time it saved is how long the recording waited for it, found on the run it was replayed from, or further back for a replay of a replay. Each replayed call carries it, and the run sums it.

**What was not recorded.** These ran for real, and a replay runs them again:

- the hosts the [network guard](./how-it-works.md#the-network-guard) saw the agent reach without Shadowlap;
- the tools `shadowlap init` finds in the project without a declared effect that the recording never saw;
- the tools the model called, by its own answers, that the run recorded no call of ([`unrecordedTools`](./cli.md#replay), read beside the server);
- the WebSockets the run keeps, gone to a provider live or refused.

**The fork and what made it.** The call a replay forked at, and the flags it ran with, as the replay kept them on the run: `--fail-at 19=529`, `--override 16=@policy.json`, `--inject 15=Prefer sources from 2026.`, `--model 15:claude-opus-5`, `--set 15:max_tokens=2048`, `--inject-result`, `--prompt-from`, `--diverge-at`, `--live-tool`, `--writes stub`.

- **A short form** shows each: an override read from a file is named by the file, one given inline shows the result its call recorded, and a long instruction is shortened.
- **Each flag exactly** is kept on the run too, so the fork menu can make the fork again. A copy of the run (`pack`, `export html`) keeps only the short form, masked by the redaction rules.
- **A replay made before Shadowlap kept its flags** shows the ones its calls reveal.

**Blame and checks.** A blamed run names where blame found it lost, as Runs, the Overview, Fixes and the activity feed say it too:

- **One call**: the model call that lost it, counted among the model calls of the blame's scope ("model call 5 of 6").
- **Lost gradually**: when blame pinned no one call, the two it was lost gradually around ("lost gradually around #5 and #7", "model calls 3 and 4 of 6").
- **Lost between**: when the probes between them could not decide, the two it was lost between ("lost between #7 and #9", "from model call 3 of 6").

The fork that blame rescued says it was rescued. Each [outcome check](./ci.md#outcome-checks) is counted over the attempts it ran in: "issue_refund never called · 5 of 5".

**Each call's own record.** Its fingerprint, the hashes of its stored request and response, and for a tool call its result in one line ("stubbed …", "blocked").

**The models.** Each model the run's calls named, as every view of the page names it: the id without a date stamp (`claude-opus-5`). Provenance shows a dated id the provider answered with on hover.

A run imported from someone else's pack carries what they recorded about it. Anything malformed there is left out rather than shown.

## Changes

Changes shows what a change does to your agent, on its own recorded runs. It has two tabs, each one word with the command it matches on hover: **Verdicts** lists every change checked, and **Compare** puts two runs side by side.

The sidebar, `g` then `c` and [Search or jump to](#search-or-jump-to) reopen the tab last shown in the project, Compare on the pair it showed. The first time, and after a reload, they open Verdicts. The crumb *Changes* always opens Verdicts.

### Verdicts

Verdicts lists every change checked, newest first, one row each. A change is one of three kinds:

- **A test session** that ran every golden at a revision. Its row opens [the revision's page](#a-revisions-page).
- **A preview or a migration**: what a change of model, prompt or tools decides differently.
- **A verify a fix keeps.** Its row opens the fix's Verify step at that verify.

Each row gives the change and how it was checked (*test session · d2e8a1f*), what it was checked on (*7 goldens*), what moved and when. Its verdict is in the words of the command that gave it: *passed*, *failed*, *inconclusive*, *accepted*, *rejected*, *not verified* or *nothing to verify*, with its tally under it. On a phone the verdict sits under the change.

The newest revision a test session ran every golden at leads the page: its verdict, its tally and **Open the change**, in lime while it failed or couldn't decide. The chips (*All*, *Test sessions*, *Previews*, *Verifies*) each count their rows. **Show more** reads 50 more at a time, up to 200, and says when older changes aren't listed.

The page keeps its chip, and how far it read, while it stays open, so the way back from a revision's page lands on its row. Who made a change shows only with a [team store](#the-team-stores-setup). Without one, Verdicts lists this machine's test sessions only, and says so, with a link to the store's settings.

### A revision's page

A test session's row opens its revision's page (`#/changes/verdicts/<revision>`). It gives that session's verdict and tally, the change, who made it and when, with **Open Tests**. On the newest revision, Open Tests is lime while it failed or couldn't decide. Under them:

- **Goldens**, worst first, as that session judged them, each with its note (*4/4 replayed*). A golden opens the replay that judged it while the store holds it, else Tests.
- **Decisions**: the previews and migrations asked at that revision.
- **The command** that gave the verdict.

A revision no session ran every golden at says *No change d2e8a1f.*, with **Open Verdicts**.

### Compare

Compare puts any two runs side by side. Pick them on the row under the tabs, from lists of runs each by its id and its about line.

#### What changed

Compare starts with what changed between the two runs:

- **The code**: the two revisions, and from the project's git the commits between them, with the newest one's subject (all of them on hover). It reads *uncommitted changes* when only the working tree differed, and *on separate branches* when neither follows the other.
- **The system prompt**: an unchanged one is named by its hash.
- **The tools**, added and removed.
- **The model.**

Two runs of one commit whose revisions git abbreviated with different lengths read as unchanged code.

#### Where the runs part

Then it shows where the runs part, in order:

1. **The identical prefix.**
2. **What made the fork**, as `shadowlap diff` says it, when one run is the other's replay and its flag changed an answer rather than a request. It shows what each run got: *#19 got HTTP 529 instead of an answer*, *#16 lookup_policy returned … instead of …*, a planted instruction, a person's other answer.
3. **The first request that differs.** Each field that differs is named by what it is in the request, such as `tool_result lookup_policy`, the system prompt or a tool's definition, with its path on hover.
4. **Each run's calls from there.** A call the other run also made at the same place is dimmed: the same tool with the same arguments, or a model call that asked for the same tools.
5. **Calls where the same request got a different answer.** For a model call, it shows what it answered each time (`"Issuing the refund.", issue_refund(…) → "Above the limit.", escalate(…)`).

A call the model answered the same way in another response is counted in the line above instead (`6 calls got the same answer in new responses`). This is the case, for example, in two live runs of one agent where only the response's id or token counts differ.

Each side's calls are headed by its kind (*fork @7*), failed or not.

#### Two long runs

Two long runs take seconds to compare whole, since every model call's request of both is read. Meanwhile:

- **The identical prefix and the first request that differs** come at once and show, unless the runs were fingerprinted under other normalizers, with no replay between them.
- **The page says what is still being compared.**
- **When the rest takes longer** than a request is given (two minutes per 50,000 calls of the pair, at least two), what came first stays, with the `shadowlap diff` command that compares the two in a terminal, with no time limit.

A run still recording is compared again as its calls arrive.

#### Open a comparison

- **`#/compare`** alone opens the newest fork or replay against its parent. With fewer than two runs, it says how to make a second.
- **Compare's tab** reopens the pair it last showed in the project. Once a run of that pair is gone, it opens as `#/compare` alone does.
- **`#/compare/<run>`** opens that run against its newest fork, else its newest replay (a test's last), else its parent. A run with none says there is nothing to compare yet, with the replay that makes something.
- **A fork or a replay** has *Compare with parent*. A recording compares with its first fork or replay, never an attempt bundled under it (a blame probe, a verify or `--repeat` attempt).
- **Two runs ticked on Runs**, and the palette, open it too.

When a side can't be compared, Compare says so:

- **The same run on both sides** says so, rather than compare it with itself.
- **A run the store doesn't hold** is named, and so is an id that starts several runs' ids (*01M5GRV matches several runs; use more of the id*), with the side to pick again.

#### Compare in an exported copy

An exported copy compares the runs it holds: every pair up to six runs, and beyond that each run with the first. It opens on the first against the newest other, and the pickers offer only those. There Compare is a page of its own, under its own head, with no tabs.

## Fixes

Fixes follows each failure from where it was lost to a fix that held.

### The list of fixes

Fixes is a to-do list. The failing runs nobody has blamed come first, as one row with **Run blame** for the newest of them. Then each fix: open ones, then those ready to apply, then those applied. Among the open ones, a fix not blamed, or whose blame couldn't settle, comes before one blamed, and that before one changed.

Each fix's row shows:

- **Its status**, one word on the ladder: *open*, *blamed*, *verified*, *applied* or *merged · PR #138*. An applied fix that doesn't hold says *broken*, and why.
- **Its title and label**, and *from CI* for a fix CI opened, its card saying how its pull request stands.
- **How many runs failed**, a link to Runs under Failed, and the day it was opened.
- **What they did and the check they must meet**, on two lines (*Failed: send_email called twice, not once*, then *Must: send_email called once*).
- **How far blame, repair and verify got**, a column each. A step that ran and needs a look is amber: a blame no call rescued (*not rescued*), one whose first probe couldn't tell (*inconclusive*) or that stopped part way (*stopped*), or a verify left *inconclusive*.
- **What repair and verify came to.** Repair's result is a change (*prompt change*, *tool change*), *by hand* when verify checked a change no repair made, or *no change yet*. A verdict that passed is lime (*2 fixed · 1 kept*), one rejected red.
- **Its next step**, the button its page leads with, which runs or asks from the row as it does there. A fix with none reads *Open →*.

While a job of the fix runs, its step says so (*blaming…*, *repairing…*, *verifying…*), and a step that needs the working tree waits, saying why. The failing-runs count is the fix's own.

All, Open, Ready to apply and Applied filter them. A merged fix is under Applied. A fix whose patch is in your working tree already is under Ready to apply, with Mark applied, though the Overview's figure leaves it out.

- **The pull request** is read from GitHub with `gh pr view` in the background while the page is open, when `gh` is installed and signed in, as [`fix pr`](./cli.md#fix) does. It is read only for pull requests on github.com, the host `GH_HOST` names or the host of the project's `origin` remote, since a fix pulled from the team store can name any address. A read-only dashboard asks no one.
- **What they did** is the title blame gave the fix when it opened it, so the row names it only once someone renames the fix.

### A fix's page

A fix's page names what failed and its check as the list does, its failing and good runs, and when it was opened and verified. It opens on its last finished step: Blame, Repair or Verify. What you can do from it is under [Actions on a fix](#actions-on-a-fix).

### Blame step

The Blame step shows:

- **Where the run was lost**, on its row of calls, with each probe marked.
- **The recorded answer** at that call next to the rescued fork's, and the training pairs they make.
- **The probes**, each row opening the run at its call.
- **Every attempt**, bundled per probe and grouped by what each did: the tool calls it made from the probed call on, and how it came out. A call that didn't plainly run is marked, as *issue_refund (blocked)*.
- **What finding out cost**, with the command.

Each group of attempts shows how many took that path, why the first of a failing group failed, and one of them to open.

Where blame's report says more than its probes, so does the step:

- a probe's attempts the provider left unavailable, never tallied;
- the method behind a probe's bound, on hover;
- the calls it lost the run between, when no one call is pinned (*lost between #3 and #5*);
- the two it was lost gradually around, when the check of the call the probes pinned found no drop there (*lost gradually around #5 and #6*);
- the error bound its confidence comes from, as `shadowlap blame` prints it (*<= 3% risk that the call is wrong: 3 probes decided, at <= 1% risk each*), and not for a blame whose passing attempts answered the call as the recording did.

Needs a look, the activity feed and the Fixes list say *lost gradually around #5 and #6* the same way, never that #5 lost it.

A blame that rescued the run from no call shows the check and how the recording failed it, instead of the answers. It says why when it knows no answer of the model's lost the run: every attempt met the error a write got when it was recorded, or the attempts that passed answered as the recording did ([blame](./blame.md#the-rescue)).

### Repair step

The Repair step shows:

- **The change**: its file, the part of the prompt or tool description it rewrites, the text it adds, and how each role held under it.
- **Why the failing runs were lost**, and the repairer's diagnosis.
- **Every candidate tried**, with why each was dropped.
- **The files handed over**: `fix.patch`, `report.md`, `report.json`, `goldens/`.
- **The pull request body.**

A repair that accepted nothing leaves the fix open, with the candidates it tried and why.

Its header says when it ran (*Accepted*, or *Ran* for one that accepted nothing) and who proposed the candidates. When no repairer did, it says why, with what to do (*the repairer could not be asked: claude was not found: install Claude Code, or set SHADOWLAP_CLAUDE to its path*). The stepper says it in a few words; *no repairer needed* is only for a fix that needed no model.

A grey line above its command gives how many attempts it ran and what every stage cost: blame, the repairer and the verification of every candidate it tried. The cost reads as the CLI prints it (*87 attempts · cost: blame ≈$0.054 · repairer ≈$0.0085 · verify ≈$0.239*).

A repair that came with a pull from the [team store](./team.md) says it ran on a teammate's machine, whose `goldens/` stay there to be committed from it.

### Verify step

The Verify step shows one change verified at a time, each at a link of its own, named by what changed:

- a repair's candidate;
- the request fields a `--set` or `--model` change set, and from which call (*temperature=1 from each run's first model call · at 35034be*);
- or the code version.

It opens on the newest verdict that counts for the fix. A verdict is headed by the runs it checked:

- *Every failing run fixed, every good run kept*, only when it checked every failing run of the fix;
- else what it did role by role (*Fixes 1 of 1 target run, keeps 1 of 1 good*).

One that doesn't count for the fix is drawn plain and headed with why (*Doesn't count for this fix: its check leaves out send_email called 1 time*). It is marked so in the switch.

**A verdict that didn't settle every run** reads *inconclusive*, in amber, as it does on every page; verify's own word for it, *incomplete*, stays in its report. It leads with what settles it, the fix's header plain meanwhile:

- **Run more attempts**, for a run its gate couldn't settle in its attempts, or that the verify stopped before it settled.
- **Verify again**, for one stopped by an attempt that couldn't be judged.

Run more attempts verifies its runs again from the start, named in their roles, since verify has no `--continue`. It doubles the limit where a gate ran out of attempts, and runs without the budget that stopped it.

Both are built from the verdict's report and the flags kept beside it, never from its command line:

- A verdict kept before its flags were kept beside it offers neither.
- One a pull brought from the [team store](./team.md) asks first, showing the exact command. It runs without a teammate's `--build`, `--base` and command after `--`, and spends at most twice what Shadowlap runs by itself: a gate up to 160 attempts a run, a fixed count up to 10.

A line under the verdict says which run is open and why, and what settling it takes (*about 12 attempts, ≈$0.045*), at the run's pass rate so far and the verdict's spend per attempt.

Then come:

- **Its oracle.**
- **Each run's role, attempts, outcome and where it went**, and, when the verdict says them, the run's baseline (paired at the base revision or from history) and the bound on its drop from it. The bound reads as the CLI says it, *drop <= 0.10 (95%)*, the margin on hover.
- **Each run's attempts the provider left unavailable**, and the method behind its bound on hover.
- **Each run's attempts grouped by what each did**, as on the Blame step.
- **What the change does to input tokens and cost per run**, in one quiet line as verify prints it.
- **What finding out cost**; for an inconclusive verdict, only what it spent.

The stepper counts the runs the verdicts that hold fixed and kept (*3 fixed · 1 kept*). A fix verified with a change of request fields has no patch: **Mark applied** says which fields, for you to set in your agent, and so does `fix apply`'s drawer.

## Tests

Tests lists every [golden](./ci.md) on disk, the packs in `goldens/` and those the config's `tests` name, and how each did. What its buttons run is under [Actions on Tests](#actions-on-tests).

Its header names the project's goldens, with **Open CI settings** and **Run tests**. **Update goldens** joins them when more than one golden diverged, as each failure has its own **Update golden**.

With no golden yet, it offers to pack the newest run whose step is **Pack as golden…**: a lime button naming the run opens the run page's dialog, with the command under it. With no run at all it offers no command, as recording one comes first.

### The verdict

A verdict leads, in one line: its word in its colour, *passed*, *failed* or *inconclusive*, then the tally of goldens that passed and the first failure named, as *2 of 3 goldens passed · refund-in-limit diverged at call 1*. With none failing, it is *inconclusive*, in amber, when a [gate](./gating.md) ran out of attempts between its bounds or a check couldn't decide.

The first failure's step is lime beside it: the button its run's page leads with, such as **Add normalizer and re-run** or **Run more attempts**. **Run tests** and each failure's buttons are plain while it leads.

**Checks changed since.** A failure that stands on checks the config no longer holds, removed or changed, says so in the reason: *2 of 3 goldens passed · refund-flow failed its check, its checks changed since*. Its step is **Run tests**, as the session judges the checks as they stand. So the verdict offers no button, and the header's **Run tests** is lime, its hover saying why.

**Edit check…** leads, lime, where a golden's own recording fails a check added since its previous test. It opens the [check builder](#making-a-check) at that check: either the check is wrong, or the golden needs an update because the agent should do this. On a [read-only](#read-only-mode) dashboard it stays, off, saying why.

With it comes the line of the newest session that ran them all (CI's, or **Run tests**): its command, revision, time, its own passed and failed counts, and upstream requests. That session reads:

- *running* while its process is there, started from this dashboard, another one or a terminal;
- *interrupted* when a signal stopped it;
- *did not finish* when its process was killed.

Goldens run again on their own since (by **Add normalizer and re-run**, say) follow it, as *since: refund-in-limit passed*, each with its result on hover.

**Following a session.** While a session runs every golden, the verdict reads *running 3 of 7 goldens*, with no step, and its line gives its counts *so far*. Each row says where it has got: the result it kept, *running* for the golden it records and one between its turns (*in progress*), or *queued*. A session that runs some goldens moves only their rows.

**Older than your working tree**, in amber, follows the session's time when the tree changed since it ran: a tracked file changed, by a normalizer added or a fix applied, say, or a later commit. A session that tested changes on top, or one still running, never says so.

### A row per golden

Then comes a row per golden. A row opens the golden's latest run.

| Column      | Shows                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------- |
| Golden      | Its name with its mode under it, and where it came from                                            |
| Checks      | Each check, marked by how its last result came out on it                                           |
| By revision | Its result at each recent revision of a session that ran them all                                  |
| Last result | *passed*, *updated at `<rev>`* after an update, or a gate's verdict, then how its presets came out |

**The mode** is `replay`, `fork ×5`, or `fork · gate` and `fork · history` for a golden with a gate, with what it means on hover.

**Check marks** say how each check's last result came out:

| Mark    | Means                            |
| ------- | -------------------------------- |
| ✓       | Passed                           |
| ✗       | Failed, with what it found       |
| ?       | Inconclusive, in amber, with why |
| –       | Not applicable                   |
| No mark | Not tested yet                   |

Each check reads as `shadowlap test` labels it, such as `escalate called 1 time` or `at most 29000 input tokens`.

- **✓** on a judge check says where its verdict came from, in the CLI's words: *judged from the recording · free*, *judged live · <$0.001*, or *judged live · no price for* its model. Its hover says what the judge asks, what it answered and its model. In the Checks column, where the verdict came from moves onto that hover.
- **✗** on a golden run more than once also says how many attempts passed it, unless some were carried over from an earlier session.
- **–** on a `when` rule whose condition never held reads *not applicable · the condition never held*, in grey, with what the calls had instead on hover.
- **No mark** shows before the golden's first result, or when its last test couldn't run it.
- **A check added since** has no mark either, as the golden's next test judges it. It reads `added since its last test · not tested yet`, or `added just now · not tested yet` within a minute of the check builder adding it.

**Changing a check.** Each check ends with **Edit** and **Remove**, and the last one with **Add check…**, shown on the row's hover or focus. On a touch screen, or with 840px of room or less, one line under the checks offers **Edit checks…** and **Add check…** instead. What each writes is under [Actions on Tests](#actions-on-tests).

**By revision** draws each result in its colour: a dot for one attempt, or a bar filled to the share that passed for several. An ink ring marks where the golden was updated, and a red one a drop against its own history. Each cell is named by its card's words, which say on hover why it failed. A key under the table says what each shape means.

Each revision's header gives its commit's subject on hover, and its author where names show. A golden run again on its own shows in the column of its commit, with changes on top named on hover, and adds no column of its own.

**Last result** for a golden with a [gate](./gating.md) is its verdict, then its tally and bound; against history, with its baseline. The pass rate's interval is drawn against the gate's two rates or its baseline. Each gate's rule is stated once under the table, beside its goldens' mode, and where two rules share a mode, with the goldens each decided.

**A gated golden's evidence.** Its interval bar opens a row under it: why the gate stopped, the score line between its bounds, each attempt, and what a pass and a failure each weigh. A gate that ran out of attempts offers **Run more attempts** there, or **Run tests** where its checks changed since. **Esc** closes the row and puts the focus back on the bar.

Under the last result comes how the golden's [error-path presets](./error-paths.md) came out, opening the attempt that failed. A golden whose presets ran but whose replay hasn't yet says so, never *not run yet*.

**Checks changed since.** A last result that failed or couldn't decide checks the config no longer holds reads *checks changed since · not tested yet* under it, with the checks gone on hover. The result stays the golden's last test's, and its step is **Run tests**.

The table fits its panel at every width. With less room the oldest revisions give way, then, at 840px or less, the checks move under the golden's name. On a phone the revisions become a strip there too, while the last result keeps its width.

### Failures

Each failure follows as the CLI prints it. A divergence offers:

- **Add normalizer and re-run**, which leads when a value made anew on every run is all that changed. It becomes **Re-run test** once the rule is in the config.
- **Update golden.**
- **Find breaking commit**, whose answer then shows above the buttons while the golden keeps failing as it did when the search started.

Find breaking commit's answer is the first bad commit, or why there is none between the commits it searched, with **Find breaking commit…** to search from an older one.

- **An answer given while the golden passed**, or about an earlier failure, never shows over a later one.
- **A golden passing at the commit it fails at**: when the search found that, the failure is in changes not committed there, or doesn't happen every time. It says so, and offers no other commit until it fails at another one.

A failed check, a non-zero exit or a replay with no calls shows with its checks and the agent's last lines of output, as `test --markdown` prints them. It offers **Find breaking commit…** unless the pack can't be read.

### Inconclusive goldens

An inconclusive golden follows too:

- **A [gate](./gating.md) that ran out of attempts** offers **Run more attempts**.
- **A [judge check](./judges.md#not-judged) with no verdict its replay could use** offers **Update golden**, as below.
- **A golden marked `fork`**, whose judges are asked live, names the key the judge's provider lacked.

Such a judge check's pack holds no verdict its replay can use: none, one given to an older form of the judge's request, or one given on other material. A test that replays offline can't ask the judge. **Update golden** asks first, then runs `shadowlap test <golden> --update`: the judge is asked once, live, with the key in the dashboard's environment, and its verdict kept in the pack. Nothing is re-recorded.

For a verdict given on other material, it says first that a value that changes every run needs a [normalizer](./normalizers-and-redaction.md#normalizers) before the update, or the next test reads not judged again.

### The network guard in a test

**A blocked connection.** A connection the [network guard](./how-it-works.md#the-network-guard) blocked in a replay is named on the golden's row, in its history and in its report: the agent went to a host directly, past Shadowlap, which a test refuses. It is named also when the agent caught the refusal and the golden passed.

**No preload.** A golden whose replay no Shadowlap preload loaded in fails under `--guard block` as *no preload loaded: the network guard never watched it*. It shows what the command shows of why, and what to do: run the agent on Node or Python with the environment `shadowlap` gives it, or test with `--guard warn`.

**Unguarded.** A golden that a process the guard can't watch ran in, such as the Claude Code CLI the Claude Agent SDK runs, fails as *unguarded: a process the network guard can’t watch ran*. It shows what `shadowlap doctor` says to do: reach a remote MCP server through `shadowlap mcp`, which records and fences its calls, and test with `--guard warn` to accept the rest.

### In CI

**In CI** says how CI runs the goldens:

- **A replay golden** runs offline, needing no key.
- **A golden marked `fork`** runs live from where it forks, needing the providers' keys, as an [injection test](./injection.md) does from each payload it plants, when a golden has one.
- **What fails a golden**: a divergence, a non-zero exit, no calls, or a check, gate or injection test that fails or can't decide. A gate against history with fewer than 30 sessions only warns when it runs out of attempts, until the plan reads a decline or a drop.

It shows the one command, `shadowlap test 'goldens/*' --junit report.xml --markdown "$GITHUB_STEP_SUMMARY" --annotations`, in its box with **Copy**, and how many goldens run live. When a golden has a gate against history, it says that CI has to keep the store between runs. On GitHub, **Settings → CI** builds the whole workflow.

**Add a golden**, beside it, gives the pack command in its box. A golden whose checks say what the agent must do is also a task a model can be scored on, under **Training tasks**.

Recordings that pytest and Vitest keep in `__recordings__/` run under their own test runner and are not listed.

## Training

Training shows:

- **The preference pairs** blame, verify and `--repeat` left in the store, grouped per call: the answer that lost the run beside the ones that went on to pass, where each came from, and how sure it is.
- **The goldens as tasks**: where a model takes over, what scores it, and whether it can be scored.
- **Each scored model's mean**, with a pip per attempt that opens its run.

**Export pairs…** and **Score model…** run [`export pairs` and `tasks score`](./training.md#in-the-dashboard) as jobs.

- **Score model…** offers only the models that can answer a ready task, and names the ones it leaves out, with why. A recording on Bedrock, Vertex AI, Azure OpenAI or the Gemini API is translated for another provider's model.
- **Score model… is off** while a repair or an applied patch changes the working tree.
- **Its card** says what an attempt of the model its dialog starts on costs. The dialog's Cost line is what the picks cost together (`20 attempts on the Anthropic API`), and the drawer says that total.

A task whose test forks before its takeover opens that test's run where it forked. It offers **Update golden**, which adds the normalizer a value that changes every run needs, and runs `test --update` on the golden. When the normalizer is the whole fix, it tests the golden again instead. If that test runs live (the golden is marked `fork`, or has an injection gate), the card and the dialog say what it bills, and the dialog's button is your yes. Without an estimate, the server's question shows in that dialog before anything runs.

## Settings

Settings (`#/settings/<tab>`) is the one page a project with no runs opens too. It has a tab for each part of the project's setup:

| Tab | What it holds |
| --- | --- |
| [Matching](#matching) | The normalizers, the clock, and **Calibrate** |
| [Redaction](#redaction) | The redaction rules, where each copy applies them, and what they would mask in a run |
| [CI](#ci) | Your CI workflow, built from its switches |
| [Coding agents](#coding-agents) | Which instruction files mention Shadowlap, and the skills |
| [Tools](#tools) | Every tool the recordings called, and the MCP servers |
| [Project](#project) | The project's store, runs, size and address |
| [Store](#store) | The [team store](./team.md) |

How Settings writes the config, and what its buttons run, is under [Actions in Settings](#actions-in-settings).

### Matching

*Matching* holds:

- **The normalizers**, with **Add normalizer…** and **Remove**. **Add normalizer…** takes a scope, a path, a named pattern, or under Advanced a regex, a tool or call name, or the whole value.
- **The clock.**
- **Calibrate**, which names the run it replays: the setup's, else the newest recording made here.

A regex the [pattern check](./normalizers-and-redaction.md#patterns-that-could-take-too-long) refuses, as `(a+)+`, which can take minutes on some text, is named with why before it is added.

### Redaction

*Redaction* holds the rules, where each kind of copy applies them, and what they would mask in a run you pick. The [picker](#menus-pickers-and-dialogs) starts on the newest recording made here, and names each run by its id and its about line, as Compare's do.

What the rules would mask is counted per rule, path rules included, with up to two samples before and after, exactly as a pack masks them. A long run is read up to 2,000 calls, 64 MB or 5 seconds, and the page says how far it got; `shadowlap redact preview` reads it all.

Under a rule come quiet lines:

- **A path rule on what calls got back**: how many values HTML, HAR and dataset copies mask there, which a pack keeps for its replay, with them on hover.
- **Values a pack leaves as they are**: how many, with the values and where they are on hover. These are numbers: a copy masks a JSON document's strings and keeps its numbers as recorded.

For values a pack leaves as they are, the lines then give:

- the path of the first place's path rule, with the command that adds it behind **Copy**: one for a request masks them in every copy, and one for what a call got back only in HTML, HAR and dataset copies;
- how many other places have one (`shadowlap redact preview` lists them);
- the rule that already masks them in those copies, or why none can: a clock or random read, which a replay needs as recorded, a stream's events, the top of a request, or a key no path can name.

### CI

*CI* (`#/settings/alerts`) builds [your workflow](./ci.md#one-job-for-all-of-it): one job, in which the action runs the goldens once (`id: goldens`) and the parts you turn on follow it. It is built from its switches, **Fix pull requests** and **Tell Slack**.

The workflow has the checkout, Node 22 and a line for the agent's dependencies before the action. With a fix pull request on, the checkout is of the branch its pull request goes into. The tab shows what the workflow needs for what is on, and what fails a golden in it. Then comes a panel for each part, its settings and what lands, for the repository's default branch, dimmed while it is off.

**Keys.** The step's `env` names the keys of the providers the goldens' recordings call, with how many there are among what it needs:

- With Fix pull requests on, every golden's keys, since blame and verify run the agent live.
- Otherwise, those of the goldens that run live: one marked `fork`, or with an injection gate, and a forking golden's judges.

Where a golden's keys can't be named, a comment in the `env` says to add them. A list of keys breaks only after a comma.

**What fails a golden** lists the injection gate too, and, in amber, a gate, judge or injection test that can't decide. **An inconclusive golden** sets that for the step:

- **Warns** writes `inconclusive: warn`.
- **Fails** leaves the input out, so a gate against history with too few sessions still only warns.

**The pull request** is shown as CI opens it: its branch named after the golden, blame where the run was lost, and verify's line with its rule stated once.

**Push from CI.** The step follows the [team store](./team.md#push-from-ci)'s Push from CI, with no switch of its own. Its Team store row says how Push from CI stands, and leads to Settings → Store, where it is set. While it is on:

- the step pushes the test runs and each fix;
- what it needs names the bucket's credentials: for short-lived ones, the two credentials steps `shadowlap store ci` prints and `id-token: write`; for R2, its keys as secrets, which only your branches' jobs get, and only those push;
- what lands in the team store adds the test runs, the fix on teammates' Fixes page, and what a pull request's job writes ([Fixes in the team store](./ci.md#fixes-in-the-team-store)).

### Coding agents

*Coding agents* need no MCP server: the CLI is their interface. The tab shows which of these files mention Shadowlap: `CLAUDE.md`, `AGENTS.md`, `.agents/skills`, and where the project has them, `.cursor/rules` and `.github/copilot-instructions.md`.

The `.agents/skills` row offers [the skills for Codex, Cursor, Copilot and the others](./agents.md#codex-cursor-copilot-and-others), with **Add the skills**:

- **After adding them**, the row reads *found · shadowlap-setup-agent, shadowlap-debug-agent* and its version. The files of the agents that read them say the skills give them the section.
- **Over another version's copy**, **Update to** moves them to the CLI's own.
- **Over one edited here**, **Replace with** puts the CLI's own copy in its place. It asks first, confirmed with **Replace skills**, since that replaces it.
- **Where the skills can't go in**, the row says why.

The tab also gives the section to paste.

### Tools

*Tools* lists every tool the recordings called, by what happens to it after a fork. It also lists the MCP servers the project's client configs list, each with the `shadowlap mcp` line that records it. Each config comes with `shadowlap mcp` in front of its servers, to copy.

Credentials in a copied config:

- **A header's value** becomes a variable in the entry's `env`.
- **A URL's user and password** are never shown or copied. A remote server's become an `Authorization: Basic` header from a variable, or are left out when it sends its own Authorization header. One in a command shows as `•••@`, to put back.
- **Every value the copy leaves out** is named on the page. In `.mcp.json`, whose `${NAME}` Claude Code fills in from the environment it starts from, the page says to set each variable there.

**Add MCP server…** shows the line and entry for a command or URL you type, credentials hidden as the table hides them. **Copy entry** copies it as you typed it, a URL's query and path included, less a URL's user and password.

### Project

*Project* shows the project's store, runs and attempts, size and address, with **Clean up old runs** and **Remove project…**. Beside the store's size, it shows any unused space that runs deleted since left in the store.

**Spending** is the row that sets when a billed job asks first: **Always ask**, **$0.50**, **$2** or **Never ask**, or an amount typed in dollars, kept once you press Enter or leave the field. See [Spending](#spending).

- **It is yours**, on every project on this machine, kept under `SHADOWLAP_HOME` in `settings.json`, never in the project.
- **Each change is kept at once**, with **Undo** in its toast (`Asks above $2 · on this machine`).
- **Its words follow the setting**: *Ask before spending more than $0.50.* and *A job with no estimate always asks.*
- **Change**, in a dialog's footer, opens this row with the field focused.

### Store

*Store* is the [team store](./team.md). It shows:

- the bucket;
- the last sync, with the runs in the store and only on this machine, by run (attempts filed under their run);
- **Push local runs** and **Pull**;
- Push from CI (every test run, its report and each fix CI opens), with its step to copy; the Fix on failure step on the CI tab follows it;
- while a setup is under way, the step that is next, with **Continue the setup**.

With no team store, **Set up team store** opens the store's setup page.

### When the config or the folder can't be read

While `shadowlap.config.json` can't be read:

- the tabs say so where their rules would be;
- they offer neither **Calibrate** nor **Set up team store**, which would read or write the same file;
- *CI* says so too, and each step says in its `env` what it leaves out until the file is fixed, as an amber row of what it needs does;
- no clock mode shows as chosen.

When the project's folder is gone, Settings says so in its header, with **Remove project…**. It says its rules, store, instruction files, recorded tool calls and MCP configs can't be read, and shows no clock mode as chosen. It changes nothing until the folder is back.

## The team store's setup

The team store's setup (`#/setup/store`) is a page of its own. You reach it from Settings → Store's **Set up team store**, or the palette's.

It has [four steps](./team.md#set-it-up). Each unlocks the next, with its command beside it where it has one:

1. **Connect your bucket.** **Check access and connect** runs `store set --check`, which writes the config only once the check passes.
2. **Push your runs.**
3. **Push from CI**: **I added it**, or `Skip for now`.
4. **Bring your team**: **Finish**.

While a setup is under way:

- Needs a look leads back to it first;
- Settings → Store names the next step;
- the palette offers **Continue team store setup**;
- the status bar says *setting up*.

A setup finished before says so, with the way to Settings → Store.

## Projects

A project is a folder with your agent's code. Its store is in that folder (`.shadowlap/shadowlap.db`), so each project has its own runs, fixes, tests, configuration and activity.

One dashboard serves several projects. Switching projects switches the store it reads, and every action runs in that project's folder, against its store. The folder `shadowlap dashboard` starts in is always one of them, and the dashboard opens on it. `shadowlap dashboard --read-only` and the dashboard the terminal UI opens serve that one store only.

### The project switcher

The project at the top of the sidebar opens the switcher. It lists every project on this machine with its run count, or *setting up* or *no runs yet*, and its folder on hover. A check marks the current one. **Add project…** follows.

- **Picking one** switches to it and opens its Overview.
- **A job already running** keeps to the project it started in. Once the page shows another, its drawer says which (*in support-agent*), and its links switch back before they open.
- **While there is more than one project**, each has a × that opens **Remove project…**. From the keyboard: ↓ to the project, then → to its × or Delete.

**A project whose folder is gone** (deleted, or moved, even while the dashboard shows it) stays listed as *folder not found*. Its pages say so and offer to remove it, and its actions are refused with the reason. They come back once the folder does.

**A store deleted while the dashboard serves it**, its folder still there, is reported as deleted: the dashboard tells by the file it was rather than its name. Its pages say so, its actions are refused with the reason, and nothing reads the deleted file any more.

A store made where it was (a run recorded) is read anew, with none of the old one's runs. A dashboard that serves one store, as the terminal UI's does, says so and asks to be started again.

### Switching projects

Switching is for every tab at once: the dashboard serves one project at a time. A tab that still shows the project you switched away from catches up within seconds, or at once when you come back to it.

- **A change it asks for meanwhile** is refused rather than made in the other project. The page says so, and turns to the current one.
- **The page it shows** stays when every project has that page (the Overview, Runs, Tests, Fixes, Training, Settings), with whatever is typed on it, so a refused change can be sent again to the current project. A run, a comparison or a fix of the other project gives way to the Overview.
- **A dialog that was open** closes, since what it asked about (a folder to record in, a golden to update, runs to delete) is the other project's, and nothing is done in either. One that holds only what you typed (a rule to add, a server's command) stays, and says it adds to the current project instead.
- **A first run's confirmation** names the project it was asked in, so it is never used up in another.

### A link into another project

A link to a run, a fix or a pair of runs that another project's store holds opens a page that says which: *In support-agent*, and *The run 01M64J32D4 is in support-agent’s store, not triage-bot’s.* **Switch to support-agent** switches to that project and opens the link there, at the same call, view, step or pair. The crumbs name only the section, and the tab's title names the project. A project with no runs shows this page in its setup's place.

- **Read, never changed.** The other projects' stores are read beside the server. Nothing is created, migrated or written in them, no connection stays open, and removing a project waits for the read.
- **Only the list.** The projects on the list are looked in, in its order. A project you removed, one whose folder is gone, a newer Shadowlap's store and a store in a folder you can't write to aren't, though the switcher lists that last one. The page then says the item isn't here.
- **One store.** A dashboard that serves one store (`--read-only`, the terminal UI's) and an exported copy say only that it isn't here.

### The project list

The dashboard keeps the list in `~/.shadowlap/projects.json`. `SHADOWLAP_HOME` moves the folder, with every other file Shadowlap keeps for this machine ([environment](./cli.md#environment)); give it as an absolute path.

The list holds no recordings. For each project it holds its name, folder and when it was added, how far its setup got, and the commands you confirmed for recording there. It holds the same for projects you removed, so adding one again brings it back. It is written atomically and readable only by you, and keys it doesn't know are kept.

- **Listing projects** reads their stores without changing them. So a project pinned to an older Shadowlap keeps working, and a store in a folder you can't write to is still read.
- **A store that can't be read at all** (a newer Shadowlap's) is listed with the reason.
- **If the list can't be read**, or a newer Shadowlap wrote it, the dashboard still opens on its folder, and says why it can't list or add others.

### Adding a project

**Add project…** asks for the folder your agent's code is in. As you type, it suggests folders and says what each holds (`Python · uv · pyproject.toml · uv.lock`, `Node · pnpm · package.json · pnpm-lock.yaml`).

- **A folder of projects**, without project files of its own, lists the projects it holds in its place (`~/code/invoice-bot` rather than `~/code`). Typing a project's name finds it there too.
- **A folder that isn't a project**, without a `pyproject.toml`, `package.json`, requirements file or other project file, can't be added, and says so. Clicking it lists what is inside.
- **A folder that was a project before** comes back as it was: its runs, its setup where it left off, and the commands you confirmed there.
- **A moved folder**: a project's folder is listed once, by its real path. One you moved with a link left at its old path is already in the dashboard, and adding it by the path it moved to moves the project there.
- **A folder that already has runs**, recorded in a terminal, opens on its Overview, as when `shadowlap dashboard` starts there.

### Folder suggestions

Suggesting folders means the dashboard lists directories, so it does that within limits a web page can't stretch.

**Access.** Like every request, suggestions need the session token. Adding a project, like every change, is also refused from another origin.

**Where they reach.** Suggestions reach your home folder, and roots you add: `"roots": ["/work/agents"]` in `projects.json`, or `SHADOWLAP_PROJECT_ROOTS` (separated like `PATH`).

- A root can't be `/`, a system folder, or a folder that holds your home folder.
- With nothing typed, a root is listed too; when it has no project files of its own, the projects in it are listed in its place, as typing its path lists them. A folder of it without project files gives way to the projects one level inside, as `code/invoice-bot`.
- A path that leads elsewhere, through `..` or a symbolic link, lists nothing.

**What they list.** Suggestions list one folder level at a time: folder names, what kind of project each is, and the projects one level inside a folder without project files. They look in at most 40 such folders, and 25 subfolders of each, looking into the usual places for code first: `code`, `projects`, `src`, `repos`, `work` and the like.

- They never list files, and a file gets the same answer as a path where nothing is.
- A link is never followed to find them.
- Hidden folders (`~/.ssh`) and system folders (`~/Library`, `~/AppData` and `~/snap` in your home folder, `node_modules` anywhere) are never listed or entered. The exception is a root you add inside one, such as your iCloud Drive folder under `~/Library`.

**How a typed path is checked.** It is checked as typed before anything is looked up, then where it really leads, and only then whether it is a folder. So a path into a hidden folder gets the same answer whether or not something is there.

**How much is read.** At most 2,000 entries are read from a folder, and 100 suggestions returned.

### Setting it up

Adding a project opens its setup.

- **A project with no runs** shows it on every page but Settings.
- **One that is partway through** shows it on the Overview (and at `#/setup`).
- **Skip the rest**, or, once its golden's test passes, **Go to the overview**, finishes it.

The setup has four steps. Each runs the command beside it in the project's folder, the same one you could type in a terminal:

| Step | What it does          | Command                                                                     |
| ---: | --------------------- | --------------------------------------------------------------------------- |
|    1 | Inspect the folder    | `shadowlap init`                                                            |
|    2 | Record a first run    | `shadowlap run -- <command>`                                                |
|    3 | Make the replay clean | `shadowlap calibrate <run> --write`                                         |
|    4 | Keep it as a test     | `shadowlap pack <run> goldens/<name>`, then `shadowlap test goldens/<name>` |

**1. Inspect the folder.** Inspecting finds the SDKs, the start command, and every tool with its effect. Tools that aren't wrapped are flagged, with the code to wrap them. The dashboard reads what [`init --json`](./cli.md#init) prints, from the job, and the job's drawer shows what `init` found, a line each.

- Inspecting is done once `init` has run in the folder. A project recorded in a terminal first shows it as skipped, and can still be inspected.
- A Node the project pins before 18.18 (`.nvmrc` or `.node-version`) is flagged there: an agent on it never starts under Shadowlap. So **Record run** stays off until the pin is raised and the folder checked again.

**2. Record a first run.** A recording counts once it holds calls. One whose command didn't start (a typo), or whose agent stopped before its first model call, recorded nothing, and the step says so.

- When tools weren't wrapped while it was recorded, their calls aren't in it: wrap them, check again, and **Record again**.
- Until the replay is made clean, the newest recording is the setup's, so recording again in a terminal works too.

**3. Make the replay clean.** This replays the recording offline. When it replays clean as it is, the step is done by itself. When calibrate proposes normalizers for values the agent makes anew on every run, **Add it** writes them to `shadowlap.config.json`.

**4. Keep it as a test.** The golden goes in a folder of its own, `goldens/<project>` unless you name another. Shadowlap never packs over a golden that is already there, and offers the next free name instead.

- **Pack as golden** packs it and runs its test in one job, so leaving the page doesn't stop it halfway. The step is done once the test passes.
- **A golden its tests entry runs live** (marked `fork`, or with an injection gate) asks first before its test runs, whatever [Spending](#spending) says, as nothing prices it here.
- **A golden whose test failed** keeps the step open, with why and **Run the test again**. Fix what changed (or record again), then run it.

**Skip the rest** appears after the first recording. Finishing before the test passed counts the last step as skipped.

The same commands typed in a terminal move the setup on:

- `init` records what it finds.
- A recording counts once it holds calls.
- A clean replay of it (`shadowlap replay <run>`) completes step 3, and a pack of it under `goldens/` whose test passed (`shadowlap test`, which keeps each golden's result in the store) completes step 4.
- Packed but not yet tested, the step offers **Run the test**.

One step is current at a time. Once a golden is packed, making the replay clean shows as passed by (it can still be run), and a test of the golden that passed counts as a clean replay too. `calibrate --write` in a terminal leaves nothing behind by itself; the setup's **Calibrate** then finds the replay clean as it is.

### The command that starts your agent

The browser never sends a command line, with one exception that already exists for a capture's replay: the command that starts your agent. It only ever goes after `--` in `shadowlap run -- <command>`.

The server splits it into arguments without a shell, reading quotes as a terminal on macOS or Linux does. So the command the setup shows reads back as the same arguments:

- **Quotes**: single quotes keep text as it is, and a backslash makes the next character text (`'it'\''s'`, `my\ file`).
- **Windows paths**: so that one works, a backslash before a letter, a digit, `.`, `_` or `-` is kept (`C:\agents\run.py`). Two backslashes in a row are refused.

What only a shell would understand is refused rather than passed on as text, so put the rest in a script. The server refuses:

- a pipe, `&&`, a redirection, `$VAR`, a leading `~`, a wildcard or a comment outside quotes;
- `$VAR` or a substitution inside double quotes;
- `$'…'`;
- a backslash at the end of the line.

The first time a command runs in a folder, the dashboard asks before running it. The same command in the same folder doesn't ask again, unless its model calls would go to another model server than before.

`init` can find that the project talks to a model server of its own: `OPENAI_BASE_URL` in its `.env`, or a local base URL in its code, as with Ollama or vLLM. Recording then sets `SHADOWLAP_UPSTREAM_OPENAI` to that server, as `init` tells you to in a terminal, so the calls go there and not to the provider's API. A server address with credentials in it (a password, or a key in its query) is never stored or shown, so such a project is recorded in a terminal.

### Removing a project

**Remove project…** takes the project off the list. Nothing on disk changes: the folder and its code, its store, `shadowlap.config.json` and the goldens stay. The list remembers how far its setup got and the commands you confirmed, so adding the folder again undoes it.

**Also delete its recordings** deletes the store as well (`.shadowlap/shadowlap.db` and the files SQLite keeps beside it), once you type the project's name. The dashboard closes every connection it has to the store before deleting it, waiting for any read of it for a link from another project or for the switcher, and opens none again. The list forgets the project: added again, its setup starts afresh.

- **It won't while a run is recording there**: a run whose process is still there, however long ago it started. One a killed process left marked running doesn't hold it up.
- **It won't when the folder can't be written to.**
- **It never touches the goldens** in your repository.

Repair reports, exports and files sent to jobs, in `.shadowlap/repairs`, `.shadowlap/exports` and `.shadowlap/uploads`, are copies of their own and stay too. The dialog names the ones there, so delete them yourself if they hold what you mean to delete. With a [team store](./team.md), the dialog says how many of the runs are in it too, which stay there, and how many exist only here.

The only project can't be removed.

## Actions

Labels, notes and actions run only from a dashboard started with `shadowlap dashboard`; elsewhere their buttons say why they are off. Each action is a [job](#jobs) that runs the CLI.

Each action has one name wherever it is offered: its button, its menu item and its entry in Search or jump to. Its dialog is titled and confirmed with that name, and its drawer heads it in the -ing form, then in the past tense once it has done it (**Run repair**, *Repairing*, *Repaired*). A name is verb and object in the CLI's words, with no article, and it ends in an ellipsis when the action asks for something before it runs (**Find breaking commit…**).

### Spending

A billed job, one that makes live model calls, starts or asks first by Spending: the most a job may spend before it asks. You set it in Settings → [Project](#project), and it holds on every project on this machine.

- **At or under it**, the job starts on the click, and its drawer says its estimate beside *running* (`running · ≈$0.027`).
- **Above it**, the job asks first. The dialog's footer says why, `Asks above $0.50 · Change`, and **Change** opens the Spending row.
- **With no estimate**, as for a job with nothing recorded to price it from, the job always asks, except **Record run** with a command this folder has run before, which starts with no estimate.

Spending has four settings, and takes any amount in dollars:

| Setting | A billed job with an estimate |
| --- | --- |
| **Always ask** | Asks first, its footer saying `Always asks · Change` |
| **$0.50** | Starts at once at or under $0.50, the default |
| **$2** | Starts at once at or under $2 |
| **Never ask** | Starts at once |

Some jobs ask on every setting, Never ask included, and their footer says nothing of Spending:

- **A form**, an action that asks for something first, such as **Switch model from here…** or **Score model…**;
- **Run repair**, **Update golden**, and **Force *tool* live** on a tool that writes, which say what they change before they run;
- **A price per unit**, such as an attempt's;
- **Someone else's command**, from a pack, the team store or a program that sent the sidecar its command. That yes is to the command, never Spending's.

A job that bills nothing, such as a replay offline, starts at once on every setting.

**Each billed control's card** says its price and what a click does: `≈$0.027 · starts at once`, `At most ≈$10.88 · asks first`, `no estimate · asks first`. *At most* is a ceiling: the job stops early when it can. Its dialog's Cost line says the estimate and what is billed (`≈$0.027 · live from #12, writes fenced`). The job keeps the estimate it started with, so its card, its dialog and its drawer say the same amount.

**Spending is no budget.** No job stops at it, and the drawer's amount is the estimate, not what was spent. A budget still stops a job: `--budget` (on an injection test too) and CI's fix budget. Spending is the dashboard's: the CLI and the [terminal UI](./tui.md) don't read it.

### Actions on a run

**Replay** re-runs the recorded command.

**Fork at #n** (or a row's fork button, or `f`) offers what the terminal UI's fork menu offers for that call, one line each with its flag, each named in the CLI's verbs:

| Selected | The menu offers |
| --- | --- |
| A model call | **Inject instruction…** (always as the user), **Switch model from here…**, **Use changed prompt from here**, **Fail with HTTP status…**, **Run live from here** |
| A tool call | **Override result…**, **Fail with tool error…**, **Plant instruction…** (reads only), **Force *tool* live**, **Run live from here** |
| A recorded user input | **Override user reply…**, **Run live from here** |
| The whole run | **Repeat 5 times** (`--repeat 5`), **Replay with writes stubbed**, **Find breaking commit…** |

The [terminal UI's fork menu](./tui.md#actions) lists the flag of each line. An item that asks for something first ends in an ellipsis, and its dialog is titled and confirmed with its name: **Inject instruction…** opens *Inject instruction at #17*, confirmed with **Inject instruction**.

- **Repeat 5 times** runs five attempts. On a recording they replay offline, and it starts at once. On a fork they run live from where it forks, so it goes by [Spending](#spending), asking in *Repeat fork 5 times*, confirmed with **Repeat 5 times**.
- **A fork is made again** from its parent, with the flags, command and checks that made it.
- **Force a tool live** on a tool that writes asks first, in red and starting on Cancel, since it acts on your systems. On any other tool it goes by [Spending](#spending), as **Run live from here** and **Use changed prompt from here** do.
- **Replay with writes stubbed** replays a recording offline, and starts at once. On a fork it runs live from where it forks, so it goes by [Spending](#spending).
- **An action that needs something from you** (the instruction to inject, the status to fail with, the model to switch to) asks for it in a dialog first. The dialog shows the command it runs, following what you type.
- **What you type** is passed as text, never read as a file. See [Interventions](./interventions.md).
- **Plant instruction…** starts from a few sample instructions, or takes your own or a red-teaming tool's payload as text.

**Find breaking commit…** runs [`bisect`](./cli.md#bisect):

- It asks for a commit where the run still worked, and offers the ones its command was recorded at that this checkout has. It searches up to HEAD when the run failed at a commit it lacks, such as a teammate's.
- On a run that passed, it reads **Find commit that changed it…**, and finds the first commit after its own that changed what it does, once there is a commit after it.
- A run that failed at the repository's first commit, or the oldest a shallow clone has, has nothing before it to search, and the item says so instead.
- A run that failed on its own is replayed with `--fork`. One live replay decides each commit, which a failure that doesn't happen every time can pass. The dialog's Cost line is the search's estimate from the commit you give, and the card on its price says what one replay can't settle.
- A run that failed only the check of its fix (blame found it failing, though it exited 0), or a check given with its own `--expect`, is searched with that check (`--expect … --fork`), from a commit you pick.

**A run imported from a capture** has no command, so its menu shows a note and one action, **Replay with your command…**. That replay records every kind of call, and every fork works on it.

**Add check…** comes first in a tool call's row menu, never in the header's **Fork at #n**. It is also on the inspector's summary line, and in ⌘K as **Add check at #n…**. Its menu starts a rule from the call, each with the key it writes, then **Ask a judge…** about the whole run, and a pick opens the [check builder](#making-a-check). A capture, a recorded user input, a run still recording and an exported copy offer none.

**Share**'s menu is named for the run (*Share 01K5CQ4R1T*). It copies the run, each copy a job, its items named for the copies they make, in the order it lists them:

| Copy                 | What it makes                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------- |
| HTML report          | The run with the runs it came from; it also downloads                                    |
| Pack…                | A pack, into a folder inside the project                                                 |
| Eval dataset…        | A dataset for evals, in a format and with the examples you pick                          |
| OpenTelemetry trace… | A trace sent to a collector, or written to a file (a file only: it is sent nowhere else) |
| HAR file             | The run's model calls; it also downloads                                                 |
| Security report      | A kept injection result's report, the matrix and each proof; it only downloads           |

- **Each dialog** says the verb for the copy it makes: *Export OpenTelemetry trace*, confirmed with **Export trace**; *Export eval dataset of* the run, confirmed with **Export dataset**; and Pack's, confirmed with **Pack run**.
- **Where copies go**: into `.shadowlap/exports/` in the project, unless a pack names another folder, and never through a link that is already there.
- **Redaction**: the menu says how many redaction rules each copy applies, and links **Redaction settings →**. A trace carries no prompt text, so only the rules without a path.
- **When**: a run is copied once it has ended. While it records, each item says it waits until the recording ends.
- **A dataset** from **Share** takes up to 500 runs at once, from Runs; past that, `shadowlap export dataset --label`.

A run whose recorder was killed reads *interrupted* in every copy, as it does on every screen. The pack, the HTML file (with the redaction rules or without) and the trace hold it ended at its last call, so whoever opens or unpacks it never sees it recording. The store is left as it is.

Where jobs can't run (a read-only dashboard), **Share → HTML report** comes straight from the dashboard, made apart from its own work so pages keep answering. One that takes more than two minutes (a redaction rule whose pattern is slow on the run's text, or a run too long for a download) is stopped, naming the rule most likely at fault. `shadowlap export html` makes it from a terminal.

With a [team store](./team.md), a share link comes first, its drawer ending on **Copy link**. The report opens for anyone with the link until it expires, 7 days at most. A run only on this machine has **Push** in its header, as does a run in the store whose attempts aren't (Push sends them).

**Delete run**, in the header's **…**, removes a run, with the attempts bundled under it, which its dialog and its toast count, as `shadowlap rm` does. It also removes the recorded data nothing else uses. It waits while the run records.

On the run's page, the run leaves the lists at once and the page goes to Runs, as it was last shown. Its toast has **Undo**, and the run is removed once the toast goes.

**Run blame** is on the page of a failed run that was never blamed. It blames the run with the check it failed, found the way a replay is judged, the first that applies:

1. the run's own `--expect`;
2. the entry under the config's `tests` for the recording it replays: the golden a test replayed, or the pack it was unpacked from, through the runs it came from;
3. the check of the fix it fails in, or of a fix its labels point to;
4. the agent's exit.

When the run failed a check none of those give, or nothing says what a passing run must do, it asks for the check. The blame opens the run's fix, or joins one, and links to it.

A capture has no command to run again, so **Run blame** asks for yours, which runs as `shadowlap blame <run> -- <command>`. A capture its import judged failed is blamed on the rules on calls it broke.

### Making a check

The check builder makes a check from a tool call and writes it to the golden's entry under `tests` in `shadowlap.config.json`. [Checks](./checks.md#make-a-check-in-the-dashboard) describes the rules it builds; this is the dialog.

- **The golden it goes to** follows the rule as it changes: the first of the agent's goldens whose own recording passes it. Pick one under **Checks of**, which lists the agent's goldens, and it stays.
- **The golden's checks**: one row a check, labelled as reports label them. The rule being built reads `new`, or `changed` once it edits one of the file's, and a removed one `removed`, with **Keep**. A tool's count the rule takes the place of reads `replaced`.
- **An injection gate** set in the golden's entry is a row of its own, read only.
- **Against your recordings**: the counts, with *not applicable* apart, the notes in amber or grey, the recordings on request, and the `shadowlap check` command with **Copy whole command**.
- **The change**: the golden's entry as the file will hold it, with the file's version. When saving would also lay out other lines of the file anew, it says so first.

**Save check** turns lime once nothing needs a look, and stays off with its reason until the rule can be saved. For an edited check it reads **Save change**. While the dashboard server can't be reached, it waits.

- **A file changed since the page read it** is never overwritten. The page names what changed, reads the file again, shows your change against it, and the button reads **Save again**.
- **An entry the server refuses**, as `shadowlap test` would refuse it, shows the server's words in the dialog's amber line.
- **A save** closes the builder, says *Saved to shadowlap.config.json · goldens/…*, and leaves an entry in the [activity feed](#activity). The run's outcome is judged again by its checks.

A press outside the dialog never closes it. Esc closes it while nothing changed, and asks first once a rule did.

### Actions on a fix

**Run repair**, on an open fix, runs [`shadowlap repair`](./repair.md):

- **From** the fix's failing runs, its check and the scope its blame searched, so the repair blames the same calls and reuses that blame.
- **Keeping** the fix's own good runs (those a repair or a verify of it kept), else the runs labelled `good` that run the same agent, else none. A good run of another agent checks nothing a change to this one touches.
- **With** the repairer `repair.repairer` in `shadowlap.config.json` names, or else your own Claude Code (`--repairer claude-code`).

It asks first on every setting of [Spending](#spending), since it runs your agent live. Its card and Cost line say how many candidates it tries, each verified up to twice, and what that is estimated to cost. It says that nothing in your working tree changes: each candidate is tried in a worktree of its own, made from your working tree as it is. So a file you change meanwhile is in the candidates made after it.

**The repairer.** The dialog reads the config again as it opens and names the repairer it will ask, whose account pays. If the config names another by the time you confirm, nothing runs, and the job says which one the config names instead.

- **Claude Code not found**: when that repairer is Claude Code and `claude` can't be found on the PATH the dashboard's jobs get (or where `SHADOWLAP_CLAUDE` points), the dialog says so, with what to do, and Repair stays off. The server refuses the job: it would blame every failing run and find no one to propose a fix.
- **An API repairer's key** can't be checked without asking it, so the repair says why when it couldn't.

**No fix to try.** When the blame of every failing run rescued it from no call, the repair would reuse those blames and end *No fix to try* without running the agent. Run repair stays, but is no longer the page's lead button. Its hover and its dialog say so, and why:

- no answer of the model's lost the run, since every attempt met a write's recorded error again, or the attempts that passed answered as the recording did;
- blame couldn't settle where it was lost;
- or no probe rescued it.

The dialog's cost line then reads *Free*, nothing runs, and the blame's own next step leads instead:

- **Run blame again**, for a blame that couldn't settle (more attempts and a lower bar, as blame's report says), or that stopped part way (to the end, without its budget), under the fix's check.
- **Run blame with stronger model…**, which asks for the model first, for one that asked the recorded model again and rescued the run from no call, unless blame found the model's answer isn't what lost the run. Its Cost line follows the model you type.

Run blame again goes by [Spending](#spending), priced for its lower bar. Its ask shows that bar beside the last blame's, or, for a search that stopped, the furthest call it had rescued the run at.

Each is built from the blame's report and the flags kept beside it, as Run more attempts is. A blame a pull brought asks first, showing the exact command.

**Copy git apply**, on a verified fix, copies the command that applies its patch by hand, `git -c core.autocrlf=false apply <patch>`. The flag keeps Git for Windows' `core.autocrlf` from writing a file with LF back with CRLF on every line. A teammate's patch with LF, for a checkout where the file has CRLF, applies only through that conversion, with plain `git apply`.

**Apply fix** runs [`shadowlap fix apply`](./cli.md#fix) once you confirm, since it changes your working tree. The confirm dialog names every file the patch changes, and shows the patch itself. The patch goes in with `git apply`, the recordings the fixed code made are copied into `goldens/`, and `shadowlap test` replays them. The button then reads *Patch applied*, and **Show patch** takes the place of Copy git apply.

- **A fix with no patch** (verified on the working tree, or with a change of request fields) reads *Marked applied* once applying marks it. Its hover names the change its agent makes, or says it was verified on the working tree, and the activity feed says *Marked applied* too.
- **A patch already in your working tree** (a pull request merged it, or you applied it by hand), which `git apply --reverse --check` recognises as `fix apply` does, needs no applying. The button reads **Mark applied**, which copies the goldens it is missing, runs them and marks the fix applied; Copy git apply is gone, and the Overview no longer counts the fix as ready to apply.
- **A teammate's repair**, from the team store: the patch goes in alone, and nothing runs it. Its recordings are on their machine, and your goldens aren't replayed against it until you have read it and run `shadowlap test`.
- **A patch that is more than the change its repair verified** (another file, a file made, renamed or given a mode, lines its candidate doesn't rewrite) can't be applied from here. The button stays off and says why, Copy git apply is gone, and `fix apply` refuses it.
- **A teammate's patch that is no rewrite a repair makes in your working tree** (code or a comment rewritten, text past the end of its string, a file or a value that runs) is refused the same way. See [the team store](./team.md#a-teammates-patch-is-held-to-a-repairs-rewrites).

Under the patch, the dialog asks a name for each golden it copies: *The golden from `01K5CQ2E8M`*, filled with the fix's label (`refund-bug`, or `refund-bug-1` and `refund-bug-2` for two), never the run's id.

- A name takes lower-case letters, digits and hyphens, from a letter or a digit, at most 64 of them, one golden each, and not one `goldens/` holds already. Under the field, the dialog says why one won't do, such as *goldens/refund-bug is taken: pick another name.*, and Apply fix waits until each will.
- A name Windows keeps for itself won't do either, whatever its case: `con`, `nul`, `prn`, `aux`, `com1` to `com9` and `lpt1` to `lpt9`. A label that makes one gives way to the fix's title in the field.
- The command follows what you type, `shadowlap fix apply <fix> --name 01K5CQ2E8M=refund-bug`, and the step says where each recording goes.
- A recording in `goldens/` already keeps its name and is asked none, as [`fix apply`](./cli.md#fix-apply) keeps it: one an earlier apply copied, under whatever name it gave it, or one `repair --goldens` copied under the run's id.
- Mark applied and Finish applying ask the names of the goldens they copy too.

For a patch repaired here, or a teammate's already in your tree, the project's other goldens are replayed offline too. A prompt or a tool description goes into every request, so a golden recorded before the change can diverge on it from the first call.

- The drawer names each golden that does, at the call and request field, with **Update goldens**. It asks first, and re-records them with `shadowlap test <goldens> --update`.
- An applied fix whose goldens failed its test holds again once a test session passes every one of them.

Applied is this machine's own: a fix a teammate applied is verified here until its patch is in this working tree.

**Rename** gives a fix a title of your own, as `shadowlap fix title` does.

### Actions on Tests

Tests runs its goldens as jobs too:

| Button                        | Runs                                                                                |
| ----------------------------- | ----------------------------------------------------------------------------------- |
| **Run tests**                 | `shadowlap test goldens/*`, plus each pack the config names elsewhere               |
| **Update golden**             | `shadowlap test <golden> --update`, once you confirm                                |
| **Add normalizer and re-run** | `shadowlap normalize add …`, then `shadowlap test <golden>`                         |
| **Add normalizer and update** | `shadowlap normalize add …` for each rule, then `shadowlap test <goldens> --update` |
| **Find breaking commit**      | `shadowlap bisect`, from the newest revision where the golden passed                |

These jobs run one at a time in a project. While any of the following runs, **Run tests**, **Update golden**, **Add normalizer and re-run** and **Find breaking commit** wait, saying what is running:

- another of these jobs, **Find breaking commit** on a golden among them, which reads its pack and answers the failure it started from;
- a setup packing and testing its golden;
- a test session or the [error-path presets](./error-paths.md) on goldens (`test --chaos`), started in a terminal or another dashboard, named by their command.

The server refuses another such job with the same words, from any tab, the palette's *Run tests* included. A test replay's page disables its **Add normalizer and re-run** (or **Add normalizer and update**) and **Update golden** the same way. Find breaking commit on a run that is no test replay touches no golden, and doesn't wait.

**Run tests** runs `shadowlap test goldens/*` (plus each pack the config names elsewhere), with no shell: the CLI expands the pattern itself, as it does in CI. The page follows the session as each result lands. Its drawer ends on **Open Tests**, with the first three goldens that failed linked by name beside it, each opening its replay. Over Tests itself, it ends on the step the page leads with once the page has read what the job did. A run of one golden ends on its replay.

**A session that runs live goes by [Spending](#spending).** Before a session runs a golden live, the server asks. The page answers by Spending for **Run tests**, **Run more attempts**, **Re-run test** and **Add normalizer and re-run**, on Tests, on a test replay's page and from the palette's *Run tests*. At or under it, the session starts with its estimate; otherwise its dialog asks. A test replays offline, except for two things that run live:

- **A golden marked `fork`** runs live from where it forks, writes blocked, and asks its judge checks live.
- **An [injection gate](./injection.md#gate-ci-on-it)** runs live from each payload it plants, writes stubbed.

The dialog says how many goldens go live and why, and shows the commands. Its Cost line says the session's estimate. It opens on its button, the only way to start the session. A session that only replays starts at once.

Setup's **Pack as golden** and a run's **Pack as golden…** ask every time their test would run a golden live, as nothing prices it. A task's **Update golden** asks in its own dialog, with what testing the golden again bills.

**Update golden** (or **Update goldens** for every one that diverged) asks first, in a dialog that says what happens. It says when a normalizer is the lasting fix, or, once the rule is in the config, that a re-run passes without an update, and offers that as its way on, beside **Update anyway**. Then it runs `shadowlap test <golden> --update`, which re-records it live with writes stubbed.

For several goldens that diverged on values that change every run, **Update goldens** offers **Add normalizer and update** as its way on: one job that adds each rule the server names for them, once, then re-records them all. Its line and **Update anyway**'s say it bills the same either way.

**Add normalizer and re-run** is two commands in one job: `shadowlap normalize add …` for each value that changes every run, then `shadowlap test <golden>`, the second only when the first succeeded. The drawer links to the replay that passed. When the rule alone can't make the replay match, it asks first, and updates the golden after it.

**Find breaking commit** runs `shadowlap bisect` from the newest revision where the golden passed under its checks as they stand. A pass from before a check was added may be a commit where it already fails that check.

- **It asks first**, as **Find breaking commit…**, when there is no such revision, after a search from it named no first bad commit, or for a golden marked `fork`, whose replays run live. Otherwise it starts at once. Its Cost line is the search's estimate from the commit it opens on.
- **Its choices** are the commits the golden was tested at, each with its subject and how it did there: *passed*, *failed*, *inconclusive* or *passed under other checks*, with its tally where it ran several attempts. The commit a search already failed at says *tried: it already fails there*.
- **A golden that never passed** offers the few commits before its failure as *not tested there*, and when it was tested at none, the field says *none tested yet*.
- **Another commit** is a field under the list, for any other: what it holds is searched from, and picking from the list again clears it.
- **Only commits this checkout has**, as on Runs and a run's page. A golden that last passed at a commit it lacks (a pull request's merge commit in CI, say) asks for one, and one that failed at such a commit is searched up to HEAD.

A job only names goldens the project has on disk.

**A golden's checks** change with no job: each button in its Checks cell writes the golden's entry under `tests` in `shadowlap.config.json`, as the [check builder](#making-a-check) does.

- **Add check…** and **Edit** open the builder on the golden, Edit at its check. **Edit checks…** opens it at the first.
- **Remove** asks first, in a dialog with the lines that leave the file and the file's version. Its toast, *Check removed · refund-flow*, offers **Undo**, which puts the entry back as the removal found it.
- **A file changed since the page read it** is never written over. Remove names what changed, shows the removal against the file as it stands, and reads **Remove again**. Undo is refused once the file changed after the removal.

While the dashboard server can't be reached, Remove waits. A [read-only](#read-only-mode) dashboard offers none of these. Each write lands in the [activity feed](#activity).

### Actions in Settings

Settings changes `shadowlap.config.json` as `shadowlap normalize add` and `rm`, `redact add` and `rm` do, keeping the file's other keys, order and indentation.

- **No lost edits**: each change names the version of the file the page read, so one made in an editor or a terminal since is never overwritten. The page says so, and shows the file as it stands.
- **The CLI's words**: a rule the CLI would refuse is refused with the same words.
- **The activity feed**: every change lands in it.

**Calibrate** is a job that runs `shadowlap calibrate <run>`, with each round in the drawer. When it proposes normalizers, **Add normalizer** adds exactly those, without replaying again.

**Clean up old runs** runs `shadowlap gc --older-than 30 --dry-run`. When it finds runs, **Delete N runs** asks first (Cancel has the focus), naming the attempts bundled under them, which go too. It then deletes exactly the runs the dry run listed, or nothing if others match by then.

When no run is that old, but runs deleted since (with `rm`, or from Runs) left blobs nothing uses or 1 MB or more of unused space in the store, **Free 53.5 MB** asks first. It then runs a plain `shadowlap gc`, which deletes no run and gives that back. Settings → Project shows such unused space beside the store's size.

### Jobs

Each action is a job: the dashboard runs the CLI in the folder of the [project](#projects) it shows, against that project's store. The job's output streams into a drawer docked across the content's foot, titled with what it does (Replaying, Forking, Repeating, Packing). The content makes room for it. A screen reader hears how the job stands as that changes (running, stopping, how it ended), not each line it prints.

The command also tells the job what it made, on a pipe of its own rather than in its output:

- the runs it started, attempts listed apart, since they open as a bundle;
- where to go next;
- the files and folders it wrote;
- its result: what `--json` would print.

So the drawer ends on what it did, the outcome and the exit code, in the verdict's colour, and its way on in its header line: the run it made (**Open replay**, **Open fork**, **Open run**) or the attempts, without reading the text. It names the folder a pack went to, and offers a file a job wrote for download. A way on never links to the page on the screen, and reads plain while that page has a lime step of its own.

How a replay or a fork ended:

- **A Replay whose request differed from its recording** says where, *diverged at #3 · went live · exit 0*, in amber (red when the agent then failed). `replay` forks at the first request that differs and runs live from there, writes blocked, so the run it made is no reproduction.
- **Calibrate**, beside **Open replay**, replays the recording offline and proposes a normalizer for each value the agent makes anew on every run (a user id, a temporary path). Its drawer offers **Add normalizer**, and the next Replay is clean.
- **A fork from the menu** says *forked*: diverging where its flag changed the run is what it was asked for.
- **A fork that left the recording before the call its flag acts on** says that instead, *diverged at #3, before the inject at #17 · went live · exit 0*, in the same colours and with **Calibrate**. The calls before it did not replay, so what the flag changed is not the only difference.

Closing and stopping:

- **The fold.** Two seconds after its end, the drawer folds to its header line, unless the keyboard is in it. **Show log** opens it again.
- **Esc or the chevron** hides a running job behind the [status bar](#status-bar)'s chip, which opens it again. A running job's drawer stays across pages.
- **Esc or Close** closes a drawer that has ended, and so does leaving the page.
- **A hidden job that ends** says so in a toast, its title in the past tense with how it came out (*Ran tests · failed · 2 of 7 goldens passed · exit 1*), and offers its way on, or **Show**. Where the past tense would claim more than happened, it says what ran instead (*Tried repairing · no fix found · exit 1*).
- **Stop**, in the drawer while its job runs, stops the command and the agent it started, as Ctrl-C would, even an agent that ignores the signal (it is killed after five seconds); the drawer then says *stopped*. It asks first while the job holds your working tree: a repair verifying candidates made from it, a patch being applied.
- **A run the stopped job left recording** is marked as interrupted, so it no longer shows as live and can be deleted.

Stopping the dashboard (Ctrl-C, a kill, or closing the terminal it runs in) stops its running jobs the same way, and waits for them. Stopping it again while it waits kills them at once. The dashboard the terminal UI opens (`o` in `shadowlap ui`) does the same when you quit the terminal UI or it is killed, and kills its jobs at once when the terminal it runs in closes.

### Commands from someone else

An action that replays a run from someone else's pack, a teammate's pulled from the [team store](./team.md), or one whose command a program sent the sidecar, runs the command recorded. So it asks before it runs:

1. Whatever the action asks first: how many attempts, an instruction, an edited result.
2. Then a dialog shows that command and what runs it, and only its way on (**Run command**, **Run blame** or **Run repair**) starts it. It opens on Cancel, so an Enter pressed once too often runs nothing.

The server asks that question itself: a 409 naming the exact command lines, with a `confirm` for them. It takes as a yes only that `confirm` sent back as `yes` (`confirmed` for the error-path presets). So a yes is to the lines the dialog showed: a command a pull has changed since is asked again.

**A golden recorded elsewhere.** A job that runs a golden from a pack your repository doesn't track, recorded elsewhere, and passes the CLI `--yes`, asks the same of its command. Such jobs are a decision diff from the working tree or with a verify, a migration, verifying what a session flagged, and an injection test. A job the server asked nothing of passes no `--yes`, whatever its request sent, and the CLI, with no terminal to ask in, refuses such a golden ([`test`](./cli.md#test) says why).

**A repair or a blame** that would run a command from someone else's pack asks once more before it does. **Find breaking commit…** is off on such a run, with the reason on hover, since it would run that command at every commit. Replay it with your own command first, and find the commit from that run.

### One job at a time on your working tree

An apply changes your working tree, and a repair makes its candidates from it, so each runs alone in its project:

- **It can't start** while a job runs your agent from that tree: a recording, a blame, a replay or fork, a test, a calibration.
- **Until it is done**, any of those is refused, with what holds the tree. Their buttons wait, with the reason on hover, as Calibrate and Apply fix do in Search or jump to.
- **Run blame**, **Run repair**, **Apply fix** and the Tests actions that run your agent (**Run tests**, **Update golden**, **Add normalizer and re-run**) are off meanwhile, and say so on hover.
- **Any other action that runs your agent** is refused, with the reason.
- **A job in another project's folder** doesn't wait.

### Files you upload

Some jobs take a file from your browser, such as a capture to import. The dashboard keeps it in `.shadowlap/uploads` in the folder of the project it was sent to, until the job that uses it ends.

- It is readable only by you.
- An upload is at most 64 MB, and 32 files at once.
- Only a job of that project can use it.
- A file no job used is deleted after an hour, and every upload is deleted when the dashboard stops.

Uploaded files are untrusted data: the command that reads one parses it as it would any file you point it at.

## Read-only mode

```sh
shadowlap dashboard --read-only
```

Read-only mode shows every page and changes nothing in your runs. Use it to show a colleague your runs, or to look around without the risk of a click changing something.

- **Refused**: replay, fork and the other actions, labels, notes, uploads and deletes. Each says why where you would have used it.
- **The status bar** says *read-only*, with the reason on hover, and Search or jump to leaves the actions out.
- **Downloading a run as HTML** (**Share → HTML report**) still works, since it changes nothing: the file comes straight from the dashboard instead of being written into the project.
- **The store**: read-only mode needs an existing store and never creates one. It opens that store the way every command does, which brings an older store's layout up to date and lets search build its index.
- **Uploads**: it leaves the uploads folder alone, even files another dashboard left there.

A dashboard started without the CLI behind it (embedded elsewhere) is read-only in the same way. Its *read-only* and its buttons say, on hover, to start it with `shadowlap dashboard`.

## Send a run to someone

Export a run as one HTML file:

```sh
shadowlap export html <run> --lineage run.html
```

The file has the same views as the dashboard, with the run's data built in and nothing to install or run. Attach it to a pull request, keep it as a CI artifact, or send it to whoever asks what the agent did.

- **What it holds**: it opens on the run that was shared, and holds Runs (the runs in the file) and, when it holds two or more, Compare between them. Any other page opens Runs.
- **What it leaves out**: there is nothing to run from it and no search across runs, so `/` filters a run's calls or Runs.
- **How it reads**: the sidebar's top says *Exported copy*, how many runs it holds and when, and whether its redaction applied. Its runs sit under *In this copy*, with no Settings or live chip. The status bar says *1 run in this copy* and *exported Oct 1, 10:20 · read-only*.
- **Its own pages**: the logo opens the run it opens on. A run it doesn't hold opens a page that says so, with a link to Runs.
- **Redaction**: it holds recorded prompts and tool data, so the project's redaction rules apply by default; see [`export html`](./cli.md#export-html).

From the dashboard:

- **Share → HTML report**, in a run's header, writes the same file for that run and the runs it came from into `.shadowlap/exports/`, and downloads it. Its output says whether redaction rules applied. On a read-only dashboard it downloads the file without writing it.
- **Share → HAR file** does the same for the model calls, and names how many rules it applied.

## Keyboard shortcuts

The dashboard's keys, by where they work. `?`, or **Keyboard shortcuts** in the top bar's Help, lists them on a sheet, and each control a key presses says its key on its hover card and to a screen reader.

**Single-key shortcuts** can be turned off at the sheet's foot, and the browser remembers it. Off, only ⌘K, ⌘Z, Esc, Enter and the arrows work, and nothing advertises a single key.

These keys work on any page:

| Key               | What it does                                                            |
| ----------------- | ----------------------------------------------------------------------- |
| ⌘K or Ctrl K      | Search or jump to anything; with the focus in a list's row, its actions |
| `/`               | Filter a run's calls, filter Runs, or search anywhere else              |
| `?`               | Show the shortcuts                                                      |
| ⌘Z or Ctrl Z, `u` | Undo, while a toast offers it (a good or bad label, a delete)           |
| Esc               | Close what is open, then go up a level                                  |

These keys work in a list: Runs, Changes' verdicts and a revision's goldens, Fixes, Tests' goldens, and the sidebar's runs while one has the focus. On Fixes, ⌘K on a fix's row offers Open fix and each of its steps, as it does on a verify's row in Changes › Verdicts, and Esc back from a fix lands on its row.

| Key          | What it does                                             |
| ------------ | -------------------------------------------------------- |
| `j` / `k`    | Next or previous row: from no row, the first or the last |
| `↓` / `↑`    | The same, on a row in focus                              |
| Enter        | Open the row; where it opens nothing, its actions        |
| ⌘K or Ctrl K | The row's actions                                        |
| `x`          | Select the row, on Runs                                  |
| `+` / `-`    | Label it good or bad, on Runs                            |
| Esc          | Clear the selection, then let go of the row              |

These keys go to a page, in the order they are listed:

| Key                                  | What it does                                              |
| ------------------------------------ | --------------------------------------------------------- |
| `g` then `o` `r` `c` `f` `t` `a` `s` | Overview, Runs, Changes, Fixes, Tests, Training, Settings |

These keys work on a run's page:

| Key             | What it does                                                                                 |
| --------------- | -------------------------------------------------------------------------------------------- |
| `j` / `k`       | Next or previous call, from anywhere on the page; the selected call takes the focus          |
| `↓` / `↑`       | The same, in the view's list                                                                 |
| `[` / `]`       | The run before or after this one in the list you came from                                   |
| `1`–`4`         | Conversation, response, request, details                                                     |
| `←` / `→`       | In a tab list, the previous or next tab                                                      |
| `←`             | In Calls, fold the selected call's group, or go to the call it sits under                    |
| `→`             | In Calls, open the selected call's group, or go to its first call                            |
| `v`             | Next view, through all of them                                                               |
| `n`             | Jump to the call where the run forked, where blame found it lost, or where it first failed   |
| `p`             | Open the parent run                                                                          |
| `r` `c` `b` `f` | Press Replay, Compare, Run blame or Fork at the selected call, where the run has that button |
| `+` / `-`       | Label the run good or bad, again to take it off                                              |
| Esc             | Back to where you came from                                                                  |

**`b`** presses Run blame only where the run's page leads with it, not the Run blame beside a crash's Find breaking commit.

**Esc** does one thing a press: it closes a menu, a dialog or the palette, hides or closes a job's drawer, then closes the sidebar on a phone, then leaves a field, then hides a hover card. Only then does it go up: a run's open diff closes, a run, a fix or a revision's page goes back the way you came, Runs' selection clears, and the row in focus lets go.

**The way back** lands on the row or the link you left. A page opened cold goes up to its crumbs' parent: a fork or a replay to the run it came from, a run to Runs, a fix to Fixes, a revision's page to Verdicts. `[`, `]` and opening a run's parent add nothing to the way back, and a page it already passed through takes it back to there.

**`[` and `]`** step through Runs as it was last shown, its filter and sort, reading its next page when they come to the last row read. A run Runs never showed steps through the sidebar's. At either end a toast says so.

### Menus, pickers and dialogs

Whatever opens over a page follows one set of rules. While a menu or a dialog is open, the page's own keys wait. ⌘K still opens Search or jump to from a menu. Going to another page, with Back or a link, closes it.

A menu's keys:

| In a menu | What it does |
| --- | --- |
| `↓` or `↑` on its button | Open it on its first or last item |
| `↓` / `↑` | Next or previous item, round the ends |
| Home or PageUp, End or PageDown | Its first or last item |
| A letter | The next item it starts |
| `→` / `←` | A row's second button, as a project's × |
| Tab or Esc | Close it, with the focus on its button |

Each row is one line: what it does, then what it runs. What it is for and the command it runs are on its hover card, a long command up to its first arguments.

**A run picker** filters by id, about line or label, and says *Nothing matches.* when the filter leaves none. The arrows, Home, End, PageUp and PageDown move through the list, a check marks the run picked, and Enter picks another.

**Every dialog reads in one order:**
- a title that is verb and object;
- one sentence ending on the page of these docs that says how the job works;
- one amber or red line, where it can't help yet or acts for real;
- what decides whether to press, as label and value rows;
- its fields, the `$` command they make, and what it bills in one quiet line;
- Cancel, then the way on: lime, red where it deletes, plain beside a second way on.

One that can't start leaves the dialog open, with what you typed.

**A dialog** always fits the window: its title and buttons stay in view, and its body scrolls.

- **Behind it**, the page can't be reached, and Tab goes round the dialog's own controls.
- **The focus starts** on Cancel in one that deletes or removes, else on its first field, else on its action.
- **A click on the dimmed page** closes it only when the press starts and ends there, so a selection dragged out of a command never does.
- **With something changed**, Esc or a click on the dimmed page asks first: *Discard what you changed?*, with **Keep editing** focused and **Discard**. A second Esc keeps editing, and Cancel never asks.

**A hover card** shows after 400 ms under a pointer, and the next one at once while one was showing. It shows at once for the keyboard's focus, and a tap on a touch screen toggles one on a fact that is no link or button. In a row that opens or selects on a tap, the tap does that instead. A card never covers the menu its button opened or a dialog's buttons, and it goes with its page.

**On a phone** a menu, a picker and a dialog are sheets from the foot of the screen, with 44 px rows and buttons. A tap on what is dimmed closes a menu. On a touch screen a dialog doesn't start on its field: it starts on its action, or on Cancel while the action waits. A picker opened by a tap starts on its list, so the keyboard stays closed until you tap the field.

### Focus and accessibility

- **Skip to content** is Tab's first stop on every page. It takes the focus past the top bar and the sidebar to the page's heading.
- **Opening a page** takes the focus to its heading once the page has drawn what it opened for, so a screen reader says where you are and Tab goes on from there into the page. A step within a page (a call, a view, a fix's step, a filter) leaves it where it was, and a first load moves nothing. No move scrolls the page.
- **What the page draws anew** hands the focus to its counterpart, found by what it is, so Tab goes on from where you were. Focus you moved away yourself stays away.
- **A job's end** that takes away the control you started it from hands the focus to the step that took its place, else to the job's drawer: its way on, else its log. A job started from a dialog opened from the drawer's way on takes that drawer's place, with the focus on its log.
- **Tabs** (a run's views, the inspector) are one Tab stop: `←` and `→` move along them round the ends, Home and End go to the first and last, and a count is read apart from its name. Settings and Training switch pages with links.
- **A row that opens on a click** names what it opens with a real link, which the keyboard reaches, a screen reader reads and a browser opens in a tab of its own.
- **Search or jump to** keeps the focus in its field while ↑ and ↓ move through what it offers, as a screen reader expects of a combobox.
- **Closing** a menu, a dialog or the palette hands the focus back to what had it, or to the control drawn in its place when the page has drawn it anew. A click outside a menu that lands on another control leaves the focus there.
- **Closing a job's drawer** from inside it hands the focus back to where it was, or else to the page. Hiding a running job from inside its drawer hands the focus to the status bar's chip, and pressing the chip hands it back.
- **The sidebar on a phone** takes the focus to its first item as it opens. Closing it from inside it, or with a click beside it, hands the focus to its button. A tap on the page or the status bar only closes it: what it lands on doesn't act. The top bar stays in reach, so its Search or jump to opens as the drawer closes.
- **A link in a menu or a dialog** hands the focus to the page it opened, and so does Back with one open. A run picked in Compare leaves it on the picker.
- **A focus ring** is drawn whole in every pane that scrolls. A pane that scrolls and may hold no control (Calls, the Timeline, Turns and Context, a run's calls on Provenance, a code block, a command to copy, a job's output, a dialog's body) takes the focus itself, so the keyboard can scroll it.
- **What has a hover card and no action of its own** takes the focus where it stands on its own (a run's outcome, a fact), so what a hover shows is never only a hover's. In a row or a chart it doesn't, and a mark with no words of its own is named by its card.
- **Every target** is 24 px at least, as WCAG 2.5.8 asks, and text reaches WCAG AA's contrast on every surface it is drawn on.
- **A field's edge** reaches 3:1 on whatever it sits on, as WCAG 1.4.11 asks of a control.
- **On a phone**, no label is under 11 px: the small labels over titles, column heads, tags and shortcut keys rise to it.
- **In a high-contrast theme** that forces its own colors, a mark that says something by its color keeps it, edged in the theme's text color. The current page and run and the selected call take the highlight color, a chosen option is underlined, and menus, dialogs, hover cards and toasts are outlined.

## Limits

The dashboard's limits, in one place:

| What                                          | Limit                                                             |
| --------------------------------------------- | ----------------------------------------------------------------- |
| Runs that Search or jump to lists             | The newest 500; any other run by its id                           |
| Recorded text that Search or jump to finds    | From three characters; up to six matches, two per run             |
| Recorded text that Runs' filter finds         | Whole words, from three characters                                |
| Runs that `status:` judges by their checks    | The newest 2,000 it reads; an older one goes by its own outcome   |
| A row of This week's runs, on the Overview    | Past 60 calls, a cell stands for a range                          |
| Lines of one kind in Needs a look             | Ten, then one line says how many more there are                   |
| A lineage in the sidebar                      | Four steps deep                                                   |
| The days above Runs' table                    | Twelve weeks                                                      |
| Runs in one dataset                           | 500; past that, `shadowlap export dataset --label`                |
| Runs packed in one job                        | 100                                                               |
| A page of Runs, or of a run's calls           | 500 rows, or 500 calls                                            |
| The origin strip                              | Where a cell would be narrower than 6 px, a cell covers a range   |
| The Context view                              | Past 360 model calls, a bar stands for a range                    |
| A cache miss                                  | A cache read short by 1,024 tokens or more                        |
| A fork's writes, one by one                   | Three, then grouped; **Show each** lists a hundred at most        |
| A fork's changes                              | The first four, then **Show all**                                 |
| An edited tool result                         | JSON of at most 2 MB                                              |
| An edited person's answer                     | At most 65,536 characters                                         |
| Compare, in a request                         | Two minutes per 50,000 calls of the pair, at least two            |
| Compare in a terminal (`shadowlap diff`)      | No time limit                                                     |
| Comparisons in an exported copy               | Every pair up to six runs, beyond that each run with the first    |
| A share link                                  | 7 days at most                                                    |
| Uploads                                       | 64 MB and 32 files at once; a file no job used goes after an hour |
| Redaction's preview of a long run             | 2,000 calls, 64 MB or 5 seconds                                   |
| Folder suggestions                            | 2,000 entries read from a folder, and 100 suggestions             |
| Projects found inside folders                 | In 40 folders, and 25 subfolders of each                          |
| **Clean up old runs**                         | Runs older than 30 days                                           |
| A teammate's verdict, run again               | A gate up to 160 attempts a run, a fixed count up to 10           |
| **Stop**, on an agent that ignores the signal | Killed after five seconds                                         |
| Reconnecting                                  | After 5, 10, 20, then every 30 seconds                            |

How the dashboard works through a large store is under [Large stores and long runs](#large-stores-and-long-runs).

## Security and consent

Recordings hold prompts and tool data, so the dashboard is built to stay local:

- **Localhost only.** It listens on 127.0.0.1 only, and refuses requests whose `Host` is not localhost, so a web page on another name that resolves to your machine cannot read it.
- **A session token.** Every data request needs the session token that `shadowlap dashboard` generates at start and puts in the link's fragment (the part after `#`, which browsers never send to servers or in a Referer). Restarting the dashboard invalidates old links.
- **No token on a command line.** The browser is opened on a file only you can read, in your temporary folder, that sends it on to the link; the file goes two minutes later, or when the dashboard stops. The token never appears in a process's command line, which any user of the machine can read.
- **Same origin, same project.** Requests that change something are refused when they come from another origin, and when the page sending them shows another project than the current one (it says which in `x-shadowlap-project`).
- **No command lines from the browser.** The browser names an action or a job and its fields, and the server builds the CLI arguments from the run, the call and those fields. The command you give a capture's replay or blame, and the one a [project's](#projects) setup records, are placed only after `--`, split without a shell, and a project's asks before it first runs in a folder.
- **Downloads.** A download is only a file a job reported writing, only from inside the project folder (checked again when you download it, links followed), and always saved rather than opened. Uploaded files stay inside the project folder, and are deleted as [Files you upload](#files-you-upload) describes.
- **Read-only.** A read-only dashboard refuses every request that would change something.
- **Nothing from the network.** The page loads nothing from the network (fonts are bundled), and runs under a Content-Security-Policy that allows only its own script.

To use it on a remote machine, forward the port over SSH rather than binding it to a public interface:

```sh
ssh -L 4777:127.0.0.1:4777 host
```

Closing the terminal stops the dashboard and its jobs. To keep it running after you log out, start it inside `tmux` or `screen`.

**Consent.** Some actions ask before they run. Each is described with its action:

- [The command that starts your agent](#the-command-that-starts-your-agent) is asked about the first time it runs in a folder.
- [Commands from someone else](#commands-from-someone-else) (a pack's, a teammate's, a program's) run only once you confirm the exact lines.
- **Run repair** and **Apply fix** ask first: see [Actions on a fix](#actions-on-a-fix).
- **Update golden** asks first, and so does a test session that runs goldens live: see [Actions on Tests](#actions-on-tests).
- **Delete N runs** and **Free 53.5 MB** ask first: see [Actions in Settings](#actions-in-settings).
- **Also delete its recordings** asks you to type the project's name: see [Removing a project](#removing-a-project).

## Large stores and long runs

How the dashboard works through a large store or a long run: on which threads, and in what order.

### Worker threads

What reads every call of a run, or every run, is worked out on two threads beside the server's own. Each reads the store through a connection of its own that only reads. Every other request is answered meanwhile, so the status bar and the page you are on never wait for them.

The work done on those threads:

- the Overview, and the totals the Runs table filters and sorts by;
- a run's page and its calls, its Provenance, and what a run's untrusted reads are;
- Compare, and what a fork did differently;
- a fix's page and its attempt groups;
- the activity feed, and a search;
- Settings → Tools' list;
- what the project switcher and a project's setup count of its store;
- Training's pairs, and Copy JSON.

**Spare threads.** While every thread is busy, a spare thread answers what comes behind them. Each ends once it has had nothing to do for a while.

- **Behind requests** that hold every thread (two whole Compares of long runs), it starts after half a second.
- **Behind what can wait** (a long run's whole analysis, the warm-up), it starts at once, and a second may start in place of the thread that work holds. Once that work has held its thread half a second, and requests hold the others, the spare starts ahead, ready for what comes.
- **What waits** goes to whichever thread is free first, a spare one once it has started: what has waited longest first, a request that reads a run over 20,000 calls after the rest.

**A run keeps its thread.** A run stays with the thread that read it, which keeps it, and a request about it goes there.

- While that thread is busy with another request, a free thread takes one about the run after a tenth of a second. One about a run of 20,000 calls or fewer is taken at once while that other request reads a longer run (a whole Compare of long runs).
- A request that reads the whole of a run over 20,000 calls waits for that thread up to 5 s (half a second while it does what can wait), rather than read the run again on another.
- Past that, another thread takes it and keeps the run, and the run's requests waiting for the first thread follow it there.
- The warm-up works on the thread that answered a request least lately, so the run you are reading keeps the thread that holds it.

**Work that takes too long.** A job that runs past its time is stopped with its thread. A request has two minutes per 50,000 calls of the runs it reads, at least two, and what can wait (a long run's whole analysis) ten. Its page says it took too long rather than wait for good, and another thread takes what comes after.

**Writes have threads of their own:**

- The search index is kept up to date on a thread of its own.
- Runs are deleted on one of their own, through a connection of its own.
- What the threads work out to keep (each run's totals, what its user asked) is written on another.
- The counts the status bar polls for take in only what was written since: the calls a recording added, and the runs started, ended or labelled, as the store's log of runs written names them.

### Totals

Each finished run's totals (what it spent, its calls, what its user asked first) are worked out once in the store's life, newest first. They are kept in the store by a thread of their own, so a write never holds the server's. While another command is writing the store (the search index, a recording, `gc`), they wait, and are kept once it is done. What one thread worked out, another reads from the store.

**On a store no dashboard has opened yet**, the Overview says how many runs are added up so far, until they all are, and every other page works meanwhile. Until then, the Runs table filters by the about lines known so far, and sorts by what the runs known so far spent. It says how many that is, and reads its first page again as more are known.

**A row** adds up its own run's totals as it is asked for only when that is quick (5,000 calls a request in all):

- A longer run's row shows at once, with its spend as … and its strip empty, and the table and the sidebar ask again until the warm-up has them.
- A long recording's about line quotes its first calls until then.

**The Overview** works the same way at any time. A short run that just ended is added up as it asks. A long one that isn't yet (its prompt cache, say) has the Overview say how far the runs are added up, and the warm-up go through them again, rather than read every call of that run while you wait.

### A long run's calls come a page at a time

A run's page comes with the first page of its calls, how many it has, and every call's origin. The page lists every call at once, those not read yet as their number and origin. It reads pages in this order:

1. the page of the call it opens on (a link, the fork, the lost call);
2. the page of any call you go to;
3. the rest in order, one page at a time.

While it reads:

- **A call deep in a long run**: while the dashboard is still analysing the run, the page of such a call comes at once from the calls around it, without its conversations' numbers. It is read again with them, in order.
- **Scrolling**: a page on its way is never asked for again. While one is, a scroll asks for the page where it stops rather than one for every step, and the pages read in order wait until it has stopped.
- **Progress**: a line under the view says how many are read, and that a filter, a scope or another view shows those read so far.
- **A page that can't be read** (the dashboard stopped, a server too busy) is tried again a second later, then two, up to thirty, or at once when you pick a call.
- **A run deleted while its page is open** is read no further, and the page says it is no longer in the store.

A run that ended with 1,000 calls or more is answered from its first calls. What its page says of the whole run (its numbers, the strip, its models, blame's step) is worked out without reading the rest.

A recording's page is read the same way, following its newest call:

- Opened from a link that names no call (Watch live, Runs, the sidebar), it opens at its newest call by its count, not the last of the calls read, and reads that page first.
- The calls it makes are read as they come, one page at a time, the selection following them.
- A call read before it was answered is read again with them.

An exported copy holds every call.

### Each page's code loads when it opens

The dashboard's first script holds the shell and what the pages share. The rest loads the first time it is needed:

- **A page's own code** loads when you first open the page, which waits empty until it comes. Opening a page loads nothing more.
- **A run's views but Calls** each have a script of their own. They load once the pointer or the focus reaches the Views tabs, or the view first changes, so switching to one draws it at once.
- **What a run's page rarely opens** has a script of its own too: a finding's diff, Edit and fork…, Run blame's check, Find breaking commit… and Delete run. Each loads the first time it opens.
- **The check builder** has a script of its own, asked for as its menu opens, or as the pointer or the focus reaches the inspector's **Add check…**. A builder whose script can't be loaded says so in a small dialog in its place, with **Retry**.
- **Changes' tabs**: Verdicts and a revision's page each have a script of their own, and so does Compare. Changes' head and tabs come with the page, and stay while a tab's script loads.
- **A script that can't be loaded** (the dashboard stopped, or was updated since the page opened) leaves a line that says so under the page's title, or in the view. Its **Retry** loads the page again, since a browser never asks twice for a script that failed, and waits while the server can't be reached.

An exported copy is one script, built apart with only what a copy shows: its runs, a run's page with every view, and Compare between them.


## How the page stays current

The server keeps a change feed: one small endpoint that says what changed since the page last asked. So a page that polls it fetches again only what moved:

| What changed | What the page fetches again |
| --- | --- |
| A run added, ended, labelled or deleted, by the dashboard, the CLI or another dashboard | The run list |
| Calls arriving | The recording that is growing, with its count |
| A command's activity entry | The feed |
| A job starting, ending or reporting what it made | The jobs |

A running job's output is not in the feed: the drawer follows it from the job itself, from the last line it has. The store counts its own writes, so asking costs almost nothing, even with a recording in progress.

A run's page asks for the run again only when runs move, or, while it records, when its own calls do:

- **A finished run's page** fetches nothing while another run records.
- **A recording's page** fetches only the calls after those that won't change (`?after=`): from the first still on its way, or answered with a failure the agent may retry, which its retry answers again under the same number.
- **A recording too long for one page** takes its count from the feed, and the calls it adds a page at a time. Its page, which works out the whole run, is asked again no sooner than ten times as long as it last took, and at once when it ends.
- **A run the page already has**, asked again, is answered 304 from where it stands (the rows of its family, its calls, its state, the fixes), without being worked out again. So another run starting or ending doesn't send it again.

For a recording, the server reads and places in conversations only the calls that arrived since it last looked, so following a run of 50,000 calls costs what its newest calls cost. A call that feeds the model call after it waits for that call to arrive, and the run is worked out whole once it ends.

## HTTP API

The page reads and changes the store through the dashboard server's HTTP API. This section lists its endpoints by area, then the [job kinds](#job-kinds) and the [job events](#job-events). Where the code for each lives is under [For contributors](#for-contributors).

### Requests

Every request needs the session token in `x-shadowlap-token`.

- **The project.** With several projects, a page sends the project it shows in `x-shadowlap-project`. A request that changes something while another project is current answers 409 with `current` (`{ id, name }`). Switching, adding and removing a project, and stopping a job, are the exceptions: they name what they act on.
- **A job's project.** A job's view names the project it runs in (`project`).
- **Not found.** A read of something the store doesn't hold is a 404 with `{ error }`. The page asks its reads with `x-shadowlap-not-found: answer`, and gets a 200 with `{ error, notFound: true }` instead, as it says what is missing itself, and the browser would log the 404 as a failed load.

### The dashboard and its feed

| Endpoint | What it answers |
| --- | --- |
| `GET /api/meta` | Version, store and its size, address, read-only and why, runs and attempts counted apart, live runs, job kinds, project folder |
| `GET /api/changes?since=<cursor>` | What changed since the cursor: runs, calls, activity, jobs, and the live runs with their call counts and call events (starts and answers) |
| `GET /api/activity?limit=&before=` | The activity feed, newest first, `limit` entries a page |
| `GET /api/summary?tz=` | The Overview, in the viewer's time zone (IANA, UTC without one) |
| `GET /api/search?q&limit` | What runs recorded that matches every word, at most two hits a run |
| `GET /api/files/:fileId` | A file a job wrote, as an attachment |
| `POST /api/uploads` | A file for a job of the current project (raw body, name in `x-filename`); answers its `uploadId` |

- **`/api/activity`**: pass `next` (opaque) as `before` for the page after, or a time in milliseconds for everything older.
- **`/api/summary`** gives each grid row's and each recording in progress's `about` line, and a failed run's never blamed in Needs a look, as `/api/runs` gives it. Until the totals of the runs it adds up are kept, it answers `{ warming: { done, total } }` at once.

**Search** (`/api/search`): hits from recordings, forks, tests and captures come first, then hits from attempts of a run with none of its own, each naming that run (`attemptOf`). It answers from what the index holds, once it has taken in what runs still recording said since the last search (20 ms at most, waited for 0.3 s at most). While the index catches up, `indexing` says how many runs it has yet to read, of how many.

### Runs

| Endpoint | What it does |
| --- | --- |
| `GET /api/runs`, `/api/runs/:id[?after=<n>]`, `/calls/:n`, `/lineage`, `/export` | Runs; one run (with `after`, only its calls numbered after `n`, for a recording's page); one call; its family; the HTML download |
| `GET /api/runs/:id/calls?from=&limit=&whole=` | A page of a run's calls from call `from` on, `limit` of them (500 at most): `calls`, `callsTotal`, `callsNext` |
| `GET /api/runs/page?limit&cursor&from&to&types&q&sort` | A page of the Runs table (at most 500 rows), each row with its `about` line |
| `GET /api/runs/days?weeks&tz&types&q` | Runs per day for the twelve weeks above Runs' table, in the viewer's days |
| `GET /api/runs/bisect?from&to&types&q` | Find breaking commit for the days picked: their first failure, and what bisect can start from |
| `POST /api/runs/labels { ids, add, remove }`, `POST /api/runs/delete { ids }` | Label or delete several runs at once, by their full ids |
| `POST /api/runs/known { ids }` | Which of these runs are still in the store (changes nothing, so a read-only dashboard answers it too) |
| `POST /api/runs/:id/labels`, `/notes`; `DELETE /api/runs/:id` | Changes to a run |
| `GET /api/runs/:id/provenance`, `/show` | The run's record for Provenance, with what a copy made at this point would mask; `shadowlap show --json` as the CLI prints it |
| `GET /api/runs/:id/unrecorded` | The tools the model called that the run never recorded, read beside the server from every model call's answer |
| `GET /api/runs/:id/differences` | What a fork did differently from its parent (`null` for a run that is no fork of a run in the store) |
| `GET /api/runs/:id/outcome` | The run's outcome by checks, each check with it ([Judged by checks](#judged-by-checks)) |
| `GET /api/runs/:id/next` | The run's next step alone, whole, with what it bills: what its page's answer leaves out rather than read a long run's calls |
| `GET /api/runs/:id/estimates?at=&model=` | What Run blame and each fork menu row at call `at` bill, by the row's key; without `at`, the whole run's rows |
| `GET /api/runs/:id/offers` | What the run's page offers |
| `GET /api/search?q=`, `GET /api/compare?a=&b=[&part=head]` | Search recorded content; compare two runs |

**A run** (`/api/runs/:id`) comes with the first page of its calls (500 at most), `callsTotal`, `callsNext` (where the next page starts, or `null`) and, while more are to come, `origins`: every call's origin, one character per call, as the run list encodes them. Beside it, `kinds` says what every call was, for a recording's strip: `m` a model call, `r` a read, `w` a write, `e` an error.

- **A long run**: one that ended with 1,000 calls or more is answered from its first 200, and says `warming: { done, total }` while the whole run is analysed. Asked again, it says the same of the same calls.
- **Its about line**: each run, in the list, on its own and in its family, carries its `about` line. That is its `text`, where it comes from (`from`: `user`, `agent`, `input`, `golden`, `change`, `nothing`, `source` or `command`), and for a replay or a fork its `change` (the flag, the call it changed and where it forked).
- **A preset's attempt** in the family carries its `preset`: the preset's words, and the verdict of the session that decided it.
- **Its state**: a run's `state` (kind, outcome, failed, interrupted) is the one the run list works out for it, and its status is the list's. A run its recorder left running reads `crashed`, ended at its last call.
- **Its outcome by checks**: `judged` says what judged it (`by`: `own`, `import` or `family`), its `verdict`, the checks' `counts`, the `callNo` it turned on, the `first` check that failed, `today`, `since`, the `goldens` and `why`. It is `null` when no check judges the run. The page's answer and Runs' rows add each of `checks`; the sidebar's rows leave them out.
- **A judge check's verdict**: each judge check in `checks` carries its `judge`, with the `verdict` (null for none), its `source`, `cost` and `model`, what was done to what it read (`redactions`, `cut`) and the judge's call in the run (`callNo`).
- **Its agent's exit**: a test replay its agent's exit failed carries `exitCode` where its test result kept the code.
- **Its next step**: `next` is what its header leads with ([The next step](#the-next-step)): its `key`, `label`, `href` for a link, `off` for why it can't start, the hover's `title` and `sub`, the `command` it runs and `estimate`, what it bills. `later` says this answer left out what would read a long run's calls, which `/api/runs/:id/next` answers with.
- **A crash's next step**: `blame` is the Run blame beside it, its `offer`, `sub`, `command` and `estimate`.
- **A list's rows** carry `next` too, with only `key`, `label`, `href`, `off`, `title`, `command` and `capture` (a capture's Run blame, which asks for your command on its page), as a list reads no run's calls for it.
- **Its estimates**: `/api/runs/:id/estimates` answers `blame` and `actions`, each the engine's estimate of the job as it runs, worked out beside the server. A row that runs nothing live is Free, such as Repeat on a recording, and one with nothing to bill has none: Replay, a normalizer, Pack. `model` prices Switch model at that model; without it, as recorded.
- **Its Replay**: `replay` is what its Replay button replays: `label` and `runId`, with the `action` that asks for your command where that run has none.
- **Its family**: each run of the family carries the same `status`, `kind`, `outcome` and `failed`, an attempt the list leaves out included. The HTML file holds such a run the same way.
- **Its calls**: a call row carries `via` for a model call made to a host of another provider's format (the host; `provider` is then its format), and `extraRead` for a replay's extra read.
- **Its WebSockets**: a run carries its `websockets` (`target`, `count`, `action`: `tunnelled` or `refused`) when it keeps them.
- **The download** is made on a thread of its own. A run still recording is a 409, one that takes more than two minutes a 422 naming the likely rule, and other downloads being made or a store another command holds a 503.

**A page of calls.** While a long run that ended is analysed, a page past its first 2,000 calls comes at once from the calls around it, 200 before to 100 after, and says so (`around: { from, to }`). Each call's `conversation` is then `null`, as conversations are numbered from the run's first call. `whole=1` waits for the analysis and has every fact. `/api/runs/:id/calls/:n` takes `whole=1` the same way.

**The Runs table.** `q` matches every word in a run's id, about line, labels, command, source or revision, and `label:<name>` the runs with that label exactly. Pass `next` as `cursor` for the page after. While the about lines `q` reads, or the totals `sort=spent` reads, are still being worked out, it answers from those known and says `warming: { done, total }`.

**Find breaking commit for days.** When the first failure failed at the first commit, with nothing before it to search, `/api/runs/bisect` gives the first that started later, with the one passed over and why in `earlier`.

**Provenance** gives what a copy made at this point would mask:

- `mask.values`, as the redaction preview counts it for a pack, read on a thread of its own;
- `mask.returned`, when there are any: what a path rule masks in what calls got back, which only `export html` and `dataset` mask;
- `mask.unmasked`, when there are any: the values the rules match that a pack leaves as they are;
- null with `mask.why` when a rule took too long or the run was read only in part, and with `mask.busy` when the preview threads were busy, to ask again.

**Unrecorded tools**: each with its `name`, `count`, `firstCallNo`, `effect` (`write`, `read` or `unknown`, as the config's `tools.unrecorded` declares it or a built-in's or its name says) and `why`; and `partial`, for a run that holds its model calls alone.

**Differences**:

- `from`, the call it left its parent at;
- each change with its `rank` (as [`decisions`](./decisions.md) ranks one), `kind`, `tool`, `detail`, the parent's side and the fork's (`before`, `after`) and the call in each run;
- how each run `ended`;
- the fork's `writes`, each with its `fate`.

**Offers**: how many redaction rules each copy applies, where the run stands with the team store, whether Run blame applies (and the check it would likely use), and Find breaking commit's revisions. For a test that diverged, the actions it offers, or that its normalizer was added and the replay that passed since.

**Compare.** `part=head` answers at once with what the page shows while the whole comparison is worked out:

- `a` and `b`, each `runId` and `calls`;
- `identicalPrefix`, and `firstRequestDifference` as the whole comparison has it;
- `onlyInA` and `onlyInB`;
- `answersDiffer`: the calls before the first request that differs that got another answer to the same request.

It is `null` when that would mean reading more than 16 pairs of requests whole: calls whose fingerprints differ and that no replay served from one another, as in runs fingerprinted under other normalizers.

### Jobs

| Endpoint | What it does |
| --- | --- |
| `POST /api/jobs { kind, … }` | Start a job of a registered kind (`/api/meta` lists them; [Job kinds](#job-kinds) describes each), with the `estimate` its page showed |
| `POST /api/jobs { kind: "export-html" \| "export-har" \| "pack" \| "export-dataset" \| "export-otel", … }` | The Share menu's copies |
| `POST /api/runs/:id/actions` | A run action the terminal UI shares, as the `action` job kind starts it |
| `GET /api/jobs`, `GET /api/jobs/:id?after=n`, `POST /api/jobs/:id/stop` | Recent jobs (without output or result); one job's output from line `n`, its runs, links, files and result; stop it, with its agent |

**A job's estimate.** `estimate` is the price its page showed: `usd`, `ceiling`, and where they apply `per` and `stops`. The job keeps it, and both `GET` routes answer it, so its drawer says what its card and its ask said. One of another shape is dropped, and the job still starts. Nothing reads it to decide what runs, and it never reaches the command line.

**The Share menu's copies** take `{ runId }`, a pack's `{ runId, dir }`, a dataset's `{ runIds, format, calls }`, or a trace's `{ runId, endpoint }` or `{ runId, out }`. A run still recording is refused (409). One its recorder left running is copied as interrupted, ended at its last call, the store left as it is.

**Someone else's command.** A replay of a run from someone else's pack, the team store or a program that sent the sidecar its command starts only with `yes` set to a `confirm`. That is the `confirm` of the 409 that named both its command and the `shadowlap` line, whatever `value` says. The upload is kept for the request that says yes.

### Fixes

| Endpoint | What it does |
| --- | --- |
| `GET /api/fixes?status=` | The fixes (all, open, verified or applied) in to-do order, with each chip's count, the page's totals and the failing runs nobody has blamed |
| `GET /api/fixes/:id`; `PUT /api/fixes/:id/title` | One fix, by its id or a prefix, with its three steps; its title |
| `GET /api/fixes/:id/groups` | A fix's attempts grouped by what each did |
| `GET /api/fixes/:id/estimates?model=` | What Run repair, Run blame again or with a stronger model, and each Verify step's more attempts bill |
| `GET /api/fixes/family/:runId` | The attempts blame and verify made in a run's family, bundled per probe and per verified run |

- **Groups**: for its blame's probes and for each verified run, each group's `path` (the tool calls from where the attempts left the run), `verdict`, `count`, `why` (the first failure), and an `example` attempt to open.
- **Its estimates**: `repair`, `blameAgain`, `blameStronger`, and `verify` by each verdict's id, worked out beside the server for what the page offers. Run repair prices a blame only of a failing run whose blame it can't reuse, and is Free where it ends "No fix to try". `model` prices the stronger model; without it, `claude-opus-5-5`.
- **A run's family**: each bundle with the fix step it leads to, its verdict as a gate's is said (`verdictLine`: the word, the tally and the bound), its `tone`, and the `rule` it was decided by.

### Tests and CI

| Endpoint | What it does |
| --- | --- |
| `GET /api/tests` | The Tests screen |
| `GET /api/tests/gate?good=&bad=&risk=&max=`, `?baseline=history&drop=&window=&min=&max=&history=47/50` | What a [gate](./gating.md)'s figures would do |
| `GET /api/tests/runs/:id?before=<ms>` | For a run's page: the diverged-test banner of a replay `shadowlap test` made, and Find breaking commit's choices |
| `GET /api/tests/estimates?update=` | What Run tests and each golden's buttons bill, and Update goldens for the goldens `update` names |
| `GET /api/tests/evidence?golden=` | A gated golden's attempts, each judged from its run, those carried over first |
| `GET /api/estimates/bisect?runId=\|golden=&good=&bad=` | What Find breaking commit bills, on a run or a golden, from `good` up to `bad` |
| `GET /api/ci/workflows?fix=&alerts=&budget=&repairer=&onlyMain=&secret=&inconclusive=` | Settings → CI: your workflow for those options |

**The Tests screen** (`/api/tests`) holds:

- the goldens on disk;
- the verdict of their last results, with the line of the newest session that ran them all (`session`, with `live` while its process runs), and what ran since on its own (`since`);
- inconclusive goldens counted apart (`inconclusive`);
- each golden's history by revision: each cell's `verdict`, its pass `rate` as passes of attempts, the `bound` its gate put on that rate, and `dropped` where a [gate](./gating.md) against history found a drop, with what it compared (`drop`);
- each revision's commit as git has it (`revisionFacts`): its `subject`, and its author (`by`) only where names show;
- `older` when the session the verdict names tested a clean commit and the working tree changed since;
- each golden that didn't pass, by its path, with the step its replay's page leads with (`steps`): `run-tests` names the checks `gone`, and `edit-check` the `check` its recording fails;
- whether a golden has an injection test, which runs live (`injection`);
- each golden's checks as its last result came out on each (`checkResults`, below);
- the checks a golden's last result failed or couldn't decide that the config no longer holds (`changed`: each a `label` and its `status`), null for none;
- each golden's `gate`, and what it decided last (`last.gate`, below);
- each golden's error-path `presets` as their last session left them: `null` when none ran, else their verdict, how many ran, passed, failed and were inconclusive, a `line`, and the attempt to open;
- the divergences and other failures as the CLI printed them, each with Find breaking commit's range, and what it last said about this failure (`found`, or `missed` with why and its `outcome`);
- the commits Find breaking commit's dialog offers (`revisions`), each with its subject and its tally there (`rate`: `passes` of `attempts`), and for a golden that never passed, the commits before its failure that no session tested (`untested`, each a `rev` and `subject`);
- for a divergence on values that change every run, the `normalize add` arguments of each rule the config lacks (`newRules`);
- the inconclusive goldens apart from them, with `judge` (below);
- a test session in progress wherever it was started (`running`), with the session's counts `passed`, `failed` and `inconclusive`, by each result's verdict;
- where that session has got (`following`): `whole` when it runs every golden, the `total` it runs, how many it has `reached`, and each golden as `passed`, `failed`, `inconclusive`, `running`, `between` its turns or `queued`;
- error-path presets on goldens in progress wherever they were started, a terminal, another dashboard or a job (`chaosRunning`: the session's `id`, `command` and `startedAt`);
- and the commands.

`checkResults` holds, for each check:

- the label;
- the `status`: null before a result, when that test couldn't run the golden, or for a check `added` to the config since;
- for a check the check builder added since, when (`addedAt`, in ms), from the [activity](#activity) entry that added it;
- the `detail`;
- a judge's `reason` and `source`, and for a verdict asked live, `live`: what asking it `cost`, and in how many attempts it was `asked`, null when that isn't known;
- a judge check's `judge`: what it asks (`question`) and its `model` as the golden's entry holds them, the `verdict` its last result kept, and where that came from in the CLI's words (`judged`: `how`, `cost` and `read`);
- over several attempts, `attempts`: how many of those that judged it `passed` it, `of` how many. It is null for one attempt, when an attempt's run is gone, or when attempts were carried over from an earlier session.

`last.gate` holds:

- its decision, and the `rule` it was decided by;
- each attempt's outcome, the interval, and its `bound` with the `method` it was worked out by;
- the attempts, and the evidence path of scores against both bounds, or, for a gate against history, the chance of a drop after each attempt;
- the cost of an attempt;
- when inconclusive, Run more attempts as `more`: the `test` job that continues it to twice its limit, carrying its attempts over, with the attempts that adds on average, how often it then settles, and what that would cost.

`judge` is on an inconclusive golden whose judge check had no verdict it could use:

- its name and model, and why;
- what its pack `held`: `none`; `older`, a verdict given to an older form of the judge's request; or `material`, one given on other material, with where it `changed`;
- what settles it: `update` for a golden that replays offline, or the `keys` its provider reads for one that forks.

**A golden's evidence** (`/api/tests/evidence?golden=`): asked when the row under a gated golden opens, never with the page. It answers `attempts` (each with `runId`, `outcome` and a `note` from its failed check), `carried` (how many came from the sessions Run more attempts continued) and `gone` (runs no longer in the store, left out).

An attempt the provider cut short is `inconclusive`, never the agent's failure; one it was unavailable for, retried and never counted, is left out. A golden not on disk is a 400, and one no gate decided a 404. Each gated result in `/api/tests` carries the evidence's words in `gate.words`.

**Gate figures** (`/api/tests/gate`):

- the rule its verdicts state (`description`, `tells 90%+ from 70%- at <= 5% risk, up to 80 attempts`);
- the attempts an agent that always passes needs, and one that always fails;
- the exact odds of each verdict, and the attempts on average, at six pass rates;
- how often 100 forked goldens of a healthy agent turn a CI run red under `--inconclusive fail` and `warn` (`ci`);
- the defaults.

A gate against history is figured at seven pass rates against the baseline `history` names, 47 of 50 unless given: the chance it fails at each of those pass rates is its power to catch a drop. Figures the config would refuse are a 400 with its message.

**A run's test** (`/api/tests/runs/:id`): the diverged-test banner has `rulesAdded` once the config has its rules. Find breaking commit's choices are the target, good and bad commits, revisions to pick from with their subjects, the check a run is judged by in `expect`, whether it costs tokens, or why it can't start. `before` limits the good commits to runs before it.

**Their estimates** are the engine's for each job as it runs, worked out beside the server:

- `/api/tests/estimates` answers `run` for Run tests, and each golden's `rerun`, `update`, `more` and `normalize` by its path. A golden that runs live in any way is never Free: one marked fork, or with an injection gate, has no estimate until it has run once. Run tests is what each golden it runs live spent the last time it ran.
- `update`, given once for each golden, adds `update` to the answer: what Update goldens bills for those goldens together. A path that isn't a golden on disk is left out.
- `/api/estimates/bisect` counts the commits with git, as the job would search them. It has no estimate until `good` names a commit. A search the job would refuse has none, with why.

**Your workflow** (`/api/ci/workflows`) takes its options: `fix`, `alerts` and `onlyMain` on or off, `budget` in dollars, `repairer` as `repair --repairer` takes it, `secret` the webhook secret's name, and `inconclusive` fail or warn. It answers with one job that runs the goldens once (`workflow`), what it needs, and for each part its own step and a preview of what lands. Whether the step pushes is no option: it follows Push from CI in `shadowlap.config.json`, read as `/settings/store` reads it (`fixOnFailure.teamStore`).

### Settings

| Endpoint | What it does |
| --- | --- |
| `GET /api/settings/matching`, `/redaction[?run=]`, `/redaction/preview?run=`, `/agents`, `/tools`, `/tools/mcp?command=\|url=`, `/project`, `/store` | Settings, one read per tab; a tab that edits the config also gets its `version` |
| `POST /api/settings/rules/normalize\|redact`, `DELETE /api/settings/rules/:list/:n?expect=`, `PUT /api/settings/clock`, `PUT /api/settings/store/ci-push`, `POST /api/settings/calibrate/write` | Changes to `shadowlap.config.json`, each with the `version` it read as `expect`; the last adds what a calibrate job proposed |
| `GET /api/user/spending`, `PUT /api/user/spending { askAbove }` | Spending, yours on every project: the amount above which a billed job asks first; a change answers what it was (`was`), for Undo |

- **`/agents`** also carries `skill`: the [skills](./agents.md#the-skills) with their commands, and what the project has of the Claude Code plugin and of the skills in `.agents/skills`. Each has its `state`, its `installedVersion` and the `install` a click runs (`null` where there is nothing to install). It also says which of Claude Code's settings files turns on the plugin installed from its marketplace.
- **The preview** masks one run as a pack would (`redact preview --json`, each rule's `returned` and `unmasked` included), read on a thread of its own within limits. A rule that takes too long on one call is a 422; other previews being read, or a store another command holds, a 503.
- **A change** to a file changed since is a 409, and a rule the CLI refuses a 400.
- **Spending** (`askAbove`) is in dollars: a billed job asks first when its estimate is above it, so 0 asks of every job that bills. With `null`, Never ask, no amount asks. A job with no estimate still asks, as do a form, a price per unit and a job that asks for what it does, such as Run repair.
- **Where it is kept**: it is kept in `settings.json` under `SHADOWLAP_HOME` (else `~/.shadowlap`), never in `shadowlap.config.json`, so CI and teammates never take it on. A page showing another project may change it. An amount that isn't whole cents is a 400, and a file it would lose something of, such as a newer Shadowlap's, a 409.

### Checks

The check builder reads a golden's checks from `shadowlap.config.json`, judges a draft on the agent's recordings and writes the golden's checks back.

| Endpoint | What it does |
| --- | --- |
| `GET /api/checks/goldens?run=<id>\|golden=<path>` | The agent's goldens with their tests entries as written, the file's `version`, `read` and whether a write lays out other lines anew (`relaid`) |
| `GET /api/checks/context?run=<id>&at=<n>` | What the run offers a check made from call `n`: each tool by its first call, the tools before it, the results' number fields |
| `POST /api/checks/preview { expect, run \| golden }` | The draft judged on the agent's 200 newest recordings, its goldens' and the run's, as [`shadowlap check`](./cli.md#check) judges them |
| `PUT /api/checks/tests { golden, version, read, entry }` | The golden's checks: `entry.expect` set, or taken out with `null` |
| `POST /api/checks/tests/undo { was }` | Puts back what the write that answered `was` changed |

- **Reads beside the server.** The context and the preview are worked out beside the server, as they read the run's calls or every recording of the agent. The preview changes nothing. A golden whose recording is only in its pack is read from the pack there.
- **A write** names the `version` it read and sends back `read`. A file changed since is a 409 that names what changed, such as `"prices" added`. A check `shadowlap test` would refuse is a 400 in its words. As the whole of `tests` is checked, that can name another golden's entry.
- **A golden that follows a pattern**, such as `goldens/refund-*`, gets an entry of its own with the pattern's other keys. The pattern stays for its other goldens.
- **The answer** is `{ key, version, added, removed, changed, was }`: the key written, the file's version after, and the labels of the checks added and removed. A write that changes the file lands in the activity feed.
- **Undo** sends the write's `was`. The server holds the entry as the write found it and puts it back, deleting an entry the write gave a pattern's golden. It writes only against the version the write left, so a file changed since is a 409 and the edit there stays.

### Projects and setup

| Endpoint | What it does |
| --- | --- |
| `GET /api/projects`; `POST /api/projects/:id/select` | The switcher: every project with its path, runs and setup; switch to one |
| `GET /api/projects/folders?q=&pick=`; `POST /api/projects { path }` | Folder suggestions for a typed path, the picked one checked; add a folder and switch to it |
| `GET /api/projects/:id/remove`; `POST /api/projects/:id/remove { deleteRecordings?, name? }` | What the Remove dialog shows; remove the project, deleting its store only when `name` matches |
| `GET /api/projects/holding?what=&id=` | Which other project's store holds a run, fix, preview or migration this one doesn't: read-only, beside the server |
| `GET /api/setup`; `POST /api/setup/record { command }`, `/golden { golden }`, `/finish` | The current project's setup; what recording a command runs and whether it asks first; where a golden would go; finish the setup |

`/api/setup/record` and `/golden` change nothing.

### Team store and imports

| Endpoint | What it does |
| --- | --- |
| `GET /api/store` | The team store as this machine knows it (or `null`), and who this machine records as |
| `GET /api/store/setup`, `GET /api/store/setup/url?provider=&url=`, `POST /api/store/setup { ci?, ciProvider?, finished? }` | The store's setup page; a typed URL checked; Push from CI added or skipped, and the setup finished |
| `GET /api/imports` | Whether each trace store's keys are set where the dashboard runs (Langfuse, LangSmith, Phoenix, Logfire), their hosts, and Phoenix's project |

- **The setup page** gives where it stands and the step that is next, each provider with the credentials this machine would use, the CI steps and the commit. A typed URL is checked against the provider picked, with the access to ask for.
- **Imports**: a user name or password in a host is left out.

### Training, decisions, verdicts, injection, presets and coverage

| Endpoint | What it does |
| --- | --- |
| `GET /api/training?filter=all\|high\|medium` | Training: the strip, the pairs grouped per call with their sources and fixes, the goldens as tasks, and each model's scores |
| `GET /api/models` | The models to score, each with its price per attempt and last score, and the picker made from them |
| `GET /api/decisions?kind=decisions\|migrate`, `/api/decisions/:id`, `/api/decisions/:id/estimates?runId=`, `GET /api/runs/:id/decisions`, `GET /api/retirements` | The [decision diff](./decisions.md): its sessions, one session, what its Verify bills, a run's decisions, and the retirement notices |
| `GET /api/verdicts?kind=all\|sessions\|previews\|verifies&limit=`, `/api/verdicts/:rev` | Every change checked and its verdict, newest first; a revision's page |
| `GET /api/injection?run=&golden=&limit=`, `/api/injection/:id`, `/api/injection/:id/report`, `/api/injection/needs-look`, `/api/injection/runs/:id`, `/api/injection/templates`, `/api/injection/tools` | [Injection tests](./injection.md): results, one result, its report, Needs a look, a run's untrusted reads, the templates and the tools |
| `GET /api/chaos`, `/api/chaos/runs/:id` | [Error-path presets](./error-paths.md): the presets and their matrices; one run's matrix |
| `GET /api/coverage` | [Production coverage](./coverage.md): the last `shadowlap coverage` scan and what it found |

**Training.** A task blocked by an early fork comes with what Update golden runs. For `/api/models`, a provider that couldn't be listed is a note, and a read-only dashboard asks none.

**The decision diff:**

- `/api/decisions`: the sessions kept, newest first, with the models the goldens use that retire. Each session's `href` opens Changes (`#/changes/decisions/<id>`, `#/changes/migrate/<id>`).
- `/api/decisions/:id`: one session as `decisions --json` or `migrate --json` printed it, with its `matrix`.
- `/api/decisions/:id/estimates`: what its Verify bills, worked out beside the server. Each run it couldn't clear, or the one `runId` names, is priced in the role its checks give it as recorded, at what it costs under the change. `verify` is `null` when there is nothing to verify.
- `/api/runs/:id/decisions`: a run's decisions under each session that asked it again.
- `/api/retirements`: the retirement notices on their own, for the agent's models, Shadowlap's own judge calls left out.

The `matrix` has a row per run and a cell per model call. Each cell holds:

- its rank: the most consequential change any sample showed, 0 for the same, and `null` for not asked;
- its `majority`, the rank most samples show;
- how many of the samples `answered` and `changed`, for a cell drawn split;
- `judge`, how the judge checks that read a text-only change came out:
  - `inconclusive` when the step waits on a judge (a sample's words could not be judged, and its samples don't flag it without them);
  - else `changed` when one came out otherwise for the changed words (the cell ranks 2);
  - `unchanged` when every one came out as recorded;
  - `null` when none read it.

**Verdicts:**

- `/api/verdicts`: every change checked, newest first, `limit` rows (50 unless given, at most 200) of the chip `kind` names. A change is a revision a test session ran every golden at, a preview or a migration, or a verify a fix keeps.
- Each row gives its verdict as the command that gave it says it (`word`, coloured by `tone`), the `line` under it, what it was `checked` on and what `moved`. It names who made the change (`by`: a commit's author, who ran a preview) only when the project's config names a team store.
- `counts` gives each chip's count, and `lead` the newest revision's verdict. The list reads the newest 200 test sessions, previews and verifies, and `more` says older changes exist.
- `/api/verdicts/:rev` gives a revision's page (`no-revision` for a session that knew none): its goldens as that session judged them, worst first with their notes, and the previews and migrations asked at that revision. `latest` says whether it is the newest revision's, the one the list leads with.

**Injection tests:**

- `/api/injection`: the results kept, newest first, of a run or a golden (`limit` of them, at most 1,000). Each has its counts of attempts that obeyed, were influenced, ignored the payload or were inconclusive, its `verdict`, what its `gate` came to, and its one `line`.
- `/api/injection/:id`: one result as `injection --json` printed it, with its row, and the runs it names that gc has deleted since (`gone`).
- `/api/injection/:id/report`: its security report, an HTML download with the project's redaction rules applied.
- `/api/injection/needs-look`: the newest result of each run or golden that obeyed, was influenced or is inconclusive, for Needs a look.
- `/api/injection/runs/:id`: a run's untrusted reads, its tests and the test it is an attempt of, with the canary and the line that joins the read to the write.
- `/api/injection/templates`: the built-in payload templates, versioned.
- `/api/injection/tools`: every recorded tool with its trust and where that comes from, for Settings → Tools.

**Error-path presets:**

- `/api/chaos`: the presets; a matrix for every recording they ran on, newest first; and the newest sessions, each with `live` while its process runs.
- `/api/chaos/runs/:id`: one run's matrix, or for a preset's attempt the matrix of the session that decided it, on its recording (`null` when no preset ran on either).

A matrix has a cell per preset: its verdict, the call it hit, passes and attempts, why, each attempt's run and verdict, and the preset's gate. A cell is inconclusive when its replay never reached the call, or only a check no attempt can decide held it back. Each attempt in a cell carries why it failed or couldn't say (`reason`).

**Production coverage** gives:

- the last `shadowlap coverage` scan as it was kept (`scan`, `null` when none ran);
- the imported runs that came in after it (`newRuns`);
- each behaviour it found, not covered first, with the goldens that cover it, its runs, the nearest golden, and what Pack one runs (`pack`);
- the count not covered, and the line Needs a look shows;
- the `commands` that scan again and pack.

### Job kinds

`POST /api/jobs` starts a job of one of these kinds:

| Job | What it runs |
| --- | --- |
| `action { runId, key, callNo?, value?, yes? }` | A run action the terminal UI shares: replay, the fork menu, repeat, pack, the suggested normalizer |
| `apply { fixId, names? }` | [`fix apply`](./cli.md#fix): a verified fix's patch into the working tree, its goldens named by their runs as `names` says, and tested |
| `bisect { golden \| runId, good, bad? }` | Find breaking commit |
| `blame { runId, expect?, command?, yes? }` | Blame with the check given, else the one it was judged by, else a 422 that asks for it. A capture takes your `command` |
| `blame { fixId, again: true, yes? }`, `blame { fixId, model, yes? }` | An open fix's blame again, under its check, when it couldn't settle or stopped part way, or with another model when nothing rescued its run |
| `calibrate { runId?, write? }` | The setup's recording, else the newest finished one made here, unless one is named |
| `chaos { golden, presets?, tool? }` | `test <golden> --chaos` |
| `chaos { runId, presets?, tool?, confirmed? }` | `replay <run> --chaos` |
| `check { expect?, recordings? }` | [`shadowlap check`](./cli.md#check): a check tried on run ids, `label:<name>` or the project's goldens, nothing replayed |
| `coverage {}` | Scan again |
| `coverage-pack { key?, command?, confirmed?, fork?, expect? }` | `coverage --pack` |
| `decisions { runs?, goldens?, model?, set?, from?, scope?, fromCode?, samples?, thenVerify? }` | A decision diff |
| `decisions-verify { sessionId, runId? }` | `decisions --verify` |
| `export-html`, `export-har`, `pack`, `export-dataset`, `export-otel` | The Share menu's copies, as [Jobs](#jobs) describes them |
| `gc { olderThanDays? }` | Always a dry run first; then `gc { confirm }` with that dry run's job id, which deletes exactly the runs it listed |
| `import { format, uploadId }` | An uploaded capture or trace; or `{ format: "langfuse", traceId, host? }`, with `project?` too for `phoenix` |
| `init`, `record { command, confirmed? }` | The setup's inspection, and its first recording |
| `injection { runId \| golden, repeat?, templates?, payloadsUpload?, baselines?, clean?, writes?, liveReads?, yes? }` | `injection <run\|golden> --json` |
| `migrate { to, goldens?, runs?, from?, scope?, set? }` | A migration, every golden unless some are named |
| `normalize-and-test { golden \| runId, path?, yes? }` | A normalizer for each value made anew on every run, then `test` on the golden |
| `override { runId, callNo, uploadId, yes? }` | Edit and fork: `replay --override` of a tool's result or a person's answer, from an upload checked as untrusted data |
| `pack-test { runId?, golden?, yes? }` | Pack, then test: with `runId`, any ended run into `golden`; `yes` answers a recording from elsewhere or a live test. Once packed, the test alone |
| `pairs { format?, minConfidence? }` | Export pairs, written to `.shadowlap/exports/pairs.jsonl` |
| `push { runIds }`, `pull` | Push runs to the team store, or `{ all: true }`; pull from it |
| `repair { fixId, repairer?, yes? }` | An open fix, from its failing and good runs, by the repairer its confirm dialog named |
| `score { model, baseUrl?, attempts?, goldens? }` | 5 or 10 attempts a task, 5 unless given; every ready task unless some are named |
| `share { runId }` | A share link |
| `skill-install { agent, replace? }` | [`skill install`](./cli.md#skill), `--force` with `replace` |
| `store-set { url, provider }` | `store set --check` |
| `task-update { golden, yes? }` | Update golden, from Training |
| `test { golden?, maxAttempts?, continue?, yes? }` | A test session |
| `test-update { goldens, normalize? }` | Re-recorded live with writes stubbed, each replaced when its checks pass; or `{ golden }` |
| `verify { fixId, verifyId, yes? }` | Run more attempts, or Verify again, for a verdict left incomplete |

What some of them do:

- **`blame`**, **`verify`**, **`repair`** and **`apply`** are a fix's jobs. `verify` verifies its runs again from the start, the limit doubled where a gate ran out of attempts, without the budget that stopped it. A `repair` whose repairer `shadowlap.config.json` no longer names is a 409, and nothing runs.
- **`test`**: `maxAttempts` raises each gate's limit for that session (`test --max-attempts`), and `continue` carries an inconclusive gate's attempts over (`test --continue`).
- **`test`** and **`normalize-and-test`** that would run a golden live, one marked `fork` or with an injection gate, start only with `yes`, the `confirm` of the 409 that named those goldens and why, and lists them in `live`; one that only replays needs none. That yes covers only the job's command lines and those goldens, so another session asks again, and so does this one once what goes live changes.
- **`test-update`**: one that replayed clean and lacks a judge's verdict it can use gets the verdict asked and kept instead. With `normalize: true`, it is Add normalizer and update for several goldens: it adds each rule in their divergences' `newRules` once, then updates them all. When none of them diverged on a value that changes every run, it is refused (400).
- **Tests' jobs** (`test`, `test-update`, `bisect`, `normalize-and-test`) run one at a time in a project, and none while a test session or error-path presets on goldens run, wherever they were started: a terminal, another dashboard or a job (409).
- **`chaos` on a golden** is refused with a 409 while a test session, an update or a pack runs, as they are while it runs, or while presets run on goldens, wherever they were started: a terminal, another dashboard or a job.
- **`chaos` on a run** whose command came from a pack, the team store or a program that sent the sidecar its command runs only `confirmed`. That is the `confirm` of the 409 that named both its command and the presets' own line, so a yes to one preset runs no other, and none an injection test.
- **`check`** without run ids, a label or the goldens tries every recording; its result is the report.
- **`coverage-pack`** packs a golden of the behaviour `key` names, or of each no golden covers, reproduced with the agent's command a run here gives or the one typed, which runs only once confirmed. With `fork` and `expect`, it packs a golden that forks. It is refused with a 409 while a test session, an update or another pack runs.
- **`decisions`**: `samples` as [`--samples`](./cli.md#decisions) takes it, 1 included. Without it, each step is asked 3 times under the change and 3 times as recorded, six requests a step.
- **`decisions-verify`** verifies each run the session could not clear under its own checks (its golden's, or for a run named by id, those of the recording it comes from). It runs one verify per set of checks, in the role its recording plays under them, and keeps the result in the session.
- **`injection`** plants the templates (`all`, `none` or their ids) or an uploaded payload file at every untrusted read. With `clean`, a call number (a run only), it tests whether that read caused the run's writes; `writes` picks them by call number.
- **`injection` on a run** whose command came from a pack, the team store or a program that sent the sidecar its command runs only with `yes`. That is the `confirm` of the 409 that named both its command and the test's own line, so a yes to one test runs no other.

### Job events

A command reports to its job by writing one JSON object per line to the descriptor `SHADOWLAP_EVENTS_FD` names (`emitJobEvent` in the CLI does it):

- `{"type":"run","runId":…,"role":"new"|"attempt"}`: a run it started, or an attempt.
- `{"type":"link","label":…,"href":"#/…"}`: where to go next.
- `{"type":"file","path":…,"label":…}`: a file or folder it wrote.
- `{"type":"result","data":…}`: its result.

Outside a dashboard job the variable is unset, and nothing is written.

## For contributors

**Browser tests.** `npm run test:browser` (from `packages/dashboard`) opens the dashboard in Chromium over the whole demo store, built by real commands (`scripts/demo-store.mjs`, or the one `SHADOWLAP_DEMO_DIR` names). It checks it with axe-core for no serious or critical violation:

- on any page, Settings tab, run, view, inspector tab, menu or dialog;
- on Fixes and each fix's steps, the palette, the help menu, and the shortcuts on Overview, Runs, Fixes and Settings;
- on a toast with Undo, or the bar that says the dashboard can't be reached;
- on a page, and a run's view, whose code couldn't be loaded;
- on an exported copy's run, opened from a file;
- on the page that says another project holds a run or a fix, at a laptop's and a phone's width;
- on every page, Settings tab and fix step again, with a few runs and Import capture…, at a phone's width (390 px).

It also checks the contrast of text and of a field's edge, the focus order, the skip link, the focus rings and every overlay's focus. It checks 24 px targets, a phone's width with no label under 11 px, and that every link the server writes opens a page. A page whose code couldn't be loaded must draw once **Retry** loads it again. An exported copy, opened from a file, must draw its run's every view, its runs and Compare without loading a thing or logging an error.

A second dashboard, started in the demo's triage-bot, checks [a link into another project](#a-link-into-another-project). Every run, fix and pair the server's links name is found in support-agent from there, and **Switch to support-agent** opens the run at the same call, its heading taking the focus.

**A large store.** `node scripts/dashboard-scale.mjs --calls 20000 --runs 10000` builds a large store and times what a browser asks for on it; see [Large stores and long runs](#large-stores-and-long-runs).

**Where the code is:**

- **Links**: the server builds its links with `packages/dashboard/src/links.ts`, the builder the page uses too.
- **Attempts**: which runs are attempts is one rule, `packages/engine/src/run-roles.ts`.
- **Endpoints**: the server's endpoints are registered by feature in `packages/dashboard/src/routes/`, and the shapes they answer with are in `packages/dashboard/src/views.ts` and `api.ts`.
- **Shared parts**: a page's header and facts, its sections, statuses, verdict lines, switches, pickers, code boxes, run ids and attempts, and its empty, loading and error states are components in `packages/dashboard/ui/components/`, listed in its `README.md`, with their styles in `ui/css/components.css`. `Term` reads its definitions from `ui/glossary.ts`.
- **Scripts**: `packages/dashboard/ui-bundles.mjs` splits the browser app: a chunk per page (`ui/pages/lazy.tsx`), one per part of a page through `onShow` (`ui/components/OnShow.tsx`), and an exported copy's one script from `ui/main-copy.tsx`. `test/ui-bundle-size.test.ts` holds each to its budget, and fails when a part it lists as heavy loads with a page instead of through `onShow`: Compare, everything under `ui/changes/` but its head, `Head.tsx`, and the check builder, everything under `ui/checks/`.
- **The check builder's script** is handed to a run's page by the served dashboard (`ui/App.tsx`). An exported copy never offers Add check…, so its one script holds none of it.

## Troubleshooting

### The server can't be reached

When the server stops answering (the dashboard was stopped), a row under the top bar says what the page last loaded, that actions are paused, and the command that starts it again. On a phone it is one line, with the rest behind **Why**.

What needs the server waits in its place, dimmed, and a press says why: *Paused until the dashboard server is back*. Reading what was loaded goes on. The page tries again after 5, 10, 20 and then every 30 seconds. A page or a view whose code couldn't be loaded meanwhile says so, and its **Retry** loads the page again once the server is back; see [Each page's code loads when it opens](#each-pages-code-loads-when-it-opens).

### The dashboard refuses the link

A link whose session token the dashboard refuses, one from before a restart or another dashboard's, gets a card that says so, with the command that starts the dashboard and `Paste the new link`. That opens the link the dashboard printed, read from the clipboard, and the page starts again with its token.

### A button is off

A button that is off keeps its place, dimmed. It says why on its card, and in a toast when pressed. The usual reasons:

| Why it is off | What to do |
| --- | --- |
| The dashboard is [read-only](#read-only-mode), or was started without the CLI behind it | Start it with `shadowlap dashboard` |
| A repair or an apply [holds the working tree](#one-job-at-a-time-on-your-working-tree) | Wait until it is done |
| A test job is running in the project | Wait: the button says what is running |
| `shadowlap.config.json` can't be read | Fix the file: **Calibrate** and **Set up team store** come back |
| Repair: `claude` can't be found | Install Claude Code, or set `SHADOWLAP_CLAUDE` to its path |
| Find breaking commit, on a run from someone else's pack | Replay it with your own command first, and find the breaking commit from that run |
| The project's folder is gone | Put the folder back, or remove the project |

### A page took too long

Work on one of the dashboard's threads that runs past its time is stopped, and its page says it took too long. A request has two minutes per 50,000 calls of the runs it reads, at least two, and what can wait ten; see [Large stores and long runs](#large-stores-and-long-runs).

- **Compare**: what came first stays, with the `shadowlap diff` command, which has no time limit.
- **Share → HTML report** on a read-only dashboard: it is stopped, naming the redaction rule most likely at fault. `shadowlap export html` makes it from a terminal.
- **Redaction's preview** of a long run reads up to its limits and says how far it got; `shadowlap redact preview` reads it all.

### The dashboard runs on another machine

Forward its port over SSH (`ssh -L 4777:127.0.0.1:4777 host`) rather than binding it to a public interface, as [Security and consent](#security-and-consent) says. To keep it running after you log out, start it inside `tmux` or `screen`.

## See also

- [Terminal UI](./tui.md): the same runs and actions in the terminal.
- [Interventions](./interventions.md): what each fork in the fork menu does.
- [Blame](./blame.md), [Repair](./repair.md) and [Verify](./verify.md): the steps of a fix.
- [CI](./ci.md): goldens, test history and the workflow Settings → CI builds.
- [Team store](./team.md): sharing runs and fixes across a team.
- [CLI reference](./cli.md#dashboard): every flag of `shadowlap dashboard`.
