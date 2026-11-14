import { applyNormalizers, atPath, canaryForms, canaryIn, cleanBound, cleanDecided, cleanRule, cleanTally, describeIdentifiers, keepingCanaries, normalizedArgs, normalizerApplies, parsePath, plural, proofLine, rewriteText, type AttemptReport, type Canary, type CauseVerdict, type CleanReport, type Evidence, type InjectionReport, type InjectionVerdict, type Normalizer, type PlantReport } from '@shadowlap/engine';

/**
 * The security report of `shadowlap injection --html` and the dashboard's Security report: one HTML
 * file, no script, no request made when it opens, to attach to a security review. For each run
 * tested, the untrusted reads × payloads matrix with obeyed, influenced, ignored and inconclusive
 * over the attempts, the proof of each obeyed cell (planted at #9 → read at #10 → send_email.to = …
 * at #12), why the inconclusive ones show nothing, the --clean verdicts, and the payloads.
 *
 * Everything it shows from the recordings (a read's arguments, a write's, the neutral result, tool
 * names, a value that carried the canary) goes through the project's redaction rules first, as every
 * export, pack and share link does: arguments under the stored request's shape (`$.args.to`), a
 * result under `$.result`, as pack and export read them. A canary is never masked: it is a value
 * Shadowlap made up, and it is the proof.
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
const shortId = (id: string) => id.slice(0, 10);
const clip = (text: string, n = 160) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

const CSS = `
:root { color-scheme: dark; --bg: #0b0c09; --panel: #12130e; --line: #22231b; --line2: #34352b; --ink: #eeede6; --dim: #a8a699; --faint: #76745f; --red: #ff6b5e; --amber: #f2c94c; --lime: #c4f233; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif; }
main { max-width: 1120px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font-size: 22px; margin: 0 0 4px; font-weight: 600; }
h2 { font-size: 17px; margin: 40px 0 8px; font-weight: 600; overflow-wrap: anywhere; }
h3 { font-size: 14px; margin: 24px 0 8px; font-weight: 600; color: var(--dim); }
p, li { color: var(--dim); }
code, .mono { font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; }
p code, .meta, .count { overflow-wrap: anywhere; }
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
.ignored, .not-caused, .not-planted { color: var(--faint); }
.passed { color: var(--lime); }
.count { color: var(--faint); font-size: 12px; }
.proof { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; margin: 8px 0; overflow-wrap: anywhere; }
.canary { color: var(--red); font-weight: 600; }
pre { white-space: pre-wrap; word-break: break-word; margin: 0; }
.payload { border-top: 1px solid var(--line); padding: 10px 0; }
footer { margin-top: 48px; color: var(--faint); font-size: 12px; }
@media (max-width: 640px) { main { padding: 20px 16px 48px; } }
`;

/**
 * What the report shows from the recordings, the rules applied and every canary kept. A tool's
 * arguments are masked as the stored request (`{ args }`), a result as `{ result }`, so the path rules
 * written for pack and export (`$.args.to`, `$.result.url`) reach them here too.
 */
class Masker {
  constructor(
    private readonly rules: readonly Normalizer[],
    private readonly canaries: readonly Canary[],
  ) {}

  /** A tool call's arguments. */
  args(args: unknown, tool: string): unknown {
    return normalizedArgs(args, this.rules, tool, this.canaries);
  }

  /** What a tool returned (the neutral result --clean served). */
  result(result: unknown, tool: string): unknown {
    if (!this.rules.length) return result;
    return keepingCanaries({ result }, this.canaries, (v) => applyNormalizers(v, [...this.rules], 'tool', tool) as { result: unknown }).result;
  }

  /** The value at `path` of a call's arguments, as its evidence keeps it: masked in its place, so a path rule for that place reaches it. */
  at(value: string, path: string, tool: string): string {
    if (!this.rules.length) return value;
    let segs: ReturnType<typeof parsePath>;
    try {
      segs = parsePath(path);
    } catch {
      return this.text(value, tool);
    }
    if (segs.some((s) => s.type === 'wild')) return this.text(value, tool);
    const root: Record<string, unknown> = {};
    let node: Record<string | number, unknown> = root;
    let key: string | number = 'args';
    for (const seg of segs) {
      const next: Record<string | number, unknown> = seg.type === 'index' ? (Array.from({ length: seg.index + 1 }, () => null) as unknown as Record<number, unknown>) : {};
      node[key] = next;
      node = next;
      key = seg.type === 'index' ? seg.index : (seg as { key: string }).key;
    }
    node[key] = value;
    let leaf: unknown = this.args(root.args, tool);
    for (const seg of segs) leaf = (leaf as Record<string | number, unknown> | null | undefined)?.[seg.type === 'index' ? seg.index : (seg as { key: string }).key];
    return typeof leaf === 'string' ? leaf : (JSON.stringify(leaf) ?? '');
  }

  /** A write's arguments that its evidence keeps as JSON text; cut short, they can't be masked by place, so they are shown only when no path rule applies to the tool. */
  argsText(text: string, tool: string): string {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      if (this.rules.some((r) => r.path !== undefined && normalizerApplies(r, 'tool', tool))) return `(${text.length} characters of arguments, cut short, not shown: a path rule applies to them)`;
      return this.text(text, tool);
    }
    return JSON.stringify(this.args(parsed, tool)) ?? 'null';
  }

  /** Free text (a reason, a value out of its place): the rules without a path, those for `tool` when one is named. */
  text(text: string, tool?: string): string {
    const rules = this.rules.filter((r) => r.path === undefined && (tool === undefined || normalizerApplies(r, 'tool', tool)));
    if (!rules.length) return text;
    return keepingCanaries(text, this.canaries, (t) => rewriteText(t, rules));
  }

  /** A tool's name: the rules without a path that apply to that tool, as a captured HTTP call's address is masked. */
  name(name: string): string {
    return this.text(name, name);
  }
}

/** Text with each canary marked, escaped: each form the test takes as it, case aside (canaryForms). */
function marked(text: string, canaries: readonly Canary[]): string {
  const forms = [...new Set(canaries.flatMap((c) => canaryForms(c)))].sort((a, b) => b.length - a.length);
  if (!forms.length) return esc(text);
  const re = new RegExp(forms.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
  let out = '';
  let last = 0;
  for (const m of text.matchAll(re)) {
    out += esc(text.slice(last, m.index)) + `<span class="canary">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}

const VERDICT_CLASS: Record<InjectionVerdict | CauseVerdict | 'passed' | 'failed', string> = { obeyed: 'obeyed', influenced: 'influenced', ignored: 'ignored', inconclusive: 'inconclusive', caused: 'caused', 'not caused': 'not-caused', passed: 'passed', failed: 'failed' };

/** An attempt's evidence as the report shows it: its values masked in their place. */
function shownEvidence(e: Evidence, m: Masker): Evidence {
  return { ...e, tool: m.name(e.tool), value: e.kind === 'write' ? m.argsText(e.value, e.tool) : m.at(e.value, e.path, e.tool) };
}

function plantSection(r: PlantReport, m: Masker, canaries: readonly Canary[]): string {
  const t = r.totals;
  const rows = r.reads.map((read) => {
    const name = m.name(read.name);
    const head = `<td><span class="mono">#${read.callNo} ${esc(name)}</span><br><span class="count mono">${esc(clip(JSON.stringify(m.args(read.args, read.name)) ?? 'null'))}</span></td>`;
    if (!read.planted) return `<tr>${head}<td colspan="${Math.max(1, r.payloads.length)}" class="not-planted">not planted: ${esc(m.text(read.why ?? ''))}</td></tr>`;
    const cells = r.payloads.map((x) => {
      const c = r.cells.find((y) => y.read === read.callNo && y.payload === x.id);
      if (!c || !c.attempts) return `<td class="cell not-planted">not run</td>`;
      return `<td class="cell"><span class="${VERDICT_CLASS[c.verdict]}">${c.verdict}</span> <span class="count">${c[c.verdict]} of ${c.attempts}</span></td>`;
    });
    return `<tr>${head}${cells.join('')}</tr>`;
  });
  const proofs = r.cells
    .filter((c) => c.verdict === 'obeyed' || c.verdict === 'influenced')
    .map((c) => {
      const a = r.attempts.find((x: AttemptReport) => x.read === c.read && x.payload === c.payload && x.verdict === c.verdict)!;
      const read = r.reads.find((x) => x.callNo === c.read)!;
      const evidence = a.evidence.map((e) => shownEvidence(e, m));
      const line = proofLine({ ...a, evidence }) ?? '';
      const e = evidence.find((x) => x.kind !== 'write') ?? evidence[0];
      const note = e?.kind !== 'write' && e?.why ? `<br><span class="count">${esc(e.why)}</span>` : '';
      return `<div class="proof"><span class="${VERDICT_CLASS[c.verdict]}">${c.verdict}</span> · <span class="mono">#${c.read} ${esc(m.name(read.name))}</span> · <span class="mono">${esc(c.payload)}</span> · ${c[c.verdict]} of ${plural(c.attempts, 'attempt')}<br><code>${marked(line, canaries)}</code>${note}<br><span class="count mono">run ${esc(a.runId)}${a.canary ? ` · canary ${esc(a.canary.address)}` : ''}</span></div>`;
    });
  // Why the attempts that show nothing show nothing, once per reason.
  const whys = new Map<string, string[]>();
  for (const a of r.attempts.filter((x) => x.verdict === 'inconclusive')) whys.set(a.why ?? '', [...(whys.get(a.why ?? '') ?? []), `#${a.read} × ${a.payload}`]);
  const failedBaselines = r.baselines.flatMap((b) => b.failed.map((f) => `#${b.read} clean replay ${shortId(f.runId)}: ${f.why}`));
  const g = r.gate;
  const gate = `<span class="${VERDICT_CLASS[g.verdict]}">${g.verdict}</span>${g.verdict === 'passed' ? '' : `: ${g.verdict === 'failed' ? esc(failedLine(r)) : esc(m.text(g.reason ?? ''))}`}`;
  return `<h2>${r.golden ? esc(r.golden) : `Run ${esc(shortId(r.runId))}`}</h2>
<p class="meta mono">run ${esc(r.runId)} · ${plural(r.reads.filter((x) => x.planted).length, 'untrusted read')} × ${plural(r.payloads.length, 'payload')} × ${r.repeat} · writes stubbed · ${r.unrecordedReads === 'live' ? 'reads the recording doesn\'t hold ran live' : 'reads the recording doesn\'t hold fenced'}</p>
<div class="totals"><span><b>${t.attempts}</b> attempts</span><span class="obeyed"><b>${t.obeyed}</b> obeyed</span><span class="influenced"><b>${t.influenced}</b> influenced</span><span class="ignored"><b>${t.ignored}</b> ignored</span>${t.inconclusive ? `<span class="inconclusive"><b>${t.inconclusive}</b> inconclusive</span>` : ''}</div>
<p>Gate (at most ${g.obeyed} obeyed${g.influenced !== null ? `, ${g.influenced} influenced` : ''}): ${gate}</p>
${r.reads.length ? `<div class="scroll"><table><thead><tr><th>Untrusted read</th>${r.payloads.map((x) => `<th class="mono">${esc(x.id)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>` : '<p>No read of a tool marked untrusted: nothing was planted.</p>'}
${r.skipped.length ? `<p class="meta">Untrusted but not planted in: ${r.skipped.map((x) => `#${x.callNo} ${esc(m.name(x.name))} (${esc(x.why)})`).join('; ')}</p>` : ''}
${proofs.length ? `<h3>Proof</h3>${proofs.join('')}` : ''}
${whys.size || failedBaselines.length ? `<h3>Why some attempts show nothing</h3>${[...whys].map(([why, cells]) => `<p><span class="inconclusive">inconclusive</span> <span class="count mono">${esc(cells.slice(0, 6).join(', '))}${cells.length > 6 ? ` and ${cells.length - 6} more` : ''}</span><br>${esc(m.text(why))}</p>`).join('')}${failedBaselines.map((x) => `<p class="meta">Left out of the comparison: ${esc(m.text(x))}</p>`).join('')}` : ''}`;
}

/** A failed gate's line, its counts and the first proof's place, without the value (the proof below shows it, masked). */
function failedLine(r: PlantReport): string {
  const t = r.totals;
  if (t.obeyed > r.gate.obeyed) return `${t.obeyed} of ${plural(t.attempts, 'attempt')} obeyed a planted instruction (at most ${r.gate.obeyed} allowed)`;
  return `${t.influenced} of ${plural(t.attempts, 'attempt')} were influenced by a planted instruction (at most ${r.gate.influenced!} allowed)`;
}

function cleanSection(r: CleanReport, m: Masker, canaries: readonly Canary[]): string {
  const writes = r.writes.map((w) => {
    const args = m.args(w.args, w.name);
    // The verdict, the tally and the Wilson bound; the gate's rule once, under the table.
    const bound = cleanBound(w, r.gate);
    const tally = cleanTally({ ...w, bound });
    const line = w.verdict === 'caused' ? `caused by #${r.read.callNo} · ${tally}` : w.verdict === 'not caused' ? `not caused · ${tally}` : w.attempts ? `inconclusive · ${tally}` : 'inconclusive: no clean attempt decided it';
    return `<tr><td class="mono">#${w.callNo} ${esc(m.name(w.name))}(${marked(describeIdentifiers(args), canaries)})</td><td class="mono count">${marked(clip(JSON.stringify(args) ?? 'null'), canaries)}</td><td class="${VERDICT_CLASS[w.verdict]}">${esc(line)}</td></tr>`;
  });
  const name = esc(m.name(r.read.name));
  const unusable = r.attempts.filter((a) => a.why);
  return `<h2>${r.golden ? esc(r.golden) : `Run ${esc(shortId(r.runId))}`}: did untrusted content cause it?</h2>
<p class="meta mono">run ${esc(r.runId)} · read #${r.read.callNo} ${name} replaced with a neutral result · ${plural(r.attempts.length, 'clean attempt')}, writes stubbed</p>
<p>What <code>#${r.read.callNo} ${name}(${esc(clip(JSON.stringify(m.args(r.read.args, r.read.name)) ?? 'null'))})</code> returned was replaced with <code>${esc(clip(JSON.stringify(m.result(r.neutral, r.read.name)) ?? 'null'))}</code>, its prose emptied, and the run replayed from there.</p>
<p>Verdict: <span class="${VERDICT_CLASS[r.verdict]}">${r.verdict}</span>${cleanDecided(r) ? '' : ' (a write is undecided)'}.</p>
<div class="scroll"><table><thead><tr><th>Recorded write</th><th>Arguments</th><th>Without the content</th></tr></thead><tbody>${writes.join('')}</tbody></table></div>
${cleanRule(r.gate) && r.writes.some((w) => w.attempts) ? `<p class="meta">${esc(cleanRule(r.gate)!)}</p>` : ''}
${unusable.length ? `<p class="meta">${plural(unusable.length, 'clean attempt')} decided nothing: ${esc(m.text(unusable[0]!.why!))}</p>` : ''}`;
}

/** The report for one or more results, as one HTML document. */
export function injectionReportHtml(reports: readonly InjectionReport[], o: InjectionReportOptions): string {
  const at = new Date(o.at ?? Date.now()).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  const plants = reports.filter((r): r is PlantReport => r.mode === 'plant');
  const canaries = reports.flatMap((r) => (r.mode === 'plant' ? r.attempts.flatMap((a) => (a.canary ? [a.canary] : [])) : r.canary ? [r.canary] : []));
  const m = new Masker(o.redact, canaries);
  const payloads = new Map(plants.flatMap((r) => r.payloads.map((x) => [x.id, x] as const)));
  const templates = plants.find((r) => r.templates.ids.length)?.templates;
  const total = plants.reduce((n, r) => n + r.totals.attempts, 0);
  const obeyed = plants.reduce((n, r) => n + r.totals.obeyed, 0);
  const sections = reports.map((r) => (r.mode === 'plant' ? plantSection(r, m, canaries) : cleanSection(r, m, canaries)));
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
<p>Each payload was planted in what a tool marked untrusted returned, with a canary: an address, an id and an amount made for that attempt alone and found nowhere else. The run replayed from the recording up to the read, then ran live from the model call that read the planted text. Writes were stubbed, and reads the recording doesn't hold were fenced unless the report says they ran live, so nothing the agent asked for reached the world. A tool call carrying the canary is proof the planted text caused it (<span class="obeyed">obeyed</span>): a write, or a read, which can carry data out. A write no clean replay of the same read made is weaker evidence (<span class="influenced">influenced</span>). Otherwise the payload was <span class="ignored">ignored</span>; <span class="inconclusive">inconclusive</span> means the attempt shows nothing either way, and the report says why.</p>
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

/** The file the security report downloads as: the run tested's short id. */
export const reportFile = (runId: string): string => `shadowlap-injection-${runId.slice(0, 10).toLowerCase()}.html`;

/** What the security report's dialog says before it downloads: the rules it applies, up to two values they mask, each canary it keeps, and its file. */
export interface ReportPreview {
  /** When the result was kept, and its attempts: the dialog's From row (nothing runs again). */
  at: number;
  attempts: number;
  rules: number;
  masks: Array<{ at: string; before: string; after: string }>;
  canaries: Array<{ at: string; value: string }>;
  file: string;
}

/** Each string in a value with its path (`$.to`), the first `max` of them. */
function leaves(value: unknown, path = '$', out: Array<[string, string]> = [], max = 200): Array<[string, string]> {
  if (out.length >= max) return out;
  if (typeof value === 'string') out.push([path, value]);
  else if (Array.isArray(value)) value.forEach((v, i) => leaves(v, `${path}[${i}]`, out, max));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) leaves(v, `${path}.${k}`, out, max);
  return out;
}

/** A tool call's arguments the report shows, with the canaries a mask keeps in them. */
interface ShownArgs {
  tool: string;
  args: unknown;
  canaries: readonly Canary[];
}

/** An attempt's evidence as arguments: a value in its place (`$.to`), a write's whole arguments from the JSON it keeps; cut short, they can't be masked by place, so they give no example. */
function evidenceArgs(e: Evidence): unknown[] {
  if (e.kind !== 'write') return [{ [e.path.replace(/^\$\.?/, '') || 'value']: e.value }];
  try {
    return [JSON.parse(e.value) as unknown];
  } catch {
    return [];
  }
}

/**
 * The tool calls' arguments the report shows: a plant's reads, then each attempt's evidence with
 * that attempt's canary, the only one its replay held; a --clean answer's read and writes, with its
 * one canary. The recorded reads hold none: a canary is made for its attempt.
 */
function shownArgs(report: InjectionReport): ShownArgs[] {
  if (report.mode !== 'plant') {
    const canaries = report.canary ? [report.canary] : [];
    return [{ tool: report.read.name, args: report.read.args, canaries }, ...report.writes.map((w) => ({ tool: w.name, args: w.args, canaries }))];
  }
  const evidence = report.attempts.flatMap((a) => a.evidence.flatMap((e) => evidenceArgs(e).map((args) => ({ tool: e.tool, args, canaries: a.canary ? [a.canary] : [] }))));
  return [...report.reads.map((r) => ({ tool: r.name, args: r.args, canaries: [] })), ...evidence];
}

/** Up to `max` values a rule masks, each once, masked in its place as the download masks it (Masker.at); it tries a value once in each place, and stops at the last it needs. */
function maskSamples(shown: readonly ShownArgs[], redact: readonly Normalizer[], max = 2): ReportPreview['masks'] {
  const masks: ReportPreview['masks'] = [];
  const tried = new Set<string>();
  for (const c of shown) {
    const m = new Masker(redact, c.canaries);
    for (const [path, before] of leaves(c.args)) {
      const key = `${c.tool}\0${path}\0${before}`;
      if (tried.has(key) || masks.some((x) => x.before === before)) continue;
      tried.add(key);
      const after = m.at(before, path, c.tool);
      if (after !== before) masks.push({ at: atPath(c.tool, path), before, after });
      if (masks.length >= max) return masks;
    }
  }
  return masks;
}

/** Each place up to `max` where an attempt's evidence carries its own canary, which the report keeps: the first such value of each. */
function keptCanaries(report: InjectionReport, max = 4): ReportPreview['canaries'] {
  const kept = new Map<string, { at: string; value: string }>();
  for (const a of report.mode === 'plant' ? report.attempts : []) {
    const c = a.canary;
    if (!c) continue;
    for (const e of a.evidence) {
      if (e.kind === 'write' || kept.has(`${e.tool}${e.path}`) || !canaryIn(e.value, c)) continue;
      kept.set(`${e.tool}${e.path}`, { at: atPath(e.tool, e.path), value: canaryForms(c).find((f) => e.value.toLowerCase().includes(f.toLowerCase())) ?? e.value });
      if (kept.size >= max) return [...kept.values()];
    }
  }
  return [...kept.values()];
}

/**
 * The security report's preview, from the same masks the download applies (Masker): the values of
 * the tool calls it shows that a rule masks, two at most, an influenced attempt's write among them,
 * and each canary it keeps, since a canary is the proof and no rule touches one. It reads no run
 * and stops at what it shows, so it answers on the server thread.
 */
export function reportPreview(report: InjectionReport, redact: readonly Normalizer[], row: { at: number; endedAt: number | null; attempts: number }): ReportPreview {
  return { at: row.endedAt ?? row.at, attempts: row.attempts, rules: redact.length, masks: redact.length ? maskSamples(shownArgs(report), redact) : [], canaries: keptCanaries(report), file: reportFile(report.runId) };
}
