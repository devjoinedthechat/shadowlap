import { EmptyState } from '../../components/bits.js';
import { SetUpStep, useNoRunsYet } from '../set-up-step.js';

/**
 * A Training tab with nothing in it (Pairs, Tasks): what it will hold, and the server's command that
 * makes the first. That command names a run, so a project with no runs yet is offered Set up
 * <project> in its place: recording one comes first.
 */
export function TabEmpty({ empty }: { empty: { title: string; text: string; command: string } }) {
  const none = useNoRunsYet();
  return <EmptyState title={empty.title} text={empty.text} step={none ? <SetUpStep /> : undefined} command={none ? undefined : empty.command} />;
}
