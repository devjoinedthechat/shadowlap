# Introduction

Shadowlap records every model API call and tool call an agent makes, then re-runs the agent's **real code** against that recording. Calls that haven't changed are served from the recording: no tokens spent, no side effects repeated. The first call that differs is reported with a precise diff, and from that point the run continues live as a *fork* of the original, with write tools fenced off.

> Replay your agent, not a trace of it.

## What it is for

| Job | Without Shadowlap | With Shadowlap |
|---|---|---|
| Reproduce a failing run | Re-run and hope; pay for the whole run again | `shadowlap replay <run>`: same run, zero upstream requests |
| Fix a harness bug (parsing, dispatch, state, stop condition) | Re-run live; the model may behave differently this time | Full replay against the recorded model behavior; the bug reproduces every time |
| Verify a fix that changes later requests | Re-run everything live, side effects included | Unchanged prefix replays; only the changed suffix runs live; writes are blocked |
| Ask "what if call 9 had returned X?" | Hand-edit code and re-run | `--override 9=@x.json`, and only the calls after it run live |
| Find where a failed run went wrong | Read the trace and guess | `shadowlap blame <run>`: the model call that lost the run, found with forks that replay everything before it for free |
| Know a fix works before it ships | Rerun the failing case once and hope | `shadowlap verify`: the failing runs fixed, runs it was not written against too, and the good runs kept, several attempts each |
| Fix a prompt the agent keeps misreading | Edit it by hand, rerun, repeat | `shadowlap repair`: a model you choose proposes rewrites, and the smallest one `verify` accepts comes back as a patch with its evidence |
| Catch unintended prompt changes in CI | String snapshot tests | `shadowlap test` fails the build on the first changed request |

## Three sentences to keep in mind

1. **A replay forks at the first request that changes, not where the bug is.** Fixes to the code around the model change no request and replay in full. Editing the system prompt changes every request and forks at call 1; you get the diff and a fenced fork, but no savings. See [How it works](./how-it-works.md#where-forks-happen).
2. **Nothing is matched fuzzily.** Two requests match only if they are identical after the [normalizers](./normalizers-and-redaction.md) you wrote. A false replay hit would be the worst bug this tool could have, so it reports a false divergence instead and shows you how to fix it.
3. **Side effects that don't go through Shadowlap will run again.** Wrap tools with the [SDK](./sdk.md) or a [framework adapter](./frameworks.md); anything else (a direct database client, an unwrapped HTTP call) is invisible to replay.

## Where to go

- [Quickstart](./quickstart.md): record and replay the bundled reference agent in two minutes, then your own.
- [How it works](./how-it-works.md): the sidecar, fingerprints, matching, effects, thinking blocks, storage.
- [Why did my replay diverge?](./troubleshooting.md): the page you'll visit most.
- [Compared with other tools](./compare.md): cassettes, tracing platforms, framework time travel, durable execution.
- [Capturing production traffic](./gateways.md): turning a run that went wrong in production into a recording, through a gateway already in the request path.
- [The wire protocol](./protocol.md), [the recordings protocol](./recordings-protocol.md) and [the engine as a library](./engine.md): building on Shadowlap, writing an SDK for another language, or integrating another test runner.

Shadowlap is pre-release and open source under Apache-2.0: [github.com/devjoinedthechat/shadowlap](https://github.com/devjoinedthechat/shadowlap).
