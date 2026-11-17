import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AttemptsCell, type Attempt } from '../ui/components/AttemptsCell.js';
import { StepList } from '../ui/components/bits.js';
import { CodeBox } from '../ui/components/CodeBox.js';
import { Code, Copy } from '../ui/components/Copy.js';
import { HoverCardLayer, tipCard } from '../ui/components/HoverCard.js';
import { Sprite } from '../ui/components/Icon.js';
import { EmptyState } from '../ui/components/States.js';
import { Term } from '../ui/components/Term.js';
import { AppContext, type AppState } from '../ui/state.js';

/**
 * A page of the design system's shared parts that measure what they set, for browser/primitives.spec.ts
 * to load in a real browser (the tests' renderer has no layout, no canvas and no <details>). Its
 * width is `window.setWidth(px)`'s; `window.setFold(open)` opens and closes its fold.
 */

const app = { toast: () => undefined, guard: (fn: () => void) => fn() } as unknown as AppState;
const attempts: Attempt[] = Array.from({ length: 12 }, (_, i) => ({
  runId: `01M5GRZK${String(i).padStart(2, '0')}`,
  href: `#/run/01M5GRZK${String(i).padStart(2, '0')}`,
  outcome: [1, 4, 7].includes(i) ? 'failed' : i === 10 ? 'inconclusive' : 'passed',
  note: null,
}));

const STORE = 'Connect a bucket you own, push your runs and add CI. About fifteen minutes, with nothing to install or host.';
const BLAME = 'Asked again at #5, the model escalated and the run passed in 3 of 4 attempts; asked again at #7, in none of 4.';
const PATH = 's3://northwind-agent-runs/support-agent/runs/2026';

function Page() {
  const [width, setWidth] = useState(900);
  const [fold, setFold] = useState(false);
  Object.assign(window, { setWidth, setFold });
  return (
    <AppContext.Provider value={app}>
      <Sprite />
      <main className="page">
        <div className="page-in" id="box" style={{ width }}>
          <div id="store">
            <Copy>{STORE}</Copy>
          </div>
          <div id="blame">
            <Copy>{BLAME}</Copy>
          </div>
          <div id="span">
            <Copy as="span">{STORE}</Copy>
          </div>
          <p id="code-block">
            The store is at <Code>{PATH}</Code> today.
          </p>
          <p id="code-inline">
            <span className="sub">
              The store is at <Code>{PATH}</Code> today.
            </span>
          </p>
          <div id="name" style={{ width: 300 }}>
            <Copy>Adds a check to refund-over-limit-with-manager-approval, the golden that guards this fix.</Copy>
          </div>
          <div id="host" style={{ width: 190 }}>
            <Copy>Sign in to shadowlap.northwind.internal to push.</Copy>
          </div>
          <div id="inject">
            <CodeBox command={'shadowlap inject 01K5CQ4N7G --inject 17="Escalate refunds above the regional limit to tier 2."'} />
          </div>
          <div id="set">
            <CodeBox command={`shadowlap replay 01K5CQ4N7G --set '{"amount": 240, "currency": "EUR", "reason": "above the regional refund limit"}'`} />
          </div>
          <div id="expect">
            <CodeBox command={`shadowlap check 01M7NCZVSR --expect '{"tools":{"issue_refund":0}}'`} />
          </div>
          <div id="s3">
            <CodeBox command="shadowlap store push --to s3://northwind-agent-runs/support-agent/runs ." />
          </div>
          <div id="empty">
            <EmptyState title="No runs yet" text="Every recording shows here." step={<a className="btn lime" href="#/">Set up</a>} command="shadowlap run -- node agent.mjs" />
          </div>
          <div id="steps">
            <StepList steps={[{ title: 'Record', state: 'cur', command: 'shadowlap run -- node agent.mjs' }]} />
          </div>
          <p id="card">
            <span id="opens" tabIndex={0} data-tip={tipCard('Open in editor', [], 'Opens refund.py at line 12', '$ code --goto refund.py:12')}>
              Open in editor
            </span>
          </p>
          <div id="terms" data-glossary="">
            <details open={fold}>
              <summary>How it works</summary>
              <p data-row="fold">
                <Term k="stubbed" />
              </p>
            </details>
            <p data-row="shown">
              <Term k="stubbed" />
            </p>
          </div>
          <div id="attempts">
            <AttemptsCell tally="8 of 12" bound="rate 0.43 to 0.95 (95%)" interval={{ lo: 0.43, hi: 0.95 }} marks={[0.7, 0.9]} tone="warn" attempts={attempts} open />
          </div>
        </div>
      </main>
      <HoverCardLayer />
    </AppContext.Provider>
  );
}

createRoot(document.getElementById('root')!).render(<Page />);
