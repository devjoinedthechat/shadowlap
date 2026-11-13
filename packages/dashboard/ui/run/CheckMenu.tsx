import { asNumber } from '../../../engine/src/checks/grammar.js';
import { Popover } from '../components/Popover.js';
import { argsOf } from './check-entry.js';
import type { CheckKind, CheckMenuProps } from './check-part.js';

/**
 * The check menu at a tool call, which Add check… opens (check-entry.tsx): its rules, each with the
 * key of the check it writes, then a judge's question about the whole run. A part of its own, which
 * the served dashboard hands a run's page beside the builder (served-parts.ts, from pages/served.tsx):
 * the run's page rarely opens it, and an exported copy never does.
 */

/** The check menu's rules for a call, each with the key of the check it writes, as the fork menu shows a flag. */
export function checkMenuItems(name: string, args: Record<string, unknown>): Array<{ kind: CheckKind; label: string; keys: string }> {
  const keys = Object.keys(args);
  const [first] = keys;
  // A number as a check compares one: the engine's rule, which the builder's argument picker reads by too.
  const num = keys.find((k) => asNumber(args[k]) !== null);
  return [
    { kind: 'never', label: `Never call ${name}`, keys: 'tools' },
    ...(first !== undefined
      ? [
          { kind: 'neverargs' as const, label: 'Never with these arguments', keys: 'tools · args' },
          { kind: 'must' as const, label: `Must call with ${first} = …`, keys: 'tools · args' },
        ]
      : [{ kind: 'must' as const, label: `Must call ${name}`, keys: 'tools' }]),
    { kind: 'after', label: 'Only after…', keys: 'calls · after' },
    ...(num === undefined ? [] : [{ kind: 'every' as const, label: `${num.charAt(0).toUpperCase()}${num.slice(1).replace(/_/g, ' ')} at most…`, keys: 'calls · args' }]),
    { kind: 'when', label: 'When… then…', keys: 'when' },
  ];
}

/** The check menu at a call: its rules, then a judge's question about the whole run. It waits for the call, as the fork menu does. */
export function CheckMenu({ anchor, call, onPick, onClose }: CheckMenuProps) {
  if (!call) {
    return (
      <Popover key="loading" anchor={anchor} onClose={onClose} className="fkm ckm" label="Add check">
        <div className="pnote">Loading the call…</div>
      </Popover>
    );
  }
  const c = call.call;
  const item = (kind: CheckKind, label: string, keys: string) => (
    <button key={kind} type="button" role="menuitem" onClick={() => onPick(kind)}>
      <b>{label}</b>
      <small>{keys}</small>
    </button>
  );
  return (
    <Popover key="menu" anchor={anchor} onClose={onClose} className="fkm ckm" label={`Add check at #${c.callNo}`}>
      <div className="pk">
        Add check · #{c.callNo} <code className="rnm">{c.name}</code>
      </div>
      {checkMenuItems(c.name, argsOf(call)).map((i) => item(i.kind, i.label, i.keys))}
      <hr />
      <div className="pk">The whole run</div>
      {item('judge', 'Ask a judge…', 'judge')}
    </Popover>
  );
}
