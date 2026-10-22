# Gating

A replay that forks is a sample: everything after the fork runs live, so a forked golden, a verify attempt or a blame probe can come out differently each time. A gate decides on such attempts as they come in, with the error rates it states, instead of a fixed count of passes.

## Why a fixed count misleads

Fixed counts can't tell agents apart. These are exact binomial figures, not measurements:

| An agent that truly passes… | …clears 4 of 5 |
|---|---|
| 95% of the time | 97.7% of the time |
| 80% of the time | 73.7% of the time |
| 70% of the time | 52.8% of the time |

So 4 of 5 lets an agent that passes 70% of the time through about half the time, and it flakes on a healthy one: an agent that passes 95% of the time fails it 2.3% of the time, which across 100 forked goldens is about 2 spurious failures per CI run, and at least one in about 90% of runs. A gate states both risks and keeps them, at the cost of the attempts that takes.

## A gate on a golden

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

It reads: tell an agent that passes 90% of the time or more from one that passes 70% or less, each verdict wrong at most 5% of the time at those two rates, and give up after 80 attempts. Every figure is optional; `"gate": {}` is those four. `shadowlap test` asks the gate after each attempt and stops as soon as it decides, then says how in one line: the verdict, the tally, the Wilson bound and the rule, with pass^k under it:

```
✓ reference-agent: passed · 12 of 12 · rate >= 0.76 (95%) · gate: tells 90%+ from 70%- at <= 5% risk, up to 80 attempts
    pass^5 1.00 · forked at call 3, 8/28 replayed, 0 input tokens not re-spent, 1 check passed
```

```
✗ reference-agent: failed · 0 of 3 · rate <= 0.56 (95%) · gate: tells 90%+ from 70%- at <= 5% risk, up to 80 attempts. Attempt 1: check failed: send_email called 0 times, but called 1 time (1 blocked)
    ✗ send_email called 0 times: called 1 time (1 blocked)
    0 of 3 passed · rate <= 0.56 (95%)
    attempt 1  ✗ check failed: send_email called 0 times, but called 1 time (1 blocked)
    attempt 2  ✗ check failed: send_email called 0 times, but called 1 time (1 blocked)
    attempt 3  ✗ check failed: send_email called 0 times, but called 1 time (1 blocked)
```

- **A clean replay settles it in one attempt.** A replay that forks nowhere and runs nothing live served every call from the recording, so every attempt would come out the same: its one attempt decides, and costs nothing.
- **It can say *inconclusive*.** When `max` runs out between the bounds, neither verdict holds at the stated risk. That is an honest outcome of its own, shown in amber, not a coin toss: `inconclusive · 64 of 80 · rate 0.70 to 0.87 (95%) · gate: tells 90%+ from 70%- at <= 5% risk, up to 80 attempts`. A golden whose only failed checks couldn't be judged is inconclusive too.
- **A verdict states the test, never a rate.** The gate bounds its error only at its two rates; between them, either verdict can come: an agent that passes 80% of the time is passed 38% of the time. So *passed* says the gate told this agent from one at 70% or less, not that it passes 90% of the time, and every report shows the tally and the Wilson bound beside it, which say what the attempts themselves show.
- **`--inconclusive fail|warn`** decides what CI does with an inconclusive verdict, a gate's or a check's. `fail`, the default, fails the run. `warn` lets it through: the exit status passes, the JUnit report marks the case skipped, `--annotations` gives it a warning instead of an error, and every report still says it is inconclusive.
- **`--max-attempts <n>`** raises every gate's `max` for one session, to settle an inconclusive golden without changing the config.
- **`--continue`** carries an inconclusive gate's attempts over from the golden's last result, when its recording, checks and gate are unchanged, so a session with a raised limit runs only the attempts still needed: `shadowlap test goldens/refund-flow --max-attempts 160 --continue`. A gate continued this way decides exactly as one that had the higher limit from the start: whatever it decided before the old limit, it decided the same way, and every tally left between the bounds there goes on from where it stood. A settled verdict is never continued, since asking again after a gate has stopped would be peeking. The verdict line's tally says what it carried (`… of 86 (80 carried over)`), and the test history keeps each session's own attempts, so a gate against history pools each attempt once. The dashboard's Tests data offers this as Run more attempts, to twice the limit, with the attempts it adds on average.
- **`passes` keeps its meaning.** A golden with `repeat` and `passes` and no gate runs exactly as before; give one or the other.

## The sequential test

The gate is Wald's sequential probability ratio test between a pass rate of `good` (call it *p₁*) and one of `bad` (*p₀*). It keeps a score, starting at 0:

- each pass adds ln(*p₁* / *p₀*);
- each failure adds ln((1 − *p₁*) / (1 − *p₀*)), which is negative;
- it passes once the score reaches ln((1 − risk) / risk), and fails once it falls to minus that;
- with `max` attempts run and the score between the two, it is inconclusive.

With 0.9, 0.7 and 0.05, a pass adds ln(9/7) ≈ 0.2513, a failure adds ln(1/3) ≈ −1.0986, and the bounds are ±ln 19 ≈ ±2.944. So:

- an agent that passes every attempt is accepted after 12 (11 × 0.2513 is 2.764, still short of 2.944);
- one that fails every attempt is rejected after 3;
- each failure takes about 4.4 more passes to make up for: with one failure anywhere, it passes after 17 of 18; with two, it needs 21 passes.

That is more than 5 attempts, and it is what it takes to tell 70% from 90% with 5% risk; the knob is explicit instead of hidden. Wald's bounds keep the error rates where the gate says: an agent at `bad` or below is passed at most risk / (1 − risk) of the time (5.3% here), one at `good` or above failed at most that, and stopping at `max` only moves some of those cases to inconclusive. In between the two rates, either verdict can happen (the [table below](#what-a-gate-costs) gives the odds), which is why a verdict states the rule it was decided by, both rates in it, and never claims a rate for the agent.

The per-attempt decision is the SPRT's because it is built to be asked after every attempt. Checking a confidence interval after every attempt and stopping when it clears a bar ("peeking") inflates the error rate well past the one it claims; the interval in the reports is for display only.

## What a gate costs

The exact odds of each verdict, and the attempts run on average, for an agent that passes a given share of the time (every way the gate can end, computed, not simulated):

| Pass rate | 4 of 5: passes | `max` 80, the default: passes · fails · inconclusive · attempts | `max` 20: passes · fails · inconclusive · attempts |
|---|---|---|---|
| 99% | 99.9% | 100.0% · 0.0% · 0.0% · 12.8 | 98.8% · 0.0% · 1.2% · 12.7 |
| 95% | 97.7% | 99.8% · 0.2% · 0.0% · 16.6 | 79.1% · 0.2% · 20.7% · 15.2 |
| 90% | 91.9% | 95.7% · 3.3% · 0.9% · 24.4 | 48.3% · 2.3% · 49.5% · 17.1 |
| 80% | 73.7% | 37.9% · 53.8% · 8.3% · 34.0 | 12.3% · 24.7% · 63.0% · 17.4 |
| 70% | 52.8% | 4.5% · 94.9% · 0.7% · 20.0 | 2.2% · 63.2% · 34.6% · 14.4 |
| 50% | 18.8% | 0.0% · 100.0% · 0.0% · 8.0 | 0.0% · 98.3% · 1.7% · 7.9 |

The limit only decides how often the close calls run out of room. An agent that always passes needs 12 attempts and one that passes 95% of the time 16.6 on average, whatever the limit; the attempts a higher limit adds are spent where the evidence is close, on agents between `good` and `bad`, up to 34 on average for one at 80%.

**What a CI run sees.** Under `--inconclusive fail`, the default, an inconclusive golden fails the run like a failed one, so the share of CI runs that go red for nothing counts both. With 100 forked goldens of an agent that passes 95% of the time:

| Gate | Goldens failed per run | Inconclusive per run | Runs red | Runs red under `--inconclusive warn` |
|---|---|---|---|---|
| 4 of 5 | 2.26 | 0 | 90% | 90% |
| `max` 80, the default | 0.17 | 0.003 | 16% | 15% |
| `max` 40 | 0.17 | 0.75 | 60% | 15% |
| `max` 20 | 0.16 | 20.7 | 100% | 14% |

That is why the default is 80: at 40, three goldens in four hundred end inconclusive, and that alone turns most runs red; at 20, a fifth of them do. What is left at 80 is the gate's false failures, 0.17% of the goldens of a healthy agent, the price of the 5% risk at `good`; a lower `risk` lowers it, for more attempts. A seeded simulation of 300 such CI runs (in the engine's tests) prints the same table from coin flips, and its figures land within a few points of these.

## A gate against history

The gate that needs no figures of your own compares a golden with its own past:

```json
"gate": { "baseline": "history", "drop": 0.15, "risk": 0.05 }
```

It asks: has this golden's pass rate dropped by 15 points or more? `shadowlap test` already keeps every golden's result per session in the store's [test history](./ci.md#test-history), with how many attempts passed of how many, so pooling the last sessions' attempts gives a baseline that costs nothing. It runs `min` attempts (5 by default), then decides after each one:

- the pass rate now and the baseline's are each a Beta posterior under a uniform prior: Beta(1 + passes, 1 + failures);
- it **fails** when P(now < baseline − drop) > 1 − risk, computed by integrating over the rate now: a drop of that size, 95% likely under the prior;
- it **passes** once that chance is 1/2 or less: no sign of a drop;
- in between, it runs another attempt, up to `max` (40 by default), where it is **inconclusive**: a drop likelier than not, short of the confidence to fail.

So an agent whose attempts all pass, as an unchanged deterministic one does, passes after exactly its 5; one that passes 95% of the time passes after 5 in about three sessions of four (all 5 passed), and after 5.7 attempts on average, its odd failure made up for by a few more passes. When its first attempts look like a drop, it takes the attempts that tell. Its verdict line names the baseline after the tally and the Wilson bound: `passed · 5 of 5 · rate >= 0.57 (95%) · against 0.94 over the last 10 sessions (47 of 50) · gate: fails a drop of 15+ points from its last 10 sessions once 95% likely, from 5 attempts up to 40`, or `failed · 4 of 8 · rate <= 0.78 (95%) · against 0.94 over the last 10 sessions (47 of 50) · gate: …`.

It is asked after every attempt, and the odds below count every look: an agent that passes as often as its history says is failed 0.2% of the time against 47 of 50, and at most 1.4% against a history that passes far less often (30 of 50), below the 5% the gate allows.

The chance it fails a golden, by its baseline and the pass rate now (inconclusive in brackets), with the attempts it takes on average at 95% and at 75%:

| Baseline | 95% now | 85% | 75% | 60% | 50% | 20% | Attempts |
|---|---|---|---|---|---|---|---|
| 47 of 50 | 0.1% | 4.6% (+1.5%) | 24.2% (+8.4%) | 73.7% (+3.5%) | 91.2% (+0.4%) | 99.9% | 5.7 / 12.2 |
| 95 of 100 | 0.3% | 7.1% (+2.1%) | 32.1% (+7.0%) | 78.5% (+1.4%) | 92.3% (+0.1%) | 99.9% | 5.7 / 11.5 |
| 50 of 50 | 0.5% | 13.0% (+5.1%) | 48.4% (+6.9%) | 87.6% (+0.5%) | 95.8% | 100.0% | 6.4 / 12.4 |
| 5 of 5 | 0.0% | 0.3% (+0.5%) | 2.7% (+9.9%) | 20.3% (+35.7%) | 49.6% (+28.4%) | 99.3% | 5.1 / 11.3 |
| none: its recording | 0.0% | 0.0% | 0.0% | 0.0% (+6.0%) | 0.0% (+26.2%) | 5.1% (+87.9%) | 5.0 / 5.6 |

Read it for what it is:

- **It catches a collapse, and a large drop, cheaply.** Against 47 of 50, a golden now at 60% fails three times in four and one at 50% nine in ten, where deciding once at 5 attempts caught them 32% and 50% of the time, and 4 of 5, which fails a healthy agent 16 times as often, 66% and 81%.
- **A drop just past `drop` is caught only sometimes.** 75% against 94% is a 19-point drop, failed a quarter of the time: telling 94% from 79% at 5% risk takes as many attempts as the [sequential test](#the-sequential-test) spends, and this gate spends them only when its first attempts look bad. Where a pass rate is a requirement, use the SPRT between the rate you need and the one you must never ship.
- **A short history knows little.** After one session of 5 attempts, its baseline could still be anywhere from about 60% up, so it fails a golden now at 50% only half the time, and one at 20% nearly always; the baseline firms up as the window fills.
- **Its first session has no history.** It then compares with the golden's recording, the one attempt it was packed from, which passed: it never flakes on a healthy agent, and fails only one that fails nearly every attempt (one at 20% mostly ends inconclusive, which fails CI by default). `test` says so under the golden's line, and the next session compares with this one's attempts.

The baseline pools only results that speak to the agent as it is tested now: the golden's last `window` sessions (10 by default) under the same recording (one re-recorded by `test --update` starts a new baseline), the same checks and the same mode, each session's attempts as it kept them, and one attempt for a result kept before attempts were. The window keeps an old baseline from hiding a slow decline, and the verdict line names it.

**In CI, keep the history.** A CI job's store goes with the job, and without history every session is a first one. The GitHub Action keeps the store between jobs in the Actions cache when a golden has a gate against history (its [`keep-history`](./ci.md#github-actions) input, `auto` by default): each run restores its branch's newest copy, or the default branch's for a branch's first run, and saves its own, a run that failed included. On another CI system, cache `.shadowlap/shadowlap.db` (or the store `--db` names) between runs the same way; with GitHub Actions and the CLI alone:

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

## Reading the evidence

Every report says a verdict in one line, wherever it appears (the terminal, `--json`'s `sentence`, JUnit, the Markdown summary and the pull request comment, the dashboard): the verdict word, the tally, the Wilson bound and the rule, stated once, as in `passed · 12 of 12 · rate >= 0.76 (95%) · gate: tells 90%+ from 70%- at <= 5% risk, up to 80 attempts`. A report that lists many runs under one gate states the rule once above them. Never "passes at least 90% of the time": that is what the gate tells apart, not what it found.

- **The tally and the Wilson bound** `18 of 20 · rate >= 0.70 (95%)`: the attempts, and the Wilson score interval of the pass rate at 1 − risk. A pass shows the interval's low end, a failure its high end (`rate <= 0.56`), an inconclusive verdict both (`rate 0.70 to 0.97`). The Wilson interval is (p̂ + z²/2n ± z √(p̂(1 − p̂)/n + z²/4n²)) / (1 + z²/n), with p̂ the share that passed and z the normal quantile; unlike p̂ ± z √(p̂(1 − p̂)/n), it has the right width near 0 and 1, so 12 of 12 reads `rate >= 0.76`, not 1.
- **pass^k**, the chance an agent passes all of *k* tries, which matters more than one success for an agent that runs unattended. With *c* passes in *n* attempts it is estimated as C(*c*, *k*) / C(*n*, *k*), the τ-bench estimator: 18 of 20 gives pass^5 = 8,568 / 15,504 ≈ 0.55, where 0.9⁵ would overstate it at 0.59. The line shows pass^5; the JSON has *k* from 1 to 8.
- **The evidence path**: each attempt's outcome in order, and for an SPRT gate the score after each attempt between its two bounds, so why it stopped at 12 attempts takes one glance; for a history gate, the baseline it pooled and the chance of a drop after each attempt from `min` on, between the 1/2 it passes at and the 1 − risk it fails above. The `--json` report keeps them under each result's `gate` ([fields](./cli.md#test)), and so does the store, for the dashboard's Tests screen.

## Verify and blame

The same engine decides `verify`'s runs and `blame`'s probes:

- **[`verify`](./verify.md)** decides each forked run with the default gate, 0.9, 0.7, 0.05 and 80: *fixed* and *kept* mean the gate passed the run, telling it from one that meets its oracle 70% of the time or less, *not fixed* and *broken* that it failed it, telling it from one at 90% or more, and a run still between the bounds after 80 attempts is *inconclusive*, which keeps the change from being accepted. Each run's line shows its tally and Wilson bound (`kept · 12 of 12 · rate >= 0.76 (95%)`), under the rule stated once. A run that passes 90% of the time ends inconclusive 0.9% of the time at 80 attempts, where 40 left it so 11%. `--gate '{"good":0.95}'` changes any figure; `--attempts` and `--passes` give a fixed count instead. [`repair`](./repair.md) verifies each candidate the same way.
- **[`blame`](./blame.md)** decides each probe with 0.6, 0.1, 0.05 and 20, a gate that tells a re-asked call that passes 60% of the time or more (*rescued*) from one that passes 10% or less (*lost*): `rescued · 3 of 4 · rate >= 0.30 (95%)`, under the rule `gate: rescue at 60%+, lost at 10%-, <= 5% risk, up to 20 attempts`. Between the two rates either verdict can come: a call the model gets right 30% of the time is rescued 40% of the time. Two straight passes rescue and four straight failures lose, the cost of the 2 of 5 it replaced; a probe still between the two after 20 attempts is inconclusive, and the search takes it as not rescued, with medium confidence when it sits right after the boundary. A call the model gets right 30% of the time ends inconclusive 5.7% of the time, where 10 attempts left it so 30%. When the first probe is the inconclusive one, blame says *Not settled from the first model call*, at low confidence, with how to settle it (more attempts, or a lower `good`), rather than *Not rescued*: a run that passes some of the time when resampled from its first call may still be an unlucky answer. With `--concurrency n`, a probe decides on its attempts in the order they started, and starts one only while fewer than *n* have started that it hasn't counted, so at most *n* − 1 run past the attempt that decides. It keeps its first verdict: attempts still running when it came are reported, but never reopen it.

Each run's and each probe's tally, its Wilson bound and the risk it was decided at are in their reports, their `--json` and the store.

## In CI

```yaml
- run: shadowlap test 'goldens/*' --junit report.xml --markdown "$GITHUB_STEP_SUMMARY" --annotations
```

An inconclusive golden fails this step, as a failed one does, and the [table above](#what-a-gate-costs) says how often that happens for nothing at each limit. To let inconclusive goldens through with a warning instead, add `--inconclusive warn`. The GitHub Action has the same choice as its `inconclusive` input, and `--max-attempts` as `max-attempts`, and counts inconclusive goldens in an `inconclusive` output of their own ([inputs and outputs](./ci.md#github-actions)).

The Markdown summary counts inconclusive goldens apart (`### Shadowlap: 1 of 12 recordings is inconclusive`), marks them 🟡, and says what to do; the JSON report has `inconclusive` beside `passed` and `failed`, and each result's `verdict`, whatever CI did with it. Fix on failure opens no fix for an inconclusive golden: more attempts settle it, not a change to the agent. `bisect` skips a commit whose verdict is inconclusive, as it skips one it can't build.

## Choosing the figures

- **Use the SPRT where a pass rate is the requirement.** `good` is the rate you need, `bad` the one you must never ship; the closer they are, the more attempts. `risk` 0.05 means each wrong verdict at most 1 in 20 at those rates.
- **Use history where each golden's own past is the standard.** `{ "baseline": "history" }` costs 5 to 6 attempts for an unchanged agent, never needs figures of its own, and fails a collapse or a large drop; it catches a drop just past `drop` only sometimes, and needs its history kept, in CI too.
- **Read the cost before you commit to it.** The odds above come from the engine's `gateOdds`, which gives them for any figures and any history, as `attemptsToPass` gives the attempts an agent that always passes needs ([the engine as a library](./engine.md)); the dashboard's `GET /api/tests/gate` previews them for figures not yet saved.
