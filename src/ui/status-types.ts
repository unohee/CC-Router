import type { LogEntry } from "../proxy/stats.js";
import type { PoolSeverity } from "../proxy/severity.js";

/** The shapes `/cc-router/health` returns, as the terminal dashboard reads them. */

export interface AccountRateLimitsView {
  status: string;
  fiveHourUtil: number;
  fiveHourReset: number;
  sevenDayUtil: number;
  sevenDayReset: number;
  claim: string;
  plan: string;
  requestsLimit: number;
  lastUpdated: number;
}

export interface AccountStat {
  id: string;
  provider?: "anthropic_subscription" | "openai_subscription";
  healthy: boolean;
  busy: boolean;
  /** Epoch ms when an account-wide 429/529 cooldown ends. */
  coolingUntil?: number;
  /** Active per-model-family cooldown deadlines (epoch ms). */
  modelCooldowns?: Record<string, number>;
  requestCount: number;
  errorCount: number;
  expiresInMs: number;
  lastUsedMs: number;
  lastRefreshMs: number;
  rateLimits?: AccountRateLimitsView;
  enabled?: boolean;
  sessionLimitPercent?: number;
  weeklyLimitPercent?: number;
  /** Whether upstream has ever named a 7-day window for this account. */
  weeklyWindow?: "seen" | "not-reported" | "unknown";
}

export interface ProviderOperationalStatus {
  configured: boolean;
  accounts: number;
  healthy: number;
  enabled: number;
}

export interface OperationalStatus {
  auth: { required: boolean };
  providers: {
    anthropic: ProviderOperationalStatus;
    openai: ProviderOperationalStatus;
  };
  endpoints: {
    health: string;
    accounts: string;
    messages: string;
    responses: string;
    models: string;
  };
  routing: {
    anthropicDefaultModel?: string;
    openAIDefaultModel?: string;
    anthropicAliases: string[];
    openAIAliases: string[];
  };
  capabilities: {
    anthropicMessages: boolean;
    openAIResponses: boolean;
    crossProviderMessages: boolean;
    dynamicModels: boolean;
    accountManagement: boolean;
  };
}

export interface HealthData {
  status: "ok" | "degraded";
  mode: string;
  target: string;
  operational?: OperationalStatus;
  uptime: number;
  totalRequests: number;
  totalErrors: number;
  totalRefreshes: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalInputTokens: number;
  totalOutputTokens?: number;
  accounts: AccountStat[];
  /** Read-only fallback provider, separate from editable OAuth accounts. */
  ollamaFallback?: OllamaFallbackView;
  recentLogs: LogEntry[];
  /** Absent from a router older than the one that introduced it; the dashboard then computes it. */
  severity?: PoolSeverity;
}

export interface OllamaFallbackView {
  enabled: boolean;
  model?: string | null;
  baseUrl?: string;
  ready?: boolean;
  keyRequired?: boolean;
  keyPresent?: boolean;
  serving?: boolean;
  inactiveReason?: string | null;
  requests?: number;
  errors?: number;
  lastServedAt?: number | null;
  quota?: {
    status: "known" | "unavailable";
    source: string | null;
    checkedAt: number | null;
    balance?: { includedUsd: number; allowanceUsd: number; purchasedUsd: number };
    resetsAt: number | null;
    reason?: string;
  };
}

export type Focus = "logs" | "accounts" | "models";
export type Mode = "view" | "editSession" | "editWeekly" | "confirmDelete";
