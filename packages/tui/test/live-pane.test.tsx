import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { LivePane } from '../src/components/TimelineParts.js';

/**
 * What asks before an action that has nothing to fill in: a fork's Repeat 5 times, and a write forced
 * live, whose line says first that it acts on your systems. As in the dashboard, where it is the
 * dialog's red line.
 */
describe('the question before an action runs live', () => {
  const pane = (over: Record<string, unknown>) => {
    const onYes = vi.fn();
    const shown = render(<LivePane action={{ key: 'l', label: 'Force send_email live', opensRun: true, ...over }} args={['replay', 'x', '--live-tool', 'send_email']} width={100} height={12} onYes={onYes} onCancel={() => undefined} />);
    return { ...shown, onYes };
  };

  it('says a write acts on your systems before anything else, with what it runs', () => {
    const { lastFrame, unmount } = pane({ asksFirst: true, warns: 'send_email acts on your systems', hint: 'Runs the first call of send_email for real.' });
    const frame = lastFrame()!;
    expect(frame).toContain('send_email acts on your systems');
    expect(frame.indexOf('send_email acts on your systems')).toBeLessThan(frame.indexOf('Runs the first call'));
    expect(frame).toContain('shadowlap replay x --live-tool send_email');
    unmount();
  });

  it('says nothing of the kind where the action acts on nothing for real', () => {
    const { lastFrame, unmount } = pane({ label: 'Repeat 5 times', asksFirst: true });
    expect(lastFrame()).not.toContain('acts on your systems');
    unmount();
  });
});
