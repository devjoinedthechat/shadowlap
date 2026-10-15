import { approx, num, plural, shortId } from '../format.js';
import { repeatBundle, type RepeatAttempt } from '../runs.js';

/**
 * The Forks view's bundles: the attempts one command made, under the run they came from, in the
 * design's words. `--repeat` bundles say how many passed; a blame probe's attempts link to the fix's
 * blame step, the probe blame settled on carries "blamed"; a verify's attempts link to its verdict,
 * with an icon that says accepted or rejected. No DOM here: the tests import it.
 */

export interface BundleAttempt extends RepeatAttempt {
  repeat: { group?: string; attempt: number; of: number } | null;
  probe?: { of: string; callNo: number; passed: boolean } | null;
  verify?: { role: string; passed: boolean } | null;
  fix?: { href: string; verdict: string | null } | null;
}

export interface Bundle {
  kind: 'repeat' | 'blame' | 'verify';
  title: string;
  line: string;
  /** The probe blame settled on: the call it found the run lost at. */
  blamed: boolean;
  /** The glyph: a blame, a verdict accepted or rejected, or forks. */
  glyph: 'blame' | 'fixok' | 'fixbad' | 'fork';
  glyphLabel: string;
  href: string | null;
  attempts: Array<{ runId: string; text: string; ok: boolean }>;
}

const passedOf = (n: BundleAttempt) => n.probe?.passed ?? n.verify?.passed ?? (n.checks ? n.checks.passed === n.checks.total : n.status === 'completed');

function outcomeText(n: BundleAttempt): string {
  if (n.status === 'running') return 'running';
  if (passedOf(n)) return 'passed';
  if (n.checks && n.checks.passed < n.checks.total) return n.checks.total === 1 ? 'check failed' : `${num(n.checks.total - n.checks.passed)} of ${num(n.checks.total)} checks failed`;
  return n.status === 'crashed' ? 'interrupted' : 'exited with an error';
}

/**
 * One command's attempts as a bundle. `parent` is the run they came from, as the family lists it:
 * where its blame found it lost (`blamedAt`), and the fix step its attempts link to.
 */
export function attemptBundle(attempts: readonly BundleAttempt[], parent: { blamedAt?: number | null; fix?: { href: string } | null } | null): Bundle {
  const sorted = [...attempts].sort((a, b) => (a.repeat?.attempt ?? 0) - (b.repeat?.attempt ?? 0) || a.startedAt - b.startedAt);
  const first = sorted[0]!;
  const spent = sorted.reduce((s, n) => s + n.spent, 0);
  const passed = sorted.filter(passedOf).length;
  const line = `${plural(sorted.length, 'attempt')}, ${num(passed)} passed${spent ? ` · ${approx(spent)}` : ''}`;
  const lines = sorted.map((n) => ({ runId: n.runId, text: `${shortId(n.runId)} · ${outcomeText(n)}`, ok: passedOf(n) }));
  if (first.probe) {
    const callNo = first.probe.callNo;
    return {
      kind: 'blame',
      title: `blame · probe #${callNo}`,
      line,
      blamed: parent?.blamedAt === callNo,
      glyph: 'blame',
      glyphLabel: 'Blame attempts',
      href: parent?.fix?.href ?? null,
      attempts: lines,
    };
  }
  if (first.verify) {
    const verdict = sorted.find((n) => n.fix?.verdict)?.fix?.verdict ?? null;
    const accepted = verdict ? verdict === 'accepted' : passed === sorted.length;
    return {
      kind: 'verify',
      title: `verify · ${first.verify.role === 'holdout' ? 'held-out' : first.verify.role}`,
      line,
      blamed: false,
      glyph: accepted ? 'fixok' : 'fixbad',
      glyphLabel: verdict ? `Verify attempts · ${verdict}` : 'Verify attempts',
      href: sorted.find((n) => n.fix?.href)?.fix?.href ?? null,
      attempts: lines,
    };
  }
  const r = repeatBundle(sorted);
  return { kind: 'repeat', title: r.title, line: r.line, blamed: false, glyph: 'fork', glyphLabel: 'Repeated attempts', href: null, attempts: r.attempts };
}
