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
      "gate": { "good": 0.9, "bad": 0.7, "risk": 0.05, "max": 40 },
      "expect": { "tools": { "issue_refund": 0, "escalate": ">= 1" } }
    }
  }
}
```

It reads: pass if the agent passes at least 90% of the time, fail if 70% or less, each with at most 5% risk of the wrong verdict, and give up after 40 attempts. Every figure is optional; `"gate": {}` is those four. `shadowlap test` asks the gate after each attempt and stops as soon as it decides, then says how in one sentence, with the evidence under it:

```
✓ reference-agent: passed: at least 90% with 95% confidence after 12 attempts
    12 of 12 passed · pass rate ≥ 0.76 (95%, Wilson) · pass^5 1.00 · forked at call 3, 8/28 replayed, 0 input tokens not re-spent, 1 check passed
```

```
✗ reference-agent: failed: at most 70% with 95% confidence after 3 attempts. Attempt 1: check failed: send_email called 0 times, but called 1 time (1 blocked or stubbed)
    ✗ send_email called 0 times: called 1 time (1 blocked or stubbed)
    0 of 3 passed · pass rate ≤ 0.56 (95%, Wilson)
    attempt 1  ✗ check failed: send_email called 0 times, but called 1 time (1 blocked or stubbed)
    attempt 2  ✗ check failed: send_email called 0 times, but called 1 time (1 blocked or stubbed)
    attempt 3  ✗ check failed: send_email called 0 times, but called 1 time (1 blocked or stubbed)
```

- **A clean replay settles it in one attempt.** A replay that forks nowhere and runs nothing live served every call from the recording, so every attempt would come out the same: its one attempt decides, and costs nothing.
- **It can say *inconclusive*.** When `max` runs out between the bounds, neither verdict holds at the stated risk. That is an honest outcome of its own, shown in amber, not a coin toss: `inconclusive: neither at least 90% nor at most 70% with 95% confidence after 40 attempts, the most the gate runs`. A golden whose only failed checks couldn't be judged is inconclusive too.
- **`--inconclusive fail|warn`** decides what CI does with an inconclusive verdict, a gate's or a check's. `fail`, the default, fails the run. `warn` lets it through: the exit status passes, the JUnit report marks the case skipped, `--annotations` gives it a warning instead of an error, and every report still says it is inconclusive.
- **`--max-attempts <n>`** raises every gate's limit for one session (an SPRT gate's `max`, a history gate's `min`), to settle an inconclusive golden without changing the config. The dashboard's `test` job takes it as `maxAttempts`, and its Tests data offers twice the limit for each inconclusive golden.
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

That is more than 5 attempts, and it is what it takes to tell 70% from 90% with 5% risk; the knob is explicit instead of hidden. Wald's bounds keep the error rates where the gate says: an agent at `bad` or below is passed at most risk / (1 − risk) of the time (5.3% here), one at `good` or above failed at most that, and stopping at `max` only moves some of those cases to inconclusive. In between the two rates, either verdict can happen, which is why the sentence names both.

The per-attempt decision is the SPRT's because it is built to be asked after every attempt. Checking a confidence interval after every attempt and stopping when it clears a bar ("peeking") inflates the error rate well past the one it claims; the interval in the reports is for display only.

## What a gate costs

The exact odds of each verdict, and the attempts run on average, for an agent that passes a given share of the time (every way the gate can end, computed, not simulated):

| Pass rate | 4 of 5: passes | `max` 40: passes · fails · inconclusive · attempts | `max` 20: passes · fails · inconclusive · attempts |
|---|---|---|---|
| 99% | 99.9% | 100.0% · 0.0% · 0.0% · 12.8 | 98.8% · 0.0% · 1.2% · 12.7 |
| 95% | 97.7% | 99.1% · 0.2% · 0.8% · 16.6 | 79.1% · 0.2% · 20.7% · 15.2 |
| 90% | 91.9% | 85.6% · 3.0% · 11.4% · 22.7 | 48.3% · 2.3% · 49.5% · 17.1 |
| 80% | 73.7% | 27.8% · 40.4% · 31.8% · 26.9 | 12.3% · 24.7% · 63.0% · 17.4 |
| 70% | 52.8% | 4.0% · 86.3% · 9.7% · 18.7 | 2.2% · 63.2% · 34.6% · 14.4 |
| 50% | 18.8% | 0.0% · 100.0% · 0.0% · 8.0 | 0.0% · 98.3% · 1.7% · 7.9 |

The default `max` is 40: with 20, one failure can be made up for and two can't, so a fifth of the goldens of an agent that passes 95% of the time end inconclusive. 40 leaves under 1% of them so, for 1.4 more attempts on average; the attempts a gate takes are spent where the evidence is close, not on agents that clearly pass or fail. A simulated agent that passes 95% of the time, behind 100 forked goldens (seeded, in the engine's tests), fails 2.23 goldens a CI run under 4 of 5, at 4.2 attempts each, and 0.16 under the default gate, at 16.5, with 0.8 inconclusive.

## A gate against history

The cheap gate, and the one worth starting with, compares a golden with its own past:

```json
"gate": { "baseline": "history", "drop": 0.15, "risk": 0.05 }
```

It asks: has this golden's pass rate dropped by 15 points or more? `shadowlap test` already keeps every golden's result per session in the store's [test history](./ci.md#test-history), with how many attempts passed of how many, so pooling the last sessions' attempts gives a baseline that costs nothing. After `min` attempts (5 by default) it decides once:

- the pass rate now and the baseline's are each a Beta posterior under a uniform prior: Beta(1 + passes, 1 + failures);
- it fails when P(now < baseline − drop) > 1 − risk, computed by integrating over the rate now;
- otherwise it passes: no drop of that size shows at that confidence.

It decides once, not after every attempt, so it doesn't peek. Without history it compares with a golden that always passes, which at 5 attempts and a 15-point drop is the 4 of 5 it replaces (3 of 5 fails). The chance it fails a golden, by its history and the pass rate now:

| Baseline | 95% now | 85% | 75% | 50% | 20% |
|---|---|---|---|---|---|
| none | 2.3% | 16.5% | 36.7% | 81.3% | 99.3% |
| 47 of 50 | 0.1% | 2.7% | 10.4% | 50.0% | 94.2% |
| 95 of 100 | 0.1% | 2.7% | 10.4% | 50.0% | 94.2% |

So an unchanged agent passes after its 5 attempts nearly every time, and one that collapsed fails; a drop of 20 points is caught only some of the time at 5 attempts, which `min` trades against cost. The baseline pools only results that speak to the agent as it is tested now: the golden's last `window` sessions (10 by default) under the same recording (one re-recorded by `test --update` starts a new baseline), the same checks and the same mode, each session's attempts as it kept them, and one attempt for a result kept before attempts were. The window keeps an old baseline from hiding a slow decline, and the sentence names it: `passed: no drop of 15 points or more from its baseline, 0.94 over the last 10 sessions (47 of 50 attempts), with 95% confidence after 5 attempts`. A CI job whose store goes with it has no history; keep `.shadowlap/` between jobs (a cache), or the gate compares with a golden that always passes.

## Reading the evidence

Every report says the verdict in one sentence and shows the evidence beside it:

- **The tally** `18 of 20 passed · pass rate ≥ 0.70 (95%, Wilson)`: the attempts, and the Wilson score interval of the pass rate at 1 − risk. A pass shows the interval's low end, a failure its high end (`≤ 0.56`), an inconclusive verdict both. The Wilson interval is (p̂ + z²/2n ± z √(p̂(1 − p̂)/n + z²/4n²)) / (1 + z²/n), with p̂ the share that passed and z the normal quantile; unlike p̂ ± z √(p̂(1 − p̂)/n), it has the right width near 0 and 1, so 12 of 12 reads ≥ 0.76, not 1.
- **pass^k**, the chance an agent passes all of *k* tries, which matters more than one success for an agent that runs unattended. With *c* passes in *n* attempts it is estimated as C(*c*, *k*) / C(*n*, *k*), the τ-bench estimator: 18 of 20 gives pass^5 = 8,568 / 15,504 ≈ 0.55, where 0.9⁵ would overstate it at 0.59. The line shows pass^5; the JSON has *k* from 1 to 8.
- **The evidence path**: for an SPRT gate, the score after each attempt between its two bounds, so why it stopped at 12 attempts takes one glance; for a history gate, the baseline it pooled and the chance of a drop it found. The `--json` report keeps both under each result's `gate` ([fields](./cli.md#test)), and so does the store, for the dashboard's Tests screen.

## Verify and blame

The same engine decides `verify`'s runs and `blame`'s probes:

- **[`verify`](./verify.md)** decides each forked run with the default gate, 0.9, 0.7, 0.05 and 40: *fixed* and *kept* mean the run passes its oracle at least 90% of the time with 95% confidence, *not fixed* and *broken* at most 70%, and a run between the two after 40 attempts is *inconclusive*, which keeps the change from being accepted. `--gate '{"good":0.95}'` changes any figure; `--attempts` and `--passes` give a fixed count instead. [`repair`](./repair.md) verifies each candidate the same way.
- **[`blame`](./blame.md)** decides each probe with 0.6, 0.1, 0.05 and 10: the probe rescues the run when the re-asked call passes at least 60% of the time, and the run is lost there when it passes at most 10%. Two straight passes rescue and four straight failures lose, the cost of the 2 of 5 it replaced; a probe still between the two after 10 attempts is inconclusive, and the search takes it as not rescued, with medium confidence when it sits right after the boundary.

Each run's and each probe's rate and the risk it was decided at are in their reports, their `--json` and the store.

## In CI

```yaml
- run: shadowlap test 'goldens/*' --junit report.xml --markdown "$GITHUB_STEP_SUMMARY" --annotations --inconclusive warn
```

The Markdown summary counts inconclusive goldens apart (`### Shadowlap: 1 of 12 recordings is inconclusive`), marks them 🟡, and says what to do; the JSON report has `inconclusive` beside `passed` and `failed`, and each result's `verdict`, whatever CI did with it. Fix on failure opens no fix for an inconclusive golden: more attempts settle it, not a change to the agent. `bisect` skips a commit whose verdict is inconclusive, as it skips one it can't build.

## Choosing the figures

- **Start with history.** `{ "baseline": "history" }` costs 5 attempts and fails a healthy golden about 0.1% of the time once it has history.
- **Use the SPRT where a pass rate is the requirement.** `good` is the rate you need, `bad` the one you must never ship; the closer they are, the more attempts. `risk` 0.05 means each wrong verdict at most 1 in 20 at those rates.
- **Read the cost before you commit to it.** The odds above come from the engine's `gateOdds`, which gives them for any figures, as `attemptsToPass` gives the attempts an agent that always passes needs ([the engine as a library](./engine.md)).
