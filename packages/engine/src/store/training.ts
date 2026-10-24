/**
 * Training: each time preference pairs left the machine (pair_exports), and each scored attempt of a
 * model on a task (task_scores). The pairs themselves are read from the attempts blame, verify and
 * --repeat left in the store, so nothing else is kept for them.
 */
import { StorePart, ulidNow } from './core.js';

/** One `shadowlap export pairs` (v4 training): how many pairs left the machine, to which file, and when. */
export interface PairsExport {
  exportId: string;
  at: number;
  pairs: number;
  /** The file written, as given (`pairs.jsonl`), or `-` for standard output. */
  file: string;
  format: string;
  minConfidence: string;
  /** Pairs below the confidence asked for, not written. */
  leftOut: number;
  actor: string | null;
  data: Record<string, unknown> | null;
}

export type NewPairsExport = Pick<PairsExport, 'pairs' | 'file' | 'format' | 'minConfidence'> & Partial<Pick<PairsExport, 'exportId' | 'at' | 'leftOut' | 'actor' | 'data'>>;

/** One scored attempt (v4 training): a model under test, a task (by its golden), and what the checks said. */
export interface TaskScoreRow {
  model: string;
  /** The OpenAI-compatible endpoint the model was asked at, or null for a provider's own API. */
  baseUrl: string | null;
  /** The golden, as the project names it: `goldens/refund-over-limit`. */
  golden: string;
  attempt: number;
  /** The attempt's run, kept in the store like any fork. */
  runId: string | null;
  /** The share of the task's checks the attempt passed, from 0 to 1. */
  score: number;
  checks: Array<{ label: string; ok: boolean; detail: string | null }>;
  /** USD spent on the attempt's live model calls (0 on a model that isn't a paid API); its judge checks' are `judgeSpent`. */
  spent: number;
  /**
   * USD its judge checks' calls cost, apart from `spent` (v5): they ask the judge, never the model
   * scored. Null without a judge call, and for a score a v4 build kept, whose `spent` counted them.
   */
  judgeSpent: number | null;
  /** Where the model ran, in words: `Anthropic API`, `Ollama, on this machine`. */
  via: string | null;
  /** The `tasks score` invocation that made it. */
  session: string;
  at: number;
}

export abstract class Training extends StorePart {
  // ---- Training (v4): pairs exports and task scores ----

  /** Records one pairs export; returns it as stored. */
  addPairsExport(input: NewPairsExport): PairsExport {
    const record: PairsExport = {
      exportId: input.exportId ?? ulidNow(),
      at: input.at ?? Date.now(),
      pairs: input.pairs,
      file: input.file,
      format: input.format,
      minConfidence: input.minConfidence,
      leftOut: input.leftOut ?? 0,
      actor: input.actor ?? null,
      data: input.data ?? null,
    };
    this.db
      .prepare(`INSERT INTO pair_exports (export_id, at, pairs, file, format, min_confidence, left_out, actor, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(record.exportId, record.at, record.pairs, record.file, record.format, record.minConfidence, record.leftOut, record.actor, record.data === null ? null : JSON.stringify(record.data));
    return record;
  }

  /** Pairs exports, newest first: the first is what "left this machine" last. */
  listPairsExports(limit = 20): PairsExport[] {
    const rows = this.db.prepare(`SELECT * FROM pair_exports ORDER BY at DESC, export_id DESC LIMIT ?`).all(Math.max(1, Math.min(10_000, limit)));
    return rows.map((r) => ({
      exportId: String(r.export_id),
      at: Number(r.at),
      pairs: Number(r.pairs),
      file: String(r.file),
      format: String(r.format),
      minConfidence: String(r.min_confidence),
      leftOut: Number(r.left_out),
      actor: r.actor === null ? null : String(r.actor),
      data: r.data === null ? null : (JSON.parse(String(r.data)) as Record<string, unknown>),
    }));
  }

  /** A model's scores on one task, replacing whatever it scored there before. */
  replaceTaskScores(model: string, baseUrl: string | null, golden: string, rows: Array<Omit<TaskScoreRow, 'model' | 'baseUrl' | 'golden' | 'judgeSpent'> & { judgeSpent?: number | null }>): void {
    const base = baseUrl ?? '';
    this.transaction(() => {
      this.db.prepare(`DELETE FROM task_scores WHERE model = ? AND base_url = ? AND golden = ?`).run(model, base, golden);
      const insert = this.db.prepare(`INSERT INTO task_scores (model, base_url, golden, attempt, run_id, score, checks, spent, via, session, at, judge_spent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const r of rows) insert.run(model, base, golden, r.attempt, r.runId, r.score, JSON.stringify(r.checks), r.spent, r.via, r.session, r.at, r.judgeSpent ?? null);
    });
  }

  /** Every scored attempt, by model, task and attempt. */
  listTaskScores(): TaskScoreRow[] {
    return this.db
      .prepare(`SELECT * FROM task_scores ORDER BY model, base_url, golden, attempt`)
      .all()
      .map((r) => ({
        model: String(r.model),
        baseUrl: r.base_url === '' || r.base_url === null ? null : String(r.base_url),
        golden: String(r.golden),
        attempt: Number(r.attempt),
        runId: r.run_id === null ? null : String(r.run_id),
        score: Number(r.score),
        checks: JSON.parse(String(r.checks)) as TaskScoreRow['checks'],
        spent: Number(r.spent),
        judgeSpent: r.judge_spent === null || r.judge_spent === undefined ? null : Number(r.judge_spent),
        via: r.via === null ? null : String(r.via),
        session: String(r.session),
        at: Number(r.at),
      }));
  }
}
