# Blame

A run usually goes wrong well before it visibly fails: the agent refunds an order it should have escalated, and the run only looks wrong at the end, when the refund is already issued. `shadowlap blame` finds the model call that lost the run: the last one whose answer, asked again, lets the run pass.

## Blame a run

Give blame the failing run, and what a passing run must do:

```sh
shadowlap blame <run> --expect '{"calls":[{"tool":"issue_refund","after":"lookup_order","args":{"amount":{"<=":100}}}]}'
```

The check is one [rule on calls](./checks.md#rules-on-calls): every refund comes after the order's lookup and is at most $100, the policy's limit. So the same check fits every run of the agent: a good run's $40 refund passes it, and the failing run's $240 refund fails it.

It prints:

```text
⑂ The run was lost at model call #5 (3 of 4)
  The re-asked call #5: rescued · 5 of 10 · rate >= 0.10 (99%); #7, the next model call: lost · 0 of 6 · rate <= 0.59 (99%).
  Checked with 20 fresh pairs: #5 rescued 10 of 20, #7 0 of 20; rescue drops at #5 beyond chance.
  Confidence: high (<= 2.9% risk that the call is wrong: 3 probes decided, at <= 0.8% risk each, and the check of #5, at <= 0.6%)

  At #5  the recording   issue_refund({"order_id":"A-1042","amount":240})
         a rescued fork  "Above the limit.", escalate({"reason":"refund of $240 is above $100"})

  Probes (gate: rescue at 60%+, lost at 10%-, <= 5% risk, up to 31 attempts;
          resample the probed call)
    #1  1 of 4  4 of 7 passed · rate >= 0.11 (99%)   rescued
    #5  3 of 4  5 of 10 passed · rate >= 0.10 (99%)  rescued  ◂ blamed
    #7  4 of 4  0 of 6 passed · rate <= 0.59 (99%)   lost

  63 attempts · 114 upstream requests · ≈$0 spent (no price for small-model) · every call before a probe replayed from the recording
  oracle: the agent exits 0; every issue_refund call: after lookup_order, amount <= 100
  rescued fork: shadowlap diff 01M3R1YKHF 01M3R1YMHF    shadowlap ui 01M3R1YMHF --call 5
…
```

Blame found the call by forking the run, not by reading it. Every call before a probe came from the recording for free, and only the rest ran live, with writes fenced. Before saying the run was lost at #5, it checked #5 against #7 with fresh pairs of attempts: rescue drops there, so the one call is named ([the check](#the-check-of-a-pinned-call)).

### What to do next

The rescued fork is an ordinary run. From there:

- **Compare the two paths**: `shadowlap diff <run> <fork>` compares the rescued fork with the recording.
- **Open the call**: `shadowlap ui <fork> --call <n>` opens the fork at the blamed call.
- **Prove a fix**: [`shadowlap verify`](./verify.md) checks it on the blamed run, on failures it was not written against, and on runs that worked.
- **Have a model propose one**: [`shadowlap repair`](./repair.md) does both steps for a fix to the prompt. It asks a model for rewrites and keeps the one the gate accepts.

Every attempt is a run in the store, marked as a blame attempt and bundled per probe in the dashboard's forks view, the way `--repeat` attempts are. `shadowlap show` prints what blame found on the blamed run and on each attempt.

## How it works

Blame probes the run's model calls, because a model answer is the one thing a probe can ask for again. In order, it:

1. **Replays the run as recorded**, for free, to reproduce the failure against [the oracle](#the-oracle).
2. **Probes the first model call.** When that probe doesn't rescue the run, the search ends there ([below](#when-no-call-rescues-the-run)).
3. **Binary-searches the rest** for the boundary, where rescue falls from rescuable to lost.
4. **Scans** a few calls past the boundary, in case rescue rises again.
5. **Checks a pinned call** against the next with fresh pairs of attempts, before it names the call.
6. **States the range and its confidence**, from the risks of the probes and of the check.

### The oracle

The oracle says what a passing run does. By default it is the agent's exit code: a run passes when the agent exits 0. `--expect` adds [outcome checks](./ci.md#outcome-checks), the same object `expect` takes under `tests` in `shadowlap.config.json`:

- which tools must or must not be called, and with what arguments;
- call counts;
- token and cost budgets;
- text in the output or the final answer.

### The baseline

Blame first replays the run as recorded. That costs nothing, and it must reproduce the failure: the replay has to be clean, and it has to fail the oracle.

- **A run that passes** has nothing to blame.
- **A run whose replay forks by itself** would make every probe ambiguous, so blame refuses it and points to [`shadowlap calibrate`](./normalizers-and-redaction.md#calibrate).

### Probes

A **probe** asks one question of one model call *k*: if the model had answered *k* differently, could the run still have passed? It replays the calls before *k* from the recording, forces *k* live, and lets the rest of the run go live. It does this several times, because one lucky sample proves nothing, and decides after each attempt with a [gate](./gating.md).

The gate tells the re-asked calls apart:

| Verdict | The re-asked call | What it claims |
|---|---|---|
| **Rescued** | Passes 60% of the time or more: it **rescues** the run | The call passes more than 10% of the time |
| **Lost** | Passes 10% or less: the run is **lost** there | The call passes less than 60% of the time |
| **Inconclusive** | Still between the two after the gate's `max` attempts | Nothing |

Each claim can be wrong only that probe's share of the gate's risk. The risk is the whole search's, 5%, split over the most probes the search makes ([the search](#the-search)), so every claim of every probe holds together but for it.

Between the two rates either verdict can come. So a probe says what it found as its verdict, its tally and the bound at its own confidence, exact under the gate's stopping ([reading the evidence](./gating.md#reading-the-evidence)): `rescued · 5 of 10 · rate >= 0.10 (99%)`. The report states the rule once, over the probes.

**How many attempts.** At a share of 1% to 0.5% (a search of 5 to 10 probes), three straight passes rescue and six or seven straight failures lose. A mix takes more attempts, up to the gate's `max` deepened to the probe's share (20 at 5% becomes 31 to 36: as far into the evidence). A probe still between the two after that is inconclusive, which claims nothing.

**A check that can't be decided.** A probe is inconclusive too when an attempt fell short only on a check that could not be decided, such as a judge whose call failed. That attempt is no failure of the answer, and no attempt after it would say more. So the probe stops there, and the report says which check and why.

**When the provider is unavailable.** A provider that is down or overloaded says nothing about the answer either. Take an attempt the agent failed while one of its model calls ended on a 429, a 529 or another 5xx ([gating](./gating.md#when-the-provider-is-unavailable)):

- **Before the model answered anything**: the attempt is run again and never counted.
- **After**: it is counted against either verdict, a failure toward a rescue and a pass toward a loss.

When the provider stays unavailable too many attempts in a row (3 within the first 10 attempts, one more for each tenfold beyond), blame stops there and exits 3: *Stopped before the search finished: provider unavailable: …*. It never calls a run rescued, lost or unrescuable on what the provider never answered.

**Other figures, or a fixed count.** `--gate '{"good":0.5}'` changes any of the figures (`good`, `bad`, `risk`, `max`). `--attempts` and `--passes` give a fixed count instead, which stops as soon as the attempts left can no longer change its verdict. A fixed count's probes can be wrong as often as their count allows (2 of 5: 8.8% a probe).

**Attempts at once.** With `--concurrency`, a probe runs that many attempts at once and decides on them in the order they started. So an attempt that takes longer because it fails counts where it would have one after another. Another attempt starts only while fewer than that many have started that the probe hasn't counted.

Once that many have, the next waits for the earliest of them to end, rather than start a live, paid fork the probe couldn't count yet. So with `--concurrency n` at most *n* − 1 attempts run past the one that decides. The probe's first verdict stands: attempts still running when it came are listed with the probe, but never reopen it.

### The search

Rescue gets harder the later it starts. Resampling from the first model call re-runs almost the whole agent, and resampling the last can only change the ending. So the rate at which resampling a call rescues the run falls as the calls go on, and the run was lost where it falls from rescuable to lost.

That place is the **boundary**: the calls from the last one rescued 60% of the time or more to the one before the first rescued 10% or less. A sharp drop makes it one call, a gradual one several.

Blame probes the first model call, then binary-searches the rest, so a run with 30 model calls needs about six probes, not thirty. The most a search makes, `1 + ⌈log₂ m⌉ + scan` for *m* model calls, is what the risk is split over.

Then **the run was lost between the last call that rescued it and the call before the first found lost after it**:

- **One call**, when those two are neighbours and [the check](#the-check-of-a-pinned-call) finds rescue drops there: *the run was lost at model call #5*.
- **A range** otherwise: *lost between model calls #7 and #9*, where the probes inside claimed nothing.

That range holds a call of the boundary whenever every claim holds. The rescued call passes more than 10% of the time, so it comes before the first call at 10% or less. The call found lost passes less than 60%, so it comes after the last at 60% or more.

### The scan

Nothing guarantees rescue falls monotonically: a run can be rescuable at 10, not at 12, and again at 14. After the binary search, blame also probes the next few calls past the boundary (`--scan`, 2 by default). That also finds the call that closes a range when the call after the boundary was inconclusive.

If one of them rescues the run past a call found lost, rescue rose again. The search moves on past it, and its extra probes add their risks to the bound. When the rise is more than chance explains (Fisher's exact test on the two probes, at the gate's risk), nothing bounds the location and the confidence is low.

### The check of a pinned call

The two claims that pin a call hold as well for two neighbours in the middle of a gradual decay as for a sharp drop: two calls that both pass 40% of the time are rescued and lost as readily. So before blame says the run was lost at a call, it checks the call against the next with fresh pairs of attempts, one at each call in every pair, and asks whether rescue drops there.

It is the [paired test](./verify.md#good-runs-against-their-own-baseline) verify keeps a good run by, on the next call's attempt less the pinned call's. It ends one of three ways:

| Verdict | When | Then |
|---|---|---|
| **Pinned** | The call is rescued more often than the next, beyond chance | The run was lost at that call |
| **Gradual** | It is shown rescued less than 50 points (the gate's two rates apart) more often | The range is the two calls, and no one call lost the run |
| **Neither** | After twice a probe's attempts in pairs | The two calls are the range too |

Pinned keeps *the run was lost at model call #5*, with the check under it: *Checked with 12 fresh pairs: #5 rescued 12 of 12, #6 0 of 12; rescue drops at #5 beyond chance.* Otherwise the report says *the run was lost gradually, around model calls #17 and #18*.

**Why fresh pairs.** The probes' own tallies are what picked the call: read off them, a rescue and a loss look apart by selection alone.

**Its risk.** Each verdict is wrong at most a probe's share of the risk, over every way the pairs can come. Its exact risk joins the error bound, and at the defaults the bound still keeps within 5% for a run of up to a million model calls.

**What it costs.** A sharp drop from 95% to 0 takes about 12 pairs, one from 60% to 10% about 24, and two neighbours both near 40% about 25.

**What it changes.** Take a run whose rescue falls from 95% to 0 over calls 5 to 28 of 30, in the engine's simulation. There, blame says with high confidence that the run was lost at one call 0.5% of the time, where unchecked it said so 71.5% of the time. Sharp drops from 95% to 0 and from 60% to 10% are still pinned 100% and 98.1% of the time.

### Confidence

The confidence is read from the range's **error bound**: the sum of the exact risks of the probes that claimed something, and of the check's when it found a drop or none. Each probe's risk (`probeRisk`) is worked out over every look of its gate at its two rates.

| Confidence | The range is wrong at most            |
| ---------- | ------------------------------------- |
| **high**   | The gate's risk, 5%                   |
| **medium** | Twice that, or 20%, whichever is more |
| **low**    | More than that, or nothing bounds it  |

Nothing bounds it when the search stopped, the first probe couldn't tell, or rescue rose again past a call found lost by more than chance explains.

A seeded simulation of the whole search in the engine's tests holds it to that. It covers sharp drops (0.95 to 0, 0.8 to 0.05, and 0.6 to 0.1, on the gate's own rates), gradual decays and runs no call rescues. On all of them, whenever blame says high, the range holds the true boundary at least 98.7% of the time.

The probes' rescue rates are also fitted non-increasing (isotonic regression). Where they rose as the calls went on, the report says which probes the fit read as one rate.

## The rescue

By default a probe asks the model the same question again, with the request exactly as recorded, and relies on sampling to produce a different answer. At temperature 0 a model answers the same way every time, so add `--set temperature=1` to let a probe sample:

```sh
shadowlap blame <run> --expect @checks.json --set temperature=1
```

The setting goes where the provider keeps it (Gemini's `generationConfig`, Bedrock Converse's `inferenceConfig`), so this works on every provider; see [patching parameters](./interventions.md#patch-parameters). `--set key=value` changes any other request field from the probed call on, like `--set` on [`replay`](./interventions.md#patch-parameters), where the provider keeps it.

`--model` rescues with another model instead, from the probed call on:

```sh
shadowlap blame <run> --expect @checks.json --model claude-opus-5-5
```

### When no call rescues the run

When the first model call's probe finds the run lost, resampling from it, and so from any later call, rescues the run less than 60% of the time. The report then says **Not rescued from any model call**, when that holds but for the gate's risk. A fixed count, which can be wrong more often, says only *Not rescued from the first model call*. `shadowlap show`, the terminal UI, repair's report and the dashboard say it in the same words.

That is a finding, not an error: the failure is not one unlucky answer the model gets right most of the time. It comes from the prompt, the tools, the harness, or a task the model cannot do. Blame with a stronger model tells the last two apart:

- **`--model` finds a call and resampling did not**: the model's capability is the problem.
- **Neither finds one**: look at the code and the tools.

When some attempts from the first call passed, the report says so. An answer the model gets right only sometimes may still be what lost the run, and a lower bar (`--gate '{"good":0.3,"bad":0.05}'`) finds where.

### When no answer lost the run

Two findings say outright that no answer of the model's lost the run:

- **The same write failed again.** Every attempt from the first model call makes the write that failed in the recording again, and meets its error. The report names the tool and the error.
- **The passing attempts answered as recorded.** Probes do rescue the run, yet every attempt that passed answered the call the search ended on as the recording did. Something after it made the difference, such as a read that ran live or a write that was stubbed, so blame blames no call and says why.

## Blaming one part of the agent

An agent is often more than one model: a planner and an executor, or, in a benchmark, the agent and a model playing its customer. `--scope agent` probes only the model calls made in that [scope](./sdk.md#scopes), or in one nested in it, so the call blamed is always the agent's:

```sh
shadowlap blame <run> --expect @checks.json --scope agent
```

A customer's answer that led nowhere is part of the run the agent had to handle, not something to fix. The report counts steps among the scope's calls only, and blame says which scopes a run has when the one given isn't among them.

## Side effects

Blame never lets a probe act on the world. After the fork, tools do this:

| Tool | After the fork |
|---|---|
| `write`, with `--writes stub` (the default) | Stubbed: the agent receives the tool's `onFork` value and carries on as if the write had succeeded |
| `write`, with `--writes block` | Each write throws |
| `write`, with `--writes allow` | Not accepted |
| A write the recording made: the same tool with the same arguments | Gets what it got then, an error included |
| `read` | Runs live, as in a replay |
| `read`, with `--reads replay` | Served from the recording when its arguments match |

**Stub or block.** A stub is closest to what happened in the recording. Blocking is safer for a tool with no `onFork`, but an agent that stops on the error fails the probe for a reason the recording never had.

**Writes the recording made.** Nothing runs either way, and a stub never fails. Otherwise a run that failed because a write did, such as a digest posted to a channel that doesn't exist, would pass every probe whatever the model answered.

**A failed write in the rescue.** A write can fail when it was recorded, then be stubbed in the fork that rescued the run, because the model called it with other arguments. Such a write is named in a warning: whether it would have failed again is not known.

## Reading the report

The report leads with where the run was lost, then the evidence for it:

| Line | Meaning |
|---|---|
| **The run was lost at model call #n (k of m)** | The boundary is pinned at one call; *k of m* is its position among the run's model calls |
| **The run was lost gradually, around model calls #n and #n′** | The check found no drop from one to the next beyond chance |
| **The run was lost between model calls #n and #n′** | The probes between them were inconclusive |
| **The re-asked call #n: …; #n′, the next model call: …** | The evidence on both sides of the boundary |
| **Checked with N fresh pairs: #n rescued …, #n′ …** | The check of a pinned call: its pairs, what each call passed, and what they show |
| **Not rescued from any model call** | Even resampled from the first model call, the gate found the run lost |
| **Inconclusive at the first model call** | The first probe could not tell a rescue from a loss |
| **Confidence** | *high*, *medium* or *low*, read from the error bound it states |
| **At #n** | What the model answered at the blamed call in the recording, and in a fork that went on to pass |
| **Probes** | Every call probed, with its tally, the bound of its pass rate and its verdict |

**Lost at one call.** #n is the last model call whose resampling rescued the run. The next one was found lost, and the check found rescue drops from one to the other: the boundary is pinned.

**Lost gradually.** The probes pinned #n, but the check found no drop from it to the next beyond chance: rescue falls gradually there, and no one call lost the run. Look at how the conversation drifts up to them, not at one answer.

**Lost between two calls.** #n is the last call that rescued the run, and #n′ the call before the first found lost after it. The probes between them were inconclusive, so the run may have been lost at any of these calls, and the report names them.

**The evidence.** The full line reads *The re-asked call #n: rescued · k of m · rate >= …; #n′, the next model call: lost · 0 of 6 · rate <= …*: each probe's verdict, its tally and the bound of its pass rate, under the gate's rule, stated over the probes. Under a fixed count (`--attempts`, `--passes`) it reads *Resampling #n rescued k of m attempts; resampling #n′ … rescued …*.

**The check.** It shows one of *rescue drops at #n beyond chance*, *rescue falls by less than 50 points from one to the next*, or *not enough to tell*, which leaves the two calls as the range too.

**Not rescued from any model call.** The run was rescued less than 60% of the time from the first model call, and so from any call, wrong at most the gate's risk. *Not rescued from the first model call* says the same under a rule that can be wrong more often (a fixed count).

**Inconclusive at the first model call.** Resampled from the first model call, the run passed some attempts and failed others, and the gate could not tell a rescue from a loss within its attempts: *inconclusive*, with its tally and bound. Or an attempt there could not be judged, and the report gives the check and why.

Confidence is then low, and the report says how to settle it: more attempts (`max`) or a lower bar (`good`) with `--gate`, or what decides the check. The run keeps it so: `shadowlap show`, its page, Needs a look, Fixes and a repair that reuses the blame say *inconclusive at the first model call*, never *not rescued*.

**Confidence.** The line states its error bound, the sum of the risks of the probes that decided: `<= 2.9% risk that the call is wrong: 3 probes decided, at <= 0.8% risk each, and the check of #5, at <= 0.6%`.

- *high*: within the gate's risk, 5%.
- *medium*: within twice that or 20%, as a fixed count's few probes are (2 of 5 can be wrong 8.8% of the time a probe).
- *low*: beyond, or nothing bounds it: the search stopped early, the first probe was inconclusive, or rescue rose again past a call found lost by more than chance explains.

**At #n.** This is the contrast to act on: the bad path and a good one, from the same point.

**Probes.** Under the gate's rule, each line gives a probed call, how many attempts passed with the bound of its pass rate at the probe's own confidence, and the verdict: rescued, lost or inconclusive. Under them come any probes the non-increasing fit read as one rate because rescue rose as the calls went on (`#7, #9 read as one rate, 0.40: rescue rose after it fell`).

## Fixes

Every blame is kept in the store whole, with the fix it opens or joins. A **fix** is one failure, from the blame that reproduced it to a change that held: [`shadowlap fix`](./cli.md#fix) lists them and shows each one's blame, repair and verify. The report ends with it:

```text
  fix fx-01M3RZ4XKN · issue_refund: amount 240 > 100 · opened · shadowlap fix show fx-01M3RZ4XKN
```

Each blame also logs a `blame.done` event in the store's activity. Run by a dashboard job, it reports a link to the fix's Blame step.

### Which fix a blamed run goes to

Labels come first, because they are how you group runs, and the check decides where they can't. The check is the `--expect` the blame was given, whatever order its keys are in; without `--expect`, it is the exit code. A fix's labels are whatever labels its failing runs carry, so a label given to its runs later counts. The label `good` never names a failure.

The first rule that matches decides:

1. **A run that already fails in a fix** stays in it, so blaming it again, with `--model` say, adds a blame to the same fix. That holds for an applied fix too: an old recording can't show the failure coming back.
2. **A fix that shares one of its [labels](./cli.md#label-note)** and has the same check.
3. **A fix that holds every label the run has**, whatever its check: the label decides. A run labelled `refund-over-limit` and blamed under another check joins the `refund-over-limit` fix.
4. **A fix with no labels and the same check.** A run with no labels joins the fix with its check, labelled or not, when only one fix has it.
5. **Otherwise the blame opens a fix of its own**, titled by how the recording failed the check, in plain words: *issue_refund called with amount 240*, *send_email called twice, not once*, *Output never says "refund issued"*.

`shadowlap fix title` replaces a fix's title with one of your own.

A run that shares one label with a fix but carries another the fix doesn't hold, under another check, is taken for another failure. A run labelled `customer-x` and `double-email` opens a fix of its own next to a `customer-x`, `refund-over-limit` fix, rather than hide in it. Where several fixes would take a run, the one sharing more of its labels wins, then the first opened. Runs labelled differently stay apart even under the same check.

- **A blame that stopped early** opens or joins a fix too: it replayed the run and saw it fail before it probed anything, so the failure is reproduced.
- **A blame that refused** (the run passes, or doesn't replay as recorded) leaves nothing behind.
- **An applied fix is finished**: no other run joins it, and the same failure in a run recorded after it shipped opens another fix.

## Cost

Each probe replays everything before its call for free. The calls after it run live, so later probes are cheaper. The header prints the bound before anything runs:

- **Probes**: at most `1 + ⌈log₂ m⌉ + scan` for *m* model calls, when rescue never rises again past a call found lost.
- **Attempts a probe**: at most the gate's `max` deepened to its share of the risk (31 to 36 at the defaults, or `--attempts` with a fixed count). Usually far fewer, because a probe stops once its verdict is settled.
- **The check of a pinned call**: up to twice a probe's attempts, in pairs.

**Why it costs what it does.** Spending the risk across the probes asks each for more evidence than a probe at the full 5% needed: three passes to rescue where two did, six or seven failures to lose where four did. The check of a pinned call takes a dozen pairs or more.

In the engine's simulation, a search of 30 calls takes 47 to 147 attempts on average where, at the full 5% a probe and unchecked, it took 15 to 56, about three times as many. That buys a location whose error is bounded, and a call named only when rescue drops there.

**A budget.** `--budget <usd>` starts no attempt once that much is spent on live model calls. Attempts already running finish, so the total can pass the budget by one attempt per concurrent slot, or by a pair in the check of a pinned call. It needs prices for the models involved: an unpriced model counts as $0, and the report names it.

**Stopping early** still prints what the search found so far. Attempts the provider was unavailable for are paid for and counted apart, never as attempts: *0 attempts (and 3 the provider was unavailable for, not counted)*. One it cut short after the model answered is an attempt, counted against either verdict.

## Flags

These are the flags this page covers. [The CLI reference](./cli.md#blame) lists every one.

| Flag | What it does | Default |
|---|---|---|
| `--expect <json\|@file>` | What a passing run must do besides exiting 0 ([the oracle](#the-oracle)) | — |
| `--gate <json\|@file>` | The figures a probe decides by: `good`, `bad`, `risk`, `max` ([probes](#probes)) | `{"good":0.6,"bad":0.1,"risk":0.05,"max":20}` |
| `--attempts <n>`, `--passes <n>` | A fixed count instead of the gate | — |
| `--model <model>` | Rescue with this model from the probed call on ([the rescue](#the-rescue)) | The recorded model |
| `--set <key=value>` | Set a request field from the probed call on, such as `temperature=1` | — |
| `--scope <name>` | Probe only the model calls made in this [scope](#blaming-one-part-of-the-agent) | Every model call |
| `--scan <n>` | Model calls past the boundary to probe too ([the scan](#the-scan)) | 2 |
| `--writes stub\|block` | What write tools do after the fork ([side effects](#side-effects)) | `stub` |
| `--reads live\|replay` | What read tools do after the fork | `live` |
| `--concurrency <n>` | Attempts of one probe run at once; probes still run one after another, since each depends on the last | 1 |
| `--budget <usd>` | Start no attempt once this much is spent on live model calls ([cost](#cost)) | — |
| `--timeout <seconds>` | Stop an attempt after this long and count it as failed, for an agent that can loop | — |
| `--json` | Print the report as JSON on stdout ([JSON](#json)) | — |

## Exit status

| Status | Meaning |
|---:|---|
| 0 | The search reached a verdict: a blamed call, or no call that rescues the run |
| 1 | Blame refused what it saw, such as a run that passes its oracle or does not replay as recorded |
| 2 | Blame can't start, such as on a run with no model call to probe ([the CLI reference](./cli.md#blame)) |
| 3 | It stopped before a verdict: the budget spent, a provider that stayed unavailable, or a search *inconclusive at the first model call* |
| 128 + n | A stop signal: 130 for Ctrl-C |

## JSON

`--json` prints the report on stdout (progress still goes to stderr), for scripts and [coding agents](./agents.md):

| Field | Type | Meaning |
|---|---|---|
| `runId` | string | The run blamed |
| `outcome` | string | `blamed`, `unrescuable` or `stopped`; `error` when blame refused |
| `error` | object | Only when blame refused: `error.reason` and `error.message` ([when blame refuses](#when-blame-refuses)) |
| `blamed`, `lost` | object or null | `{ callNo, step, passes, attempts }` for the blamed call and the one after it |
| `range` | object or null | The calls the run was lost between, by call number ([below](#range)) |
| `pin` | object or null | The check of the call the probes pinned ([below](#pin)); `null` when they pinned none |
| `errorBound` | number or null | The most the range, or the finding that no call rescues the run, is wrong, from 0 to 1 |
| `confidence` | string | `high`, `medium` or `low`, read from `errorBound` |
| `fit` | array | Each probe's rescue rate fitted non-increasing (isotonic regression), in call order: `{ callNo, rate }` |
| `contrast` | object or null | `{ callNo, recorded, rescued, rescuedRunId }`: the answer at the blamed call, in the recording and the rescued fork |
| `sameAnswer` | object or null | `{ callNo, runId, why }` when every attempt that passed answered as the recording did |
| `failedWrite` | object or null | `{ name, message, callNo }` when every attempt met a recorded write's error |
| `probes` | array | Each probe ([below](#each-probe)) |
| `oracle`, `recordedFailures` | array | What a passing run must do, and how the recording fails it |
| `rescue` | object | `{ fields }`: the request fields a probe changed; empty when it resampled |
| `gate` | object or null | The search's gate, `{ kind, good, bad, risk, max }`, its risk the whole search's |
| `probeBudget` | number or null | The most probes the search's risk was split across |
| `probeGate` | object or null | The gate each probe ran under at its share, `max` deepened to it |
| `modelCalls` | number | The agent's model calls, never a judge check's |
| `attemptsPerProbe`, `passesNeeded` | number | With a gate, its `max`, and the fewest passes that can rescue (2) |
| `nonMonotone` | array | Each place rescue worked again past a call found lost: `{ lost, rescued }` call numbers |
| `cost` | object | What the search spent: `{ attempts, unavailable, spent, upstreamRequests, unknownModels }` |
| `stopReason` | string or null | Why it stopped early; `provider unavailable: …` for a provider that stayed unavailable |
| `judge` | object or null | `{ spent, upstreamRequests }`: what [judge checks](./judges.md)' calls cost; `null` when no judge was asked live |
| `warnings` | array | What the replays warned about, such as a connection that bypassed shadowlap |
| `fix` | object or null | `{ fixId, title, status, opened }`: the [fix](#fixes) the blame opened (`opened: true`) or joined |

Some fields need more than a line:

- **`contrast`** holds the model's answers as blocks: `text`, `thinking`, and `tool_call` with `name` and `input`.
- **`sameAnswer`** names that call, an attempt that passed, and why it passed; `outcome` is then `unrescuable`.
- **`failedWrite`** is set when no probe rescued the run and every attempt from the first model call (`callNo`) met the error a write got when the run was recorded. It names the tool and the error.
- **`gate`**, **`probeBudget`** and **`probeGate`** are `null` when a fixed count (`--attempts`, `--passes`) decided.
- **`cost.unavailable`** counts the attempts the provider was unavailable for: retried, and never counted in `cost.attempts`.
- **`judge`** is apart from `cost`, which is the agent's alone. `--budget` counts both.
- **`fix`** is `null` when the store could not keep it.

### `range`

`range` is `{ from, to }`, the calls the run was lost between, by call number:

| Value                    | Means                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------- |
| `from` and `to` differ   | From the last call that rescued the run to the one before the first found lost after it |
| `from` and `to` the same | The boundary is pinned at that call                                                     |
| With `gradual: true`     | The call the probes pinned and the next: its check found no drop there                  |
| `null`                   | No call rescued the run                                                                 |

### `pin`

`pin` is the check of the call the probes pinned:

| Field | Type | Meaning |
|---|---|---|
| `callNo`, `next` | number | The call the probes pinned, and the next one |
| `verdict` | string | `pinned`, `gradual` or `inconclusive` ([the check](#the-check-of-a-pinned-call)) |
| `pairs` | number | The pairs it ran |
| `passes`, `nextPasses` | number | The passes at the call, and at the next |
| `dropped`, `rose` | number | The pairs that passed at the call and failed at the next, and the other way round |
| `rule` | object | `margin`, the drop it tells from none; `risk`, a probe's share; `max` pairs |
| `risk` | number | The most its verdict can be wrong, exactly; 0 when it claimed nothing |
| `undecided` | string or null | Why an attempt could not be judged, when one stopped it |
| `cutShort` | number | Attempts the provider cut short after the model answered, counted against either verdict |
| `runs` | array | Each pair's attempts, as `{ at, next }` ([each attempt](#each-attempt)) |

### Each probe

Each entry of `probes`:

| Field | Type | Meaning |
|---|---|---|
| `callNo`, `step` | number | The probed call, and its place among the run's model calls |
| `passes`, `attempts` | number | The attempts that passed, and the attempts run |
| `rescued` | boolean | Whether the probe rescued the run |
| `risk` | number | The most its claim can be wrong, exactly, at the gate's two rates |
| `unavailable` | number | Its attempts the provider was unavailable for before the model answered: retried, never counted |
| `cutShort` | number | Those it cut short after, counted against either verdict, each with `cutShort: true` among `runs` |
| `decision` | string or null | The gate's: `pass`, `fail` or `inconclusive` |
| `rate` | object or null | The `decision`, the `interval` of the pass rate and the `sentence` |
| `undecided` | string or null | Why an attempt could not be judged; `null` otherwise |
| `runs` | array | Each attempt ([below](#each-attempt)) |

**`decision`** is `null` under a fixed count, unless an attempt could not be judged, which makes it `inconclusive`.

**`rate`** gives the `interval` exact under the gate's stopping, and the `sentence` as the report words it: `rescued · 5 of 10 · rate >= 0.10 (99%) · gate: rescue at 60%+, lost at 10%-, <= 5% risk, up to 31 attempts`. It is `null` under a fixed count, or when an attempt that could not be judged stopped the probe.

### Each attempt

Each entry of a probe's `runs`, and each side of a `pin` pair:

| Field | Type | Meaning |
|---|---|---|
| `runId` | string | The attempt's run |
| `passed` | boolean | Whether it met the oracle |
| `verdict` | string | `passed`, `failed`, or `inconclusive` when all it fell short on is a check that could not be decided |
| `exitCode` | number | The agent's exit code |
| `failures` | array | Why it failed the oracle |
| `spent`, `upstreamRequests` | number | What its live model calls cost, and the requests it sent upstream |
| `cutShort` | boolean | `true` when the provider cut it short after the model answered |
| `unrecordedTools` | array | The tools its model called that its run never recorded, which ran for real in it |

`unrecordedTools` lists them as [`show --json`](./cli.md#show) does.

## When blame refuses

Blame refuses a run it can't search, and says why:

| Message | `error.reason` | Why | What to do |
|---|---|---|---|
| *passes its oracle when replayed* | `passes` | The replayed run does what the oracle asks, so there is no failure | Say what it should have done with `--expect` |
| *fails only because … has no price* | `unpriced` | Its only failed check is a cost check, which can't be judged for a model with no price, whatever the model answers | Add the model under `prices` in `shadowlap.config.json`, and blame again if it still fails |
| *--expect has a check no attempt can decide* | — | A [judge check](./judges.md) whose judge can't be asked live, refused before anything runs | Give the judge its provider's key, or leave it out of `--expect` |
| *has a check that can't be decided as recorded* | `inconclusive` | A check is [inconclusive](./checks.md#how-a-check-comes-out) on the free replay, so it would be on every probe too | Fix the check, or leave it out of `--expect` |
| *does not replay as recorded* | `diverged` | The replay forks by itself, so a probe could not tell a changed answer from a changed prefix | [`shadowlap calibrate`](./normalizers-and-redaction.md#calibrate), then blame again |
| *forked at call n instead* | `prefix` | An attempt ran a prefix the recording doesn't hold | As above. Branches that run at once need [scopes](./sdk.md#scopes) |
| *made no model calls* | `no-model-calls` | There is no model answer to blame, or none in the `--scope` given | Check the scope names blame lists |
| *did not replay through shadowlap* | `bypassed` | The recording has model calls and the replay made none | Replay in the environment you recorded in |

A Ctrl-C before the first probe ends it with `interrupted`. With `--json`, a refusal prints the `runId`, `outcome` `error`, `error.reason` and `error.message`, and `judge` for what [judge checks](./judges.md) spent before it refused.

**A judge that can't be asked live** has no key for its provider, and no upstream set for it. Each probe is a fork, which asks the judge live, so every attempt would read inconclusive and none could pass. [`shadowlap check`](./checks.md#try-a-check-on-your-recordings) judges recordings by the verdicts they hold.

**A check that can't be decided as recorded** is such as a judge with no verdict, or a `when` whose condition reads a value the run doesn't have. Fix it at the source, such as the path a condition reads: `shadowlap doctor` names one no recorded call has.

**A replay that bypassed shadowlap** means the agent reached its model some other way. That is often a local server shadowlap was told about when recording (`SHADOWLAP_UPSTREAM_OPENAI`), but not for the replay.

## Limits

- **Blame points at a model call**, because a model answer is the one thing a probe can ask for again. A failure caused by a tool returning bad data shows up as *not rescued*, or as blame on a call that read the bad data; an [override](./interventions.md#override-a-tool-result) tests that directly.
- **A write that failed**, such as a post to a channel that doesn't exist, shows up as *not rescued* with the write and its error when every attempt makes it again, since a write a probe repeats gets its recorded error. One a probe makes with other arguments is stubbed, so a rescue that went through it comes with a warning.
- **The verdict is statistical**, and says what its gate tells apart: a call that passes 60% of the time or more from one that passes 10% or less, with the gate's risk spent across the probes. [Gating](./gating.md) has the maths.
- **It never claims a rate.** A call the model gets right 30% of the time is between the two, and at a search's usual share of the risk is rescued 35% of the time, lost 47%, and left inconclusive 18%. Its tally and bound say what the attempts show.
- **A partial rescue can read as none.** A run rescued 45% of the time from its first calls, then never, is reported not rescued at 60%+ from any call, with high confidence, about 7% of the time. That is true at the gate's bar, and the first probe's tally shows the passes.
- **For an agent that rarely succeeds**, lower the bar, as in `--gate '{"good":0.3,"bad":0.05}'`, which takes more attempts.
- **The bound rests on rescue falling as the calls go on.** A rise the probes show beyond chance voids it; one they never probed, a dip further along, goes unseen: the binary search finds *a* boundary.

## See also

- [Verify](./verify.md): prove a fix on the blamed run, on failures it was not written against, and on good runs.
- [Repair](./repair.md): blame failing runs, ask a model for rewrites, and keep the one verify accepts.
- [Gating](./gating.md): the gate a probe decides by, and its maths.
- [Outcome checks](./ci.md#outcome-checks): what `--expect` takes.
- [`shadowlap blame`](./cli.md#blame) in the CLI reference: every flag and exit status.
