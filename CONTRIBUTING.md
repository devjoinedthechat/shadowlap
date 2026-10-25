# Contributing to Shadowlap

Thanks for looking. The most useful contribution is a run against your own agent: open an issue with what diverged, what confused you, or what broke.

## What to expect

Issues and pull requests are read, but there is no response-time commitment for them, and nothing here is a support channel. Security reports are different: they get an answer within 3 days ([SECURITY.md](SECURITY.md)).

What is most likely to be merged: a bug fix with the test that catches it, a provider or framework adapter you use yourself and will notice breaking, and documentation that corrects something wrong. What is least likely: large refactors, new subsystems, and new dependencies. The rules below are firm, especially the one about fingerprints.

## Setup

Node ≥ 22.16, not 23. Python ≥ 3.9 only if you touch `sdks/python`.

```sh
npm ci
npm run build                     # tsc -b, then the dashboard's UI bundle
npx vitest run                    # unit tests, the fidelity suite, the golden replay, the Python agent
npm run typecheck:tests           # the test files, under the same strict settings as the source
npm run lint                      # ESLint with typescript-eslint's typed rules, and ruff on the Python (through uvx)
node --test testing/conformance/conformance.test.mjs   # the SDK wire protocol, for both SDKs
cd sdks/python && uv run --no-project --with pytest --with-editable . python -m pytest -q
```

Without uv, the Python tests run with `pip install pytest -e sdks/python` and `python -m pytest -q sdks/python`.

The dashboard's checks in a real browser run with `npm run test:browser`, in the Chromium Playwright installs (`npx playwright install chromium`, in `packages/dashboard`); what follows `--` goes to Playwright, so `npm run test:browser -- -g axe` runs the tests whose titles match.

`npm run lint` reads the packages through their built declarations, so it runs after the build, and it fails on any finding. A finding is fixed; where the code is right as it is, the rule is turned off on that line with the reason (`// eslint-disable-next-line <rule> -- <why>`, `# noqa: <code> -- <why>`). `eslint.config.mjs` and `sdks/python/pyproject.toml` say why each rule that is off is off.

`npx vitest run` runs the Python reference agent end to end, and the Python agents that build their clients the default way (`testing/default-clients`), only with a Python ≥ 3.9 that can import `anthropic`, `openai`, `google-genai` and `boto3`, which CI installs; the guard's and in-process capture's async cases need `aiohttp`, `websockets`, `aiobotocore` and `uvloop` too, which CI installs as well (`uvloop` not on Windows). Without one, those tests count as skipped and the run is still green (the async cases fetch theirs through uv when uv is installed), so point `SHADOWLAP_PYTHON` at one before you rely on it. Under CI a missing one fails the run instead, naming it. CI takes every Python package's version from `testing/python-constraints.txt`, which `testing/python-constraints.in` lists and says how to compile; the same file pins a venv of your own:

```sh
uv venv .venv --python 3.12 && uv pip install --python .venv/bin/python -c testing/python-constraints.txt anthropic openai google-genai boto3 aiohttp websockets aiobotocore uvloop
SHADOWLAP_PYTHON="$PWD/.venv/bin/python" npx vitest run
```

A run fails when a test leaves anything in the checkout: a `.shadowlap` folder in the repository's root or in `testing/frameworks`, where the suites run, or anything `git status --ignored` lists that it didn't before the run, build outputs and test reports aside (`testing/no-stray-stores.mjs`). A test runs the CLI in a temporary folder of its own (`cwd`), with its own store (`--db`), and makes a project an agent runs in with `testing/temp-project.mjs`, in the temporary folder below links to the packages it imports. Under CI anything else new, and a tracked file that changed, fail the run too; elsewhere they are said, as you may be editing while it runs.

CI runs all of it with Node 22 and 24, and the build, the tests and the CLI end to end (the golden replay, record, replay and fork) on Node 22.16.0 too, the oldest Node the packages support. Every push to main and every pull request runs it on Linux. macOS and Windows join a run started by hand (Actions, then CI, then Run workflow) while the repository is private, and every run once it is public; `.github/workflows/scope.yml` decides, and the framework suites, the coding-agent commands and the local model run on the same terms. The test run also writes `vitest-junit.xml`, uploaded as an artifact whether the job passed or not: test files run in parallel workers, so a failure that won't reproduce locally is only identifiable from the report of the run that saw it. Nothing retries; a flake CI swallows is one nobody fixes. A coverage job runs the suite under V8's coverage and uploads the report (`vitest-coverage`, or `npx vitest run --coverage` into `coverage/` locally); it gates nothing.

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
| `packages/test` | `@shadowlap/test`: recorded tests for Vitest, Jest and node:test |
| `packages/tui` · `packages/dashboard` | The Ink terminal UI; the local web dashboard (server in `src`, React UI in `ui`) |
| `packages/collector` | The self-hostable telemetry collector |
| `sdks/python/shadowlap/_capture.py` · `litellm_callback.py` | Capturing model calls at a gateway already in the request path, for `shadowlap import litellm`. `_capture.py` decides what to keep and imports nothing from LiteLLM, so it is tested without it |
| `action.yml` · `action/` | The GitHub Action |
| `testing/` | The scripted mock APIs, the reference agent, the golden recording, the framework and live-provider suites, and the conformance suite |
| `docs/` | The documentation |

The README's "How it works" and "Security" sections state the contract users rely on: what is matched and what replays after a fork (How it works), and what is never stored (Security). If a change alters it, update the README in the same pull request; `testing/docs` checks the parts of it the code can check.

## Rules of the road

- **Fingerprints never get fuzzier implicitly.** Anything excluded from matching is an explicit normalizer, but for the few built-in exclusions the [design rule](docs/normalizers-and-redaction.md#calibrate) names, each a value that changes nothing the model does. A false replay hit is the worst bug this project can have.
- **Recordings are append-only.** Never edit or delete rows in place.
- **Provider modules stay declarative.** Adding a provider must not touch the engine; if it does, the abstraction is wrong.
- **Nothing in the SDKs computes hashes or matches.** They are clients of the sidecar.
- **Tests before merge.** New behaviour comes with a test; a bug fix comes with the test that would have caught it.
- **Cross-platform.** CI covers Linux, macOS and Windows (macOS and Windows on a run started by hand while the repository is private). Avoid shell-specific and path-specific assumptions.
- **No new runtime dependencies** in the engine, sidecar, SDKs, adapters or dashboard. `packages/cli/test/packaging.test.ts` lists the few there are, and fails on one added without it.

## Pull requests

Small and focused. Describe what changed and why. Commit messages: a short imperative subject that says what a user gets, then the reasoning in the body.

There is no Contributor License Agreement. Contributions are accepted under the Apache-2.0 license the project already uses, and copyright stays with whoever wrote the code.

## Reporting a divergence you think is wrong

Attach `shadowlap show <run> --json` for both the recording and the replay **after redacting prompts and tool I/O**: recordings contain everything your agent saw. The divergence report alone (`shadowlap show <replay-run>`) is usually enough.
