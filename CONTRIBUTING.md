# Contributing to Shadowlap

Thanks for looking. The most useful contribution is a run against your own agent: open an issue with what diverged, what confused you, or what broke. This page covers setup, the tests, lint, commit messages and how a pull request is reviewed.

- [What to expect](#what-to-expect)
- [Set up](#set-up)
- [Run the tests](#run-the-tests)
- [What CI runs](#what-ci-runs)
- [Lint](#lint)
- [The docs](#the-docs)
- [Where things live](#where-things-live)
- [Rules of the road](#rules-of-the-road)
- [Commit messages](#commit-messages)
- [How a pull request is reviewed](#how-a-pull-request-is-reviewed)
- [Reporting a divergence you think is wrong](#reporting-a-divergence-you-think-is-wrong)

## What to expect

Issues and pull requests are read, but there is no response-time commitment for them, and nothing here is a support channel. Security reports are different: they get an answer within 3 days ([SECURITY.md](SECURITY.md)).

What is most likely to be merged:

- a bug fix with the test that catches it;
- a provider or framework adapter you use yourself and will notice breaking;
- documentation that corrects something wrong.

What is least likely: large refactors, additional subsystems, and additional dependencies. The [rules](#rules-of-the-road) below are firm, especially the one about fingerprints.

## Set up

You need Node 22.16 or later, not 23. Python 3.9 or later is needed only if you touch `sdks/python`.

```sh
git clone https://github.com/devjoinedthechat/shadowlap
cd shadowlap
npm ci
npm run build                     # tsc -b (first removing its build of a source since deleted), the CommonJS copies, the dashboard's UI bundle
```

## Run the tests

```sh
npx vitest run                    # unit tests, the fidelity suite, the golden replay, the Python agent
npm run typecheck:tests           # the test files, under the same strict settings as the source
npm run typecheck:js              # the GitHub Action and the Node preloads, JavaScript checked from its JSDoc
node --test testing/conformance/conformance.test.mjs   # the SDK wire protocol, for both SDKs
cd sdks/python && uv run --no-project --with pytest --with-editable . python -m pytest -q
```

Without uv, the Python tests run with `pip install pytest -e sdks/python` and `python -m pytest -q sdks/python`.

### Python agents in the Vitest run

`npx vitest run` also runs Python agents end to end: the Python reference agent, and the Python agents that build their clients the default way (`testing/default-clients`). They need a Python 3.9 or later that can import these packages, all of which CI installs:

| Tests | Packages |
|---|---|
| The Python agents | `anthropic`, `openai`, `google-genai` and `boto3` |
| The guard's and in-process capture's async cases | Those, plus `aiohttp`, `websockets`, `aiobotocore` and `uvloop` (`uvloop` not on Windows) |

Without one, those tests count as skipped and the run is still green. The async cases fetch theirs through uv when uv is installed. So point `SHADOWLAP_PYTHON` at one before you rely on the run. Under CI, a missing one fails the run instead, naming it.

CI takes every Python package's version from `testing/python-constraints.txt`, which `testing/python-constraints.in` lists and says how to compile. The same file pins a venv of your own:

```sh
uv venv .venv --python 3.12 && uv pip install --python .venv/bin/python -c testing/python-constraints.txt anthropic openai google-genai boto3 aiohttp websockets aiobotocore uvloop
SHADOWLAP_PYTHON="$PWD/.venv/bin/python" npx vitest run
```

### The dashboard in a real browser

The dashboard's checks in a real browser run with `npm run test:browser`, in the Chromium Playwright installs (`npx playwright install chromium`, in `packages/dashboard`). What follows `--` goes to Playwright, so `npm run test:browser -- -g axe` runs the tests whose titles match.

### Tests leave the checkout as they found it

A run fails when a test leaves anything in the checkout (`testing/no-stray-stores.mjs`):

- a `.shadowlap` folder in the repository's root, or in `testing/frameworks`, where the suites run;
- anything `git status --ignored` lists that it didn't before the run, build outputs and test reports aside.

Under CI, anything else that appears, and a tracked file that changed, fail the run too. Elsewhere they are only reported, as you may be editing while it runs. So a test:

- runs the CLI in a temporary folder of its own (`cwd`), with its own store (`--db`);
- makes a project an agent runs in with `testing/temp-project.mjs`, in the temporary folder below links to the packages it imports.

Your own `~/.shadowlap` is left alone too. The run sets `SHADOWLAP_HOME` to a temporary folder of its own, for the suites and every process they start, and removes it after. So the project list, and the agents and proxies registered while they run, never reach yours. A test that runs the CLI keeps `process.env` in the environment it gives it, or sets a folder of its own.

What changes in the real `~/.shadowlap` while the tests run fails the run under CI. Elsewhere it is only reported, as your own Shadowlap may write there meanwhile.

### The golden recording

`npm run golden` re-records `testing/golden/reference-agent`. Only do that when the reference scenario changes on purpose: the golden is what proves replay fidelity in CI.

## What CI runs

CI runs all of it with Node 22 and 24, and the build, the tests and the CLI end to end (the golden replay, record, replay and fork) on Node 22.16.0 too, the oldest Node the packages support.

Every push to main and every pull request runs it on Linux. macOS and Windows join a run started by hand (Actions, then CI, then Run workflow) while the repository is private, and every run once it is public. `.github/workflows/scope.yml` decides, and the framework suites, the coding-agent commands and the local model run on the same terms.

A version tag's run covers everything, as one started by hand does: the release (`.github/workflows/release.yml`) publishes only once CI, the dashboard in a browser, the framework suites, the Action and the coding-agent commands have passed on the tagged commit.

What else to know about a CI run:

- **The JUnit report.** The test run also writes `vitest-junit.xml`, uploaded as an artifact whether the job passed or not. Test files run in parallel workers, so a failure that won't reproduce locally is only identifiable from the report of the run that saw it.
- **No retries.** Nothing retries: a flake CI swallows is one nobody fixes.
- **Coverage.** A coverage job runs the suite under V8's coverage and uploads the report (`vitest-coverage`, or `npx vitest run --coverage` into `coverage/` locally). It gates nothing.

## Lint

```sh
npm run lint                      # ESLint with typescript-eslint's typed rules and the size caps, ruff on the Python and mypy on the Python guard (through uvx)
```

`npm run lint` reads the packages through their built declarations, so it runs after the build, and it fails on any finding. A finding is fixed. Where the code is right as it is, the rule is turned off on that line with the reason (`// eslint-disable-next-line <rule> -- <why>`, `# noqa: <code> -- <why>`). `eslint.config.mjs` and `sdks/python/pyproject.toml` say why each rule that is off is off.

### Size caps

Lint caps how complex, how long and how deeply nested a function may grow, and how long a file runs:

| Cap | TypeScript and JavaScript (ESLint) | Python (ruff) |
|---|---:|---:|
| A function's complexity (paths) | 30 | 15 |
| A function's length | 150 lines | — |
| A function's statements | — | 50 |
| How deep a function's blocks nest | 5 | — |
| A file's length | 800 lines | — |

Line counts leave out blank lines and comments.

### The lint-caps ratchet

Code that was over a cap when it came is listed in `lint-caps.json`, each held to what it was:

- **A function** by its name in its file (`register > action("show")`, `Tool.stream.wrapper`).
- **A file's length** by the file.

An entry may shrink, never grow. Every other function in that file is held to the cap, not to its worst neighbour. A Python function on the list carries a `noqa` on its `def` line, as ruff needs, and its number stays in `lint-caps.json`.

`npm run lint` checks that the list is exact. Two commands keep it so:

- **`node scripts/lint-caps.mjs --write`** lowers the list once a function has shrunk.
- **`--write --add`** keeps the ceiling of a function renamed or moved, which the list no longer knows by its old name.

A pull request may lower an entry or take one off, but never add one or raise one. CI checks the list against where the request left its base branch, and fails on an entry added or raised. A function renamed or moved shows there as an entry added: say so in the pull request. The same check runs locally against a branch you name:

```sh
node scripts/lint-caps-raised.mjs origin/main
```

## The docs

`docs/*.md` are the documentation, read on GitHub as they are.

- **Page names** use lower-case letters, digits and hyphens.
- **Links** to another page read `./page.md` or `./page.md#section`. Anything else in the repository is linked by its relative path, so every link works on GitHub.
- **A command or flag you add** is documented in `docs/cli.md`, in the section of its command.
- **Anything a user would notice** goes in `README.md`, and in `CHANGELOG.md` under Unreleased.

`testing/docs` reads the CLI's command tree, and fails when an option is missing from the reference or when a page shows a command or flag the CLI doesn't have. It also:

- runs the CI step `docs/ci.md` prints;
- holds the normalizer samples and the divergence output the docs show to what the CLI prints;
- installs the packages the way the docs say, each from its folder here;
- holds the changelog's line on dependencies to the package manifests.

The README's "How it works" and "Security" sections state the contract users rely on: what is matched and what replays after a fork (How it works), and what is never stored (Security). If a change alters it, update the README in the same pull request. `testing/docs` checks the parts of it the code can check.

## Where things live

The repository's main folders and files:

| Path | What |
|---|---|
| `packages/engine` | Canonical JSON, fingerprints and normalizers, the replay session (matching), structural diff, the SQLite store, the pack format |
| `packages/sidecar` | The loopback proxy (record and replay of model APIs) and the call resolution API for the SDKs; provider modules |
| `packages/sdk` · `sdks/python` | Thin SDK clients: `tool()`, `now()`, `random()`, `uuid()`, `scope()`, both implementing [the wire protocol](docs/protocol.md) |
| `packages/adapters` | Framework adapters for TypeScript; the Python ones are in `sdks/python/shadowlap/adapters` |
| `packages/cli` | The `shadowlap` command (see below) |
| `packages/test` | `@shadowlap/test`: recorded tests for Vitest, Jest and node:test |
| `packages/tui` · `packages/dashboard` | The Ink terminal UI; the local web dashboard (server in `src`, React UI in `ui`) |
| `packages/collector` | The self-hostable telemetry collector |
| `sdks/python/shadowlap/_capture.py` · `litellm_callback.py` | Capturing model calls at a gateway already in the request path, for `shadowlap import litellm` |
| `action.yml` · `action/` | The GitHub Action |
| `testing/` | The scripted mock APIs, the reference agent, the golden recording, the framework and live-provider suites, and the conformance suite |
| `docs/` | The documentation |

Some of these need a note:

- **The SDKs.** A change to either usually belongs in the wire protocol's spec and in the conformance suite too.
- **`packages/cli`.** `src/commands/` holds one module per help group; `run-agent.ts` runs an agent under a sidecar; `recordings.ts` is the host behind the pytest and Vitest plugins.
- **`_capture.py`** decides what to keep and imports nothing from LiteLLM, so it is tested without it.

## Rules of the road

- **Fingerprints never get fuzzier implicitly.** Anything excluded from matching is an explicit normalizer, but for the few built-in exclusions the [design rule](docs/normalizers-and-redaction.md#calibrate) names, each a value that changes nothing the model does. A false replay hit is the worst bug this project can have.
- **Recordings are append-only.** Never edit or delete rows in place.
- **Provider modules stay declarative.** Adding a provider must not touch the engine; if it does, the abstraction is wrong.
- **Nothing in the SDKs computes hashes or matches.** They are clients of the sidecar.
- **Tests before merge.** Behaviour you add comes with a test; a bug fix comes with the test that would have caught it.
- **Cross-platform.** CI covers Linux, macOS and Windows (macOS and Windows on a run started by hand while the repository is private). Avoid shell-specific and path-specific assumptions.
- **No more runtime dependencies** in the engine, sidecar, SDKs, adapters or dashboard. `packages/cli/test/packaging.test.ts` lists the few there are, and fails on one added without it.

## Commit messages

A commit message is a short imperative subject that says what a user gets, then the reasoning in the body. Subjects from the history:

```text
Keep a secret's name in a captured call, so two lookups by name stay two calls
Break a listener's answer off again on replay where the server broke it off live
```

## How a pull request is reviewed

Keep a pull request small and focused, and describe what changed and why. It is read against:

- **CI**, which runs on every pull request ([what CI runs](#what-ci-runs));
- **the checklist in its template**: a test for the behaviour or the fix; `npm run build`, `npx vitest run` and `npm run typecheck:tests` passing locally; and the docs above, updated;
- **the [rules of the road](#rules-of-the-road)**, which are firm.

There is no Contributor License Agreement. Contributions are accepted under the Apache-2.0 license the project already uses, and copyright stays with whoever wrote the code.

## Reporting a divergence you think is wrong

Attach `shadowlap show <run> --json` for both the recording and the replay **after redacting prompts and tool I/O**: recordings contain everything your agent saw. The divergence report alone (`shadowlap show <replay-run>`) is usually enough.
