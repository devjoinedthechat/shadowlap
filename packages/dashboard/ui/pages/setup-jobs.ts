import { useCallback, useEffect, useRef, useState } from 'react';
import { JOB_KINDS, type JobView } from '../api.js';
import { messageOf } from '../../../engine/src/message-of.js';
import { commandText } from '../goldens.js';
import type { RecordConfirmation, SetupView } from '../projects-api.js';
import { asksForSetup, confirmedRecording } from '../projects.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import { useApp } from '../state.js';
import { startTestsJob, type TestsAsk } from '../tests-ask.js';
import { errorText } from '../toast.js';

/**
 * What the setup page (Setup.tsx) runs: its read model, read again as the project moves on
 * (`useSetupView`), and the steps' jobs with what they were given (`useSetupJobs`). The page draws
 * them; the steps' bodies are in setup-steps.tsx.
 */

/**
 * Pack's question, where the golden's tests entry runs it live: Pack as golden (it packs the run,
 * then tests it) or, once it is packed, Run test, titled by the step's button.
 * The shell asks it, as it asks a Tests session's; this page's chunk holds its words.
 */
export function keepAsk(label: string | undefined, golden: string, packs: boolean): TestsAsk {
  const title = label ?? (packs ? 'Pack as golden' : 'Run test');
  return { title, lead: packs ? `Packs the run as ${golden}, then runs its test.` : `Runs the test of ${golden}.`, doc: 'goldensThatFork', ok: title, commands: [commandText(['test', golden])], parts: ['only what runs live'] };
}

/** The setup's read model as it stands (`undefined` until read, `null` for none), why it couldn't be read, and how to start a job it follows. */
export interface SetupRead {
  view: SetupView | null | undefined;
  failed: string | null;
  load: () => void;
  /** Starts a job this page follows: the setup is read again once it ends. */
  start: (p: Promise<JobView>) => void;
}

/**
 * The setup, read again as runs move (a recording streaming in), when the project changes, every
 * few seconds while the page shows (what a terminal does, an init or a pack, moves it on too), and
 * when a job this page started ends. Not before the meta says whether there is a setup to read: a
 * dashboard that serves one store (`--read-only`, the terminal UI's) has none to follow.
 */
export function useSetupView(): SetupRead {
  const app = useApp();
  const { client, meta, tick, jobs } = app;
  const [view, setView] = useState<SetupView | null | undefined>(undefined);
  const [failed, setFailed] = useState<string | null>(null);
  // The jobs this page started: the setup is read again as each ends.
  const mine = useRef(new Set<string>());
  const projectId = meta?.project?.id ?? null;
  const asks = asksForSetup(meta);

  const load = useCallback(() => {
    client.projects.setup().then(
      (v) => {
        setView(v);
        setFailed(null);
      },
      (err: unknown) => setFailed(messageOf(err)),
    );
  }, [client]);

  useEffect(() => {
    if (asks) load();
  }, [load, tick, projectId, asks]);
  const polling = !!view && view.shows !== 'none';
  useEffect(() => {
    if (!polling) return;
    const t = setInterval(() => {
      if (!document.hidden) load();
    }, 4000);
    return () => clearInterval(t);
  }, [load, polling]);

  const start = useCallback(
    (p: Promise<JobView>) => {
      p.then(
        (job) => mine.current.add(job.id),
        () => undefined,
      );
      app.watchJob(p);
    },
    [app],
  );

  // When a job this page started ends, the setup is read again: what it made moves the steps on.
  useEffect(() => {
    for (const w of jobs) {
      if (!w.job.done || !mine.current.has(w.job.id)) continue;
      mine.current.delete(w.job.id);
      load();
    }
  }, [jobs, load]);

  return { view, failed, load, start };
}

/** The steps' jobs, and what the page keeps for them: the command and golden typed, what each was refused, the first recording's question. */
export interface SetupJobs {
  command: string | null;
  setCommand: (v: string) => void;
  golden: string | null;
  setGolden: (v: string) => void;
  recordError: string | null;
  goldenError: string | null;
  /** The first run's confirmation, for the project it was asked in: the job it starts names that one. */
  asking: { confirm: RecordConfirmation; command: string; project: string } | null;
  closeAsking: () => void;
  /** Records as the confirmation was answered. */
  confirmAsking: () => void;
  inspect: (again: boolean) => void;
  record: (value: string) => void;
  calibrate: (runId: string, write: boolean) => void;
  pack: (value: string) => void;
  testGolden: () => void;
  finish: () => void;
  /** A step's job still running here: its button waits for it, rather than starting a second. */
  running: (kind: string) => boolean;
}

/** The steps' jobs on the setup as read (`view`), each started through `start` so the page follows it. */
export function useSetupJobs(view: SetupView | null | undefined, start: SetupRead['start']): SetupJobs {
  const app = useApp();
  const { client, meta, jobs, guard, toast } = app;
  const [command, setCommand] = useState<string | null>(null);
  const [golden, setGolden] = useState<string | null>(null);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [goldenError, setGoldenError] = useState<string | null>(null);
  const [asking, setAsking] = useState<SetupJobs['asking']>(null);
  const projectId = meta?.project?.id ?? null;
  // A new project starts from its own command and golden, and asks nothing the last one asked.
  useEffect(() => {
    setCommand(null);
    setGolden(null);
    setRecordError(null);
    setGoldenError(null);
    setAsking(null);
  }, [projectId]);

  const id = view?.project.id ?? '';
  const inspect = (again: boolean) => guard(() => start(client.startJob(JOB_KINDS.inspect, { project: id, ...(again ? { again: true } : {}) })));
  const record = (value: string) =>
    guard(() => {
      setRecordError(null);
      client.projects.planRecording(id, value).then(
        (plan) => {
          if (plan.confirm) setAsking({ confirm: plan.confirm, command: value, project: id });
          else start(client.startJob(JOB_KINDS.record, { project: id, command: value }));
        },
        (err: unknown) => setRecordError(messageOf(err)),
      );
    });
  const calibrate = (runId: string, write: boolean) => guard(() => start(client.startJob(JOB_KINDS.calibrate, { runId, write })));
  // Pack as golden: the path checked first, so a mistake shows under the field; then one job packs
  // it and runs its test, on the server, so leaving the page doesn't stop halfway. Where its tests
  // entry runs that test live, the server asks first, as for Tests' sessions, and the shell asks it.
  const keep = { client, guard, watchJob: start };
  const pack = (value: string) =>
    guard(() => {
      setGoldenError(null);
      client.projects.checkGolden(id, value).then(
        ({ path, runId }) => {
          if (!runId) return setGoldenError('Record a run before you pack it as a golden.');
          setGolden(path);
          startTestsJob(keep, JOB_KINDS.keepGolden, { project: id, golden: path }, keepAsk(view?.test.button?.label, path, true));
        },
        (err: unknown) => setGoldenError(messageOf(err)),
      );
    });
  // Packed already: its test runs (again).
  const testGolden = () => startTestsJob(keep, JOB_KINDS.keepGolden, { project: id }, keepAsk(view?.test.button?.label, view?.test.packed?.golden ?? golden ?? '', false));
  const finish = () =>
    guard(() => {
      client.projects.finish(id).then(
        async () => {
          await app.reload();
          navigate(href.overview());
        },
        (err: unknown) => toast(errorText(err), 'error'),
      );
    });
  const confirmAsking = () => {
    if (asking) guard(() => start(client.startJob(JOB_KINDS.record, confirmedRecording(asking))));
  };
  const running = (kind: string) => jobs.some((w) => !w.job.done && !w.lost && w.job.kind === kind);

  return { command, setCommand, golden, setGolden, recordError, goldenError, asking, closeAsking: () => setAsking(null), confirmAsking, inspect, record, calibrate, pack, testGolden, finish, running };
}
