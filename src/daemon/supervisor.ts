/**
 * The supervisor: owns the listening socket and runs the router in a worker
 * process it can replace without dropping a request.
 *
 * Built on node:cluster with round-robin scheduling: the supervisor (primary)
 * holds the socket and hands each connection to a worker. Replacing the worker
 * never unbinds the port, so no connection is refused during a reload.
 *
 *   SIGHUP   reload: freeze the old worker's writes, start a worker from the
 *            release `exec` now points at (through the `current` symlink),
 *            wait until it listens, then let the old one drain and exit.
 *            If the new worker does not come up, the old one is thawed and
 *            keeps serving. See handoff-protocol.ts for the messages.
 *   SIGTERM  stop: every worker drains (up to the drain limit), saves, exits.
 *   crash    a worker that dies unexpectedly is replaced after a short delay.
 */
import cluster, { type Worker } from "node:cluster";
import { isFromWorker, type FromWorker, type HandoffReport, type SupervisorView, type ToWorker } from "./handoff-protocol.js";

export interface SupervisorOptions {
  /** Worker entry script. Keep it a path through the `current` symlink so a reload runs the new release. */
  exec: string;
  /** Arguments for the worker, e.g. ["start", "--foreground", "--port", "3456"]. */
  args: string[];
  execArgv?: string[];
  /** Extra environment for workers. */
  env?: Record<string, string>;
  /** The workers' drain limit; the supervisor waits that long (plus a margin) before killing one. */
  drainLimitMs: number;
  /** How long a new worker may take to listen before the reload is abandoned. */
  readyTimeoutMs?: number;
  /** How long the old worker may take to confirm it saved and froze. */
  freezeTimeoutMs?: number;
  /** Delay before replacing a worker that crashed. */
  respawnDelayMs?: number;
  log?: (msg: string) => void;
  /** Exit the process once every worker has stopped (default true; tests keep it running). */
  exitWhenStopped?: boolean;
}

export interface SupervisorHandle {
  reload(reason?: string): Promise<boolean>;
  stop(reason?: string): Promise<void>;
  view(): SupervisorView;
  currentPid(): number | undefined;
}

const DRAIN_MARGIN_MS = 30_000;

export function runSupervisor(opts: SupervisorOptions): SupervisorHandle {
  if (!cluster.isPrimary) throw new Error("runSupervisor must run in the primary process");
  const log = opts.log ?? ((m: string) => console.log(`[supervisor] ${m}`));
  const readyTimeoutMs = opts.readyTimeoutMs ?? 120_000;
  const freezeTimeoutMs = opts.freezeTimeoutMs ?? 15_000;
  const respawnDelayMs = opts.respawnDelayMs ?? 1_000;

  // Round-robin: the primary accepts and hands connections out, so the socket
  // stays bound while workers come and go. (The default on every platform but
  // Windows; set explicitly so the reload never depends on it.)
  cluster.schedulingPolicy = cluster.SCHED_RR;

  const startedAt = Date.now();
  let current: Worker | undefined;
  let generation = 0;
  let lastHandoff: HandoffReport | null = null;
  let failedReloads = 0;
  let reloading = false;
  let stopping = false;
  /** Workers that were told to drain (handoff) or shut down; their exit is expected. */
  const leaving = new Set<Worker>();

  /** Sends unless the worker is gone; a dead worker's channel throws. */
  const safeSend = (w: Worker, m: ToWorker): boolean => {
    if (w.isDead() || !w.isConnected()) return false;
    try { w.send(m); return true; } catch { return false; }
  };

  const view = (): SupervisorView => ({
    supervised: true, supervisorPid: process.pid, generation, startedAt, lastHandoff, failedReloads,
  });
  const broadcastView = () => {
    for (const w of Object.values(cluster.workers ?? {})) {
      if (w) safeSend(w, { cc: "supervisor", view: view() });
    }
  };

  const fork = (): Worker => {
    cluster.setupPrimary({ exec: opts.exec, args: opts.args, execArgv: opts.execArgv ?? process.execArgv });
    const w = cluster.fork({ ...opts.env, CC_ROUTER_SUPERVISED: "1" });
    w.on("exit", (code, signal) => onExit(w, code, signal));
    return w;
  };

  /** Resolves true once `w` listens, false if it exits or the timeout passes first. */
  const waitListening = (w: Worker, timeoutMs: number): Promise<boolean> => new Promise(resolve => {
    const done = (ok: boolean) => {
      clearTimeout(timer);
      w.off("listening", onListening);
      w.off("exit", onGone);
      resolve(ok);
    };
    const onListening = () => done(true);
    const onGone = () => done(false);
    const timer = setTimeout(() => done(false), timeoutMs);
    w.once("listening", onListening);
    w.once("exit", onGone);
  });

  /** The next message of `kind` from `w`, or null on exit or timeout. */
  const waitMessage = <K extends FromWorker["cc"]>(w: Worker, kind: K, timeoutMs: number): Promise<Extract<FromWorker, { cc: K }> | null> =>
    new Promise(resolve => {
      const done = (m: Extract<FromWorker, { cc: K }> | null) => {
        clearTimeout(timer);
        w.off("message", onMessage);
        w.off("exit", onGone);
        resolve(m);
      };
      const onMessage = (m: unknown) => {
        if (isFromWorker(m) && m.cc === kind) done(m as Extract<FromWorker, { cc: K }>);
      };
      const onGone = () => done(null);
      const timer = setTimeout(() => done(null), timeoutMs);
      w.on("message", onMessage);
      w.once("exit", onGone);
    });

  const onExit = (w: Worker, code: number | null, signal: string | null) => {
    const expected = leaving.delete(w);
    if (w !== current) return;
    current = undefined;
    if (stopping || expected) return;
    log(`worker ${w.process.pid} exited unexpectedly (code ${code}, signal ${signal}); replacing it in ${respawnDelayMs} ms`);
    setTimeout(() => { if (!stopping && !current) void startFirst(); }, respawnDelayMs).unref();
  };

  const startFirst = async (): Promise<boolean> => {
    const w = fork();
    const ok = await waitListening(w, readyTimeoutMs);
    if (!ok) {
      log(`worker ${w.process.pid} did not start listening`);
      if (!w.isDead()) w.kill();
      if (!stopping) setTimeout(() => { if (!stopping && !current) void startFirst(); }, Math.max(respawnDelayMs, 5_000)).unref();
      return false;
    }
    current = w;
    generation++;
    log(`worker ${w.process.pid} listening (generation ${generation})`);
    broadcastView();
    return true;
  };

  const reload = async (reason = "reload requested"): Promise<boolean> => {
    if (stopping) return false;
    if (reloading) { log(`${reason}: a reload is already under way; ignored`); return false; }
    const old = current;
    if (!old) { log(`${reason}: no worker running; starting one`); return startFirst(); }
    reloading = true;
    try {
      log(`${reason}: freezing worker ${old.process.pid}`);
      const frozenReply = waitMessage(old, "frozen", freezeTimeoutMs);
      safeSend(old, { cc: "freeze" });
      if (!(await frozenReply)) {
        // Without a confirmed freeze two workers could rotate the same token.
        safeSend(old, { cc: "thaw" });
        failedReloads++;
        log(`worker ${old.process.pid} did not confirm the freeze; reload abandoned`);
        broadcastView();
        return false;
      }
      const next = fork();
      if (!(await waitListening(next, readyTimeoutMs))) {
        if (!next.isDead()) next.kill();
        safeSend(old, { cc: "thaw" });
        failedReloads++;
        log(`new worker ${next.process.pid} did not start listening; worker ${old.process.pid} keeps serving`);
        broadcastView();
        return false;
      }
      current = next;
      generation++;
      leaving.add(old);
      const fromPid = old.process.pid ?? 0;
      const toPid = next.process.pid ?? 0;
      const at = Date.now();
      log(`worker ${toPid} listening (generation ${generation}); worker ${fromPid} drains`);
      const drained = waitMessage(old, "drained", opts.drainLimitMs + DRAIN_MARGIN_MS);
      safeSend(old, { cc: "drain" });
      broadcastView();
      // The old worker drains in the background: the next reload need not wait for it.
      void drained.then(report => {
        lastHandoff = {
          generation, at, fromPid, toPid,
          finished: report?.finished ?? 0,
          dropped: report?.dropped ?? 0,
          unsaved: report?.unsaved ?? 0,
          drainMs: report?.drainMs ?? Date.now() - at,
        };
        if (!report) log(`worker ${fromPid} sent no drain report`);
        else log(`worker ${fromPid} drained: ${report.finished} finished, ${report.dropped} ended at the limit, ${report.unsaved} unsaved`);
        broadcastView();
        killLater(old);
      });
      return true;
    } finally {
      reloading = false;
    }
  };

  /** A worker that has reported (or should have) gets a short grace, then is killed. */
  const killLater = (w: Worker) => {
    setTimeout(() => { if (!w.isDead()) { log(`worker ${w.process.pid} still alive after draining; killing it`); w.process.kill("SIGKILL"); } }, 5_000).unref();
  };

  const stop = async (reason = "stop requested"): Promise<void> => {
    if (stopping) return;
    stopping = true;
    const workers = Object.values(cluster.workers ?? {}).filter((w): w is Worker => Boolean(w));
    log(`${reason}: ${workers.length} worker(s) drain and save`);
    for (const w of workers) {
      leaving.add(w);
      safeSend(w, { cc: "shutdown" });
    }
    const deadline = setTimeout(() => {
      for (const w of Object.values(cluster.workers ?? {})) if (w && !w.isDead()) w.process.kill("SIGKILL");
    }, opts.drainLimitMs + DRAIN_MARGIN_MS);
    deadline.unref();
    await Promise.all(workers.map(w => (w.isDead() ? Promise.resolve() : new Promise<void>(r => w.once("exit", () => r())))));
    clearTimeout(deadline);
    log("all workers stopped");
    if (opts.exitWhenStopped !== false) process.exit(0);
  };

  process.on("SIGHUP", () => { void reload("SIGHUP"); });
  process.on("SIGTERM", () => { void stop("SIGTERM"); });
  process.on("SIGINT", () => { void stop("SIGINT"); });

  void startFirst();

  return {
    reload,
    stop,
    view,
    currentPid: () => current?.process.pid,
  };
}
