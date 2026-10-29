# Verify

A fix that works on the run it was written for proves little: the model may have got lucky, the fix may only fit that one run, and it may break runs that worked. `shadowlap verify` checks all three before a change ships. It replays recorded runs under the code as it is now, as many times as it takes to decide where the replay forks, and accepts the change only when every failing run is fixed and every good run is kept: no worse than the same run under the code before the change by 10 points or more. Each is decided at a stated risk.

```sh
shadowlap verify --fixes 01M3RXQ4VB --holdout 01M3RXQ51B --keeps label:good \
  --expect '{"tools":{"issue_refund":{"count":0,"args":{"amount":240}}}}'
```

```
✗ Rejected: the change fixes 1 of 1 target run, 1 of 1 held-out run and keeps 0 of 1 good run
  · good run 01M3RXQ56V broken: 0 of 7 passed, baseline 7 of 7 · drop >= 0.03 (95%) (the agent exited with code 1)

  A run's attempts must meet the oracle: the agent exits 0; issue_refund with {"amount":240} called 0 times. Its gate decides after each attempt (gate: tells 90%+ from 70%- at <= 5% risk, up to 80 attempts); a clean replay settles it in one. A good run that forks is kept unless it drops 10+ points below its baseline at 370712a, attempt for attempt, <= 5% risk, up to 200 pairs.

    target    01M3RXQ4VB  fixed   12 of 12 passed · rate >= 0.73 (95%)                              forked at #1
    held-out  01M3RXQ51B  fixed   12 of 12 passed · rate >= 0.73 (95%)                              forked at #1
    good      01M3RXQ56V  broken  0 of 7 passed, baseline 7 of 7 · drop >= 0.03 (95%)               the agent exited with code 1

  per run, as it would run live: 4,182 → 5,713 input tokens (+37%)
  verifying: 38 attempts · 145 upstream requests · ≈$0 spent (no price for small-model) · code 370712a+dirty
```

Here a prompt change stopped the agent refunding $240 against policy, in the run it was written for and in one it was not. It also named a tool the agent doesn't have, and the good run, a $40 refund within policy, crashed on it. Its baseline, the same run at 370712a, the commit before the change, passed every one of its attempts, each forced live where the change forked: seven pairs in which the change failed and its baseline passed are enough to call the run broken. The exit status is 1, so the same command gates a merge.

## The runs

| Option | Role | Passes when |
|---|---|---|
| `--fixes <run...>` | **Targets**: failing runs the change was written to fix | enough attempts meet the oracle |
| `--holdout <run...>` | **Held-out**: failing runs of the same kind that the change was not written against | the same |
| `--keeps <run...>` | **Good** runs: runs that passed and must not get worse | it is not worse than its [own baseline](#good-runs-against-their-own-baseline) by the margin or more |

Each takes run ids or unique prefixes, and `label:<name>` for every run with that label, so `--keeps label:good` checks every run you have [labelled](./cli.md#label-note) good. A run has one role.

Held-out runs are what tell a fix from a patch that only fits its examples. A prompt edit written while reading two failed runs can mention what those runs had in common and nothing else. It will fix them and miss the next one. The report warns when there are none, and when there are no good runs, because then nothing was checked for regressions.

It also warns when a recording contradicts its role. A target that already passes as recorded proves nothing when fixed, and a "good" run that fails as recorded is not a good run. The recording is judged from what it holds: its exit status, and every check but those on the agent's output, which is not recorded.

## How a run is judged

**The oracle** is the same as [blame's](./blame.md#how-it-works): the agent exits 0, and meets `--expect`, the `expect` object of an [outcome check](./ci.md#outcome-checks). One oracle applies to every run, so a policy such as "never refund $240" is also checked on the good runs. Each attempt is a fork, so a [judge check](./judges.md) in `--expect` is asked live; one whose judge can't be (no key for its provider, and no upstream set for it) is refused before anything runs, since every attempt would read inconclusive and none could pass. An attempt that all the same fell short only on a check that could not be decided, such as a judge whose call failed or a condition the attempt gave no value for, is **inconclusive**, never a failure: it says nothing of the change, and no attempt after it would say more, so its run stops there, inconclusive, and the report says which check and why.

**Attempts.** Each run is replayed with its recorded command, under the code in the working directory. A replay forks at the first request the change affects, and everything after that runs live, so a forked run is a sample, and is replayed until it is decided: a target or held-out run by its [gate](./gating.md), a good run against [its own baseline](#good-runs-against-their-own-baseline). The gate tells a run that meets its oracle 90% of the time or more from one that meets it 70% or less, each verdict wrong at most 5% of the time at those two rates: after each attempt it passes the run, fails it, or takes another. Between the two rates either verdict can come (a run that passes 80% of the time is passed 37% of the time), so a run's line states its outcome, its tally and the bound of its pass rate, exact under the gate's stopping ([reading the evidence](./gating.md#reading-the-evidence)), and the report states the rule once, never a rate the run is claimed to pass at. A run that always passes is accepted after 12 attempts; one that always fails is rejected after 3; one still between the two after 80 is **inconclusive**, and the change is not accepted (a run that passes 90% of the time ends so 1.0% of the time). The 4 of 5 verify used before let a run that passes 70% of the time through about half the time; the gate lets it through 4% of the time. `--gate` changes the figures, such as `--gate '{"good":0.95,"bad":0.8}'`; `--attempts` and `--passes` give a fixed count instead (4 of 5 by default), which stops as soon as its verdict is settled. An attempt the agent failed while its provider was down, overloaded or rate limiting says nothing about the change ([gating](./gating.md#when-the-provider-is-unavailable)), on either side of a pair: when the provider failed before the model answered anything, the attempt is run again and never counted; when it cut the attempt short after, the attempt is counted against either verdict, a failure toward fixed or kept and a pass toward not fixed or broken, so neither rests on how it would have ended. When the provider stays unavailable too many attempts in a row (3 within the first 10 attempts, one more for each tenfold beyond: 4 to 100, 5 to 1,000), the run is **inconclusive**, never not fixed or broken, and verify stops there, *incomplete* with the provider named, exit 3.

**A replay that forks nowhere settles its run in one attempt.** Every call came from the recording, so every attempt would come out the same. A replay that made no model calls through Shadowlap, where the recording made some, is not one of them. The agent reached its model some other way, and what it did is unrecorded. The attempt fails and the report says why, because counting it would judge a run nobody saw. That makes verifying a harness fix free, since fixes to parsing, dispatch or stop conditions change no request. It also makes the good runs a change doesn't touch free.

**The change is tested as it will ship.** A changed system prompt changes every request, so every run forks at its first model call and runs live. That is what the change will do in production. [`--prompt-from`](./interventions.md#apply-a-changed-prompt-from-a-later-call) is cheaper, but it answers a different question ("what if the prompt had been this from step *k*"), so verify doesn't use it.

The change can also be a request field instead of code: `--model` and `--set key=value` apply from each run's first model call, to check whether a model switch fixes the failures and what it costs. When the runs hold other models' calls, a simulated user or a sub-agent on a smaller model, `--from <model>` keeps the change to the calls made with that model, from the first of them on: `shadowlap verify --keeps label:good --model claude-sonnet-5-5 --from claude-sonnet-4-5`.

**A fix inside a tool** needs `--live-tool <name>`. A tool call whose arguments didn't change is served from the recording, so without the flag the fixed code never runs. The report says so when it happens: *read_policy changed since the recording; pass --live-tool read_policy to run it live*.

## Good runs against their own baseline

A good run is no evidence on its own. One that passes 90% of the time unchanged fails a gate between 90% and 70% now and then, so a perfect change was rejected when there were several such runs, and one that slid from 99% to 84% under the change still passed the gate two times in three. So a good run that forks is compared with its own baseline, the same run under the code before the change, and **kept unless its pass rate drops by the margin or more** below the baseline's: 10 points by default (`--margin`, or `verify.margin` in `shadowlap.config.json`), at the gate's risk. A run that drops by the margin or more is kept at most 5% of the time, whatever its baseline's pass rate; one that doesn't drop at all is broken at most 5% of the time. A good run that replays clean is kept by its one free attempt, as before: the change doesn't touch it. A failing run is fixed as before, when it passes its gate on its own.

**The baseline** runs at HEAD when the working tree has a change, or at the commit `--base` names when the change is committed (`--base main`). For a change of request fields alone (`--model`, `--set`) on a working tree with no change, it is the working tree without them: for a model switch, the same run on the model it was recorded with. A commit is checked out on its own, in a temporary git worktree under `.shadowlap/verify/`, as [bisect](./cli.md#bisect) checks one out: the recorded command points into it, the working tree's installed packages serve it (this repository's own as they were at that commit), and `--build "npm run build"` builds it instead. It is removed when verify ends. The environment is today's for both, so a change made through an environment variable reaches the baseline too. Under [repair](./repair.md#candidates-are-tried-in-a-worktree-of-their-own), which verifies each candidate in a worktree of its own, the baseline is the code without the candidate: that worktree as it was before the candidate went in, copied into another and built the same way.

**Attempt for attempt.** Each attempt of the change is paired with one of the baseline, run straight after it and forced live at the call where the change forked, so both sample the run from the same point on, and whatever drifts over the run, the provider or its load, moves both alike. After each pair the test decides: a betting e-process on the pair's difference, the change's outcome minus its baseline's (Waudby-Smith and Ramdas, *Estimating means of bounded random variables by betting*, 2023). It keeps the run once the evidence that the drop is under the margin reaches 1/risk, 20 at 5%; it breaks it once the evidence of any drop does; with 200 pairs run and neither, the run is **inconclusive**, and the change is not accepted. Ville's inequality bounds each verdict's error by the risk at every look, with no fixed number of attempts, and for any pairs whose drop, given the pairs before, is at least the margin: arms that drift together, arms that are correlated, pass rates that change from pair to pair. The test reads the counts of pairs only, so its odds can be worked out exactly; over every such null at once, the worst it does is keep a dropped run 4.9% of the time, and break an undropped one 4.3%.

The exact odds of each verdict, and the attempts each arm runs on average, at the defaults (10 points, 5% risk, 200 pairs), for a baseline at a given pass rate and the change that much lower, its pairs independent:

| Baseline | No drop: kept · broken · attempts | 5 points | 10 points | 15 points | 25 points |
|---|---|---|---|---|---|
| 99% | 100% · 0% · 46 | 39.9% · 56.8% · 108 | 3.0% · 96.5% · 74 | 0.3% · 99.7% · 49 | 0% · 100% · 29 |
| 90% | 79.1% · 3.0% · 114 | 22.9% · 24.2% · 151 | 3.6% · 67.5% · 123 | 0.8% · 93.9% · 80 | 0.1% · 99.9% · 38 |
| 85% | 65.1% · 3.4% · 130 | 19.0% · 19.9% · 158 | 3.7% · 57.2% · 134 | 1.0% · 88.4% · 93 | 0.1% · 99.8% · 43 |
| 75% | 48.0% · 3.8% · 145 | 15.0% · 16.0% · 164 | 3.8% · 45.4% · 146 | 1.2% · 78.7% · 108 | 0.2% · 99.4% · 50 |

A drop of the margin or more is kept 3.8% of the time at most, as the table's last three columns show. The price is attempts: telling "no worse by 10 points" from "worse" takes many pairs when the run is noisy, so a run at 90% unchanged is kept four times in five within 200 pairs and left inconclusive most of the rest, one at 75% about half the time. Runs whose arms pass every attempt are kept after 38 pairs. The engine's tests hold these figures, by exact enumeration and by a seeded simulation that adds drift and correlated arms.

**The margin is the lever.** A wider one is cheaper, and still bounds what it lets through:

| `--margin` | Kept when every attempt passes, after | No drop from 90%: kept · attempts an arm | No drop from 99% |
|---|---|---|---|
| 0.05 | 78 pairs | 25.5% · 171 | 88.0% · 108 |
| 0.1, the default | 38 pairs | 79.1% · 114 | 100% · 46 |
| 0.2 | 18 pairs | 97.9% · 39 | 100% · 20 |
| 0.3 | 11 pairs | 99.0% · 20 | 100% · 12 |

A gate's `max` other than its default (`--gate '{"max":40}'`) caps a good run's pairs too, and `verify.max` sets them alone.

**The line** shows both tallies and a bound on the drop: `kept · 38 of 38 passed, baseline 38 of 38 · drop <= 0.10 (95%)`, or `broken · 0 of 7 passed, baseline 7 of 7 · drop >= 0.03 (95%)`. The bound holds whenever the test stopped, however it stopped (it inverts the same e-processes, a confidence sequence), so it is wider than an interval for a fixed count of attempts: seven pairs say the run dropped, and only a little about how far. Each end is rounded away from what it bounds, an upper end up and a lower one down, so the line never says more than was worked out. A run left inconclusive states both ends, `drop -0.04 to 0.18 (95%)`, each built at half the risk, so the two hold together at the 95% the line prints.

**Against history.** `--baseline history` (or `verify.baseline`) compares a good run with its golden's test history instead: the attempts of the golden's last sessions under the same recording and checks, in fork mode, each session by its first 5 attempts, as [a gate against history](./gating.md#a-gate-against-history) pools them. Only the change's arm runs. The history's pass rate is bounded at risk/2 (Clopper-Pearson), and the change's attempts are tested against that bound at risk/2, so a drop of the margin is kept at most 5% of the time, if the history's attempts are draws of the pass rate the baseline has now. A short history knows little: against 50 attempts, a run at 90% with no drop is kept 18.9% of the time within 200 attempts, one at 99% after 60 attempts on average. A run with no golden, or a golden with no history under these checks, is judged by its gate on its own.

**No baseline.** Where none can be had, a good run is judged by its gate on its own, as every run once was, and the report says so in a warning: the working directory is in no git repository, the working tree has no change against HEAD and no `--base` names the commit before it, or there is no history. `--attempts` and `--passes` judge every run by a fixed count on its own.

## Reading the report

| Part | Meaning |
|---|---|
| **Accepted / Rejected / Incomplete** | Accepted: every target and held-out run fixed, every good run kept. Rejected: any run failed, each listed with its first failure. Incomplete: nothing failed, but a run never settled (budget, Ctrl-C), its gate ended inconclusive, or an attempt of it could not be judged; the first line counts inconclusive runs apart |
| **The runs** | Each run's role, outcome (*fixed*, *not fixed*, *kept*, *broken*, *inconclusive* or *unsettled*), attempts passed (or *clean replay*; an attempt that could not be judged counted apart, `2 of 2 passed, attempt 3 not judged`) with the bound of its pass rate at the gate's confidence (`rate >= 0.73 (95%)`: the interval's low end for a run that passed, the high end for one that failed, both ends for one left inconclusive), and where it forked or why it failed. A good run kept against its baseline shows both tallies and the bound on its drop (`0 of 7 passed, baseline 7 of 7 · drop >= 0.03 (95%)`). The rules they were decided by are stated once, above them |
| **Warnings** | What the evidence lacks: no held-out or good runs, a good run judged on its own for want of a baseline, a recording that contradicts its role, a tool that changed without `--live-tool`, a connection that bypassed Shadowlap |
| **per run, as it would run live** | Input tokens and cost per run as recorded and under the change, as budget checks count them: every model request, whatever its origin. A prompt that grows shows up here |
| **verifying** | What the verification itself cost, and the code version it verified |

Every attempt is a run in the store, bundled per verified run in the dashboard's forks view. `shadowlap show` on an attempt says which role its recording played and whether it passed.

## Cost

A run that replays clean costs nothing. A forked target or held-out run costs up to the gate's `max` live suffixes (80), and usually far fewer: 12 for a fix that always works, 3 for one that never does. That is what it takes to tell a run that passes 90% of the time from one at 70% at 5% risk; [Gating](./gating.md#what-a-gate-costs) has the table. A forked good run costs two attempts a pair, its own and its baseline's, up to 200 pairs: 38 pairs when every attempt passes, 46 on average for a run at 99% that doesn't drop, 114 at 90%; one that drops 25 points is broken after 29 to 50. The [margin](#good-runs-against-their-own-baseline) is the lever.

| Option | Effect |
|---|---|
| `--budget <usd>` | Start no attempt once this much is spent on live model calls, though a pair that started runs its baseline's attempt too; the report is *incomplete* |
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
| `summary` | `{ targets, holdout, good }`, each `{ passed, inconclusive, total }`: an inconclusive run is counted apart, neither passed nor failed |
| `runs` | Per run: `runId`, `role` (`target`, `holdout`, `good`), `outcome` (`fixed`, `not-fixed`, `kept`, `broken`, `inconclusive`, `unsettled`), `passes`, `attempts`, the gate's `decision` (`pass`, `fail`, `inconclusive` or `continue`; `null` under a fixed count), its `rate` (the `decision`, the `interval` of the pass rate as `{ lo, hi, confidence }`, exact under the gate's stopping, and the `sentence`, the verdict line: `passed · 12 of 12 · rate >= 0.73 (95%) · gate: tells 90%+ from 70%- at <= 5% risk, up to 80 attempts`; `null` under a fixed count, or when an attempt that could not be judged stopped the run, as its gate decided nothing), `deterministic`, `recorded` (`{ passed, failures, footprint }`), `undecided` (why its last attempt could not be judged, which made it `inconclusive`; `null` otherwise), and `runs`, each attempt with `runId`, `passed`, its `verdict` (`passed`, `failed`, or `inconclusive` when all it fell short on is a check that could not be decided), `exitCode`, `failures`, `forkedAt`, `spent`, `upstreamRequests`, `footprint` and `unrecordedTools`, the tools its model called that its run never recorded, which ran for real in it. A good run kept against its [own baseline](#good-runs-against-their-own-baseline) also has `baseline` (`{ passes, attempts, source, revision }`: the baseline's tally, `paired` or `history`, and the commit it ran at, `null` for code that is no commit: the working tree, or under repair the code without the candidate), `margin` (the drop that breaks it, 0.1 for 10 points), `drop` (`{ lo, hi, confidence, method }`: the drop's confidence interval, valid whenever the test stopped: each end at `confidence` for a run kept or broken, and for one left undecided each at half the risk, the two together at `confidence`; `null` where nothing bounds it) and `baselineRuns`, each attempt of the baseline as `runs` lists the change's; its `rate` is then `{ decision, drop, sentence }`, the sentence its line and rule (`kept · 38 of 38 passed, baseline 38 of 38 · drop <= 0.10 (95%) · kept unless it drops 10+ points below its baseline at 370712a, attempt for attempt, <= 5% risk, up to 200 pairs`). A good run that forked with no baseline to compare with has `noBaseline`, why it was judged by its gate on its own. Every run has `unavailable`, its attempts and its baseline's the provider was unavailable for before the model answered, retried and never counted, and `cutShort`, those it cut short after the model answered, counted against either verdict, each with `cutShort: true` among the attempts; the attempt it stopped on, when the provider stayed unavailable, has `unavailable: true` |
| `gate` | The gate each run was decided by, `{ kind, good, bad, risk, max }`, or `null` when a fixed count (`--attempts`, `--passes`) decided |
| `kept` | The rule good runs were kept by, `{ source, margin, risk, max, revision, label }`: against what, the margin, the risk, the most pairs (or attempts, against history), and the commit a paired baseline ran at with its short form; `null` when no good run was verified against a baseline |
| `oracle`, `attemptsPerRun`, `passesNeeded`, `change`, `codeVersion` | What was checked, against what: with a gate, `attemptsPerRun` is its `max` and `passesNeeded` the fewest passes that can pass it (12) |
| `cost`, `stopReason` | What verifying cost, both arms' attempts in `attempts` (those the provider cut short among them, also counted in `cutShort`) and those the provider was unavailable for, retried and never counted, in `unavailable`; and why it stopped early, `provider unavailable: …` for a provider that stayed unavailable |
| `judge` | `{ spent, upstreamRequests }`: what [judge checks](./judges.md)' calls cost, apart from `cost`, which is the agent's alone; `null` when no judge was asked live. `--budget` counts both |
| `verifyId`, `fixes` | The verdict as it was kept (`vf-…`), and each fix it was kept with: `fixId`, `title`, `status` after it, `counts`, and `why` it doesn't count (`another-check`, `already-passing`, `no-runs`) |

A footprint is `{ inputTokens, outputTokens, cost }`, with `cost` null when a model has no price: the agent's model calls, never a judge check's.

[`shadowlap repair`](./repair.md) runs this gate on every fix it considers, and keeps only one it accepts.
