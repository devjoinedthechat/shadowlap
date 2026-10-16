# Dashboard

`shadowlap dashboard` opens your recordings in a browser: the same store the CLI and the terminal UI use, with more room to read.

```sh
shadowlap dashboard              # opens http://127.0.0.1:4777/#token=…
shadowlap dashboard <run>        # opens a run directly
shadowlap dashboard <run> --call 17   # at a call
shadowlap dashboard --no-open    # print the link instead
shadowlap dashboard --read-only  # look around, change nothing
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
  - *Calls*: every call with its kind, name, origin, tokens and time; a tool call that was blocked, stubbed or failed says so on a second line. A replayed call's time is its recorded duration, in grey, because the replay did not wait for it. Filter by origin or text; each row has a fork button.
  - *Turns*: each model call with its tokens and stop reason, and the tool calls that followed it, grouped by scope.
  - *Context*: tokens per model call, split into input read from the cache, written to it and uncached, with output below, as a chart or a table. A call is flagged where the cache stopped hitting: it read less from the cache than the previous model call in the same scope and conversation sent in all, by 1,024 tokens or more. That is usually a change early in the prompt, and the most expensive bug an agent has. An agent that never caches its prompt sends its history again on every turn, so every turn after the first is flagged, and the view says the cache was never read.
  - *Timeline*: every call on a clock, colored by origin, with the first token of streamed responses marked, scope by scope; how long model calls and tools took, the longest call, and what ran at once.
  - *Forks*: the run's family: its recording, every replay and fork of it, with a line on what each did. Attempts of one `replay --repeat` are bundled with how many passed. Blame's attempts are bundled per probe under the run they replayed, the probe blame named marked *blamed*, and verify's per run under each change it checked, its icon saying whether the change was accepted; each bundle opens its fix at that step, a verify at its verdict. The fork blame rescued a run with stays a fork of its own.
  - *Provenance*: the run's record (command, revision, times in UTC, models, provider, upstream requests, origins), its lineage, what a copy made now applies, and its labels and notes.
- **The inspector** for the selected call:
  - *Conversation*: the conversation exactly as the model saw it at this call, with tool calls and thinking blocks shown. It works the same for Anthropic, OpenAI (Chat Completions and Responses) and Gemini requests. **Format JSON** lays out tool results that are JSON; on a fork, **Jump to change** opens the message the fork changed. For a call answered with `--fail-at`, it says the request was never sent.
  - *Response*: the response as text and tool calls. **Play** replays a streamed response at its recorded pacing (1×, 2×, 4× or instant). *Raw* shows the stream as recorded. For a tool call, the recorded result or error.
  - *Request*: the stored request (or tool arguments) as a collapsible tree.
  - *Details*: origin, outcome and HTTP status, model, stop reason, token usage by cache tier, cost, latency and first token, size, retries, fingerprint and occurrence, response headers, and notes.
- **Labels and notes**: label a run from its header (`bug`, `good`, `refund-flow`), or several from Runs, and leave notes on a call in its details.
- **Compare**: any two runs, picked at the top, starting with what changed between them (code version, system prompt, tools, model), then the identical prefix, the first request that differs, each run's calls from there, and calls where the same request got a different answer. A fork or a replay has *Compare with parent*; a recording compares with its first fork or replay.
- **Fixes**: each failure from where it was lost to a fix that held. One row per fix: its status (open, verified, applied), title and label, where a fix from CI came from, its failing runs and check, and how far blame, repair and verify got; All, Open and Verified filter them. A fix's page names its check, its failing and good runs and when it was opened and verified, and opens on its last finished step:
  - *Blame*: where the run was lost, on its row of calls with each probe marked; the recorded answer at that call next to the rescued fork's, and the training pairs they make; the probes, each row opening the run at its call; every attempt, bundled per probe; and what finding out cost, with the command.
  - *Repair*: the change, with its file, the part of the prompt or tool description it rewrites and the text it adds, and how each role held under it; why the failing runs were lost and the repairer's diagnosis; every candidate tried, with why each was dropped; the files handed over (`fix.patch`, `report.md`, `report.json`, `goldens/`); and the pull request body. A repair that accepted nothing leaves the fix open, with the candidates it tried and why.
  - *Verify*: one change verified at a time, each at a link of its own: its verdict and oracle, each run's role, attempts, outcome and where it went, what the change does to input tokens and cost per run, and what finding out cost.
- **Activity**: what happened in the project, newest first, each entry with who did it. Most of it comes from the runs themselves: recordings started and finished, clean replays, forks with the flags that made them (`--fail-at 19=529`, `--model 15:claude-opus-5`, as the replay kept them on the run), the attempts of one `replay --repeat` as one entry with how many took the same path, captures and packs imported (the runs one import or one pack brought in as one entry), tests passed or failed with their checks, and blames. A replay that parted from its recording only over a value that changes on every run, such as a UUID or a timestamp, reads as diverged rather than forked: nobody changed anything, and a normalizer would mask it. The rest is what commands record as they change the project or write something: normalizers and redaction rules added (by hand or by `calibrate --write`; a redaction rule is named by what it puts in place, never by its pattern), goldens packed (a pack in a goldens folder or named in the config's `tests`) and other packs, the project set up by `init` (when the project has a store already, as it has when the dashboard runs `init`: `init` never creates one). Who did it is the run's author, worked out when it was made: `SHADOWLAP_AUTHOR` if set, `ci` in CI, else git's `user.email`, else the OS user. It stays on this machine: packs and HTML files (`export html`, or **Share → HTML file** on a run) leave the author out.

## What a run's page is worked out from

Besides each call as recorded, the run's endpoint (`/api/runs/<id>`, which the page and an [exported copy](./cli.md#export-html) read) works out the following for it.

- **Conversations.** A run can hold many: an overnight batch works through forty tickets in one process, and a multi-agent run has one per agent. A model request continues a conversation when it extends that conversation's latest request in the same [scope](./sdk.md): the messages (Gemini's contents, the Responses API's input items) sent last time come first again, with the answer and what followed it appended. Cache breakpoints, thinking blocks and thought signatures that an agent moves or drops between requests don't count, and neither does a system message that only carries the time. An agent that edits its history still continues its conversation: one that drops its oldest turns, by the tool-use ids it still carries, and one that strips a reminder from an earlier message or completes a prefilled answer, by the last answer it carries right after the history it kept. A request that continues no conversation starts a new one; so does one that repeats another conversation's request word for word, unless that request failed and this is its retry. A tool call belongs to the conversation of the model call that asked for it, matched by name and arguments in its scope, with the tool-use id the provider gave. A call no model asked for goes with the tool that was running when it started (the HTTP request a tool sends), else with the model call whose tools have not all run yet, else with the next model call (the ticket fetched before it). A call's *Conversation* is its own conversation as it stood at that call, never another ticket's or another agent's.
- **Where the prompt cache stopped hitting.** A model call misses when its cache read is smaller than the previous model call's whole input (uncached, written and read) in the same scope and conversation, by at least 1,024 tokens; the tokens sent again are the difference. A conversation's first call is never a miss, so a batch doesn't flag the start of every ticket. Every call whose cache read is known is judged: Anthropic and OpenAI report it, zero included, and Gemini leaves it out when it read nothing. An agent that never asks to cache therefore shows each turn's history as sent again; a server that reports no cache at all (a local model behind an OpenAI-compatible API) shows no misses. The share of input read from the cache counts live model calls.
- **Time not waited.** A replayed call is answered from the recording at once. The time it saved is how long the recording waited for it, found on the run it was replayed from, or further back for a replay of a replay; each replayed call carries it, and the run sums it.
- **What was not recorded.** The hosts the [network guard](./how-it-works.md#the-network-guard) saw the agent reach without Shadowlap, and the tools `shadowlap init` finds in the project without a declared effect that the recording never saw. They ran for real, and a replay runs them again.
- **The fork and what made it.** The call a replay forked at, and the flags it ran with, as the replay kept them on the run: `--fail-at 19=529`, `--override 16=@policy.json`, `--inject 15=Prefer sources from 2026.`, `--model 15:claude-opus-5`, `--set 15:max_tokens=2048`, `--inject-result`, `--prompt-from`, `--diverge-at`, `--live-tool`, `--writes stub`. Each is shown in a short form: an override read from a file is named by the file, one given inline shows the result its call recorded, and a long instruction is shortened. The run also keeps each flag exactly, so the fork menu can make the fork again; a copy of the run (`pack`, `export html`) keeps only the short form, masked by the redaction rules. A replay made before Shadowlap kept its flags shows the ones its calls reveal.
- **Blame and checks.** A blamed run names the model call that lost it, counted among the model calls of the blame's scope ("model call 5 of 6"), and the fork that blame rescued says it was rescued. Each [outcome check](./ci.md#outcome-checks) is counted over the attempts it ran in: "issue_refund never called · 5 of 5".
- **Each call's own record.** Its fingerprint, the hashes of its stored request and response, and for a tool call its result in one line ("stubbed …", "blocked").

A run imported from someone else's pack carries what they recorded about it; anything malformed there is left out rather than shown.

## Actions

Labels, notes and actions run only from a dashboard started with `shadowlap dashboard`; elsewhere their buttons say why they are off. **Replay** re-runs the recorded command. **Fork at #n** (or a row's fork button, or `f`) offers what the terminal UI's fork menu offers for that call, one line each with its flag: at a model call, inject an instruction (always as the user), switch the model, fork with your changed prompt, an HTTP failure (`--fail-at`) or diverge; at a tool call, override its result, answer with a tool error, plant a prompt injection (reads only), force it live or diverge; at a recorded user input, answer differently as the user or diverge; and for the whole run, repeat the replay and compare the attempts (`--repeat`) or stub the writes; a fork is made again from its parent, with the flags, command and checks that made it. An action that needs something from you (the instruction to inject, the status to fail with, the model to switch to) asks for it in a dialog first; the inject dialog shows the command it runs. What you type is passed as text, never read as a file. See [Interventions](./interventions.md). A run imported from a capture has no command, so its menu shows a note and one action, **Replay** with your command; that replay records every kind of call, and every fork works on it. **Share** saves the run as one HTML file, or packs it into a folder. **Delete** removes a run and the recorded data nothing else uses.

A failed run that was never blamed has **Run blame** on its page. It blames the run with the check it failed, found the way a replay is judged: the run's own `--expect`, else the entry under the config's `tests` for the recording it replays (the golden a test replayed, or the pack it was unpacked from, through the runs it came from); else the check of the fix it fails in or of a fix its labels point to; else the agent's exit. When the run failed a check none of those give, or nothing says what a passing run must do, it asks for the check. The blame opens the run's fix, or joins one, and links to it. On an open fix, **Repair from here** runs [`shadowlap repair`](./repair.md) from the fix's failing and good runs and its check, with the repairer `repair.repairer` in shadowlap.config.json names, or else your own Claude Code (`--repairer claude-code`); it asks first, since each candidate is tried in your working tree and put back. On a verified fix, **Copy git apply** copies the command that applies its patch, and **Apply the patch** runs [`shadowlap fix apply`](./cli.md#fix) once you confirm, since it changes your working tree: the patch goes in with `git apply`, the recordings the fixed code made are copied into `goldens/` and `shadowlap test` replays them; the button then reads *Patch applied*. A repair or an apply changes your working tree, so it runs alone in its project: it can't start while a job runs your agent from that tree (a recording, a blame, a replay or fork, a test, a calibration), and until it is done any of those is refused with what holds the tree. **Run blame**, **Repair from here** and **Apply the patch** are off meanwhile and say so on hover; a job in another project's folder doesn't wait. A repair or a blame that would run a command from someone else's pack asks once more before it does. **Rename** gives a fix a title of your own, as `shadowlap fix title` does.

Each action is a job: the dashboard runs the CLI in the directory it was started from, and the job's output streams into a drawer titled with what it does (Replaying, Forking, Repeating, Packing). The command also tells the job what it made, on a pipe of its own rather than in its output: the runs it started (attempts listed apart, since they open as a bundle), where to go next, the files and folders it wrote, and its result (what `--json` would print). So the drawer ends on the outcome and the exit code and links to the new run (**Open run**) or the attempts without reading the text, names the folder a pack went to, and offers a file a job wrote for download. Closing the drawer leaves the job running. Stopping it stops the command and the agent it started, even an agent that ignores the signal (it is killed after five seconds); a run it left recording is marked as interrupted, so it no longer shows as live and can be deleted. Stopping the dashboard (Ctrl-C, a kill, or closing the terminal it runs in) stops its running jobs the same way and waits for them; stopping it again while it waits kills them at once. The dashboard the terminal UI opens (`o` in `shadowlap ui`) does the same when you quit the terminal UI or it is killed, and kills its jobs at once when the terminal it runs in closes.

Some jobs take a file from your browser, such as a capture to import. The dashboard keeps it in `.shadowlap/uploads` in the project folder, readable only by you, at most 64 MB and 32 files at once, until the job that uses it ends. A file no job used is deleted after an hour, and every upload is deleted when the dashboard stops. Uploaded files are untrusted data: the command that reads one parses it as it would any file you point it at.

## Read-only

`shadowlap dashboard --read-only` shows every page and changes nothing in your runs: replay, fork and the other actions, labels, notes, uploads and deletes are refused, and each says why where you would have used it. Downloading a run as HTML still works, since it changes nothing. Use it to show a colleague your runs, or to look around without the risk of a click changing something. It needs an existing store and never creates one, and it leaves the uploads folder alone (even files another dashboard left there); it opens that store the way every command does, which brings an older store's layout up to date and lets search build its index. A dashboard started without the CLI behind it (embedded elsewhere) is read-only in the same way.

## Projects

> Projects come with the dashboard's next pages: the switcher, **Add project…**, the setup and **Remove from dashboard** described here aren't in it yet. Until then `shadowlap dashboard` serves the folder it starts in, or the store `--db` names, and each setup step below is a command you can run in a terminal.

A project is a folder with your agent's code. Its store is in that folder (`.shadowlap/shadowlap.db`), so each project has its own runs, fixes, tests, configuration and activity, and one dashboard serves several: switching projects switches the store it reads, and every action runs in that project's folder, against its store. The folder `shadowlap dashboard` starts in is always one of them.

The dashboard keeps the list in `~/.shadowlap/projects.json` (`SHADOWLAP_HOME` moves the folder; give it as an absolute path). It holds no recordings: for each project its name, folder and when it was added, how far its setup got, and the commands you confirmed for recording there, and the same for projects you removed, so adding one again brings it back. It is written atomically and readable only by you, and keys it doesn't know are kept. Listing projects reads their stores without changing them, so a project pinned to an older Shadowlap keeps working, and a store in a folder you can't write to is still read; one that can't be read at all (a newer Shadowlap's) is listed with the reason. If the list can't be read, or a newer Shadowlap wrote it, the dashboard still opens on its folder and says why it can't list or add others.

### Adding a project

**Add project…** asks for the folder your agent's code is in. As you type, it suggests folders and says what each holds (`Python · uv · pyproject.toml`, `Node · npm · package.json`). A folder without a `pyproject.toml`, `package.json`, requirements file or other project file can't be added, and says so. Adding a folder that was a project before brings it back as it was: its runs, its setup where it left off, and the commands you confirmed there.

Suggesting folders means the dashboard lists directories, so it does that within limits a web page can't stretch:

- Like every request, suggestions need the session token; adding a project, like every change, is also refused from another origin.
- They reach your home folder, and roots you add: `"roots": ["/work/agents"]` in `projects.json`, or `SHADOWLAP_PROJECT_ROOTS` (separated like `PATH`). A root can't be `/`, a system folder, or a folder that holds your home folder. A path that leads elsewhere, through `..` or a symbolic link, lists nothing.
- They list one folder level at a time, folder names and what kind of project each is; never files, and a file gets the same answer as a path where nothing is. Hidden folders (`~/.ssh`) and system folders (`~/Library`, `~/AppData` and `~/snap` in your home folder, `node_modules` anywhere) are never listed or entered, unless you add a root inside one, such as your iCloud Drive folder under `~/Library`.
- A typed path is checked as typed before anything is looked up, then where it really leads, and only then whether it is a folder: a path into a hidden folder gets the same answer whether or not something is there.
- At most 2,000 entries are read from a folder, and 100 suggestions returned.

### Setting it up

A project with no runs shows its setup on every page but Settings; one that is partway through shows it on the Overview. There are four steps, and each runs the command beside it in the project's folder, the same one you could type in a terminal:

| Step | Command |
|---|---|
| Inspect the folder: SDKs, the start command, and every tool with its effect. Tools that aren't wrapped are flagged with the code to wrap them | `shadowlap init` (the dashboard reads [`init --json`](./cli.md#init)) |
| Record a first run | `shadowlap run -- <command>` |
| Make the replay clean | `shadowlap calibrate <run> --write` |
| Keep it as a test | `shadowlap pack <run> goldens/<name>`, then `shadowlap test goldens/<name>` |

Inspecting is done once `init` has run in the folder; a project recorded in a terminal first shows it as skipped, and can still be inspected. A recording counts once it holds calls: one whose command didn't start (a typo), or whose agent stopped before its first model call, recorded nothing, and the step says so. When tools weren't wrapped while it was recorded, their calls aren't in it: wrap them, check again, and **Record again**. Until the replay is made clean, the newest recording is the setup's, so recording again in a terminal works too.

Making the replay clean replays the recording offline: when it replays clean as it is, the step is done by itself; when calibrate proposes normalizers for values the agent makes anew on every run, **Add it** writes them to `shadowlap.config.json`. The golden goes in a folder of its own, `goldens/<project>` unless you name another; Shadowlap never packs over a golden that is already there, and offers the next free name instead. **Skip the rest** appears after the first recording.

The same commands typed in a terminal move the setup on: `init` records what it finds, a recording counts once it holds calls, a clean replay of it (`shadowlap replay <run>`) completes step 3, and a pack of it under `goldens/` completes step 4. `calibrate --write` in a terminal leaves nothing behind by itself; the setup's **Calibrate** then finds the replay clean as it is.

The browser never sends a command line, with one exception that already exists for a capture's replay: the command that starts your agent, which only ever goes after `--` in `shadowlap run -- <command>`. The server splits it into arguments without a shell, reading quotes as a terminal on macOS or Linux does, so the command the setup shows reads back as the same arguments: single quotes keep text as it is, and a backslash makes the next character text (`'it'\''s'`, `my\ file`). What only a shell would understand is refused rather than passed on as text: a pipe, `&&`, a redirection, `$VAR`, a leading `~`, a wildcard or a comment outside quotes, `$VAR` or a substitution inside double quotes, `$'…'`, and a backslash at the end of the line. So that a Windows path works, a backslash before a letter, a digit, `.`, `_` or `-` is kept (`C:\agents\run.py`), and two backslashes in a row are refused. Put the rest in a script. The first time a command runs in a folder, the dashboard asks before running it; the same command in the same folder doesn't ask again, unless its model calls would now go to another model server.

When `init` finds that the project talks to a model server of its own (`OPENAI_BASE_URL` in its `.env`, or a local base URL in its code, as with Ollama or vLLM), recording sets `SHADOWLAP_UPSTREAM_OPENAI` to that server, as `init` tells you to in a terminal, so the calls go there and not to the provider's API. A server address with credentials in it (a password, or a key in its query) is never stored or shown, so such a project is recorded in a terminal.

### Removing a project

**Remove from dashboard** takes the project off the list. Nothing on disk changes: the folder and its code, its store, `shadowlap.config.json` and the goldens stay, and the list remembers how far its setup got and the commands you confirmed, so adding the folder again undoes it. **Also delete its recordings** deletes the store as well (`.shadowlap/shadowlap.db` and the files SQLite keeps beside it) once you type the project's name, and the list forgets the project: added again, its setup starts afresh. It won't while a run is recording there or when the folder can't be written to, and it never touches the goldens in your repository. Repair reports, exports and files sent to jobs, in `.shadowlap/repairs`, `.shadowlap/exports` and `.shadowlap/uploads`, are copies of their own and stay too: the dialog names the ones there, so delete them yourself if they hold what you mean to delete. The only project can't be removed.

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
- The browser never sends a command line: it names an action or a job and its fields, and the server builds the CLI arguments from the run, the call and those fields. The command you give a capture's replay is placed only after `--`; so will be a [project's](#projects) first recording, split without a shell.
- A download is only a file a job reported writing, only from inside the project folder (checked again when you download it, links followed), and always saved rather than opened. Uploaded files stay inside the project folder and are deleted as described under Actions.
- A read-only dashboard refuses every request that would change something.
- The page loads nothing from the network (fonts are bundled) and runs under a Content-Security-Policy that allows only its own script.

To use it on a remote machine, forward the port over SSH (`ssh -L 4777:127.0.0.1:4777 host`) rather than binding it to a public interface. Closing the terminal stops the dashboard and its jobs; to keep it running after you log out, start it inside `tmux` or `screen`.

## How the page stays current

The server keeps a change feed: one small endpoint that says what changed since the page last asked, so a page that polls it fetches again only what moved. A run added, ended, labelled or deleted, by the dashboard, the CLI or another dashboard, means the run list; calls arriving mean the recording that is growing, with its count; a command's activity entry means the feed; a job starting, ending or reporting what it made means the jobs. A running job's output is not in the feed: the drawer follows it from the job itself, from the last line it has. The store counts its own writes, so asking costs almost nothing, even with a recording in progress.

For contributors, the server's endpoints are registered by feature in `packages/dashboard/src/routes/`, and the shapes they answer with are in `packages/dashboard/src/views.ts` and `api.ts`:

| Endpoint | |
|---|---|
| `GET /api/meta` | Version, store and its size, address, read-only and why, runs and attempts counted apart, live runs, job kinds, project folder |
| `GET /api/changes?since=<cursor>` | What changed since the cursor: runs, calls, activity, jobs, and the live runs with their call counts |
| `GET /api/activity?limit=&before=` | The activity feed, newest first, `limit` entries a page; pass `next` (opaque) as `before` for the page after, or a time in milliseconds for everything older |
| `GET /api/runs`, `/api/runs/:id`, `/calls/:n`, `/lineage`, `/export` | Runs, one run, one call, its family, the HTML download |
| `POST /api/runs/:id/labels`, `/notes`; `DELETE /api/runs/:id` | Changes to a run |
| `GET /api/search?q=`, `GET /api/compare?a=&b=` | Search recorded content; compare two runs |
| `POST /api/jobs { kind, … }` | Start a job of a registered kind (`/api/meta` lists them); `POST /api/runs/:id/actions` starts a run action |
| `GET /api/jobs`, `GET /api/jobs/:id?after=n`, `POST /api/jobs/:id/stop` | Recent jobs (without output or result); one job's output from line `n`, its runs, links, files and result; stop it, with its agent |
| `GET /api/fixes?status=`, `/api/fixes/:id`; `PUT /api/fixes/:id/title` | The fixes (all, open, verified or applied) with their counts; one fix, by its id or a prefix, with its three steps; its title |
| `GET /api/fixes/family/:runId` | The attempts blame and verify made in a run's family, bundled per probe and per verified run, each with the fix step it leads to |
| `GET /api/files/:fileId` | A file a job wrote, as an attachment |
| `POST /api/uploads` | A file for a job (raw body, name in `x-filename`); answers its `uploadId` |

Every request needs the session token in `x-shadowlap-token`. A command reports to its job by writing one JSON object per line to the descriptor `SHADOWLAP_EVENTS_FD` names: `{"type":"run","runId":…,"role":"new"|"attempt"}`, `{"type":"link","label":…,"href":"#/…"}`, `{"type":"file","path":…,"label":…}` and `{"type":"result","data":…}` (`emitJobEvent` in the CLI does it). Outside a dashboard job the variable is unset and nothing is written.
