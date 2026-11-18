/**
 * Messages between the supervisor (cluster primary) and router workers.
 *
 * Reload, in order:
 *   1. supervisor → old worker  freeze      flush all state, then stop writing and refreshing
 *      old worker → supervisor  frozen
 *   2. supervisor forks the new worker from the current release; it loads the
 *      state the old one just flushed, starts refreshing and listens
 *   3. supervisor → old worker  drain       stop accepting, finish in-flight, exit (no save)
 *      old worker → supervisor  drained     with what it finished and what it dropped
 *   4. supervisor → new worker  handoff     the report, for health
 * If the new worker fails to start, the supervisor sends `thaw` to the old one,
 * which resumes writing and refreshing as if nothing happened.
 *
 * Stop (SIGTERM to the supervisor): `shutdown` to every worker, which drains
 * and then saves, like a standalone router on SIGTERM.
 */

export interface HandoffReport {
  generation: number;
  at: number;
  fromPid: number;
  toPid: number;
  /** Requests the old worker finished after the new one took over. */
  finished: number;
  /** Requests still open when the drain limit ran out. */
  dropped: number;
  /** Requests the old worker answered after its freeze: their usage was not saved. */
  unsaved: number;
  drainMs: number;
}

export interface SupervisorView {
  supervised: true;
  supervisorPid: number;
  generation: number;
  startedAt: number;
  lastHandoff: HandoffReport | null;
  /** Reloads that were abandoned because the new worker did not come up. */
  failedReloads: number;
}

export type ToWorker =
  | { cc: "freeze" }
  | { cc: "thaw" }
  | { cc: "drain" }
  | { cc: "shutdown" }
  | { cc: "supervisor"; view: SupervisorView };

export type FromWorker =
  | { cc: "frozen"; servedAtFreeze: number }
  | { cc: "drained"; finished: number; dropped: number; unsaved: number; drainMs: number };

export function isToWorker(m: unknown): m is ToWorker {
  return typeof m === "object" && m !== null && typeof (m as { cc?: unknown }).cc === "string";
}

export function isFromWorker(m: unknown): m is FromWorker {
  return typeof m === "object" && m !== null && typeof (m as { cc?: unknown }).cc === "string";
}
