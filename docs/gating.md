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

It reads: tell an agent that passes 90% of the time or more from one that passes 70% or less, each verdict wrong at most 5% of the time at those two rates, and give up after 80 attempts. Every figure is optional; `"gate": {}` is those four. `shadowlap test` asks the gate after each attempt and stops as soon as it decides, then says how in one line: the verdict, the tally, the bound and the rule, with pass^k under it:

```
✓ reference-agent: passed · 12 of 12 · rate >= 0.73 (95%) · gate: tells 90%+ from 70%- at <= 5% risk, up to 80 attempts
    pass^5 1.00 · forked at call 3, 8/28 replayed, 0 input tokens not re-spent, 1 check passed
```

```
✗ reference-agent: failed · 0 of 3 · rate <= 0.71 (95%) · gate: tells 90%+ from 70%- at <= 5% risk, up to 80 attempts. Attempt 1: check failed: send_email called 0 times, but called 1 time (1 blocked)
    ✗ send_email called 0 times: called 1 time (1 blocked)
    0 of 3 passed · rate <= 0.71 (95%)
    attempt 1  ✗ check failed: send_email called 0 times, but called 1 time (1 blocked)
    attempt 2  ✗ check failed: send_email called 0 times, but called 1 time (1 blocked)
    attempt 3  ✗ check failed: send_email called 0 times, but called 1 time (1 blocked)
```

- **A clean replay settles it in one attempt.** A replay that forks nowhere and runs nothing live served every call from the recording, so every attempt would come out the same: its one attempt decides, and costs nothing.
- **It can say *inconclusive*.** When `max` runs out between the bounds, neither verdict holds at the stated risk. That is an honest outcome of its own, shown in amber, not a coin toss: `inconclusive · 64 of 80 · rate 0.67 to 0.91 (95%) · gate: tells 90%+ from 70%- at <= 5% risk, up to 80 attempts`. A golden whose only failed checks couldn't be judged is inconclusive too, and so is one whose provider was [unavailable](#when-the-provider-is-unavailable) for three attempts in a row.
- **A verdict states the test, never a rate.** The gate bounds its error only at its two rates; between them, either verdict can come: an agent that passes 80% of the time is passed 37% of the time. So *passed* says the gate told this agent from one at 70% or less, not that it passes 90% of the time, and every report shows the tally and the [bound](#reading-the-evidence) beside it, which say what the attempts themselves show.
- **`--inconclusive fail|warn`** decides what CI does with an inconclusive verdict, a gate's or a check's. `fail`, the default, fails the run. `warn` lets it through: the exit status passes, the JUnit report marks the case skipped, `--annotations` gives it a warning instead of an error, and every report still says it is inconclusive.
- **`--max-attempts <n>`** raises every gate's `max` for one session, to settle an inconclusive golden without changing the config.
- **`--continue`** carries an inconclusive gate's attempts over from the golden's last result, when its recording, checks and gate are unchanged and it ran on the same branch, so a session with a raised limit runs only the attempts still needed: `shadowlap test goldens/refund-flow --max-attempts 160 --continue`. A gate continued this way decides exactly as one that had the higher limit from the start: whatever it decided before the old limit, it decided the same way, and every tally left between the bounds there goes on from where it stood. A settled verdict is never continued, since asking again after a gate has stopped would be peeking. The verdict line's tally says what it carried (`… of 86 (80 carried over)`), and its bound is the one that holds however attempts stopped. The test history keeps each session's own attempts, so a gate against history pools each attempt once. The dashboard's Tests data offers this as Run more attempts, to twice the limit, with the attempts it adds on average.
- **`passes` keeps its meaning.** A golden with `repeat` and `passes` and no gate runs exactly as before; give one or the other.

## The sequential test

The gate is Wald's sequential probability ratio test between a pass rate of `good` (call it *p₁*) and one of `bad` (*p₀*). It keeps a score, starting at 0:

- each pass adds ln(*p₁* / *p₀*);
- each failure adds ln((1 − *p₁*) / (1 − *p₀*)), which is negative;
- it passes once the score reaches ln(1 / α), and fails once it falls to ln β, where α, the risk of a wrong pass, is `risk`, and β, the risk of a wrong failure, is `risk` too unless a session [splits its risk](#one-risk-for-the-whole-suite);
- with `max` attempts run and the score between the two, it is inconclusive.

With 0.9, 0.7 and 0.05, a pass adds ln(9/7) ≈ 0.2513, a failure adds ln(1/3) ≈ −1.0986, and the bounds are ±ln 20 ≈ ±2.996. So:

- an agent that passes every attempt is accepted after 12 (11 × 0.2513 is 2.764, still short of 2.996);
- one that fails every attempt is rejected after 3;
- each failure takes about 4.4 more passes to make up for: with one failure anywhere, it passes after 17 of 18; with two, it needs 21 passes.

That is more than 5 attempts, and it is what it takes to tell 70% from 90% with 5% risk; the knob is explicit instead of hidden. The bounds keep the error rates where the gate says. The score is the logarithm of a likelihood ratio, which for an agent at `bad` stays 1 on average however many attempts run, and falls for one below it; so by Ville's inequality the score ever reaches ln(1 / α) at most α of the time, every look counted and whatever the limit. For an agent at `good` or above, it falls to ln β at most β of the time, and stopping at `max` only moves some of those cases to inconclusive. Wald's own bounds, ln((1 − β) / α) and ln(β / (1 − α)), ±ln 19 here, keep the errors only within α / (1 − β), 5.3% at these figures, and a gate's exact error can go past its risk under them: one between 98% and 73% at 5% risk, up to 1,000 attempts, passed an agent at 73% 5.12% of the time. In between the two rates, either verdict can happen (the [table below](#what-a-gate-costs) gives the odds), which is why a verdict states the rule it was decided by, both rates in it, and never claims a rate for the agent.

The per-attempt decision is the SPRT's because it is built to be asked after every attempt. Checking a confidence interval after every attempt and stopping when it clears a bar ("peeking") inflates the error rate well past the one it claims; the bound in the reports describes where the gate stopped, and never decides anything.

## What a gate costs

The exact odds of each verdict, and the attempts run on average, for an agent that passes a given share of the time (every way the gate can end, computed, not simulated):

| Pass rate | 4 of 5: passes | `max` 80, the default: passes · fails · inconclusive · attempts | `max` 20: passes · fails · inconclusive · attempts |
|---|---|---|---|
| 99% | 99.9% | 100.0% · 0.0% · 0.0% · 12.8 | 98.8% · 0.0% · 1.2% · 12.7 |
| 95% | 97.7% | 99.8% · 0.2% · 0.0% · 16.7 | 79.1% · 0.1% · 20.7% · 15.2 |
| 90% | 91.9% | 95.8% · 3.2% · 1.0% · 24.8 | 48.3% · 2.1% · 49.6% · 17.2 |
| 80% | 73.7% | 37.4% · 53.7% · 9.0% · 34.8 | 12.3% · 23.7% · 64.0% · 17.5 |
| 70% | 52.8% | 4.3% · 95.0% · 0.7% · 20.4 | 2.2% · 62.2% · 35.6% · 14.6 |
| 50% | 18.8% | 0.0% · 100.0% · 0.0% · 8.1 | 0.0% · 98.2% · 1.7% · 8.0 |

The limit only decides how often the close calls run out of room. An agent that always passes needs 12 attempts whatever the limit, and one that passes 95% of the time 16.7 on average at 80 (15.2 at 20, where a fifth of them run out); the attempts a higher limit adds are spent where the evidence is close, on agents between `good` and `bad`, up to 35 on average for one at 80%.

**What a CI run sees.** Under `--inconclusive fail`, the default, an inconclusive golden fails the run like a failed one, so the share of CI runs that go red for nothing counts both. With 100 forked goldens of an agent that passes 95% of the time:

| Gate | Goldens failed per run | Inconclusive per run | Runs red | Runs red under `--inconclusive warn` | Attempts a golden |
|---|---|---|---|---|---|
| 4 of 5 | 2.26 | 0 | 90% | 90% | 4.2 |
| A gate per golden at its own 5%, `max` 80 | 0.15 | 0.0027 | 15% | 14% | 16.7 |
| A gate per golden at its own 5%, `max` 40 | 0.15 | 0.78 | 61% | 14% | 16.6 |
| A gate per golden at its own 5%, `max` 20 | 0.14 | 20.7 | 100% | 13% | 15.2 |
| The default: 5% for the suite, split 100 ways | 0.00002 | under 0.0001 | 0.0018% | 0.0018% | 16.75 |

A gate per golden keeps each golden's risk, but a hundred of them add up: 0.15% of a healthy agent's goldens fail, and one in seven runs goes red. So `shadowlap test` gives the session [one risk](#one-risk-for-the-whole-suite) and splits it: a healthy suite then goes red about once in 55,000 runs, at 16.75 attempts a golden instead of 16.7. The engine's seeded simulation of 300 such CI runs prints the same table from coin flips, and its figures land within a few points of these.

## One risk for the whole suite

A test session has one risk of going red for nothing, 5% by default: `--suite-risk 0.05` for one session, or `"suiteRisk": 0.05` under `tests` in the config. It is split evenly across the session's gated goldens, each with a share: with 100, 0.05% each. The chance that any golden goes red is at most the sum of the chances that each does, whatever they have in common (one agent behind all of them), so shares that add up to the session's risk keep a healthy suite within it. That is Bonferroni's split. Holm's step-down would let a golden use what others left unused, but its thresholds depend on every golden's evidence at once, and a gate decides as its own attempts come in, before the goldens after it have run; a healthy suite's goldens end far from their failing bounds, where the two split alike.

A golden goes red for nothing in two ways, both at its gate's `good` rate: failing there, and, under `--inconclusive fail`, running out of attempts there. Its share pays for both:

- **An SPRT gate keeps its `risk` for a pass**, the safety side, and takes a lower risk for a failure, `failRisk`: the largest, at two significant digits, whose exact chance of going red at `good`, every look counted, fits the share. With 100 goldens of `"gate": {}`, that is 0.047%: the gate fails only after about 7 straight failures, where it took 3.
- **Its `max` grows to fit**, unless the config sets one: the fewest attempts, 80 or more, that leave at most 1% of attempts at `good` inconclusive, or, under `--inconclusive fail`, half the share when that is less. With 100 goldens, 179.
- **A better agent goes red less often still**: a gate passes no less often for an agent that passes more often. With every golden at 90%, the worst a healthy suite can be, the default suite goes red 4.8% of the time when its goldens are independent, and at most 4.95% whatever they share; at 95%, 0.0018%.
- **A gate against history takes the share as its `risk`**, so it fails once a drop is that much likelier, and halves it until its chance of going red, worked out exactly at the pass rate its baseline shows, fits the share.
- **A `max` the config sets is kept.** When it leaves more attempts at `good` inconclusive than the share allows, the session says so before it runs, and counts the gate's real chance of going red in the suite's.
- **A single golden runs exactly as before**: the default gate, at 3.2% failed and 1.0% inconclusive at its `good` rate, already fits the whole 5%.

The verdict line names the risks it ran with: `gate: tells 90%+ from 70%- at <= 5% risk to pass and <= 0.047% to fail, up to 179 attempts`, and `--json` gives each result's `failRisk` and the session's `suite`.

What it costs: the score a gate passes at stays at ln 20, ln(1 / α), whatever β, so an agent that always passes still needs 12 attempts, and one at 95% takes 16.75 on average instead of 16.7. A golden whose agent is at `bad`, 70%, still goes red 96% of the time, after 49.5 attempts on average instead of 20; one at 80% after 83.5. An agent that slips to 80% on every golden turns every run red.

**The forecast.** Before any golden runs, the session says what it will cost. For 100 gated goldens of an agent that passes 95% of the time, at $0.025 an attempt:

```
forecast: about 1,675 attempts (16.7 a golden on average), up to 17,900 · about $41.87
suite risk 5%: 100 gated goldens, 0.05% each, so a healthy suite goes red for nothing in 5% of runs or fewer
```

The attempts are each gate's exact average at the pass rate its golden's last 10 results show, or at its `good` rate when it has none (a gate against history: at its baseline's), and up to the most every gate can run. The cost is those attempts times the cost of an attempt: what the golden's last results spent per attempt, else what its recording's model calls cost, which is what an attempt that forks at its first call would spend. A model with no price leaves the cost out, and says so.

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

So an agent whose attempts all pass, as an unchanged deterministic one does, passes after exactly its 5; one that passes 95% of the time passes after 5 in about three sessions of four (all 5 passed), and after 5.7 attempts on average, its odd failure made up for by a few more passes. When its first attempts look like a drop, it takes the attempts that tell. Its verdict line names the baseline after the tally and the bound: `passed · 5 of 5 · rate >= 0.47 (95%) · against 0.94 over the last 10 sessions (47 of 50) · gate: fails a drop of 15+ points from its last 10 sessions once 95% likely, from 5 attempts up to 40`, or `failed · 4 of 8 · rate <= 0.87 (95%) · against 0.94 over the last 10 sessions (47 of 50) · gate: …`.

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
- **Its first session has no baseline.** It then compares with the golden's recording, the one attempt it was packed from, which passed: it never flakes on a healthy agent, and fails only one that fails nearly every attempt (one at 20% mostly ends inconclusive, which fails CI by default). `test` says so under the golden's line.

**What makes the baseline.** A golden's baseline is a standard to keep, so it takes only results that were one: the golden **passed**, in a session on the **baseline branch** that ran for **no pull request**, on a **committed revision**. A session that failed, a branch's, a pull request's and one on uncommitted changes are kept in the history and shown, but never pooled, and so is a result kept before results said where their session ran, which can't show it was the baseline branch's: a golden's baseline starts again from its next session that passes there. Of those that qualify, it pools the golden's last `window` sessions (10 by default) under the same recording (one re-packed or re-recorded starts a new baseline), the same checks and the same mode, each session's attempts as it kept them. The window keeps an old baseline from hiding a slow decline, and the verdict line names it.

The baseline branch is the default branch: in GitHub Actions the repository's, from the event, or for a pull request the branch it merges into; in GitLab CI and Buildkite their own variables; elsewhere git's `origin/HEAD`. `"baselineBranch": "main"` under `tests` in the config names another. Where none can be told (no CI, and a clone without `origin/HEAD`), no session is a baseline, and `test` says how to name one. Every result keeps where its session ran in the history: its `branch`, `revision`, `pullRequest` and the `baselineBranch` it saw.

That is what keeps a regression caught. Once a drop lands on the default branch, its sessions fail, and a failing session never joins the baseline: every later run is judged against the agent before the drop. In a seeded simulation of 300 histories (in the engine's tests), a drop from 95% to 60% was caught on each of the 10 runs after it 79% to 87% of the time, against 84.7% the exact odds give for the first; when every session joined the baseline, it was caught 85% of the time on the first run, 32% on the fourth and 2% on the tenth, the regression having become the standard. A pull request's sessions never count, however often its CI runs. A drop you mean to keep is a new standard: pack the golden again from a run of the agent as it is now, and its new recording starts a new baseline.

**In CI, keep the history.** A CI job's store goes with the job, and without history every session is a first one. The GitHub Action keeps the store between jobs in the Actions cache when a golden has a gate against history (its [`keep-history`](./ci.md#github-actions) input, `auto` by default): each run restores its branch's newest copy, or the default branch's for a branch's first run, and saves its own, a run that failed included. A failed run's results are kept and never pooled, and a pull request's runs read the default branch's sessions in the copy they restored. On another CI system, cache `.shadowlap/shadowlap.db` (or the store `--db` names) between runs the same way; with GitHub Actions and the CLI alone:

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

## When the provider is unavailable

A provider that is down, overloaded or rate limiting says nothing about the agent. An attempt the agent failed while one of its live model calls ended on HTTP 408, 409, 429 or any 5xx (529 "overloaded" included), on a connection that failed, on a stream cut short or on an answer that could not be passed on to the agent, is *unavailable*:

- it is kept as a run, and its line says so: `the provider was unavailable (HTTP 529 from anthropic at call #3), so that attempt isn't counted`;
- it is run again after a pause: what the provider's `retry-after-ms` or `retry-after` asked for, at most a minute, else 5 s, then 15 s, a fifth either way at random;
- it is never counted: the gate's tally, a fixed count's and the test history leave it out, the verdict line says so beside the tally (`passed · 12 of 12 (2 unavailable, not counted) · rate >= 0.73 (95%) · gate: …`), and `--json` counts it as `unavailable`;
- three in a row make the golden inconclusive, with the provider named: `provider unavailable: 3 attempts in a row ended on HTTP 529 from anthropic at call #3, so none of them says anything about the agent; run it again once the provider answers`. Never failed.

What is read is each call's final answer: a call its SDK retried until it succeeded is fine, and an attempt that passed after a call failed is a pass, its agent having coped. The agent's own clock is not the provider's: a call the agent hung up on (its client's timeout, or an abort) and an attempt the test's time limit stopped count as the agent's, as do failures Shadowlap plays in on purpose (`--fail-at`, `test --chaos`), the calls it refuses itself (offline, a placeholder key), a judge check's calls, which the judge retries by itself, and a replay no preload loaded in, which the [guard](./how-it-works.md#the-network-guard) fails. [`verify`](./verify.md) and [`blame`](./blame.md) handle their attempts the same way: retried, never counted, and three in a row leave a verified run inconclusive, never not fixed or broken, and stop a blame, which names the provider and exits 3, never calling the run rescued, lost or unrescuable. [`repair`](./repair.md) stops with them.

## Reading the evidence

Every report says a verdict in one line, wherever it appears (the terminal, `--json`'s `sentence`, JUnit, the Markdown summary and the pull request comment, the dashboard): the verdict word, the tally, the bound and the rule, stated once, as in `passed · 12 of 12 · rate >= 0.73 (95%) · gate: tells 90%+ from 70%- at <= 5% risk, up to 80 attempts`. A report that lists many runs under one gate states the rule once above them. Never "passes at least 90% of the time": that is what the gate tells apart, not what it found.

- **The tally and the bound** `12 of 12 · rate >= 0.73 (95%)`: the attempts, and one end of the pass rate's interval at 1 − risk. A pass shows the low end, a failure the high end (`rate <= 0.71`), an inconclusive verdict both (`rate 0.67 to 0.91`).
  - **What it guarantees.** Over every way the gate can end, the end it shows is wrong at most 1 − confidence of the time, whatever the agent's true pass rate. Each end alone is wrong at most half that, so the guarantee holds whichever end a verdict picks. The engine's tests prove it exactly, every stop the gate can make summed with its chance, at every rate from 1% to 99%. The worst the printed bound does is 95.9% under the default gate, 96.2% under a gate split 100 ways, 97.8% under the gate against history against 47 of 50, and 99.7% under a blame probe's at the share of 8 probes, whose bound is at 99.4%.
  - **How it is worked out.** Exactly, under the gate's own stopping rule. Every stop the gate can make is ranked, Siegmund's stagewise ordering: a pass ranks higher the sooner it came, a failure lower the sooner it came, and stops after the same attempt by their passes. The low end is the lowest rate at which stopping as high as the gate did, or higher, has more than a 2.5% chance; the high end is the highest rate at which stopping as low or lower has. 12 of 12 is the highest stop of all, reached only by 12 straight passes, so its low end is the rate whose twelfth power is 2.5%: 0.735. Ends print rounded away from the rate they bound, so a printed bound never says more than was worked out.
  - **What it doesn't say:** how often a verdict of one kind is wrong. Among the runs that passed an agent at 70%, the few lucky ones, the low end is above 70% about a third of the time (32%): every run of 12 straight passes. Those passes happen 4.3% of the time, so they put the bound wrong 1.4% of the time, within the 5%.
  - **Why not the Wilson interval** reports showed before. Computed from the tally as if its count had been fixed, it misses the true rate whenever the gate stopped early on a run of passes, as often as 17% of the time under the default gate. After a pass at 75%, its `rate >= 0.76` was wrong 23% of the time.
  - **Other bounds.** A replay that forked nowhere shows none: it is the same every time. A gate cut short (a signal, a budget), continued from another session, or with the provider unavailable too often shows a confidence sequence instead: the rates whose likelihood, mixed over a uniform prior, is above 1 − confidence, which covers the true rate at every attempt at once and so holds however the attempts stopped, and is wider (12 of 12 reads `rate >= 0.62`). A fixed count (`--attempts`, `repeat`) has the Clopper–Pearson interval, which holds for a count stopped as soon as it is settled too.
  - **In `--json`,** each result's `bound` says which: `{ "lo": 0.73535, "confidence": 0.95, "method": "stagewise" }`, with `method` `stagewise`, `confidence-sequence` or `clopper-pearson`, and `interval` has both ends.
- **pass^k**, the chance an agent passes all of *k* tries, which matters more than one success for an agent that runs unattended. With *c* passes in *n* attempts it is estimated as C(*c*, *k*) / C(*n*, *k*), the τ-bench estimator: 18 of 20 gives pass^5 = 8,568 / 15,504 ≈ 0.55, where 0.9⁵ would overstate it at 0.59. The line shows pass^5; the JSON has *k* from 1 to 8. It is the tally's own estimate, with no confidence of its own, and a gate that stopped on a run of passes flatters it: 12 of 12 reads pass^5 1.00 whatever the agent's rate. What the attempts guarantee is the bound to the *k*th power: `rate >= 0.73 (95%)` means pass^5 is at least 0.73⁵ = 0.207, at the same confidence.
- **The evidence path**: each attempt's outcome in order, and for an SPRT gate the score after each attempt between its two bounds, so why it stopped at 12 attempts takes one glance; for a history gate, the baseline it pooled and the chance of a drop after each attempt from `min` on, between the 1/2 it passes at and the 1 − risk it fails above. The `--json` report keeps them under each result's `gate` ([fields](./cli.md#test)), and so does the store, for the dashboard's Tests screen.

## Verify and blame

The same engine decides `verify`'s runs and `blame`'s probes:

- **[`verify`](./verify.md)** decides each failing run that forks, a target or a held-out one, with the default gate, 0.9, 0.7, 0.05 and 80: *fixed* means the gate passed the run, telling it from one that meets its oracle 70% of the time or less, *not fixed* that it failed it, telling it from one at 90% or more, and a run still between the bounds after 80 attempts is *inconclusive*, which keeps the change from being accepted. Its line shows its tally and bound (`fixed · 12 of 12 · rate >= 0.73 (95%)`), under the rule stated once. A run that passes 90% of the time ends inconclusive 1.0% of the time at 80 attempts, where 40 left it so 12%.
- **A good run that forks** is decided against [its own baseline](./verify.md#good-runs-against-their-own-baseline) instead: the same run under the code before the change, each of its attempts paired with one of the baseline's (or, with `--baseline history`, its golden's test history). It is *kept* unless its pass rate drops 10 points or more below the baseline's, *broken* once a drop shows, and *inconclusive* after 200 pairs with neither. Against a paired baseline, a run that dropped 10 points or more is kept, and one that didn't drop at all is broken, each at most 5% of the time, whatever the baseline's own pass rate; when both arms pass every attempt, it is kept after 38 pairs. Its line shows both tallies and a bound on the drop: `kept · 38 of 38 passed, baseline 38 of 38 · drop <= 0.10 (95%)`. With no baseline to be had (no git repository, no change against HEAD, no history), it is judged by the gate on its own, and the report says so. `--gate '{"good":0.95}'` changes any figure of the gate and `--margin` the drop; `--attempts` and `--passes` give a fixed count instead, which judges every run on its own. [`repair`](./repair.md) verifies each candidate the same way.
- **[`blame`](./blame.md)** decides each probe with a gate that tells a re-asked call that passes 60% of the time or more (*rescued*) from one that passes 10% or less (*lost*): 0.6, 0.1, 0.05 and 20. The 5% is the whole search's, spread over the most probes it can make, 1 + ⌈log₂ *m*⌉ + `scan` for *m* model calls, so every claim of every probe holds together but for it. Each probe runs at its share, about 1% to 0.5% for a search of 5 to 10 probes (a run of 3 to 128 model calls), with its `max` deepened so it reaches as far into the evidence: 20 becomes 31 to 36 attempts. So three straight passes rescue and six or seven straight failures lose, where two and four did at the full 5%. The rule is stated once, `gate: rescue at 60%+, lost at 10%-, <= 5% risk, up to 32 attempts` for a search of 6 probes, and each probe shows its tally and its bound at its own confidence: `rescued · 5 of 10 · rate >= 0.10 (99.2%)`. Between the two rates either verdict can come: at the share of 8 probes (a run of 17 to 32 model calls), a call the model gets right 30% of the time is rescued 35% of the time, lost 47% of the time and left inconclusive 18%. A probe still between the two after its `max` is inconclusive and claims nothing, so the run was lost somewhere between the last call that rescued it and the call before the first found lost after it. The [confidence](./blame.md#how-it-works) is read from the sum of the exact risks of the probes that claimed something: high when it is within the 5%. When the first probe is the inconclusive one, blame says *Not settled from the first model call*, at low confidence, with how to settle it (more attempts, or a lower `good`), rather than *Not rescued*: a run that passes some of the time when resampled from its first call may still be an unlucky answer. With `--concurrency n`, a probe decides on its attempts in the order they started, and starts one only while fewer than *n* have started that it hasn't counted, so at most *n* − 1 run past the attempt that decides. It keeps its first verdict: attempts still running when it came are reported, but never reopen it.

Each run's and each probe's tally, its bound and the risk it was decided at are in their reports, their `--json` and the store.

## In CI

```yaml
- run: shadowlap test 'goldens/*' --junit report.xml --markdown "$GITHUB_STEP_SUMMARY" --annotations
```

An inconclusive golden fails this step, as a failed one does, and the session's [one risk](#one-risk-for-the-whole-suite) counts both: a healthy suite goes red for nothing at most that often. To let inconclusive goldens through with a warning instead, add `--inconclusive warn`; the risk is then spent on failures alone. The GitHub Action has the same choice as its `inconclusive` input, and `--max-attempts` as `max-attempts`, and counts inconclusive goldens in an `inconclusive` output of their own ([inputs and outputs](./ci.md#github-actions)).

The Markdown summary counts inconclusive goldens apart (`### Shadowlap: 1 of 12 recordings is inconclusive`), marks them 🟡, and says what to do, and with several gated goldens it states the session's risk and each one's share; the JSON report has `inconclusive` beside `passed` and `failed`, each result's `verdict`, whatever CI did with it, and the session's `suite`. Fix on failure opens no fix for an inconclusive golden: more attempts settle it, not a change to the agent. `bisect` skips a commit whose verdict is inconclusive, as it skips one it can't build.

## Choosing the figures

- **Use the SPRT where a pass rate is the requirement.** `good` is the rate you need, `bad` the one you must never ship; the closer they are, the more attempts. `risk` 0.05 means a wrong pass at most 1 in 20 at `bad`; a wrong failure, its share of the suite's risk.
- **Use history where each golden's own past is the standard.** `{ "baseline": "history" }` costs 5 to 6 attempts for an unchanged agent, never needs figures of its own, and fails a collapse or a large drop; it catches a drop just past `drop` only sometimes, and needs its history kept, in CI too.
- **Set the suite's risk for the whole session,** not each gate's: `--suite-risk` or `tests.suiteRisk`. A lower one costs attempts only where the evidence is close; leave `max` out so the session can size it.
- **Read the cost before you commit to it.** The forecast says it before every session. The odds above come from the engine's `gateOdds`, which gives them for any figures and any history, as `attemptsToPass` gives the attempts an agent that always passes needs and `planSuite` a session's split ([the engine as a library](./engine.md)); the dashboard's `GET /api/tests/gate` previews them for figures not yet saved.
