import { useCallback, useEffect, useMemo, useState } from 'react';
import { messageOf } from '../../../engine/src/message-of.js';
import { EmptyLine } from '../components/States.js';
import { useLatest } from '../hooks.js';
import { ISSUE_ASK } from '../page-ask.js';
import { usePendingHidden } from '../pending-delete.js';
import { useApp } from '../state.js';
import { errorText } from '../toast.js';
import type { Issue, IssuesPage, RunsQuery } from '../types.js';
import { type AskedRuns, issuesEmpty, issuesShown, type MoreRuns, openAsked, withAsked } from './issues.js';
import { IssuesTable } from './IssuesTable.js';
import { useKeptScroll } from './scroll.js';

/*
 * Runs › Failed as issues, in the served dashboard only (served-parts.ts): an exported copy keeps
 * Failed as a filter over its runs. Read beside the table's read, with the same words and days, and
 * again on the page's tick as the table is, and every moment while the verdicts Failed counts by are
 * still being worked out. A read carries the runs of the issues shown open as it was asked, and every
 * other issue's count alone: an issue opened since asks for its newest runs, with the loading line
 * under it until they come. The runs a delete waits to take leave the issues as they leave the table.
 * The runs asked for an issue, and those Show more brings, are kept with the read they came after,
 * and dropped once the issues are read again, whose first runs may have moved since.
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
    // The issues shown open as it is asked, whose runs it carries: opening one later asks for its own.
    client.runsIssues(queryNow.current, openAsked(opened)).then(
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

/** The runs Show more brought for each issue, after the read they came after (`of`). */
interface Brought {
  of: IssuesPage | null;
  runs: ReadonlyMap<string, MoreRuns>;
}

/** Show more on an issue: its next runs after `after`, kept with the read they followed; why they couldn't be read is said. */
function useMoreRuns(query: FailedIssuesProps['query'], page: IssuesPage | null): [ReadonlyMap<string, MoreRuns>, (x: Issue, after: string) => void] {
  const { client, toast } = useApp();
  const [brought, setBrought] = useState<Brought>({ of: null, runs: NO_MORE });
  const pageNow = useLatest(page);
  const onMore = (x: Issue, after: string) => {
    const of = page;
    void client.issueRuns(x.key, query, after).then(
      (p) => {
        // A read since has its own first runs: these followed the one before it.
        if (pageNow.current !== of) return;
        setBrought((b) => {
          const runs = b.of === of ? b.runs : NO_MORE;
          return { of, runs: new Map(runs).set(x.key, { runs: [...(runs.get(x.key)?.runs ?? []), ...p.runs], more: p.more }) };
        });
      },
      (err: unknown) => toast(errorText(err), 'error'),
    );
  };
  return [brought.of === page ? brought.runs : NO_MORE, onMore];
}

/** The newest runs asked for each issue shown open whose read carried its count alone, after that read (`of`). */
interface Asked {
  of: IssuesPage | null;
  runs: ReadonlyMap<string, AskedRuns>;
}

/**
 * An issue shown open whose read carried its count alone, opened since it was asked or past those a
 * read asks for: its newest runs, asked for once after that read and kept with it, or why they
 * couldn't be read, which Retry (the second value) asks again.
 */
function useAskedRuns(query: FailedIssuesProps['query'], page: IssuesPage | null, open: ReadonlySet<string>): [ReadonlyMap<string, AskedRuns>, (key: string) => void] {
  const { client } = useApp();
  const [asked, setAsked] = useState<Asked>({ of: null, runs: NO_ASKED });
  const queryNow = useLatest(query);
  const held = asked.of === page ? asked.runs : NO_ASKED;
  useEffect(() => {
    const want = page ? page.issues.filter((x) => !x.runs && open.has(x.key) && !held.has(x.key)) : [];
    if (!page || !want.length) return;
    // What came once the issues were read again is dropped: that read asks for its own.
    const put = (key: string, runs: AskedRuns, came: boolean) => setAsked((a) => (came && a.of !== page ? a : { of: page, runs: new Map(a.of === page ? a.runs : NO_ASKED).set(key, runs) }));
    for (const x of want) {
      put(x.key, { runs: null, more: null, error: null }, false);
      client.issueRuns(x.key, queryNow.current, null).then(
        (p) => put(x.key, { runs: p.runs, more: p.more, error: null }, true),
        (err: unknown) => put(x.key, { runs: null, more: null, error: messageOf(err) }, true),
      );
    }
  }, [client, page, open, held, queryNow]);
  const retry = useCallback(
    (key: string) =>
      setAsked((a) => {
        const runs = new Map(a.runs);
        runs.delete(key);
        return { ...a, runs };
      }),
    [],
  );
  return [held, retry];
}

/** Failed's issues, their empty line, or why they couldn't be read. */
export function FailedIssues({ query, refresh, scrollKey, above }: FailedIssuesProps) {
  const read = useIssues(query, refresh);
  const hidden = usePendingHidden();
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(opened));
  const [asked, retry] = useAskedRuns(query, read.page, open);
  const [more, onMore] = useMoreRuns(query, read.page);
  const page = useMemo(() => (read.page ? issuesShown(withAsked(read.page, asked), hidden, more) : null), [read.page, asked, hidden, more]);
  useKeptScroll(scrollKey, above && page !== null);
  const toggle = useCallback((x: Issue | string, to?: boolean) => {
    const key = typeof x === 'string' ? x : x.key;
    const on = to ?? !opened.has(key);
    if (on) opened.add(key);
    else opened.delete(key);
    setOpen(new Set(opened));
  }, []);
  useAskedIssue(page?.issues ?? NO_ISSUES, useCallback((key: string) => toggle(key, true), [toggle]));
  if (read.error && !page) return <div className="empty">The runs could not be read: {read.error.message}</div>;
  if (!page) return <div className="empty">Loading runs…</div>;
  if (!page.issues.length) return <EmptyLine>{issuesEmpty({ q: query.q ?? '', days: query.from != null })}</EmptyLine>;
  return <IssuesTable issues={page.issues} open={open} asked={asked} now={Date.now()} onToggle={toggle} onMore={onMore} onRetry={retry} />;
}

const NO_ISSUES: readonly Issue[] = [];
const NO_MORE: ReadonlyMap<string, MoreRuns> = new Map();
const NO_ASKED: ReadonlyMap<string, AskedRuns> = new Map();
