import { useCallback, useEffect, useMemo, useState } from 'react';
import { EmptyLine } from '../components/States.js';
import { useLatest } from '../hooks.js';
import { ISSUE_ASK } from '../page-ask.js';
import { usePendingHidden } from '../pending-delete.js';
import { useApp } from '../state.js';
import type { Issue, IssuesPage, RunsQuery } from '../types.js';
import { issuesEmpty, issuesLess } from './issues.js';
import { IssuesTable, type MoreRuns } from './IssuesTable.js';
import { useKeptScroll } from './scroll.js';

/*
 * Runs › Failed as issues, in the served dashboard only (served-parts.ts): an exported copy keeps
 * Failed as a filter over its runs. Read beside the table's read, with the same words and days, and
 * again on the page's tick as the table is, and every moment while the verdicts Failed counts by are
 * still being worked out. The runs a delete waits to take leave the issues as they leave the table.
 */

export interface FailedIssuesProps {
  /** The filter's words and the days picked, as the table's read takes them. */
  query: Pick<RunsQuery, 'from' | 'to' | 'q'>;
  /** What reads them again when it changes: the page's tick, as the table's. */
  refresh: string;
  /** The view's address, whose place is given back once the issues are in, with what is above them (`above`). */
  scrollKey: string;
  above: boolean;
}

/** The issues shown open, by key, while the dashboard is: a disclosure, never in the address. */
const opened = new Set<string>();

/** While what Failed counts is still being worked out, or the search index is behind: how often the issues are asked for again. */
const ASK_AGAIN_MS = 1500;

interface Read {
  key: string;
  page: IssuesPage | null;
  error: Error | null;
}

function useIssues(query: FailedIssuesProps['query'], refresh: string): Read {
  const { client } = useApp();
  const key = JSON.stringify([query.from ?? null, query.to ?? null, query.q ?? '']);
  const [read, setRead] = useState<Read>({ key, page: null, error: null });
  const [nudge, setNudge] = useState(0);
  const queryNow = useLatest(query);
  useEffect(() => {
    let alive = true;
    client.runsIssues(queryNow.current).then(
      (page) => alive && setRead({ key, page, error: null }),
      (err: unknown) => alive && setRead((r) => ({ key, page: r.key === key ? r.page : null, error: err instanceof Error ? err : new Error(String(err)) })),
    );
    return () => {
      alive = false;
    };
  }, [client, key, refresh, nudge, queryNow]);
  const behind = read.page?.warming ?? read.page?.indexing ?? null;
  useEffect(() => {
    if (!behind) return;
    const t = setTimeout(() => setNudge((n) => n + 1), ASK_AGAIN_MS);
    return () => clearTimeout(t);
  }, [behind]);
  return read.key === key ? read : { key, page: null, error: null };
}

/** The issue a link elsewhere asked for (open-issue.ts): opened, and its row brought to the middle of the view, once it is drawn. */
function useAskedIssue(issues: readonly Issue[], open: (key: string) => void): void {
  useEffect(() => {
    const show = (key: string) => {
      open(key);
      requestAnimationFrame(() => document.querySelector(`tr[data-rowkey="${CSS.escape(key)}"]`)?.scrollIntoView?.({ block: 'center' }));
    };
    for (const x of issues) if (ISSUE_ASK.take(x.key)) show(x.key);
    const off = issues.map((x) => ISSUE_ASK.on(() => show(x.key), x.key));
    return () => off.forEach((f) => f());
  }, [issues, open]);
}

/** Failed's issues, their empty line, or why they couldn't be read. */
export function FailedIssues({ query, refresh, scrollKey, above }: FailedIssuesProps) {
  const { client } = useApp();
  const read = useIssues(query, refresh);
  const hidden = usePendingHidden();
  const page = useMemo(() => (read.page ? issuesLess(read.page, hidden) : null), [read.page, hidden]);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(opened));
  const [more, setMore] = useState<ReadonlyMap<string, MoreRuns>>(() => new Map());
  useKeptScroll(scrollKey, above && page !== null);
  const toggle = useCallback((x: Issue | string, to?: boolean) => {
    const key = typeof x === 'string' ? x : x.key;
    const on = to ?? !opened.has(key);
    if (on) opened.add(key);
    else opened.delete(key);
    setOpen(new Set(opened));
  }, []);
  useAskedIssue(page?.issues ?? NO_ISSUES, useCallback((key: string) => toggle(key, true), [toggle]));
  const onMore = (x: Issue, after: string) =>
    void client.issueRuns(x.key, query, after).then(
      (p) => setMore((m) => new Map(m).set(x.key, { runs: [...(m.get(x.key)?.runs ?? []), ...p.runs], more: p.more })),
      () => undefined,
    );
  if (read.error && !page) return <div className="empty">The runs could not be read: {read.error.message}</div>;
  if (!page) return <div className="empty">Loading runs…</div>;
  if (!page.issues.length) return <EmptyLine>{issuesEmpty({ q: query.q ?? '', days: query.from != null })}</EmptyLine>;
  return <IssuesTable issues={page.issues} open={open} now={Date.now()} more={more} onToggle={toggle} onMore={onMore} />;
}

const NO_ISSUES: readonly Issue[] = [];
