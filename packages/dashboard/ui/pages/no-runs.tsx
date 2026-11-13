import { PageHeader, StepList, type Step } from '../components/bits.js';
import { Page } from '../components/Page.js';
import { RECORD_PLACEHOLDER } from '../projects.js';
import { projectOf } from '../shell/ProjectBlock.js';
import { useApp } from '../state.js';
import { SETUP_INTRO } from '../../src/setup-words.js';

/**
 * The four steps with their commands, for a page that can't follow this project's setup (a
 * dashboard that serves one store, the Overview before its summary): from the first, with nothing
 * marked done, since nothing here can tell how far the project got. Apart from the setup page, so
 * the Overview draws them without loading it.
 */
export function setupSteps(): Step[] {
  return [
    {
      title: 'Inspect',
      text: 'Finds the model SDKs, the command that starts the agent, and every tool with the effect it declares. It runs nothing.',
      command: 'shadowlap init',
      state: 'cur',
    },
    {
      title: 'Record',
      text: 'Runs your command once with a local sidecar in front of the model API. Model calls go to the real API with your keys, which are never stored.',
      command: `shadowlap run -- ${RECORD_PLACEHOLDER}`,
      state: 'todo',
    },
    {
      title: 'Calibrate',
      text: 'Replays the run offline until it is clean, and proposes a normalizer for every value the agent makes anew.',
      command: 'shadowlap calibrate <run> --write',
      state: 'todo',
    },
    {
      title: 'Pack',
      text: 'Packs the run into the repository, and CI replays it offline on every commit.',
      command: 'shadowlap pack <run> goldens/first-run && shadowlap test goldens/first-run',
      state: 'todo',
    },
  ];
}

/**
 * A project with no runs where its setup can't be followed: `No runs yet`, the setup's lead
 * (`SETUP_INTRO`), and the four steps with their commands. The setup page of a dashboard that
 * serves one store draws it, and so does the Overview whose summary counts no runs.
 */
export function NoRunsSteps() {
  const { meta } = useApp();
  return (
    <Page>
      <PageHeader eyebrow={projectOf(meta)?.name ?? 'this project'} title="No runs yet" text={SETUP_INTRO} />
      <StepList steps={setupSteps()} />
    </Page>
  );
}
