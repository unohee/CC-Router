export interface LogEntry {
  ts: number;
  accountId: string;
  model: string;
  type: "route" | "refresh" | "error";
  details?: string;
  statusCode?: number;
  durationMs?: number;
  method?: string;
  path?: string;
  source?: "cli" | "desktop" | "api";
  /** Claude Code session this request belongs to, when it sent one. Without it
   *  the activity list cannot separate concurrent conversations, and per-session
   *  context growth is unmeasurable — every reading is a mix of whichever
   *  sessions happened to be active. */
  sessionId?: string;
  // Token usage from Anthropic response (message_start + message_delta events)
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
}

const MAX_LOG_ENTRIES = 100;

export class ProxyStats {
  totalRequests = 0;
  totalErrors = 0;
  totalRefreshes = 0;
  totalCacheReadTokens = 0;
  totalCacheCreationTokens = 0;
  totalInputTokens = 0;
  totalOutputTokens = 0;
  readonly startTime = Date.now();
  private logs: LogEntry[] = [];

  addLog(entry: LogEntry): void {
    this.logs.push(entry);
    if (this.logs.length > MAX_LOG_ENTRIES) this.logs.shift();
  }

  /**
   * Most recent activity, while preserving provider visibility.
   *
   * A plain last-N slice is dominated by whichever account is busiest: in a
   * 50-row dashboard, a working Codex account disappeared after 50 Anthropic
   * requests and looked idle. Keep the newest entry for every account first,
   * then fill the remaining slots by recency. Entries stay globally sorted so
   * the activity timeline still reads newest-first.
   */
  getRecentLogs(n = 20): LogEntry[] {
    if (n <= 0) return [];
    const newestFirst = [...this.logs].reverse();
    const latestPerAccount = new Map<string, LogEntry>();
    for (const entry of newestFirst) {
      if (!latestPerAccount.has(entry.accountId)) latestPerAccount.set(entry.accountId, entry);
    }

    const required = new Set(latestPerAccount.values());
    const selected = newestFirst.slice(0, n);
    const missing = [...required].filter(entry => !selected.includes(entry));

    // Make room by evicting the oldest non-required entries. If there are more
    // accounts than slots, the newest accounts win naturally.
    for (const entry of missing) {
      if (selected.length < n) {
        selected.push(entry);
        continue;
      }
      let victim = -1;
      for (let i = selected.length - 1; i >= 0; i--) {
        if (!required.has(selected[i])) { victim = i; break; }
      }
      if (victim < 0) continue;
      selected[victim] = entry;
    }

    return selected.sort((a, b) => b.ts - a.ts).slice(0, n);
  }

  getUptimeSeconds(): number {
    return Math.round((Date.now() - this.startTime) / 1000);
  }
}

// Singleton — shared across server and health endpoint
export const stats = new ProxyStats();
