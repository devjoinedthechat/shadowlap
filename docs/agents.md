# Coding agents

Claude Code, Cursor, Codex and other coding agents can debug an agent with Shadowlap the way you would: record a failing run, read where it went wrong, change the code, and replay to check the fix, without paying for the model calls that didn't change. They need no plugin or MCP server. The CLI is the interface, and every command they need reads and writes JSON.

## What an agent uses

| To | Run | Reads |
|---|---|---|
| Find runs | `shadowlap ls --json [--label bug]` | Run ids, whether each forked and where, labels; whether a run has a command to re-run, came from a pack or a capture, or is an attempt with check results ([fields](./cli.md#ls)) |
| Read a run | `shadowlap show <run> --json` | The summary (calls by origin, divergence, cost) and every call |
| Read one call | `shadowlap show <run> --request <n>` / `--response <n>` | The request as sent, the response as received |
| Search what runs recorded | `shadowlap search <words> --json` | Matching prompts, responses, tool arguments and results |
| Check a change | `shadowlap replay <run> --strict --summary-json out.json` | Exit code 1 on divergence or an early end; the summary in `out.json` |
| Check a prompt change from a later step | `shadowlap replay <run> --prompt-from <call> --summary-json out.json` | As above |
| See what a prompt or model change decides differently | `shadowlap decisions <runs\|goldens> --from-code --json` (or `--model <model>`) | Each recorded model call asked again with only the change: the changed decisions in rank order, writes first, with the recorded and the new action; no tool runs ([fields](./cli.md#decisions)) |
| See whether a fix holds | `shadowlap replay <run> --repeat 5 --summary-json out.json` | Every attempt, and the paths they took |
| Find where a failed run went wrong | `shadowlap blame <run> --expect '<checks>' --json` | The model call that lost the run, what the model answered there in the recording and in a fork that passed, and that fork's run id ([fields](./blame.md#json)) |
| Check a fix before calling it done | `shadowlap verify --fixes <runs> --keeps label:good --expect '<checks>' --json` | Accepted or rejected, and for each run whether it is fixed, kept or broken ([fields](./verify.md#json)) |
| Get a verified fix to the prompt | `shadowlap repair --fixes <runs> --keeps label:good --expect '<checks>' --json` | The accepted rewrite and its patch, or why none passed; where each run was lost, as a brief for a fix in code ([details](./repair.md)) |
| Compare two runs | `shadowlap diff <a> <b> --json` | What changed, the first differing request, each run's course after it |
| Find ids and temp paths that change every run | `shadowlap calibrate --json` | Proposed normalizers |
| Run the recorded tests | `shadowlap test <pack...> --json report.json` | Per recording: result, divergence, checks |

A replay runs the agent's own command, so its output mixes with Shadowlap's on the terminal; `--summary-json` writes the outcome to a file instead. Replays make no model calls until the fork, so an agent can replay as often as it likes.

## Instructions to give it

Paste this into the project's `CLAUDE.md`, `AGENTS.md` or rules file, and adjust the commands:

```md
## Debugging the agent with Shadowlap

Agent runs are recorded with Shadowlap (`shadowlap run -- <command>`). To investigate a failing run:

1. `shadowlap ls --json` to find it, `shadowlap show <run> --json` to read it. A call's request and
   response: `shadowlap show <run> --request <n>` and `--response <n>`.
2. Change the code. Then `shadowlap replay <run> --summary-json /tmp/replay.json` re-runs the agent
   against the recording: calls that didn't change are served from it for free, and the run forks at
   the first request that changed. Read `summary.divergence` in the JSON to see where and why.
3. A changed system prompt forks at call 1; to test it from a later model call instead, add
   `--prompt-from <call>`. To see what it decides differently at every step without running the
   agent, `shadowlap decisions goldens/* --from-code --json` (rank 1 is a write that changed). To
   see whether a fix holds rather than got lucky, add `--repeat 5`.
   Not sure where it went wrong? `shadowlap blame <run> --expect '<what it must do>' --json` names
   the model call that lost the run and shows what the model answered there in a fork that passed.
4. Writes (emails, tickets, payments) are blocked after a fork; never pass `--writes allow`.
5. Before finishing, run `shadowlap verify --fixes <the failing runs> --keeps label:good --expect
   '<what it must do>'` and make sure it is accepted, then `shadowlap test goldens/*`. A fix inside a
   tool needs `--live-tool <name>`.
```

Shadowlap never passes credentials to the agent's process beyond what it already had, and a replay reaches a provider only for calls after the fork.
