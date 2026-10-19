# Coding agents

Claude Code, Cursor, Codex and other coding agents can debug an agent with Shadowlap the way you would: record a failing run, read where it went wrong, change the code, and replay to check the fix, without paying for the model calls that didn't change. They need no plugin or MCP server: the CLI is the interface, and every command they need reads and writes JSON. What they need to know about it comes packaged, as a [Claude Code plugin](#claude-code) or a [Cursor rule](#cursor), or as a [section to paste](#instructions-to-give-it) into any other agent's instructions.

## What an agent uses

| To | Run | Reads |
|---|---|---|
| Find runs | `shadowlap ls --json [--label bug]` | Run ids, whether each forked and where, labels; whether a run has a command to re-run, came from a pack or a capture, or is an attempt with check results ([fields](./cli.md#ls)) |
| Read a run | `shadowlap show <run> --json` | The summary (calls by origin, divergence, cost) and every call |
| Read one call | `shadowlap show <run> --request <n>` / `--response <n>` | The request as sent, the response as received |
| Search what runs recorded | `shadowlap search <words> --json` | Matching prompts, responses, tool arguments and results |
| Check a change | `shadowlap replay <run> --strict --summary-json out.json` | Exit code 1 on divergence or an early end; the summary in `out.json` |
| Check a prompt change from a later step | `shadowlap replay <run> --prompt-from <call> --summary-json out.json` | As above |
| See whether a fix holds | `shadowlap replay <run> --repeat 5 --summary-json out.json` | Every attempt, and the paths they took |
| Find where a failed run went wrong | `shadowlap blame <run> --expect '<checks>' --json` | The model call that lost the run, what the model answered there in the recording and in a fork that passed, and that fork's run id ([fields](./blame.md#json)) |
| Check a fix before calling it done | `shadowlap verify --fixes <runs> --keeps label:good --expect '<checks>' --json` | Accepted or rejected, and for each run whether it is fixed, kept or broken ([fields](./verify.md#json)) |
| Get a verified fix to the prompt | `shadowlap repair --fixes <runs> --keeps label:good --expect '<checks>' --json` | The accepted rewrite and its patch, or why none passed; where each run was lost, as a brief for a fix in code ([details](./repair.md)) |
| Compare two runs | `shadowlap diff <a> <b> --json` | What changed, the first differing request, each run's course after it |
| See what is being fixed | `shadowlap fix ls --json` | Each failure blame opened a fix for: where its run was lost, and how far its fix got ([fields](./cli.md#fix)) |
| Find ids and temp paths that change every run | `shadowlap calibrate --json` | Proposed normalizers |
| Run the recorded tests | `shadowlap test <pack...> --json report.json` | Per recording: result, divergence, checks |

A replay runs the agent's own command, so its output mixes with Shadowlap's on the terminal; `--summary-json` writes the outcome to a file instead. Replays make no model calls until the fork, so an agent can replay as often as it likes.

## Claude Code

A plugin with one skill, `debug-agent`, which Claude loads when a task calls for it, or on purpose with `/shadowlap:debug-agent`. The repository is its own plugin marketplace:

```sh
claude plugin marketplace add devjoinedthechat/shadowlap
claude plugin install shadowlap@shadowlap
```

From a clone, add its folder instead (`claude plugin marketplace add ./shadowlap`), or load the plugin for one session with `claude --plugin-dir shadowlap/coding-agents/claude-code`. The skill lets Claude run the commands that only read (`shadowlap ls`, `show`, `search`, `diff` and `fix ls`) without asking; everything that runs the agent asks first, as any other command does. The plugin is in [coding-agents/claude-code](https://github.com/devjoinedthechat/shadowlap/tree/main/coding-agents/claude-code), and its version is the CLI's.

## Cursor

A project rule, which Agent applies when it finds it relevant, holding the skill's instructions word for word. Copy [coding-agents/cursor/shadowlap.mdc](https://github.com/devjoinedthechat/shadowlap/blob/main/coding-agents/cursor/shadowlap.mdc) into the project's `.cursor/rules/` folder; from a clone:

```sh
mkdir -p .cursor/rules && cp shadowlap/coding-agents/cursor/shadowlap.mdc .cursor/rules/
```

Settings → Coding agents in the [dashboard](./dashboard.md) shows `.cursor/rules` as mentioning Shadowlap from then on.

## Instructions to give it

For any other agent (Codex reads `AGENTS.md`, GitHub Copilot `.github/copilot-instructions.md`), or to keep them in `CLAUDE.md`, paste this into the project's instructions file, and adjust the commands:

```md
## Debugging the agent with Shadowlap

Agent runs are recorded with Shadowlap (`shadowlap run -- <command>`). To investigate a failing run:

1. `shadowlap ls --json` to find it, `shadowlap show <run> --json` to read it. A call's request and
   response: `shadowlap show <run> --request <call>` and `shadowlap show <run> --response <call>`.
2. Change the code. Then `shadowlap replay <run> --summary-json .shadowlap/replay.json` re-runs the
   agent against the recording: calls that didn't change are served from it for free, and the run
   forks at the first request that changed. Read `summary.divergence` in the JSON to see where and why.
3. A changed system prompt forks at call 1; to test it from a later model call instead, add
   `--prompt-from <call>`. To see whether a fix holds rather than got lucky, add `--repeat 5`.
   Not sure where it went wrong? `shadowlap blame <run> --expect '<checks>' --json` names the model
   call that lost the run and shows what the model answered there in a fork that passed. `<checks>`
   is what a passing run must do besides exiting 0, as JSON: `{"tools":{"send_email":0}}`.
4. Writes (emails, tickets, payments) are blocked after a fork; never pass `--writes allow`.
5. Before finishing, run `shadowlap verify --fixes <runs> --keeps label:good --expect '<checks>'`
   with the failing runs as `<runs>`, and make sure it is accepted; then `shadowlap test goldens/*`.
   A fix inside a tool needs `--live-tool <tool>`.
```

## Kept in step with the CLI

The skill, the rule and the section above say which commands to run word for word, so each is tested as an agent would use it: CI runs every command they name against the repository's reference agent, with a scripted fake of the model's API, and checks that the JSON fields they say to read are there ([coding-agents.yml](https://github.com/devjoinedthechat/shadowlap/blob/main/.github/workflows/coding-agents.yml)). A flag renamed, or a field moved, fails that job before a coding agent meets it.

Shadowlap never passes credentials to the agent's process beyond what it already had, and a replay reaches a provider only for calls after the fork.
