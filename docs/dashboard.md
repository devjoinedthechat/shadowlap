# Dashboard

`shadowlap dashboard` opens your recordings in a browser: the same store the CLI and the terminal UI use, with more room to read.

```sh
shadowlap dashboard              # opens http://127.0.0.1:4777/#token=…
shadowlap dashboard <run>        # opens a run directly
shadowlap dashboard <run> --call 17   # at a call
shadowlap dashboard --no-open    # print the link instead
```

## What you see

- **Runs**, newest first, with forks and replays under the recording they came from. Each is tagged with what it is (recording, capture, clean replay, or fork and where) and whether it failed, with the number of calls, what its live calls cost and what replaying saved. A run imported from a capture shows the file it came from where a command would be, and its cost as captured rather than spent: that money was spent where the traffic ran. Search by id, command or revision; filter to recordings, forks, clean replays or failures. A run that is still recording updates as it goes.
- **A run**: its command, revision and timing; calls by origin; upstream requests; cost and tokens not re-spent. A fork opens at its divergence, with the structural diff of the request that changed, the recorded counterpart, and the normalizer to add when the change is a date or an id.
- **The origin strip**: one cell per call, colored by what happened to it (replayed, live, blocked, stubbed, overridden, injected, failed). *Injected* is a failure Shadowlap answered with instead of the provider, from [`--fail-at`](./interventions.md#inject-a-failure); it takes the overridden purple, because Shadowlap stood in, and the hollow square of an error. The shape of a fork is visible at a glance; click a cell to open that call. In a run of more than 360 calls, each cell covers a range of calls and takes the color of its rarest origin, so a single blocked write still shows; its tooltip counts the range.
- **Views of the run**, beside the inspector. Every mark selects its call:
  - *Calls*: every call with its kind, name, origin, arguments or model and stop reason, tokens, cost and time. Filter by origin or text.
  - *Turns*: calls grouped the way the agent loop made them: each model call with its tokens and stop reason, and the tool calls that followed it before the next one.
  - *Context*: tokens per model call, split into uncached input, input written to the cache and input read from it, with output below. The largest context, the share of input read from the cache, and every call where the cache stopped hitting, usually a change early in the prompt and the most expensive bug an agent has.
  - *Timeline*: every call on a clock, in as many lanes as ran at once, colored by origin, with the first token of streamed responses marked. How long the model calls and tools took, what ran in parallel, and the longest call.
  - *Forks*: the run's family: its recording, every replay and fork of it, with where each forked, what it cost and when it ran. Attempts of one `replay --repeat` are bundled with how many forked where, and runs from `shadowlap test --db` show whether their [outcome checks](./ci.md#outcome-checks) passed.
- **The inspector** for the selected call:
  - *Conversation*: the conversation exactly as the model saw it at this call, as system, user, assistant and tool-result turns, with tool calls and thinking blocks shown. It works the same for Anthropic, OpenAI (Chat Completions and Responses) and Gemini requests. **Format JSON** lays out tool results that are JSON as a tree; off, they show as the agent sent them. For a call answered with `--fail-at`, it says the request was never sent: the conversation is what the agent would have sent.
  - *Response*: the response as text and tool calls. **Play** replays a streamed response at its recorded pacing (1×, 2×, 4× or instant). *Raw* shows the stream as recorded. For a tool call, the recorded result or error.
  - *Request*: the stored request (or tool arguments) as a collapsible tree.
  - *Details*: origin, outcome and HTTP status, model, stop reason, token usage by cache tier, cost, latency, size, retries, fingerprint and occurrence, response headers.
- **Labels and notes**: label a run from its header (`bug`, `good`, `refund-flow`) and leave notes on a call in its details. The runs list shows labels, and its search box matches them.
- **Search**: three or more characters in the runs search box also searches what the runs recorded: prompts, responses, tool arguments and results. Each match opens its call.
- **Compare**: any two runs, starting with what changed between them (system prompts, tools, models, code version), then call by call (for a fork, *Compare with parent*): the identical prefix, the first request that differs with its diff, and calls where the same request got a different response.

## Actions

Labels and notes are saved to the store, and, like actions, only from a dashboard started with `shadowlap dashboard`. **Replay** re-runs the recorded command. **Fork at #n** offers what the terminal UI's actions palette offers for the selected call: force a tool live, override a tool's result, inject an instruction, fork with your changed prompt from here, answer a model call with an HTTP failure (`--fail-at`), switch the model, or diverge here; and for the run, stub writes, repeat the replay and compare the attempts (`--repeat`), add the suggested normalizer, or pack the run. A run imported from a capture has no command, so **Replay** asks for yours; the forks that ask for something else are greyed out until that replay exists, since it records every kind of call and every fork works on it. Each runs the CLI in the directory the dashboard was started from; its output streams into a panel, and when it created a run, **Open run** takes you there. **Delete** removes a run and the recorded data nothing else uses.

## Projects

A project is a folder with your agent's code. Its store is in that folder (`.shadowlap/shadowlap.db`), so each project has its own runs, fixes, tests, configuration and activity, and one dashboard serves several: switching projects switches the store it reads, and every action runs in that project's folder, against its store. The folder `shadowlap dashboard` starts in is always one of them.

The dashboard keeps the list in `~/.shadowlap/projects.json` (`SHADOWLAP_HOME` moves the folder). It holds no recordings: for each project its name, folder and when it was added, how far its setup got, and the commands you confirmed for recording there. It is written atomically and readable only by you, and keys it doesn't know are kept.

### Adding a project

**Add project…** asks for the folder your agent's code is in. As you type, it suggests folders and says what each holds (`Python · uv · pyproject.toml`, `Node · npm · package.json`). A folder without a `pyproject.toml`, `package.json`, requirements file or other project file can't be added, and says so. Adding a folder that was a project before brings its runs back, and its setup if it was finished.

Suggesting folders means the dashboard lists directories, so it does that within limits a web page can't stretch:

- Like every request, suggestions need the session token; adding a project, like every change, is also refused from another origin.
- They reach your home folder, and roots you add: `"roots": ["/work/agents"]` in `projects.json`, or `SHADOWLAP_PROJECT_ROOTS` (separated like `PATH`). A root can't be `/`, a system folder, or a folder that holds your home folder. A path that leads elsewhere, through `..` or a symbolic link, lists nothing.
- They list one folder level at a time, folder names and what kind of project each is; never files. Hidden folders (`~/.ssh`) and system folders (`~/Library`, `~/AppData` and `~/snap` in your home folder, `node_modules` anywhere) are never listed or entered, unless you add a root inside one, such as your iCloud Drive folder under `~/Library`.
- At most 2,000 entries are read from a folder, and 100 suggestions returned.

### Setting it up

A project with no runs shows its setup on every page but Settings; one that is partway through shows it on the Overview. There are four steps, and each runs the command beside it in the project's folder, the same one you could type in a terminal:

| Step | Command |
|---|---|
| Inspect the folder: SDKs, the start command, and every tool with its effect. Tools that aren't wrapped are flagged with the code to wrap them | `shadowlap init` (the dashboard reads [`init --json`](./cli.md#init)) |
| Record a first run | `shadowlap run -- <command>` |
| Make the replay clean | `shadowlap calibrate <run> --write` |
| Keep it as a test | `shadowlap pack <run> goldens/<name>`, then `shadowlap test goldens/<name>` |

Running `init` or recording in a terminal moves the setup on as well. **Skip the rest** appears after the first recording.

The browser never sends a command line, with one exception that already exists for a capture's replay: the command that starts your agent, which only ever goes after `--` in `shadowlap run -- <command>`. The server splits it into arguments without a shell, so what only a shell would understand is refused rather than passed on as text: a pipe, `&&`, a redirection, `$VAR`, `~` or a wildcard outside quotes, `$VAR` or a substitution inside double quotes, and a backslash before a space or a quote. Single quotes keep text as it is. Put the rest in a script. The first time a command runs in a folder, the dashboard asks before running it; the same command in the same folder doesn't ask again.

When `init` finds that the project talks to a model server of its own (`OPENAI_BASE_URL` in its `.env`, or a local base URL in its code, as with Ollama or vLLM), recording sets `SHADOWLAP_UPSTREAM_OPENAI` to that server, as `init` tells you to in a terminal, so the calls go there and not to the provider's API. A server address with credentials in it is never stored, so such a project is recorded in a terminal.

### Removing a project

**Remove from dashboard** forgets the folder. Nothing on disk changes: the folder and its code, its store, `shadowlap.config.json` and the goldens stay, so adding the folder again undoes it. **Also delete its recordings** deletes the store as well (`.shadowlap/shadowlap.db` and the files SQLite keeps beside it) once you type the project's name. It won't while a run is recording there, and it never touches the goldens in your repository. Repair reports and exports written under `.shadowlap/` are files of their own and stay too. The only project can't be removed.

## Keys

| Key | |
|---|---|
| `j` / `k`, `↓` / `↑` | Next or previous call |
| `1`–`4` | Conversation, response, request, details |
| `n` | Jump to the call where the run forked |
| `p` | Open the parent run |
| `/` | Filter calls |
| `v` | Next view: calls, turns, context, timeline, forks |
| `?` | All shortcuts |

## Send a run to someone

```sh
shadowlap export html <run> --lineage run.html
```

The same views as one HTML file, with the run's data built in and nothing to install or run: attach it to a pull request, keep it as a CI artifact, or send it to whoever asks what the agent did. It holds recorded prompts and tool data, so the project's redaction rules apply by default; see [`export html`](./cli.md#export-html). **Download** in a run's header saves the same file for that run and the runs it came from, and says so when there were no redaction rules to apply.

## Security

Recordings hold prompts and tool data, so the dashboard is built to stay local:

- It listens on 127.0.0.1 only, and refuses requests whose `Host` is not localhost, so a web page on another name that resolves to your machine cannot read it.
- Every data request needs the session token that `shadowlap dashboard` generates at start and puts in the link's fragment (the part after `#`, which browsers never send to servers or in a Referer). Restarting the dashboard invalidates old links.
- Requests that change something are refused when they come from another origin.
- The browser never sends a command line: it names an action, and the server builds the CLI arguments from the run and call. The command you give a capture's replay, or a project's first recording, is placed only after `--`, split without a shell.
- Folder suggestions for a new project list only folder names under your home folder and the roots you add, one level at a time, never hidden or system folders ([limits](#adding-a-project)).
- The page loads nothing from the network (fonts are bundled) and runs under a Content-Security-Policy that allows only its own script.

To use it on a remote machine, forward the port over SSH (`ssh -L 4777:127.0.0.1:4777 host`) rather than binding it to a public interface.
