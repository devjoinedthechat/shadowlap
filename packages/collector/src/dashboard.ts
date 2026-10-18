import type { Stats } from './store.js';

/**
 * The public usage dashboard: aggregate numbers only, server-rendered, no scripts (the response's
 * CSP forbids them). Charts are HTML and CSS so they stay sharp at any width and read in both
 * themes; every chart also carries its numbers as a visually hidden table.
 */

export interface DashboardOptions {
  /** This collector's public origin, e.g. https://telemetry.example.com, for the empty state. */
  origin?: string;
  /** Where "what is collected" and the source link point. */
  repoUrl?: string;
}

const REPO = 'https://github.com/devjoinedthechat/shadowlap';
const DAY = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const DIVERGENCE_LABELS: Record<string, string> = {
  request_changed: 'request changed',
  new_call: 'new call',
  forced: 'forced live',
  beyond_recording: 'past the recording',
  ended_early: 'ended early',
};
const DIVERGENCE_HINTS: Record<string, string> = {
  request_changed: 'A request differed from the recorded one: a prompt, a tool argument, a parameter.',
  new_call: 'The agent made a call the recording never made.',
  forced: 'Forced live with --live-tool or --diverge-at.',
  beyond_recording: 'The agent kept going after the recording ended, e.g. a recording of a crashed run.',
  ended_early: 'The agent stopped before making every recorded model or tool call, though every request it sent matched.',
};
const OS_LABELS: Record<string, string> = { darwin: 'macOS', linux: 'Linux', win32: 'Windows', freebsd: 'FreeBSD', openbsd: 'OpenBSD', sunos: 'SunOS', aix: 'AIX', android: 'Android' };
const CI_LABELS: Record<string, string> = { github: 'GitHub Actions', gitlab: 'GitLab CI', circleci: 'CircleCI', buildkite: 'Buildkite', jenkins: 'Jenkins', azure: 'Azure Pipelines', other: 'other' };
const SDK_LABELS: Record<string, string> = { typescript: 'TypeScript', python: 'Python', mcp: 'MCP proxy', other: 'other' };
const PROVIDER_LABELS: Record<string, string> = { anthropic: 'Anthropic', openai: 'OpenAI-compatible', gemini: 'Gemini' };

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 1,234 below 100k; 123.4k, 5.7M, 1.2B above. */
export function formatCount(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e5) return `${(n / 1e3).toFixed(1)}k`;
  return Math.round(n).toLocaleString('en-US');
}

const shortDate = (iso: string) => {
  const [, m, d] = iso.split('-').map(Number);
  return `${MONTHS[(m ?? 1) - 1]} ${d}`;
};
const pct = (part: number, whole: number) => (whole ? Math.round((100 * part) / whole) : 0);
const height = (v: number, max: number) => (max && v ? Math.max(1.5, (100 * v) / max) : 0);

/** Week-over-week change as a chip: "+12%", "−4%", "new", or nothing. */
function delta(current: number, previous: number): string {
  if (!current && !previous) return '';
  if (!previous) return '<em class="chip up">new this week</em>';
  const change = Math.round((100 * (current - previous)) / previous);
  if (change === 0) return '<em class="chip">flat vs previous 7 days</em>';
  return `<em class="chip ${change > 0 ? 'up' : 'down'}">${change > 0 ? '+' : '−'}${Math.abs(change)}% vs previous 7 days</em>`;
}

/** The last 30 days, one entry per day, empty days included. */
function fillDays(daily: Stats['daily'], now: number): Stats['daily'] {
  const byDay = new Map(daily.map((d) => [d.day, d]));
  return Array.from({ length: 30 }, (_, i) => {
    const day = new Date(now - (29 - i) * DAY).toISOString().slice(0, 10);
    return byDay.get(day) ?? { day, installs: 0, runs: 0, replays: 0, clean: 0, forked: 0, tokensNotRespent: 0 };
  });
}

function breakdown(title: string, note: string, data: Record<string, number>, labels: Record<string, string>, unit: string, hints: Record<string, string> = {}): string {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const total = entries.reduce((n, [, v]) => n + v, 0);
  const max = entries[0]?.[1] ?? 0;
  const rows = entries.length
    ? entries
        .map(
          ([k, v]) =>
            `<li${hints[k] ? ` title="${esc(hints[k]!)}"` : ''}><span class="k">${esc(labels[k] ?? k)}</span><span class="track" aria-hidden="true"><i style="width:${height(v, max).toFixed(1)}%"></i></span><span class="n">${formatCount(v)}<small>${pct(v, total)}%</small></span></li>`,
        )
        .join('')
    : '<li class="none">nothing yet</li>';
  return `<section class="bd"><h3>${esc(title)}</h3><p class="note">${esc(note)} · ${esc(unit)}</p><ul>${rows}</ul></section>`;
}

export function renderDashboard(s: Stats, options: DashboardOptions = {}): string {
  const repo = options.repoUrl ?? REPO;
  const empty = s.events.total === 0;
  const generated = new Date(s.generatedAt);
  const generatedLabel = `${generated.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  const cleanRate30 = pct(s.replays.clean30d, s.replays.last30d);

  // ---- weekly active developers, 12 weeks
  const weeks = s.weekly;
  const weekMax = Math.max(0, ...weeks.map((w) => w.activeDevelopers));
  const weekCols = weeks
    .map((w, i) => {
      const current = i === weeks.length - 1;
      const label = `Week of ${shortDate(w.week)}${current ? ' (so far)' : ''}: ${w.activeDevelopers} developer${w.activeDevelopers === 1 ? '' : 's'} replayed, ${w.replays} replays`;
      return `<div class="col${current ? ' now' : ''}" title="${esc(label)}"><i style="height:${height(w.activeDevelopers, weekMax).toFixed(1)}%">${w.activeDevelopers ? `<b>${formatCount(w.activeDevelopers)}</b>` : ''}</i></div>`;
    })
    .join('');
  const weekAxis = weeks
    .map((w, i) => {
      const [, m, d] = w.week.split('-').map(Number);
      const prevMonth = i ? Number(weeks[i - 1]!.week.split('-')[1]) : 0;
      const month = m !== prevMonth ? MONTHS[(m ?? 1) - 1] : '';
      return i === weeks.length - 1 ? `<span class="now"><b>now</b><small>${month}</small></span>` : `<span><b>${d}</b><small>${month}</small></span>`;
    })
    .join('');
  const weekTable = weeks.map((w) => `<tr><td>${esc(w.week)}</td><td>${w.activeDevelopers}</td><td>${w.replays}</td></tr>`).join('');

  // ---- replays per day, 30 days, clean and forked
  const days = fillDays(s.daily, s.generatedAt);
  const dayMax = Math.max(0, ...days.map((d) => d.replays));
  const dayCols = days
    .map((d) => {
      const label = `${shortDate(d.day)}: ${d.replays} replay${d.replays === 1 ? '' : 's'}, ${d.clean} clean, ${d.forked} forked`;
      return `<div class="stack" title="${esc(label)}"><i class="f" style="height:${height(d.forked, dayMax).toFixed(1)}%"></i><i class="c" style="height:${height(d.clean, dayMax).toFixed(1)}%"></i></div>`;
    })
    .join('');
  const dayTable = days.map((d) => `<tr><td>${esc(d.day)}</td><td>${d.replays}</td><td>${d.clean}</td><td>${d.forked}</td></tr>`).join('');
  const emptyBanner = empty
    ? `<section class="empty" aria-label="No data yet"><div><h2>No events yet</h2><p>This collector has not received anything. Charts fill in as clients report. To send from a machine you control:</p></div><pre><code>export SHADOWLAP_TELEMETRY_URL=${esc(options.origin ?? 'https://<this host>')}/v1/events</code></pre></section>`
    : '';

  const favicon = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300"><g fill="none" stroke=\"#15140f\" stroke-width="46"><path d="M100 262V185A122 122 0 0 1 222 63"/><path d="M176 262V185A46 46 0 0 1 222 139"/></g></svg>')}`;
  const logo = '<svg class="logo" viewBox="0 0 300 300" aria-hidden="true"><g fill="none" stroke-width="46"><path d="M100 262V185A122 122 0 0 1 222 63"/><path d="M176 262V185A46 46 0 0 1 222 139"/></g></svg>';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Shadowlap usage</title>
<meta name="description" content="Public, aggregate usage of Shadowlap: weekly active developers, replays and how many were clean, tokens not re-spent. Anonymous opt-out telemetry, no prompts or tool data.">
<link rel="icon" href="${favicon}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@800;900&family=Inter:wght@400;500&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head>
<body>
<div class="frame">
  <nav class="nav">
    <a class="lock" href="${esc(repo)}">${logo}<b>shadowlap</b></a><span class="crumb">usage</span>
    <span class="sp"></span>
    <a class="lnk" href="${esc(repo)}/blob/main/docs/telemetry.md">What is collected</a>
    <a class="lnk" href="/v1/stats">JSON</a>
    <a class="lnk" href="${esc(repo)}">Source</a>
  </nav>

  <header class="hero">
    <div class="eyebrow"><s></s>public usage · anonymous · aggregate</div>
    <h1>Shadowlap, counted in the open.</h1>
    <p class="lede">Every number here comes from the CLI's opt-out telemetry: counts and versions, never prompts, tool data, file paths or names. A developer is an install that replayed at least once in the period.</p>
    <p class="meta">Updated <time datetime="${esc(generated.toISOString())}">${esc(generatedLabel)}</time> · refreshed every minute</p>
  </header>

  <section class="strip" aria-label="Headline numbers">
    <div class="stat"><b>${formatCount(s.installs.active7d)}</b><span>weekly active developers</span>${delta(s.installs.active7d, s.installs.active7dPrev)}</div>
    <div class="stat"><b>${formatCount(s.replays.last30d)}</b><span>replays, last 30 days</span>${s.replays.last30d ? `<em class="chip">${cleanRate30}% replayed clean</em>` : ''}</div>
    <div class="stat"><b>${formatCount(s.tokensNotRespent)}</b><span>input tokens not re-spent</span><em class="chip">all time</em></div>
    <div class="stat"><b>${formatCount(s.installs.ci)}</b><span>repositories replaying in CI</span><em class="chip">${formatCount(s.callsReplayed)} calls served from recordings</em></div>
  </section>
  ${emptyBanner}
  <section class="charts">
    <figure class="fig">
      <figcaption><h2>Weekly active developers</h2><span>installs that replayed, by week (Monday, UTC)</span></figcaption>
      <div class="chart weeks${empty ? ' is-empty' : ''}" role="img" aria-label="Weekly active developers over the last 12 weeks">
        <div class="plot">${weekCols}</div>
        <div class="axis">${weekAxis}</div>
      </div>
      <table class="sr"><caption>Weekly active developers</caption><tr><th>Week</th><th>Developers</th><th>Replays</th></tr>${weekTable}</table>
    </figure>

    <figure class="fig">
      <figcaption><h2>Replays per day</h2><span><i class="key c"></i>clean <i class="key f"></i>forked · last 30 days${dayMax ? ` · peak ${formatCount(dayMax)}` : ''}</span></figcaption>
      <div class="chart days${empty ? ' is-empty' : ''}" role="img" aria-label="Replays per day over the last 30 days, clean and forked">
        <div class="plot">${dayCols}</div>
        <div class="axis"><span>${shortDate(days[0]!.day)}</span><span>${shortDate(days[14]!.day)}</span><span>today</span></div>
      </div>
      <table class="sr"><caption>Replays per day</caption><tr><th>Day</th><th>Replays</th><th>Clean</th><th>Forked</th></tr>${dayTable}</table>
    </figure>
  </section>

  <section class="grid">
    ${breakdown('Why replays forked', 'the first difference, by kind', s.replays.divergenceByType, DIVERGENCE_LABELS, 'all time', DIVERGENCE_HINTS)}
    ${breakdown('Providers', 'model APIs seen in runs', s.providers, PROVIDER_LABELS, 'events, 30 days')}
    ${breakdown('How tools are recorded', 'SDKs and the MCP proxy', s.sdks, SDK_LABELS, 'events, 30 days')}
    ${breakdown('Operating systems', 'where Shadowlap runs', s.os, OS_LABELS, 'installs, 30 days')}
    ${breakdown('Continuous integration', 'recordings replayed in CI', s.ciSystems, CI_LABELS, 'installs, 30 days')}
    ${breakdown('Versions', 'what people have installed', s.versions, {}, 'installs, 30 days')}
  </section>

  <footer class="foot">
    <p><b>What is sent.</b> Event type, time, Shadowlap and Node versions, OS and architecture, CI system, provider and SDK names, and counts: calls, replayed, live, blocked, tokens not re-spent, duration, exit code. The collector rejects anything else, field by field. Install ids are random; in CI they are a hash, never a repository name.</p>
    <p><b>Opt out</b> with <code>SHADOWLAP_TELEMETRY=0</code> or <code>DO_NOT_TRACK=1</code>. <a href="/v1/stats">Raw aggregates as JSON</a> · <a href="${esc(repo)}/tree/main/packages/collector">collector source</a></p>
  </footer>
</div>
</body>
</html>
`;
}

const CSS = `
:root{--bg:#f0eee9;--panel:#e7e3da;--mass:#ddd8cc;--ink:#15140f;--dim:#55534a;--faint:#86826f;--line:#e2ded4;--line2:#cbc5b6;--grid:#e4e0d6;--spot:#0f8f8a;--warn:#b8860b;--ok:#2d7a45;--err:#b0413e;
--disp:Archivo,"Archivo Black",Inter,ui-sans-serif,system-ui,sans-serif;--body:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;--mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--gut:clamp(16px,4vw,56px);color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0f1012;--panel:#15171a;--mass:#22252a;--ink:#ecebe6;--dim:#a7a59d;--faint:#7a786f;--line:#1f2226;--line2:#2c3036;--grid:#141619;--spot:#62d1de;--warn:#e6c060;--ok:#7ecf8a;--err:#ff7b72;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14.5px/1.65 var(--body);background-image:linear-gradient(var(--grid) 1px,transparent 1px),linear-gradient(90deg,var(--grid) 1px,transparent 1px);background-size:72px 72px;padding-bottom:56px}
a{color:inherit}code{font-family:var(--mono);font-size:.9em}
.frame{max-width:1280px;margin:0 auto;overflow:hidden;background:var(--bg);border:1px solid var(--line2);border-top:0}
.nav{display:flex;align-items:center;gap:20px;padding:14px var(--gut);border-bottom:1px solid var(--line2);flex-wrap:wrap}
.lock{display:flex;align-items:center;gap:10px;text-decoration:none}.logo{width:18px;height:22px;fill:var(--ink)}
.lock b{font-family:var(--disp);font-weight:900;font-size:19px;letter-spacing:-.045em}
.crumb{font-family:var(--mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--spot);border:1px solid var(--line2);padding:3px 8px}
.sp{flex:1}.lnk{color:var(--dim);text-decoration:none;font-size:11.5px;letter-spacing:.07em;text-transform:uppercase}.lnk:hover{color:var(--ink)}
.hero{padding:clamp(32px,5vw,64px) var(--gut) clamp(28px,4vw,44px)}
.eyebrow{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;color:var(--spot);font-size:11px;letter-spacing:.3em;text-transform:uppercase}.eyebrow s{width:42px;height:1px;background:var(--spot)}
h1{font-family:var(--disp);font-weight:900;letter-spacing:-.05em;line-height:.95;font-size:clamp(34px,5.4vw,72px);margin:20px 0 0;text-wrap:balance}
.lede{color:var(--dim);max-width:62ch;margin:22px 0 0}.meta{color:var(--faint);font-size:12px;margin:12px 0 0;font-family:var(--mono)}
.strip{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border-top:1px solid var(--line2);border-bottom:1px solid var(--line2)}
.stat{padding:22px var(--gut) 24px;border-right:1px solid var(--line);display:flex;flex-direction:column;gap:8px;min-width:0}.stat:last-child{border-right:0}
.stat b{font-family:var(--disp);font-weight:900;font-size:clamp(30px,3.6vw,48px);letter-spacing:-.045em;line-height:1;font-variant-numeric:tabular-nums}
.stat span{color:var(--faint);font-size:10.5px;letter-spacing:.18em;text-transform:uppercase}
.chip{font-style:normal;font-family:var(--mono);font-size:11px;color:var(--dim);align-self:flex-start}.chip.up{color:var(--ok)}.chip.down{color:var(--err)}
.charts{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.35fr);border-bottom:1px solid var(--line2)}
.fig{margin:0;padding:26px var(--gut) 28px;min-width:0}.fig+.fig{border-left:1px solid var(--line)}
figcaption{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 14px;margin-bottom:18px}
figcaption h2{margin:0;font-family:var(--disp);font-weight:800;font-size:18px;letter-spacing:-.025em}
figcaption span{color:var(--faint);font-size:12px;min-width:0}
.key{display:inline-block;width:9px;height:9px;margin:0 5px 0 4px;vertical-align:-1px}.key.c{background:var(--spot)}.key.f{background:var(--warn)}
.chart .plot{height:190px;display:grid;align-items:end;border-bottom:1px solid var(--line2);background:linear-gradient(to top,transparent calc(50% - .5px),var(--line) calc(50% - .5px),var(--line) calc(50% + .5px),transparent calc(50% + .5px))}
.chart.weeks .plot{grid-template-columns:repeat(12,minmax(0,1fr));gap:clamp(3px,.8vw,10px)}
.chart.days .plot{grid-template-columns:repeat(30,minmax(0,1fr));gap:clamp(1px,.35vw,4px)}
.col{height:100%;display:flex;align-items:flex-end}
.col i{display:block;width:100%;background:var(--ink);position:relative}
.col.now i{background:repeating-linear-gradient(135deg,var(--ink) 0 3px,transparent 3px 6px);outline:1px solid var(--ink);outline-offset:-1px}
.col b{position:absolute;left:50%;bottom:calc(100% + 5px);transform:translateX(-50%);font:500 11px var(--mono);color:var(--dim);white-space:nowrap}
.stack{height:100%;display:flex;flex-direction:column;justify-content:flex-end}
.stack i{display:block;width:100%}.stack .c{background:var(--spot)}.stack .f{background:var(--warn)}
.stack:hover i,.col:hover i{opacity:.75}
.axis{display:flex;justify-content:space-between;margin-top:8px;color:var(--faint);font:11px var(--mono)}
.weeks .axis{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:clamp(3px,.8vw,10px);text-align:center}
.weeks .axis span{display:flex;flex-direction:column;line-height:1.35;white-space:nowrap}.weeks .axis b{font-weight:400}.weeks .axis small{font-size:10px;color:var(--faint);min-height:1.35em;letter-spacing:.04em}
.weeks .axis .now b{color:var(--ink);font-weight:500}
.is-empty .plot{opacity:.45}
.empty{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:14px 32px;align-items:center;padding:22px var(--gut);border-bottom:1px solid var(--line2);background:var(--panel)}
.empty h2{margin:0;font-family:var(--disp);font-weight:800;font-size:18px;letter-spacing:-.025em}.empty p{margin:4px 0 0;color:var(--dim);font-size:13px;max-width:60ch}
.empty pre{margin:0;padding:10px 14px;border:1px solid var(--line2);background:var(--bg);overflow-x:auto;max-width:100%;font-size:12.5px}
.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr))}
.bd{padding:24px var(--gut) 26px;border-right:1px solid var(--line);border-bottom:1px solid var(--line);min-width:0}
.bd:nth-child(3n){border-right:0}.bd:nth-last-child(-n+3){border-bottom:0}
.bd h3{margin:0;font-family:var(--disp);font-weight:800;font-size:16px;letter-spacing:-.02em}
.bd .note{margin:3px 0 14px;color:var(--faint);font-size:11.5px}
.bd ul{list-style:none;margin:0;padding:0;display:grid;gap:9px}
.bd li{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr) auto;align-items:center;gap:12px;font-size:13px}
.bd .k{color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bd .track{height:8px;background:var(--panel)}.bd .track i{display:block;height:100%;background:var(--spot)}
.bd .n{font:500 12.5px var(--mono);font-variant-numeric:tabular-nums;text-align:right;min-width:62px}.bd .n small{color:var(--faint);margin-left:6px;font-weight:400}
.bd .none{display:block;color:var(--faint);font-size:12.5px}
.foot{border-top:1px solid var(--line2);padding:22px var(--gut) 26px;display:grid;gap:10px;color:var(--dim);font-size:12.5px;max-width:none}
.foot p{margin:0;max-width:92ch}.foot b{color:var(--ink);font-weight:500}.foot a{color:var(--spot);text-decoration:none}.foot a:hover{text-decoration:underline}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
a:focus-visible{outline:2px solid var(--spot);outline-offset:2px}
@media (max-width:980px){.charts{grid-template-columns:minmax(0,1fr)}.fig+.fig{border-left:0;border-top:1px solid var(--line)}.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.bd:nth-child(3n){border-right:1px solid var(--line)}.bd:nth-child(2n){border-right:0}.bd:nth-last-child(-n+3){border-bottom:1px solid var(--line)}.bd:nth-last-child(-n+2){border-bottom:0}}
@media (max-width:720px){.strip{grid-template-columns:repeat(2,minmax(0,1fr))}.stat:nth-child(2){border-right:0}.stat:nth-child(-n+2){border-bottom:1px solid var(--line)}.weeks .axis span:nth-child(odd):not(.now) b{visibility:hidden}.col b{display:none}.empty{grid-template-columns:minmax(0,1fr)}}
@media (max-width:560px){.grid{grid-template-columns:minmax(0,1fr)}.eyebrow{letter-spacing:.18em}.stat span{letter-spacing:.1em}.bd{border-right:0!important;border-bottom:1px solid var(--line)!important}.bd:last-child{border-bottom:0!important}.lnk{font-size:10.5px}}
`;
