# Terminal UI

```sh
shadowlap ui                   # the run tree
shadowlap ui <run>             # a run's timeline; a fork opens at its divergence
shadowlap ui <run> --call 17   # opened at call 17
```

The terminal UI is where a run is worked through without leaving the terminal: why it failed, where [blame](./blame.md) found it lost and whether its fix held, where a fork left its parent and what it then did differently, what each call sent and got back, and a fork from the call in front of you. The [dashboard](./dashboard.md) is the full inspector, with turns, context and cache charts, the timeline of what ran in parallel, a run's family of forks, comparison, and editing labels and notes beyond the good/bad key and a new note. `o` opens the run, at the selected call, in the dashboard. `shadowlap search` ends each match with the `shadowlap ui <run> --call <n>` that opens it.

```
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

## Screens

- **Runs**: the run tree, forks nested under their parents, with what each run is (`recording`, `fork @3`, `clean replay`), what it was about as the dashboard names it (for a recording, the first thing its user asked, from its first model requests; for a fork, the change that made it, `override #16`; for an attempt, which one), cut in the middle at whole words when it has to be, `shadowlap test` check results (`✓ 3/3`, `✗ 2/3`), a status when there is one to give (`recording`, `interrupted` for a run whose recorder went away, `crashed` for one a signal stopped, `failed`, or `lost at #9` once blame found where), labels, the attempts bundled under it, and theirs in turn, with how many passed kind by kind (`5 attempts, 4 passed` for a `replay --repeat`, `12 probes, 3 passed · 6 verify attempts, 6 passed` for blame's and verify's, which count by their own verdicts, an inconclusive or an unavailable provider being no failure, and an interrupted attempt apart), call count, cost and age; the line under the list has its command. Attempts are folded under their run, as the dashboard's Runs folds them; `a` lists them one by one. The columns fit the terminal: in a narrow one cost, the call count, attempts, labels and age give way, in that order, then the status, and the cursor, the run, what it is, what it was about and its checks stay. The part of the ids every listed run shares, the day they were made, is drawn faint. The line under the list has the selected run in full. `Enter` opens.
- **Timeline**: one row per call with kind (`model`, `tool`, `clock`, `rand`), scope (when the run uses [scopes](./sdk.md#scopes)), what the call was, origin (`live`, `replayed`, `blocked`, `stubbed`, `overridden`, or `injected` for a failure Shadowlap answered with under [`--fail-at`](./interventions.md#inject-a-failure)), outcome, and the model and tokens of a model call (`opus-5 · 1.2k in, 40 out`) or a tool's arguments. A model call is named by what it did: the tools it called (`-> search_web, read_file`), the first words of what it said, `cut off: max_tokens`, or the HTTP status it failed with. On a fork, a line across the list marks where it forked and says what changed there (`── forked at #17 · the request changed: $.system`), and the calls replayed before it are drawn quieter than those after. On a run blame placed, a red line marks the call it was lost at (`── lost here · blame, high confidence`), and a blamed run opens there. The line under the header says what the run was about, then how it stands, in the dashboard's words: the check it failed (`check failed: send_email called 1 time, but called 2 times (2 blocked)`) or how it passed, where blame found it lost, how its fix stands (`fixed: “Ask before emailing the customer twice”, verified`, or `not blamed yet`), and the tools its model called that the run never recorded.
- **Inspector** tabs: *conversation* (the full conversation as sent at the selected call; it opens on the turns this call added since the model call before it, marked `new`, and tool results that are JSON are laid out as JSON), *request* (structured), *response* (rendered stream, or JSON), *meta* (origin, outcome, model and stop reason, effect, latency, usage and cost, size, attempts, fingerprint and the tool's implementation hash, the error, then the response headers and the call's notes), on a fork *diff*: the divergence report with the normalizer hint, then what the fork did differently from its parent from there on, as the dashboard's fork banner says it: each run's tool calls from there compared as one decision and ranked as `shadowlap decisions` ranks a change, a write first (`issue_refund is no longer called`, `search_web is asked differently`, with what each asked before and after; the project's normalizers leave out what they mask, and a person's answers and a judge's calls are no decisions of the agent's), whether it now fails or no longer does, the fork's writes and what became of each (`#29 send_email {…} · blocked`), how each run ended and its last words; and *verdict*: how the run stands, whichever call is selected: its checks one by one, blame's report, its fix with the `shadowlap fix show` that has the rest, the tools it ran unrecorded with what a replay does about them and how to declare one, its attempts, and its labels. A fork opened at its divergence opens on the diff, and a failed run (by its outcome, or one a fix lists among its failing runs) on the verdict, unless `--call` named a call. `z` widens the inspector to the whole terminal.
- **Play mode**: replays the selected response at its recorded pacing (×1, ×2, ×4, instant) from the per-event timing stored with the recording. Watch the run happen, at zero cost.
- **Actions**: see below.

The conversation tab needs no state reconstruction: every model request carries the whole conversation, so call *k*'s request *is* the state at *k*.

## Keys

| Key | Action |
|---|---|
| `↑`/`↓`, `j`/`k`, `PgUp`/`PgDn`, `g`/`G` | Move in the focused pane: the selected row is filled in lime |
| `←`/`→`, `h`/`l` | Focus the call list or the inspector; the inspector then scrolls with the same keys |
| `Tab`, `Shift-Tab`, `1`–`6` | Inspector tabs: the call's four, `5` a fork's diff, `6` the verdict, the same numbers on every run |
| `v` | The verdict tab: how the run stands |
| `b` | Select the call blame found the run lost at |
| `z` | Widen the inspector to the whole terminal, and back; `Esc` too |
| `J`/`K` | Scroll the inspector without leaving the call list |
| `space`, `<`/`>` | Play the selected response; speed |
| `+`, `-` | Label the run `good` (a run a fix must not make worse than its own baseline: `repair --keeps label:good`) or `bad` (one to fix: `--fixes label:bad`), as the dashboard's key does. A run is never both, and a press of the label it has takes it off. In the runs view and on a run |
| `a` | List the attempts folded under their runs one by one, or fold them again (runs view) |
| `/` | Filter calls by name, arguments, origin or scope as you type: `Enter` keeps the filter, `Esc` puts back the one before, and `Esc` again clears it. In the runs view, filter runs by id, what they were about, command, revision or label |
| `[` / `]` | Previous / next call that didn't replay cleanly: one that ran live, was fenced, overridden or injected, or failed |
| `n`, `d` | Jump to the call the run forked at; show what changed there, and what the fork did differently, on the diff tab |
| `f` | Cycle the origin filter: all / live / replayed / fenced |
| `:` | Actions for the selected call |
| `y`, `w` | Copy the request (or the response, on that tab) to the clipboard; write request and response to `shadowlap-<run>-call<n>.json` |
| `p` | Open the parent run |
| `s` | Search what runs said, as `shadowlap search` searches it (it runs the search, so the first one indexes every run, in a process of its own while the UI keeps answering): prompts, model responses, tool arguments and results, every word, or `"quoted words"` together. The matches are listed with the text around each, and `Enter` opens one at its call, on the tab it was found on (runs view) |
| `N` | Add a note on the selected call, as `shadowlap note` adds one; a call with notes is marked `*` in the list, its notes are on its meta tab, and every note of the run is on the verdict tab |
| `o` | Open the run, at the selected call, in the dashboard. The first `o` starts the dashboard in the same process; it stops when you quit, and so do the jobs started from it (they are killed at once when the terminal closes). Without a browser (over SSH), the link is shown and copied |
| `x` | Delete the selected run with the attempts bundled under it (`--repeat`, blame's probes, verify's attempts, and theirs in turn), as `rm` does (runs view; asks first, naming how many attempts go with it). A run still recording, one a replay in progress reads from, and one with an attempt still running stay, and the reason is shown |
| `?`, `Esc`/`q` | Help: the keys of the view it was opened from. `Esc` steps back one thing at a time (a filter, the zoom, the inspector's focus, then the view); `q` goes back to the runs, or quits from them, and from a run `shadowlap ui <run>` opened |

The header line summarizes the run: calls, how many replayed, ran live, were blocked or stubbed, tokens saved and what they were worth, the approximate cost of the live calls, wall time, status, age and revision. A run that is still recording is tailed live. The layout follows terminal resizes; the minimum is 60×12, and every screen fits it. In a terminal too narrow for all of the header, what fits is shown whole, in order, and ` · …` stands for the rest. The footer line is the keys of the pane in focus, `? help` first, or a message, or what a filter or a delete asks.

## Colours

The terminal UI uses the dashboard's colours: lime for what Shadowlap adds (a replayed call, the fork point, the focused pane, the selected row), the terminal's own text colour for what was said and what ran live, and red, amber and violet for failures, fenced and stubbed calls, and overrides. Lime that reads well on a dark background disappears on a light one, so before it draws anything the UI asks the terminal for its background colour, as Neovim does, and picks a palette to suit: on a light background, lime text is darkened and lime stays behind the selected row. A terminal that doesn't say gets its own sixteen colours, which its theme already suits to its background, as does one with fewer than 256 colours; `COLORFGBG`, which rxvt, Konsole and iTerm2 set, is read when the terminal doesn't answer. `SHADOWLAP_UI_THEME=dark`, `light` or `ansi` chooses for it. The `>` before the selected row marks it in a terminal without colour.

## Cost, model and stop reason

Every model call stores the model it was made with, the provider's stop reason and the response size; the meta tab shows them with the usage split into uncached input, output, cache reads and cache writes, and an approximate cost at list price. Replayed calls show what they *would* have cost: that money was not re-spent. The runs list has a cost column, and its detail line shows wall time, what a run spent and what its replay saved. A run imported from a pack or a capture shows its cost as captured: that traffic was paid for where it ran. A teammate's run pulled from the [team store](./team.md) shows what it spent, as the team's.

Prices are USD per million tokens for the current Claude, OpenAI and Gemini models, matched by the longest model-name prefix. They are estimates: list prices change, partner platforms and batch tiers differ, and a model that is not in the table shows `unknown` with no number. Add or override prices in `shadowlap.config.json`:

```json
{
  "prices": {
    "claude-opus-5": { "input": 5, "output": 25, "cacheRead": 0.5, "cacheWrite": 6.25 },
    "my-finetune": { "input": 2, "output": 8 }
  }
}
```

The same table drives the cost figures in `shadowlap run`, `replay` and `show`.

## Actions

`:` opens the fork menu for the selected call: only the actions that apply to it, one line each with its flag on the right, then the whole run's, then Fixes (`B`, `R`, `V`, each off with its reason where it doesn't apply), then replaying and packing. The header names the call and its kind (`At #19 · search_web · read tool`), and the selected action's line on what it does is shown underneath. On a run still recording, the forks, the replay, the pack and Find the commit are off until it finishes, and each says so ("fork once the recording finishes"), as in the dashboard; the run is tailed, so they turn on when it ends. A run whose recording process was killed stays marked running, but nothing will add to it: the runs list and the header call it interrupted, as the dashboard does, and its actions are on, as `replay` and `pack` take it. An action that asks for a line (an instruction, a model, a commit) shows what it asks on its own lines, the line you type under it.

| Key | Action | At | Runs |
|---|---|---|---|
| `i` | Inject an instruction (asks for text) | model call | `… --inject <n>=<text> --inject-as user` |
| `m` | Switch the model from here (asks for a model) | model call | `… --model <n>:<model>` |
| `g` | Fork with your changed prompt | model call | `… --prompt-from <n>` |
| `f` | Answer with an HTTP failure (asks for a status) | model call | `… --fail-at <n>=<status>` |
| `o` | Override this tool's result (opens with the recorded result to edit) | tool call | `… --override <n>=<json>` |
| `t` | Answer with a tool error (`timeout`, `error` or `error:<message>`, or a status) | tool call | `… --fail-at <n>=<failure>` |
| `x` | Plant a prompt injection here (asks for the text) | read tool call | `… --inject-result <n>=<text> --repeat 3` |
| `l` | Force this tool live | tool call | `… --live-tool <name>` |
| `u` | Answer differently as the user (starts from the recorded reply) | recorded user input | `… --override <n>=<reply>` |
| `a` | Diverge here | any call | `… --diverge-at <n>` |
| `e` | Repeat the replay and compare (asks how many attempts) | the whole run | `… --repeat <n>`; a replay runs again from its parent with the flags that made it, its own command and its `--expect` |
| `s` | Stub the writes | the whole run | `… --writes stub`; a replay, again from its parent |
| `b` | Find the commit that broke it (asks for a commit where it still worked), or on a run that passed, the commit that changed it (from its own) | the whole run | `shadowlap bisect <run> --good <commit>` |
| `r` | Replay this run | | `shadowlap replay <run>` |
| `n` | Add the divergence's suggested normalizer | | `shadowlap normalize add …` |
| `p` | Pack this run (asks for a directory) | | `shadowlap pack <run> <dir>` |
| `B` | Find the call it was lost at | a failed run | `shadowlap blame <run> [--expect <json>]` |
| `R` | Repair the fix it fails in | a run in an open fix | `shadowlap repair --fixes … [--keeps …] [--scope …] [--expect <json>] [--repairer claude-code]` |
| `V` | Verify a change for the fix | a run in a fix | `shadowlap verify --fixes … [--keeps …] [--expect <json>]` |

The Fixes section's `B` runs [blame](./blame.md) from the run in front of you. It shows the exact command first, since it replays the run and asks models live, and the check it judges by: the run's own `replay --expect`, its golden's check in `shadowlap.config.json`, the check of the fix it fails in, or for a run that exited with an error, that exit. A run that failed a check none of those name asks for one (`--expect`), since blaming on the exit alone would look for another failure than the one it had. A run from someone else's pack asks its yes first, as a replay of it does. When the job's pane closes, the run is read again, so its verdict, blame's call and its fix show what blame found.

`R` ([repair](./repair.md)) and `V` ([verify](./verify.md)) work on the fix the run fails in, with the command the dashboard's Fixes page runs for it: its failing runs (by the fix's label when that selects exactly them), the good runs it keeps (those an earlier repair or verify of it kept, else the runs labelled good that run the same agent, `label:good` when that is all of them, never a failing run), the scope its blame searched and its check. A repair asks the repairer `repair.repairer` in `shadowlap.config.json` names, else your own Claude Code (`--repairer claude-code`), and says so, since that account pays for its candidates; when `claude` can't be found it runs nothing and says how to point at it. When a repair would end "No fix to try" without running the agent, as the dashboard warns, it says why first. `V` checks the change in your working tree as it is now. Each is worked out when you press it, shows the exact command and runs on `Enter`. When a run the command selects came from someone else's pack, the team store or a program that sent the sidecar its command, a label's included, it names that run and its command and runs only once you type `yes` (or `y`). When you say yes, the command is built again: one that would now run another line, ask another repairer or name another run's command is shown again, with nothing typed, rather than run. When the job's pane closes, the run is read again.

Inject always passes `--inject-as user`, which every provider takes. Find the commit is off for a run recorded outside git, and for a run from someone else's pack, whose command it would run at every commit. What you type is passed as text: an override or a planted instruction that starts with `@` is never read as a file (from a terminal, `--inject-result <n>=@payload.txt` reads one). A recorded user input offers only a different answer and diverge: running it live or overriding it as a tool result would mean asking a person again. A run imported from a capture has no command, so its menu shows a note, a replay that asks for your command, which goes after `--`, and Pack, with blame, repair and verify off until that replay; that replay records every kind of call, and every fork works on it.

A replay of a run from someone else's pack, a teammate's pulled from the team store, or one whose command a program sent the sidecar, runs that command. Whatever the action asked first (attempts, an instruction), a step of its own then shows the exact command line it runs, the recorded command and the `shadowlap` line around it, and it runs only once you type `yes` (or `y`), which it passes on as `--yes`; anything else, or `Esc`, runs nothing.

Each action runs the CLI against the same store, streams its output into a pane, and, when it created a run, `Enter` opens it. The TUI never reimplements engine behavior; it is a front end to the same commands you'd type.
