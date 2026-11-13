# Terminal UI

`shadowlap ui` works a run through without leaving the terminal. It shows why the run failed, where [blame](./blame.md) found it lost and whether its fix held, and where a fork left its parent and what it then did differently. It shows what each call sent and got back, and forks from the call in front of you.

## Open it

```sh
shadowlap ui                   # the run tree
shadowlap ui <run>             # a run's timeline; a fork opens at its divergence
shadowlap ui <run> --call 17   # opened at call 17
```

`shadowlap search` ends each match with the `shadowlap ui <run> --call <n>` that opens it.

A run's screen: the header and the line under it, the calls on the left, the inspector on the right, and the keys at the foot.

```text
 01M64J4H6F fork @17 of 01M64J4EMP · 32 calls · 15 replayed · 14 live · 2 blocked · 1 overridden · …
 override #16
╭─────────────────────────────────────────────────────╮╭───────────────────────────────────────────╮
│  #15  model -> lookup_policy         replayed   ok  ││  chat  req  resp  meta  diff  verd        │
│  #16  tool  lookup_policy            overridden ok  ││ ✗ Diverged at call 17 (api POST           │
│── forked at #17 · the request changed: $.messages[1…││ /v1/messages): 16 calls replayed before   │
│> #17  model -> queue_status          live       ok  ││ divergence                                │
│  #18  tool  queue_status             live       ok  ││ compared with run 01M64J4EMP, call 17     │
│  #19  model -> escalate              live       ok  ││                                           │
│  #20  tool  escalate                 blocked    ERR ││ ~ $.messages[14].content[0].content       │
╰─────────────────────────────────────────────────────╯╰───────────────────────────────────────────╯
 ? help  : fork  v verdict  d diff  / filter  z zoom  [ ] notable  space play  o dashboard  y copy
```

The [dashboard](./dashboard.md) is the full inspector. `o` opens the run there, at the selected call, for what the terminal UI leaves to it:

- turns, context and cache charts;
- the timeline of what ran in parallel;
- a run's family of forks;
- comparison;
- editing labels and notes, beyond the good/bad key and adding a note.

## Screens

### Runs

The runs screen is the run tree, forks nested under their parents. Each run's row shows:

- **what it is**: `recording`, `fork @3`, `clean replay`;
- **what it was about**, as the dashboard names it, cut in the middle at whole words when it has to be;
- **its `shadowlap test` check results**: `✓ 3/3`, `✗ 2/3`;
- **a status**, when there is one to give;
- **its labels**;
- **the attempts bundled under it**, and theirs in turn, with how many passed kind by kind;
- **its call count, cost and age**.

What a run was about depends on the run: for a recording, the first thing its user asked, from its first model requests; for a fork, the change that made it (`override #16`); for an attempt, which one.

A run's status, when it has one:

| Status                            | Means                                    |
| --------------------------------- | ---------------------------------------- |
| `recording`                       | It is still recording                    |
| `interrupted`                     | Its recorder went away                   |
| `crashed`                         | A signal stopped it                      |
| `failed`                          | It failed                                |
| `lost at #9`                      | Blame found where it was lost            |
| `lost gradually around #8 and #9` | Blame found no one call lost the run     |
| `lost between #7 and #9`          | The probes between them could not decide |

How attempts count:

- `5 attempts, 4 passed` for a `replay --repeat`.
- `12 probes, 3 passed · 6 verify attempts, 6 passed` for blame's and verify's, which count by their own verdicts. An inconclusive attempt, or an unavailable provider, is no failure, and an interrupted attempt counts apart, one whose recorder went away among them.

Attempts are folded under their run, as the dashboard's Runs folds them; `a` lists them one by one. The line under the list has the selected run in full, with its command. `Enter` opens a run.

- **The columns fit the terminal.** In a narrow one, cost, the call count, attempts, labels and age give way, in that order, then the status. The cursor, the run, what it is, what it was about and its checks stay.
- **The part of the ids every listed run shares**, the day they were made, is drawn faint.

### Timeline

A run's timeline has one row per call:

| Column | Shows |
| --- | --- |
| Kind | `model`, `tool`, `clock`, `rand` |
| Scope | Its scope, when the run uses [scopes](./sdk.md#scopes) |
| What the call was | A model call is named by what it did |
| Origin | `live`, `replayed`, `blocked`, `stubbed`, `overridden`, or `injected` for a failure Shadowlap answered with under [`--fail-at`](./interventions.md#inject-a-failure) |
| Outcome | How the call came out |
| Model and tokens | A model call's (`opus-5 · 1.2k in, 40 out`), or a tool's arguments |

A model call is named by what it did: the tools it called (`-> search_web, read_file`), the first words of what it said, `cut off: max_tokens`, or the HTTP status it failed with.

**On a fork**, a line across the list marks where it forked and says what changed there (`── forked at #17 · the request changed: $.system`). The calls replayed before it are drawn quieter than those after.

**On a run blame placed**, a red line marks the call it was lost at (`── lost here · blame, high confidence`). When blame pinned no one call, the line marks the first of the two it was lost gradually around or between (`── lost gradually around #9 and #11 · blame, high confidence`). A blamed run opens there.

The line under the header says what the run was about, then how it stands, in the dashboard's words:

- the check it failed (`check failed: send_email called 1 time, but called 2 times (2 blocked)`), or how it passed;
- where blame found it lost;
- how its fix stands (`fixed: “Ask before emailing the customer twice”, verified`, or `not blamed yet`);
- the tools its model called that the run never recorded.

### Inspector

The inspector shows the selected call, in the call's four tabs and two more:

| Tab            | Shows                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------- |
| *conversation* | The full conversation as sent at the selected call                                                |
| *request*      | The request, structured                                                                           |
| *response*     | The rendered stream, or JSON                                                                      |
| *meta*         | The call's origin, outcome, model, effect, timing, usage and cost, fingerprint, headers and notes |
| *diff*         | On a fork: the divergence report, then what the fork did differently from its parent              |
| *verdict*      | How the run stands, whichever call is selected                                                    |

**conversation** opens on the turns this call added since the model call before it, marked `new`. Tool results that are JSON are laid out as JSON. The tab needs no state reconstruction: every model request carries the whole conversation, so call *k*'s request *is* the state at *k*.

**meta** lists origin, outcome, model and stop reason, effect, latency, usage and cost, size, attempts, fingerprint and the tool's implementation hash, and the error. Then come the response headers and the call's notes.

**diff** starts with the divergence report and its normalizer hint. Then it shows what the fork did differently from its parent from there on, as the dashboard's fork banner says it:

- each run's tool calls from there, compared as one decision and ranked as `shadowlap decisions` ranks a change, a write first (`issue_refund is no longer called`, `search_web is asked differently`), with what each asked before and after;
- whether the fork fails where its parent didn't, or no longer does;
- the fork's writes and what became of each (`#29 send_email {…} · blocked`);
- how each run ended, and its last words.

The project's normalizers leave out what they mask, and a person's answers and a judge's calls are no decisions of the agent's.

**verdict** shows how the run stands, whichever call is selected:

- its checks, one by one;
- blame's report;
- its fix, with the `shadowlap fix show` that has the rest;
- the tools it ran unrecorded, with what a replay does about them and how to declare one;
- its attempts, its labels, and every note of the run.

A fork opened at its divergence opens on the diff. A failed run (by its outcome, or one a fix lists among its failing runs) opens on the verdict, unless `--call` named a call. `z` widens the inspector to the whole terminal.

### Play mode

Play mode replays the selected response at its recorded pacing (×1, ×2, ×4, instant), from the per-event timing stored with the recording. Watch the run happen, at zero cost.

## Layout

- **The header line** summarizes the run: calls; how many replayed, ran live, were blocked or stubbed; tokens saved and what they were worth; the approximate cost of the live calls; wall time, status, age and revision.
- **A narrow terminal**: when it is too narrow for all of the header, what fits is shown whole, in order, and ` · …` stands for the rest.
- **The footer line** is the keys of the pane in focus, `? help` first, or a message, or what a filter or a delete asks.
- **A run that is still recording** is tailed live.
- **Resizing**: the layout follows terminal resizes. The minimum is 60×12, and every screen fits it.
- **The alternate screen**: it draws there, as full-screen programs do. Quitting puts back the screen it opened on, with the prompt on a line of its own, whether by `q`, Ctrl-C, a stop signal or an error, whose message follows.
- **Stop signals**: SIGINT, SIGTERM and the SIGHUP of a closed window end it from the moment it starts, a Ctrl-C typed as it starts included. It ends with the [status](./cli.md#exit-status) for the signal, 128 + its number, and stops the dashboard it opened first.

## Keyboard shortcuts

The terminal UI's keys:

| Key | What it does |
| --- | --- |
| `↑`/`↓`, `j`/`k`, `PgUp`/`PgDn`, `g`/`G` | Move in the focused pane: the selected row is bold, on a grey ground |
| `←`/`→`, `h`/`l` | Focus the call list or the inspector; the inspector then scrolls with the same keys |
| `Tab`, `Shift-Tab`, `1`–`6` | Inspector tabs: the call's four, `5` a fork's diff, `6` the verdict, the same numbers on every run |
| `v` | The verdict tab: how the run stands |
| `b` | Select the call blame found the run lost at |
| `z` | Widen the inspector to the whole terminal, and back; `Esc` too |
| `J`/`K` | Scroll the inspector without leaving the call list |
| `space`, `<`/`>` | Play the selected response; speed |
| `+`, `-` | Label the run `good` or `bad`, in the runs view and on a run |
| `a` | List the attempts folded under their runs one by one, or fold them again (runs view) |
| `/` | Filter calls by name, arguments, origin or scope as you type; in the runs view, filter runs |
| `[` / `]` | Previous / next call that didn't replay cleanly |
| `n`, `d` | Jump to the call the run forked at; show what changed there on the diff tab |
| `f` | Cycle the origin filter: all / live / replayed / blocked / stubbed |
| `:` | Actions for the selected call |
| `y`, `w` | Copy the request (or the response, on that tab) to the clipboard; write request and response to a file |
| `p` | Open the parent run |
| `s` | Search what runs said, as `shadowlap search` searches it (runs view) |
| `N` | Add a note on the selected call, as `shadowlap note` adds one |
| `o` | Open the run, at the selected call, in the dashboard |
| `x` | Delete the selected run with the attempts bundled under it, as `rm` does (runs view) |
| `?`, `Esc`/`q` | Help: the keys of the view it was opened from; step back; go back or quit |

**`+` and `-`** label the run as the dashboard's key does. `good` marks a run a fix must not make worse than its own baseline (`repair --keeps label:good`); `bad` marks one to fix (`--fixes label:bad`). A run is never both, and a press of the label it has takes it off.

**`/`** filters as you type: `Enter` keeps the filter, `Esc` puts back the one before, and `Esc` again clears it. In the runs view, it filters runs by id, what they were about, command, revision or label.

**`[` and `]`** step to a call that didn't replay cleanly: one that ran live, was blocked, stubbed, overridden or injected, or failed.

**`n` and `d`**: `n` jumps to the call the run forked at, and `d` shows what changed there, and what the fork did differently, on the diff tab.

**`w`** writes request and response to `shadowlap-<run>-call<n>.json`.

**`s`** searches prompts, model responses, tool arguments and results, every word, or `"quoted words"` together. It runs the search, so the first one indexes every run, in a process of its own while the UI keeps answering. The matches are listed with the text around each, and `Enter` opens one at its call, on the tab it was found on.

**`N`**: a call with notes is marked `*` in the list, its notes are on its meta tab, and every note of the run is on the verdict tab.

**`o`**: the first `o` starts the dashboard in the same process. It stops when you quit, and so do the jobs started from it (they are killed at once when the terminal closes). Without a browser (over SSH), the link is shown and copied.

**`x`** deletes the run with its attempts (`--repeat`, blame's probes, verify's attempts, and theirs in turn). It asks first, naming how many attempts go with it. A run still recording, one a replay in progress reads from, and one with an attempt still running stay, and the reason is shown.

**`?`, `Esc` and `q`**: `?` shows the keys of the view it was opened from. `Esc` steps back one thing at a time: a filter, the zoom, the inspector's focus, then the view. `q` goes back to the runs, or quits from them, and from a run `shadowlap ui <run>` opened.

## Actions

`:` opens the fork menu for the selected call. It lists, in order:

1. only the actions that apply to the call, one line each, with its flag on the right;
2. the whole run's;
3. Fixes (`B`, `R`, `V`), each off with its reason where it doesn't apply;
4. replaying and packing.

The menu's header names the call and its kind (`At #19 · search_web · read tool`), and the selected action's line on what it does is shown underneath. An action that asks for a line (an instruction, a model, a commit) shows what it asks on its own lines, the line you type under it.

The menu's actions:

| Key | Action | At | Runs |
| --- | --- | --- | --- |
| `i` | Inject instruction… (asks for text) | model call | `… --inject <n>=<text> --inject-as user` |
| `m` | Switch model from here… (asks for a model) | model call | `… --model <n>:<model>` |
| `g` | Use changed prompt from here | model call | `… --prompt-from <n>` |
| `f` | Fail with HTTP status… (asks for a status) | model call | `… --fail-at <n>=<status>` |
| `o` | Override result… (opens with the recorded result to edit) | tool call | `… --override <n>=<json>` |
| `t` | Fail with tool error… (`timeout`, `error` or `error:<message>`, or a status) | tool call | `… --fail-at <n>=<failure>` |
| `x` | Plant instruction… (asks for the text) | read tool call | `… --inject-result <n>=<text> --repeat 3` |
| `l` | Force *tool* live (on a write, asks first: it acts on your systems) | tool call | `… --live-tool <name>` |
| `u` | Override user reply… (starts from the recorded reply) | recorded user input | `… --override <n>=<reply>` |
| `a` | Run live from here | any call | `… --diverge-at <n>` |
| `e` | Repeat 5 times (on a fork, asks first: its attempts run live) | the whole run | `… --repeat 5` |
| `s` | Replay with writes stubbed | the whole run | `… --writes stub` |
| `c` | Run error-path presets… (asks first: its attempts run live) | the whole run | `shadowlap replay <run> --chaos` |
| `b` | Find breaking commit… (asks for a commit where it still worked) | the whole run | `shadowlap bisect <run> --good <commit>` |
| `r` | Replay | — | `shadowlap replay <run>` |
| `n` | Add suggested normalizer (the divergence's) | — | `shadowlap normalize add …` |
| `p` | Pack run… (asks for a directory) | — | `shadowlap pack <run> <dir>` |
| `B` | Run blame: find the call it was lost at | a failed run | `shadowlap blame <run> [--expect <json>]` |
| `R` | Run repair: repair the fix it fails in | a run in an open fix | `shadowlap repair --fixes … [--keeps …] [--scope …] [--expect <json>] [--repairer claude-code]` |
| `V` | Run verify: verify a change for the fix | a run in a fix | `shadowlap verify --fixes … [--holdout …] [--keeps …] [--expect <json>]` |

Each is named as the dashboard's fork menu names it, in the CLI's verbs: an ellipsis means it asks for something before it runs.

- **`e` on a replay** runs again from its parent, with the flags that made it, its own command and its `--expect`. Its five attempts run live from where it forks, so it shows the exact command first, and `Enter` runs it. On a recording, which replays offline, it starts at once.
- **`s` on a replay** runs again from its parent too.
- **`c` on a clean replay or a test's replay** runs the presets on the recording it came from. It is off on an attempt of the presets or of an injection test, whose recording's presets are the ones to run.
- **`b` on a run that passed** reads *Find commit that changed it…*, and searches from its own commit.

Each action runs the CLI against the same store and streams its output into a pane. When it created a run, `Enter` opens it. The TUI never reimplements engine behavior: it is a front end to the same commands you'd type.

### What the menu offers, case by case

- **A run still recording**: the forks, the replay, the pack and Find breaking commit… are off until it finishes, and each says so ("fork once the recording finishes"), as in the dashboard. The run is tailed, so they turn on when it ends.
- **A run whose recording process was killed** stays marked running, but nothing will add to it. The runs list and the header call it interrupted, as the dashboard does, and its actions are on, as `replay` and `pack` take it.
- **A recorded user input** offers only Override user reply… and Run live from here: forcing it live or overriding it as a tool result would mean asking a person again.
- **A run imported from a capture** has no command, so its menu shows a note, a replay that asks for your command (which goes after `--`), and Pack, with blame, repair and verify off until that replay. That replay records every kind of call, and every fork works on it.
- **Find breaking commit…** is off for a run recorded outside git, and for a run from someone else's pack, whose command it would run at every commit.

Inject always passes `--inject-as user`, which every provider takes. What you type is passed as text: an override or a planted instruction that starts with `@` is never read as a file. From a terminal, `--inject-result <n>=@payload.txt` reads one.

### Blame from here

The Fixes section's `B` runs [blame](./blame.md) from the run in front of you. It shows the exact command first, since it replays the run and asks models live, and the check it judges by:

- the run's own `replay --expect`;
- its golden's check in `shadowlap.config.json`;
- the check of the fix it fails in;
- or, for a run that exited with an error, that exit.

A run that failed a check none of those name asks for one (`--expect`), since blaming on the exit alone would look for another failure than the one it had. A run from someone else's pack asks its yes first, as a replay of it does. When the job's pane closes, the run is read again, so its verdict, blame's call and its fix show what blame found.

### Repair and verify

`R` ([repair](./repair.md)) and `V` ([verify](./verify.md)) work on the fix the run fails in, with the command the dashboard's Fixes page runs for it:

- **its failing runs**, by the fix's label when that selects exactly the runs to fix;
- **for `V`, the runs held out** (`--holdout`): those a repair or a verify of the fix held out, unless a later repair showed them to its repairer, so the change is tried on failing runs it was not written for. `R` holds every other run out itself;
- **the good runs it keeps**: those an earlier repair or verify of it kept, else the runs labelled good that run the same agent (`label:good` when that is all of them), never a failing run;
- **its check**, and for `R` the scope its blame searched.

Each is worked out when you press it, shows the exact command, and runs on `Enter`. When the job's pane closes, the run is read again.

**The repairer.** A repair asks the repairer `repair.repairer` in `shadowlap.config.json` names, else your own Claude Code (`--repairer claude-code`). It says so, since that account pays for its candidates. When `claude` can't be found, it runs nothing, and says how to point at it.

- **No fix to try**: when a repair would end "No fix to try" without running the agent, as the dashboard warns, it says why first.
- **`V`** checks the change in your working tree as it stands.

**Someone else's command.** When a run the command selects came from someone else's pack, the team store or a program that sent the sidecar its command, a label's included, it names that run and its command. It runs only once you type `yes` (or `y`). When you say yes, the command is built again: one that would by then run another line, ask another repairer or name another run's command is shown again, with nothing typed, rather than run.

### Commands from someone else

A replay of a run from someone else's pack, a teammate's pulled from the team store, or one whose command a program sent the sidecar, runs that command. After whatever the action asked first (attempts, an instruction), a step of its own shows the exact command line it runs: the recorded command and the `shadowlap` line around it. It runs only once you type `yes` (or `y`), which it passes on as `--yes`. Anything else, or `Esc`, runs nothing.

## Colours

The terminal UI uses the dashboard's colours, and each means one thing, as it does there:

| Colour | For |
| --- | --- |
| Lime | What passed, and the `Enter` that runs a blame, a repair or a verify |
| Amber | What needs a look or is inconclusive |
| Red | What failed: a check, a call, a lost run, and what a changed request removed |
| Teal | A write a fork changed, on its diff tab |
| Grey | Secondary text, and what doesn't apply or was interrupted |
| The terminal's own text colour | Where you are, a fork, and what was said |

The wordmark keeps the brand's lime behind it.

Each origin has a colour of its own, as on the dashboard's [origin strip](./dashboard.md#the-origin-strip):

| Origin | Drawn as |
| --- | --- |
| Replayed | The logo's second green, quieter than lime, for a clean replay too |
| Live | Off-white on a dark background, else the terminal's own text colour |
| Overridden | Violet |
| Injected | A quieter violet |
| Blocked | Grey: the word says Shadowlap fenced the write, where the dashboard draws a hatch |
| Stubbed | Steel blue |

**Where you are** is drawn as the dashboard draws it:

- **The ground** of the selected row and the open tab is grey: the background the terminal reports, a step lighter, or darker on a light one. When the terminal reports none, it is the dashboard's own, or a light grey on a light background.
- **Bold** marks the open tab, and the selected row in the focused pane. The other pane's selected row keeps the ground alone.
- **The pane in focus** is framed in the terminal's text colour.

Lime that reads well on a dark background disappears on a light one. So before it draws anything, the UI asks the terminal for its background colour, as Neovim does, and picks a palette to suit. On a light background, each colour is darkened to keep its meaning and to read at 4.5:1.

- **A terminal that doesn't say** gets its own sixteen colours, which its theme already suits to its background, as does one with fewer than 256 colours.
- **`COLORFGBG`**, which rxvt, Konsole and iTerm2 set, is read when the terminal doesn't answer.
- **`SHADOWLAP_UI_THEME=dark`, `light` or `ansi`** chooses for it.
- **In a terminal without colour**, the `>` before the selected row marks it.

**In the sixteen colours**, each meaning takes the nearest of them. Passed, replayed, amber, red, teal, stubbed, overridden and injected never share one: passed is bright green, replayed green. Grey covers secondary text, what doesn't apply, and a blocked write. Where you are has no ground: bold and the `>` mark it.

## Cost, model and stop reason

Every model call stores the model it was made with, the provider's stop reason and the response size. The meta tab shows them with the usage, the whole input split into cache read, cache creation and uncached, then the output, and an approximate cost at list price.

- **Replayed calls** show what they *would* have cost: that money was not re-spent.
- **The runs list** has a cost column, and its detail line shows wall time, what a run spent and what its replay saved.
- **A run imported from a pack or a capture** shows its cost as captured: that traffic was paid for where it ran.
- **A teammate's run** pulled from the [team store](./team.md) shows what it spent, as the team's.

### Prices

Prices are USD per million tokens for the current Claude, OpenAI and Gemini models, matched by the longest model-name prefix. They are estimates: list prices change, and partner platforms and batch tiers differ. A model that is not in the table shows `unknown`, with no number.

Add or override prices in `shadowlap.config.json`:

```json
{
  "prices": {
    "claude-opus-5": { "input": 5, "output": 25, "cacheRead": 0.5, "cacheWrite": 6.25 },
    "my-finetune": { "input": 2, "output": 8 }
  }
}
```

The same table drives the cost figures in `shadowlap run`, `replay` and `show`.

## See also

- [Dashboard](./dashboard.md): the same runs in a browser, with the full inspector.
- [Interventions](./interventions.md): what each fork in the menu does.
- [Blame](./blame.md), [Repair](./repair.md) and [Verify](./verify.md): the steps of a fix.
- [CLI reference](./cli.md#ui): `shadowlap ui` and its flags.
