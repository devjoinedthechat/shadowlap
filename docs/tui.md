# Terminal UI

```sh
shadowlap ui                   # the run tree
shadowlap ui <run>             # a run's timeline; a fork opens at its divergence
shadowlap ui <run> --call 17   # opened at call 17
```

The terminal UI is the quick look: where a run forked, what a call sent and got back, and a fork from the call in front of you, without leaving the terminal. The [dashboard](./dashboard.md) is the full inspector, with turns, context and cache charts, the timeline of what ran in parallel, a run's family of forks, search across runs, comparison, and label and note editing. `o` opens the run, at the selected call, in the dashboard. `shadowlap search` ends each match with the `shadowlap ui <run> --call <n>` that opens it.

```
 01K5CQ4P2R fork @17 of 01K5CQ4N7G · 30 calls · 16 replayed · 13 live · 1 blocked · 12k tok saved · 2s ago
┌─────────────────────────────────────────────────┐┌───────────────────────────────────────────────┐
│  #15  tool  fetch_page        replayed ok  {"url"││ conversation  request  response  meta         │
│  #16  tool  read_file         replayed ok  {"path││ ■ 14 events over 1.3s · stop tool_use · space │
│>!#17  api   messages          live     ok  1k>40 ││                                               │
│  #18  tool  search_web        live     ok  {"quer││ Sending the summary.                          │
│  #19  tool  send_email        blocked  ERR {"to":││ ⚙ send_email {"to":"team@example.com",…       │
└─────────────────────────────────────────────────┘└───────────────────────────────────────────────┘
 : actions · / search · [ ] jump · o dashboard · y copy · w write · p parent · space play · d diff · f filter · ? help
```

## Screens

- **Runs**: the run tree, forks nested under their parents, with status, call count, cost, age, `shadowlap test` check results (`✓ 3/3`, `✗ 2/3`) and labels. `Enter` opens.
- **Timeline**: one row per call with kind, scope (when the run uses [scopes](./sdk.md#scopes)), name, origin (`live`, `replayed`, `blocked`, `stubbed`, `overridden`, or `injected` for a failure Shadowlap answered with under [`--fail-at`](./interventions.md#inject-a-failure)), outcome, and for model calls the tokens, model and stop reason (`1k>40 tok · opus-5 · tool_use`), for tools the arguments. The divergence row is marked `!`.
- **Inspector** tabs: *conversation* (the full conversation as sent at the selected call), *request* (structured), *response* (rendered stream, or JSON), *meta* (origin, latency, usage, attempts, headers, the changed-implementation warning).
- **Play mode**: replays the selected response at its recorded pacing (×1, ×2, ×4, instant) from the per-event timing stored with the recording. Watch the run happen, at zero cost.
- **Diff**: the divergence report with the normalizer hint.
- **Actions**: see below.

The conversation tab needs no state reconstruction: every model request carries the whole conversation, so call *k*'s request *is* the state at *k*.

## Keys

| Key | Action |
|---|---|
| `↑`/`↓`, `j`/`k`, `PgUp`/`PgDn`, `g`/`G` | Move in the focused pane |
| `←`/`→`, `h`/`l` | Focus the call list or the inspector; the inspector then scrolls with the same keys |
| `Tab`, `Shift-Tab`, `1`–`4` | Inspector tabs |
| `J`/`K` | Scroll the inspector or the diff without changing focus |
| `space`, `+`/`-` | Play the selected response; speed |
| `/` | Filter calls by name, arguments, origin or scope; `Esc` clears. In the runs view, filter runs by id, command, revision or label |
| `[` / `]` | Previous / next call that ran live, was fenced, or failed |
| `n`, `d` | Jump to the divergence; show its diff |
| `f` | Cycle the origin filter: all / live / replayed / fenced |
| `:` | Actions for the selected call |
| `y`, `w` | Copy the request (or the response, on that tab) to the clipboard; write request and response to `shadowlap-<run>-call<n>.json` |
| `p` | Open the parent run |
| `o` | Open the run, at the selected call, in the dashboard. The first `o` starts the dashboard in the same process; it stops when you quit, and so do the jobs started from it (they are killed at once when the terminal closes). Without a browser (over SSH), the link is shown and copied |
| `x` | Delete the selected run (runs view; asks first). A run still recording, or one a replay in progress reads from, stays, and the reason is shown |
| `?`, `Esc`/`q` | Help; back / quit |

The header line summarizes the run: calls, how many replayed, ran live, were blocked or stubbed, tokens saved and what they were worth, the approximate cost of the live calls, wall time, status, age and revision. A run that is still recording is tailed live. The layout follows terminal resizes; the minimum is 60×12.

## Cost, model and stop reason

Every model call stores the model it was made with, the provider's stop reason and the response size; the meta tab shows them with the usage split into uncached input, output, cache reads and cache writes, and an approximate cost at list price. Replayed calls show what they *would* have cost: that money was not re-spent. The runs list has a cost column, and its detail line shows wall time, what a run spent and what its replay saved. A run imported from a pack or a capture shows its cost as captured: that traffic was paid for where it ran.

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

`:` opens the fork menu for the selected call: only the actions that apply to it, one line each with its flag on the right, then the whole run's, then replaying and packing. The header names the call and its kind (`At #19 · search_web · read tool`), and the selected action's line on what it does is shown underneath.

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

Inject always passes `--inject-as user`, which every provider takes. Find the commit is off for a run recorded outside git, and for a run from someone else's pack, whose command it would run at every commit. What you type is passed as text: an override or a planted instruction that starts with `@` is never read as a file (from a terminal, `--inject-result <n>=@payload.txt` reads one). A recorded user input offers only a different answer and diverge: running it live or overriding it as a tool result would mean asking a person again. A run imported from a capture has no command, so its menu shows a note and one action, a replay that asks for your command, which goes after `--`; that replay records every kind of call, and every fork works on it.

Each action runs the CLI against the same store, streams its output into a pane, and, when it created a run, `Enter` opens it. The TUI never reimplements engine behavior; it is a front end to the same commands you'd type.
