import { readWorkflow } from '@shadowlap/engine';
import { describe, expect, it } from 'vitest';
import { fileSwitches } from '../src/ci-file.js';
import { workflowFile } from '../src/ci-yaml.js';

describe('fileSwitches', () => {
  it('reads the switches back from a file Settings → CI wrote', () => {
    const text = workflowFile({ fix: { budget: '5.00', repairer: 'openai:gpt-5' }, alerts: { onlyMain: true, secret: 'TEAM_HOOK', branch: 'trunk' }, comment: false, inconclusive: 'warn', push: 'keys' });
    expect(fileSwitches(readWorkflow(text))).toEqual({ comment: false, fix: true, budget: '5.00', repairer: 'openai:gpt-5', alerts: true, onlyMain: true, secret: 'TEAM_HOOK', branch: 'trunk', inconclusive: 'warn', push: 'keys' });
    expect(fileSwitches(readWorkflow(workflowFile({ fix: null, alerts: null, push: 'oidc' })))).toEqual({ comment: true, fix: false, alerts: false, onlyMain: true, inconclusive: 'fail', push: 'oidc' });
  });

  it('reads a Slack step for every branch, and leaves out what the page wouldn’t take', () => {
    const text = workflowFile({ fix: { budget: '2.00', repairer: 'anthropic' }, alerts: { onlyMain: false, secret: 'SLACK_WEBHOOK_URL' } }).replace('fix-budget: 2.00', 'fix-budget: 5000').replace('repairer: anthropic', 'repairer: gpt');
    expect(fileSwitches(readWorkflow(text))).toEqual({ comment: true, fix: true, alerts: true, onlyMain: false, secret: 'SLACK_WEBHOOK_URL', inconclusive: 'fail', push: null });
  });

  it('has none for a file with no step that uses the action', () => {
    expect(fileSwitches(readWorkflow('jobs:\n  a:\n    steps:\n      - run: npm test\n'))).toBeNull();
  });
});
