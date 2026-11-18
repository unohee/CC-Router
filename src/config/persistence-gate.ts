/**
 * Whether this process may write router state or rotate tokens.
 *
 * During a handoff two workers run at once: the old one finishes its in-flight
 * streams while the new one takes every new request. Only one of them may
 * write accounts.json, sessions.json, the usage and quota history, the account
 * state or config.json, and only one may refresh tokens. A refresh token
 * rotates on use, so two holders refreshing it is exactly how a seat ends up
 * with `invalid_grant`.
 *
 * The old worker flushes everything, then freezes. From then on every writer
 * in this process is a no-op and every refresh is declined, until it exits (or
 * is thawed because its successor failed to start). The new worker loads state
 * only after the freeze, so it starts from what the old one last wrote.
 */

let frozen = false;

export function freezePersistence(): void {
  frozen = true;
}

export function thawPersistence(): void {
  frozen = false;
}

export function persistenceFrozen(): boolean {
  return frozen;
}
