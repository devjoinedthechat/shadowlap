# @shadowlap/collector

A telemetry collector for [Shadowlap](https://github.com/devjoinedthechat/shadowlap), for a team that wants to count its own use: one Node process, one SQLite file, no dependencies. The CLI sends nothing unless `SHADOWLAP_TELEMETRY_URL` names a collector, and the project runs none.

```sh
npm install -g @shadowlap/collector
PORT=8787 COLLECTOR_DB=./collector.db shadowlap-collector
```

Put it behind TLS at a hostname you control, and point the CLI at it with `SHADOWLAP_TELEMETRY_URL=https://your-host/v1/events`. `HOST` sets the address it listens on (`0.0.0.0` by default), and `PUBLIC_ORIGIN` the address its empty dashboard tells clients to send to.

- `POST /v1/events` takes a batch from the CLI. Every field is checked against a closed allowlist (event types, providers, SDK languages, OS and arch, integer counts, version patterns), and an unexpected key or free-text value is refused with a 400, so the collector can't store prompts, paths or names, even from a client with a bug. A time before 2025, or more than a day ahead of the collector's clock, is refused too, so no client can keep its events counted as recent for years; events a collector stored with such a time before it checked are dropped when it starts.
- `GET /v1/stats` answers the aggregates as JSON: active developers, replays and how many were clean, tokens not re-spent, divergence types, providers, SDKs, versions and a daily series.
- `GET /` is a dashboard of the same aggregates, rendered on the server: weekly active developers over 12 weeks with the change from the week before, replays per day split clean and forked, tokens not re-spent, CI repositories, and counts by divergence type, provider, SDK, OS, CI system and version. It runs no scripts, and its Content-Security-Policy forbids them.
- `GET /healthz` is the health check.

Bodies up to 64 KB, 50 events a batch, 60 requests a minute per client address. Aggregates are kept for a minute, and a new batch refreshes them.

[Telemetry](https://github.com/devjoinedthechat/shadowlap/blob/main/docs/telemetry.md) lists every field a client sends, and how to turn it off: `SHADOWLAP_TELEMETRY=0` or `DO_NOT_TRACK=1`.

To work on the dashboard, build a clone (`npm ci && npm run build`); `node packages/collector/scripts/preview.mjs` then serves it on port 8788 with twelve weeks of synthetic use from a store in memory, and `--empty` shows the first day.
