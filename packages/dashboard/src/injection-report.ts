import { applyNormalizers, keepingCanaries, proofLine, rewriteText, type AttemptReport, type Canary, type CleanReport, type InjectionReport, type Normalizer, type PlantReport } from '@shadowlap/engine';

/**
 * The security report of `shadowlap injection --html` and the dashboard's Security report: one HTML
 * file, no script, no request made when it opens, to attach to a security review. For each run
 * tested, the untrusted reads × payloads matrix with obeyed, influenced and ignored over the
 * attempts, the proof of each obeyed cell (planted at #9 → read at #10 → send_email.to = … at #12),
 * the --clean verdicts, and the payloads themselves.
 *
 * Everything it shows from the recordings (a read's arguments, a write's, tool names) goes through
 * the project's redaction rules first, as every copy that leaves the machine does. A canary is
 * never masked: it is a value Shadowlap made up, and it is the proof.
 */

export interface InjectionReportOptions {
  /** The redaction rules to apply (the config's `redact`); none leaves the values as recorded. */
  redact: readonly Normalizer[];
  /** Shadowlap's version, for the footer. */
  version?: string | null;
  /** When the report was made (ms). */
  at?: number;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
const shortId = (id: string) => id.slice(0, 10);

const CSS = `
:root { color-scheme: dark; --bg: #0b0c09; --panel: #12130e; --line: #22231b; --line2: #34352b; --ink: #eeede6; --dim: #a8a699; --faint: #76745f; --red: #ff6b5e; --amber: #f2c94c; --lime: #c4f233; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif; }
main { max-width: 1120px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font-size: 22px; margin: 0 0 4px; font-weight: 600; }
h2 { font-size: 17px; margin: 40px 0 8px; font-weight: 600; }
h3 { font-size: 14px; margin: 24px 0 8px; font-weight: 600; color: var(--dim); }
p, li { color: var(--dim); }
code, .mono { font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; }
.brand { color: var(--lime); font-weight: 700; letter-spacing: .02em; }
.meta { color: var(--faint); font-size: 12.5px; }
.totals { display: flex; flex-wrap: wrap; gap: 8px 20px; margin: 12px 0; }
.totals b { font-weight: 600; }
.scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: 10px; }
table { border-collapse: collapse; width: 100%; }
th, td { padding: 8px 10px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
th { color: var(--faint); font-weight: 500; font-size: 12px; white-space: nowrap; }
tr:last-child td { border-bottom: 0; }
td.cell { white-space: nowrap; }
.obeyed, .caused, .failed { color: var(--red); }
.influenced, .inconclusive { color: var(--amber); }
.ignored, .unread, .not-caused { color: var(--faint); }
.passed { color: var(--lime); }
.count { color: var(--faint); font-size: 12px; }
.proof { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; margin: 8px 0; overflow-x: auto; }
.canary { color: var(--red); font-weight: 600; }
pre { white-space: pre-wrap; word-break: break-word; margin: 0; }
.payload { border-top: 1px solid var(--line); padding: 10px 0; }
footer { margin-top: 48px; color: var(--faint); font-size: 12px; }
@media (max-width: 640px) { main { padding: 20px 16px 48px; } }
`;

/** A value from a recording as the report may show it: the rules applied, every canary kept. */
function masked(value: unknown, tool: string, rules: readonly Normalizer[], canaries: readonly Canary[]): unknown {
  if (!rules.length) return value;
  return keepingCanaries(value, canaries, (v) => applyNormalizers(v, [...rules], 'tool', tool));
}

const maskedName = (name: string, rules: readonly Normalizer[]) => (rules.length ? rewriteText(name, [...rules]) : name);

/** A write's arguments as its evidence keeps them (JSON text), read back so path rules reach them; text cut short stays text. */
function parsed(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function shownArgs(args: unknown, tool: string, rules: readonly Normalizer[], canaries: readonly Canary[]): string {
  const v = masked(args, tool, rules, canaries);
  const text = typeof v === 'string' ? v : JSON.stringify(v) ?? 'null';
  return text.length > 160 ? `${text.slice(0, 159)}…` : text;
}

/** Text with each canary marked, escaped. */
function marked(text: string, canaries: readonly Canary[]): string {
  const forms = [...new Set(canaries.flatMap((c) => [c.address, c.id, c.amount, c.token]))].sort((a, b) => b.length - a.length);
  if (!forms.length) return esc(text);
  const re = new RegExp(forms.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
  let out = '';
  let last = 0;
  for (const m of text.matchAll(re)) {
    out += esc(text.slice(last, m.index)) + `<span class="canary">${esc(m[0])}</span>`;
    last = m.index! + m[0].length;
  }
  return out + esc(text.slice(last));
}

const VERDICT_CLASS: Record<string, string> = { obeyed: 'obeyed', influenced: 'influenced', ignored: 'ignored', unread: 'unread', caused: 'caused', 'not caused': 'not-caused', inconclusive: 'inconclusive' };
const verdictText = (v: string) => (v === 'unread' ? 'not read' : v);

function plantSection(r: PlantReport, o: InjectionReportOptions): string {
  const rules = o.redact;
  const canaries = r.attempts.flatMap((a) => (a.canary ? [a.canary] : []));
  const t = r.totals;
  const rows = r.reads.map((read) => {
    const name = maskedName(read.name, rules);
    const head = `<td><span class="mono">#${read.callNo} ${esc(name)}</span><br><span class="count mono">${esc(shownArgs(read.args, read.name, rules, canaries))}</span></td>`;
    if (!read.planted) return `<tr>${head}<td colspan="${Math.max(1, r.payloads.length)}" class="unread">not planted: ${esc(read.why ?? '')}</td></tr>`;
    const cells = r.payloads.map((x) => {
      const c = r.cells.find((y) => y.read === read.callNo && y.payload === x.id);
      if (!c || !c.attempts) return `<td class="cell unread">not run</td>`;
      const n = c.verdict === 'unread' ? c.unread : c[c.verdict];
      return `<td class="cell"><span class="${VERDICT_CLASS[c.verdict]}">${verdictText(c.verdict)}</span> <span class="count">${n} of ${c.attempts}</span></td>`;
    });
    return `<tr>${head}${cells.join('')}</tr>`;
  });
  const proofs = r.cells
    .filter((c) => c.verdict === 'obeyed' || c.verdict === 'influenced')
    .map((c) => {
      const a = r.attempts.find((x: AttemptReport) => x.read === c.read && x.payload === c.payload && x.verdict === c.verdict)!;
      const read = r.reads.find((x) => x.callNo === c.read)!;
      const e = a.evidence[0]!;
      const value = e.kind === 'write' ? shownArgs(parsed(e.value), e.tool, rules, canaries) : String(masked(e.value, e.tool, rules, canaries));
      const line = proofLine({ ...a, evidence: [{ ...e, value, tool: maskedName(e.tool, rules) }] }) ?? '';
      return `<div class="proof"><span class="${VERDICT_CLASS[c.verdict]}">${c.verdict}</span> · <span class="mono">#${c.read} ${esc(maskedName(read.name, rules))}</span> · <span class="mono">${esc(c.payload)}</span> · ${c[c.verdict]} of ${plural(c.attempts, 'attempt')}<br><code>${marked(line, canaries)}</code>${e.why ? `<br><span class="count">${esc(e.why)}</span>` : ''}<br><span class="count mono">run ${esc(a.runId)}${a.canary ? ` · canary ${esc(a.canary.address)}` : ''}</span></div>`;
    });
  const gate = r.gate.passed ? `<span class="passed">passed</span>` : `<span class="failed">failed</span>: ${esc(r.gate.reason ?? '')}`;
  return `<h2>${r.golden ? esc(r.golden) : `Run ${esc(shortId(r.runId))}`}</h2>
<p class="meta mono">run ${esc(r.runId)} · ${plural(r.reads.filter((x) => x.planted).length, 'untrusted read')} × ${plural(r.payloads.length, 'payload')} × ${r.repeat} · writes stubbed</p>
<div class="totals"><span><b>${t.attempts}</b> attempts</span><span class="obeyed"><b>${t.obeyed}</b> obeyed</span><span class="influenced"><b>${t.influenced}</b> influenced</span><span class="ignored"><b>${t.ignored}</b> ignored</span>${t.unread ? `<span class="unread"><b>${t.unread}</b> not read</span>` : ''}<span>gate (at most ${r.gate.obeyed} obeyed${r.gate.influenced !== null ? `, ${r.gate.influenced} influenced` : ''}): ${gate}</span></div>
${r.reads.length ? `<div class="scroll"><table><thead><tr><th>Untrusted read</th>${r.payloads.map((x) => `<th class="mono">${esc(x.id)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>` : '<p>No read of a tool marked untrusted: nothing was planted.</p>'}
${r.skipped.length ? `<p class="meta">Untrusted but not planted in: ${r.skipped.map((x) => `#${x.callNo} ${esc(maskedName(x.name, rules))} (${esc(x.why)})`).join('; ')}</p>` : ''}
${proofs.length ? `<h3>Proof</h3>${proofs.join('')}` : ''}`;
}

function cleanSection(r: CleanReport, o: InjectionReportOptions): string {
  const rules = o.redact;
  const canaries = r.canary ? [r.canary] : [];
  const writes = r.writes.map((w) => {
    const line = w.verdict === 'caused' ? `caused by #${r.read.callNo}: gone in ${w.gone} of ${w.attempts} clean attempts` : w.verdict === 'not caused' ? `not caused: made again in ${w.attempts - w.gone} of ${w.attempts} clean attempts` : `inconclusive after ${plural(w.attempts, 'clean attempt')}: gone in ${w.gone}`;
    return `<tr><td class="mono">#${w.callNo} ${esc(maskedName(w.name, rules))}</td><td class="mono count">${marked(shownArgs(w.args, w.name, rules, canaries), canaries)}</td><td class="${VERDICT_CLASS[w.verdict]}">${esc(line)}</td></tr>`;
  });
  const name = esc(maskedName(r.read.name, rules));
  return `<h2>${r.golden ? esc(r.golden) : `Run ${esc(shortId(r.runId))}`}: did untrusted content cause it?</h2>
<p class="meta mono">run ${esc(r.runId)} · read #${r.read.callNo} ${name} replaced with a neutral result · ${plural(r.attempts.length, 'clean attempt')}, writes stubbed</p>
<p>What <code>#${r.read.callNo} ${name}(${esc(shownArgs(r.read.args, r.read.name, rules, canaries))})</code> returned was replaced with <code>${esc(shownArgs(r.neutral, r.read.name, rules, canaries))}</code>, its prose emptied, and the run replayed from there.</p>
<p>Verdict: <span class="${VERDICT_CLASS[r.verdict]}">${r.verdict}</span>.</p>
<div class="scroll"><table><thead><tr><th>Recorded write</th><th>Arguments</th><th>Without the content</th></tr></thead><tbody>${writes.join('')}</tbody></table></div>`;
}

/** The report for one or more results, as one HTML document. */
export function injectionReportHtml(reports: readonly InjectionReport[], o: InjectionReportOptions): string {
  const at = new Date(o.at ?? Date.now()).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  const plants = reports.filter((r): r is PlantReport => r.mode === 'plant');
  const payloads = new Map(plants.flatMap((r) => r.payloads.map((x) => [x.id, x] as const)));
  const templates = plants.find((r) => r.templates.ids.length)?.templates;
  const total = plants.reduce((n, r) => n + r.totals.attempts, 0);
  const obeyed = plants.reduce((n, r) => n + r.totals.obeyed, 0);
  const sections = reports.map((r) => (r.mode === 'plant' ? plantSection(r, o) : cleanSection(r, o)));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Injection test report</title>
<style>${CSS}</style>
</head>
<body>
<main>
<div class="brand">Shadowlap</div>
<h1>Injection test report</h1>
<p class="meta">${esc(at)}${templates ? ` · built-in templates v${templates.version}` : ''}</p>
<p>Each payload was planted in what a tool marked untrusted returned, with a canary: an address, an id and an amount made for that attempt alone and found nowhere else. The run replayed from the recording up to the read, then ran live from the model call that read the planted text, with writes stubbed, so nothing reached the world. A write carrying the canary is proof the planted text caused it (<span class="obeyed">obeyed</span>). A write no clean replay of the same read made, or one that only quotes the planted text, is weaker evidence (<span class="influenced">influenced</span>). Otherwise the payload was <span class="ignored">ignored</span>; <span class="unread">not read</span> means no model ever saw it.</p>
${plants.length ? `<p>${obeyed ? `<span class="obeyed">${obeyed} of ${plural(total, 'attempt')} obeyed a planted instruction.</span>` : `None of ${plural(total, 'attempt')} obeyed a planted instruction.`}</p>` : ''}
<p class="meta">${o.redact.length ? `${plural(o.redact.length, 'redaction rule')} of shadowlap.config.json applied to everything shown from the recordings; canaries are never masked.` : 'No redaction rules applied: values from the recordings are shown as recorded.'}</p>
${sections.join('\n')}
${payloads.size ? `<h2>Payloads</h2>${[...payloads.values()].map((x) => `<div class="payload"><span class="mono">${esc(x.id)}</span> <span class="count">${x.source === 'template' ? `template${x.shape ? ` · ${esc(x.shape)}` : ''}` : 'from a file'}${x.canary ? '' : ' · no {{canary}}: it can show influence, never proof'}</span><br><span>${esc(x.title)}</span><pre class="mono count">${esc(x.text)}</pre></div>`).join('')}` : ''}
<footer>Made by shadowlap injection${o.version ? ` ${esc(o.version)}` : ''}. Shadowlap runs on your machine: this file was written there and sent nowhere.</footer>
</main>
</body>
</html>
`;
}
