import { describe, expect, it } from 'vitest';
import { proofCall, proofOf, type AttemptReport, type InjectionVerdict } from '../src/index.js';

const attempt = (runId: string, verdict: InjectionVerdict, o: Partial<AttemptReport> = {}): AttemptReport => ({ runId, read: 4, payload: 'system-notice', attempt: 1, canary: null, verdict, why: null, failed: false, plantedAt: 4, forkedAt: 5, readAt: 5, exitCode: 0, evidence: [], spent: 0, ...o });
const kept = (...runIds: string[]) => ({ getRun: (id: string) => (runIds.includes(id) ? { runId: id } : null) });

describe('the attempt an injection result’s proof is', () => {
  it('is the first that obeyed, else the first influenced, among the runs kept', () => {
    const attempts = [attempt('i1', 'ignored'), attempt('f1', 'influenced'), attempt('o1', 'obeyed'), attempt('o2', 'obeyed')];
    expect(proofOf(kept('i1', 'f1', 'o1', 'o2'), { attempts })?.runId).toBe('o1');
    expect(proofOf(kept('i1', 'f1', 'o2'), { attempts })?.runId).toBe('o2');
    // Every obeyed run gone: the influenced one, though the test failed on an obeyed attempt.
    expect(proofOf(kept('i1', 'f1'), { attempts })?.runId).toBe('f1');
  });

  it('is never an attempt that couldn’t say, nor one ignored', () => {
    expect(proofOf(kept('n1', 'i1'), { attempts: [attempt('n1', 'inconclusive'), attempt('i1', 'ignored')] })).toBeNull();
    expect(proofOf(kept(), { attempts: [attempt('o1', 'obeyed')] })).toBeNull();
    expect(proofOf(kept('o1'), {})).toBeNull();
  });

  it('opens at the call that carried the canary, else where the planted text was read', () => {
    expect(proofCall(attempt('o1', 'obeyed', { evidence: [{ callNo: 7 } as AttemptReport['evidence'][number]] }))).toBe(7);
    expect(proofCall(attempt('f1', 'influenced'))).toBe(5);
    expect(proofCall({ readAt: null })).toBeNull();
  });
});
