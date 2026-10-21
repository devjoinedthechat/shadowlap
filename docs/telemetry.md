# Telemetry

Shadowlap can send anonymous usage counts to a collector you name. This page is the complete list of what is sent.

**Nothing is sent by default, and the project collects nothing.** The CLI has no default endpoint and Shadowlap runs no collector. Events go out only when `SHADOWLAP_TELEMETRY_URL` points at one, which in practice means a collector you host yourself to measure usage inside your own organization.

## What is sent

One event per `run`, `replay`, `test` pack, `ui` open and `pack`:

| Field | Example | Notes |
|---|---|---|
| install id | `123e4567-…` | Random UUID stored in your config directory. In CI, a hash of the repository's numeric id, never its name |
| version, OS, arch, Node version | `0.1.0`, `darwin`, `arm64`, `22.18.0` | |
| CI system | `github`, `gitlab`, `other`, none | From environment variables |
| providers | `["anthropic"]` | Which provider modules received calls |
| SDK languages | `["typescript", "python"]` | From the user agent of what called the sidecar (an SDK, the recorded-input preload, `shadowlap mcp`), as one of `typescript`, `python`, `mcp`, `other` |
| counts | calls: 30, replayed: 28, live: 2, blocked: 1, stubbed: 0, overridden: 0 | |
| divergence type | `request_changed`, or none | The category only |
| tokens not re-spent | 12000 | From recorded usage |
| duration, exit code | 900 ms, 0 | |

## What is never sent

Prompts, messages, tool names, tool arguments or results, file paths, hostnames, run ids, model names, repository names, or anything the agent saw. The collector rejects any event carrying a field outside its allowlist or a value outside its closed sets, so a client bug cannot leak content.

## Opt out

```sh
export SHADOWLAP_TELEMETRY=0     # or DO_NOT_TRACK=1
```

With a collector configured, the first run prints a one-line notice. `SHADOWLAP_TELEMETRY_URL` sends events to a collector of your own.

## The collector

`@shadowlap/collector` is a dependency-free Node service with a strict validator, a SQLite store, aggregate stats and a dashboard: weekly active developers over twelve weeks, replays per day and how many were clean, tokens not re-spent, CI repositories, and why replays forked, by provider, SDK, OS and version. The dashboard runs no scripts. Source: `packages/collector` in the repository. It ships so that a team running Shadowlap can see its own numbers; whether the dashboard is public is up to whoever hosts it.

## Hosting your own

Install the collector with `npm install -g @shadowlap/collector` (Node 22.16 or later) and start it with `shadowlap-collector`. `PORT` sets the port it listens on (8787 by default), `HOST` the address (`0.0.0.0`), `COLLECTOR_DB` its SQLite file (`./collector.db`), and `PUBLIC_ORIGIN` the address its empty dashboard tells clients to send to. Put it behind TLS at a hostname you control, and point the CLI at it with `SHADOWLAP_TELEMETRY_URL=https://your-host/v1/events`; `GET /healthz` is its health check.
