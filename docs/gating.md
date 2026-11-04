# Gating

A replay that forks is a sample: everything after the fork runs live, so a forked golden, a verify attempt or a blame probe can come out differently each time. A gate decides on such attempts as they come in, with the error rates it states, instead of a fixed count of passes. Read this page to gate a golden that forks, choose its figures, and read what it decided.

- [What a gate decides](#what-a-gate-decides)
- [Choose a gate](#choose-a-gate)
- [The sequential test](#the-sequential-test)
- [A gate against history](#a-gate-against-history)
- [Fixed counts](#fixed-counts)
- [One risk for the whole suite](#one-risk-for-the-whole-suite)
- [Inconclusive verdicts](#inconclusive-verdicts)
- [Young goldens](#young-goldens)
- [In CI](#in-ci)
- [Attempts are independent](#attempts-are-independent)
- [When the provider is unavailable](#when-the-provider-is-unavailable)
- [Reading the evidence](#reading-the-evidence)
- [Verify and blame](#verify-and-blame)
- [Reference](#reference)

## What a gate decides

A golden marked `fork` takes a `gate` under `tests` in `shadowlap.config.json`, in place of `repeat` and `passes`:

```json
{
  "tests": {
    "goldens/refund-*": {
      "fork": true,
      "gate": { "good": 0.9, "bad": 0.7, "risk": 0.05, "max": 80 },
      "expect": { "tools": { "issue_refund": 0, "escalate": ">= 1" } }
    }
  }
}
```

It reads: tell an agent that passes 90% of the time or more from one that passes 70% or less, each verdict wrong at most 5% of the time at those two rates, and give up after 80 attempts. Every figure is optional; `"gate": {}` is those four.

`shadowlap test` asks the gate after each attempt and stops as soon as it decides. Then it says how in one line: the verdict, the tally, the bound and the rule, with pass^k under it:

```text
✓ reference-agent: passed · 12 of 12 · rate >= 0.73 (95%) · gate: tells 90%+ from 70%- at <= 5% risk, up to 80 attempts
    pass^5 1.00 · forked at call 3, 8/28 replayed, 0 input tokens not re-spent, 1 check passed
```

```text
✗ reference-agent: failed · 0 of 3 · rate <= 0.71 (95%) · gate: tells 90%+ from 70%- at <= 5% risk, up to 80 attempts. Attempt 1: check failed: send_email called 0 times, but called 1 time (1 blocked)
    ✗ send_email called 0 times: called 1 time (1 blocked)
    0 of 3 passed · rate <= 0.71 (95%)
    attempt 1  ✗ check failed: send_email called 0 times, but called 1 time (1 blocked)
    attempt 2  ✗ check failed: send_email called 0 times, but called 1 time (1 blocked)
    attempt 3  ✗ check failed: send_email called 0 times, but called 1 time (1 blocked)
```

**A clean replay settles it in one attempt.** A replay that forks nowhere and runs nothing live served every call from the recording, so every attempt would come out the same. Its one attempt decides, and costs nothing.

**It can say *inconclusive*.** When `max` runs out between the bounds, neither verdict holds at the stated risk. That is an honest outcome of its own, shown in amber, not a coin toss:

`inconclusive · 64 of 80 · rate 0.67 to 0.91 (95%) · gate: tells 90%+ from 70%- at <= 5% risk, up to 80 attempts`

[Inconclusive verdicts](#inconclusive-verdicts) lists what else is inconclusive, and what CI does with it.

**A verdict states the test, never a rate.** The gate bounds its error only at its two rates. Between them, either verdict can come: an agent that passes 80% of the time is passed 37% of the time.

So *passed* says the gate told this agent from one at 70% or less, not that it passes 90% of the time. Every report shows the tally and the [bound](#reading-the-evidence) beside it, which say what the attempts themselves show.

## Choose a gate

Each gate answers its own question. Pick the one whose question is your requirement:

| Gate | Decides | When to use |
|---|---|---|
| [The sequential test](#the-sequential-test) | Whether the pass rate is `good` or more, or `bad` or less | A pass rate is the requirement |
| [A gate against history](#a-gate-against-history) | Whether the golden's pass rate dropped by `drop` or more from its own past | Each golden's own past is the standard |
| [A fixed count](#fixed-counts) | Whether `passes` of `repeat` attempts passed | Fewer attempts matter more than stated risks: a count can't tell agents apart |
| [`chaos.gate`](./error-paths.md#gating) | Whether the agent copes with an error-path preset, by the sequential test | `test --chaos`, in place of the golden's `repeat` and `passes` |

[`verify` and `blame`](#verify-and-blame) decide their runs and probes with the same engine.

### Choose the figures

- **Use the SPRT where a pass rate is the requirement.** `good` is the rate you need, `bad` the one you must never ship; the closer they are, the more attempts. `risk` 0.05 means a wrong pass at most 1 in 20 at `bad`; a wrong failure, its share of the suite's risk.
- **Use history where each golden's own past is the standard.** `{ "baseline": "history" }` costs 5 to 6 attempts for an unchanged agent, never needs figures of its own, and fails a collapse or a large drop. It catches a drop just past `drop` only sometimes, and needs its history kept, in CI too.
- **Set the suite's risk for the whole session,** not each gate's: `--suite-risk` or `tests.suiteRisk`. A lower one costs attempts only where the evidence is close; leave `max` out so the session can size it.
- **Read the cost before you commit to it.** The [forecast](#the-forecast) says it before every session. The odds on this page come from the engine's `gateOdds`, which gives them for any figures and any history ([reference](#engine-and-dashboard)).

## The sequential test

The gate is Wald's sequential probability ratio test (SPRT) between a pass rate of `good` (call it *p₁*) and one of `bad` (*p₀*). It keeps a score, starting at 0:

- each pass adds ln(*p₁* / *p₀*);
- each failure adds ln((1 − *p₁*) / (1 − *p₀*)), which is negative;
- it passes once the score reaches ln(1 / α), and fails once it falls to ln β;
- with `max` attempts run and the score between the two, it is inconclusive.

α, the risk of a wrong pass, is `risk`. β, the risk of a wrong failure, is `risk` too unless a session [splits its risk](#one-risk-for-the-whole-suite).

Its settings, under `gate`:

| Field  | What it sets                                          | Default |
|--------|-------------------------------------------------------|--------:|
| `good` | The pass rate you need, *p₁*                          |   `0.9` |
| `bad`  | The pass rate you must never ship, *p₀*               |   `0.7` |
| `risk` | The most each verdict may be wrong at those two rates |  `0.05` |
| `max`  | The attempts it runs before it ends inconclusive      |    `80` |

A session gives each gate a share of its [one risk](#one-risk-for-the-whole-suite), which can lower a failure's risk, `failRisk`, and raise `max` ([below](#how-a-gate-spends-its-share)).

### A worked example

With 0.9, 0.7 and 0.05, a pass adds ln(9/7) ≈ 0.2513, a failure adds ln(1/3) ≈ −1.0986, and the bounds are ±ln 20 ≈ ±2.996. So:

- an agent that passes every attempt is accepted after 12 (11 × 0.2513 is 2.764, still short of 2.996);
- one that fails every attempt is rejected after 3;
- each failure takes about 4.4 more passes to make up for: with one failure anywhere, it passes after 17 of 18; with two, it needs 21 passes.

That is more than 5 attempts, and it is what it takes to tell 70% from 90% with 5% risk. The knob is explicit instead of hidden.

### Why its bounds hold

The bounds keep the error rates where the gate says. The score is the logarithm of a likelihood ratio, which for an agent at `bad` stays 1 on average however many attempts run, and falls for one below it. So by Ville's inequality the score ever reaches ln(1 / α) at most α of the time, every look counted and whatever the limit.

For an agent at `good` or above, it falls to ln β at most β of the time. Stopping at `max` only moves some of those cases to inconclusive.

Wald's own bounds, ln((1 − β) / α) and ln(β / (1 − α)), ±ln 19 here, keep the errors only within α / (1 − β), 5.3% at these figures. Under them, a gate's exact error can go past its risk: one between 98% and 73% at 5% risk, up to 1,000 attempts, passed an agent at 73% 5.12% of the time.

In between the two rates, either verdict can happen ([What a gate costs](#what-a-gate-costs) gives the odds). That is why a verdict states the rule it was decided by, both rates in it, and never claims a rate for the agent.

The per-attempt decision is the SPRT's because it is built to be asked after every attempt. Checking a confidence interval after every attempt and stopping when it clears a bar ("peeking") inflates the error rate well past the one it claims. The bound in the reports describes where the gate stopped, and never decides anything.

### What a gate costs

The exact odds of each verdict, and the attempts run on average, for an agent that passes a given share of the time. Every way the gate can end is computed, not simulated:

| Pass rate | 4 of 5: passes | `max` 80, the default: passes · fails · inconclusive · attempts | `max` 20: passes · fails · inconclusive · attempts |
|---:|---:|---:|---:|
| 99% | 99.9% | 100.0% · 0.0% · 0.0% · 12.8 | 98.8% · 0.0% · 1.2% · 12.7 |
| 95% | 97.7% | 99.8% · 0.2% · 0.0% · 16.7 | 79.1% · 0.1% · 20.7% · 15.2 |
| 90% | 91.9% | 95.8% · 3.2% · 1.0% · 24.8 | 48.3% · 2.1% · 49.6% · 17.2 |
| 80% | 73.7% | 37.4% · 53.7% · 9.0% · 34.8 | 12.3% · 23.7% · 64.0% · 17.5 |
| 70% | 52.8% | 4.3% · 95.0% · 0.7% · 20.4 | 2.2% · 62.2% · 35.6% · 14.6 |
| 50% | 18.8% | 0.0% · 100.0% · 0.0% · 8.1 | 0.0% · 98.2% · 1.7% · 8.0 |

The limit only decides how often the close calls run out of room. An agent that always passes needs 12 attempts whatever the limit, and one that passes 95% of the time 16.7 on average at 80 (15.2 at 20, where a fifth of them run out). The attempts a higher limit adds are spent where the evidence is close, on agents between `good` and `bad`: up to 35 on average for one at 80%.

### What a CI run sees

Under `--inconclusive fail`, an inconclusive golden fails the run like a failed one, so the share of CI runs that go red for nothing counts both. That is the default for every golden but one gated against a short history whose sessions show no decline or drop ([young goldens](#young-goldens)).

With 100 forked goldens of an agent that passes 95% of the time, each golden fares like this:

| Gate | Goldens failed per run | Inconclusive per run | Attempts a golden |
|---|---:|---:|---:|
| 4 of 5 | 2.26 | 0 | 4.2 |
| A gate per golden at its own 5%, `max` 80 | 0.15 | 0.0027 | 16.7 |
| A gate per golden at its own 5%, `max` 40 | 0.15 | 0.78 | 16.6 |
| A gate per golden at its own 5%, `max` 20 | 0.14 | 20.7 | 15.2 |
| The default: 5% for the suite, split 100 ways | 0.00002 | under 0.0001 | 16.75 |

And each CI run like this:

| Gate | Runs red | Runs red under `--inconclusive warn` |
|---|---:|---:|
| 4 of 5 | 90% | 90% |
| A gate per golden at its own 5%, `max` 80 | 15% | 14% |
| A gate per golden at its own 5%, `max` 40 | 61% | 14% |
| A gate per golden at its own 5%, `max` 20 | 100% | 13% |
| The default: 5% for the suite, split 100 ways | 0.0018% | 0.0018% |

A gate per golden keeps each golden's risk, but a hundred of them add up: 0.15% of a healthy agent's goldens fail, and one in seven runs goes red. So `shadowlap test` gives the session [one risk](#one-risk-for-the-whole-suite) and splits it: a healthy suite then goes red about once in 55,000 runs, at 16.75 attempts a golden instead of 16.7.

The engine's seeded simulation of 300 such CI runs prints the same tables from coin flips, and its figures land within a few points of these.

## A gate against history

The gate that needs no figures of your own compares a golden with its own past:

```json
"gate": { "baseline": "history", "drop": 0.15, "risk": 0.05 }
```

It asks: has this golden's pass rate dropped by 15 points or more? `shadowlap test` already keeps every golden's result per session in the store's [test history](./ci.md#test-history), with how many attempts passed of how many. So pooling the last sessions' attempts gives a baseline that costs nothing.

It runs `min` attempts (5 by default), then decides after each one:

- the current pass rate and the baseline's are each a Beta posterior under a uniform prior: Beta(1 + passes, 1 + failures);
- it **fails** when P(*current* < *baseline* − `drop`) > 1 − `risk`, computed by integrating over the current rate: a drop of that size, 95% likely under the prior;
- it **passes** once that chance is 1/2 or less: no sign of a drop;
- in between, it runs another attempt, up to `max` (40 by default), where it is **inconclusive**: a drop likelier than not, short of the confidence to fail.

An agent whose attempts all pass, as an unchanged deterministic one does, passes after exactly its 5, and one that passes 95% of the time passes after 5 in about three sessions of four (all 5 passed), and after 5.7 attempts on average. Its odd failure is made up for by a few more passes. When its first attempts look like a drop, it takes the attempts that tell.

Its verdict line names the baseline after the tally and the bound:

`passed · 5 of 5 · rate >= 0.47 (95%) · against 0.94 over the last 10 sessions (47 of 50) · gate: fails a drop of 15+ points from its last 10 sessions once 95% likely, from 5 attempts up to 40`

`failed · 4 of 8 · rate <= 0.87 (95%) · against 0.94 over the last 10 sessions (47 of 50) · gate: …`

Its settings, under `gate`:

| Field      | What it sets                                                 | Default |
|------------|--------------------------------------------------------------|--------:|
| `baseline` | `"history"`: the golden's own past sessions are the baseline |       — |
| `drop`     | The drop in pass rate that fails it                          |  `0.15` |
| `risk`     | It fails once a drop of `drop` is 1 − `risk` likely          |  `0.05` |
| `min`      | The attempts it runs before it decides                       |     `5` |
| `max`      | The most attempts it runs                                    |    `40` |
| `window`   | How many past sessions make the baseline                     |    `10` |

A session gives each gate a share of its [one risk](#one-risk-for-the-whole-suite): a gate against history takes the share as its `risk`, and its `max` can be raised ([below](#a-gate-against-historys-share)).

### What it catches

It is asked after every attempt, and the odds below count every look. So an agent that passes as often as its history says is failed 0.2% of the time against 47 of 50, and at most 1.4% against a history that passes far less often (30 of 50), below the 5% the gate allows.

The chance it fails a golden, by its baseline and the golden's pass rate, with the chance it ends inconclusive in brackets. Against a history of 50 or 100 attempts:

| Pass rate | 47 of 50 | 95 of 100 | 50 of 50 |
|---:|---:|---:|---:|
| 95% | 0.1% | 0.3% | 0.5% |
| 85% | 4.6% (+1.5%) | 7.1% (+2.1%) | 13.0% (+5.1%) |
| 75% | 24.2% (+8.4%) | 32.1% (+7.0%) | 48.4% (+6.9%) |
| 60% | 73.7% (+3.5%) | 78.5% (+1.4%) | 87.6% (+0.5%) |
| 50% | 91.2% (+0.4%) | 92.3% (+0.1%) | 95.8% |
| 20% | 99.9% | 99.9% | 100.0% |

Against a short history, or none:

| Pass rate | 5 of 5 | None: its recording |
|---:|---:|---:|
| 95% | 0.0% | 0.0% |
| 85% | 0.3% (+0.5%) | 0.0% |
| 75% | 2.7% (+9.9%) | 0.0% |
| 60% | 20.3% (+35.7%) | 0.0% (+6.0%) |
| 50% | 49.6% (+28.4%) | 0.0% (+26.2%) |
| 20% | 99.3% | 5.1% (+87.9%) |

The attempts it takes on average:

| Baseline | Attempts at 95% | Attempts at 75% |
|---|---:|---:|
| 47 of 50 | 5.7 | 12.2 |
| 95 of 100 | 5.7 | 11.5 |
| 50 of 50 | 6.4 | 12.4 |
| 5 of 5 | 5.1 | 11.3 |
| None: its recording | 5.0 | 5.6 |

Read the tables for what they are:

- **It catches a collapse, and a large drop, cheaply.** Against 47 of 50, a golden at 60% fails three times in four, and one at 50% nine in ten. Deciding once at 5 attempts caught them 32% and 50% of the time, and 4 of 5, which fails a healthy agent 16 times as often, 66% and 81%.
- **A drop just past `drop` is caught only sometimes.** 75% against 94% is a 19-point drop, failed a quarter of the time. Telling 94% from 79% at 5% risk takes as many attempts as the [sequential test](#the-sequential-test) spends, and this gate spends them only when its first attempts look bad.
- **A short history knows little.** After one session of 5 attempts, its baseline could still be anywhere from about 60% up, so it fails a golden that has fallen to 50% only half the time, and one at 20% nearly always. The baseline firms up as the window fills.

Where a pass rate is a requirement, use the SPRT between the rate you need and the one you must never ship.

### Its first session

Its first session has no baseline, so it compares with the golden's recording: the one attempt it was packed from, which passed. It fails only a golden that fails nearly every attempt. But it can't pass one that passes much less often than that attempt suggests, and leaves it inconclusive instead: in its 40 attempts, one at 60% 6% of the time, and one at 50% a quarter of it.

With no history, that inconclusive only warns by default, and fails CI under `--inconclusive fail`. More attempts would not let it pass, so the session's plan gives it none.

Under `--inconclusive fail`, it says it has no baseline yet, and about how often it goes red ([its share](#a-gate-against-historys-share)), until it has sessions of its own; `test` says so under the golden's line. By default, the line of a golden that ends inconclusive says it needs more history.

### What makes the baseline

A golden's baseline is a standard to keep, so it takes only results that were one: the golden **passed**, in a session on the **baseline branch** that ran for **no pull request**, on a **committed revision**.

The history keeps and shows the others, but never pools them:

- a session that failed;
- a branch's, or a pull request's;
- one on uncommitted changes;
- one a signal stopped: its goldens' attempts run in turns, so those decided by then were the quickest to, a sample tilted towards the attempts that pass;
- a result kept before results said where their session ran, which can't show it was the baseline branch's: a golden's baseline starts again from its next session that passes there.

Of those that qualify, it pools the golden's last `window` sessions (10 by default) under the same recording, the same checks and the same mode. A recording re-packed or re-recorded starts its baseline over.

It pools each session by its first `min` attempts, the ones every session runs whatever they show. The gate stops a session as soon as it is sure, so one that ran on had a bad start; pooled whole, the sessions that passed overstated the agent. The window keeps an old baseline from hiding a slow decline, and the verdict line names it.

### The baseline branch

The baseline branch is the default branch:

| Where the session runs | The baseline branch                                                               |
|------------------------|-----------------------------------------------------------------------------------|
| GitHub Actions         | The repository's, from the event, or for a pull request the branch it merges into |
| GitLab CI, Buildkite   | From their own variables                                                          |
| Elsewhere              | git's `origin/HEAD`                                                               |

`"baselineBranch": "main"` under `tests` in the config names another. Where none can be told (no CI, and a clone without `origin/HEAD`), no session is a baseline, and `test` says how to name one. Every result keeps where its session ran in the history: its `branch`, `revision`, `pullRequest` and the `baselineBranch` it saw.

### Why a regression stays caught

Once a drop lands on the default branch, most of its sessions fail, and a failing session never joins the baseline. Later runs are judged against a baseline that stays mostly the agent before the drop, as only its sessions that pass by chance join it.

In a seeded simulation of 300 histories (in the engine's tests), each with a baseline of its own from 10 sessions at 95%, a drop to 60% was caught on the first run after it 77% of the time and on the tenth 69%. Both are worked out exactly against each history's baseline and averaged over them. When every session joined the baseline, it was caught as often on the first run, 29% on the fourth and 4% on the tenth, the regression having become the standard.

A pull request's sessions never count, however often its CI runs. A drop you mean to keep is a standard of its own: pack the golden again from a run of the agent as it is today, and its re-packed recording starts the baseline over.

### In CI, keep the history

A CI job's store goes with the job, and without history every session is a first one. The GitHub Action keeps the store between jobs in the Actions cache when a golden has a gate against history: its [`keep-history`](./ci.md#github-actions) input, `auto` by default.

- Each run restores its branch's newest copy, or the default branch's for a branch's first run.
- Each run saves its own, a run that failed included. A failed run's results are kept and never pooled.
- A pull request's runs read the default branch's sessions in the copy they restored.

On another CI system, cache `.shadowlap/shadowlap.db` (or the store `--db` names) between runs the same way. With GitHub Actions and the CLI alone:

```yaml
- uses: actions/cache/restore@v4
  with:
    path: .shadowlap/shadowlap.db
    key: shadowlap-history-${{ github.ref_name }}-${{ github.run_id }}
    restore-keys: |
      shadowlap-history-${{ github.ref_name }}-
      shadowlap-history-${{ github.event.repository.default_branch }}-
- run: shadowlap test 'goldens/*' --junit report.xml
- if: always()
  uses: actions/cache/save@v4
  with:
    path: .shadowlap/shadowlap.db
    key: shadowlap-history-${{ github.ref_name }}-${{ github.run_id }}
```

## Fixed counts

A golden with `repeat` and `passes` and no gate runs a fixed count: `repeat` attempts, of which `passes` must pass ([CI mode](./ci.md#outcome-checks)). `passes` keeps its meaning beside gates: such a golden runs exactly as before. Give a golden one or the other.

| Field    | What it sets         | Default     |
|----------|----------------------|-------------|
| `repeat` | The attempts it runs | —           |
| `passes` | How many must pass   | All of them |

`verify` and `blame` take a fixed count with `--attempts` and `--passes` ([below](#verify-and-blame)). A fixed count's bound is the [Clopper–Pearson interval](#other-bounds), and an attempt the provider cut short counts [against either verdict](#after-the-model-answered).

### Why a fixed count misleads

Fixed counts can't tell agents apart. These are exact binomial figures, not measurements:

| An agent that truly passes… | …clears 4 of 5 |
|---|---|
| 95% of the time | 97.7% of the time |
| 80% of the time | 73.7% of the time |
| 70% of the time | 52.8% of the time |

So 4 of 5 lets an agent that passes 70% of the time through about half the time. And it flakes on a healthy one: an agent that passes 95% of the time fails it 2.3% of the time, which across 100 forked goldens is about 2 spurious failures per CI run, and at least one in about 90% of runs.

A gate states both risks and keeps them, at the cost of the attempts that takes.

## One risk for the whole suite

A test session has one risk of going red for nothing, 5% by default: `--suite-risk 0.05` for one session, or `"suiteRisk": 0.05` under `tests` in the config. It is split evenly across the session's gated goldens, each with a share: with 100, 0.05% each.

The chance that any golden goes red is at most the sum of the chances that each does, whatever they have in common (one agent behind all of them). So shares that add up to the session's risk keep a healthy suite within it. That is Bonferroni's split.

Holm's step-down would let a golden use what others left unused. But its thresholds depend on every golden's evidence at once, and a gate decides as its own attempts come in, before the goldens after it have run. A healthy suite's goldens end far from their failing bounds, where the two split alike.

### How a gate spends its share

A golden goes red for nothing in two ways, both at its gate's `good` rate:

- failing there;
- running out of attempts there, unless `--inconclusive warn`.

By default, a gate against history with fewer than 30 sessions goes red only by failing, as its inconclusive only warns, until the plan reads a decline or a drop in its sessions ([young goldens](#young-goldens)). It still runs the attempts that would settle it.

Its share pays for both:

- **An SPRT gate keeps its `risk` for a pass**, the safety side, and takes a lower risk for a failure, `failRisk`: the largest, at two significant digits, whose exact chance of going red at `good`, every look counted, fits the share. With 100 goldens of `"gate": {}`, that is 0.047%: the gate fails only after about 7 straight failures, where it took 3.
- **Its `max` grows to fit**, unless the config sets one: the fewest attempts, 80 or more, that leave at most 1% of attempts at `good` inconclusive, or, unless `--inconclusive warn`, half the share when that is less. With 100 goldens, 179.
- **A better agent goes red less often still**: a gate passes no less often for an agent that passes more often. With every golden at 90%, the worst a healthy suite can be, the default suite goes red 4.8% of the time when its goldens are independent, and at most 4.95% whatever they share; at 95%, 0.0018%.
- **A single golden keeps the default gate whole**: the default gate, at 3.2% failed and 1.0% inconclusive at its `good` rate, already fits the whole 5%.

**A `max` the config sets is kept.** When it leaves more attempts at `good` inconclusive than the share allows, the session counts the gate's real chance of going red in the suite's. Once the goldens' chances add up past the risk, the session says so before it runs, and states that chance instead of the risk it was given:

`but 1 golden can't keep within its share, so a healthy suite goes red for nothing in …% of runs or fewer, with the provider answering`

It says so here and in the Markdown summary, with `over` in `--json`.

The verdict line names the risks it ran with, `gate: tells 90%+ from 70%- at <= 5% risk to pass and <= 0.047% to fail, up to 179 attempts`, and `--json` gives each result's `failRisk` and the session's `suite`.

### What the split costs

Under the split, the score a gate passes at stays at ln 20, ln(1 / α), whatever β, so an agent that always passes still needs 12 attempts, and one at 95% takes 16.75 on average instead of 16.7.

A golden whose agent is at `bad`, 70%, still goes red 96% of the time, after 49.5 attempts on average instead of 20; one at 80% after 83.5. An agent that slips to 80% on every golden turns every run red.

### A gate against history's share

A gate against history takes the share as its `risk`, so it fails once a drop is that much likelier.

No one pass rate will do to work out how often it goes red. A baseline that came out lucky makes an agent that is as it was look dropped, and a short one comes out lucky often. So its chance of going red is worked out exactly over every rate the golden's record leaves open, each weighed by how likely the record makes it.

The record is every attempt of its last 30 sessions, three of its windows, those that went red too, which its baseline leaves out. It holds one failure more, so a short record errs towards the low rates it leaves open.

Its `max` is raised from its own, as far as 400, until few enough attempts end undecided and that chance fits the share.

**Past 40, a pass is held to the record too.** 40 is the most attempts a gate against history runs by default. Past it, a pass also needs its attempts to make a drop of `drop` from that record at most the gate's own `risk` likely. That holds however its max came past 40: the plan's, the config's, `--max-attempts` or Run more attempts.

The attempts past 40 are for an agent as its record shows it, whose baseline came out lucky. One that dropped sits below its record by the drop, so it all but never passes on them by luck. Take a gate continued past an inconclusive 40 against 48 of 50, at a 0.25% share. There, an agent at 75% passed 12.8% of the time by 80 and 17.9% by 160 under the plain rule, and held to the 20 sessions before its drop (107 of 112), 0.00% and 0.02%.

Its rule says so once its max is past 40:

`gate: fails a drop of 15+ points from its last 10 sessions once 99.75% likely, from 5 attempts up to 255, and past 40 passes only once that drop from every attempt of its last 30 sessions (150 of 170) is 5% likely or less`

**When its max stays its own.** A gate against history gets no more than its own max with no baseline yet. Nor does it once its last 10 sessions sit below the sessions of its record before them, 4 to 1 likely, every attempt of each against every attempt of the others. A pass past 40 is then held to those earlier sessions.

**When the plan reads a drop.** Below them beyond chance at its share, the plan reads a drop, works its chance out for the agent before it, and names the golden whatever the suite's line says:

`its last 10 sessions passed 40 of 56 attempts, below the 20 sessions before them, 105 of 112, beyond chance at its 0.25% share: a drop; it runs as its baseline asks, at its share, up to its 40 attempts`

Like with like: two tallies of one agent, its last 10 sessions' 56 attempts against the 112 before them, read as a drop 0.22% to 0.28% of the time at a 0.25% share, at 50% to 95%. Read against its baseline instead, which takes only the first attempts of the sessions that passed, a healthy agent that fails often looked dropped well past its share.

### How well its share holds

The engine's seeded loops plan, decide and pool each session as `shadowlap test` does, from a golden's first. In them, 20 goldens whose agent drops after 30 sessions are caught as often as by a gate held at their share with max 40 against the same baselines, never more than 0.02 of a point less:

- from 95% to 75%: 33.8% in the first session after it and 12.9% in the tenth, as against 33.8% and 12.9%;
- from 90% to 70%: 34.6% in the first session after it and 14.2% in the tenth, as against 34.6% and 14.2%;
- from 95% to 60%: 76.6% in the first session after it and 68.4% in the tenth, as against 76.6% and 68.4%.

In the same loops for a healthy agent, where the plan says a golden of 20 keeps within its 0.25% share, it goes red at most 0.2% of the time on average over a stage of its sessions, at 80% down to 50%. That holds on average over the sessions it says so for, not in each. But with every inconclusive counted, up to about one in ten of the sessions it says so for, one in twenty at 90%, against a baseline that came out lucky, go red more often than the share.

Where the plan says a golden can't keep within its share, it says about as often as it goes red, or more.

The suite's line states the plan's chance, about, instead of the risk it was given, only when its goldens' chances add up to more than the risk. It then names those that can't keep within their share, or have too few sessions yet to, and why. One over its own share in a suite that keeps within its risk takes room the others leave, and isn't named.

So, with every inconclusive counted, a healthy suite of 20 goldens at 80% states a chance past its 5% in about one session in four from the 21st to the 40th. It goes red for nothing more often than that in fewer than one in ten.

A baseline knows only what its attempts show: 50 of them sometimes overstate an agent by the whole drop. Against such a baseline the gate can neither pass the agent nor fail it at a small share, so it ends inconclusive, which no `max` settles. With many goldens of an agent that passes less often, that alone can go past the share, and the plan says so; a longer `window` gives the baseline the attempts to settle it.

### The forecast

Before any golden runs, the session says what it will cost. For 100 gated goldens of an agent that passes 95% of the time, at $0.025 an attempt:

```text
forecast: about 1,675 attempts (16.7 a golden on average), up to 17,900 · about $41.87
suite risk 5%: 100 gated goldens, 0.05% each, so a healthy suite goes red for nothing in 5% of runs or fewer, with the provider answering
```

The attempts are each gate's exact average at a pass rate, and up to the most every gate can run:

- **An SPRT gate:** at the pass rate its golden's last 10 results show, or at its `good` rate when it has none.
- **A gate against history:** averaged over the pass rates its last 10 sessions leave open, one failure more, as its chance of going red is. And with none, over those its recording leaves open, about 19 attempts where an agent at 95% takes 5 and one at 50% 16.

The cost is those attempts times the cost of an attempt: what the golden's last results spent per attempt, else what its recording's model calls cost. That is what an attempt that forks at its first call would spend. A model with no price leaves the cost out, and says so.

## Inconclusive verdicts

An inconclusive verdict is an honest outcome of its own: neither verdict holds at the stated risk. A golden is inconclusive when:

- its gate's `max` ran out between the bounds;
- its only failed checks couldn't be judged;
- its provider stayed [unavailable](#when-the-provider-is-unavailable) too many attempts in a row.

### What CI does with one

`--inconclusive fail|warn` decides what CI does with an inconclusive verdict, a gate's or a check's:

| `--inconclusive` | What it does |
|---|---|
| Neither given | Fails the run, except a [young golden's](#young-goldens) gate against history, which only warns when it runs out of attempts |
| `fail` | Fails the run on every inconclusive |
| `warn` | Lets each through: the exit status passes, the JUnit report marks the case skipped, and `--annotations` gives it a warning instead of an error |

Every report still says it is inconclusive.

### Settle one with more attempts

`--max-attempts <n>` raises every gate's `max` for one session, to settle an inconclusive golden without changing the config.

`--continue` carries an inconclusive gate's attempts over from the golden's last result, so a session with a raised limit runs only the attempts still needed:

```sh
shadowlap test goldens/refund-flow --max-attempts 160 --continue
```

It continues only when the golden's recording, checks and gate are unchanged, and it ran on the same branch.

- **It decides exactly as a gate with the higher limit from the start.** Whatever it decided before the old limit, it decided the same way, and every tally left between the bounds there goes on from where it stood.
- **A settled verdict is never continued**, since asking again after a gate has stopped would be peeking.
- **The verdict line's tally says what it carried** (`… of 86 (80 carried over)`), and its bound is the one that holds however attempts stopped.
- **The test history keeps each session's own attempts**, so a gate against history pools each attempt once.

The dashboard's Tests data offers this as Run more attempts, to twice the limit, with the attempts it adds on average.

## Young goldens

A golden gated against its own history needs sessions to tell a drop from chance. It counts the sessions its baseline could take, whatever they came to, and needs 30: three of its `window`s. Where no baseline branch is known, it counts none.

A golden with fewer than 30 sessions is young. With no `--inconclusive` given:

- **Running out of attempts only warns**, as so few sessions can't tell a drop from chance at a suite's share. Its line says so: `needs more history: 3 of 30 sessions`.
- **It still runs the attempts `--inconclusive fail` would**, to settle what it can. So the sessions it passes keep its baseline learning, its sessions from the 31st on run as they would have, and its plan counts its failures alone.
- **A clear failure still fails.**
- **So does an inconclusive once the plan reads a decline or a drop**: the golden's last sessions below the ones before them, 99 to 1 likely or more. A decline, or a drop, is no shortage of history, and more history would not explain it away.

When it counts, its line says why:

`counts though it has only 15 of 30 sessions: its last 10 sessions sit below the 5 before them, 44 of 57 attempts against 30 of 31, 99 to 1 likely or more: a decline`

Until the plan reads one, a drop in a golden's first 30 sessions that its gate can't tell from chance only warns. One after them is caught as [a mature golden's is](#how-well-its-share-holds).

Until its record holds 30 sessions, a golden that can't keep within its share says it has too few sessions yet, and that a gate on two fixed rates, `"good"` and `"bad"`, needs no history at all.

With no sessions, all it has is its recording: one attempt that passed, which leaves most rates open. So with every inconclusive counted, an agent at 50% goes red 26% of the time in its first session, where the plan says about 37%, nearly all of it inconclusive.

### How often a young golden goes red

The engine's seeded loops ([above](#how-well-its-share-holds)) show what the rule costs a healthy suite, and what it lets through after a drop.

In the same loops, over 400 histories each, a healthy suite of 20 goldens at 80% goes red for nothing in this share of its sessions:

| Red for nothing | From the 2nd session to the 10th | From the 11th to the 20th |
|---|---:|---:|
| By default | 0.5% | 0.8% |
| With every inconclusive counted, as `--inconclusive fail` counts it | 16.1% | 5.6% |

When the agent behind 20 goldens drops after their 15th session, the 10 sessions after it come out like this, over 400 histories:

| Of the 10 sessions after the drop | 95% to 75% | 90% to 70% | 95% to 60% |
|---|---:|---:|---:|
| Red by default | 12% | 14% | 69% |
| Red under `--inconclusive fail` | 22% | 23% | 73% |
| Warned | 10% | 9% | 5% |
| Passed | 78% | 77% | 27% |

A young golden's green is weaker evidence of no drop than a mature one's: after the drop from 95% to 75%, a golden with 15 sessions stays green in 88% of the 10 sessions after it, one with 30 in 78%.

## In CI

One step runs every golden, with a JUnit report, a job summary and annotations:

```yaml
- run: shadowlap test 'goldens/*' --junit report.xml --markdown "$GITHUB_STEP_SUMMARY" --annotations
```

An inconclusive golden fails this step, as a failed one does, unless it is a [young golden](#young-goldens) whose gate ran out of attempts, and the plan reads no decline or drop in its sessions. The session's [one risk](#one-risk-for-the-whole-suite) counts both: a healthy suite goes red for nothing within that risk as the suite's line states it, with the provider answering.

To let inconclusive goldens through with a warning instead, add `--inconclusive warn`; the risk is then spent on failures alone. The GitHub Action has the same choices ([inputs and outputs](./ci.md#github-actions)):

| Input or output       | What it does                    |
|-----------------------|---------------------------------|
| `inconclusive` input  | As `--inconclusive`             |
| `max-attempts` input  | As `--max-attempts`             |
| `inconclusive` output | Counts the inconclusive goldens |

The Markdown summary counts inconclusive goldens apart (`### Shadowlap: 1 of 12 recordings is inconclusive`) and marks them 🟡. It says what CI did with them and what to do:

- the `--inconclusive` given, or with none, the default;
- for each gate against a short history, whether it only warned or counted, and why;
- with several gated goldens, the session's risk and each one's share.

The JSON report has `inconclusive` beside `passed` and `failed`, each result's `verdict`, whatever CI did with it, and the session's `suite`.

Fix on failure opens no fix for an inconclusive golden: more attempts settle it, not a change to the agent. `bisect` skips a commit whose verdict is inconclusive, as it skips one it can't build.

## Attempts are independent

Every figure a gate states takes its attempts to be independent draws of the agent's pass rate: an attempt's outcome owes nothing to the attempts before it. That covers the risks on its verdict line, its bound and its share of the suite's risk.

The split across goldens doesn't need the goldens to be independent of each other: it holds whatever they share. But each gate needs its own attempts to be. A replay forks the recording afresh each time, so the agent's side holds unless the agent keeps state from run to run (a cache it fills, a file it leaves behind).

What the attempts run against need not be independent: a provider slow for a minute, a rate limit that comes and goes, a shared service that fails a few calls in a row. An attempt the provider was unavailable for is told apart, and no verdict rests on how it would have ended ([below](#when-the-provider-is-unavailable)). But a burst can fail attempts in other ways, and one that lands on one golden's attempts in a row fails a healthy golden.

So `shadowlap test` runs its goldens' attempts in turns:

- one attempt at a time, each golden's next behind the other goldens still open;
- the first attempt of each, then the second of each still undecided, and so on;
- once every golden's replays have ended, it takes their results in order.

A golden whose replay is clean is decided in the first round. A burst then lands on many goldens once or twice each, not on one golden's run of attempts.

In a seeded simulation in the CLI's tests, 100 goldens whose failures come in bursts go red this share of the time, against the suite's 5%:

| Agent passes | After a failure, the next attempt fails | Red, one golden after another | Red, in turns |
|---|---|---:|---:|
| 95% of its attempts | Half the time | 38.1% | 0.0% |
| 90% | 30% of the time | 46.4% | 5.2% |

Turns can't undo a dependence of the agent on its own past: keep the agent's runs from sharing state.

## When the provider is unavailable

A provider that is down, overloaded or rate limiting says nothing about the agent, and no verdict rests on how an attempt it broke would have ended. An attempt is *unavailable* when the agent failed while one of its live model calls ended:

- on HTTP 408, 409, 429 or any 5xx (529 "overloaded" included);
- on a connection that failed;
- on a stream cut short;
- on an answer that could not be passed on to the agent.

Where the provider failed decides how the attempt counts.

### Before the model answered

When the model had answered nothing yet in the attempt, nothing of the attempt's own course had happened, so the error can't depend on how it would have gone. The attempt is run again and never counted, and its line says so:

`the provider was unavailable (HTTP 529 from anthropic at call #3), so that attempt isn't counted`

The attempts a gate counts are then the ones it would have had with no error at all.

### After the model answered

Part way through, the error may come with the course the attempt took, as for an agent that loops until it is rate limited. Leaving such attempts out leaves failing ones out. Retried and left out, failures that came with a provider error one time in ten, five or three passed an agent at 70% 7.2%, 12.1% and 20.3% of the time under the default gate, whose own risk there is 4.3%.

So a gate counts the attempt against either verdict, in two views: a pass must hold with it counted as a failure, and a failure with it counted as a pass. With neither, the gate runs another attempt. Each view is the gate's own test of every attempt it counts, so each keeps the gate's risk however the provider's errors fall, and that agent passes at most 4.5% of the time.

Its line says so, `the provider cut that attempt short (…), so it is counted against either verdict`, and so does the verdict line, beside the tally:

`passed · 17 of 18 (1 cut short by the provider, counted against either verdict) · rate >= … (95%) · gate: …`

Its bound is a confidence sequence on each view. It costs a pass what a failure does, about 4.4 more passes under the default gate.

Its `max` counts only the attempts the provider didn't cut short, so one from time to time uses up none of it. A gate whose attempts, those cut short among them, reach twice its `max` ends inconclusive. The errors in a row that stop a session are counted across it ([below](#errors-in-a-row)).

Suppose the provider cuts short 5% of the attempts of a 100-golden suite at 95%. A gate whose `max` counted them, stopped by three in a row of its own, was left inconclusive 0.32% of the time, 27% of sessions, nearly all of it three in a row. Counted as above, at most 0.9% of sessions are.

A fixed count (`repeat`, `--attempts`) counts a cut-short attempt the same way:

- it passes once enough passed with each cut-short attempt counted as a failure;
- it fails once, even counted as passes, they can't make the count;
- otherwise it is inconclusive once its attempts have run: `inconclusive: 2 of 3 attempts passed, 1 of them cut short by the provider, 3 needed`.

Run again instead, failures cut short three times in ten let 4 of 5 pass an agent at 70% 67.3% of the time where it passes 52.8%; counted this way, it passes 52.8% however many the provider cuts short.

### Waits and counts

After either kind, the next attempt waits what the provider's `retry-after-ms` or `retry-after` asked for, at most a minute. Without one, it waits 5 s, then 15 s, a fifth either way at random.

`--json` counts those never counted as `unavailable` and those counted as `cutShort`, and the gate's `unavailableAt` says which of its outcomes they are. A baseline from the [test history](#a-gate-against-history) leaves both out.

### Errors in a row

Enough unavailable attempts in a row, of either kind, stop the session. They are counted across its goldens, whichever ran them: 3 for a session of one golden, and one more for each tenfold of goldens (4 from 2, 5 from 11, 6 from 101).

The golden that met the last is inconclusive, with the provider named. So is every golden still to run, its line saying the session stopped. Never failed:

`provider unavailable: 3 attempts in a row ended on HTTP 529 from anthropic at call #3, so none of them says anything about the agent; run it again once the provider answers`

A provider that errs occasionally, and independently, errs k in a row somewhere among N attempts about N·eᵏ of the time. So a fixed 3 stopped most large sessions for nothing. A session of 100 stops at 5 in a row. Sessions of 100 goldens at 95% come out like this, worked out exactly in the engine's tests:

| Early error rate | A fixed 3: sessions that exited 3 | 5 in a row: sessions stopped |
|---:|---:|---:|
| 2% | 1.3% | 0.0006% |
| 5% | 19% | 0.053% |
| 10% | 81% | 1.7% |

A provider that is down stops a session of 100 after five attempts and their pauses, which every golden waits out in turn. The suite's line says its risk holds *with the provider answering*: a provider that is down leaves goldens inconclusive whatever the plan says.

### What counts as the provider's

What is read is each call's final answer. A call its SDK retried until it succeeded is fine, and an attempt that passed after a call failed is a pass, its agent having coped.

The agent's own clock is not the provider's. These count as the agent's:

- a call the agent hung up on (its client's timeout, or an abort);
- an attempt the test's time limit stopped;
- failures Shadowlap plays in on purpose (`--fail-at`, `test --chaos`);
- the calls it refuses itself (offline, a placeholder key);
- a judge check's calls, which the judge retries by itself;
- a replay no preload loaded in, which the [guard](./how-it-works.md#the-network-guard) fails.

### Verify, blame and the other commands

[`verify`](./verify.md) and [`blame`](./blame.md) handle their attempts the same way. Enough in a row leave a verified run inconclusive, never not fixed or broken. They stop a blame, which names the provider and exits 3, never calling the run rescued, lost or unrescuable. [`repair`](./repair.md) stops with them.

Enough is 3 within a run's first 10 attempts, and one more for each tenfold beyond (4 to 100, 5 to 1,000), as a session's grows with its goldens. That holds for verify, blame, repair, migrate and injection alike. A fixed 3 stopped long runs for nothing far more often:

| Error rate | Attempts in the run | A fixed 3 stopped | This count stops |
|---:|---:|---:|---:|
| 5% | 300 | 3.5% | 0.16% |
| 5% | 600 | 6.9% | 0.17% |
| 10% | 300 | 24% | 1.7% |
| 10% | 600 | 42% | 2.0% |

A good run's pairs are tallied twice over. An attempt cut short counts against keeping in one tally: the change's as a failure, with no baseline attempt run beside it, the baseline's as a pass. It counts against breaking in the other. Kept must hold on the first, broken on the second.

At the drop that breaks it, errors on a fifth of the change's failing attempts kept a run 12.5% of the time when they were retried away, and at most 3.2% tallied twice over.

`test --chaos` reads its attempts the same way: a real provider error, beyond the one a preset plays in, is the provider's, never a failure of the agent's error path. Errors in a row are counted across the session's presets, as `test` counts them across its goldens. The preset that met the last is inconclusive, and every one after it too. Counted within each preset, they stopped sessions far more often:

| Error rate | Presets of 20 attempts | 3 in a row within each preset | Counted across the session |
|---:|---:|---:|---:|
| 5% | 50 | 10% | 0.030% |
| 5% | 100 | 19% | 0.060% |
| 10% | 50 | 56% | 0.90% |
| 10% | 100 | 80% | 1.8% |

An attempt of [`injection`](./injection.md) that obeyed a planted instruction keeps its proof when the provider fails after it.

## Reading the evidence

Every report says a verdict in one line, wherever it appears: the terminal, `--json`'s `sentence`, JUnit, the Markdown summary and the pull request comment, and the dashboard. The line holds the verdict word, the tally, the bound and the rule, stated once:

`passed · 12 of 12 · rate >= 0.73 (95%) · gate: tells 90%+ from 70%- at <= 5% risk, up to 80 attempts`

A report that lists many runs under one gate states the rule once above them. It never says "passes at least 90% of the time": that is what the gate tells apart, not what it found.

### The tally and the bound

`12 of 12 · rate >= 0.73 (95%)` is the attempts, and one end of the pass rate's interval at 1 − risk:

| Verdict      | The bound shows | For example         |
|--------------|-----------------|---------------------|
| Passed       | The low end     | `rate >= 0.73`      |
| Failed       | The high end    | `rate <= 0.71`      |
| Inconclusive | Both ends       | `rate 0.67 to 0.91` |

**What it guarantees.** Over every way the gate can end, the end it shows is wrong at most 1 − confidence of the time, whatever the agent's true pass rate. Each end alone is wrong at most half that, so the guarantee holds whichever end a verdict picks.

The engine's tests prove it exactly, every stop the gate can make summed with its chance, at every rate where the coverage can be lowest. A printed end is a whole hundredth, so each hundredth is approached from both sides, where the ends that stop holding there have stopped. The rates between are read every thousandth.

| Gate | The worst the printed bound does |
|---|---:|
| The default gate | 95.7% |
| A gate split 100 ways | 95.6% |
| The gate against history, against 47 of 50 | 97.5% |
| A blame probe's at the share of 8 probes, whose bound is at 99.3% | 99.6% |

**How it is worked out.** Exactly, under the gate's own stopping rule. Every stop the gate can make is ranked, Siegmund's stagewise ordering:

- a pass ranks higher the sooner it came;
- a failure ranks lower the sooner it came;
- stops after the same attempt rank by their passes.

The low end is the lowest rate at which stopping as high as the gate did, or higher, has more than a 2.5% chance. The high end is the highest rate at which stopping as low or lower has. 12 of 12 is the highest stop of all, reached only by 12 straight passes, so its low end is the rate whose twelfth power is 2.5%: 0.735. Ends print rounded away from the rate they bound, so a printed bound never says more than was worked out.

**What it doesn't say:** how often a verdict of one kind is wrong. Among the runs that passed an agent at 70%, the few lucky ones, the low end is above 70% about a third of the time (32%): every run of 12 straight passes. Those passes happen 4.3% of the time, so they put the bound wrong 1.4% of the time, within the 5%.

**Why not the Wilson interval** reports showed before. Computed from the tally as if its count had been fixed, it misses the true rate whenever the gate stopped early on a run of passes, as often as 17% of the time under the default gate. After a pass at 75%, its `rate >= 0.76` was wrong 23% of the time.

### Other bounds

A replay that forked nowhere shows no bound: it is the same every time.

A gate shows a confidence sequence instead when it was:

- cut short (a signal, a budget);
- continued from another session;
- left with the provider unavailable too often;
- given attempts the provider cut short: one sequence for each view, each at half the doubt.

A confidence sequence is the rates whose likelihood, mixed over a uniform prior, is above 1 − confidence. It covers the true rate at every attempt at once, so it holds however the attempts stopped, and is wider (12 of 12 reads `rate >= 0.62`).

A fixed count (`--attempts`, `repeat`) has the Clopper–Pearson interval, which holds for a count stopped as soon as it is settled too.

In `--json`, each result's `bound` says which: `{ "lo": 0.73535, "confidence": 0.95, "method": "stagewise" }`, with `method` `stagewise`, `confidence-sequence` or `clopper-pearson`. Its `interval` has both ends.

### pass^k

pass^k is the chance an agent passes all of *k* tries, which matters more than one success for an agent that runs unattended. With *c* passes in *n* attempts it is estimated as C(*c*, *k*) / C(*n*, *k*), the τ-bench estimator: 18 of 20 gives pass^5 = 8,568 / 15,504 ≈ 0.55, where 0.9⁵ would overstate it at 0.59. The line shows pass^5; the JSON has *k* from 1 to 8.

It is the tally's own estimate, with no confidence of its own, and a gate that stopped on a run of passes flatters it: 12 of 12 reads pass^5 1.00 whatever the agent's rate. What the attempts guarantee is the bound to the *k*th power: `rate >= 0.73 (95%)` means pass^5 is at least 0.73⁵ = 0.207, at the same confidence.

### The evidence path

Each result keeps each attempt's outcome in order, and how the gate moved:

- **An SPRT gate:** the score after each attempt, between its two bounds, so why it stopped at 12 attempts takes one glance.
- **A history gate:** the baseline it pooled, and the chance of a drop after each attempt from `min` on, between the 1/2 it passes at and the 1 − risk it fails above.

The `--json` report keeps them under each result's `gate` ([fields](./cli.md#test)), and so does the store, for the dashboard's Tests screen.

## Verify and blame

The same engine decides `verify`'s runs and `blame`'s probes. Each run's and each probe's tally, its bound and the risk it was decided at are in their reports, their `--json` and the store.

### A failing run

[`verify`](./verify.md) decides each failing run that forks, a target or a held-out one, with the default gate: 0.9, 0.7, 0.05 and 80.

| Verdict        | Means                                                                                             |
|----------------|---------------------------------------------------------------------------------------------------|
| *fixed*        | The gate passed the run, telling it from one that meets its oracle 70% of the time or less        |
| *not fixed*    | The gate failed it, telling it from one at 90% or more                                            |
| *inconclusive* | The run is still between the bounds after 80 attempts, which keeps the change from being accepted |

Its line shows its tally and bound (`fixed · 12 of 12 · rate >= 0.73 (95%)`), under the rule stated once. A run that passes 90% of the time ends inconclusive 1.0% of the time at 80 attempts, where 40 left it so 12%.

### A good run

A good run that forks is decided against [its own baseline](./verify.md#good-runs-against-their-own-baseline) instead: the same run under the code before the change, each of its attempts paired with one of the baseline's. With `--baseline history`, the baseline is its golden's test history.

- It is *kept* unless its pass rate drops 10 points or more below the baseline's, *broken* once a drop shows, and *inconclusive* after 200 pairs with neither.
- Against a paired baseline, a run that dropped 10 points or more is kept, and one that didn't drop at all is broken, each at most 5% of the time, whatever the baseline's own pass rate.
- Its line shows both tallies and a bound on the drop; when both arms pass every attempt, it is kept after 38 pairs: `kept · 38 of 38 passed, baseline 38 of 38 · drop <= 0.10 (95%)`.

With no baseline to be had (no git repository, no change against HEAD, no history), it is judged by the gate on its own, and the report says so. [`repair`](./repair.md) verifies each candidate the same way.

| Flag                     | What it does                                             | Default                       |
|--------------------------|----------------------------------------------------------|-------------------------------|
| `--gate '{"good":0.95}'` | Changes any figure of the gate                           | `0.9`, `0.7`, `0.05` and `80` |
| `--margin`               | Changes the drop that breaks a good run                  | `0.1`: 10 points              |
| `--attempts`, `--passes` | A fixed count instead, which judges every run on its own | —                             |

### A blame probe

[`blame`](./blame.md) decides each probe with a gate that tells a re-asked call that passes 60% of the time or more (*rescued*) from one that passes 10% or less (*lost*): 0.6, 0.1, 0.05 and 20.

The 5% is the whole search's, spread over the most probes it can make, 1 + ⌈log₂ *m*⌉ + `scan` for *m* model calls, so every claim of every probe holds together but for it. Each probe runs at its share, about 1% to 0.5% for a search of 5 to 10 probes (a run of 3 to 128 model calls). Its `max` is deepened so it reaches as far into the evidence: 20 becomes 31 to 36 attempts.

So three straight passes rescue and six or seven straight failures lose, where two and four did at the full 5%. The rule is stated once, `gate: rescue at 60%+, lost at 10%-, <= 5% risk, up to 32 attempts` for a search of 6 probes. Each probe shows its tally and its bound at its own confidence, rounded down so it never says more than the probe is sure of: `rescued · 5 of 10 · rate >= 0.10 (99.1%)`.

Between the two rates either verdict can come. For instance, at the share of 8 probes (a run of 17 to 32 model calls), a call the model gets right 30% of the time is rescued 35% of the time, lost 47% of the time and left inconclusive 18%.

How blame reads its probes:

- **A probe still between the two after its `max`** is inconclusive and claims nothing. So the run was lost somewhere between the last call that rescued it and the call before the first found lost after it.
- **The [confidence](./blame.md#how-it-works)** is read from the sum of the exact risks of the probes that claimed something: high when it is within the 5%.
- **A call the probes pin** is checked against the next with fresh pairs before the run is said to be lost there. That is the paired test above, on the next call's attempt less the pinned call's, at a probe's share. It is pinned when rescue drops there beyond chance, else *lost gradually, around* the two calls, and the check's exact risk joins the sum.
- **When the first probe is the inconclusive one**, blame says *Inconclusive at the first model call*, at low confidence, with how to settle it (more attempts, or a lower `good`), rather than *Not rescued*. A run that passes some of the time when resampled from its first call may still be an unlucky answer.
- **With `--concurrency n`**, a probe decides on its attempts in the order they started, and starts one only while fewer than *n* have started that it hasn't counted. So at most *n* − 1 run past the attempt that decides. It keeps its first verdict: attempts still running when it came are reported, but never reopen it.

## Reference

### Options and settings

The options and config keys that change how a session gates:

| Flag or key | What it does | Default |
|---|---|---|
| `--inconclusive fail\|warn` | What CI does with an inconclusive verdict, a gate's or a check's | Fails the run; a young golden's gate only warns |
| `--max-attempts <n>` | Raises every gate's `max` for one session | — |
| `--continue` | Carries an inconclusive gate's attempts over from the golden's last result | — |
| `--suite-risk <r>`, `tests.suiteRisk` | The session's one risk of going red for nothing | `0.05` |
| `tests.baselineBranch` | The branch whose sessions make a baseline | The default branch |

The GitHub Action takes `inconclusive` and `max-attempts` as inputs, keeps the history with `keep-history` (`auto` by default), and gives an `inconclusive` output ([inputs and outputs](./ci.md#github-actions)).

### JSON fields

The fields of `shadowlap test --json` this page refers to. The [CLI reference](./cli.md#test) lists them all.

| Field           | Type   | Meaning                                                                         |
|-----------------|--------|---------------------------------------------------------------------------------|
| `sentence`      | string | The verdict line                                                                |
| `verdict`       | string | Each result's verdict, whatever CI did with it                                  |
| `bound`         | object | The end, or ends, the verdict line shows, with its `confidence` and `method`    |
| `interval`      | object | Both ends of the pass rate's interval                                           |
| `failRisk`      | number | The risk a session's split gave a gate for a failure                            |
| `unavailable`   | number | Attempts never counted: the provider failed before the model answered           |
| `cutShort`      | number | Attempts counted against either verdict                                         |
| `unavailableAt` | array  | Which of the gate's outcomes the provider cut short                             |
| `gate`          | object | Each result's gate, with its evidence path                                      |
| `suite`         | object | The session's plan: its risk, each golden's share and the forecast, with `over` |
| `inconclusive`  | number | The inconclusive goldens, beside `passed` and `failed`                          |

### Engine and dashboard

The odds on this page come from the engine ([the engine as a library](./engine.md)):

| Function or endpoint  | What it gives                                                              |
|-----------------------|----------------------------------------------------------------------------|
| `gateOdds`            | The odds of each verdict and the attempts, for any figures and any history |
| `attemptsToPass`      | The attempts an agent that always passes needs                             |
| `planSuite`           | A session's split                                                          |
| `GET /api/tests/gate` | The dashboard's preview of the odds, for figures not yet saved             |

## See also

- [CI mode](./ci.md): goldens, `repeat` and `passes`, the test history and the GitHub Action.
- [Verify](./verify.md) and [blame](./blame.md): the commands that decide runs and probes with these gates.
- [Error paths](./error-paths.md#gating): `chaos.gate` on error-path presets.
- [The CLI reference](./cli.md#test): every flag and JSON field of `shadowlap test`.
