/**
 * Whether the server is answering a request now: what a store in memory does while the server is
 * idle (bringing its search index up to date, warming its run totals) runs on the server's own
 * thread, as no other can open that store, so it waits while a request is being answered. The
 * server counts each request from when it arrives until its answer has gone or its connection closed.
 */

let answering = 0;

/** Counts a request until `done` is called, once. */
export function answeringRequest(): () => void {
  answering++;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    answering--;
  };
}

/** Whether no request is being answered: the moment for a slice of what can wait. */
export function serverIdle(): boolean {
  return answering === 0;
}
