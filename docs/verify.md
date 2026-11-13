# Verify

`shadowlap verify` proves a change before it ships: every failing run fixed, and every good run kept. A fix that works on the run it was written for proves little: the model may have got lucky, the fix may only fit that one run, and it may break runs that worked. Verify checks all three, each at a stated risk.

It replays recorded runs under the code in the working directory, as many times as it takes to decide where the replay forks. It accepts the change only when every failing run is fixed and every good run is kept: no worse than the same run under the code before the change by 10 points or more.

## Verify a change

Name the runs the change should fix, the failing runs it was not written against, and the runs that must not get worse:

```sh
shadowlap verify --fixes 01M3RXQ4VB --holdout 01M3RXQ51B --keeps label:good \
  --expect '{"calls":[{"tool":"issue_refund","after":"lookup_order","args":{"amount":{"<=":100}}}]}'
```

It prints:

```text
✗ Rejected: the change fixes 1 of 1 target run, 1 of 1 held-out run and keeps 0 of 1 good run
  · good run 01M3RXQ56V broken: 0 of 7 passed, baseline 7 of 7 · drop >= 0.03 (95%) (the agent exited with code 1)

  A run's attempts must meet the oracle: the agent exits 0; every issue_refund call: after lookup_order, amount <= 100. Its gate decides after each attempt (gate: tells 90%+ from 70%- at <= 5% risk, up to 80 attempts); a clean replay settles it in one. A good run that forks is kept unless it drops 10+ points below its baseline at 370712a, attempt for attempt, <= 5% risk, up to 200 pairs.

    target    01M3RXQ4VB  fixed   12 of 12 passed · rate >= 0.73 (95%)                              forked at #1
    held-out  01M3RXQ51B  fixed   12 of 12 passed · rate >= 0.73 (95%)                              forked at #1
    good      01M3RXQ56V  broken  0 of 7 passed, baseline 7 of 7 · drop >= 0.03 (95%)               the agent exited with code 1

  per run, as it would run live: 4,182 → 5,713 input tokens (+37%)
  verifying: 38 attempts · 145 upstream requests · ≈$0 spent (no price for small-model) · code 370712a+dirty
```

Here a prompt change stopped the agent refunding $240 against policy, in the run it was written for and in one it was not. It also named a tool the agent doesn't have, and the good run, a $40 refund within policy, crashed on it.

Its baseline, the same run at 370712a (the commit before the change), passed every one of its attempts, each forced live where the change forked. Seven pairs in which the change failed and its baseline passed are enough to call the run broken. The exit status is 1, so the same command gates a merge.

## The runs

Each run has one role:

| Flag | Role | Passes when |
|---|---|---|
| `--fixes <run...>` | **Targets**: failing runs the change was written to fix | Enough attempts meet the oracle |
| `--holdout <run...>` | **Held-out**: failing runs of the same kind that the change was not written against | The same |
| `--keeps <run...>` | **Good** runs: runs that passed and must not get worse | It is not worse than its [own baseline](#good-runs-against-their-own-baseline) by the margin or more |

Each takes run ids or unique prefixes, and `label:<name>` for every run with that label, so `--keeps label:good` checks every run you have [labelled](./cli.md#label-note) good.

**Held-out runs** are what tell a fix from a patch that only fits its examples. A prompt edit written while reading two failed runs can mention what those runs had in common and nothing else. It will fix them and miss the next one. The report warns when there are none, and when there are no good runs, because then nothing was checked for regressions.

**A recording that contradicts its role** gets a warning too. A target that already passes as recorded proves nothing when fixed, and a "good" run that fails as recorded is not a good run. The recording is judged from what it holds: its exit status, and every check but those on the agent's output, which is not recorded.

## How a run is judged

Each run is replayed with its recorded command, under the code in the working directory:

1. **The replay forks** at the first request the change affects, and everything after that runs live.
2. **A forked run is a sample**, so it is replayed until it is decided: a target or held-out run by its [gate](./gating.md), a good run against [its own baseline](#good-runs-against-their-own-baseline).
3. **Each attempt is judged** by the oracle.
4. **A replay that forks nowhere** is settled by its first attempt, for free.

### The oracle

The oracle is the same as [blame's](./blame.md#how-it-works): the agent exits 0, and meets `--expect`, the `expect` object of an [outcome check](./ci.md#outcome-checks). One oracle applies to every run, so a policy such as "refund at most $100" is also checked on the good runs.

Each attempt is a fork, so a [judge check](./judges.md) in `--expect` is asked live. One whose judge can't be asked (no key for its provider, and no upstream set for it) is refused before anything runs, since every attempt would read inconclusive and none could pass.

An attempt can still fall short only on a check that could not be decided, such as a judge whose call failed, or a condition the attempt gave no value for. Such an attempt is **inconclusive**, never a failure: it says nothing of the change, and no attempt after it would say more. So its run stops there, inconclusive, and the report says which check and why.

### Attempts

A target or held-out run is decided by its gate. The gate tells a run that meets its oracle 90% of the time or more from one that meets it 70% or less, each verdict wrong at most 5% of the time at those two rates. After each attempt it passes the run, fails it, or takes another:

- **A run that always passes** is accepted after 12 attempts.
- **A run that always fails** is rejected after 3.
- **A run still between the two after 80** is **inconclusive**, and the change is not accepted. A run that passes 90% of the time ends so 1.0% of the time.

Between the two rates either verdict can come: a run that passes 80% of the time is passed 37% of the time. So a run's line states its outcome, its tally and the bound of its pass rate, exact under the gate's stopping ([reading the evidence](./gating.md#reading-the-evidence)). The report states the rule once, never a rate the run is claimed to pass at.

**Other figures, or a fixed count.** `--gate` changes the figures, such as `--gate '{"good":0.95,"bad":0.8}'`. `--attempts` and `--passes` give a fixed count instead (4 of 5 by default), which stops as soon as its verdict is settled. A fixed count of 4 of 5 lets a run that passes 70% of the time through about half the time; the gate lets it through 4% of the time.

**When the provider is unavailable.** An attempt the agent failed while its provider was down, overloaded or rate limiting says nothing about the change ([gating](./gating.md#when-the-provider-is-unavailable)), on either side of a pair:

- **The provider failed before the model answered anything**: the attempt is run again and never counted.
- **It cut the attempt short after**: the attempt is counted against either verdict, a failure toward fixed or kept and a pass toward not fixed or broken, so neither rests on how it would have ended.

When the provider stays unavailable too many attempts in a row (3 within the first 10 attempts, one more for each tenfold beyond: 4 to 100, 5 to 1,000), the run is **inconclusive**, never not fixed or broken. Verify stops there, *incomplete* with the provider named, exit 3.

**Side effects.** Writes are stubbed after a fork, as in [blame](./blame.md#side-effects) (`--writes block` to make them throw); `allow` is not accepted.

### A replay that forks nowhere

A replay that forks nowhere settles its run in one attempt. Every call came from the recording, so every attempt would come out the same. That makes verifying a harness fix free, since fixes to parsing, dispatch or stop conditions change no request. It also makes the good runs a change doesn't touch free.

A replay that made no model calls through Shadowlap, where the recording made some, is not one of them. The agent reached its model some other way, and what it did is unrecorded. The attempt fails and the report says why, because counting it would judge a run nobody saw.

### The change is tested as it will ship

A changed system prompt changes every request, so every run forks at its first model call and runs live. That is what the change will do in production. [`--prompt-from`](./interventions.md#apply-a-changed-prompt-from-a-later-call) is cheaper, but it answers a different question ("what if the prompt had been this from step *k*"), so verify doesn't use it.

The change can also be a request field instead of code: `--model` and `--set key=value` apply from each run's first model call, to check whether a model switch fixes the failures and what it costs. When the runs hold other models' calls, such as a simulated user or a sub-agent on a smaller model, `--from <model>` keeps the change to the calls made with that model, from the first of them on: `shadowlap verify --keeps label:good --model claude-sonnet-5-5 --from claude-sonnet-4-5`.

### A fix inside a tool

A fix inside a tool needs `--live-tool <name>`. A tool call whose arguments didn't change is served from the recording, so without the flag the fixed code never runs. The report says so when it happens: *read_policy changed since the recording; pass --live-tool read_policy to run it live*.

## Good runs against their own baseline

A good run is no evidence on its own. One that passes 90% of the time unchanged fails a gate between 90% and 70% from time to time. Judged by the gate alone, a perfect change would be rejected when there were several such runs, and one that slid from 99% to 84% under the change would still pass the gate two times in three.

So a good run that forks is compared with its own baseline, the same run under the code before the change. It is **kept unless its pass rate drops by the margin or more** below the baseline's: 10 points by default (`--margin`, or `verify.margin` in `shadowlap.config.json`), at the gate's risk.

- **A run that drops by the margin or more** is kept at most 5% of the time, whatever its baseline's pass rate.
- **A run that doesn't drop at all** is broken at most 5% of the time.
- **A good run that replays clean** is kept by its one free attempt: the change doesn't touch it.

A failing run is fixed when it passes its gate on its own.

### The baseline

Where the baseline runs depends on the change:

| The change | The baseline runs |
|---|---|
| In the working tree | At HEAD |
| Committed | At the commit `--base` names, such as `--base main` |
| Request fields alone (`--model`, `--set`), on a working tree with no change | On the working tree without them: for a model switch, the same run on the model it was recorded with |
| A candidate under [repair](./repair.md#candidates-are-tried-in-a-worktree-of-their-own) | On the code without the candidate (below) |

A commit is checked out on its own, in a temporary git worktree under `.shadowlap/verify/`, as [bisect](./cli.md#bisect) checks one out:

- the recorded command points into it;
- the working tree's installed packages serve it, this repository's own as they were at that commit;
- `--build "npm run build"` builds it instead.

It is removed when verify ends. The environment is today's for both, so a change made through an environment variable reaches the baseline too.

Repair verifies each candidate in a worktree of its own. There the baseline is the code without the candidate: that worktree as it was before the candidate went in, copied into another and built the same way.

### Attempt for attempt

Each attempt of the change is paired with one of the baseline, run straight after it and forced live at the call where the change forked. So both sample the run from the same point on, and whatever drifts over the run, the provider or its load, moves both alike.

After each pair the test decides. It is a betting e-process on the pair's difference, the change's outcome minus its baseline's (Waudby-Smith and Ramdas, *Estimating means of bounded random variables by betting*, 2023):

- **Kept** once the evidence that the drop is under the margin reaches 1/risk, 20 at 5%.
- **Broken** once the evidence of any drop does.
- **Inconclusive** with 200 pairs run and neither, and the change is not accepted.

Ville's inequality bounds each verdict's error by the risk at every look, with no fixed number of attempts. It holds for any pairs whose drop, given the pairs before, is at least the margin: arms that drift together, arms that are correlated, pass rates that change from pair to pair.

The test reads the counts of pairs only, so its odds can be worked out exactly. Over every such null at once, the worst it does is keep a dropped run 4.9% of the time, and break an undropped one 4.3%.

### What it takes

This table gives the exact odds of each verdict, and the attempts each arm runs on average, at the defaults (10 points, 5% risk, 200 pairs). The baseline passes at a given rate and the change that much lower, its pairs independent:

| Baseline | Drop      | Kept · broken | Attempts an arm |
| -------: | --------- | ------------- | --------------: |
|      99% | None      | 100% · 0%     |              46 |
|      99% | 5 points  | 39.9% · 56.8% |             108 |
|      99% | 10 points | 3.0% · 96.5%  |              74 |
|      99% | 15 points | 0.3% · 99.7%  |              49 |
|      99% | 25 points | 0% · 100%     |              29 |
|      90% | None      | 79.1% · 3.0%  |             114 |
|      90% | 5 points  | 22.9% · 24.2% |             151 |
|      90% | 10 points | 3.6% · 67.5%  |             123 |
|      90% | 15 points | 0.8% · 93.9%  |              80 |
|      90% | 25 points | 0.1% · 99.9%  |              38 |
|      85% | None      | 65.1% · 3.4%  |             130 |
|      85% | 5 points  | 19.0% · 19.9% |             158 |
|      85% | 10 points | 3.7% · 57.2%  |             134 |
|      85% | 15 points | 1.0% · 88.4%  |              93 |
|      85% | 25 points | 0.1% · 99.8%  |              43 |
|      75% | None      | 48.0% · 3.8%  |             145 |
|      75% | 5 points  | 15.0% · 16.0% |             164 |
|      75% | 10 points | 3.8% · 45.4%  |             146 |
|      75% | 15 points | 1.2% · 78.7%  |             108 |
|      75% | 25 points | 0.2% · 99.4%  |              50 |

A drop of the margin or more is kept 3.8% of the time at most, as the rows with a drop of 10 points or more show. The price is attempts: telling "no worse by 10 points" from "worse" takes many pairs when the run is noisy. So a run at 90% unchanged is kept four times in five within 200 pairs and left inconclusive most of the rest, one at 75% about half the time.

Runs whose arms pass every attempt are kept after 38 pairs. The engine's tests hold these figures, by exact enumeration and by a seeded simulation that adds drift and correlated arms.

### The margin

The margin is the lever. A wider one is cheaper, and still bounds what it lets through:

| `--margin` | Kept when every attempt passes, after | No drop from 90%: kept · attempts an arm | No drop from 99% |
|---|---|---|---|
| 0.05 | 78 pairs | 25.5% · 171 | 88.0% · 108 |
| 0.1, the default | 38 pairs | 79.1% · 114 | 100% · 46 |
| 0.2 | 18 pairs | 97.9% · 39 | 100% · 20 |
| 0.3 | 11 pairs | 99.0% · 20 | 100% · 12 |

A gate's `max` other than its default (`--gate '{"max":40}'`) caps a good run's pairs too, and `verify.max` sets them alone. `--kept-max` sets them for one verify, over both.

### The line

A good run's line shows both tallies and a bound on the drop: `kept · 38 of 38 passed, baseline 38 of 38 · drop <= 0.10 (95%)`, or `broken · 0 of 7 passed, baseline 7 of 7 · drop >= 0.03 (95%)`.

- **The bound holds whenever the test stopped**, however it stopped: it inverts the same e-processes, a confidence sequence. So it is wider than an interval for a fixed count of attempts: seven pairs say the run dropped, and only a little about how far.
- **Each end is rounded away from what it bounds**, an upper end up and a lower one down, so the line never says more than was worked out.
- **A run left inconclusive states both ends**, `drop -0.04 to 0.18 (95%)`, each built at half the risk, so the two hold together at the 95% the line prints.

### Against history

`--baseline history` (or `verify.baseline`) compares a good run with its golden's test history instead. That is the attempts of the golden's last sessions under the same recording and checks, in fork mode, each session by its first 5 attempts, as [a gate against history](./gating.md#a-gate-against-history) pools them. Only the change's arm runs.

The history's pass rate is bounded at risk/2 (Clopper-Pearson), and the change's attempts are tested against that bound at risk/2. So a drop of the margin is kept at most 5% of the time, if the history's attempts are draws of the baseline's present pass rate.

A short history knows little: against 50 attempts, a run at 90% with no drop is kept 18.9% of the time within 200 attempts, one at 99% after 60 attempts on average. A run with no golden, or a golden with no history under these checks, is judged by its gate on its own.

### No baseline

Where none can be had, a good run is judged by its gate on its own, as a target is, and the report says so in a warning. That happens when:

- the working directory is in no git repository;
- the working tree has no change against HEAD, and no `--base` names the commit before it;
- there is no history;
- the baseline can't ask its model: the provider turned it away for good, as it does once a model retires ([migrate](./decisions.md#once-the-old-model-is-gone));
- the baseline, or the history, passes so rarely that its pass rate is at or under the margin, at the gate's risk. No run can drop that far, so keeping a run to it would say nothing.

The attempts already run stand, and the gate decides on them. `--attempts` and `--passes` judge every run by a fixed count on its own.

## Reading the report

The report has these parts:

| Part                                 | Meaning                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------ |
| **Accepted / Rejected / Incomplete** | The verdict on the change                                                |
| **The runs**                         | Each run's role, outcome and tally, and where it forked or why it failed |
| **Warnings**                         | What the evidence lacks                                                  |
| **after the fork**                   | What answered the attempts' tool calls after their forks                 |
| **per run, as it would run live**    | Input tokens and cost per run, as recorded and under the change          |
| **verifying**                        | What the verification itself cost, and the code version it verified      |

**The verdict.**

- *Accepted*: every target and held-out run fixed, every good run kept.
- *Rejected*: any run failed, each listed with its first failure.
- *Incomplete*: nothing failed, but a run never settled (budget, Ctrl-C), its gate ended inconclusive, or an attempt of it could not be judged. The first line counts inconclusive runs apart.

**The runs.** The rules they were decided by are stated once, above them. Each run's line gives:

- its role;
- its outcome: *fixed*, *not fixed*, *kept*, *broken*, *inconclusive* or *unsettled*;
- the attempts passed, or *clean replay*, with an attempt that could not be judged counted apart: `2 of 2 passed, attempt 3 not judged`;
- the bound of its pass rate at the gate's confidence, `rate >= 0.73 (95%)`: the interval's low end for a run that passed, the high end for one that failed, both ends for one left inconclusive;
- where it forked, or why it failed.

A good run kept against its baseline shows both tallies and the bound on its drop (`0 of 7 passed, baseline 7 of 7 · drop >= 0.03 (95%)`).

**Warnings.** What the evidence lacks: no held-out or good runs, a good run judged on its own for want of a baseline, a recording that contradicts its role, a tool that changed without `--live-tool`, a connection that bypassed Shadowlap. Also what the attempts got after the fork, below: a good run whose two arms got different answers, and a person's recorded answers served in order.

**after the fork.** What answered the tool calls the attempts made from their forks on, the change's and the good runs' baselines' apart:

- *answered as recorded*: a pure tool, or a read under [`--reads replay`](./cli.md#verify), with the same arguments;
- *given a person's recorded answers in order*, whatever the agent then asked;
- *ran live*, *stubbed* or *blocked*.

Model calls are left out: after the fork they run live by design. A good run warns when its change's attempts got stubbed or blocked answers for a share of their calls 10 points or more above its baseline's: the two arms then ran against different answers.

**per run, as it would run live.** Input tokens and cost per run as recorded and under the change, as budget checks count them: every model request, whatever its origin. A prompt that grows shows up here.

Every attempt is a run in the store, bundled per verified run in the dashboard's forks view. `shadowlap show` on an attempt says which role its recording played and whether it passed.

## Cost

What a run costs depends on how it replays:

| Run | What it costs |
|---|---|
| Replays clean | Nothing |
| Forked target or held-out run | Up to the gate's `max` live suffixes (80): 12 for a fix that always works, 3 for one that never does |
| Forked good run | Two attempts a pair, its own and its baseline's, up to 200 pairs |

A target's 80 is what it takes to tell a run that passes 90% of the time from one at 70% at 5% risk; [Gating](./gating.md#what-a-gate-costs) has the table. A good run takes 38 pairs when every attempt passes, 46 on average for a run at 99% that doesn't drop, and 114 at 90%. One that drops 25 points is broken after 29 to 50. The [margin](#the-margin) is the lever.

**Limits on spending.** `--budget <usd>` starts no attempt once that much is spent on live model calls, though a pair that started runs its baseline's attempt too; the report is *incomplete*. `--fail-fast` starts nothing more once a run has failed, and the rest are reported unsettled.

## Verdicts are kept

Every verdict is kept in the store with its whole report, whether or not `--json` was given. It is linked to the [fix](./cli.md#fix) of the failing runs: the fix they fail in, or, for runs never blamed, a fix not yet applied that their labels point to. A verdict on runs no fix holds is kept on its own.

A verdict counts for a fix only when it checked what the fix checks, on a run that failed it:

- **Its oracle has every condition of the fix's check**: the same `--expect`, or one that asks for more. A verify without `--expect` checks the exit code alone, so it says nothing about a fix blamed with `--expect '{"calls":[{"tool":"issue_refund","after":"lookup_order","args":{"amount":{"<=":100}}}]}'`, however many runs it accepts.
- **At least one of the fix's failing runs** among its targets and held-out runs failed that oracle as recorded, or can't be judged from its recording (a check on the agent's output, which is not recorded). Fixing runs that already passed proves nothing.

A verdict that counts brings its runs to the fix: the target and held-out runs that didn't pass as recorded become its failing runs, and the good runs its good runs. Then:

| Verdict                              | What it does to the fix                                                     |
| ------------------------------------ | --------------------------------------------------------------------------- |
| Accepted                             | Turns the fix verified                                                      |
| Rejected, before the fix was applied | Counts as a change rejected before it shipped                               |
| Rejected, after the fix was applied  | The fix no longer holds, and says so until a later verdict accepts it again |

A fix stays verified whatever a later verdict says. A verdict that doesn't count is kept and shown on the fix's Verify step with why, and changes nothing.

**A check changed later.** [`shadowlap fix check`](./cli.md#fix-check) gives an open fix another check. A verdict given under the check before is kept, and counts only when its oracle has every condition of the fix's check. The Verify step shows the others as made under the old check.

The report ends with each fix it was kept with, and what the verdict did to it:

```text
  fix fx-01M3RZ4XKN · Refunds above the limit issued without approval · verified · shadowlap fix show fx-01M3RZ4XKN
```

A verdict that doesn't count says why in the same place: *accepted verdict kept, not counted (checked under another check); still open*.

The verdict is logged as a `verify.accepted` or `verify.rejected` event in the store's activity, naming the fixes it counts for. Run by a dashboard job, it reports a link to that verdict on the fix's Verify step.

## Flags

These are the flags this page covers. [The CLI reference](./cli.md#verify) lists every one.

| Flag | What it does | Default |
|---|---|---|
| `--fixes <run...>` | Targets: failing runs the change was written to fix ([the runs](#the-runs)) | — |
| `--holdout <run...>` | Held-out runs: failing runs the change was not written against | — |
| `--keeps <run...>` | Good runs: runs that passed and must not get worse | — |
| `--expect <json\|@file>` | What a passing run must do besides exiting 0 ([the oracle](#the-oracle)) | The exit code alone |
| `--gate <json\|@file>` | The gate a run is decided by ([attempts](#attempts)) | `{"good":0.9,"bad":0.7,"risk":0.05,"max":80}` |
| `--attempts <n>`, `--passes <n>` | A fixed count instead of the gate, 4 of 5 by default | — |
| `--margin <share>` | The drop below its baseline that breaks a good run | `verify.margin`, else 0.1 |
| `--kept-max <n>` | The most pairs a good run takes against its baseline, or attempts against its history | `verify.max`, else 200, or a `--gate` max off its default |
| `--baseline paired\|history` | What a good run is compared with ([against history](#against-history)) | `verify.baseline`, else `paired` |
| `--base <rev>` | The commit before a committed change ([the baseline](#the-baseline)) | HEAD |
| `--build <command>` | Build the baseline's checkout before its attempts | — |
| `--model <model>`, `--set <key=value>` | The change is a request field, set from each run's first model call | — |
| `--from <model>` | With `--model` or `--set`: change only the calls made with this model | Every call |
| `--live-tool <name>` | The change is in this tool: run it live ([a fix inside a tool](#a-fix-inside-a-tool)) | — |
| `--writes stub\|block` | What write tools do after a fork | `stub` |
| `--budget <usd>` | Start no attempt once this much is spent on live model calls ([cost](#cost)) | — |
| `--fail-fast` | Start nothing new once a run has failed; the rest are reported unsettled | — |
| `--concurrency <n>` | Verify *n* runs at once; each run's attempts still go one after another | 1 |
| `--timeout <seconds>` | Stop an attempt after this long and count it as failed | — |
| `--json` | Print the report as JSON on stdout ([JSON](#json)) | — |
| `-- <command>` | A command after `--` replaces every run's recorded command | — |

## Exit status

| Status | Meaning |
|---:|---|
| 0 | The change is accepted |
| 1 | The change is rejected |
| 2 | A run's model called a tool the run never recorded that [writes](./how-it-works.md#tools-shadowlap-did-not-record), found before anything runs |
| 3 | The verification did not finish: a run's gate or baseline inconclusive, the budget spent, or the provider unavailable |
| 128 + n | A stop signal, whenever it comes, the verdict reached or not: 130 for Ctrl-C |

## JSON

`--json` prints the report on stdout, for scripts, CI and [coding agents](./agents.md):

| Field | Type | Meaning |
|---|---|---|
| `verdict` | string | `accepted`, `rejected` or `incomplete` |
| `reasons` | array | Why it was not accepted, run by run |
| `warnings` | array | What the evidence lacks |
| `summary` | object | `{ targets, holdout, good }`, each `{ passed, inconclusive, total }` |
| `runs` | array | Each run ([below](#each-run)) |
| `gate` | object or null | The gate each run was decided by, `{ kind, good, bad, risk, max }` |
| `kept` | object or null | The rule good runs were kept by ([below](#the-rule-good-runs-were-kept-by)) |
| `oracle` | array | What was checked |
| `attemptsPerRun`, `passesNeeded` | number | With a gate, its `max`, and the fewest passes that can pass it (12) |
| `change` | object | `{ fields }`: what was changed |
| `codeVersion` | string or null | The code it verified |
| `cost` | object | What verifying cost: `{ attempts, unavailable, spent, upstreamRequests, unknownModels }` |
| `stopReason` | string or null | Why it stopped early; `provider unavailable: …` for a provider that stayed unavailable |
| `judge` | object or null | `{ spent, upstreamRequests }`: what [judge checks](./judges.md)' calls cost; `null` when no judge was asked live |
| `verifyId` | string or null | The verdict as it was kept (`vf-…`) |
| `fixes` | array | Each fix it was kept with: `fixId`, `title`, `status` after it, `counts`, and `why` it doesn't count |

Some fields need more than a line:

- **`summary`** counts an inconclusive run apart, neither passed nor failed.
- **`gate`** is `null` when a fixed count (`--attempts`, `--passes`) decided.
- **`cost.attempts`** counts both arms' attempts, those the provider cut short among them (each run's `cutShort` counts those too). `cost.unavailable` counts those the provider was unavailable for: retried, and never counted.
- **`judge`** is apart from `cost`, which is the agent's alone. `--budget` counts both.
- **`fixes[].why`** is `another-check`, `already-passing` or `no-runs`.

### Each run

Each entry of `runs`:

| Field | Type | Meaning |
|---|---|---|
| `runId` | string | The run |
| `role` | string | `target`, `holdout` or `good` |
| `outcome` | string | `fixed`, `not-fixed`, `kept`, `broken`, `inconclusive` or `unsettled` |
| `passes`, `attempts` | number | The attempts that passed, and the attempts run |
| `decision` | string or null | The gate's: `pass`, `fail`, `inconclusive` or `continue`; `null` under a fixed count |
| `rate` | object or null | The `decision`, the `interval` of the pass rate as `{ lo, hi, confidence }`, and the `sentence` |
| `deterministic` | boolean | Whether its first attempt replayed clean, so it settled the run |
| `recorded` | object | `{ passed, failures, footprint }`: how the recording itself fares against the oracle |
| `undecided` | string or null | Why its last attempt could not be judged, which made it `inconclusive` |
| `unavailable` | number | Its attempts and its baseline's the provider was unavailable for before the model answered: retried, never counted |
| `cutShort` | number | Those it cut short after the model answered, counted against either verdict, each with `cutShort: true` among the attempts |
| `runs` | array | Each attempt ([below](#each-attempt)) |

**`rate`** gives the `interval` exact under the gate's stopping, and the `sentence` as the verdict line: `passed · 12 of 12 · rate >= 0.73 (95%) · gate: tells 90%+ from 70%- at <= 5% risk, up to 80 attempts`. It is `null` under a fixed count, or when an attempt that could not be judged stopped the run, as its gate decided nothing.

### A good run against its baseline

A good run kept against its [own baseline](#good-runs-against-their-own-baseline) also has these fields:

| Field | Type | Meaning |
|---|---|---|
| `baseline` | object | `{ passes, attempts, source, revision }`: the baseline's tally, `paired` or `history`, and the commit it ran at |
| `margin` | number | The drop that breaks it: 0.1 for 10 points |
| `drop` | object or null | `{ lo, hi, confidence, method }`: the drop's confidence interval, valid whenever the test stopped |
| `baselineRuns` | array | Each attempt of the baseline, as `runs` lists the change's |

- **`baseline.revision`** is `null` for code that is no commit: the working tree, or under repair the code without the candidate.
- **`drop`** has each end at `confidence` for a run kept or broken. For one left undecided, each end is at half the risk, the two together at `confidence`. It is `null` where nothing bounds it.
- **`rate`** is then `{ decision, drop, sentence }`, the sentence its line and rule: `kept · 38 of 38 passed, baseline 38 of 38 · drop <= 0.10 (95%) · kept unless it drops 10+ points below its baseline at 370712a, attempt for attempt, <= 5% risk, up to 200 pairs`.

A good run that forked with no baseline to compare with has `noBaseline`: why it was judged by its gate on its own.

### The rule good runs were kept by

`kept` is `{ source, margin, risk, max, revision, label }`: against what, the margin, the risk, and the most pairs (or attempts, against history). For a paired baseline it also gives the commit the baseline ran at, with its short form. It is `null` when no good run was verified against a baseline.

### Each attempt

Each entry of a run's `runs`, and of `baselineRuns`:

| Field | Type | Meaning |
|---|---|---|
| `runId` | string | The attempt's run |
| `passed` | boolean | Whether it met the oracle |
| `verdict` | string | `passed`, `failed`, or `inconclusive` when all it fell short on is a check that could not be decided |
| `exitCode` | number | The agent's exit code |
| `failures` | array | Why it failed the oracle |
| `forkedAt` | number or null | Where the attempt forked; `null` when it replayed clean |
| `spent`, `upstreamRequests` | number | What its live model calls cost, and the requests it sent upstream |
| `footprint` | object | `{ inputTokens, outputTokens, cost }` |
| `cutShort` | boolean | `true` when the provider cut it short after the model answered |
| `unavailable` | boolean | `unavailable: true` on the attempt it stopped on, when the provider stayed unavailable |
| `unrecordedTools` | array | The tools its model called that its run never recorded, which ran for real in it |
| `afterFork` | object | What answered its tool calls from the fork on: `{ recorded, inOrder, live, stubbed, blocked }`; absent when it replayed clean |

A footprint is `{ inputTokens, outputTokens, cost }`, with `cost` null when a model has no price: the agent's model calls, never a judge check's.

## Limits

- **Replays run in today's environment.** A replay re-runs a run's recorded command, but in the environment verify runs in, not the one the run was recorded in. If what makes a run *that* run comes from an environment variable (which customer, which ticket), every run replays with today's value. Pass it as an argument instead, where the recorded command keeps it.
- **A tool's own code runs only with `--live-tool`**: a call whose arguments didn't change is served from the recording ([a fix inside a tool](#a-fix-inside-a-tool)).
- **A person's answers come in the order given.** After the fork no one is there to type, so each attempt gets a person's recorded answers in order, whatever the agent then asked. Where the change alters the conversation, they may not fit it. The report warns when an attempt got any ([reading the report](#reading-the-report)).
- **A short history knows little**: against 50 attempts, a run at 90% with no drop is kept 18.9% of the time ([against history](#against-history)).

## See also

- [Blame](./blame.md): find the model call that lost a run, before you write the fix.
- [`shadowlap repair`](./repair.md): runs this gate on every fix it considers, and keeps only one it accepts.
- [Gating](./gating.md): the gate's maths, its costs and a gate against history.
- [Outcome checks](./ci.md#outcome-checks): what `--expect` takes.
- [`shadowlap verify`](./cli.md#verify) in the CLI reference: every flag and exit status.
