import { describe, expect, it, vi } from "vitest";
import {
  createTierDiscovery,
  fetchOllamaCandidates,
  fetchOllamaCatalog,
  matchCodexTiers,
  matchOllamaTiers,
  ollamaCloudName,
  OLLAMA_CLOUD_CATALOG_URL,
  type CodexCatalogModel,
  type OllamaCatalogModel,
} from "../providers/tier-matching.js";
import { fetchOpenAICodexModelCatalog } from "../providers/model-discovery.js";
import { openAIModelForClaudeModel } from "../protocol/model-ref.js";
import { decideOllamaFallback, ollamaModelFor, resolveOllamaFallbackConfig } from "../providers/ollama/fallback-policy.js";
import type { OpenAISubscriptionAccount } from "../providers/openai/token-refresher.js";

// `codex/models` as read on 2026-10-25 (slug, priority, visibility only).
const CODEX_CATALOG: CodexCatalogModel[] = [
  { slug: "gpt-6.1-sol", priority: 1, visibility: "list" },
  { slug: "gpt-6-astra", priority: 2, visibility: "list" },
  { slug: "gpt-6-sol", priority: 4, visibility: "list" },
  { slug: "gpt-reserve", priority: 4, visibility: "hide" },
  { slug: "gpt-6-luna", priority: 5, visibility: "list" },
  { slug: "gpt-5.6-sol", priority: 6, visibility: "list" },
  { slug: "gpt-5.6-terra", priority: 8, visibility: "list" },
  { slug: "gpt-5.6-luna", priority: 9, visibility: "list" },
  { slug: "codex-auto-review", priority: 43, visibility: "hide" },
];

const GB = 1_000_000_000;
const OLLAMA_CATALOG: OllamaCatalogModel[] = [
  { name: "deepseek-v4.1-flash:cloud", size: 486 * GB, capabilities: ["completion", "thinking", "tools"] },
  { name: "kimi-k3:cloud", size: 1560 * GB, capabilities: ["completion", "tools"] },
  { name: "deepseek-v4-pro:0813-cloud", size: 892 * GB, capabilities: ["completion", "tools"] },
  { name: "mistral-large-4:cloud", size: 0, capabilities: ["completion", "tools"] },
  { name: "huge-chat:cloud", size: 9000 * GB, capabilities: ["completion"] },
];

describe("matchCodexTiers", () => {
  it("ranks by family, not by the backend's priority", () => {
    // priority 1 is the workhorse; the frontier model is astra at priority 2.
    expect(matchCodexTiers(CODEX_CATALOG)).toEqual({
      frontier: "gpt-6-astra",
      opus: "gpt-6.1-sol",
      sonnet: "gpt-6.1-sol",
      haiku: "gpt-6-luna",
    });
  });

  it("falls back to the nearest family when the preferred one is absent", () => {
    const older = CODEX_CATALOG.filter(m => m.slug.startsWith("gpt-5.6"));
    expect(matchCodexTiers(older)).toEqual({
      frontier: "gpt-5.6-sol",
      opus: "gpt-5.6-sol",
      sonnet: "gpt-5.6-sol",
      haiku: "gpt-5.6-luna",
    });
  });

  it("never promotes Opus to Astra when Sol is absent", () => {
    expect(matchCodexTiers([{ slug: "gpt-6-astra", priority: 2 }])).toEqual({
      frontier: "gpt-6-astra",
    });
  });

  it("skips hidden models and unknown families", () => {
    expect(matchCodexTiers([
      { slug: "gpt-7-astra", priority: 1, visibility: "hide" },
      { slug: "gpt-reserve", priority: 2 },
    ])).toEqual({});
  });
});

describe("matchOllamaTiers", () => {
  it("gives opus the largest tool-capable model and sonnet the next family", () => {
    expect(matchOllamaTiers(OLLAMA_CATALOG)).toEqual({
      opus: "kimi-k3:cloud",
      sonnet: "deepseek-v4-pro:0813-cloud",
    });
  });

  it("does not give sonnet another tag of the opus model", () => {
    expect(matchOllamaTiers([
      { name: "kimi-k3:cloud", size: 1560 * GB, capabilities: ["tools"] },
      { name: "kimi-k3:1017-cloud", size: 1500 * GB, capabilities: ["tools"] },
      { name: "glm-5.3:cloud", size: 755 * GB, capabilities: ["tools"] },
    ]).sonnet).toBe("glm-5.3:cloud");
  });

  it("leaves haiku to the configured model and matches nothing from an empty catalog", () => {
    expect(matchOllamaTiers(OLLAMA_CATALOG).haiku).toBeUndefined();
    expect(matchOllamaTiers([])).toEqual({});
  });
});

describe("ollamaCloudName", () => {
  it("uses the local daemon's naming for cloud models", () => {
    expect(ollamaCloudName("kimi-k3")).toBe("kimi-k3:cloud");
    expect(ollamaCloudName("deepseek-v4-pro:0813")).toBe("deepseek-v4-pro:0813-cloud");
    expect(ollamaCloudName("gpt-oss:120b-cloud")).toBe("gpt-oss:120b-cloud");
    expect(ollamaCloudName("glm-5.3:cloud")).toBe("glm-5.3:cloud");
  });
});

describe("tier resolution order", () => {
  const matched = { frontier: "gpt-6-astra", opus: "gpt-6.1-sol", sonnet: "gpt-6.1-sol", haiku: "gpt-6-luna" };

  it("Codex: explicit map, then matched, then default", () => {
    const routing = { openAIDefaultModel: "gpt-6.1-sol", openAITierMap: { haiku: "gpt-5.6-luna" } };
    expect(openAIModelForClaudeModel("claude-haiku-5-5", routing, matched)).toBe("gpt-5.6-luna");
    expect(openAIModelForClaudeModel("claude-fable-5-1", routing, matched)).toBe("gpt-6-astra");
    expect(openAIModelForClaudeModel("claude-fable-5-1", routing)).toBe("gpt-6.1-sol");
    expect(openAIModelForClaudeModel("some-unknown-model", routing, matched)).toBe("gpt-6.1-sol");
  });

  it("Ollama: explicit map, then matched, then the configured model", () => {
    const config = { model: "deepseek-v4.1-flash:cloud", tierMap: { sonnet: "glm-5.3:cloud" } };
    const ollamaMatched = { opus: "kimi-k3:cloud", sonnet: "deepseek-v4-pro:0813-cloud" };
    expect(ollamaModelFor("claude-sonnet-5-5", config, ollamaMatched)).toBe("glm-5.3:cloud");
    expect(ollamaModelFor("claude-fable-5-1", config, ollamaMatched)).toBe("kimi-k3:cloud");
    expect(ollamaModelFor("claude-haiku-5-5", config, ollamaMatched)).toBe("deepseek-v4.1-flash:cloud");
    expect(ollamaModelFor("claude-fable-5-1", config)).toBe("deepseek-v4.1-flash:cloud");
  });

  it("the Ollama decision answers with the matched model", () => {
    const config = resolveOllamaFallbackConfig({
      enabled: true, baseUrl: "http://127.0.0.1:11434", model: "deepseek-v4.1-flash:cloud", autoTierMap: true,
    });
    expect(config?.autoTierMap).toBe(true);
    const decision = decideOllamaFallback({
      config,
      claudeModel: "claude-opus-5-5",
      anthropicAvailable: () => false,
      poolWaitSeconds: () => 1800,
      estimatedPromptTokens: 1000,
      apiKey: () => undefined,
      matchedTiers: () => ({ opus: "kimi-k3:cloud" }),
    });
    expect(decision).toEqual({ use: true, model: "kimi-k3:cloud", waitSeconds: 1800 });
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("fetchOllamaCatalog", () => {
  const tags = {
    models: [
      { name: "kimi-k3", size: 1560 * GB, capabilities: ["tools"] },
      { name: "deepseek-v4-pro:0813", size: 892 * GB, capabilities: ["tools"] },
      { name: 42 },
    ],
  };

  it("reads the cloud catalog for a local daemon and rewrites names", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(tags));
    const catalog = await fetchOllamaCatalog("http://127.0.0.1:11434", "secret", fetchImpl as unknown as typeof fetch);
    expect(fetchImpl.mock.calls[0][0]).toBe(OLLAMA_CLOUD_CATALOG_URL);
    // A local daemon's key is never sent to ollama.com.
    expect((fetchImpl.mock.calls[0][1] as RequestInit).headers).not.toHaveProperty("authorization");
    expect(catalog.map(m => m.name)).toEqual(["kimi-k3:cloud", "deepseek-v4-pro:0813-cloud"]);
  });

  it("uses the endpoint's own tags, with its key, for Ollama Cloud", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(tags));
    const catalog = await fetchOllamaCatalog("https://ollama.com", "secret", fetchImpl as unknown as typeof fetch);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://ollama.com/api/tags");
    expect((fetchImpl.mock.calls[0][1] as RequestInit).headers).toMatchObject({ authorization: "Bearer secret" });
    expect(catalog.map(m => m.name)).toEqual(["kimi-k3", "deepseek-v4-pro:0813"]);
  });

  it("returns empty on an error status or a network failure", async () => {
    expect(await fetchOllamaCatalog("http://127.0.0.1:11434", undefined,
      (async () => jsonResponse({}, 500)) as unknown as typeof fetch)).toEqual([]);
    expect(await fetchOllamaCatalog("http://127.0.0.1:11434", undefined,
      (async () => { throw new Error("down"); }) as unknown as typeof fetch)).toEqual([]);
  });
});

describe("fetchOllamaCandidates", () => {
  const GB_ = 1_000_000_000;
  const tags = { models: [
    { name: "big-model", size: 900 * GB_, capabilities: ["tools"] },
    { name: "small-window", size: 800 * GB_, capabilities: ["tools"] },
    { name: "configured", size: 400 * GB_, capabilities: ["tools"] },
  ] };
  const windows: Record<string, number> = {
    "configured:cloud": 1_048_576, "big-model:cloud": 1_048_576, "small-window:cloud": 262_144,
  };

  function showFetch(opts: { showFails?: boolean } = {}) {
    return vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/api/tags")) return jsonResponse(tags);
      if (opts.showFails) return jsonResponse({}, 500);
      const model = JSON.parse(String(init?.body)).model as string;
      return jsonResponse({ model_info: { "general.architecture": "x", "x.context_length": windows[model] ?? 0 } });
    });
  }

  it("drops a candidate whose window is smaller than the configured model's", async () => {
    const catalog = await fetchOllamaCandidates("http://127.0.0.1:11434", undefined, "configured:cloud",
      showFetch() as unknown as typeof fetch);
    expect(catalog.map(m => m.name)).toEqual(["big-model:cloud", "configured:cloud"]);
    // Filtered out rather than merely down-ranked, so it can never be matched.
    expect(matchOllamaTiers(catalog)).toEqual({ opus: "big-model:cloud", sonnet: "configured:cloud" });
  });

  it("keeps the whole catalog when the configured model's window cannot be read", async () => {
    const catalog = await fetchOllamaCandidates("http://127.0.0.1:11434", undefined, "configured:cloud",
      showFetch({ showFails: true }) as unknown as typeof fetch);
    expect(catalog.map(m => m.name)).toEqual(["big-model:cloud", "small-window:cloud", "configured:cloud"]);
  });
});

describe("fetchOpenAICodexModelCatalog", () => {
  const account = { id: "codex", provider: "openai_subscription", accessToken: "tok" } as OpenAISubscriptionAccount;

  it("keeps slug, priority and visibility, and drops malformed entries", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({
      models: [
        { slug: "gpt-6-astra", priority: 2, visibility: "list", description: "x" },
        { slug: "gpt-6-luna", priority: "5" },
        { priority: 1 },
      ],
    }));
    expect(await fetchOpenAICodexModelCatalog(account, fetchImpl as unknown as typeof fetch))
      .toEqual([{ slug: "gpt-6-astra", priority: 2, visibility: "list" }]);
    expect((fetchImpl.mock.calls[0][1] as RequestInit).headers).toMatchObject({ authorization: "Bearer tok" });
  });
});

describe("createTierDiscovery", () => {
  it("keeps the last good mapping when a later read fails, and reports only changes", async () => {
    let fail = false;
    const onChange = vi.fn();
    const discovery = createTierDiscovery({
      codexCatalog: async () => { if (fail) throw new Error("down"); return CODEX_CATALOG; },
      ollamaCatalog: async () => (fail ? [] : OLLAMA_CATALOG),
      onChange,
    });
    try {
      await discovery.refresh();
      await discovery.refresh();
      fail = true;
      await discovery.refresh();
      expect(discovery.openAI().frontier).toBe("gpt-6-astra");
      expect(discovery.openAI().opus).toBe("gpt-6.1-sol");
      expect(discovery.ollama().opus).toBe("kimi-k3:cloud");
      expect(onChange).toHaveBeenCalledTimes(2);
    } finally {
      discovery.stop();
    }
  });

  it("retries before the full interval while a provider still has no match", async () => {
    vi.useFakeTimers();
    let served = 0;
    const catalog = vi.fn(async () => { served++; return served === 1 ? [] : CODEX_CATALOG; });
    const discovery = createTierDiscovery({ codexCatalog: catalog, intervalMs: 6 * 60 * 60 * 1000 });
    try {
      await discovery.refresh();
      expect(discovery.openAI()).toEqual({});
      // A catalog that was down at boot must not wait six hours to be retried.
      await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
      expect(discovery.openAI().frontier).toBe("gpt-6-astra");
      expect(discovery.openAI().opus).toBe("gpt-6.1-sol");
      // Once matched, the short tick no longer re-reads it.
      await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
      expect(catalog).toHaveBeenCalledTimes(2);
    } finally {
      discovery.stop();
      vi.useRealTimers();
    }
  });

  it("matches nothing for a provider that is switched off", async () => {
    const discovery = createTierDiscovery({ ollamaCatalog: async () => OLLAMA_CATALOG });
    try {
      await discovery.refresh();
      expect(discovery.openAI()).toEqual({});
      expect(discovery.ollama().opus).toBe("kimi-k3:cloud");
    } finally {
      discovery.stop();
    }
  });
});
