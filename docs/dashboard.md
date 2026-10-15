# Dashboard

`shadowlap dashboard` opens your recordings in a browser: the same store the CLI and the terminal UI use, with more room to read.

```sh
shadowlap dashboard              # opens http://127.0.0.1:4777/#token=…
shadowlap dashboard <run>        # opens a run directly
shadowlap dashboard <run> --call 17   # at a call
shadowlap dashboard --no-open    # print the link instead
```

## What you see

- **The shell**: a sidebar with the project, **Search or jump to** (⌘K or Ctrl K), Overview, Runs, Compare, Fixes, Tests and Training, the most recent runs as a tree (forks and replays under the recording they came from), and Settings; a top bar with where you are and, while a run records, a live chip; a status bar with the store, the run count, whether it is in sync, the address and the version. Dark only. Below 1000px the sidebar is a drawer behind the menu button.
- **Search or jump to**: every page, This run's actions, the runs, and, from three characters, what the runs recorded (prompts, responses, tool arguments and results; up to six matches, two per run). Every typed word must match.
- **Overview**: this week's failed runs, forks, clean replays and what was spent live, with what replaying saved after it; this week's runs by family; and what ran today.
- **Runs**: every run in a table, with chips by kind (recordings, forks, clean replays, tests, captures, failed) and their counts, a filter, sorting by calls, spend or time, and each run's outcome. A run imported from a capture shows the file it came from where a command would be, and its cost as captured rather than spent: that money was spent where the traffic ran. Tick runs to label, compare or delete them together.
- **A run**: what it is and where it came from, its command, revision and timing; its counts first (calls, replayed, live, fenced, upstream requests, spent), then what replaying saved: not re-spent, and the time not waited (each replayed call's duration where it was recorded). One banner says how it forked, where blame found it lost, which checks it passed, or that it failed. A fork opens at its divergence; **Show diff** shows the request that changed, and the normalizer to add when the change is a date or an id.
- **The origin strip**: one cell per call, colored by what happened to it (replayed, live, overridden, injected, failed, blocked, stubbed); the legend lists those present. *Injected* is a failure Shadowlap answered with instead of the provider, from [`--fail-at`](./interventions.md#inject-a-failure). The fork and the call blame named are flagged. Click a cell to open that call. In a run of more than 360 calls, each cell covers a range of calls and takes the color of its rarest origin, so a single blocked write still shows; hovering it counts the range.
- **Scopes**: a run made with `scope()` gets a chip per scope, nested ones included, with counts; picking one dims the strip outside it and narrows every view to it.
- **Views of the run**, beside the inspector (`v` cycles the first five). Every mark selects its call:
  - *Calls*: every call with its kind, name, origin, tokens and time; a tool's result on a second line. A replayed call's time is its recorded duration, in grey, because the replay did not wait for it. Filter by origin or text; each row has a fork button.
  - *Turns*: each model call with its tokens and stop reason, and the tool calls that followed it, grouped by scope.
  - *Context*: tokens per model call, split into input read from the cache, written to it and uncached, with output below, as a chart or a table. In a conversation that uses the prompt cache, a call is flagged where the cache stopped hitting: it read less from the cache than the previous model call in the same scope sent in all, by 1,024 tokens or more. That is usually a change early in the prompt, and the most expensive bug an agent has.
  - *Timeline*: every call on a clock, colored by origin, with the first token of streamed responses marked, scope by scope; how long model calls and tools took, the longest call, and what ran at once.
  - *Forks*: the run's family: its recording, every replay and fork of it, with a line on what each did. Attempts of one `replay --repeat` are bundled with how many passed.
  - *Provenance*: the run's record (command, revision, times in UTC, models, provider, upstream requests, origins), its lineage, what a copy made now applies, and its labels and notes.
- **The inspector** for the selected call:
  - *Conversation*: the conversation exactly as the model saw it at this call, with tool calls and thinking blocks shown. It works the same for Anthropic, OpenAI (Chat Completions and Responses) and Gemini requests. **Format JSON** lays out tool results that are JSON; on a fork, **Jump to change** opens the message the fork changed. For a call answered with `--fail-at`, it says the request was never sent.
  - *Response*: the response as text and tool calls. **Play** replays a streamed response at its recorded pacing (1×, 2×, 4× or instant). *Raw* shows the stream as recorded. For a tool call, the recorded result or error.
  - *Request*: the stored request (or tool arguments) as a collapsible tree.
  - *Details*: origin, outcome and HTTP status, model, stop reason, token usage by cache tier, cost, latency and first token, size, retries, fingerprint and occurrence, response headers, and notes.
- **Labels and notes**: label a run from its header (`bug`, `good`, `refund-flow`), or several from Runs, and leave notes on a call in its details.
- **Compare**: any two runs, picked at the top, starting with what changed between them (code version, system prompt, tools, model), then the identical prefix, the first request that differs, each run's calls from there, and calls where the same request got a different answer. A fork or a replay has *Compare with parent*; a recording compares with its first fork or replay.

## Actions

Labels, notes and actions run only from a dashboard started with `shadowlap dashboard`; elsewhere their buttons say why they are off. **Replay** re-runs the recorded command. **Fork at #n** (or a row's fork button, or `f`) offers what applies to that call, each with its flag: inject an instruction, switch the model, fork with your changed prompt, answer with an HTTP failure (`--fail-at`) or diverge for a model call; override the result, force it live or diverge for a tool call; and for the whole run, repeat the replay and compare the attempts, or stub the writes. An action that needs something from you (the instruction to inject, the status to fail with, the model to switch to) asks for it in a dialog that shows the command it runs. A run imported from a capture has no command, so its menu offers one thing: replay it with yours, which records every kind of call so every fork works on it. **Share** saves the run as one HTML file, or packs it into a folder. Each action runs the CLI in the directory the dashboard was started from; its output streams into a drawer that ends on the outcome and the exit code, and when it made a run, **Open run** takes you there. **Delete** removes a run and the recorded data nothing else uses.

## Keys

| Key | |
|---|---|
| ⌘K or Ctrl K | Search or jump to anything |
| `/` | Filter the calls on a run; search anywhere else |
| `j` / `k`, `↓` / `↑` | Next or previous call |
| `1`–`4` | Conversation, response, request, details |
| `v` | Next view: calls, turns, context, timeline, forks |
| `n` | Jump to the call where the run forked, or where blame found it lost |
| `p` | Open the parent run |
| `f` | Fork at the selected call |
| `g` then `o` `r` `c` `f` `t` `a` `s` | Overview, Runs, Compare, Fixes, Tests, Training, Settings |
| `?` | All shortcuts |
| Esc | Close a menu, then a dialog, then a panel |

When the server stops answering (the dashboard was stopped), a bar says what the page last loaded, actions pause, and it tries again after 5, 10, 20 and then every 30 seconds. A link from before a restart has expired: its session token is gone, and the page says to open the new link.

## Send a run to someone

```sh
shadowlap export html <run> --lineage run.html
```

The same views as one HTML file, with the run's data built in and nothing to install or run: attach it to a pull request, keep it as a CI artifact, or send it to whoever asks what the agent did. It holds recorded prompts and tool data, so the project's redaction rules apply by default; see [`export html`](./cli.md#export-html). **Share → HTML file** in a run's header saves the same file for that run and the runs it came from, and says so when there were no redaction rules to apply.

## Security

Recordings hold prompts and tool data, so the dashboard is built to stay local:

- It listens on 127.0.0.1 only, and refuses requests whose `Host` is not localhost, so a web page on another name that resolves to your machine cannot read it.
- Every data request needs the session token that `shadowlap dashboard` generates at start and puts in the link's fragment (the part after `#`, which browsers never send to servers or in a Referer). Restarting the dashboard invalidates old links.
- Requests that change something are refused when they come from another origin.
- The browser never sends a command line: it names an action, and the server builds the CLI arguments from the run and call. The command you give a capture's replay is placed only after `--`.
- The page loads nothing from the network (fonts are bundled) and runs under a Content-Security-Policy that allows only its own script.

To use it on a remote machine, forward the port over SSH (`ssh -L 4777:127.0.0.1:4777 host`) rather than binding it to a public interface.
