# Security

Shadowlap sits between your agent and your model provider, stores what passes through, and replays it by running commands. Please report vulnerabilities privately.

## Reporting

Use GitHub's private vulnerability reporting on this repository ("Security" → "Report a vulnerability"). You'll get an acknowledgement within 3 days and a fix or a plan within 14. Please don't open public issues for security problems.

## What's in scope

- The sidecar: request handling, the loopback binding and session token, credential handling, replay serving.
- The store and the pack format: what is written to disk and how packs are parsed. Packs are untrusted input.
- The dashboard server and the terminal UI, including the actions they run.
- `shadowlap mcp` and how it finds a running sidecar.
- The SDKs and the telemetry client and collector.

## What Shadowlap does today

### Recording

- The sidecar binds to `127.0.0.1` on a random port and requires a per-session token in every URL.
- Credentials (`x-api-key`, `api-key`, `authorization`, cookies, and AWS's `x-amz-security-token`, `x-amz-date` and `x-amz-content-sha256`) are forwarded upstream but never stored, and replay needs no real credentials.
- Node and Python agents get a preloaded capture module that sends calls to known model hosts (Azure OpenAI, Vertex AI, Bedrock, and the three base-URL providers) to the sidecar, naming the original host in `x-shadowlap-upstream`. The sidecar forwards such a call only to an `https` origin matching that provider's host list, and answers anything else with 403, so it can't be used to relay requests to arbitrary hosts. A signed request is forwarded unchanged; the sidecar never signs or re-signs anything. `SHADOWLAP_CAPTURE=off` turns the module off.
- HTTP hosts declared under `http` in `shadowlap.config.json` are captured the same way and recorded as tool calls. The sidecar makes those calls itself only to a host the config declares, over `http` or `https`, and answers anything else with 403. Their request headers are never stored; their response bodies are, like any tool result, and response `set-cookie` headers are dropped.
- `shadowlap test` gives a pack with Bedrock calls placeholder AWS credentials only when the environment has no credential source. Replays under `shadowlap test` are offline, so nothing signed with them leaves the machine.
- Recordings live in `./.shadowlap/`, which gets its own `.gitignore` so they stay out of version control. A new store directory is readable only by you (`0700`), and the database and its WAL files are `0600`. A store created by an earlier version is tightened when it is next opened.
- `.shadowlap/active.json`, which tells `shadowlap mcp` where the running sidecar is, carries the session token. It is written `0600`, and a symbolic link at that path is replaced rather than followed.

### Packs

A pack can come from anyone: a colleague, an issue attachment, a pull request. `shadowlap unpack` and `shadowlap test` treat it as hostile until checked.

- **Validation before any write.** Every run and call is checked for type, range and shape. Ids must be real run ids and blob hashes, so nothing in a pack can become a path. Strings in ids, names and command lines may not contain control characters. Errors name the file and line.
- **Integrity.** Every blob is verified against its SHA-256 name, and every blob a call references must be present, including each part of a chunked request. A pack that fails any check imports nothing.
- **Files.** Only regular files are read. Symbolic links, unexpected files in `blobs/` and oversized files are refused. Limits: 256 MiB per blob, 4 GiB of blobs, 16 MiB for `run.json`.
- **Imported commands need consent.** A pack records the command that produced it, and replaying re-runs that command. Imported runs are marked, whatever the pack claims about itself. `shadowlap unpack` prints each imported command. `shadowlap replay` of an imported run asks before running it, refuses without a terminal unless you pass `--yes`, and runs your own command without asking when one follows `--`. Replays of an imported run inherit the mark. The terminal UI and the dashboard ask you to type `yes` before a replay of an imported run.
- **`shadowlap test` runs pack commands without asking.** It exists for goldens committed to your own repository, where a pull request that changes a golden could change any other code CI runs too. Review changes to goldens like changes to code, and don't point `shadowlap test` at packs you haven't read.

### Captures

`shadowlap import` reads a capture made by something else — a HAR, a nock recording, a VCR cassette
— and a capture can come from anywhere a pack can. It is treated the same way.

- **Nothing identifying is taken from the file.** Run ids, call numbers, fingerprints and occurrences are computed, never read from the capture, so nothing in it can become a path or collide with an existing run.
- **Credentials are dropped**, not stored: `authorization`, `x-api-key`, `api-key`, cookies, `proxy-authorization`, `x-goog-api-key` and `x-amz-security-token`, on both the request and the response.
- **Header text is escaped and bounded.** Header names and values end up in run metadata that terminals and the dashboard render, so control characters are escaped where they are stored rather than relied on to be escaped at every point of display. Names are capped at 256 characters, values at 8192, and a call keeps at most 100 headers. Real HTTP headers carry neither control characters nor those lengths, so nothing legitimate changes — including a fingerprint.
- **Only model API calls are imported.** An entry whose host is not one of the six providers is skipped with a reason, so a capture of a whole browsing session contributes only its model traffic.
- **No YAML parser is trusted with a cassette.** `import vcr` reads VCR's JSON serialization; a YAML cassette has to be converted first, deliberately.
- **An imported run carries no command.** A capture says what was sent, not what sent it, so there is nothing to execute: the run is marked imported and its recorded command is the non-runnable placeholder `<no-recorded-command>`. Replaying it needs a command you supply after `--`; `shadowlap replay` without one, and `shadowlap test` on a golden packed from it, refuse rather than run the placeholder.
- **Imports are partial recordings.** A capture never saw tool, clock or randomness calls, so a replay runs those live. Write tools are still fenced by `--writes`, which defaults to blocking them.

### Output

Recorded strings are shown with control characters escaped, in the CLI, `diff`, reports and the terminal UI, so a recorded prompt, tool name or error cannot rewrite your terminal.

### Dashboard

- `shadowlap dashboard` listens on `127.0.0.1` only and answers only requests addressed to `localhost` or a loopback address, which blocks DNS rebinding.
- The link it prints carries a random session token in the URL fragment, so the token never appears in server logs or `Referer` headers. Every API request must send it.
- Requests that change anything are refused when a browser sends them from another origin, even with the token.
- The page runs under a strict Content Security Policy, loads nothing from the network, and serves only its own bundled files.
- Actions map to a fixed list of CLI commands built on the server. The browser never sends a command line.
- A run imported from a capture has no command, so its replay asks for yours. What you type is split on the server and placed only after `--`, where `shadowlap replay` takes the agent's command; it never becomes one of Shadowlap's own arguments. It is your command, so it runs without the consent an imported pack's command needs.
- **Download** saves a run and the runs it came from as one HTML file, with the redaction rules in `shadowlap.config.json` applied, as `shadowlap export html --lineage` does. With no rules, the button says the file was not redacted.

### MCP

`shadowlap mcp` trusts `SHADOWLAP_URL` only when it is a loopback address. It uses `.shadowlap/active.json` only when that file is a regular file you own, points at loopback, and names a process that is still running. Otherwise it passes tool calls straight through and says why.

### Telemetry

The CLI sends nothing unless `SHADOWLAP_TELEMETRY_URL` names a collector; it has no default endpoint until the project runs one on a domain it controls. What it would send is listed field by field in [docs/telemetry.md](docs/telemetry.md). They never include prompts, tool names, arguments or results, file paths, hostnames, run ids or model names. The collector rejects any event with a field outside its allowlist or a value outside its closed sets. Turn it off with `SHADOWLAP_TELEMETRY=0` or `DO_NOT_TRACK=1`.

## What you should know

Recordings contain **everything your agent saw**: prompts, tool inputs and outputs, and any user data in them. Treat `.shadowlap/` and any pack you export as sensitive.

`shadowlap pack` applies the redaction rules in `shadowlap.config.json` (`shadowlap redact add --pattern email`, a UUID, a `/regex/`, or a path-scoped rule) to every stored request and response in the exported copy; the local store is left untouched. A redacted pack records its rules and still replays cleanly, because the same rules are applied when matching. Redaction is pattern-based: it masks what your rules describe and nothing else, so review a pack before sharing it.

The network guard (`--guard warn|block`) keeps replays faithful by reporting or refusing connections that bypass the sidecar. It is not a sandbox. A replayed agent runs with your permissions and can still read files, spawn processes and reach the network by other means.

A store in a repository you cloned is someone else's data, like a pack. A store is normally ignored by git, but a repository can force-add one. Don't replay runs from a checkout you don't trust.
