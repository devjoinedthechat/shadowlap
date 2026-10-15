import { PageHeader, StepList, type Step } from '../components/bits.js';
import { Page } from '../components/Page.js';
import { isAttempt } from '../runs.js';
import { projectOf } from '../shell/ProjectBlock.js';
import { useApp } from '../state.js';

/** The four steps that make a project replayable, each with the command that does it. */
export function setupSteps(recorded: boolean): Step[] {
  return [
    {
      title: 'Inspect the folder',
      text: 'Finds the model SDKs, the command that starts the agent, and every tool with the effect it declares. It runs nothing.',
      command: 'shadowlap init',
      state: recorded ? 'done' : 'cur',
    },
    {
      title: 'Record a first run',
      text: 'Runs your command once with a local sidecar in front of the model API. Model calls go to the real API with your keys, which are never stored.',
      command: 'shadowlap run -- python agent.py',
      state: recorded ? 'done' : 'todo',
    },
    {
      title: 'Make the replay clean',
      text: 'Replays the run offline until it is clean, and proposes a normalizer for every value the agent makes anew.',
      command: 'shadowlap calibrate <run> --write',
      state: recorded ? 'cur' : 'todo',
    },
    {
      title: 'Keep it as a test',
      text: 'Packs the run into the repository, and CI replays it offline on every commit.',
      command: 'shadowlap pack <run> goldens/first-run',
      state: 'todo',
    },
  ];
}

/** Setup (#/setup). The guided setup with its jobs comes later; these are the steps and their commands. */
export function SetupPage() {
  const { meta, runs } = useApp();
  const name = projectOf(meta)?.name ?? 'this project';
  const recorded = (runs ?? []).some((r) => !isAttempt(r));
  return (
    <Page>
      <PageHeader eyebrow={name} title={`Set up ${name}`} text="Record the agent once. Every replay after that is free." />
      <StepList steps={setupSteps(recorded)} />
    </Page>
  );
}
