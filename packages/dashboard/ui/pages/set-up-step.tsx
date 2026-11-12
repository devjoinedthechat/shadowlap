import { noRunsYet } from '../projects.js';
import { href } from '../route.js';
import { projectOf } from '../shell/ProjectBlock.js';
import { useApp } from '../state.js';

/**
 * What a page's empty state offers in a project with no runs yet: `Set up <project>`, a lime link to
 * the Overview, where the setup walks through recording the first run. A plain link rather than an
 * ActionButton, since opening the Overview asks nothing of the server: it works on a read-only
 * dashboard and offline alike. Pages import it on their own, so it is never in the first look.
 */
export function SetUpStep() {
  const { meta } = useApp();
  return (
    <a className="btn lime" href={href.overview()}>
      Set up {projectOf(meta)?.name ?? 'this project'}
    </a>
  );
}

/**
 * Whether the page's empty state is a project's with no runs yet (`noRunsYet`): it then offers Set
 * up <project>, and no command that needs a run (`shadowlap blame <run>`, `shadowlap pack <run>`).
 * Never in an exported copy, which always holds a run.
 */
export function useNoRunsYet(): boolean {
  const { exported, meta, runs } = useApp();
  return !exported && !meta?.static && noRunsYet({ meta, runs }) === true;
}
