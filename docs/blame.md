# Blame

A run usually goes wrong well before it visibly fails. The agent refunds an order it should have escalated, and the run only looks wrong at the end, when the refund is already issued. `shadowlap blame` finds the model call that lost the run: the last one whose answer, asked again, lets the run pass.

```sh
shadowlap blame <run> --expect '{"tools":{"issue_refund":0}}'
```

```
⑂ The run was lost at model call #5 (3 of 4)
  Resampling #5 rescued 2 of 4 attempts; resampling #7, the next model call, rescued 0 of 4.
  Confidence: high (rescue stops cleanly at the boundary)

  At #5  the recording   issue_refund({"order_id":"A-1042","amount":240})
         a rescued fork  "Above the limit.", escalate({"reason":"refund of $240 is above $100"})

  Probes (a rescue needs 2 of 5 attempts to pass; resample the probed call)
    #1  1 of 4  2 of 3 passed   rescued
    #5  3 of 4  2 of 4 passed   rescued  ◂ blamed
    #7  4 of 4  0 of 4 passed   lost

  11 attempts · 24 upstream requests · ≈$0.101 spent · every call before a probe replayed from the recording
  oracle: the agent exits 0; issue_refund called 0 times
  rescued fork: shadowlap diff 01M3R1YKHF 01M3R1YMHF    shadowlap ui 01M3R1YMHF --call 5
```

It found the call by forking the run, not by reading it: every call before a probe came from the recording for free, and only the rest ran live, with writes stubbed.

## How it works

**The oracle** says what a passing run does. By default it is the agent's exit code: a run passes when the agent exits 0. `--expect` adds [outcome checks](./ci.md#outcome-checks), the same object `expect` takes under `tests` in `shadowlap.config.json`: which tools must or must not be called and with what arguments, call counts, token and cost budgets, text in the output or the final answer.

**The baseline.** Blame first replays the run as recorded. That costs nothing, and it must reproduce the failure: the replay has to be clean, and it has to fail the oracle. A run that passes has nothing to blame; one whose replay forks by itself would make every probe ambiguous, so blame refuses it and points to [`shadowlap calibrate`](./normalizers-and-redaction.md#calibrate).

**A probe** asks one question of one model call *k*: if the model had answered *k* differently, could the run still have passed? It replays the calls before *k* from the recording, forces *k* live, and lets the rest of the run go live. It does this several times (`--attempts`, 5 by default), because one lucky sample proves nothing, and the probe **rescues** the run when enough attempts pass the oracle (`--passes`, 2 by default). A probe stops as soon as the attempts left can no longer change its verdict, which gives the same answer as running all of them for fewer attempts.

**The search.** Rescue gets harder the later it starts: resampling from the first model call re-runs almost the whole agent, and resampling the last can only change the ending. So probes rescue the run up to some model call and stop rescuing after it. That boundary is the answer. The last call that still rescues is the one whose recorded answer lost the run, and from the next call on the failure was already unavoidable. Blame probes the first model call, then binary-searches the rest for the boundary, so a run with 30 model calls needs about six probes, not thirty.

**The scan.** Nothing guarantees a clean boundary: a run can be rescuable at 10, not at 12, and again at 14. After the binary search, blame also probes the next few calls past the boundary (`--scan`, 2 by default). If one of them rescues the run, the search moves on past it, and the confidence it reports drops to low.

## The rescue

By default a probe asks the model the same question again, with the request exactly as recorded, and relies on sampling to produce a different answer. At temperature 0 a model answers the same way every time, so add `--set temperature=1` to let a probe sample.

`--model` rescues with another model instead, from the probed call on:

```sh
shadowlap blame <run> --expect @checks.json --model claude-opus-5-5
```

When no probe rescues the run, even from the first model call, the report says **Not rescued from any model call**. That is a finding, not an error: the failure is not one unlucky answer. It comes from the prompt, the tools, the harness, or a task the model cannot do. Blame with a stronger model tells the last two apart. If `--model` finds a call and resampling did not, the model's capability is the problem; if neither finds one, look at the code and the tools.

`--set key=value` changes any other top-level request field from the probed call on, like `--set` on [`replay`](./interventions.md#patch-parameters).

## Blaming one part of the agent

An agent is often more than one model: a planner and an executor, or, in a benchmark, the agent and a model playing its customer. `--scope agent` probes only the model calls made in that [scope](./sdk.md#scopes), or in one nested in it, so the call blamed is always the agent's. A customer's answer that led nowhere is part of the run the agent had to handle, not something to fix. The report counts steps among the scope's calls only, and blame says which scopes a run has when the one given isn't among them.

## Side effects

Blame never lets a probe act on the world. After the fork, `write` tools are stubbed (`--writes stub`, the default): the agent receives the tool's `onFork` value and carries on as if the write had succeeded, which is closest to what happened in the recording. `--writes block` makes each write throw instead. That is safer for a tool with no `onFork`, but an agent that stops on the error fails the probe for a reason the recording never had. `--writes allow` is not accepted.

`read` tools run live after the fork, as in a replay; `--reads replay` serves them from the recording when their arguments match.

## Reading the report

| Line | Meaning |
|---|---|
| **The run was lost at model call #n (k of m)** | The last model call whose resampling rescued the run. *k of m* is its position among the run's model calls |
| **Resampling #n rescued … ; resampling #n′ … rescued …** | The evidence on both sides of the boundary |
| **Confidence** | *high*: the call after the boundary passed no attempt. *medium*: it passed some, but too few to count as a rescue, so the run was not reliably lost there. *low*: rescue worked again past the boundary, or the search stopped early |
| **At #n** | What the model answered at the blamed call in the recording, and in a fork that went on to pass. This is the contrast to act on: the bad path and a good one, from the same point |
| **Probes** | Every call probed, how many attempts passed, and the verdict |

Once you have a fix, [`shadowlap verify`](./verify.md) checks it on the blamed run, on failures it was not written against, and on runs that worked. [`shadowlap repair`](./repair.md) does both steps for a fix to the prompt: it asks a model for rewrites and keeps the one the gate accepts.

Every attempt is a run in the store, marked as a blame attempt and bundled per probe in the dashboard's forks view, the way `--repeat` attempts are. `shadowlap show` prints what blame found on the blamed run and on each attempt. The rescued fork is an ordinary run: `shadowlap diff <run> <fork>` compares it with the recording, and `shadowlap ui <fork> --call <n>` opens it at the blamed call.

## Fixes

Every blame is kept in the store whole, with the fix it opens or joins. A fix is one failure, from the blame that reproduced it to a change that held: [`shadowlap fix`](./cli.md#fix) lists them and shows each one's blame, repair and verify. The report ends with it:

```
  fix fx-01M3RZ4XKN · issue_refund called with amount 240 · opened · shadowlap fix show fx-01M3RZ4XKN
```

Which fix a blamed run goes to:

- A run that already fails in a fix stays in it, so blaming it again, with `--model` say, adds a blame to the same fix.
- Otherwise it joins the fix of another run with the same [label](./cli.md#label-note), such as `refund-over-limit`. The label `good` never names a failure.
- A run with no label joins the fix with the same check: the same `--expect`, whatever order its keys are in. Without `--expect`, the check is the exit code.
- Otherwise the blame opens a new fix. Its title says how the recording failed the check, in plain words: *issue_refund called with amount 240*, *send_email called twice, not once*, *Output never says "refund issued"*. `shadowlap fix title` replaces it with one of your own.

A blame that stopped early opens or joins a fix too: it replayed the run and saw it fail before it probed anything, so the failure is reproduced. A blame that refused (the run passes, or doesn't replay as recorded) leaves nothing behind. An applied fix is finished: no run joins it, and the same failure coming back after it shipped opens a new one.

Each blame also logs a `blame.done` event in the store's activity. Run by a dashboard job, it reports a link to the fix's Blame step.

## Cost

Each probe replays everything before its call for free. The calls after it run live, so later probes are cheaper. A search makes at most `1 + ⌈log₂ m⌉ + scan` probes for *m* model calls, each of at most `--attempts` attempts, and usually far fewer attempts than that, because a probe stops once its verdict is settled. The header prints the bound before anything runs.

| Option | Effect |
|---|---|
| `--budget <usd>` | Start no attempt once this much is spent on live model calls. Attempts already running finish, so the total can pass the budget by one attempt per concurrent slot. Needs prices for the models involved: an unpriced model counts as $0, and the report names it |
| `--timeout <seconds>` | Stop an attempt after this long and count it as failed, for an agent that can loop |
| `--concurrency <n>` | Run up to *n* attempts of a probe at once. Probes still run one after another, since each depends on the last |

Stopping early, by budget or by Ctrl-C, still prints what the search found so far, and exits 1.

## JSON

`--json` prints the report on stdout (progress still goes to stderr), for scripts and [coding agents](./agents.md):

| Field | |
|---|---|
| `outcome` | `blamed`, `unrescuable` or `stopped`; `error` when blame refused, with `error.reason` (`passes`, `diverged`, `bypassed`, `prefix`, `no-model-calls`, `interrupted`) and `error.message` |
| `blamed`, `lost` | `{ callNo, step, passes, attempts }` for the blamed call and the one after it, or `null` |
| `confidence` | `high`, `medium` or `low` |
| `contrast` | `{ callNo, recorded, rescued, rescuedRunId }`: the model's answer at the blamed call in the recording and in the rescued fork, as blocks (`text`, `thinking`, `tool_call` with `name` and `input`) |
| `probes` | Per probe: `callNo`, `step`, `passes`, `attempts`, `rescued`, and `runs`, each with `runId`, `passed`, `exitCode`, `failures`, `spent` and `upstreamRequests` |
| `oracle`, `recordedFailures` | What a passing run must do, and how the recording fails it |
| `rescue` | `{ fields }`: the request fields a probe changed; empty when it resampled |
| `modelCalls`, `attemptsPerProbe`, `passesNeeded`, `nonMonotone`, `cost`, `stopReason` | The search's parameters and what it spent |
| `warnings` | What the replays warned about, such as a connection that bypassed Shadowlap |
| `fix` | `{ fixId, title, status, opened }`: the [fix](#fixes) the blame opened (`opened: true`) or joined, or `null` when the store could not keep it |

## When blame refuses

| Message | Why | What to do |
|---|---|---|
| *passes its oracle when replayed* | The replayed run does what the oracle asks, so there is no failure | Say what it should have done with `--expect` |
| *does not replay as recorded* | The replay forks by itself, so a probe could not tell a changed answer from a changed prefix | [`shadowlap calibrate`](./normalizers-and-redaction.md#calibrate), then blame again |
| *forked at call n instead* | An attempt ran a prefix the recording doesn't hold | As above. Branches that run at once need [scopes](./sdk.md#scopes) |
| *made no model calls* | There is no model answer to blame, or none in the `--scope` given | Check the scope names blame lists |
| *did not replay through Shadowlap* | The recording has model calls and the replay made none: the agent reached its model some other way, often a local server Shadowlap was told about when recording (`SHADOWLAP_UPSTREAM_OPENAI`) and not now | Replay in the environment you recorded in |

## Limits

- Blame points at a model call, because a model answer is the one thing a probe can ask for again. A failure caused by a tool returning bad data shows up as *not rescued*, or as blame on a call that read the bad data; an [override](./interventions.md#override-a-tool-result) tests that directly.
- The verdict is statistical. With 5 attempts and 2 needed, a call the model gets right a fifth of the time can look lost. Raise `--attempts` for an agent that rarely succeeds.
- The binary search finds *a* boundary. The scan checks the calls just past it, but a dip further along goes unprobed, so read a low-confidence result together with its probes.
