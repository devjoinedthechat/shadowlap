# shadowlap

Change safety for agents: record, replay and fork AI agent runs.

Your agent refunded $240 it should have escalated. Run it again and it behaves: you can't make it fail on demand, so you can't prove a fix worked.

Shadowlap records your agent's model calls and the tools you wrap, then replays your real code against the recording. Every call is served from it, the refund included: nothing goes upstream and nothing happens twice. Change one thing and the run forks at the first request that differs.

## Quickstart

See the whole loop first, with no key and nothing to clone: `npx shadowlap demo` records a refund agent breaking its policy, replays it with 0 upstream requests, finds the model call that lost the run, and has a fix proposed, proven and applied, against a scripted model on 127.0.0.1.

Then install the CLI (Node 22.16 or later, not 23), and let it read your project:

```sh
npm install -g shadowlap
cd your-agent
shadowlap init
```

`init` finds your model SDKs, framework, agent command and tools, and prints your next steps. Model calls need no code changes (an agent on Node needs Node 18.18 or later). Wrap each tool once with its effect, or it runs again on every replay:

```sh
# wrap tools (Node 18.18+)
npm install @shadowlap/sdk
# wrap them in your framework (Node 18.18+)
npm install @shadowlap/adapters
# record tests in Vitest, Jest or node:test (Node 22.16+, not 23)
npm install -D @shadowlap/test
# Python 3.9+: all three in one package
pip install shadowlap
```

[`@shadowlap/sdk`](https://www.npmjs.com/package/@shadowlap/sdk) and [`shadowlap` for Python](https://pypi.org/project/shadowlap/) show the wrapper. Then record, replay and look:

```sh
# record a run, with your usual key
shadowlap run -- node agent.mjs
# a clean replay: 0 upstream requests, no real key
shadowlap replay <run>
# step through it in your browser
shadowlap dashboard
```

## From failure to proof

- **Reproduce a failure exactly.** `shadowlap replay <run>` serves every call from the recording. A what-if changes the run at one call and replays everything before it: `--override`, `--fail-at`, `--inject`, `--model`.
- **Find the call that lost the run.** `shadowlap blame <run> --expect '{"calls":[{"tool":"issue_refund","after":"lookup_order","args":{"amount":{"<=":100}}}]}'` asks model calls again, each from a fork, and names the last one whose new answer can still save the run.
- **Prove the fix.** `shadowlap repair` asks a model you choose, or your own Claude Code, to rewrite the system prompt or a tool description, and keeps the smallest rewrite that fixes the failing runs and leaves no good run 10 points or more worse than before. `--repairer anthropic` needs the Anthropic SDK beside the CLI: `npm install -g @anthropic-ai/sdk`. `shadowlap verify` gives a fix you wrote yourself the same proof, and exits 0 only when it accepts the fix: 1 when it rejects it, 3 when it can't decide.
- **Keep it fixed in CI.** `shadowlap test goldens/*` replays committed recordings offline and fails on a changed request, a live call, an error exit or a failed check. On GitHub it is one step after your checkout, Node and build steps: `uses: devjoinedthechat/shadowlap@v0.1.0`, with `version: 0.1.0` ([the workflow](https://github.com/devjoinedthechat/shadowlap/blob/main/docs/ci.md#github-actions)).
- **Change models and prompts safely.** `shadowlap decisions <runs or goldens/*> --model <model>` asks the recorded model calls again under the change and ranks what they decide differently, writes first. `shadowlap migrate --to <model>` verifies and prices a switch.

`shadowlap --help` lists every command.

## Security

The sidecar and the dashboard listen on 127.0.0.1 behind a session token, recordings stay in your project, readable only by you, and keys pass through to the provider, never stored. Telemetry is off unless `SHADOWLAP_TELEMETRY_URL` names a collector; the project runs none. [SECURITY.md](https://github.com/devjoinedthechat/shadowlap/blob/main/SECURITY.md) lists every check and how to report a vulnerability.

## Documentation

[Introduction](https://github.com/devjoinedthechat/shadowlap/blob/main/docs/index.md) · [Quickstart](https://github.com/devjoinedthechat/shadowlap/blob/main/docs/quickstart.md) · [CLI reference](https://github.com/devjoinedthechat/shadowlap/blob/main/docs/cli.md) · [CI](https://github.com/devjoinedthechat/shadowlap/blob/main/docs/ci.md) · [Why did my replay diverge?](https://github.com/devjoinedthechat/shadowlap/blob/main/docs/troubleshooting.md)
