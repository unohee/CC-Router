import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import express from "express";
import {
  mountMessagesCrossProviderRoute,
  type MessagesCrossProviderRouteOptions,
} from "../proxy/messages-cross-route.js";
import { resolveOllamaFallbackConfig } from "../providers/ollama/fallback-policy.js";
import type { OpenAIResponsesRequest } from "../protocol/openai-responses-types.js";

const account = {
  id: "codex", provider: "openai_subscription" as const,
  accessToken: "fixture", refreshToken: "fixture",
  expiresAt: Date.now() + 3_600_000, enabled: true,
};
const modelRouting = {
  openAIDefaultModel: "gpt-6.1-sol",
  openAIReasoningEffort: "medium",
};

function codexResponse(): Response {
  return Response.json({
    id: "codex-reply", model: "gpt-6.1-sol",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "from codex" }] }],
    usage: { input_tokens: 2, output_tokens: 2 },
  });
}

async function withRouter(
  overrides: Partial<MessagesCrossProviderRouteOptions>,
  run: (send: (model: string, effort?: string) => Promise<Response>) => Promise<void>,
) {
  const app = express();
  mountMessagesCrossProviderRoute(app, {
    modelRouting,
    crossProviderFallback: true,
    hasAvailableAnthropicAccount: () => false,
    getOpenAIAccount: () => account,
    forwardOpenAI: async () => codexResponse(),
    ...overrides,
  });
  app.post("/v1/messages", (_req, res) => res.json({ source: "anthropic" }));
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  try {
    await run((model, effort) => fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-claude-code-session-id": "fallback-test" },
      body: JSON.stringify({
        model, messages: [{ role: "user", content: "hi" }],
        ...(effort ? { output_config: { effort } } : {}),
      }),
    }));
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
}

describe("Codex first fallback with a fixed effort", () => {
  it("uses the configured model and medium for every Claude tier, overriding or supplying effort", async () => {
    const bodies: OpenAIResponsesRequest[] = [];
    await withRouter({ forwardOpenAI: async ({ body }) => { bodies.push(body); return codexResponse(); } }, async send => {
      for (const model of ["claude-opus-5", "claude-sonnet-4-6", "claude-haiku-4-5"]) {
        for (const effort of [undefined, "xhigh"]) {
          const response = await send(model, effort);
          expect(response.status).toBe(200);
          expect((await response.json()).model).toBe(model);
        }
      }
    });
    expect(bodies).toHaveLength(6);
    for (const body of bodies) {
      expect(body.model).toBe("gpt-6.1-sol");
      expect(body.reasoning).toEqual({ effort: "medium" });
    }
  });

  it("applies the override to an OpenAI-pinned Claude session but preserves explicit OpenAI effort", async () => {
    const bodies: OpenAIResponsesRequest[] = [];
    await withRouter({
      resolveSessionTarget: () => ({ provider: "openai", accountId: "codex" }),
      forwardOpenAI: async ({ body }) => { bodies.push(body); return codexResponse(); },
    }, async send => {
      await (await send("claude-opus-5", "xhigh")).json();
      await (await send("openai/gpt-6.1-sol", "xhigh")).json();
    });
    expect(bodies.map(body => body.reasoning)).toEqual([{ effort: "medium" }, { effort: "xhigh" }]);
  });

  it("keeps the request on Claude while its pool is available", async () => {
    const forwardOpenAI = vi.fn(async () => codexResponse());
    await withRouter({ hasAvailableAnthropicAccount: () => true, forwardOpenAI }, async send => {
      expect(await (await send("claude-opus-5", "xhigh")).json()).toEqual({ source: "anthropic" });
    });
    expect(forwardOpenAI).not.toHaveBeenCalled();
  });

  it("tries Codex before Ollama, and only reaches Ollama after Codex refuses", async () => {
    const order: string[] = [];
    const config = resolveOllamaFallbackConfig({ enabled: true, model: "cloud-model", minWaitSeconds: 0 });
    if (!config) throw new Error("fixture config disabled");
    let codexLimited = false;
    await withRouter({
      forwardOpenAI: async ({ body }) => {
        order.push("codex");
        expect(body.reasoning).toEqual({ effort: "medium" });
        return codexLimited ? new Response("limited", { status: 429 }) : codexResponse();
      },
      ollamaFallback: {
        config, poolWaitSeconds: () => 3600, apiKey: () => "fixture", timeoutMs: 1000,
        fetchImpl: async (_url, init) => {
          order.push("ollama");
          const body = JSON.parse(String(init?.body));
          expect(body.model).toBe("cloud-model");
          // A failed Codex attempt must not mutate the original Claude request.
          expect(body.output_config?.effort).toBe("xhigh");
          return Response.json({
            id: "ollama-reply", type: "message", role: "assistant", model: "cloud-model",
            content: [{ type: "text", text: "from ollama" }],
            stop_reason: "end_turn", usage: { input_tokens: 2, output_tokens: 2 },
          });
        },
      },
    }, async send => {
      expect((await (await send("claude-opus-5", "xhigh")).json()).content[0].text).toBe("from codex");
      expect(order).toEqual(["codex"]);
      codexLimited = true;
      expect((await (await send("claude-opus-5", "xhigh")).json()).content[0].text).toBe("from ollama");
      expect(order).toEqual(["codex", "codex", "ollama"]);
    });
  });
});
