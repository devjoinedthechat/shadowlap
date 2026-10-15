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
- **Activity**: what happened in the project, newest first, each entry with who did it. Most of it comes from the runs themselves: recordings started and finished, clean replays, forks with the flags that made them (`--fail-at 19=529`, `--model 15:claude-opus-5`, as the replay kept them on the run), the attempts of one `replay --repeat` as one entry with how many took the same path, captures and packs imported (the runs one import or one pack brought in as one entry), tests passed or failed with their checks, and blames. A replay that parted from its recording only over a value that changes on every run, such as a UUID or a timestamp, reads as diverged rather than forked: nobody changed anything, and a normalizer would mask it. The rest is what commands record as they change the project or write something: normalizers and redaction rules added (by hand or by `calibrate --write`; a redaction rule is named by what it puts in place, never by its pattern), goldens packed (a pack in a goldens folder or named in the config's `tests`) and other packs, the project set up by `init`. Who did it is the run's author, worked out when it was made: `SHADOWLAP_AUTHOR` if set, `ci` in CI, else git's `user.email`, else the OS user. It stays on this machine: packs and HTML files (`export html`, or **Download** on a run) leave the author out.

## Actions

Labels and notes are saved to the store, and, like actions, only from a dashboard started with `shadowlap dashboard`. **Replay** re-runs the recorded command. **Fork at #n** offers what the terminal UI's actions palette offers for the selected call: force a tool live, override a tool's result, inject an instruction, fork with your changed prompt from here, answer a model call with an HTTP failure (`--fail-at`), switch the model, or diverge here; and for the run, stub writes, repeat the replay and compare the attempts (`--repeat`), add the suggested normalizer, or pack the run. A run imported from a capture has no command, so **Replay** asks for yours; the forks that ask for something else are greyed out until that replay exists, since it records every kind of call and every fork works on it. **Delete** removes a run and the recorded data nothing else uses.

Each action is a job: the dashboard runs the CLI in the directory it was started from, and the job's output streams into a drawer titled with what it does (Replaying, Forking, Repeating, Packing). The command also tells the job what it made, on a pipe of its own rather than in its output: the runs it started (attempts listed apart, since they open as a bundle), where to go next, the files and folders it wrote, and its result (what `--json` would print). So the drawer ends on the outcome and links to the new run or the attempts without reading the text, names the folder a pack went to, and offers a file a job wrote for download. Closing the drawer leaves the job running. Stopping it stops the command and the agent it started, even an agent that ignores the signal (it is killed after five seconds); a run it left recording is marked as interrupted, so it no longer shows as live and can be deleted. Stopping the dashboard (Ctrl-C, a kill, or closing the terminal it runs in) stops its running jobs the same way and waits for them; stopping it again while it waits kills them at once. The dashboard the terminal UI opens (`o` in `shadowlap ui`) does the same when you quit the terminal UI or it is killed, and kills its jobs at once when the terminal it runs in closes.

Some jobs take a file from your browser, such as a capture to import. The dashboard keeps it in `.shadowlap/uploads` in the project folder, readable only by you, at most 64 MB and 32 files at once, until the job that uses it ends. A file no job used is deleted after an hour, and every upload is deleted when the dashboard stops. Uploaded files are untrusted data: the command that reads one parses it as it would any file you point it at.

## Read-only

`shadowlap dashboard --read-only` shows every page and changes nothing in your runs: replay, fork and the other actions, labels, notes, uploads and deletes are refused, and each says why where you would have used it. Downloading a run as HTML still works, since it changes nothing. Use it to show a colleague your runs, or to look around without the risk of a click changing something. It needs an existing store and never creates one, and it leaves the uploads folder alone (even files another dashboard left there); it opens that store the way every command does, which brings an older store's layout up to date and lets search build its index. A dashboard started without the CLI behind it (embedded elsewhere) is read-only in the same way.

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
- The browser never sends a command line: it names an action or a job and its fields, and the server builds the CLI arguments from the run, the call and those fields. The command you give a capture's replay is placed only after `--`.
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
| `GET /api/files/:fileId` | A file a job wrote, as an attachment |
| `POST /api/uploads` | A file for a job (raw body, name in `x-filename`); answers its `uploadId` |

Every request needs the session token in `x-shadowlap-token`. A command reports to its job by writing one JSON object per line to the descriptor `SHADOWLAP_EVENTS_FD` names: `{"type":"run","runId":…,"role":"new"|"attempt"}`, `{"type":"link","label":…,"href":"#/…"}`, `{"type":"file","path":…,"label":…}` and `{"type":"result","data":…}` (`emitJobEvent` in the CLI does it). Outside a dashboard job the variable is unset and nothing is written.
