# shadowlap

Record, replay and fork AI agent runs.

Shadowlap records every model API call and tool call an agent makes, then re-runs the agent's *real code* against that recording. Calls that haven't changed are served from the recording: no tokens spent, no side effects repeated. The first call that differs is reported with a precise diff, and from there the run continues live as a fork of the original, with write tools fenced off.

```sh
npm install -g shadowlap

shadowlap run -- node agent.js        # record (sets ANTHROPIC_BASE_URL, OPENAI_BASE_URL, GOOGLE_GEMINI_BASE_URL for the agent)
shadowlap replay <run>                # replay: zero upstream requests when nothing changed, a fork with a diff when something did
shadowlap ui                          # timeline, inspector, play mode, diffs, actions
```

Model calls need no code changes: the official Anthropic, OpenAI (and OpenAI-compatible) and Gemini SDKs read the base-URL variables `shadowlap run` sets. Tools declare an effect through the SDK (`@shadowlap/sdk`, `shadowlap` on PyPI), a one-line framework adapter (`@shadowlap/adapters`), or, for MCP servers, `shadowlap mcp -- <server>`.

| Command | What it does |
|---|---|
| `run -- <cmd>` | Record a run |
| `replay <run> [-- <cmd>]` | Replay; forks at the first changed call. `--strict`, `--writes block\|stub\|allow`, `--reads live\|replay`, `--live-tool`, `--diverge-at`, `--override`, `--inject`, `--set`, `--model`, `--guard` |
| `test <pack...>` | Replay committed recordings offline in CI, JUnit output |
| `ui [run]` | The terminal UI |
| `show <run>`, `ls [--tree]`, `diff <a> <b>` | Inspect and compare runs |
| `mcp -- <server>` | Run an MCP server behind Shadowlap |
| `pack`, `unpack`, `redact`, `normalize` | Portable recordings, redaction, normalizers |
| `export otel <run>` | The run as an OpenTelemetry trace |
| `rm`, `gc`, `doctor` | Store maintenance and environment checks |

Needs Node ≥ 22.13. Recordings stay on your machine in `./.shadowlap/`; credentials are forwarded to the provider and never stored. No telemetry is sent: the CLI has no default collector and the project runs none.

Docs, source and the terminal UI in action: https://github.com/devjoinedthechat/shadowlap
