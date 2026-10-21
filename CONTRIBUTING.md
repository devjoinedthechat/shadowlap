# Contributing to Shadowlap

Thanks for looking. The most useful contribution is a run against your own agent: open an issue with what diverged, what confused you, or what broke.

## What to expect

Issues and pull requests are read, but there is no response-time commitment for them, and nothing here is a support channel. Security reports are different: they get an answer within 3 days ([SECURITY.md](SECURITY.md)).

What is most likely to be merged: a bug fix with the test that catches it, a provider or framework adapter you use yourself and will notice breaking, and documentation that corrects something wrong. What is least likely: large refactors, new subsystems, and new dependencies. The rules below are firm, especially the one about fingerprints.

## Setup

Node ≥ 22.13. Python ≥ 3.9 only if you touch `sdks/python`.

```sh
npm ci
npm run build                     # tsc -b, then the dashboard's UI bundle
npx vitest run                    # unit tests, the fidelity suite, the golden replay, the Python agent
npm run typecheck:tests           # the test files, under the same strict settings as the source
node --test testing/conformance/conformance.test.mjs   # the SDK wire protocol, for both SDKs
cd sdks/python && uv run --no-project --with pytest --with-editable . python -m pytest -q
```

Without uv, the Python tests run with `pip install pytest -e sdks/python` and `python -m pytest -q sdks/python`.

`npx vitest run` runs the Python reference agent end to end only with a Python ≥ 3.9 that can import `anthropic`, which CI installs. Without one, those four tests count as skipped and the run is still green, so point `SHADOWLAP_PYTHON` at one before you rely on it:

```sh
uv venv .venv --python 3.12 && uv pip install --python .venv/bin/python anthropic
SHADOWLAP_PYTHON="$PWD/.venv/bin/python" npx vitest run
```

CI runs all of it on Linux, macOS and Windows with Node 22 and 24. There the test run also writes `vitest-junit.xml`, uploaded as an artifact whether the job passed or not: test files run in parallel workers, so a failure that won't reproduce locally is only identifiable from the report of the run that saw it. Nothing retries; a flake CI swallows is one nobody fixes.

`npm run golden` re-records `testing/golden/reference-agent`. Only do that when the reference scenario changes on purpose: the golden is what proves replay fidelity in CI.

## The docs

`docs/*.md` are the documentation, read on GitHub as they are. Name a new page in lower-case letters, digits and hyphens. Link to another page as `./page.md` or `./page.md#section`, and to anything else in the repository by its relative path, so every link works on GitHub.

Document a new command or flag in `docs/cli.md`, in the section of its command, and anything a user would notice in `README.md` and `CHANGELOG.md`, under Unreleased. `testing/docs` reads the CLI's command tree and fails when an option is missing from the reference, or when a page shows a command or flag the CLI doesn't have. It also runs the CI step `docs/ci.md` prints, holds the normalizer samples and the divergence output the docs show to what the CLI prints, installs the packages the way the docs say (each from its folder here), holds the changelog's line on dependencies to the package manifests, and builds the site, the repository's own docs included.

## Where things live

| Path | What |
|---|---|
| `packages/engine` | Canonical JSON, fingerprints and normalizers, the replay session (matching), structural diff, the SQLite store, the pack format |
| `packages/sidecar` | The loopback proxy (record and replay of model APIs) and the call resolution API for the SDKs; provider modules |
| `packages/sdk` · `sdks/python` | Thin SDK clients: `tool()`, `now()`, `random()`, `uuid()`, `scope()`. Both implement [the wire protocol](docs/protocol.md); a change to either usually belongs in that spec and in the conformance suite |
| `packages/adapters` | Framework adapters for TypeScript; the Python ones are in `sdks/python/shadowlap/adapters` |
| `packages/cli` | The `shadowlap` command. `src/commands/` holds one module per help group; `run-agent.ts` runs an agent under a sidecar; `recordings.ts` is the host behind the pytest and Vitest plugins |
| `packages/test` | `@shadowlap/test`: recorded tests for Vitest and node:test |
| `packages/tui` · `packages/dashboard` | The Ink terminal UI; the local web dashboard (server in `src`, React UI in `ui`) |
| `packages/collector` | The self-hostable telemetry collector |
| `sdks/python/shadowlap/_capture.py` · `litellm_callback.py` | Capturing model calls at a gateway already in the request path, for `shadowlap import litellm`. `_capture.py` decides what to keep and imports nothing from LiteLLM, so it is tested without it |
| `action.yml` · `action/` | The GitHub Action |
| `testing/` | The scripted mock APIs, the reference agent, the golden recording, the framework and live-provider suites, and the conformance suite |
| `docs/` | The documentation |

The README's "How it works" and "Security" sections state the contract users rely on: what is matched and what replays after a fork (How it works), and what is never stored (Security). If a change alters it, update the README in the same pull request; `testing/docs` checks the parts of it the code can check.

## Rules of the road

- **Fingerprints never get fuzzier implicitly.** Anything excluded from matching is an explicit normalizer. A false replay hit is the worst bug this project can have.
- **Recordings are append-only.** Never edit or delete rows in place.
- **Provider modules stay declarative.** Adding a provider must not touch the engine; if it does, the abstraction is wrong.
- **Nothing in the SDKs computes hashes or matches.** They are clients of the sidecar.
- **Tests before merge.** New behaviour comes with a test; a bug fix comes with the test that would have caught it.
- **Cross-platform.** CI runs Linux, macOS and Windows. Avoid shell-specific and path-specific assumptions.
- **No new runtime dependencies** in the engine, sidecar, SDKs, adapters or dashboard. `packages/cli/test/packaging.test.ts` lists the few there are, and fails on one added without it.

## Pull requests

Small and focused. Describe what changed and why. Commit messages: a short imperative subject that says what a user gets, then the reasoning in the body.

There is no Contributor License Agreement. Contributions are accepted under the Apache-2.0 license the project already uses, and copyright stays with whoever wrote the code.

## Reporting a divergence you think is wrong

Attach `shadowlap show <run> --json` for both the recording and the replay **after redacting prompts and tool I/O**: recordings contain everything your agent saw. The divergence report alone (`shadowlap show <replay-run>`) is usually enough.
