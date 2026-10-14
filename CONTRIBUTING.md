# Contributing to Shadowlap

Thanks for looking. Shadowlap is early; the fastest way to help is to run it against your own agent and open an issue with what diverged, what confused you, or what broke.

## What to expect

Shadowlap is maintained by one person in their own time, as an open-source project rather than a product. That shapes what to expect: there is no response-time commitment, issues may sit, and a pull request may take a while to be read. Nothing here is a support channel, and there is no company behind it.

What is most likely to be merged: a bug fix with the test that catches it, a provider or framework adapter you use yourself and will notice breaking, documentation that corrects something wrong. What is least likely: large refactors, new subsystems, and dependencies. The rules below are firm, especially the one about fingerprints.

If you depend on this, fork it. That is a normal outcome, not a failure.

## Setup

Node ≥ 22.13. Python ≥ 3.9 only if you touch `sdks/python`.

```sh
npm install
npm run build        # tsc -b
npm test             # unit tests, the end-to-end fidelity suite, the golden replay, the Python SDK subprocess test
node --test testing/conformance/conformance.test.mjs   # the SDK wire protocol, for both SDKs
```

In CI `npm test` also writes `vitest-junit.xml`, uploaded as an artifact whether the job passed or
not. Test files run in parallel workers, so a failure that will not reproduce locally is only ever
identifiable from the report of the run that saw it. Nothing retries: a flake CI swallows is one
nobody fixes.

`npm run golden` re-records `testing/golden/reference-agent`. Only do that when the reference scenario changes on purpose; the golden is what proves replay fidelity in CI.

## Where things live

| Path | What |
|---|---|
| `packages/engine` | Canonical JSON, fingerprints and normalizers, the replay session (matching), structural diff, SQLite store, pack format |
| `packages/sidecar` | The loopback proxy (record/replay of model APIs) and the call resolution API for SDKs; provider modules |
| `packages/sdk` · `sdks/python` | Thin SDK clients: `tool()`, `now()`, `random()`, `uuid()`. Both implement [the wire protocol](docs/protocol.md); a change to either usually belongs in that spec and in the conformance suite |
| `packages/cli` | The `shadowlap` command. `src/commands/` holds one module per help group (record, inspect, testing, setup, import, data); `run-agent.ts` runs an agent under a sidecar; `recordings.ts` is the host behind the pytest and Vitest plugins |
| `packages/test` | `@shadowlap/test`: recorded tests for Vitest and node:test |
| `sdks/python/shadowlap/_capture.py` · `litellm_callback.py` | Capturing model calls from a gateway already in the request path, for `shadowlap import litellm`. The callback is the thin binding to LiteLLM's hooks; `_capture.py` decides what to keep and imports nothing from LiteLLM, so those decisions are tested without it |
| `packages/tui` · `packages/dashboard` | The Ink terminal UI; the local web dashboard |
| `testing/` | The scripted mock API, the reference agent, the golden recording, the framework and live-provider suites |
| `testing/conformance` | The SDK conformance suite: fourteen scenarios any client must pass, run against a real sidecar with no API keys |

The README's "How it works" section states the contract users rely on (what is matched, what replays after a fork, what is never stored). If a change alters it, update the README in the same pull request.

## Rules of the road

- **Fingerprints never get fuzzier implicitly.** Anything excluded from matching is an explicit normalizer. A false replay hit is the worst bug this project can have.
- **Recordings are append-only.** Never edit or delete rows in place.
- **Provider modules stay declarative.** Adding a provider must not touch the engine; if it does, the abstraction is wrong.
- **Nothing in the SDKs computes hashes or matches.** They are clients of the sidecar.
- **Tests before merge.** New behavior comes with a test; a bug fix comes with the test that would have caught it.
- **Cross-platform.** CI runs Linux, macOS and Windows. Avoid shell-specific and path-specific assumptions.

## Pull requests

Small and focused. Describe what changed and why; if it's user-visible, update `README.md` (the Status table is the live checklist) in the same PR. Commit messages: a short imperative subject, then the reasoning in the body.

There is no Contributor License Agreement. Contributions are accepted under the Apache-2.0 license the project already uses, and copyright stays with whoever wrote the code.

## Reporting a divergence you think is wrong

Attach `shadowlap show <run> --json` for both the recording and the replay **after redacting prompts and tool I/O**; recordings contain everything your agent saw. The divergence report alone (`shadowlap show <replay-run>`) is usually enough.
