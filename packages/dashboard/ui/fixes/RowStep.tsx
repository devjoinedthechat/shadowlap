import { useRef, useState } from 'react';
import { consentAsked } from '../actions.js';
import { ActionButton } from '../components/ActionButton.js';
import { ConsentDialog } from '../components/Dialog.js';
import { useBilledPress } from '../components/JobButton.js';
import { onShow } from '../components/OnShow.js';
import type { FixEstimates } from '../estimates-api.js';
import { ACTIONS } from '../labels.js';
import { tipEst } from '../spending.js';
import { useApp } from '../state.js';
import { errorText } from '../toast.js';
import type { FixDetail, FixLead } from '../types.js';
import type { Estimate } from '../../../engine/src/estimates/estimate.js';
import { blameNextPrice, verifyPrice } from './estimates.js';
import { LEAD_KIND, leadCard, leadReadsFix } from './lead.js';
import type { LeadOpen } from './LeadDialog.js';
import { fixAction } from './model.js';
import { refusedPress } from './page-fix.js';

/** The dialog a press opens, the fix page's own, in a script of its own that loads as it first shows (LeadDialog.tsx). */
const LeadDialog = onShow(() => import('./LeadDialog.js').then((m) => m.LeadDialog));

/**
 * Each fix's estimates, asked the first time a row's card shows or its step is pressed, once per
 * answer of the list (`version`): a list carries no estimate, and no row asks before it is looked at.
 */
const priced = new Map<string, Promise<FixEstimates | null>>();
let pricedAt = '';

function estimatesOf(api: { fixEstimates: (fixId: string) => Promise<FixEstimates> }, fixId: string, version: string): Promise<FixEstimates | null> {
  if (pricedAt !== version) {
    priced.clear();
    pricedAt = version;
  }
  let read = priced.get(fixId);
  if (!read) {
    read = api.fixEstimates(fixId).catch(() => null);
    priced.set(fixId, read);
  }
  return read;
}

/** What a lead bills, as the fix's estimates price it: undefined until they are known; Apply fix bills nothing. */
function priceOf(lead: FixLead, e: FixEstimates | null | undefined): Estimate | null | undefined {
  if (e === undefined) return undefined;
  if (lead.key === 'repair') return e?.repair ?? null;
  if (lead.key === 'more' || lead.key === 'again') return verifyPrice(e, lead.verifyId);
  if (lead.key === 'verify-left') return e?.verifyLeft ?? null;
  return blameNextPrice(lead.key === 'blame-again' ? 'again' : 'stronger', e);
}

/** The fields a lead's job starts with, beside the fix. */
function fieldsOf(lead: FixLead): Record<string, unknown> {
  if (lead.key === 'blame-again') return { again: true };
  if (lead.key === 'more' || lead.key === 'again') return { verifyId: lead.verifyId };
  return lead.key === 'verify-left' ? { left: true } : {};
}

/**
 * A fix's next step on a list row (`fixLead`), small and plain: its Fixes row and its row on Needs a
 * look, or where a job's drawer ends on its fix's page (job-footers.tsx: its `className`, and the
 * page's `fix`, so a press reads none). It runs or asks as the same button on the fix's page does. A
 * press asks the fix's estimates, and the fix's detail for a step whose dialog shows it (Run blame
 * with stronger model…, Run repair, Apply fix, Mark applied, Finish applying), then opens that dialog;
 * Run blame again, Run more attempts, Verify again and Verify this run follow Spending from the lead's
 * own fields, starting at or under the threshold, else asking. A list can be older than the working
 * tree: an apply whose patch `fix apply` refuses now says why instead (`fixAction`). While a read is out
 * the button is busy and another press does nothing. `why` is the list's: one jobs read for every row.
 * A press refused once the fix's blame moved on offers Open Blame (`refusedPress`).
 */
export function RowStep(p: RowStepProps) {
  // A crash's Find breaking commit and Revert run on its run, not the fix: drawn apart (until then, none).
  return p.lead.key === 'bisect' || p.lead.key === 'revert' ? null : <FixRowStep {...p} lead={p.lead} />;
}

interface RowStepProps {
  fixId: string;
  lead: FixLead;
  why: string | null;
  version: string;
  className?: string;
  fix?: FixDetail;
}

function FixRowStep({ fixId, lead, why, version, className = 'btn sm', fix: detail }: RowStepProps & { lead: Exclude<FixLead, { key: 'bisect' | 'revert' }> }) {
  const app = useApp();
  const press = useBilledPress();
  const [got, setGot] = useState<{ version: string; e: FixEstimates | null } | null>(null);
  const [reading, setReading] = useState(false);
  const out = useRef(false);
  const [open, setOpen] = useState<LeadOpen | null>(null);
  const [consent, setConsent] = useState<{ why: string; confirm: string; fields: Record<string, unknown> } | null>(null);
  const api = app.client.estimates;
  const known = got?.version === version ? got.e : undefined;
  const estimate = priceOf(lead, known);
  const bills = lead.key !== 'apply';
  const look = () => {
    if (!api || !bills || known !== undefined) return;
    void estimatesOf(api, fixId, version).then((e) => setGot({ version, e }));
  };
  const start = (fields: Record<string, unknown>) =>
    app.client.startJob(LEAD_KIND[lead.key], { fixId, ...fieldsOf(lead), ...fields }).then(
      (job) => app.watchJob(Promise.resolve(job)),
      (err: unknown) => {
        const asked = fields.yes === undefined ? consentAsked(err) : null;
        if (asked) setConsent({ ...asked, fields });
        else refusedPress(app, LEAD_KIND[lead.key], { fixId }, err);
      },
    );
  const onClick = () =>
    app.guard(() => {
      if (out.current) return;
      out.current = true;
      setReading(true);
      const e = !api || !bills ? Promise.resolve(null) : estimatesOf(api, fixId, version);
      const fix = !leadReadsFix(lead) ? Promise.resolve(null) : detail ? Promise.resolve(detail) : app.client.fix(fixId);
      void Promise.all([e, fix])
        .then(
          ([e, fix]) => {
            setGot({ version, e });
            const est = priceOf(lead, e);
            // As the fix's page leads (`fixAction`): a patch `fix apply` refuses now says why, and the dialog takes the page's label.
            const act = fix && lead.key === 'apply' ? fixAction(fix) : null;
            if (act?.kind === 'none') app.toast(act.why, 'error');
            else if (fix) setOpen({ kind: 'fix', fix, estimate: est, label: act?.kind === 'apply' ? act.label : lead.label });
            else press({ estimate: est, form: false, start: (sent) => void start(sent), ask: () => setOpen({ kind: 'ask', estimate: est }) });
          },
          (err: unknown) => app.toast(errorText(err)),
        )
        .finally(() => {
          out.current = false;
          setReading(false);
        });
    });
  const close = () => setOpen(null);
  const run = (fields: Record<string, unknown>) => app.guard(() => void start(fields));
  return (
    <>
      <ActionButton
        className={className}
        why={why}
        aria-busy={reading || undefined}
        tip={lead.label}
        sub={leadCard(lead)}
        command={`$ ${lead.command}`}
        est={bills ? tipEst(estimate, lead.key === 'blame-stronger') : null}
        onPointerEnter={look}
        onFocus={look}
        onClick={onClick}
      >
        {lead.label}
      </ActionButton>
      {open ? <LeadDialog lead={lead} open={open} run={run} close={close} /> : null}
      {consent ? (
        <ConsentDialog
          why={consent.why}
          ok={lead.key === 'repair' ? ACTIONS.runRepair.label : 'Run command'}
          onClose={() => setConsent(null)}
          onOk={() => run({ ...consent.fields, yes: consent.confirm })}
        />
      ) : null}
    </>
  );
}
