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

/** Sends unless the worker is gone; a dead worker's channel throws. */
function safeSend(w: Worker, m: ToWorker): boolean {
  if (w.isDead() || !w.isConnected()) return false;
  try { w.send(m); return true; } catch { return false; }
}

/** Resolves true once `w` listens, false if it exits or the timeout passes first. */
function waitListening(w: Worker, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
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
}

/** The next message of `kind` from `w`, or null on exit or timeout. */
function waitMessage<K extends FromWorker["cc"]>(w: Worker, kind: K, timeoutMs: number): Promise<Extract<FromWorker, { cc: K }> | null> {
  return new Promise(resolve => {
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
}

const exited = (w: Worker): Promise<void> =>
  (w.isDead() ? Promise.resolve() : new Promise<void>(r => w.once("exit", () => r())));

class Supervisor implements SupervisorHandle {
  private readonly log: (msg: string) => void;
  private readonly readyTimeoutMs: number;
  private readonly freezeTimeoutMs: number;
  private readonly respawnDelayMs: number;
  private readonly startedAt = Date.now();
  private current: Worker | undefined;
  private generation = 0;
  private lastHandoff: HandoffReport | null = null;
  private failedReloads = 0;
  private crashes = 0;
  private reloading = false;
  private stopping = false;
  /** Workers told to drain (handoff) or shut down: their exit is expected. */
  private readonly leaving = new Set<Worker>();

  constructor(private readonly opts: SupervisorOptions) {
    this.log = opts.log ?? ((m: string) => console.log(`[supervisor] ${m}`));
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 120_000;
    this.freezeTimeoutMs = opts.freezeTimeoutMs ?? 15_000;
    this.respawnDelayMs = opts.respawnDelayMs ?? 1_000;
  }

  view(): SupervisorView {
    return {
      supervised: true, supervisorPid: process.pid, generation: this.generation,
      startedAt: this.startedAt, lastHandoff: this.lastHandoff, failedReloads: this.failedReloads, crashes: this.crashes,
    };
  }

  currentPid(): number | undefined {
    return this.current?.process.pid;
  }

  private workers(): Worker[] {
    return Object.values(cluster.workers ?? {}).filter((w): w is Worker => Boolean(w));
  }

  private broadcastView(): void {
    for (const w of this.workers()) safeSend(w, { cc: "supervisor", view: this.view() });
  }

  private fork(): Worker {
    const { exec, args, execArgv, env } = this.opts;
    cluster.setupPrimary({ exec, args, execArgv: execArgv ?? process.execArgv });
    const w = cluster.fork({ ...env, CC_ROUTER_SUPERVISED: "1" });
    w.on("exit", (code, signal) => this.onExit(w, code, signal));
    return w;
  }

  private onExit(w: Worker, code: number | null, signal: string | null): void {
    const expected = this.leaving.delete(w);
    if (w !== this.current) return;
    this.current = undefined;
    if (this.stopping || expected) return;
    this.crashes++;
    this.log(`worker ${w.process.pid} exited unexpectedly (code ${code}, signal ${signal}); replacing it in ${this.respawnDelayMs} ms`);
    this.respawnLater(this.respawnDelayMs);
  }

  private respawnLater(delayMs: number): void {
    // Not unref'd: with the last worker gone this timer is all that keeps the
    // supervisor alive, and an unref'd one let it exit instead of respawning.
    setTimeout(() => { if (!this.stopping && !this.current) void this.startFirst(); }, delayMs);
  }

  async startFirst(): Promise<boolean> {
    const w = this.fork();
    if (!(await waitListening(w, this.readyTimeoutMs))) {
      this.log(`worker ${w.process.pid} did not start listening`);
      if (!w.isDead()) w.kill();
      if (!this.stopping) this.respawnLater(Math.max(this.respawnDelayMs, 5_000));
      return false;
    }
    this.current = w;
    this.generation++;
    this.log(`worker ${w.process.pid} listening (generation ${this.generation})`);
    this.broadcastView();
    return true;
  }

  /** Gives up on a reload: the old worker resumes writing and refreshing. */
  private abandon(old: Worker, why: string): false {
    safeSend(old, { cc: "thaw" });
    this.failedReloads++;
    this.log(why);
    this.broadcastView();
    return false;
  }

  async reload(reason = "reload requested"): Promise<boolean> {
    if (this.stopping) return false;
    if (this.reloading) { this.log(`${reason}: a reload is already under way; ignored`); return false; }
    const old = this.current;
    if (!old) { this.log(`${reason}: no worker running; starting one`); return this.startFirst(); }
    this.reloading = true;
    try {
      this.log(`${reason}: freezing worker ${old.process.pid}`);
      const frozen = waitMessage(old, "frozen", this.freezeTimeoutMs);
      safeSend(old, { cc: "freeze" });
      // Without a confirmed freeze two workers could rotate the same token.
      if (!(await frozen)) return this.abandon(old, `worker ${old.process.pid} did not confirm the freeze; reload abandoned`);
      const next = this.fork();
      if (!(await waitListening(next, this.readyTimeoutMs))) {
        if (!next.isDead()) next.kill();
        return this.abandon(old, `new worker ${next.process.pid} did not start listening; worker ${old.process.pid} keeps serving`);
      }
      this.handOver(old, next);
      return true;
    } finally {
      this.reloading = false;
    }
  }

  /** `next` takes over; `old` drains in the background, so the next reload need not wait for it. */
  private handOver(old: Worker, next: Worker): void {
    this.current = next;
    this.generation++;
    this.leaving.add(old);
    const generation = this.generation;
    const fromPid = old.process.pid ?? 0;
    const toPid = next.process.pid ?? 0;
    const at = Date.now();
    this.log(`worker ${toPid} listening (generation ${generation}); worker ${fromPid} drains`);
    const drained = waitMessage(old, "drained", this.opts.drainLimitMs + DRAIN_MARGIN_MS);
    safeSend(old, { cc: "drain" });
    this.broadcastView();
    void drained.then(report => {
      this.lastHandoff = {
        generation, at, fromPid, toPid,
        finished: report?.finished ?? 0,
        dropped: report?.dropped ?? 0,
        unsaved: report?.unsaved ?? 0,
        drainMs: report?.drainMs ?? Date.now() - at,
      };
      if (!report) this.log(`worker ${fromPid} sent no drain report`);
      else this.log(`worker ${fromPid} drained: ${report.finished} finished, ${report.dropped} ended at the limit, ${report.unsaved} unsaved`);
      this.broadcastView();
      // A short grace to exit on its own, then it is killed.
      setTimeout(() => {
        if (old.isDead()) return;
        this.log(`worker ${fromPid} still alive after draining; killing it`);
        old.process.kill("SIGKILL");
      }, 5_000).unref();
    });
  }

  async stop(reason = "stop requested"): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    const workers = this.workers();
    this.log(`${reason}: ${workers.length} worker(s) drain and save`);
    for (const w of workers) {
      this.leaving.add(w);
      safeSend(w, { cc: "shutdown" });
    }
    const deadline = setTimeout(() => {
      for (const w of this.workers()) if (!w.isDead()) w.process.kill("SIGKILL");
    }, this.opts.drainLimitMs + DRAIN_MARGIN_MS);
    deadline.unref();
    await Promise.all(workers.map(exited));
    clearTimeout(deadline);
    this.log("all workers stopped");
    if (this.opts.exitWhenStopped !== false) process.exit(0);
  }
}

export function runSupervisor(opts: SupervisorOptions): SupervisorHandle {
  if (!cluster.isPrimary) throw new Error("runSupervisor must run in the primary process");
  // Round-robin: the primary accepts and hands connections out, so the socket
  // stays bound while workers come and go. (The default on every platform but
  // Windows; set explicitly so the reload never depends on it.)
  cluster.schedulingPolicy = cluster.SCHED_RR;
  const sup = new Supervisor(opts);
  process.on("SIGHUP", () => { void sup.reload("SIGHUP"); });
  process.on("SIGTERM", () => { void sup.stop("SIGTERM"); });
  process.on("SIGINT", () => { void sup.stop("SIGINT"); });
  void sup.startFirst();
  return sup;
}
