# Checks

Checks say what a passing run must do: which tools it calls and how often, in what order, with what arguments, on what condition, within what budget, and what it says. One `expect` object holds them wherever a run is judged: under `tests` in `shadowlap.config.json` for a golden ([CI mode](./ci.md#outcome-checks)), and with `--expect` for [`replay`](./cli.md#checks-on-a-replay), [`blame`](./blame.md), [`verify`](./verify.md), [`repair`](./repair.md), [`bisect`](./cli.md#bisect) and [`check`](#try-a-check-on-your-recordings).

A run can exit 0, stay within every count and budget, and still do the wrong thing: refund more than the order came to, refund before looking the order up, refund when policy says escalate. Those are rules about the calls themselves, and `calls` and `when` say them.

| Key | Passes when |
|---|---|
| `tools` | Each tool was called the given number of times, optionally only counting calls with given arguments ([details](./ci.md#outcome-checks)) |
| `modelCalls`, `toolCalls` | The run made that many model calls, or tool calls |
| `inputTokens`, `outputTokens`, `cost` | The run's model requests stay within the budget |
| `output`, `answer` | What the agent printed, or the last model response, includes and excludes the given text |
| [`calls`](#rules-on-calls) | Every call of a tool meets a rule: the tools it comes after, and its arguments, compared with values from earlier calls |
| [`when`](#conditions) | Its checks hold once a call matched a condition; until then they are not applicable |
| [`judge`](#judge-checks) | A model answers a question about the run the way that passes |

## Rules on calls

```json
{
  "tests": {
    "goldens/refund-*": {
      "expect": {
        "calls": [
          {
            "tool": "issue_refund",
            "after": "lookup_order",
            "args": { "amount": { "<=": "@lookup_order.result.total" } }
          },
          { "tool": "send_email", "args": { "to": { "endsWith": "@example.com" } } }
        ]
      }
    }
  }
}
```

- `tool`: the rule applies to every call of this tool, blocked and stubbed ones included. A rule on a tool that was never called passes: pair it with `tools` when the call must happen.
- `after`: a tool, or a list of tools, that each have a call before every call of `tool`. A call that failed still counts as made.
- `args`: the call's arguments by name, each a value to match or a [predicate](#predicates).

A rule needs `after`, `args` or both. When a call breaks it, the check names the call and the values:

```
✗ 1 of 1 check failed (--expect)
  ✗ every issue_refund call: after lookup_order, amount <= lookup_order.result.total, but issue_refund #4: amount 240 > lookup_order.result.total 180 (#2)
```

`#4` is the refund call and `#2` the lookup it was compared with. With several calls breaking a rule, the first three are named and the rest counted.

### Predicates

An object whose keys are all operators is a predicate, and every operator in it must hold: `{ ">": 0, "<=": 500 }` is a range.

| Operator | Holds when the value |
|---|---|
| `=`, `!=` | equals, or doesn't equal, the operand, as a literal matches (objects partially, lists item by item) |
| `<`, `<=`, `>`, `>=` | compares so with the operand. Both must be numbers; a number written as text (`"240.00"`) reads as the number |
| `in` | equals one item of a list: one given (`["USD", "GBP"]`), one a reference reads (`"@list_contacts.result.emails"`), or the values a reference with `*` reaches |
| `includes` | is text that contains the operand, or a list with the operand as an item |
| `startsWith`, `endsWith` | is text that starts or ends with the operand |
| `not` | doesn't match the predicate or value it holds: `{ "not": { "in": "@lookup_customer.result.*" } }` |

Text is compared as it is, case included. There are no regular expressions: a check should never be the slow part of a test, and a pattern can take minutes on the wrong input.

A value the predicate needs and the call doesn't have, or a value of another kind than it compares (text where a number is compared, text where a list or an object is written), can't be decided: the rule fails and says so. Operators that must all hold are broken as soon as one is, whatever the others are, and one that can't be decided never passes, negated or not. So `{ "not": { ">": 0, "<": "@lookup.result.max" } }` passes `-1`, which is not above 0 whatever `max` is, and fails `5` when there is no lookup before it: a pass never rests on a value that wasn't there.

### Values from earlier calls

A string `"@<tool>.result.<path>"` or `"@<tool>.args.<path>"` is a reference: the value from the most recent call of that tool before the call being checked. Its path is the JSONPath subset that [normalizers](./normalizers-and-redaction.md) use: `.total`, `.items[0].sku`, `.items[-1].sku` for the last one, and `.*` or `[*]` for every value at that level, which only `in` takes. A tool that answers with JSON inside a string is read as that JSON.

| The rule reads | It fails, naming |
|---|---|
| a tool with no call before this one | `issue_refund #3: no lookup_order call before it` |
| a call that has no result (it failed, was blocked or never finished) | `issue_refund #3: lookup_order #2 has no result (it failed)` |
| a path the result doesn't have | `issue_refund #3: lookup_order #2 has no result.total` |

A reference on its own is a value to equal: `{ "order_id": "@lookup_order.args.order_id" }` holds when the refund is for the order that was looked up. Only a string that names `.result` or `.args` after a tool is a reference: `"@example.com"` is text. Text that starts with `@` and would read as a reference is written with `@@`: `"@@corp.args.io"` is the text `@corp.args.io`.

### Literals

A value that is not a predicate keeps the meaning it has under `tools`: equal, objects partially (the keys given must match, others may be there), lists item by item and of the same length. Predicates may sit at any key inside one: `{ "customer": { "email": { "endsWith": "@example.com" } } }`. An object that mixes operators with other keys is refused, since it can't be both.

A key named like an operator it is not, such as `gt`, `contains`, `$in` or `endswith`, is refused, with the operator it most likely meant: as a key the value must have, it would never be there, and under `not` the rule would pass everything. A value that really has such keys is compared with `=`: `{ "filter": { "=": { "in": "inbox" } } }`. The top level of `args` is always argument names, so an argument called `in` is matched as it is.

## Conditions

```json
{
  "tests": {
    "goldens/refund-*": {
      "expect": {
        "when": [
          {
            "if": { "tool": "lookup_order", "result": { "total": { ">": 100 } } },
            "then": { "tools": { "escalate": ">= 1", "issue_refund": 0 } }
          }
        ]
      }
    }
  }
}
```

- `if` holds when any call of `tool` matches its `args` and its `result`, by the same grammar as `calls`, references included. A call that failed or was blocked returned nothing, so a condition on its result doesn't hold there.
- `then` is an ordinary `expect` object, read as this one is: counts, budgets, text, `calls`, another `when`, judge checks.
- Each check under `then` is reported on its own, after the condition. When a call met the condition, it is judged on the whole run, and a failure says where the condition held. When none did, each is **not applicable**, never passed, so a report never claims more than it checked:

```
✓ refund-escalated: 5/5 replayed, 3k input tokens not re-spent, 3 checks passed
✓ refund-in-limit: 5/5 replayed, 3k input tokens not re-spent, 1 check passed, 2 not applicable
✗ refund-over-limit: check failed: every issue_refund call: after lookup_order, amount <= lookup_order.result.total, but issue_refund #4: amount 240 > lookup_order.result.total 180 (#2); 2 more checks failed
    ✗ every issue_refund call: after lookup_order, amount <= lookup_order.result.total: issue_refund #4: amount 240 > lookup_order.result.total 180 (#2)
    ✗ when lookup_order has result.total > 100: escalate called at least 1 time: called 0 times; tools called: lookup_order, issue_refund; the condition held at lookup_order #2 (result.total 180 > 100)
    ✗ when lookup_order has result.total > 100: issue_refund called 0 times: called 1 time; the condition held at lookup_order #2 (result.total 180 > 100)
```

A golden whose recording never met the condition is reported, with `--json`, as `"status": "not-applicable"` and a detail such as `the condition never held: lookup_order #2: result.total 40 <= 100`.

Not applicable is said only of a condition that was read and did not hold. When no call met it and one could not be read for it (a value it compares is missing from the call, as a misspelt `result.totl` is, or of another kind, or a reference in it has no call to read), whether it held can't be told, and each check under `then` is **inconclusive**: `could not tell whether the condition held: lookup_order #2: has no result.totl`. A typo in a condition fails the test as inconclusive, and never switches the rule off quietly.

## Judge checks

Some outcomes are not in the calls: whether the reply explains why the refund was escalated. A judge check asks a model, and passes on its answer:

```json
{
  "expect": {
    "judge": [
      {
        "name": "explains-escalation",
        "question": "Does the final reply tell the customer why the refund was escalated?",
        "of": "answer",
        "model": "claude-haiku-4-5",
        "pass": "yes"
      }
    ]
  }
}
```

| Field | |
|---|---|
| `name` | Letters, digits, `.`, `_` and `-`, up to 64. The verdict is kept under it, so each judge in an `expect` has its own |
| `question` | Answered `yes` or `no` |
| `of` | What the judge reads: `answer`, the last model response (the default); `output`, what the agent printed; or `run`, the conversation and the tool calls |
| `model` | The judge's model: a Claude, OpenAI or Gemini model by its name (`claude-haiku-4-5`, `gpt-5.5`, `o3`, `gemini-3-flash`), or any model with its provider before it (`openai:my-model`, for an OpenAI-compatible server's own names) |
| `pass` | The answer that passes: `yes` (the default) or `no` |

A verdict is the judge's `yes` or `no` with a one-line reason, which the report shows beside the check, and where it came from: the judge's call recorded in the run, or one asked live. Calls in the scope `shadowlap:judge` are a judge's, not the agent's, and no other check counts them: a `modelCalls` limit or a cost budget is about the agent.

Until a run holds a verdict for it, a judge check is **inconclusive**, saying what is missing: `not judged: no recorded verdict and no key for anthropic`, or without `and no key…` when the environment has the provider's key (`ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `GEMINI_API_KEY` or `GOOGLE_API_KEY`). It never passes, and it fails a test as a failed check does. `blame`, `verify` and `repair` refuse a judge check before they start: each of their attempts is a fork, which would need the judge's verdict asked live, so every attempt would read inconclusive and none could pass.

## How a check comes out

| Status | |
|---|---|
| **passed** | The run did what the check asks |
| **failed** | It didn't; the detail names the values |
| **inconclusive** | It could not be decided: a judge with no verdict, or a `when` whose condition could not be read. Never a pass |
| **not applicable** | A `when` check whose condition never held. Never a failure, and never counted as passed |

A run's checks come out as one: failed when any check failed, else inconclusive when any could not be decided, else passed. Every report uses these words: the terminal marks them `✓`, `✗`, `?` and `–`, a job summary ✅, ❌, 🟡 and ➖. With `--json`, each check is `{ "status", "ok", "label", "detail" }`, where `status` is `passed`, `failed`, `inconclusive` or `not-applicable`, `ok` is true for passed and not applicable (what results said before they had a status), `label` is what was expected and `detail` what happened, null for a check that passed. A judge's result adds its `reason` and the `source` of its verdict (`recording` or `live`). Checks are kept on the run that was judged, and in the test history.

A check's label depends only on the check, never on the run: the same check reads the same whether it passed, failed or did not apply, so a golden's checks can be listed before it runs and compared across sessions.

## Try a check on your recordings

`shadowlap check` judges recordings by checks from what they recorded. Nothing is replayed and nothing is sent, so a rule can be tried on every run there is before it goes into the config:

```sh
shadowlap check --expect @refund-rule.json
```

```
✓ 01M58VXG3S  node agent.mjs A-1042: 1 check passed
✓ 01M58VXFVT  node agent.mjs B-7: 1 check passed
✓ 01M58VXFKW  good · node agent.mjs A-1042: 1 check passed
✗ 01M58VXFAW  bug · node agent.mjs A-1042: failed
    ✗ every issue_refund call: after lookup_order, amount <= lookup_order.result.total: issue_refund #4: amount 240 > lookup_order.result.total 180 (#2)
4 recordings judged from what they recorded, nothing replayed: 1 failed, 3 passed
```

A check that fails a run labelled `good`, or passes one labelled `bug`, says so under the totals. Without `--expect`, each recording is judged by its own entry under `tests`; packs work too (`shadowlap check goldens/*`). A check on the agent's output can't be judged from a recording, which doesn't keep it: such a recording reads inconclusive. See [the reference](./cli.md#check).

## Checking the checks

`shadowlap doctor` holds the rules under `tests` against the packs they apply to. A tool a rule names that none of those recordings called or offered to its model is most likely misspelt, or renamed since, and a rule on it checks nothing:

```
! check rules    shadowlap.config.json: tests["goldens/refund-in-limit"].expect.calls[0].after names lookup_orders, which goldens/refund-in-limit never called or offered to the model
                 Did you mean lookup_order? Otherwise check the name: they call issue_refund, lookup_order.
```

A tool the recordings offered but never called is reported where the rule needs the call: a condition that never holds there, a reference with nothing to read. A count that allows none (`"delete_account": 0`) on a tool the agent has is what it says, and is left alone.
