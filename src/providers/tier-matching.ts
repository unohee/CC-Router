import type { ClaudeTier } from "../protocol/model-ref.js";

/**
 * Claude tier -> fallback model, matched against what each fallback provider
 * actually offers right now.
 *
 * A configured tier map is static: it names models that get retired, and a new
 * frontier model never reaches it. Without one, every tier — including the top
 * one the advisor and Fable requests sit in — lands on a single default model,
 * which for Ollama is usually a small "flash" model chosen for the cheap case.
 *
 * Matching is opt-in per provider and only fills tiers the operator left unset:
 * an explicit `openAITierMap` / `ollamaFallback.tierMap` entry always wins.
 */
export type TierModels = Partial<Record<ClaudeTier, string>>;

/** The fields of a `codex/models` entry the matcher reads. */
export interface CodexCatalogModel {
  slug: string;
  /** Backend ordering; lower is newer within a family. Not a capability rank. */
  priority: number;
  visibility?: string;
}

/** The fields of an Ollama `/api/tags` entry the matcher reads. */
export interface OllamaCatalogModel {
  /** The name the configured endpoint accepts (already `:cloud`-suffixed for a local daemon). */
  name: string;
  /** Bytes; 0 when the catalog does not say. */
  size: number;
  capabilities: string[];
}

/**
 * Codex families by the word in the slug. `priority` cannot rank them: the
 * backend puts its recommended workhorse first (gpt-6.1-sol, priority 1) and
 * describes it as "near-Astra performance", so the frontier model sits below
 * it. Verified against `codex/models` 2026-10-25:
 *   astra — "Frontier intelligence for the most demanding work."
 *   sol   — "Latest workhorse model for coding and everyday work."
 *   terra — "Older balanced model for straightforward work."
 *   luna  — "Fast and affordable model for easier tasks."
 */
const CODEX_FAMILIES = ["astra", "sol", "terra", "luna"] as const;
type CodexFamily = typeof CODEX_FAMILIES[number];

/** First family present wins; the second is the nearest substitute. */
const CODEX_TIER_FAMILIES: Record<ClaudeTier, CodexFamily[]> = {
  opus: ["astra", "sol"],
  sonnet: ["sol", "terra"],
  haiku: ["luna", "terra"],
};

function codexFamilyOf(slug: string): CodexFamily | null {
  const words = slug.toLowerCase().split(/[-_.]/);
  return CODEX_FAMILIES.find(f => words.includes(f)) ?? null;
}

export function matchCodexTiers(models: CodexCatalogModel[]): TierModels {
  // Newest model of each family: within a family, lower priority is the newer
  // generation (gpt-6.1-sol 1 < gpt-6-sol 4 < gpt-5.6-sol 6).
  const newest = new Map<CodexFamily, CodexCatalogModel>();
  for (const model of models) {
    if (model.visibility === "hide") continue;
    const family = codexFamilyOf(model.slug);
    if (!family) continue;
    const current = newest.get(family);
    if (!current || model.priority < current.priority) newest.set(family, model);
  }

  const tiers: TierModels = {};
  for (const tier of Object.keys(CODEX_TIER_FAMILIES) as ClaudeTier[]) {
    const family = CODEX_TIER_FAMILIES[tier].find(f => newest.has(f));
    if (family) tiers[tier] = newest.get(family)!.slug;
  }
  return tiers;
}

function baseName(name: string): string {
  return name.split(":")[0];
}

/**
 * Ollama publishes no capability ranking, so parameter size stands in for one:
 * opus gets the largest tool-capable model, sonnet the largest of a different
 * family. Haiku is left to the configured `model`, which is the operator's
 * choice for the cheap, frequent case. Models of unknown size are skipped
 * rather than guessed at, and tool use is required because Claude Code's
 * requests carry tools.
 */
export function matchOllamaTiers(models: OllamaCatalogModel[]): TierModels {
  const ranked = models
    .filter(m => m.size > 0 && m.capabilities.includes("tools"))
    .sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));

  const tiers: TierModels = {};
  const opus = ranked[0];
  if (!opus) return tiers;
  tiers.opus = opus.name;
  const sonnet = ranked.find(m => baseName(m.name) !== baseName(opus.name));
  if (sonnet) tiers.sonnet = sonnet.name;
  return tiers;
}

/**
 * The name a local Ollama daemon accepts for a cloud catalog entry: untagged
 * models take `:cloud`, tagged ones a `-cloud` suffix on the tag (measured on
 * 0.34.3: `kimi-k3:cloud`, `deepseek-v4-pro:0813-cloud`).
 */
export function ollamaCloudName(name: string): string {
  if (/[:-]cloud$/.test(name)) return name;
  return name.includes(":") ? `${name}-cloud` : `${name}:cloud`;
}

export const OLLAMA_CLOUD_CATALOG_URL = "https://ollama.com/api/tags";
const CATALOG_TIMEOUT_MS = 10_000;

function isOllamaCloud(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "ollama.com" || host.endsWith(".ollama.com");
  } catch {
    return false;
  }
}

/**
 * The cloud models the configured endpoint can serve. A local daemon lists only
 * what is pulled, not the cloud models it proxies, so for one the catalog comes
 * from ollama.com and the names are rewritten to the daemon's form. Empty on
 * any failure: the caller keeps its previous mapping.
 */
export async function fetchOllamaCatalog(
  baseUrl: string,
  apiKey: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<OllamaCatalogModel[]> {
  const cloud = isOllamaCloud(baseUrl);
  const url = cloud ? `${baseUrl.replace(/\/+$/, "")}/api/tags` : OLLAMA_CLOUD_CATALOG_URL;
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        ...(cloud && apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      redirect: "error",
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const payload = await res.json() as { models?: unknown };
    if (!Array.isArray(payload?.models)) return [];
    return payload.models.flatMap((raw): OllamaCatalogModel[] => {
      if (!raw || typeof raw !== "object") return [];
      const entry = raw as { name?: unknown; size?: unknown; capabilities?: unknown };
      if (typeof entry.name !== "string" || !entry.name.trim()) return [];
      const name = entry.name.trim();
      return [{
        name: cloud ? name : ollamaCloudName(name),
        size: typeof entry.size === "number" && Number.isFinite(entry.size) ? entry.size : 0,
        capabilities: Array.isArray(entry.capabilities)
          ? entry.capabilities.filter((c): c is string => typeof c === "string")
          : [],
      }];
    });
  } catch {
    return [];
  }
}

/** Context window an Ollama endpoint reports for one model, or null if it does not say. */
export async function fetchOllamaContextLength(
  baseUrl: string,
  model: string,
  apiKey: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<number | null> {
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/api/show`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(isOllamaCloud(baseUrl) && apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ model }),
      redirect: "error",
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const info = (await res.json() as { model_info?: Record<string, unknown> }).model_info ?? {};
    for (const [key, value] of Object.entries(info)) {
      if (key.endsWith("context_length") && typeof value === "number" && value > 0) return value;
    }
    return null;
  } catch {
    return null;
  }
}

/** How many of the largest models are sized up per refresh; one `/api/show` each. */
const CONTEXT_PROBE_LIMIT = 8;

/**
 * The catalog, cut to models that can carry what the configured model already
 * carries. The router admits a request on `contextTokens`, not on the model's
 * window, so a matched model with a smaller window than the configured one
 * would turn conversations the configured model answers into failures — and
 * a failure before the first byte becomes a 429 rather than an answer.
 *
 * Only the largest few are probed. A model whose window cannot be read is
 * dropped, unless the configured model's window is unknown too, in which case
 * there is nothing to compare against and the catalog is returned unfiltered.
 */
export async function fetchOllamaCandidates(
  baseUrl: string,
  apiKey: string | undefined,
  configuredModel: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OllamaCatalogModel[]> {
  const catalog = await fetchOllamaCatalog(baseUrl, apiKey, fetchImpl);
  const minContext = await fetchOllamaContextLength(baseUrl, configuredModel, apiKey, fetchImpl);
  if (minContext === null) return catalog;

  const largest = catalog
    .filter(m => m.size > 0 && m.capabilities.includes("tools"))
    .sort((a, b) => b.size - a.size)
    .slice(0, CONTEXT_PROBE_LIMIT);
  const windows = await Promise.all(largest.map(m => fetchOllamaContextLength(baseUrl, m.name, apiKey, fetchImpl)));
  return largest.filter((_, i) => (windows[i] ?? 0) >= minContext);
}

export interface TierDiscoveryOptions {
  /** Absent when the provider's matching is off. */
  codexCatalog?: () => Promise<CodexCatalogModel[]>;
  ollamaCatalog?: () => Promise<OllamaCatalogModel[]>;
  intervalMs?: number;
  onChange?: (provider: "openai" | "ollama", tiers: TierModels) => void;
}

export interface TierDiscovery {
  openAI: () => TierModels;
  ollama: () => TierModels;
  refresh: () => Promise<void>;
  stop: () => void;
}

const DEFAULT_REFRESH_MS = 6 * 60 * 60 * 1000;
/** Retry cadence while a provider has no match yet, e.g. the catalog was
 *  unreachable at boot. Waiting the full interval would leave the top tier on
 *  the default model for hours. */
const UNMATCHED_RETRY_MS = 5 * 60 * 1000;

function sameTiers(a: TierModels, b: TierModels): boolean {
  return a.opus === b.opus && a.sonnet === b.sonnet && a.haiku === b.haiku;
}

/**
 * Keeps each provider's matched tiers current. A failed or empty catalog read
 * keeps the last good mapping: losing the catalog for an hour must not drop
 * the advisor back onto the cheapest model.
 */
export function createTierDiscovery(opts: TierDiscoveryOptions): TierDiscovery {
  let openAI: TierModels = {};
  let ollama: TierModels = {};
  let openAIMatchedAt = 0;
  let ollamaMatchedAt = 0;
  const intervalMs = opts.intervalMs ?? DEFAULT_REFRESH_MS;

  const refreshOpenAI = async (): Promise<void> => {
    if (!opts.codexCatalog) return;
    const next = matchCodexTiers(await opts.codexCatalog().catch(() => []));
    if (Object.keys(next).length === 0) return;
    openAIMatchedAt = Date.now();
    if (sameTiers(next, openAI)) return;
    openAI = next;
    opts.onChange?.("openai", next);
  };

  const refreshOllama = async (): Promise<void> => {
    if (!opts.ollamaCatalog) return;
    const next = matchOllamaTiers(await opts.ollamaCatalog().catch(() => []));
    if (Object.keys(next).length === 0) return;
    ollamaMatchedAt = Date.now();
    if (sameTiers(next, ollama)) return;
    ollama = next;
    opts.onChange?.("ollama", next);
  };

  const refresh = async (): Promise<void> => {
    await Promise.all([refreshOpenAI(), refreshOllama()]);
  };

  // Ticks at the short cadence; a provider is re-read once its last match is
  // a full interval old, or on every tick while it has none.
  const due = (matchedAt: number) => matchedAt === 0 || Date.now() - matchedAt >= intervalMs;
  const timer = setInterval(() => {
    Promise.all([
      due(openAIMatchedAt) ? refreshOpenAI() : undefined,
      due(ollamaMatchedAt) ? refreshOllama() : undefined,
    ]).catch(() => {});
  }, Math.min(intervalMs, UNMATCHED_RETRY_MS));
  timer.unref?.();

  return {
    openAI: () => openAI,
    ollama: () => ollama,
    refresh,
    stop: () => clearInterval(timer),
  };
}
