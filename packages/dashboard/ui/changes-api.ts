import type { Request } from './settings-api.js';
import type { DecisionSessionDetail, DecisionsListView, RetirementsView, RunDecisionsView, VerdictRevision, VerdictsKind, VerdictsView } from './types.js';

/**
 * What Changes reads from the server: the decision diff (`/api/decisions`, `shadowlap decisions` and
 * `migrate`) and Verdicts (`/api/verdicts`), every change checked and the verdict it got. Flat on the
 * client, as each of its reads is. Nothing here is drawn, so nothing comes from ui/changes/.
 */
export interface ChangesApi {
  /** The decisions and migrate sessions kept, newest first, and the goldens' models that retire. */
  decisionSessions(kind?: 'decisions' | 'migrate'): Promise<DecisionsListView>;
  /** One session whole, by its id (`dc-…`, `mg-…`): its report and its matrix. */
  decisionSession(id: string): Promise<DecisionSessionDetail>;
  /** A run's decisions under each session that asked its model calls again, for its Decisions view. */
  runDecisions(runId: string): Promise<RunDecisionsView>;
  /** The models the goldens use that retire, by the table that ships with Shadowlap. */
  retirements(): Promise<RetirementsView>;
  /** Verdicts: the changes of a chip, newest first, `limit` at most, each chip's count, and the newest revision's verdict. */
  verdicts(kind: VerdictsKind, limit: number): Promise<VerdictsView>;
  /** A revision's page, by its key (`no-revision` for none): its goldens as that session judged them, and the previews asked at it. */
  verdictRevision(rev: string): Promise<VerdictRevision>;
}

export function changesApi(request: Request): ChangesApi {
  // A revision's `+dirty` goes as `%2B`, which the server's router reads back.
  const id = encodeURIComponent;
  return {
    decisionSessions: (kind) => request<DecisionsListView>(`decisions${kind ? `?kind=${kind}` : ''}`),
    decisionSession: (sessionId) => request<DecisionSessionDetail>(`decisions/${id(sessionId)}`),
    runDecisions: (runId) => request<RunDecisionsView>(`runs/${id(runId)}/decisions`),
    retirements: () => request<RetirementsView>('retirements'),
    verdicts: (kind, limit) => request<VerdictsView>(`verdicts?kind=${kind}&limit=${limit}`),
    verdictRevision: (rev) => request<VerdictRevision>(`verdicts/${id(rev)}`),
  };
}
