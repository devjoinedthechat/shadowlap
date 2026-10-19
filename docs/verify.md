# Verify

A fix that works on the run it was written for proves little: the model may have got lucky, the fix may only fit that one run, and it may break runs that worked. `shadowlap verify` checks all three before a change ships. It replays recorded runs under the code as it is now, as many times as it takes to decide where the replay forks, and accepts the change only when every failing run is fixed and every good run still passes, each decided at a stated risk.

```sh
shadowlap verify --fixes 01M3RXQ4VB --holdout 01M3RXQ51B --keeps label:good \
  --expect '{"tools":{"issue_refund":{"count":0,"args":{"amount":240}}}}'
```

```
✗ Rejected: the change fixes 1 of 1 target run, 1 of 1 held-out run and keeps 0 of 1 good run
  · good run 01M3RXQ56V broken: 0 of 3 passed, ≤ 0.56 (the agent exited with code 1)

  A run's attempts must meet the oracle: the agent exits 0; issue_refund with {"amount":240} called 0 times. Its gate decides after each attempt: pass at 90% or more, fail at 70% or less, at most 5% risk of the wrong verdict, up to 80 attempts; a clean replay settles it in one.

    target    01M3RXQ4VB  fixed   12 of 12 passed, ≥ 0.76  forked at #1
    held-out  01M3RXQ51B  fixed   12 of 12 passed, ≥ 0.76  forked at #1
    good      01M3RXQ56V  broken  0 of 3 passed, ≤ 0.56   the agent exited with code 1

  per run, as it would run live: 4,329 → 5,193 input tokens (+20%) · ≈$0.015 → ≈$0.018 (+16%)
  verifying: 27 attempts · 102 upstream requests · ≈$0.486 spent · code 370712a+dirty
```

Here a prompt change stopped the agent refunding $240 against policy, in the run it was written for and in one it was not. It also named a tool the agent doesn't have, and the good run, a $40 refund within policy, crashed on it. The exit status is 1, so the same command gates a merge.

## The runs

| Option | Role | Passes when |
|---|---|---|
| `--fixes <run...>` | **Targets**: failing runs the change was written to fix | enough attempts meet the oracle |
| `--holdout <run...>` | **Held-out**: failing runs of the same kind that the change was not written against | the same |
| `--keeps <run...>` | **Good** runs: runs that passed and must still pass | the same |

Each takes run ids or unique prefixes, and `label:<name>` for every run with that label, so `--keeps label:good` checks every run you have [labelled](./cli.md#label-note) good. A run has one role.

Held-out runs are what tell a fix from a patch that only fits its examples. A prompt edit written while reading two failed runs can mention what those runs had in common and nothing else. It will fix them and miss the next one. The report warns when there are none, and when there are no good runs, because then nothing was checked for regressions.

It also warns when a recording contradicts its role. A target that already passes as recorded proves nothing when fixed, and a "good" run that fails as recorded is not a good run. The recording is judged from what it holds: its exit status, and every check but those on the agent's output, which is not recorded.

## How a run is judged

**The oracle** is the same as [blame's](./blame.md#how-it-works): the agent exits 0, and meets `--expect`, the `expect` object of an [outcome check](./ci.md#outcome-checks). One oracle applies to every run, so a policy such as "never refund $240" is also checked on the good runs. Each attempt is a fork, so a [judge check](./judges.md) in `--expect` is asked live; one whose judge can't be (no key for its provider, and no upstream set for it) is refused before anything runs, since every attempt would read inconclusive and none could pass.

**Attempts.** Each run is replayed with its recorded command, under the code in the working directory. A replay forks at the first request the change affects, and everything after that runs live, so a forked run is a sample, and is replayed until its [gate](./gating.md) decides: after each attempt it either passes (the run passes its oracle at least 90% of the time), fails (70% or less), or takes another, each verdict wrong at most 5% of the time. A run that always passes is accepted after 12 attempts; one that always fails is rejected after 3; one still between the two after 80 is **inconclusive**, and the change is not accepted (a run that passes 90% of the time ends so 0.9% of the time). The 4 of 5 verify used before let a run that passes 70% of the time through about half the time; the gate lets it through 4% of the time. `--gate` changes the figures, such as `--gate '{"good":0.95,"bad":0.8}'`; `--attempts` and `--passes` give a fixed count instead (4 of 5 by default), which stops as soon as its verdict is settled.

**A replay that forks nowhere settles its run in one attempt.** Every call came from the recording, so every attempt would come out the same. A replay that made no model calls through Shadowlap, where the recording made some, is not one of them. The agent reached its model some other way, and what it did is unrecorded. The attempt fails and the report says why, because counting it would judge a run nobody saw. That makes verifying a harness fix free, since fixes to parsing, dispatch or stop conditions change no request. It also makes the good runs a change doesn't touch free.

**The change is tested as it will ship.** A changed system prompt changes every request, so every run forks at its first model call and runs live. That is what the change will do in production. [`--prompt-from`](./interventions.md#apply-a-changed-prompt-from-a-later-call) is cheaper, but it answers a different question ("what if the prompt had been this from step *k*"), so verify doesn't use it.

The change can also be a request field instead of code: `--model` and `--set key=value` apply from each run's first model call, to check whether a model switch fixes the failures and what it costs. When the runs hold other models' calls, a simulated user or a sub-agent on a smaller model, `--from <model>` keeps the change to the calls made with that model, from the first of them on: `shadowlap verify --keeps label:good --model claude-sonnet-5-5 --from claude-sonnet-4-5`.

**A fix inside a tool** needs `--live-tool <name>`. A tool call whose arguments didn't change is served from the recording, so without the flag the fixed code never runs. The report says so when it happens: *read_policy changed since the recording; pass --live-tool read_policy to run it live*.

## Reading the report

| Part | Meaning |
|---|---|
| **Accepted / Rejected / Incomplete** | Accepted: every target and held-out run fixed, every good run kept. Rejected: any run failed, each listed with its first failure. Incomplete: nothing failed, but a run never settled (budget, Ctrl-C) or its gate ended inconclusive |
| **The runs** | Each run's role, outcome (*fixed*, *not fixed*, *kept*, *broken*, *inconclusive* or *unsettled*), attempts passed (or *clean replay*) with its pass rate as the gate decided it (`≥ 0.76`: the low end of the Wilson interval at 95% for a run that passed, the high end for one that failed), and where it forked or why it failed |
| **Warnings** | What the evidence lacks: no held-out or good runs, a recording that contradicts its role, a tool that changed without `--live-tool`, a connection that bypassed Shadowlap |
| **per run, as it would run live** | Input tokens and cost per run as recorded and under the change, as budget checks count them: every model request, whatever its origin. A prompt that grows shows up here |
| **verifying** | What the verification itself cost, and the code version it verified |

Every attempt is a run in the store, bundled per verified run in the dashboard's forks view. `shadowlap show` on an attempt says which role its recording played and whether it passed.

## Cost

A run that replays clean costs nothing. A forked run costs up to the gate's `max` live suffixes (80), and usually far fewer: 12 for a fix that always works, 3 for one that never does. That is what it takes to tell a run that passes 90% of the time from one at 70% at 5% risk; [Gating](./gating.md#what-a-gate-costs) has the table.

| Option | Effect |
|---|---|
| `--budget <usd>` | Start no attempt once this much is spent on live model calls; the report is *incomplete* |
| `--fail-fast` | Start nothing new once a run has failed. The rest are reported unsettled |
| `--concurrency <n>` | Verify *n* runs at once; each run's attempts still go one after another |
| `--timeout <seconds>` | Stop an attempt after this long and count it as failed |

Writes are stubbed after a fork, as in [blame](./blame.md#side-effects) (`--writes block` to make them throw); `allow` is not accepted.

## Replaying in today's environment

A replay re-runs a run's recorded command, but in the environment verify runs in, not the one the run was recorded in. If what makes a run *that* run comes from an environment variable (which customer, which ticket), every run replays with today's value. Pass it as an argument instead, where the recorded command keeps it. A command after `--` replaces every run's recorded command.

## Verdicts are kept

Every verdict is kept in the store with its whole report, whether or not `--json` was given, and linked to the [fix](./cli.md#fix) of the failing runs: the fix they fail in, or, for runs never blamed, a fix not yet applied that their labels point to. A verdict on runs no fix holds is kept on its own.

A verdict counts for a fix only when it checked what the fix checks, on a run that failed it:

- Its oracle has every condition of the fix's check: the same `--expect`, or one that asks for more. A verify without `--expect` checks the exit code alone, so it says nothing about a fix blamed with `--expect '{"tools":{"issue_refund":0}}'`, however many runs it accepts.
- At least one of the fix's failing runs among its targets and held-out runs failed that oracle as recorded, or can't be judged from its recording (a check on the agent's output, which is not recorded). Fixing runs that already passed proves nothing.

A verdict that counts brings its runs to the fix: the target and held-out runs that didn't pass as recorded become its failing runs, and the good runs its good runs. An accepted one turns the fix verified. A rejected one counts as a change rejected before it shipped; given after the fix was applied, it means the fix no longer holds, and the fix says so until a later verdict accepts it again. A fix stays verified whatever a later verdict says. A verdict that doesn't count is kept and shown on the fix's Verify step with why, and changes nothing.

The report ends with each fix it was kept with and what the verdict did to it:

```
  fix fx-01M3RZ4XKN · Refunds above the limit issued without approval · verified · shadowlap fix show fx-01M3RZ4XKN
```

A verdict that doesn't count says why in the same place: *accepted verdict kept, not counted (checked under another check); still open*.

The verdict is logged as a `verify.accepted` or `verify.rejected` event in the store's activity, naming the fixes it counts for. Run by a dashboard job, it reports a link to that verdict on the fix's Verify step.

## JSON

`--json` prints the report on stdout, for scripts, CI and [coding agents](./agents.md):

| Field | |
|---|---|
| `verdict` | `accepted`, `rejected` or `incomplete` |
| `reasons`, `warnings` | Why it was not accepted, run by run; what the evidence lacks |
| `summary` | `{ targets, holdout, good }`, each `{ passed, total }` |
| `runs` | Per run: `runId`, `role` (`target`, `holdout`, `good`), `outcome` (`fixed`, `not-fixed`, `kept`, `broken`, `inconclusive`, `unsettled`), `passes`, `attempts`, the gate's `decision` (`pass`, `fail`, `inconclusive` or `continue`; `null` under a fixed count), its `rate` (the `decision`, the Wilson `interval` of the pass rate as `{ lo, hi, confidence }`, and the `sentence`; `null` under a fixed count), `deterministic`, `recorded` (`{ passed, failures, footprint }`), and `runs`, each attempt with `runId`, `passed`, `exitCode`, `failures`, `forkedAt`, `spent`, `upstreamRequests` and `footprint` |
| `gate` | The gate each run was decided by, `{ kind, good, bad, risk, max }`, or `null` when a fixed count (`--attempts`, `--passes`) decided |
| `oracle`, `attemptsPerRun`, `passesNeeded`, `change`, `codeVersion` | What was checked, against what: with a gate, `attemptsPerRun` is its `max` and `passesNeeded` the fewest passes that can pass it (12) |
| `cost`, `stopReason` | What verifying cost, and why it stopped early |
| `judge` | `{ spent, upstreamRequests }`: what [judge checks](./judges.md)' calls cost, apart from `cost`, which is the agent's alone; `null` when no judge was asked live. `--budget` counts both |
| `verifyId`, `fixes` | The verdict as it was kept (`vf-…`), and each fix it was kept with: `fixId`, `title`, `status` after it, `counts`, and `why` it doesn't count (`another-check`, `already-passing`, `no-runs`) |

A footprint is `{ inputTokens, outputTokens, cost }`, with `cost` null when a model has no price: the agent's model calls, never a judge check's.

[`shadowlap repair`](./repair.md) runs this gate on every fix it considers, and keeps only one it accepts.
