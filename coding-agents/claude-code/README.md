# Shadowlap for Claude Code

A Claude Code plugin with one skill, `debug-agent`, that teaches Claude to debug an AI agent with the
`shadowlap` CLI: find a failing run, read where it went wrong, replay a change against what the
agent actually did, find the model call that lost the run, and verify a fix before calling it done.
Claude loads the skill when a task calls for it; `/shadowlap:debug-agent` loads it on purpose.

It needs the `shadowlap` CLI on the PATH, in a project whose agent runs are recorded with it: see the
[quickstart](../../docs/quickstart.md).

## Install

The repository is its own plugin marketplace:

```sh
claude plugin marketplace add devjoinedthechat/shadowlap
claude plugin install shadowlap@shadowlap
```

From a clone, add its folder instead (`claude plugin marketplace add ./shadowlap`), or load the plugin
for one session with `claude --plugin-dir shadowlap/coding-agents/claude-code`.

## What it may run without asking

The skill pre-approves the commands that only read the store: `shadowlap ls`, `show`, `search`,
`diff` and `fix ls`. Like any skill's, that grant lasts for the turn in which Claude loads the skill
and ends when you send your next message. Everything that runs the agent (`replay`, `blame`,
`verify`, `test`) asks first, as any other command does.

## Kept in step with the CLI

The plugin's version is the CLI's, and CI runs every command the skill names against the
repository's reference agent, so the skill never tells Claude to run something the CLI doesn't take.
The same instructions come as a [Cursor rule](../cursor/shadowlap.mdc) and as a section to paste
into `CLAUDE.md` or `AGENTS.md`: [Coding agents](../../docs/agents.md).
