import { useMemo } from 'react';
import { Code } from '../components/Copy.js';
import type { CallRow } from '../api.js';
import { Org } from '../components/bits.js';
import { ktok, num } from '../format.js';
import { agentOf, scopesOf } from '../scopes.js';
import { originOf, tokensText, turnsOf, type Turn } from './model.js';
import { useWindow } from './window-hook.js';

/**
 * Turns: each model call with the tool calls it led to. With agents, each agent is its own line of
 * work, under a header with its model calls and input tokens. Only the turns in view and a
 * screenful either side are drawn (window-hook.ts).
 */

/** A line of the list: an agent's header, or a turn. */
export type TurnLine = { kind: 'head'; scope: string; calls: number; tokens: number } | { kind: 'turn'; turn: Turn<CallRow> };

/** The turns in the order they show: by agent with a header each when there are agents, then those of none. */
export function turnLines(calls: readonly CallRow[], scoped: boolean): TurnLine[] {
  const turns = turnsOf(calls, scoped);
  if (!scoped) return turns.map((turn) => ({ kind: 'turn', turn }));
  const out: TurnLine[] = [];
  for (const sc of scopesOf(calls)) {
    const ts = turns.filter((t) => agentOf(t.model) === sc);
    if (!ts.length) continue;
    const tokens = ts.reduce((s, t) => s + (t.model.usage ? t.model.usage.input + t.model.usage.cacheRead + t.model.usage.cacheWrite : 0), 0);
    out.push({ kind: 'head', scope: sc, calls: ts.length, tokens });
    for (const turn of ts) out.push({ kind: 'turn', turn });
  }
  for (const turn of turns) if (!agentOf(turn.model)) out.push({ kind: 'turn', turn });
  return out;
}

const TURN_LINES = {
  keyOf: (l: TurnLine) => (l.kind === 'head' ? `s:${l.scope}` : l.turn.model.callNo),
  // A turn's height: its first line, what the model said, and a line per tool call.
  shapeOf: (l: TurnLine) => (l.kind === 'head' ? 'head' : `${l.turn.model.resultShort ? 1 : 0}:${l.turn.tools.length}`),
  estimate: (shape: string) => {
    if (shape === 'head') return 34;
    const [say = 0, tools = 0] = shape.split(':').map(Number);
    return 45 + (say ? 26 : 0) + (tools ? 6 + tools * 26 : 0);
  },
};

export function TurnsView({ calls, selected, scoped, onSelect }: { calls: CallRow[]; selected: number | null; scoped: boolean; onSelect: (n: number) => void }) {
  const lines = useMemo(() => turnLines(calls, scoped), [calls, scoped]);
  const win = useWindow(lines, TURN_LINES);
  if (!lines.length) return <div className="empty">No model calls yet.</div>;
  return (
    <div className="turnlist" ref={win.listRef}>
      {win.before ? <div aria-hidden="true" style={{ height: win.before }} /> : null}
      {lines.slice(win.start, win.end).map((l, j) => {
        const at = win.start + j;
        if (l.kind === 'head')
          return (
            <div key={`s:${l.scope}`} data-wi={at} className="tgroup">
              <Code>{l.scope}</Code>
              <span>
                {num(l.calls)}&nbsp;{l.calls === 1 ? 'model call' : 'model calls'}&nbsp;· {ktok(l.tokens)}&nbsp;input tokens
              </span>
            </div>
          );
        const t = l.turn;
        const m = t.model;
        const sel = m.callNo === selected || t.tools.some((c) => c.callNo === selected);
        const ts = m.outcome === 'error' ? `HTTP ${m.status ?? 'error'}${m.attempts ? ` · ${m.attempts + 1} attempts` : ''}` : [tokensText(m), m.stopReason].filter(Boolean).join('\u00a0· ');
        return (
          <div key={m.callNo} data-wi={at} data-acts="" className={`turn${sel ? ' sel' : ''}`} onClick={() => onSelect(m.callNo)}>
            <div className="t1">
              <span className="tn">#{m.callNo}</span>
              <span className="tm">{m.model ?? 'model call'}</span>
              <Org origin={originOf(m)} />
              <span className="ts">{ts}</span>
            </div>
            {m.resultShort ? <div className="say">{m.resultShort}</div> : null}
            {t.tools.length ? (
              <div className="tools">
                {t.tools.map((c) => (
                  <button
                    key={c.callNo}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelect(c.callNo);
                    }}
                  >
                    <span className="arrow">↳ #{c.callNo}</span>
                    {c.name}
                    {c.input ? <span className="eff input">input</span> : c.effect ? <span className={`eff ${c.effect}`}>{c.effect}</span> : null}
                    <Org origin={originOf(c)} />
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
      {win.after ? <div aria-hidden="true" style={{ height: win.after }} /> : null}
    </div>
  );
}
