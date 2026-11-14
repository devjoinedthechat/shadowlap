# The verdict study

How often is a `shadowlap verify` verdict right? The study plants changes whose effect is known, asks verify about each as a developer would, and scores the verdict against what the change really does.

## How it works

1. **A subject.** `subject/` is a support agent that handles one refund request: it looks the order up, reads the refund policy, then refunds or escalates. Its prompt and tool definitions are files, so a change to either is a change in the working tree.
2. **A corpus.** `changes.mjs` holds the planted changes: regressions, changes that alter nothing, fixes, and changes that fix nothing.
3. **A measurement.** For each change the changed agent runs live, 20 times an order by default, and each run is judged by `oracle.json`. The pass rate with the change and without it is what the change really does. The label a change was planted with is never trusted.
4. **A verdict.** `shadowlap verify` is asked at its defaults, with the good runs as `--keeps` and the failing ones as `--fixes` and `--holdout`.
5. **A score.** `report.mjs` compares the two. Accepting a change that breaks a run is a false accept; rejecting one that breaks nothing is a false reject.

## Run it

A dry run against a stand-in model spends nothing and checks the plumbing:

```sh
node testing/verdict-study/study.mjs --mock --out /tmp/verdict-study-dry --truth 3
```

The study itself calls the provider with your key:

```sh
node --env-file=.env testing/verdict-study/study.mjs --out ~/verdict-study --cap 10
node testing/verdict-study/report.mjs ~/verdict-study/results.json
```

- `--cap <usd>` starts nothing more once that much is spent, and each verify gets what is left as its `--budget`.
- A run that stopped is taken up again from the same `--out` folder.
- `--only <id,id>` studies those changes alone.

## What it does not say

- **One subject, one model.** The rates hold for this agent on the model named in the results. Another agent's runs are noisier or steadier, and its verdicts take more attempts or fewer.
- **A measurement of 20 runs can't tell a small drop from none.** A change whose measured drop falls between 5 and 30 points is left unscored.
- **A change inside a tool** is seen only with `--live-tool`, so the corpus asks about that one both ways.
