# Blame

A run usually goes wrong well before it visibly fails. The agent refunds an order it should have escalated, and the run only looks wrong at the end, when the refund is already issued. `shadowlap blame` finds the model call that lost the run: the last one whose answer, asked again, lets the run pass.

```sh
shadowlap blame <run> --expect '{"tools":{"issue_refund":0}}'
```

```
⑂ The run was lost at model call #5 (3 of 4)
  The re-asked call #5: rescued · 3 of 4 · rate >= 0.30 (95%); #7, the next model call: lost · 0 of 4 · rate <= 0.49 (95%).
  Confidence: high (rescue stops cleanly at the boundary)

  At #5  the recording   issue_refund({"order_id":"A-1042","amount":240})
         a rescued fork  "Above the limit.", escalate({"reason":"refund of $240 is above $100"})

  Probes (gate: rescue at 60%+, lost at 10%-, <= 5% risk, up to 20 attempts;
          resample the probed call)
    #1  1 of 4  2 of 2 passed · rate >= 0.34 (95%)  rescued
    #5  3 of 4  3 of 4 passed · rate >= 0.30 (95%)  rescued  ◂ blamed
    #7  4 of 4  0 of 4 passed · rate <= 0.49 (95%)  lost

  10 attempts · 22 upstream requests · ≈$0.093 spent · every call before a probe replayed from the recording
  oracle: the agent exits 0; issue_refund called 0 times
  rescued fork: shadowlap diff 01M3R1YKHF 01M3R1YMHF    shadowlap ui 01M3R1YMHF --call 5
```

It found the call by forking the run, not by reading it: every call before a probe came from the recording for free, and only the rest ran live, with writes fenced.

## How it works

**The oracle** says what a passing run does. By default it is the agent's exit code: a run passes when the agent exits 0. `--expect` adds [outcome checks](./ci.md#outcome-checks), the same object `expect` takes under `tests` in `shadowlap.config.json`: which tools must or must not be called and with what arguments, call counts, token and cost budgets, text in the output or the final answer.

**The baseline.** Blame first replays the run as recorded. That costs nothing, and it must reproduce the failure: the replay has to be clean, and it has to fail the oracle. A run that passes has nothing to blame; one whose replay forks by itself would make every probe ambiguous, so blame refuses it and points to [`shadowlap calibrate`](./normalizers-and-redaction.md#calibrate).

**A probe** asks one question of one model call *k*: if the model had answered *k* differently, could the run still have passed? It replays the calls before *k* from the recording, forces *k* live, and lets the rest of the run go live. It does this several times, because one lucky sample proves nothing, and decides after each attempt with a [gate](./gating.md) that tells a re-asked call that passes 60% of the time or more, which **rescues** the run, from one that passes 10% or less, where the run is **lost**, each verdict wrong at most 5% of the time at those two rates. Between them either verdict can come, so a probe says what it found as its verdict, its tally and the Wilson bound (`rescued · 3 of 4 · rate >= 0.30 (95%)`), and the report states the rule once, over the probes. Two straight passes rescue and four straight failures lose, the cost of the 2 of 5 that blame used before; a mix takes more attempts, up to 20, and a probe still between the two after that is **inconclusive**, which the search counts as not rescued. So is a probe with an attempt that all it fell short on is a check that could not be decided, such as a judge whose call failed: that attempt is no failure of the answer, and no attempt after it would say more, so the probe stops there, and the report says which check and why. `--gate '{"good":0.5}'` changes any of the figures (`good`, `bad`, `risk`, `max`); `--attempts` and `--passes` give a fixed count instead, which stops as soon as the attempts left can no longer change its verdict. With `--concurrency`, a probe runs that many attempts at once and decides on them in the order they started, so an attempt that takes longer because it fails counts where it would have one after another. A new attempt starts only while fewer than that many have started that the probe hasn't counted: once that many have, the next waits for the earliest of them to end rather than start a live, paid fork the probe couldn't count yet, so with `--concurrency n` at most *n* − 1 attempts run past the one that decides. The probe's first verdict stands, and attempts still running when it came are listed with the probe but never reopen it.

**The search.** Rescue gets harder the later it starts: resampling from the first model call re-runs almost the whole agent, and resampling the last can only change the ending. So probes rescue the run up to some model call and stop rescuing after it. That boundary is the answer. The last call that still rescues is the one whose recorded answer lost the run, and from the next call on the failure was already unavoidable. Blame probes the first model call, then binary-searches the rest for the boundary, so a run with 30 model calls needs about six probes, not thirty.

**The scan.** Nothing guarantees a clean boundary: a run can be rescuable at 10, not at 12, and again at 14. After the binary search, blame also probes the next few calls past the boundary (`--scan`, 2 by default). If one of them rescues the run, the search moves on past it, and the confidence it reports drops to low.

## The rescue

By default a probe asks the model the same question again, with the request exactly as recorded, and relies on sampling to produce a different answer. At temperature 0 a model answers the same way every time, so add `--set temperature=1` to let a probe sample. The setting goes where the provider keeps it (Gemini's `generationConfig`, Bedrock Converse's `inferenceConfig`), so this works on every provider; see [patching parameters](./interventions.md#patch-parameters).

`--model` rescues with another model instead, from the probed call on:

```sh
shadowlap blame <run> --expect @checks.json --model claude-opus-5-5
```

When no probe rescues the run, even from the first model call, the report says **Not rescued from any model call**. That is a finding, not an error: the failure is not one unlucky answer. It comes from the prompt, the tools, the harness, or a task the model cannot do. Blame with a stronger model tells the last two apart. If `--model` finds a call and resampling did not, the model's capability is the problem; if neither finds one, look at the code and the tools.

Two findings say outright that no answer of the model's lost the run. When every attempt from the first model call makes the write that failed in the recording again and meets its error, the report names the tool and the error. And when probes do rescue the run, yet every attempt that passed answered the call the search ended on as the recording did, the answer is not what lost it: something after it made the difference, such as a read that ran live or a write that was stubbed. Blame then blames no call and says why.

`--set key=value` changes any other request field from the probed call on, like `--set` on [`replay`](./interventions.md#patch-parameters), where the provider keeps it.

## Blaming one part of the agent

An agent is often more than one model: a planner and an executor, or, in a benchmark, the agent and a model playing its customer. `--scope agent` probes only the model calls made in that [scope](./sdk.md#scopes), or in one nested in it, so the call blamed is always the agent's. A customer's answer that led nowhere is part of the run the agent had to handle, not something to fix. The report counts steps among the scope's calls only, and blame says which scopes a run has when the one given isn't among them.

## Side effects

Blame never lets a probe act on the world. After the fork, `write` tools are stubbed (`--writes stub`, the default): the agent receives the tool's `onFork` value and carries on as if the write had succeeded, which is closest to what happened in the recording. `--writes block` makes each write throw instead. That is safer for a tool with no `onFork`, but an agent that stops on the error fails the probe for a reason the recording never had. `--writes allow` is not accepted.

A write the recording made, the same tool with the same arguments, gets what it got then instead, an error included. Nothing runs either way, and a stub never fails: a run that failed because a write did, a digest posted to a channel that doesn't exist, would otherwise pass every probe whatever the model answered. A write that failed when it was recorded and was stubbed in the fork that rescued the run, because the model called it with other arguments, is named in a warning: whether it would have failed again is not known.

`read` tools run live after the fork, as in a replay; `--reads replay` serves them from the recording when their arguments match.

## Reading the report

| Line | Meaning |
|---|---|
| **The run was lost at model call #n (k of m)** | The last model call whose resampling rescued the run. *k of m* is its position among the run's model calls |
| **The re-asked call #n: rescued · k of m · rate >= …; #n′, the next model call: lost · 0 of 4 · rate <= …** | The evidence on both sides of the boundary: each probe's verdict, its tally and the Wilson bound of its pass rate, under the gate's rule, stated over the probes. Under a fixed count (`--attempts`, `--passes`): *Resampling #n rescued k of m attempts; resampling #n′ … rescued …* |
| **Not rescued from any model call** | Even resampled from the first model call, the gate found the run lost there, telling it from one rescued 60% of the time or more: the failure is not one unlucky answer |
| **Not settled from the first model call** | Resampled from the first model call, the run passed some attempts and failed others, and the gate could not tell a rescue from a loss within its attempts: *inconclusive*, with its tally and Wilson bound; or an attempt there could not be judged, with the check and why. Confidence is low, and the report says how to settle it: more attempts (`max`) or a lower bar (`good`) with `--gate`, or what decides the check. The run keeps it so: `shadowlap show`, its page, Needs a look, Fixes and a repair that reuses the blame say *not settled*, never *not rescued* |
| **Confidence** | *high*: the call after the boundary was lost (under a fixed count: it passed no attempt). *medium*: it was inconclusive (under a fixed count: it passed some, but too few to count as a rescue), so the run was not reliably lost there. *low*: rescue worked again past the boundary, the search stopped early, or the first probe was inconclusive |
| **At #n** | What the model answered at the blamed call in the recording, and in a fork that went on to pass. This is the contrast to act on: the bad path and a good one, from the same point |
| **Probes** | Under the gate's rule, every call probed: how many attempts passed with the Wilson bound of its pass rate, and the verdict, rescued, lost or inconclusive |

Once you have a fix, [`shadowlap verify`](./verify.md) checks it on the blamed run, on failures it was not written against, and on runs that worked. [`shadowlap repair`](./repair.md) does both steps for a fix to the prompt: it asks a model for rewrites and keeps the one the gate accepts.

Every attempt is a run in the store, marked as a blame attempt and bundled per probe in the dashboard's forks view, the way `--repeat` attempts are. `shadowlap show` prints what blame found on the blamed run and on each attempt. The rescued fork is an ordinary run: `shadowlap diff <run> <fork>` compares it with the recording, and `shadowlap ui <fork> --call <n>` opens it at the blamed call.

## Fixes

Every blame is kept in the store whole, with the fix it opens or joins. A fix is one failure, from the blame that reproduced it to a change that held: [`shadowlap fix`](./cli.md#fix) lists them and shows each one's blame, repair and verify. The report ends with it:

```
  fix fx-01M3RZ4XKN · issue_refund called with amount 240 · opened · shadowlap fix show fx-01M3RZ4XKN
```

Which fix a blamed run goes to. Labels come first, because they are how you group runs, and the check decides where they can't. The check is the `--expect` the blame was given, whatever order its keys are in; without `--expect`, it is the exit code. A fix's labels are the ones its failing runs carry now, so a label given to its runs later counts, and the label `good` never names a failure.

- A run that already fails in a fix stays in it, so blaming it again, with `--model` say, adds a blame to the same fix. That holds for an applied fix too: an old recording can't show the failure coming back.
- Otherwise it joins a fix that shares one of its [labels](./cli.md#label-note) and has the same check.
- Else a fix that holds every label the run has, whatever its check: the label decides. A run labelled `refund-over-limit` and blamed under another check joins the `refund-over-limit` fix.
- Else a fix with no labels and the same check. A run with no labels joins the fix with its check, labelled or not, when only one fix has it.
- Otherwise the blame opens a new fix. Its title says how the recording failed the check, in plain words: *issue_refund called with amount 240*, *send_email called twice, not once*, *Output never says "refund issued"*. `shadowlap fix title` replaces it with one of your own.

A run that shares one label with a fix but carries another the fix doesn't hold, under another check, is taken for another failure: a run labelled `customer-x` and `double-email` opens a fix of its own next to a `customer-x`, `refund-over-limit` fix, rather than hide in it. Where several fixes would take a run, the one sharing more of its labels wins, then the first opened. Runs labelled differently stay apart even under the same check.

A blame that stopped early opens or joins a fix too: it replayed the run and saw it fail before it probed anything, so the failure is reproduced. A blame that refused (the run passes, or doesn't replay as recorded) leaves nothing behind. An applied fix is finished: no new run joins it, and the same failure in a run recorded after it shipped opens a new fix.

Each blame also logs a `blame.done` event in the store's activity. Run by a dashboard job, it reports a link to the fix's Blame step.

## Cost

Each probe replays everything before its call for free. The calls after it run live, so later probes are cheaper. A search makes at most `1 + ⌈log₂ m⌉ + scan` probes for *m* model calls, each of at most the gate's `max` attempts (20, or `--attempts` with a fixed count), and usually far fewer attempts than that, because a probe stops once its verdict is settled. The header prints the bound before anything runs.

| Option | Effect |
|---|---|
| `--budget <usd>` | Start no attempt once this much is spent on live model calls. Attempts already running finish, so the total can pass the budget by one attempt per concurrent slot. Needs prices for the models involved: an unpriced model counts as $0, and the report names it |
| `--timeout <seconds>` | Stop an attempt after this long and count it as failed, for an agent that can loop |
| `--concurrency <n>` | Run up to *n* attempts of a probe at once, and at most *n* − 1 past the one that decides it. Probes still run one after another, since each depends on the last |

Stopping early, by budget or by Ctrl-C, still prints what the search found so far, and exits 1.

## JSON

`--json` prints the report on stdout (progress still goes to stderr), for scripts and [coding agents](./agents.md):

| Field | |
|---|---|
| `runId` | The run blamed |
| `outcome` | `blamed`, `unrescuable` or `stopped`; `error` when blame refused, with `error.reason` (`passes`, `unpriced`, `inconclusive`, `diverged`, `bypassed`, `prefix`, `no-model-calls`, `interrupted`), `error.message`, and `judge` for what [judge checks](./judges.md) spent before it refused |
| `blamed`, `lost` | `{ callNo, step, passes, attempts }` for the blamed call and the one after it, or `null` |
| `confidence` | `high`, `medium` or `low` |
| `contrast` | `{ callNo, recorded, rescued, rescuedRunId }`: the model's answer at the blamed call in the recording and in the rescued fork, as blocks (`text`, `thinking`, `tool_call` with `name` and `input`) |
| `sameAnswer` | `{ callNo, runId, why }` when probes rescued the run but every attempt that passed answered the call the search ended on as the recording did, so `outcome` is `unrescuable`: that call, an attempt that passed, and why it passed. Otherwise `null` |
| `failedWrite` | `{ name, message, callNo }` when no probe rescued the run and every attempt from the first model call (`callNo`) met the error a write got when the run was recorded: the tool and the error. Otherwise `null` |
| `probes` | Per probe: `callNo`, `step`, `passes`, `attempts`, `rescued`, the gate's `decision` (`pass`, `fail` or `inconclusive`; `null` under a fixed count, unless an attempt could not be judged, which makes it `inconclusive`), its `rate` (the `decision`, the Wilson `interval` of the pass rate, and the `sentence`, as the report words it: `rescued · 3 of 4 · rate >= 0.30 (95%) · gate: rescue at 60%+, lost at 10%-, <= 5% risk, up to 20 attempts`; `null` under a fixed count, or when an attempt that could not be judged stopped it), `undecided` (why that attempt could not be judged; `null` otherwise), and `runs`, each with `runId`, `passed`, its `verdict` (`passed`, `failed`, or `inconclusive` when all it fell short on is a check that could not be decided), `exitCode`, `failures`, `spent` and `upstreamRequests` |
| `oracle`, `recordedFailures` | What a passing run must do, and how the recording fails it |
| `rescue` | `{ fields }`: the request fields a probe changed; empty when it resampled |
| `gate` | The gate each probe was decided by, `{ kind, good, bad, risk, max }`, or `null` when a fixed count (`--attempts`, `--passes`) decided |
| `modelCalls`, `attemptsPerProbe`, `passesNeeded`, `nonMonotone`, `cost`, `stopReason` | The search's parameters and what it spent: `modelCalls` counts the agent's model calls, never a judge check's; with a gate, `attemptsPerProbe` is its `max` and `passesNeeded` the fewest passes that can rescue (2) |
| `judge` | `{ spent, upstreamRequests }`: what [judge checks](./judges.md)' calls cost, apart from `cost`, which is the agent's alone; `null` when no judge was asked live. `--budget` counts both |
| `warnings` | What the replays warned about, such as a connection that bypassed Shadowlap |
| `fix` | `{ fixId, title, status, opened }`: the [fix](#fixes) the blame opened (`opened: true`) or joined, or `null` when the store could not keep it |

## When blame refuses

| Message | Why | What to do |
|---|---|---|
| *passes its oracle when replayed* | The replayed run does what the oracle asks, so there is no failure | Say what it should have done with `--expect` |
| *fails only because … has no price* | The only check it fails is a cost check, which can't be judged for a model with no price, whatever the model answers | Add the model under `prices` in `shadowlap.config.json`, and blame again if it still fails |
| *--expect has a check no attempt can decide* | A [judge check](./judges.md) whose judge can't be asked live (no key for its provider, and no upstream set for it): each probe is a fork, which asks the judge live, so every attempt would read inconclusive and none could pass. Refused before anything runs | Give the judge its provider's key, or leave it out of `--expect`; [`shadowlap check`](./checks.md#try-a-check-on-your-recordings) judges recordings by the verdicts they hold |
| *has a check that can't be decided as recorded* | A check is [inconclusive](./checks.md#how-a-check-comes-out) on the free replay (a judge with no verdict, a `when` whose condition reads a value the run doesn't have), so it would be on every probe too | Fix the check, such as the path a condition reads (`shadowlap doctor` names one no recorded call has), or leave it out of `--expect` |
| *does not replay as recorded* | The replay forks by itself, so a probe could not tell a changed answer from a changed prefix | [`shadowlap calibrate`](./normalizers-and-redaction.md#calibrate), then blame again |
| *forked at call n instead* | An attempt ran a prefix the recording doesn't hold | As above. Branches that run at once need [scopes](./sdk.md#scopes) |
| *made no model calls* | There is no model answer to blame, or none in the `--scope` given | Check the scope names blame lists |
| *did not replay through Shadowlap* | The recording has model calls and the replay made none: the agent reached its model some other way, often a local server Shadowlap was told about when recording (`SHADOWLAP_UPSTREAM_OPENAI`) and not now | Replay in the environment you recorded in |

## Limits

- Blame points at a model call, because a model answer is the one thing a probe can ask for again. A failure caused by a tool returning bad data shows up as *not rescued*, or as blame on a call that read the bad data; an [override](./interventions.md#override-a-tool-result) tests that directly.
- A write that failed, such as a post to a channel that doesn't exist, shows up as *not rescued* with the write and its error when every attempt makes it again, since a write a probe repeats gets its recorded error. One a probe makes with other arguments is stubbed, so a rescue that went through it comes with a warning.
- The verdict is statistical, and says what its gate tells apart: a call that passes 60% of the time or more from one that passes 10% or less, each verdict wrong at most 5% of the time at those two rates. It never claims a rate: a call the model gets right 30% of the time is between the two, and is rescued 40% of the time, lost 54%, and left inconclusive 5.7% at 20 attempts. Its tally and Wilson bound say what the attempts show. For an agent that rarely succeeds, lower the bar, as in `--gate '{"good":0.3,"bad":0.05}'`, which takes more attempts. [Gating](./gating.md) has the maths.
- The binary search finds *a* boundary. The scan checks the calls just past it, but a dip further along goes unprobed, so read a low-confidence result together with its probes.
