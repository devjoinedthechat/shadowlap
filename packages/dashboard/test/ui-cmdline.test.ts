import { describe, expect, it } from 'vitest';
import { cmdParts, cmdWords, type CmdPiece } from '../ui/cmdline.js';

/**
 * A command as `.cmdline` sets it: where it may wrap. Drawn here as text, a piece kept on one line
 * in brackets and a place it may break as `|`; a space between pieces is where words wrap.
 */
const drawn = (cmd: string) => cmdParts(cmd).map((p: CmdPiece) => ('wbr' in p ? '|' : p.whole ? `[${p.text}]` : p.text)).join('');
const text = (cmd: string) => cmdParts(cmd).map((p: CmdPiece) => ('wbr' in p ? '' : p.text)).join('');

describe('a command as the page sets it', () => {
  it('keeps each flag with its value, so no line ends on a flag, and never breaks inside one', () => {
    expect(drawn(`shadowlap bisect 01M5J0DN6V --good <commit> --bad 7c9e6fe --expect '{"tools":{"send_email":1}}' --fork`)).toBe(`[shadowlap] [bisect] [01M5J0DN6V] [--good ][<commit>] [--bad ][7c9e6fe] [--expect ]'{|["tools"]:{|["send_email"]:1}}' [--fork]`);
    expect(drawn('shadowlap repair --fixes 01M5J1SYVNVGEBEST66X68F5XY --repairer claude-code')).toBe('[shadowlap] [repair] [--fixes ][01M5J1SYVNVGEBEST66X68F5XY] [--repairer ][claude-code]');
    // A flag before another flag has no value to keep; `--` alone ends the options and is no flag.
    expect(drawn('shadowlap fix apply fx-01M5J0Y9QK --no-test --json')).toBe('[shadowlap] [fix] [apply] [fx-01M5J0Y9QK] [--no-test] [--json]');
    expect(drawn('shadowlap verify --fixes 01M5J0DN6V -- node agent.mjs')).toBe('[shadowlap] [verify] [--fixes ][01M5J0DN6V] [--] [node] [agent.mjs]');
  });

  it('breaks JSON after its commas and braces, a long path after a slash, a long title between its words', () => {
    expect(drawn(`shadowlap verify --expect '{"tools":{"issue_refund":{"count":0,"args":{"amount":240}}}}'`)).toBe(`[shadowlap] [verify] [--expect ]'{|["tools"]:{|["issue_refund"]:{|["count"]:0,|["args"]:{|["amount"]:240}}}}'`);
    expect(drawn('git -c core.autocrlf=false apply .shadowlap/repairs/repair-munzln2i/fix.patch')).toBe('[git] [-c ][core.autocrlf=false] [apply] [.shadowlap]/|[repairs]/|[repair-munzln2i]/|[fix.patch]');
    expect(drawn(`shadowlap fix title fx-01 'Escalate refunds above the policy limit'`)).toBe(`[shadowlap] [fix] [title] [fx-01] ['Escalate] [refunds] [above] [the] [policy] [limit']`);
  });

  it('reads as the command, its quoting whole', () => {
    for (const cmd of [`shadowlap fix title fx-01 'it'\\''s done'`, `shadowlap verify --fixes label:refund-bug --keeps 01M3RZ4XKN --expect '{"tools":{"send_email":1}}' --set temperature=1`, 'cd <folder> && shadowlap dashboard']) expect(text(cmd)).toBe(cmd);
    expect(cmdWords(`shadowlap fix title fx-01 'it'\\''s done'`)).toEqual(['shadowlap', 'fix', 'title', 'fx-01', `'it'\\''s done'`]);
  });
});
