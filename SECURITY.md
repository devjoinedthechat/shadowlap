# Security

Shadowlap sits between your agent and your model provider, stores what passes through, and replays it by running commands. This page says how to report a vulnerability, what Shadowlap protects and from whom, and the checks behind each claim. Please report vulnerabilities privately.

- [Reporting a vulnerability](#reporting-a-vulnerability)
- [Scope](#scope)
- [Threat model](#threat-model)
- [The sidecar](#the-sidecar)
- [Credentials and masking](#credentials-and-masking)
- [The store on disk](#the-store-on-disk)
- [Packs, captures and pulled runs](#packs-captures-and-pulled-runs)
- [Consent before running someone else's command](#consent-before-running-someone-elses-command)
- [The guard and the fence](#the-guard-and-the-fence)
- [Terminal output](#terminal-output)
- [The dashboard](#the-dashboard)
- [The team store](#the-team-store)
- [Repair](#repair)
- [The GitHub Action](#the-github-action)
- [MCP](#mcp)
- [Telemetry](#telemetry)
- [Known limits](#known-limits)

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository: **Security** → **Report a vulnerability**. Please don't open public issues for security problems.

- **Acknowledgement**: within 3 days.
- **A fix or a plan**: within 14 days.

## Scope

Reports about any of these are in scope:

- **The sidecar**: request handling, the loopback binding and session token, credential handling, replay serving.
- **The store and the pack format**: what is written to disk and how packs are parsed. Packs are untrusted input.
- **The dashboard server and the terminal UI**, including the actions they run.
- **`shadowlap mcp`**: how it finds a running sidecar, and what it serves with `--listen`.
- **The SDKs**, and the telemetry client and collector.
- **The team store**: how `push`, `pull`, `share` and the store commands reach a bucket, use credentials and check what they read.
- **The GitHub Action**: what it installs, the tokens it is given, and the fixes and pull requests it opens.

## Threat model

Shadowlap runs on your machine and in your CI, with your permissions. Within that, it protects:

- **Your credentials.** A model key is forwarded upstream and never stored. Cloud credentials stay on each machine, and the GitHub Action keeps its tokens from the agent.
- **Your recordings.** The store is readable only by you. Every copy that leaves your machine masks credentials, and every export applies your redaction rules.
- **Your machine.** Nothing someone else wrote runs as a command without your yes, becomes a path, rewrites your terminal or stalls a replay.
- **Your goldens and your team's runs.** A test replays what you or your repository vouched for, and an edit in the bucket can't change a replay here.

It treats these as hostile:

| Who | What they could try | Where it's stopped |
|---|---|---|
| A web page in your browser | Reach the sidecar, the dashboard or `mcp --listen` by DNS rebinding or a cross-origin request | [The sidecar](#the-sidecar), [the dashboard](#the-dashboard), [MCP](#mcp) |
| Another user on this machine | Read a session token or the store, or plant a link where a store's files go | [The store on disk](#the-store-on-disk), [the dashboard](#the-dashboard) |
| Whoever made a pack, a capture or a pulled run | Run a command, name a path, stall a replay or rewrite your terminal | [Packs, captures and pulled runs](#packs-captures-and-pulled-runs), [consent](#consent-before-running-someone-elses-command) |
| A repository you clone, or a pull request | Plant a link, ship a store or a golden, or reach CI's tokens | [The store on disk](#the-store-on-disk), [repair](#repair), [the GitHub Action](#the-github-action) |
| Anyone who can write to the bucket | Change a run, a fix's patch or the steps a fix runs | [The team store](#the-team-store) |
| What the agent or the model writes | Start a run with a command of its choosing, or plant a link, a mention or a workflow command | [Consent](#consent-before-running-someone-elses-command), [the GitHub Action](#the-github-action) |

Shadowlap is not a sandbox. A replayed agent runs with your permissions, and a process running as you can do what you can. [Known limits](#known-limits) lists what Shadowlap doesn't protect against.

## The sidecar

The sidecar is the local proxy every recording and replay goes through. It listens on loopback behind a session token, and forwards only to the hosts a provider or your config names.

### Who can reach it

- **Loopback and a session token.** The sidecar binds to `127.0.0.1` on a random port and requires a per-session token in every URL.
- **The `Host` it answers.** It answers only requests that name it in `Host` by a loopback address, or that in-process capture redirected to it. Those keep the `Host` of the host they were for, and name that host, one Shadowlap captures, in `x-shadowlap-upstream`.
- **DNS rebinding.** The `Host` check blocks DNS rebinding, as the dashboard's check does.

### Where it forwards

The sidecar forwards each kind of call only to the hosts its provider or your config names:

| Call | Forwarded only to |
|---|---|
| A call in-process capture sends | an `https` origin matching that provider's host list; for a declared host with a port, that port over `http` too |
| A call to a host declared under `http` in `shadowlap.config.json` | that host, over `http` or `https` |
| A WebSocket under a provider's path, such as OpenAI's Realtime API | the hosts that provider's calls may go to, tunnelled |
| An SDK's own telemetry, such as the OpenAI Agents SDK's trace export | the host the agent sent it to when that host is its provider's, else where the provider's calls go |

For the first two, the sidecar answers anything else with 403, so it can't be used to relay requests to arbitrary hosts. What it records of them:

- **HTTP hosts** declared under `http` are recorded as tool calls.
- **A WebSocket**: nothing sent over it is recorded, and an offline replay refuses it.
- **An SDK's own telemetry** is passed on while recording and never recorded. A replay answers it itself, so a replay's traces never reach the provider.

### In-process capture

Node and Python agents get a preloaded capture module. It sends to the sidecar the calls to these hosts, naming the original host in `x-shadowlap-upstream`:

- known model hosts: Azure OpenAI, Vertex AI, Bedrock, Claude on Microsoft Foundry, and the three base-URL providers;
- the hosts that `providers` in `shadowlap.config.json` declares.

`SHADOWLAP_CAPTURE=off` turns the module off. What it forwards:

- **Signed requests** are forwarded unchanged unless an intervention changes them. Then each is signed again with the credentials the agent signed with, when Shadowlap can read them from the environment or the shared files, and otherwise refused with the reason.
- **A redirect the Node module follows for `fetch`**: a request sent on to another origin goes without its `authorization`, `cookie` and `proxy-authorization`, as `fetch` itself drops them.
- **The headers the module adds for the sidecar alone** (`x-shadowlap-upstream`, `x-shadowlap-scope`, `x-shadowlap-failures`) never go anywhere else. A redirect a captured call's answer gives to another host is sent without them, whether the Node module follows it or Python's httpx or requests does, which copy a request's headers onto it.

### Requests and answers

- **A request's body is read whole or not at all.** One past its limit (1 GB for a model call) is answered 413 with none of it kept, and nothing is done with part of a message whose client left. The dashboard and the telemetry collector read theirs the same way.
- **A model API's answer reaches the agent without a `location` header**, live or replayed. No model API redirects, and a client that follows one (Node's `fetch` does) sends every header again, its key among them, to wherever it points.

## Credentials and masking

Shadowlap forwards a model call's credentials upstream and never stores them. It stores a captured call with its credentials masked, and every copy that leaves your machine masks them again. [Credentials](docs/normalizers-and-redaction.md#credentials) lists every rule: each header, name, body shape and command-line form.

### Model calls

- **Key headers are never stored.** `x-api-key`, `api-key`, `authorization`, cookies, and AWS's `x-amz-security-token`, `x-amz-date` and `x-amz-content-sha256` are forwarded upstream but never stored, in whichever of them a client sends its key. The anthropic package for Python 2.0 and later sends it as a bearer token.
- **An offline replay needs no real credentials.**
- **The query string** is stored without the credentials in it: `key`, `api-key`, `subscription-key`, a signature, and the other names [Credentials](docs/normalizers-and-redaction.md#names-that-hold-a-credential) lists.
- **The `anthropic-organization-id`** an answer names is not stored either.
- **The headers of the answer** reach the agent unmasked, less a `location`, the hop-by-hop headers and the provider's own credential headers. They are stored with each credential they carry masked, as a captured host's are.

The answer's credentials masked in the store include a token header, one whose value is a JWT (a gateway's `x-amzn-oidc-data`), a token in a URL in `link` or `content-location`, and a challenge's token.

### Captured HTTP calls

Calls to the hosts declared under `http` in `shadowlap.config.json` are captured as model calls are, and recorded as tool calls.

- **Only declared hosts.** The sidecar makes these calls itself only to a host the config declares, over `http` or `https`, and answers anything else with 403.
- **Their request headers are never stored.**
- **Credentials are stored as `<CREDENTIAL>`**: in the call's address and its name, in its body, read by its shape whatever its content type says, and in what the response hands back, its body and its headers.
- **A response's `set-cookie` is never stored.**
- **Kept on purpose.** A count or a limit of tokens, such as Bedrock's `x-amzn-bedrock-input-token-count`, is kept as sent only as a count of at most 12 digits, a time or a duration. Azure's `azureml-model-session`, a routing hint that signs nobody in, is kept only as Azure writes it.
- **Each credential is masked in place**, the rest of the body kept as the service sent it.
- **The agent gets the real values while recording**, and a client that reads its token from the response still finds it there on replay.

[Credentials](docs/normalizers-and-redaction.md#credentials) lists what is read as one: webhook secrets in a path, sessions, every body shape, the secrets a secret store hands back, and each response header.

### What each copy masks

Every copy masks again the credentials a recording an earlier version made kept, when they weren't yet known to be credentials, except in the error a call ended with. That holds for a pack (with `--no-redact` too), an HTML report and a share link, a HAR, and a push to the team store. The redaction rules, and what happens to the run's command line, differ by copy:

| Copy | Redaction rules | The run's command line |
|---|---|---|
| The store, `.shadowlap/` | none: it holds what was recorded | as it ran, since a replay runs it again |
| `shadowlap pack` | every rule; signed reasoning kept as recorded | as recorded, but for its credentials, as `<CREDENTIAL>` |
| `shadowlap export html` | every rule; signed reasoning masked like any text | masked by the rules without a path; its credentials as `<CREDENTIAL>` |
| A share link | every rule, always, as `export html` applies them | as `export html` |
| `shadowlap export har` | every rule on its model calls | not in a HAR |
| `shadowlap export dataset` | every rule on its conversations and answers | masked |
| `shadowlap export otel` | a trace carries no prompt text; the rules without a path on its names and errors | masked |
| A push to the team store | none | as recorded, but for its credentials, as `<CREDENTIAL>` |

[Where the rules apply](docs/normalizers-and-redaction.md#where-the-rules-apply) has the detail for each copy.

### Redaction rules

`shadowlap pack` applies the redaction rules in `shadowlap.config.json` to every stored request and response in the exported copy; the local store is left untouched. A rule is a pattern such as `shadowlap redact add --pattern email`, a UUID or a `/regex/`, or a path-scoped rule.

- **A redacted pack still replays.** It records its rules, and still replays cleanly, because the same rules are applied when matching.
- **Signed reasoning stays as recorded in a pack**, whatever the rules: Anthropic's `thinking` and `redacted_thinking` blocks, Gemini's `thoughtSignature`, an OpenAI reasoning item's `encrypted_content` and the like. A fork sends it back, and the provider refuses a block that was changed.
- **What a rule matches inside signed reasoning leaves with the pack**, so `pack` names each rule that does, and the calls. A copy that is only read (an HTML report, a share link, a HAR, a dataset) masks it like any other text.

### Placeholder keys on replay

A replay can give the agent a placeholder key, so a client that takes its key from the environment sends what the recording answers. The placeholder is `shadowlap-offline-replay-placeholder`, or for Bedrock, AWS credentials whose access key is `SHADOWLAPREPLAY`.

The agent gets one only for a provider the recording called whose credentials the environment lacks. A key you set is never replaced. Every source the provider's SDKs read counts as credentials:

| Source | What counts |
|---|---|
| Any provider | a key or token variable, set and not empty |
| Anthropic | a profile: `ANTHROPIC_PROFILE`, `ANTHROPIC_FEDERATION_RULE_ID`, or an active profile in `ANTHROPIC_CONFIG_DIR`, `$XDG_CONFIG_HOME/anthropic` or `~/.config/anthropic` |
| OpenAI | `OPENAI_ADMIN_KEY` |
| Microsoft Entra ID | `AZURE_OPENAI_AD_TOKEN`, `AZURE_CLIENT_ID`, `AZURE_FEDERATED_TOKEN_FILE`, `IDENTITY_ENDPOINT`, `MSI_ENDPOINT` |
| AWS | its profile, web identity, container credentials, `AWS_BEARER_TOKEN_BEDROCK`, and a profile in its shared files that holds credentials |

Two sources don't count. An Azure CLI sign-in is none, since Azure OpenAI's and Foundry's clients read it only through a token provider their code gives them. Neither is an AWS config file that names only a region.

Which commands give one:

| Command | Placeholder |
|---|---|
| Offline replays: `shadowlap test` and the GitHub Action, recorded tests, `bisect` without `--fork`, `calibrate` | yes |
| `shadowlap replay`, which goes live from a fork | only for a provider whose key the recording's own environment held |
| Commands that run live on purpose | none |

- **`shadowlap replay`** leaves a key from a `.env` file, a token provider or an instance role to the agent.
- **Azure OpenAI** gets one only for a recording whose environment held `AZURE_OPENAI_API_KEY`.
- **Azure OpenAI and Bedrock** get none with `SHADOWLAP_CAPTURE=off`, when their calls would go straight to the provider.

[How it works](docs/how-it-works.md#keys) lists which commands are offline and which may go live.

**A placeholder is never sent.** The sidecar answers a live call that carries one, in any header, in an AWS signature or in the query string, with `a live call needs a real key: set ANTHROPIC_API_KEY, or keep the replay offline` instead of forwarding it. That holds whatever the upstream: a provider, a gateway, a model server on this machine or a mock. A call to a host declared under `http` that passes one on is answered the same way.

**Key names, never values.** A run keeps the names of the key variables its environment held (`keyEnv`), never a value. A reader of a pack takes from it only the providers and variables Shadowlap knows.

### What masking costs

Masking a captured body reads all of it, in time that grows with its length, never its square. Each pattern it reads a body with passes the check a [redaction rule's pattern](docs/normalizers-and-redaction.md#patterns-that-could-take-too-long) must, and a test holds them to it.

Counted in CPU time, which a busy machine inflates far less than the clock, a megabyte took:

| Body | CPU time per megabyte |
|---|---:|
| JSON, a page or a binary body | 20 to 40 ms |
| An event stream or lines of JSON | 50 to 80 ms |
| Text shaped to be slow: an object opened over and over, never closed | over 400 ms |

So storing a 20 MB body held the sidecar's thread, which every agent's model streams and calls go through, for 0.4 to 1.5 seconds, and over 8 for one shaped to be slow. Where each body is masked:

- **A body of 64 KB or more** is masked and stored on a thread of its own. The sidecar's thread only hands it over and takes it back stored: under 10 ms for 20 MB, about 95 for a 20 MB JSON request, whose stored body comes back as values.
- **A shorter one** is stored in place, in 25 ms at most.

What is stored is the same either way, and the call is answered once it is.

## The store on disk

Recordings live in `./.shadowlap/`, which gets its own `.gitignore` so they stay out of version control. Shadowlap keeps the store readable only by you, and opens none that someone else could have swapped.

| File | Mode |
|---|---|
| The store directory Shadowlap makes | `0700`, readable only by you |
| The database and its WAL files | `0600` |
| `.shadowlap/active.json` | `0600` |

- **Older stores are tightened.** A store created by an earlier version is tightened when it is next opened.
- **Made without following a link.** A store is made with `O_CREAT | O_EXCL | O_NOFOLLOW`, never through a link.
- **`.shadowlap/active.json`**, which tells `shadowlap mcp` where the running sidecar is, carries the session token. A symbolic link at that path is replaced rather than followed.

A store is opened only when all of these hold, checked before anything is written in it:

- **Its files.** Its file, and its write-ahead log and shared-memory files when they exist, are regular files you own. A symbolic link there (which a checkout could plant), a folder or another user's file is refused.
- **Its directory.** It is a directory you own that no one else can write to. A store directory that is a link, another user's, or writable by its group or by everyone is refused. A shared `/tmp` is among them, where anyone could put a link where a store's files go.
- **The directory above it.** A store directory inside one another user keeps, that everyone can change and that isn't sticky, is refused, since anyone could put another directory in its place.

## Packs, captures and pulled runs

A pack can come from anyone: a colleague, an issue attachment, a pull request. A capture can come from anywhere a pack can, and a pull brings runs from a bucket others write to. Shadowlap treats each as hostile until checked.

### Packs

`shadowlap unpack` and `shadowlap test` check a pack before they write anything, and a pack that fails any check imports nothing.

**Validation before any write:**

- **Shape.** Every run and call is checked for type, range and shape. Errors name the file and line.
- **Ids.** Ids must be real run ids and blob hashes, so nothing in a pack can become a path.
- **Control characters.** Strings in ids, names and command lines may not contain control characters. A command line and its folder may hold tabs and line breaks (`python -c '…'`), which every terminal shows escaped.
- **Disguised commands.** A command line may not hold a format character (a right-to-left override, a zero-width space) or a line or paragraph separator, which would disguise the command a replay asks to run.
- **Times.** A time more than a day ahead of this machine's clock is refused. A run marked as still running comes in as interrupted, so a pack can't hold up `rm` and `gc` with a recording nobody makes.

**Rules are checked before they run.** A pack's redaction rules, and the normalizer a divergence hint suggests, are read as the config's are. A replay applies the rules to every request, and the terminal UI and the dashboard offer to add the normalizer. So before anything is imported:

- a pattern that could take too long is refused: a backreference, a repeated part whose end the next character doesn't settle inside another, two of them outside one, or more than 10,000 characters;
- each path is parsed;
- no name, path or replacement may hold control characters.

A pattern the check takes can still take the square of a long text (`.*x`). So the rules applied to any one document run within 5 seconds and are stopped past it, naming them. A replay of a pack whose rule runs that long answers that call with why, and goes on.

**Integrity:**

- **Blobs.** Every blob is verified against its SHA-256 name. One git checked out with its line endings converted to CRLF is verified with them converted back, and imported only if that matches.
- **Completeness.** Every blob a call references must be present, including each part of a chunked request.

**Files:**

- **Regular files only.** Symbolic links, unexpected files in `blobs/` and oversized files are refused.
- **Checked on the descriptor.** Each file is opened without following a link and checked on the descriptor it is read from. So a link or anything else swapped in after a check is never read, and a file that grows or shrinks while it is read is refused.

| Limit | Size |
|---|---:|
| Each blob | 256 MiB |
| All blobs | 4 GiB |
| `run.json` | 16 MiB |

A pack's command needs your consent to run: see [Imported runs](#imported-runs).

### Captures

`shadowlap import` reads a capture made by something else: a HAR, a nock recording, a VCR cassette. It is treated the same way as a pack.

- **Nothing identifying is taken from the file.** Run ids, call numbers, fingerprints and occurrences are computed, never read from the capture, so nothing in it can become a path or collide with an existing run.
- **Only model API calls are imported.** An entry whose host is not one of the six providers is skipped with a reason, so a capture of a whole browsing session contributes only its model traffic.
- **No YAML parser is trusted with a cassette.** `import vcr` reads VCR's JSON serialization; a YAML cassette has to be converted first, deliberately.
- **Credentials are dropped**, not stored: `authorization`, `x-api-key`, `api-key`, cookies, `proxy-authorization`, `x-goog-api-key` and `x-amz-security-token`, on both the request and the response, and the credentials in a URL's query string.
- **Other answer headers are kept** as the capture holds them, and every copy masks a credential among them.
- **Imports are partial recordings.** A capture never saw tool, clock or randomness calls, so a replay runs those live. Write tools are still fenced by `--writes`, which defaults to blocking them.

**Header text is escaped and bounded.** Header names and values end up in run metadata that terminals and the dashboard render. So control characters are escaped where they are stored, rather than relied on to be escaped at every point of display.

- **Lengths.** Names are capped at 256 characters, values at 8192, and a call keeps at most 100 headers.
- **Nothing legitimate changes.** Real HTTP headers carry neither control characters nor those lengths, so nothing legitimate changes, a fingerprint included.

### A capture's message as an argument

`shadowlap coverage --pack` fills `{message}` in the command you give with a capture's first message: text from production. The message is only ever an argument of your agent's.

- **Code and programs.** A placeholder where the message would run as code or name what runs is refused. That is a shell's script, the argument after an interpreter's `-c`, `-e` or `-m`, the program, or the script an interpreter runs or one of its flags.
- **Runners and package managers.** So is the command a runner such as `env`, `cross-env` or `npx` runs, or what a package manager's subcommand such as `npm exec`, `pnpm dlx`, `bun x`, `uv run` or `pipx run` runs.
- **A leading dash.** A capture whose message would start an argument with a dash is left out.
- **Patterns.** A `{message:/regex/}` pattern is checked as a redaction rule's pattern is, and runs on each message within the same time limit.

**On Windows**, a batch file can read its arguments again. It passes them on with `%*`, as npm's `npm.cmd` and `npx.cmd` and every bin npm, pnpm or yarn installs do, or puts one in its line as `%1` or `%~1`. Then cmd.exe reads them twice, so they are escaped twice. A quote in the message can't end it there, nor `%~1` take its quotes off, and run what follows as a command.

- **Escaped once** only for a file that reads its argument as `"%~1"` alone, which is safe escaped once.
- **A chain of batch files** has cmd.exe read the argument a third time, which no escaping can foresee. Give `coverage --pack` a command that runs your agent, not a chain of batch files.

### Pulled runs

Runs pulled from the [team store](#the-team-store) are untrusted input, checked as strictly as a pack:

- every record validated, and every blob checked against its hash;
- every redaction rule's pattern read as a pack's is;
- nothing in them that could rewrite a terminal.

A run that fails the checks is skipped. A pulled run is marked imported, so replaying its command asks first.

## Consent before running someone else's command

A pack records the command that produced it, and replaying re-runs that command. So Shadowlap marks each run whose command someone else chose, and asks before it runs that command.

| Run | Runs without asking | Otherwise |
|---|---|---|
| An imported run, from a pack or pulled from the team store | only your own command, given after `--` | asks; without a terminal, refuses unless you pass `--yes` |
| A run a program started through the sidecar's API | only your own command, given after `--` | asks, as for an imported run |
| A golden | its command, when this machine recorded it with that command or your git repository tracks its pack | asks at a terminal, or takes `--yes`; without a terminal, the golden isn't run |
| A run imported from a capture | it has no command: only yours, given after `--` | `replay` and `test` refuse rather than run a placeholder |

### Imported runs

- **Marked, whatever the pack claims.** Imported runs are marked, whatever the pack claims about itself. Replays of an imported run inherit the mark.
- **`shadowlap unpack`** prints each imported command.
- **`shadowlap replay`** of an imported run asks before running it, and refuses without a terminal unless you pass `--yes`. It runs your own command without asking when one follows `--`.
- **`shadowlap bisect`** of one does the same, since it would run the command at every commit it tries.
- **A run a program starts through the sidecar's API** with a command of its choosing (`POST /v1/runs`, or the recordings API's `command`) is marked the same way. Whoever holds the session token chose it, and an agent the sidecar records is among them.
- **A pulled run** is marked imported, so replaying its command asks first.
- **The terminal UI and the dashboard** show the exact command line, and ask a yes of its own before a replay of an imported run, after whatever the action asked first.

### Goldens

A golden's replay runs the command its pack recorded, and so does every command that replays a golden: `shadowlap test` (with `--chaos` too), `bisect`, `injection`, `decisions` (with `--from-code`, `--then-verify` or `--verify`), `migrate`, `tasks score` and `tasks serve`.

- **Runs without asking**: a golden this machine recorded, with the command it was recorded with, or one whose pack your git repository tracks (its `run.json` is in the repository's index). That is where your goldens live.
- **Needs a yes**: a pack from anyone else, outside the repository or in it but not added. It runs its command only after a yes at a terminal or with `--yes`.
- **A reused id**: a pack that reuses the id of a run recorded here, with a command of its own, is someone else's too.
- **Without a terminal**, as in CI, that golden isn't run, saying why. `tasks serve` asks as it starts, and serves only the goldens you said yes to.
- **In the dashboard**, a job that passes `--yes` on (decisions, migrate, verifying what a session flagged, an injection test) asks the same question first, naming the command. It passes `--yes` only once it asked; its other jobs run the CLI with no terminal, which refuses such a golden.

**Warning:** In CI, a pull request that changes a golden could change any other code CI runs too. Review changes to goldens like changes to code.

### A capture's run

An imported capture's run carries no command. A capture says what was sent, not what sent it, so there is nothing to execute. The run is marked imported, and its recorded command is the non-runnable placeholder `<no-recorded-command>`.

- **Replaying it** needs a command you supply after `--`. `shadowlap replay` without one, and `shadowlap test` on a golden packed from it, refuse rather than run the placeholder.
- **In the dashboard**, its replay asks for your command. What you type is split on the server and placed only after `--`, where `shadowlap replay` takes the agent's command; it never becomes one of Shadowlap's own arguments.
- **It is your command**, so it runs without the consent an imported pack's command needs.

### Jobs in the dashboard

A dashboard job that would run someone else's command (a pack's, a teammate's pulled from the team store, one a program sent the sidecar) is refused with a question:

1. The question names the exact command lines, and its `confirm`: a digest of those lines.
2. The yes the page sends back is that digest, so it says yes to those lines only.
3. The server builds the command again for the yes. One that differs by then, because a pull changed the fields it is made from, is asked again.

A teammate's fix runs its steps only from checked fields, and only after a yes: see [A pulled fix](#a-pulled-fix).

## The guard and the fence

The network guard and the fence keep a replay faithful: what the recording doesn't hold doesn't run unseen. Neither is a sandbox.

### The network guard

The network guard (`--guard warn|block`) keeps replays faithful by reporting or refusing connections that bypass the sidecar.

- **It is not a sandbox.** A replayed agent runs with your permissions and can still read files, spawn processes and reach the network by other means.
- **Knowing it loaded.** Each Node and Python process tells the sidecar when the guard's preload has loaded. A run the guard never watched says so, and under `--guard block` fails.
- **Sockets a C library opens** are out of its sight: libpq under `psycopg`, `mysqlclient`, `grpcio`, Node's native addons. Wrap such calls as tools with a `write` effect.

### The Claude Agent SDK's fence

The Claude Code CLI that the Claude Agent SDK runs loads no preload. The SDK's [fence](docs/frameworks.md#claude-agent-sdk) names what that CLI can still reach: WebFetch, an MCP server over the network, a hook or credential helper that isn't Python, and its own traffic. Under `--guard block` the run fails unless nothing is left, or `guard.accept` takes the CLI as it is.

### Tools the recording doesn't hold

A replay runs again whatever its recording doesn't hold. So every command that replays a run refuses to start when the model called a tool the run never recorded that writes, or that nothing says the effect of:

- **The commands**: `replay`, `test`, `blame`, `verify`, `repair`, `calibrate`, `bisect`, `injection`, and recorded tests through `serve --recordings`.
- **Such tools**: a built-in such as `Bash`, a name such as `send_email`, or one the config declares.
- **What lets it start**: the tool wrapped, declared a read, or allowed with `--allow-unrecorded` (`SHADOWLAP_ALLOW_UNRECORDED` for recorded tests).

## Terminal output

Recorded strings are shown with these escaped, in the CLI, `diff`, reports and the terminal UI:

- control characters;
- format characters, such as a right-to-left override or a zero-width space;
- line and paragraph separators.

So a recorded prompt, tool name or error cannot rewrite your terminal or disguise what it shows. A command line you are asked to say yes to shows a word holding such a character in `$'…'` quotes, the character as its escape. So it shows what runs, and still runs when typed.

## The dashboard

`shadowlap dashboard` listens on loopback behind a session token. It checks the `Host` of every request, and refuses a change that a page from another origin asks for.

### Who can reach it

- **Loopback only.** It listens on `127.0.0.1` only, and answers only requests addressed to `localhost` or a loopback address, which blocks DNS rebinding.
- **A token in the fragment.** The link it prints carries a random session token in the URL fragment, so the token never appears in server logs or `Referer` headers. Every API request must send it.
- **No token in a process's arguments.** The dashboard opens your browser through a file only you can read, in a folder only you can open, which sends it on to the link. So the token is never in a process's arguments, where any user of the machine could read it.
- **No changes from another origin.** Requests that change anything are refused when a browser sends them from another origin, even with the token.
- **A strict page.** The page runs under a strict Content Security Policy, loads nothing from the network, and serves only its own bundled files.

### What it runs

- **A fixed list of commands.** Actions map to a fixed list of CLI commands built on the server. The browser never sends a command line.
- **Someone else's command** needs a yes to those exact lines: see [Jobs in the dashboard](#jobs-in-the-dashboard).
- **Edit and fork.** An answer edited in the call inspector (**Edit and fork**) goes to the server as an upload, and is checked as untrusted data. It becomes the fork's `--override`, which the server writes into the command itself.
- **Read-only threads.** What reads a whole run or the whole store (the Overview, a run's page, Compare, the Runs table's totals) is worked out on threads beside the server, each through a connection to the store that only reads.
- **Share → HTML file** saves a run and the runs it came from as one HTML file, with the redaction rules in `shadowlap.config.json` applied, as `shadowlap export html --lineage` does. With no rules, the Share menu says a copy holds what was recorded.

### Limits

| What it reads | Limit |
|---|---|
| A tool's result, edited in **Edit and fork** | UTF-8 JSON of at most 2 MB |
| A person's answer, edited in **Edit and fork** | UTF-8 text of at most 65,536 characters |
| A request's body | read whole or not at all, as the sidecar reads its own |

## The team store

The team store is a bucket you own. Shadowlap hosts nothing for it, and nothing calls home. [The team store page](docs/team.md) covers setting one up.

- **Credentials stay on each machine.** Every machine reaches the bucket with its own credentials, found where the cloud's own tools keep them. `shadowlap.config.json` names only the bucket.
- **A committed config can't send credentials elsewhere.** Google and Azure credentials, whose signatures don't name the host, are sent only to the cloud's own addresses over https or to this machine. An `?endpoint=` anywhere else is refused.
- **Only the store's folder is reached.** Anyone who can write to the folder names the objects in it. So a pull reads only objects named as a push names them: a run's id and a blob's hash are checked before they make a name.
- **No `.` or `..` keys.** No request is ever made for a key with a `.` or `..` part, so nothing outside the store's folder is read or written with your credentials.
- **Pulled runs are untrusted input**, checked as strictly as a pack: see [Pulled runs](#pulled-runs).
- **A share link's report** has every redaction rule applied, holds no credential a recording kept, and masks a model's signed reasoning like any other text. The link expires after 7 days.

### What a push sends

Runs go up as recorded, but without their credentials.

- **No redaction rules.** A push applies none: the bucket holds what `.shadowlap/` holds, so give it the same care.
- **No credential an older recording kept.** A credential a recording made by an earlier version kept stays behind, as the sidecar records them. A model call's query string goes without its credentials, and a credential response header with `<CREDENTIAL>` for its value.
- **A captured call's credentials stay behind** too: its name, address, request and answer go with their credentials masked.
- **A run's command** is kept in the store as it ran, which a replay runs again. Whoever replays a copy gives their own key.

**Command lines.** A key the agent's command line carries goes as `<CREDENTIAL>` too, as in a pack, an HTML report, a trace and a dataset. [Command lines](docs/normalizers-and-redaction.md#command-lines) lists every form; among them:

- the value of a flag that takes one (`--api-key …`, `--token=…`, `-password …`), but not `--token-file …`;
- an assignment's value, when its name reads as a credential (`OPENAI_API_KEY=…` after `env`, `--set auth.password=…`), and else the URL's password, the JWT or the header line it gives (`DATABASE_URL=postgres://app:…@db`, git's `-c http.extraheader=…`);
- a header line (`-H 'Authorization: …'`), a JWT, and a URL's password, query credentials and webhook secret;
- a password a program takes under a name that doesn't say so: curl's `-u user:…`, mysql's glued `-p…` and `docker login -p` among them;
- a body curl sends with `-d`, `--data…`, `--json` or `-F`, read as a form or as JSON;
- each of them in a script a program runs, read word by word as a shell reads it, such as `sh -c 'OPENAI_API_KEY=… node agent.js'`.

**A fix's command lines.** A fix goes up with the command line each of its blames, verdicts and repairs ran, with the same credentials masked. So do the flags kept beside them to run each again, a command after `--` and a `--build` included. This machine keeps those command lines masked too, and the flags as they ran, which run them again here.

### Pull requests' CI jobs

A pull request's CI job doesn't write to the team's runs.

- **Its own folder.** It writes only under `pr/<number>/`.
- **Left out of a pull.** A pull leaves those folders out unless given `--include-pr`, and a run brought from one is never pushed back.
- **Nothing taken.** Nothing such a folder says about a run already here is taken.
- **The cloud enforces it.** The CLI only puts those runs in their place. `shadowlap store policy` prints the pull-request policy that makes the cloud enforce it.

### A pulled fix

**A pulled fix's patch is someone else's code.**

- **One rewrite, one file.** A pull takes a fix only when each repair's patch is the one rewrite its accepted candidate makes, to that candidate's file alone and in place.
- **Checked again.** `shadowlap fix apply` checks it again before `git apply`, so an edit in the bucket can't make it write any other file.
- **Never a recording.** That file is never one of a recording: a pack's `run.json` holds the command a replay of it runs, which `shadowlap test` runs without asking once the repository tracks the pack.
- **Never Shadowlap's or git's files.** Nor is it `shadowlap.config.json`, or anything in `.shadowlap` or in git's own folder, whatever its case, trailing dots, stream or short name.
- **Read before it runs.** Its confirm dialog shows the patch. Nothing on this machine runs the code it put in (no build, test or replay of your goldens) until you have read it.

So a recorded command never changes through a repair, which only ever rewrites the text the agent sends the model, where its source holds it.

**A pulled fix's steps run only from checked fields, and only after a yes.** A pull marks every blame and verdict it brings as pulled, a mark that stays on this machine.

- **Built from checked fields.** Blame again, Run more attempts and Verify again build their arguments from the report and the flags kept beside it: each a flag Shadowlap allows, with a value of its shape. Never from a command line the fix carries.
- **No hidden characters.** None runs again with a value that holds a control or format character or a line or paragraph separator. A pull refuses a fix whose text holds one.
- **None of the teammate's commands.** A pulled one runs without a teammate's `--build`, `--base` and command after `--`.
- **A bounded budget.** It spends no more than twice what Shadowlap runs by itself, as the table below gives.
- **Only after you confirm.** It runs only once you confirm the exact command line, which the question shows. A pulled step's page offers the command made here to copy, never the one a teammate ran.

| Pulled step | At most |
|---|---|
| A blame's gate | 40 attempts, and 2 calls probed past its boundary |
| A verify's gate | 160 attempts a run |
| A fixed count | 10 |

### Edits in the bucket

An edit in the bucket can't change a replay here.

- **Your copy holds.** Anyone your cloud admin lets write to the bucket can change a run there, but not how a copy already on your machine replays, or whom it names as its author.
- **Versions and locks.** `shadowlap store check` warns when the bucket keeps no versions, which keep a run's earlier state, or no object lock, which keeps those versions from being deleted.

## Repair

`shadowlap repair` shows a model what the failing runs held, tool output included, through your redaction rules. Verify then builds the agent's prompt from the rewrite it gets back. So repair limits what a rewrite may hold, what it reads, and what it writes.

### What a rewrite may hold

A rewrite has to keep exactly the placeholders of the text it replaces, and add none. It may hold no quote or backslash beyond what the span it replaces already held. One that brings in `${process.env.GH_TOKEN}` or `{os.environ}`, or a backtick that would end the string literal a span sits in, is set aside before anything runs.

### What it reads

- **A prompt file that is a link** counts as the file it names only when git lists that file too: tracked, or untracked and not ignored. So a link to a file git ignores, such as a `.env`, or out of the repository, puts nothing of it in what the repairer is shown, a patch or a report.
- **Nothing of git's.** Repair reads nothing in `.git`, or in a git dir a `.git` file names, through a link included. Git's config can hold a credential (a remote's URL with a token, the header `actions/checkout` writes), so a link a pull request adds puts none of it in what the repairer is shown or in a report.

### What it writes

- **The file itself.** A candidate is read from, and written to, the file itself, never through a link out of it.
- **No swapped folders.** The file is opened without following a link and without being emptied, and written only once it is the file the path, walked again, names. So a folder on the way swapped for a link while repair opens it is refused, and what the link led to is left as it was.
- **No hard links.** A file with another name, a hard link, is refused the same way, since it is the same file wherever that name is.
- **A temporary worktree.** Each candidate is tried in a temporary git worktree, checked out without the repository's hooks, never in your working tree.
- **No linked `.shadowlap`.** A `.shadowlap`, or a `.shadowlap/repairs` in it, that is a link is refused, since a repository could ship one to send what a repair writes elsewhere. It is refused before the repair takes its lock, and again when it writes its report, patch and recordings.
- **A teammate's repair.** A pull writes a teammate's repair's files through no such link either.

**An older Shadowlap's journal.** Older versions tried candidates in the working tree, and left a journal when a repair died. Repair puts one back only when git says it is your checkout's own (a file it doesn't track, reached through no link), since a repository can ship one. It writes it only into the repository's own files, as a candidate is written, so no journal makes repair write a file outside the repository.

**Note:** A process running as you that rewrites the worktree as repair works crosses no boundary this guards: it could write those files itself.

### The pull request it opens

The pull request `--pr` opens is titled as the Action's: the fix's commit subject, the repairer's one line, on one line and at most 256 characters. A mention, an issue reference and a workflow command's start are split by a word joiner, which shows nothing.

### Claude Code as the repairer

`--repairer claude-code` runs your Claude Code on that content, restricted:

| Flag | What it keeps out |
|---|---|
| `--restricted` (Claude Code 2.1.248 or later) | your user, project and local settings: it loads managed settings alone, so no hook, permission rule or plugin of theirs runs |
| `--tools ''`, `--disallowed-tools 'mcp__*'` | every tool |
| `--strict-mcp-config`, with no server given | every MCP server |
| `--no-session-persistence` | a session kept on disk |

- **A fixed shape.** Its answer is held to a schema, and its system prompt is replaced from a file.
- **Signing in.** It signs in with your login or an API key in its environment, never through an `apiKeyHelper` or `env` of your own settings, which it doesn't load.
- **An older Claude Code**, one whose `claude --version` is older than 2.1.248, is refused before anything is blamed. An older one that names no version rejects `--restricted` itself.
- **A managed MCP config.** A Claude Code your organization's `managed-mcp.json` governs is refused too, since under it Claude Code won't start with no MCP server.

## The GitHub Action

The Action runs your agent in a job that may hold keys and tokens. It keeps GitHub's tokens from the agent, runs only on events that don't hand a pull request's code the base repository's secrets, and writes what the agent wrote as inert text.

### What it installs

- **No install scripts.** The Action installs the CLI from npm without running any package's install script, since the job may hold keys and tokens.
- **A build from source** (`build-from-source: true`) runs no install script either. It gets none of the job's environment but what npm and Node need, in a home and a temporary folder of its own.

### Tokens

- **No GitHub token reaches the CLI or the agent.** The job's own token, `github-token`, a `GH_TOKEN` in the step's env, the token the job asks GitHub for OIDC tokens with, and any variable that copies one are taken out of what they get.
- **Pushing a fix's branch.** The Action pushes with the token in git's environment alone, from a repository of its own made for the push: no config, no hooks, none of git's user and system config.
- **Opening the pull request.** It opens it through GitHub's API. Its steps check out with `persist-credentials: false`.

So the token is on no command line and in no file the agent could read, and no hook or remote the agent could leave in the checkout gets it.

**Warning:** That bounds where the token goes, not who can take it. While the agent runs, the Action's own process holds the tokens in its environment, and on any runner the agent's processes run as the same user, who can read it. The job's `permissions` are the bound on what an agent with a tool that runs code could do with a token.

### Where it pushes

The Action pushes a fix's branch to the repository the workflow runs in, as the runner names it, and only when the checkout's origin names it too. It checks that before a repair spends anything. Otherwise it pushes nothing, and never pushes to the origin in its place.

### Events

The Action runs on `pull_request`, `push`, `schedule`, `workflow_dispatch` and `merge_group` alone.

- **Every other event is refused.** It refuses to test or fix anything on any other event, `pull_request_target`, `workflow_run` and `issue_comment` among them. Each of those runs with the base repository's secrets and a token that may write, and is how a pull request's code gets run beside them.
- **No cache on another event.** On another event it neither restores the test history from the cache nor saves the job's store as a branch's.
- **No fixes for forks.** On a pull request it opens a fix only when the pull request is from this repository, never from a fork.

### What the agent wrote

The Action writes what a run, a model or the agent's source wrote, and what the test history a job restored from the cache says, as inert text:

- **A fix's pull request body, the Action's comment and its job summary** hold that text as text GitHub renders, links and mentions nothing in. So an image, a link or an `@mention` planted in a tool's output shows as it was written and does nothing.
- **The pull request's title** is the fix's commit subject, the repairer's one line, on one line and at most 256 characters. A mention, an issue reference and a workflow command's start are split by a word joiner, which shows nothing.

### The job's log

None of that text starts a line of the job's log either. The runner would read such a line as a workflow command: an annotation, `::add-mask::`, or `::stop-commands::`, which would silence the Action's own warnings.

- **Each line the Action writes** keeps that text on that line, escaped as a command's data is.
- **Repair's output**: a line that would start one is escaped where it starts, and at each `##[` in it.
- **`shadowlap test`**, whose lines reach the log as it prints them, escapes a failed golden's details, its message and an update's reason the same way.

## MCP

`shadowlap mcp` is a proxy that records, replays and fences an agent's MCP tool calls, in the run of the Shadowlap command that started the agent. It trusts only a loopback address, or a file you own and alone can read, to say where that run is.

### Finding the run

`shadowlap mcp` takes its run from these sources, in this order, each on its own terms:

| Source | Trusted only when |
|---|---|
| `SHADOWLAP_URL` | it is a loopback address |
| `~/.shadowlap/agents/<pid>.json` | it is a regular file you own, readable by you alone, naming the process it is filed under and that process's parent, pointing at loopback |
| `.shadowlap/active.json` | on the same terms, naming a process still running; read only where the process tree can't be read |

- **The agents file.** Shadowlap writes one for each agent it starts, and it carries the session token. Its folder is owner-only. It is in the project's `.shadowlap/agents` when the home folder can't be written.
- **No run to record into.** Started under a Shadowlap command that runs agents but unable to record into its run, it refuses write tools and passes reads through unrecorded.
- **Nothing pointing at Shadowlap.** It passes tool calls straight through, and says why. [Finding the run](docs/mcp.md#finding-the-run) has the detail.

### `shadowlap mcp --listen`

`shadowlap mcp --listen` serves the proxy over HTTP.

- **Loopback only.** It takes only a loopback address, and answers only requests that name that address in `Host` and, from a browser, in `Origin`. So a web page can't reach the server through it.
- **Any local process can.** Any process on this machine that can reach the port can reach the server through it, with the `--header` values the proxy holds.
- **Its registration.** It registers its address while it runs, in `~/.shadowlap/mcp`, with a key it keeps. The network guard of the agents Shadowlap commands start lets them reach it: every command's agents when it was started on its own, its own command's alone when started under one.
- **When a registration counts.** Only when it is read from the home folder, is the user's own, owner-only and not a link, in an owner-only folder, and names the process it is filed under, which is running, at a loopback address.
- **It proves it runs.** A connection goes on only once what answers at that address proves it holds the registration's key. So one left behind by a proxy that died, even after its process id is reused, or planted, lets nothing through.

## Telemetry

The CLI sends nothing unless `SHADOWLAP_TELEMETRY_URL` names a collector, and it has no default endpoint.

- **What it would send** is listed field by field in [Telemetry](docs/telemetry.md). It never includes prompts, tool names, arguments or results, file paths, hostnames, run ids or model names.
- **The collector** installs nothing but Shadowlap's engine, which has no dependencies of its own.
- **Closed sets.** The collector rejects any event with a field outside its allowlist or a value outside its closed sets, and any time before 2025 or more than a day ahead of its own clock.
- **Turning it off**: `SHADOWLAP_TELEMETRY=0` or `DO_NOT_TRACK=1`.

## Known limits

- **Recordings contain everything your agent saw**: prompts, tool inputs and outputs, and any user data in them. Treat `.shadowlap/` and any pack you export as sensitive.
- **Redaction is pattern-based.** It masks what your rules describe and nothing else, so review a pack before sharing it.
- **Signed reasoning leaves with a pack** as recorded, with whatever a rule matches inside it. `pack` names each such rule, and the calls.
- **Encoded secrets.** Masking reads what a credential is written as, not what it is encoded into. A secret left encoded is stored as it came: in base64 (JSON a form field carries, a JWE), percent-encoded twice, in a string nested more than six deep (an event stream inside an event's data is one level), or in UTF-16.
- **A body stored compressed as it came isn't masked**: a request body the agent compressed, and an answer under two content encodings at once (`gzip, br`), which the sidecar passes on as it came, without its `content-encoding`.
- **Rules for encoded secrets.** Write a [redaction rule](docs/normalizers-and-redaction.md) for a secret left encoded: every copy applies the rules. No rule reads a body stored as bytes (compressed, UTF-16), and a push applies none, so keep a key out of those.
- **The network guard is not a sandbox.** A replayed agent runs with your permissions, and the guard can't see a socket a C library opens.
- **A process running as you** crosses no boundary Shadowlap guards. It could rewrite a worktree as repair works, and on a runner it can read the tokens the Action's process holds.
- **`shadowlap mcp --listen`** lets any process on this machine that can reach its port use the `--header` values the proxy holds.
- **Anyone who can write to the bucket** can change a run there, though not a replay here. Versions keep its earlier state, and an object lock keeps those versions from being deleted.
- **A store in a repository you cloned** is someone else's data, like a pack. A store is normally ignored by git, but a repository can force-add one. Don't replay runs from a checkout you don't trust.
- **Goldens in a pull request.** In CI, a pull request that changes a golden could change any other code CI runs too. Review changes to goldens like changes to code.
- **A pattern that passes the check** can still take the square of a long text (`.*x`). The rules applied to one document are stopped past 5 seconds.
- **A chain of batch files** on Windows reads an argument a third time, which no escaping can foresee.

## See also

- [How it works](docs/how-it-works.md): the sidecar, keys, and the network guard.
- [Normalizers and redaction](docs/normalizers-and-redaction.md): every credential rule, and the redaction rules you write.
- [Team store](docs/team.md): setting up a bucket, and what a push, a pull and a share link carry.
- [Telemetry](docs/telemetry.md): every field the CLI can send.
