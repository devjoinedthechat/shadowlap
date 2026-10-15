import type { CallRow } from '../api.js';
import { Org } from '../components/bits.js';
import { ktok, num } from '../format.js';
import { scopesOf } from '../scopes.js';
import { originOf, tokensText, turnsOf, type Turn } from './model.js';

/**
 * Turns: each model call with the tool calls it led to. With scopes, each scope is its own line of
 * work, under a header with its model calls and input tokens.
 */
export function TurnsView({ calls, selected, scoped, onSelect }: { calls: CallRow[]; selected: number | null; scoped: boolean; onSelect: (n: number) => void }) {
  const turns = turnsOf(calls, scoped);
  if (!turns.length) return <div className="empty">No model calls yet.</div>;
  const turn = (t: Turn<CallRow>) => {
    const m = t.model;
    const sel = m.callNo === selected || t.tools.some((c) => c.callNo === selected);
    const ts = m.outcome === 'error' ? `HTTP ${m.status ?? 'error'}${m.attempts ? ` · ${m.attempts + 1} attempts` : ''}` : [tokensText(m), m.stopReason].filter(Boolean).join(' · ');
    return (
      <div key={m.callNo} className={`turn${sel ? ' sel' : ''}`} onClick={() => onSelect(m.callNo)}>
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
  };
  if (!scoped) return <>{turns.map(turn)}</>;
  return (
    <>
      {scopesOf(calls)
        .map((sc) => {
          const ts = turns.filter((t) => t.model.scope === sc);
          if (!ts.length) return null;
          const tokens = ts.reduce((s, t) => s + (t.model.usage ? t.model.usage.input + t.model.usage.cacheRead + t.model.usage.cacheWrite : 0), 0);
          return (
            <div key={sc}>
              <div className="tgroup">
                <code>{sc}</code>
                <span>
                  {num(ts.length)} {ts.length === 1 ? 'model call' : 'model calls'} · {ktok(tokens)} input tokens
                </span>
              </div>
              {ts.map(turn)}
            </div>
          );
        })
        .filter(Boolean)}
      {turns.some((t) => !t.model.scope) ? turns.filter((t) => !t.model.scope).map(turn) : null}
    </>
  );
}
