import { describe, expect, it, vi } from "vitest";
import { createServer } from "http";
import express from "express";
import { ReadableStream } from "stream/web";
import { mountMessagesCrossProviderRoute } from "../proxy/messages-cross-route.js";
import type { OpenAIResponsesRequest } from "../protocol/openai-responses-types.js";

describe("mountMessagesCrossProviderRoute", () => {
  it("translates Claude Code openai/* messages into Responses and returns Anthropic-shaped JSON", async () => {
    const forwardedBodies: OpenAIResponsesRequest[] = [];
    const app = express();

    mountMessagesCrossProviderRoute(app, {
      getOpenAIAccount: () => ({
        id: "openai-victor",
        provider: "openai_subscription",
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: Date.now() + 60 * 60 * 1000,
        enabled: true,
      }),
      forwardOpenAI: async ({ body }) => {
        forwardedBodies.push(body);
        return new Response(JSON.stringify({
          id: "resp_1",
          model: "gpt-5.5",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Done." }],
            },
          ],
          usage: { input_tokens: 4, output_tokens: 2 },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");

    try {
      const res = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "openai/gpt-5.5",
          max_tokens: 128,
          messages: [{ role: "user", content: "hi" }],
          stream: false,
        }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        id: "resp_1",
        type: "message",
        role: "assistant",
        model: "gpt-5.5",
        content: [{ type: "text", text: "Done." }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 4, output_tokens: 2 },
      });
      expect(forwardedBodies).toEqual([
        {
          model: "gpt-5.5",
          input: [
            { role: "user", content: [{ type: "input_text", text: "hi" }] },
          ],
          max_output_tokens: 128,
          stream: false,
        },
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(err => err ? reject(err) : resolve());
      });
    }
  });

  it("applies configured OpenAI aliases when Claude Code cross-routes to OpenAI", async () => {
    const forwardedBodies: OpenAIResponsesRequest[] = [];
    const app = express();

    mountMessagesCrossProviderRoute(app, {
      modelRouting: { openAIAliases: { codex: "gpt-5-codex" } },
      getOpenAIAccount: () => ({
        id: "openai-victor",
        provider: "openai_subscription",
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: Date.now() + 60 * 60 * 1000,
        enabled: true,
      }),
      forwardOpenAI: async ({ body }) => {
        forwardedBodies.push(body);
        return new Response(JSON.stringify({
          id: "resp_1",
          model: "gpt-5-codex",
          output: [],
          usage: {},
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");

    try {
      const res = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "openai/codex",
          max_tokens: 128,
          messages: [{ role: "user", content: "hi" }],
        }),
      });

      expect(res.status).toBe(200);
      expect(forwardedBodies[0].model).toBe("gpt-5-codex");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(err => err ? reject(err) : resolve());
      });
    }
  });

  it("refreshes the selected OpenAI account before Claude Code cross-routing", async () => {
    const prepare = vi.fn().mockResolvedValue(true);
    const forward = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "resp_1",
      model: "gpt-5.5",
      output: [],
      usage: {},
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const app = express();

    mountMessagesCrossProviderRoute(app, {
      getOpenAIAccount: () => ({
        id: "openai-victor",
        provider: "openai_subscription",
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: Date.now() + 60_000,
        enabled: true,
      }),
      prepareOpenAIAccount: prepare,
      forwardOpenAI: forward,
    });

    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");

    try {
      const res = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "openai/gpt-5.5",
          messages: [{ role: "user", content: "hi" }],
        }),
      });

      expect(res.status).toBe(200);
      expect(prepare).toHaveBeenCalledOnce();
      expect(forward).toHaveBeenCalledOnce();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(err => err ? reject(err) : resolve());
      });
    }
  });

  it("collapses OpenAI Responses SSE into Anthropic-shaped JSON for non-stream messages", async () => {
    const app = express();

    mountMessagesCrossProviderRoute(app, {
      getOpenAIAccount: () => ({
        id: "openai-victor",
        provider: "openai_subscription",
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: Date.now() + 60 * 60 * 1000,
        enabled: true,
      }),
      forwardOpenAI: async () => new Response(
        new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode("data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_1\",\"model\":\"gpt-5.4-mini\"}}\n\n"));
            controller.enqueue(encoder.encode("data: {\"type\":\"response.output_text.delta\",\"delta\":\"Done.\"}\n\n"));
            controller.enqueue(encoder.encode("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"model\":\"gpt-5.4-mini\",\"usage\":{\"input_tokens\":4,\"output_tokens\":2}}}\n\n"));
            controller.close();
          },
        }) as BodyInit,
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      ),
    });

    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");

    try {
      const res = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "openai/gpt-5.4-mini",
          max_tokens: 128,
          messages: [{ role: "user", content: "hi" }],
          stream: false,
        }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toEqual({
        id: "resp_1",
        type: "message",
        role: "assistant",
        model: "gpt-5.4-mini",
        content: [{ type: "text", text: "Done." }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 4, output_tokens: 2 },
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(err => err ? reject(err) : resolve());
      });
    }
  });

  it("collapses a function-call SSE into tool_use blocks, preserving model ordering", async () => {
    const app = express();
    const sse = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;

    mountMessagesCrossProviderRoute(app, {
      getOpenAIAccount: () => ({
        id: "openai-victor",
        provider: "openai_subscription",
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: Date.now() + 60 * 60 * 1000,
        enabled: true,
      }),
      forwardOpenAI: async () => new Response(
        new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            const push = (event: unknown) => controller.enqueue(encoder.encode(sse(event)));
            push({ type: "response.created", response: { id: "resp_1", model: "gpt-5.6-terra" } });
            push({ type: "response.output_text.delta", output_index: 0, delta: "Checking." });
            push({ type: "response.output_item.done", output_index: 0, item: { type: "message" } });
            push({
              type: "response.output_item.added",
              output_index: 1,
              item: { type: "function_call", call_id: "call_1", name: "get_weather", arguments: "" },
            });
            push({ type: "response.function_call_arguments.delta", output_index: 1, delta: "{\"city\":\"Seoul\"}" });
            push({
              type: "response.output_item.done",
              output_index: 1,
              item: { type: "function_call", call_id: "call_1", name: "get_weather", arguments: "{\"city\":\"Seoul\"}" },
            });
            push({ type: "response.completed", response: { id: "resp_1", model: "gpt-5.6-terra", usage: { input_tokens: 63, output_tokens: 19 } } });
            controller.close();
          },
        }) as BodyInit,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    });

    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");

    try {
      const res = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "openai/gpt-5.6-terra",
          max_tokens: 128,
          messages: [{ role: "user", content: "weather?" }],
          stream: false,
        }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        id: "resp_1",
        type: "message",
        role: "assistant",
        model: "gpt-5.6-terra",
        content: [
          { type: "text", text: "Checking." },
          { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Seoul" } },
        ],
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 63, output_tokens: 19 },
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(err => err ? reject(err) : resolve());
      });
    }
  });

  it("streams a function call back as Anthropic tool_use SSE events", async () => {
    const app = express();
    const sse = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;

    mountMessagesCrossProviderRoute(app, {
      getOpenAIAccount: () => ({
        id: "openai-victor",
        provider: "openai_subscription",
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: Date.now() + 60 * 60 * 1000,
        enabled: true,
      }),
      forwardOpenAI: async () => new Response(
        new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            const push = (event: unknown) => controller.enqueue(encoder.encode(sse(event)));
            push({ type: "response.created", response: { id: "resp_1", model: "gpt-5.6-terra" } });
            push({
              type: "response.output_item.added",
              output_index: 0,
              item: { type: "function_call", call_id: "call_1", name: "get_weather", arguments: "" },
            });
            push({ type: "response.function_call_arguments.delta", output_index: 0, delta: "{\"city\":\"Seoul\"}" });
            push({
              type: "response.output_item.done",
              output_index: 0,
              item: { type: "function_call", call_id: "call_1", name: "get_weather", arguments: "{\"city\":\"Seoul\"}" },
            });
            push({ type: "response.completed", response: { id: "resp_1", usage: { output_tokens: 19 } } });
            controller.close();
          },
        }) as BodyInit,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    });

    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");

    try {
      const res = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "openai/gpt-5.6-terra",
          max_tokens: 128,
          messages: [{ role: "user", content: "weather?" }],
          stream: true,
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.text();
      const payloads = body
        .split("\n")
        .filter(line => line.startsWith("data: "))
        .map(line => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>);

      expect(payloads.find(p => p.type === "content_block_start")).toEqual({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "call_1", name: "get_weather", input: {} },
      });
      expect(payloads.find(p => p.type === "content_block_delta")).toEqual({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "{\"city\":\"Seoul\"}" },
      });
      expect(payloads.find(p => p.type === "message_delta")).toMatchObject({
        delta: { stop_reason: "tool_use" },
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(err => err ? reject(err) : resolve());
      });
    }
  });

  it("streams OpenAI Responses SSE back as Anthropic Messages SSE", async () => {
    const app = express();

    mountMessagesCrossProviderRoute(app, {
      getOpenAIAccount: () => ({
        id: "openai-victor",
        provider: "openai_subscription",
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: Date.now() + 60 * 60 * 1000,
        enabled: true,
      }),
      forwardOpenAI: async () => new Response(
        new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode("data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_1\",\"model\":\"gpt-5.5\"}}\n\n"));
            controller.enqueue(encoder.encode("data: {\"type\":\"response.output_text.delta\",\"delta\":\"Hi\"}\n\n"));
            controller.enqueue(encoder.encode("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"model\":\"gpt-5.5\",\"usage\":{\"input_tokens\":3,\"output_tokens\":1}}}\n\n"));
            controller.close();
          },
        }) as BodyInit,
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      ),
    });

    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");

    try {
      const res = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "openai/gpt-5.5",
          max_tokens: 128,
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const text = await res.text();
      expect(text).toContain("data: {\"type\":\"message_start\"");
      expect(text).toContain("data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hi\"}}");
      expect(text).toContain("data: {\"type\":\"message_stop\"}");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(err => err ? reject(err) : resolve());
      });
    }
  });

  it("forwards a non-2xx OpenAI status as-is for explicit openai/* routing (not fallback)", async () => {
    const app = express();

    mountMessagesCrossProviderRoute(app, {
      getOpenAIAccount: () => ({
        id: "openai-victor",
        provider: "openai_subscription",
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: Date.now() + 60 * 60 * 1000,
        enabled: true,
      }),
      forwardOpenAI: async () => new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
    });

    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");

    try {
      const res = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "openai/gpt-5.5",
          messages: [{ role: "user", content: "hi" }],
        }),
      });

      // 429 has no JSON body translator branch of its own — openAIResponseToAnthropicMessage
      // still runs on whatever JSON came back, but the status code itself must pass through.
      expect(res.status).toBe(429);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(err => err ? reject(err) : resolve());
      });
    }
  });

  it("returns 502 for explicit openai/* routing when the OpenAI request itself throws", async () => {
    const app = express();

    mountMessagesCrossProviderRoute(app, {
      getOpenAIAccount: () => ({
        id: "openai-victor",
        provider: "openai_subscription",
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: Date.now() + 60 * 60 * 1000,
        enabled: true,
      }),
      forwardOpenAI: async () => { throw new Error("network unreachable"); },
    });

    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");

    try {
      const res = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "openai/gpt-5.5",
          messages: [{ role: "user", content: "hi" }],
        }),
      });

      expect(res.status).toBe(502);
      expect((await res.json()).error.type).toBe("api_error");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(err => err ? reject(err) : resolve());
      });
    }
  });

  it("passes non-openai models to later Anthropic proxy middleware with replayable raw body", async () => {
    const app = express();
    const nextSpy = vi.fn();

    mountMessagesCrossProviderRoute(app, {
      getOpenAIAccount: () => null,
      forwardOpenAI: async () => new Response("unused"),
    });
    app.use("/v1/messages", (req, res) => {
      nextSpy();
      res.json({
        rawBody: req._ccRawBody?.toString("utf8"),
      });
    });

    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");

    try {
      const body = {
        model: "claude/sonnet",
        messages: [{ role: "user", content: "hi" }],
      };
      const res = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ rawBody: JSON.stringify(body) });
      expect(nextSpy).toHaveBeenCalledOnce();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(err => err ? reject(err) : resolve());
      });
    }
  });

  it("reports an explicit openai/* request so it is not invisible in logs", async () => {
    const onExplicitRoute = vi.fn();
    const app = express();

    mountMessagesCrossProviderRoute(app, {
      getOpenAIAccount: () => ({
        id: "codex", provider: "openai_subscription", accessToken: "a",
        refreshToken: "r", expiresAt: Date.now() + 3_600_000, enabled: true,
      }),
      modelRouting: { openAIAliases: { fast: "gpt-5.6-luna" } },
      onExplicitRoute,
      forwardOpenAI: async () => new Response(JSON.stringify({
        id: "r", model: "gpt-5.6-luna",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
        usage: {},
      }), { status: 200, headers: { "content-type": "application/json" } }),
    });

    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");

    try {
      await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "openai/fast", max_tokens: 8,
          messages: [{ role: "user", content: "hi" }], stream: false,
        }),
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(err => err ? reject(err) : resolve());
      });
    }

    // The alias is reported resolved, matching what actually went upstream.
    expect(onExplicitRoute).toHaveBeenCalledWith(expect.objectContaining({
      openAIAccountId: "codex",
      upstreamModel: "gpt-5.6-luna",
      usage: { input_tokens: 0, output_tokens: 0 },
      method: "POST",
      path: "/v1/messages",
      statusCode: 200,
      source: "api",
    }));
    expect(onExplicitRoute.mock.calls[0]?.[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("degrades to Anthropic when a 200 stream carries an upstream rejection", async () => {
    // Codex reports an over-long context as response.failed inside a 200
    // stream. Treating that as success would hand the client an empty message.
    const sse = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
    const nextSpy = vi.fn();
    const app = express();

    mountMessagesCrossProviderRoute(app, {
      getOpenAIAccount: () => ({
        id: "codex", provider: "openai_subscription", accessToken: "a",
        refreshToken: "r", expiresAt: Date.now() + 3_600_000, enabled: true,
      }),
      modelRouting: { openAIDefaultModel: "gpt-5.6-terra" },
      crossProviderFallback: true,
      hasAvailableAnthropicAccount: () => false,
      forwardOpenAI: async () => new Response(
        new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode(sse({ type: "response.created", response: { id: "r" } })));
            controller.enqueue(encoder.encode(sse({
              type: "response.failed",
              response: { id: "r", error: { message: "Your input exceeds the context window of this model." } },
            })));
            controller.close();
          },
        }) as BodyInit,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    });
    app.use((_req, _res, next) => { nextSpy(); next(); });
    app.use((_req, res) => res.status(200).json({ servedBy: "anthropic" }));

    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");

    try {
      const res = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-5", max_tokens: 8,
          messages: [{ role: "user", content: "hi" }], stream: true,
        }),
      });

      expect(await res.json()).toEqual({ servedBy: "anthropic" });
      expect(nextSpy).toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(err => err ? reject(err) : resolve());
      });
    }
  });

  describe("session affinity", () => {
    const openAIAccount = {
      id: "openai-victor",
      provider: "openai_subscription" as const,
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: Date.now() + 60 * 60 * 1000,
      enabled: true,
    };

    async function withServer(app: express.Express, fn: (url: string) => Promise<void>) {
      const server = createServer(app);
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");
      try {
        await fn(`http://127.0.0.1:${address.port}`);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close(err => err ? reject(err) : resolve());
        });
      }
    }

    it("routes a Claude-model request to OpenAI when the session is pinned there", async () => {
      const app = express();
      const forwarded: OpenAIResponsesRequest[] = [];
      const onSessionRoute = vi.fn();

      mountMessagesCrossProviderRoute(app, {
        getOpenAIAccount: () => openAIAccount,
        modelRouting: { openAIDefaultModel: "gpt-5.6-terra" },
        resolveSessionTarget: () => ({ provider: "openai", accountId: "openai-victor" }),
        onSessionRoute,
        forwardOpenAI: async ({ body }) => {
          forwarded.push(body);
          return new Response(JSON.stringify({
            id: "resp_1", model: "gpt-5.6-terra",
            output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] }],
            usage: { input_tokens: 4, output_tokens: 1 },
          }), { status: 200, headers: { "content-type": "application/json" } });
        },
      });

      await withServer(app, async (url) => {
        const res = await fetch(`${url}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-claude-code-session-id": "sess-1" },
          body: JSON.stringify({
            model: "claude-sonnet-5",        // a Claude model, not openai/*
            max_tokens: 128,
            messages: [{ role: "user", content: "hi" }],
            stream: false,
          }),
        });

        expect(res.status).toBe(200);
        // The pinned session resolved "openai/default" to the configured model.
        expect(forwarded[0]?.model).toBe("gpt-5.6-terra");
      });

      expect(onSessionRoute).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: "sess-1",
        openAIAccountId: "openai-victor",
        upstreamModel: "gpt-5.6-terra",
        usage: { input_tokens: 4, output_tokens: 1 },
        method: "POST",
        path: "/v1/messages",
        statusCode: 200,
        source: "cli",
      }));
      expect(onSessionRoute.mock.calls[0]?.[0].durationMs).toBeGreaterThanOrEqual(0);
    });

    it("sends a pinned session to its own OpenAI account instead of the next in rotation", async () => {
      const app = express();
      const second = { ...openAIAccount, id: "openai-second" };
      const accounts = [openAIAccount, second];
      const used: string[] = [];
      let rotation = 0;

      mountMessagesCrossProviderRoute(app, {
        // Mirrors the real picker: a preferred id wins, otherwise rotate.
        getOpenAIAccount: (preferredAccountId?: string) => {
          if (preferredAccountId) return accounts.find(a => a.id === preferredAccountId) ?? null;
          return accounts[rotation++ % accounts.length];
        },
        modelRouting: { openAIDefaultModel: "gpt-5.6-terra" },
        resolveSessionTarget: () => ({ provider: "openai", accountId: "openai-second" }),
        forwardOpenAI: async ({ account }) => {
          used.push(account.id);
          return new Response(JSON.stringify({
            id: "resp_1", model: "gpt-5.6-terra",
            output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
            usage: { input_tokens: 1, output_tokens: 1 },
          }), { status: 200, headers: { "content-type": "application/json" } });
        },
      });

      await withServer(app, async (url) => {
        for (let i = 0; i < 2; i++) {
          await fetch(`${url}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-claude-code-session-id": "sess-pinned" },
            body: JSON.stringify({
              model: "claude-sonnet-5", max_tokens: 8,
              messages: [{ role: "user", content: "hi" }], stream: false,
            }),
          });
        }
      });

      // Rotation would have produced [openai-victor, openai-second].
      expect(used).toEqual(["openai-second", "openai-second"]);
    });

    it("keeps an explicit openai/* request on the account its session is already pinned to", async () => {
      const app = express();
      const second = { ...openAIAccount, id: "openai-second" };
      const accounts = [openAIAccount, second];
      const used: string[] = [];
      const resolveSessionTarget = vi.fn();
      let rotation = 0;

      mountMessagesCrossProviderRoute(app, {
        getOpenAIAccount: (preferredAccountId?: string) => {
          if (preferredAccountId) return accounts.find(a => a.id === preferredAccountId) ?? null;
          return accounts[rotation++ % accounts.length];
        },
        modelRouting: { openAIDefaultModel: "gpt-5.6-terra" },
        peekSessionTarget: () => ({ provider: "openai", accountId: "openai-second" }),
        resolveSessionTarget,
        forwardOpenAI: async ({ account }) => {
          used.push(account.id);
          return new Response(JSON.stringify({
            id: "r", model: "gpt-5.6-terra",
            output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
            usage: { input_tokens: 1, output_tokens: 1 },
          }), { status: 200, headers: { "content-type": "application/json" } });
        },
      });

      await withServer(app, async (url) => {
        for (let i = 0; i < 2; i++) {
          await fetch(`${url}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-claude-code-session-id": "sess-x" },
            body: JSON.stringify({
              model: "openai/gpt-5.6-terra", max_tokens: 8,
              messages: [{ role: "user", content: "hi" }], stream: false,
            }),
          });
        }
      });

      expect(used).toEqual(["openai-second", "openai-second"]);
      // Peeking must not create an assignment. This is a deliberate trade-off:
      // an unassigned session calling openai/* keeps plain picker rotation
      // (so with 2+ OpenAI accounts those calls are not account-affine), but in
      // exchange one explicit call never silently commits the session — and
      // therefore its later Claude-model requests — to OpenAI. Diverting a
      // whole conversation on the strength of a single explicit call is the
      // worse surprise of the two.
      expect(resolveSessionTarget).not.toHaveBeenCalled();
    });

    it("echoes the requested Claude model in responses served by OpenAI", async () => {
      // Claude Code treats "gpt-5.6-*" as an unrecognised model and clamps its
      // assumed context window to 200k, which sends long sessions into
      // autocompact thrashing. The proxy therefore reports the model the
      // client asked for; the upstream model stays visible in logs/dashboard.
      const app = express();
      mountMessagesCrossProviderRoute(app, {
        getOpenAIAccount: () => openAIAccount,
        modelRouting: { openAIDefaultModel: "gpt-5.6-terra" },
        resolveSessionTarget: () => ({ provider: "openai", accountId: "openai-victor" }),
        forwardOpenAI: async () => new Response(JSON.stringify({
          id: "resp_1", model: "gpt-5.6-terra",
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] }],
          usage: { input_tokens: 40, output_tokens: 2 },
        }), { status: 200, headers: { "content-type": "application/json" } }),
      });

      await withServer(app, async (url) => {
        const res = await fetch(`${url}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-claude-code-session-id": "sess-echo" },
          body: JSON.stringify({
            model: "claude-sonnet-5", max_tokens: 8,
            messages: [{ role: "user", content: "hi" }], stream: false,
          }),
        });
        const body = await res.json() as { model: string; usage: { input_tokens: number } };

        expect(body.model).toBe("claude-sonnet-5");
        expect(body.usage.input_tokens).toBe(40);
      });
    });

    it("streams the requested Claude model and honest usage back for a pinned session", async () => {
      const sse = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
      const app = express();
      mountMessagesCrossProviderRoute(app, {
        getOpenAIAccount: () => openAIAccount,
        modelRouting: { openAIDefaultModel: "gpt-5.6-terra" },
        resolveSessionTarget: () => ({ provider: "openai", accountId: "openai-victor" }),
        forwardOpenAI: async () => new Response(
          new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder();
              const push = (event: unknown) => controller.enqueue(encoder.encode(sse(event)));
              push({ type: "response.created", response: { id: "r", model: "gpt-5.6-terra" } });
              push({ type: "response.output_text.delta", output_index: 0, delta: "hi" });
              push({ type: "response.completed", response: { id: "r", usage: { input_tokens: 55, output_tokens: 3 } } });
              controller.close();
            },
          }) as BodyInit,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      });

      await withServer(app, async (url) => {
        const res = await fetch(`${url}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-claude-code-session-id": "sess-echo-s" },
          body: JSON.stringify({
            model: "claude-sonnet-5", max_tokens: 8,
            messages: [{ role: "user", content: "hi" }], stream: true,
          }),
        });
        const text = await res.text();
        const events = text.split("\n").filter(l => l.startsWith("data: "))
          .map(l => JSON.parse(l.slice(6)) as Record<string, any>);

        expect(events.find(e => e.type === "message_start")?.message.model).toBe("claude-sonnet-5");
        expect(events.find(e => e.type === "message_delta")?.usage).toEqual({ input_tokens: 55, output_tokens: 3 });
      });
    });

    it("does not rename the model on an explicit openai/* request", async () => {
      const app = express();
      mountMessagesCrossProviderRoute(app, {
        getOpenAIAccount: () => openAIAccount,
        modelRouting: {},
        forwardOpenAI: async () => new Response(JSON.stringify({
          id: "r", model: "gpt-5.6-luna",
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
          usage: {},
        }), { status: 200, headers: { "content-type": "application/json" } }),
      });

      await withServer(app, async (url) => {
        const res = await fetch(`${url}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "openai/gpt-5.6-luna", max_tokens: 8,
            messages: [{ role: "user", content: "hi" }], stream: false,
          }),
        });

        // The caller named the OpenAI model on purpose — reporting it back is
        // accurate, not a compatibility hazard.
        expect(((await res.json()) as { model: string }).model).toBe("gpt-5.6-luna");
      });
    });

    it("passes through to the Anthropic proxy when the session is pinned to Anthropic", async () => {
      const app = express();
      const forwardOpenAI = vi.fn();

      mountMessagesCrossProviderRoute(app, {
        getOpenAIAccount: () => openAIAccount,
        modelRouting: { openAIDefaultModel: "gpt-5.6-terra" },
        resolveSessionTarget: () => ({ provider: "anthropic", accountId: "intrect" }),
        forwardOpenAI,
      });
      app.use((req, res) => {
        // Stand-in for the downstream Anthropic proxy — assert the pin was stashed.
        res.status(200).json({ pinned: req._ccSessionTarget });
      });

      await withServer(app, async (url) => {
        const res = await fetch(`${url}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-claude-code-session-id": "sess-2" },
          body: JSON.stringify({
            model: "claude-sonnet-5", max_tokens: 128,
            messages: [{ role: "user", content: "hi" }], stream: false,
          }),
        });

        expect(await res.json()).toEqual({ pinned: { provider: "anthropic", accountId: "intrect" } });
        expect(forwardOpenAI).not.toHaveBeenCalled();
      });
    });

    it("does not resolve a session target when the request carries no session header", async () => {
      const app = express();
      const resolveSessionTarget = vi.fn();

      mountMessagesCrossProviderRoute(app, {
        getOpenAIAccount: () => openAIAccount,
        modelRouting: { openAIDefaultModel: "gpt-5.6-terra" },
        resolveSessionTarget,
      });
      app.use((_req, res) => res.status(200).json({ ok: true }));

      await withServer(app, async (url) => {
        await fetch(`${url}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "claude-sonnet-5", max_tokens: 128,
            messages: [{ role: "user", content: "hi" }], stream: false,
          }),
        });

        expect(resolveSessionTarget).not.toHaveBeenCalled();
      });
    });
  });

  describe("cross-provider fallback", () => {
    async function withServer(
      app: express.Express,
      run: (baseUrl: string) => Promise<void>,
    ): Promise<void> {
      const server = createServer(app);
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");
      try {
        await run(`http://127.0.0.1:${address.port}`);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close(err => err ? reject(err) : resolve());
        });
      }
    }

    function jsonOpenAIResponse(text: string) {
      return async () => new Response(JSON.stringify({
        id: "resp_fallback",
        model: "gpt-5-codex",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }

    it("does NOT fall back when crossProviderFallback is disabled, even if Anthropic is exhausted", async () => {
      const app = express();
      const nextSpy = vi.fn();
      const getOpenAIAccount = vi.fn(() => null);

      mountMessagesCrossProviderRoute(app, {
        getOpenAIAccount,
        forwardOpenAI: async () => new Response("unused"),
        hasAvailableAnthropicAccount: () => false,
        modelRouting: { openAIDefaultModel: "gpt-5-codex" },
        // crossProviderFallback intentionally omitted — default off
      });
      app.use("/v1/messages", (req, res) => { nextSpy(); res.json({ ok: true }); });

      await withServer(app, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: "hi" }] }),
        });
        expect(res.status).toBe(200);
        expect(nextSpy).toHaveBeenCalledOnce();
        expect(getOpenAIAccount).not.toHaveBeenCalled();
      });
    });

    it("preserves the request's tier when routing to OpenAI", async () => {
      const seen: Array<{ requested: string; sent: string }> = [];
      const app = express();

      mountMessagesCrossProviderRoute(app, {
        getOpenAIAccount: () => ({
          id: "codex", provider: "openai_subscription", accessToken: "a",
          refreshToken: "r", expiresAt: Date.now() + 3_600_000, enabled: true,
        }),
        modelRouting: {
          openAIDefaultModel: "gpt-5-codex",
          openAITierMap: { opus: "gpt-5.6-sol", sonnet: "gpt-5.6-terra", haiku: "gpt-5.6-luna" },
        },
        crossProviderFallback: true,
        hasAvailableAnthropicAccount: () => false,
        forwardOpenAI: async ({ body }) => {
          seen.push({ requested: "", sent: body.model });
          return new Response(JSON.stringify({
            id: "r", model: body.model,
            output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
            usage: {},
          }), { status: 200, headers: { "content-type": "application/json" } });
        },
      });

      const server = createServer(app);
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");

      try {
        for (const model of ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"]) {
          await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: "user", content: "hi" }] }),
          });
        }
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close(err => err ? reject(err) : resolve());
        });
      }

      // Each tier keeps its own counterpart instead of collapsing onto one model.
      expect(seen.map(s => s.sent)).toEqual(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
    });

    it("falls back to the configured default model when the Claude model has no known tier", async () => {
      const app = express();
      const nextSpy = vi.fn();
      const forwardedBodies: OpenAIResponsesRequest[] = [];
      const onFallback = vi.fn();

      mountMessagesCrossProviderRoute(app, {
        crossProviderFallback: true,
        hasAvailableAnthropicAccount: () => false,
        modelRouting: { openAIDefaultModel: "gpt-5-codex" },
        getOpenAIAccount: () => ({
          id: "codex",
          provider: "openai_subscription",
          accessToken: "access",
          refreshToken: "refresh",
          expiresAt: Date.now() + 60 * 60 * 1000,
          enabled: true,
        }),
        forwardOpenAI: async ({ body }) => {
          forwardedBodies.push(body);
          return jsonOpenAIResponse("Done.")();
        },
        onFallback,
      });
      app.use("/v1/messages", (req, res) => { nextSpy(); res.json({ ok: true }); });

      await withServer(app, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          // Not a recognised family word, so no tier can be inferred.
          body: JSON.stringify({ model: "claude-instant-1", max_tokens: 64, messages: [{ role: "user", content: "hi" }] }),
        });
        expect(res.status).toBe(200);
        expect(forwardedBodies[0]?.model).toBe("gpt-5-codex");
        expect(nextSpy).not.toHaveBeenCalled();
        expect(onFallback).toHaveBeenCalledWith(expect.objectContaining({
          openAIAccountId: "codex",
          upstreamModel: "gpt-5-codex",
          usage: { input_tokens: 1, output_tokens: 1 },
          method: "POST",
          path: "/v1/messages",
          statusCode: 200,
          source: "api",
        }));
        expect(onFallback.mock.calls[0]?.[0].durationMs).toBeGreaterThanOrEqual(0);
      });
    });

    it("falls through to next() (no error) when Anthropic is exhausted and no OpenAI account is available", async () => {
      const app = express();
      const nextSpy = vi.fn();

      mountMessagesCrossProviderRoute(app, {
        crossProviderFallback: true,
        hasAvailableAnthropicAccount: () => false,
        modelRouting: { openAIDefaultModel: "gpt-5-codex" },
        getOpenAIAccount: () => null,
        forwardOpenAI: async () => new Response("unused"),
      });
      app.use("/v1/messages", (req, res) => { nextSpy(); res.status(200).json({ degraded: true }); });

      await withServer(app, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: "hi" }] }),
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ degraded: true });
        expect(nextSpy).toHaveBeenCalledOnce();
      });
    });

    it("falls through to next() (no error) when the OpenAI account fails to prepare/refresh", async () => {
      const app = express();
      const nextSpy = vi.fn();

      mountMessagesCrossProviderRoute(app, {
        crossProviderFallback: true,
        hasAvailableAnthropicAccount: () => false,
        modelRouting: { openAIDefaultModel: "gpt-5-codex" },
        getOpenAIAccount: () => ({
          id: "codex",
          provider: "openai_subscription",
          accessToken: "access",
          refreshToken: "refresh",
          expiresAt: Date.now() + 60 * 60 * 1000,
          enabled: true,
        }),
        prepareOpenAIAccount: async () => false,
        forwardOpenAI: async () => new Response("unused"),
      });
      app.use("/v1/messages", (req, res) => { nextSpy(); res.status(200).json({ degraded: true }); });

      await withServer(app, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: "hi" }] }),
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ degraded: true });
        expect(nextSpy).toHaveBeenCalledOnce();
      });
    });

    it("falls through without calling getOpenAIAccount when no OpenAI default model is configured", async () => {
      const app = express();
      const nextSpy = vi.fn();
      const getOpenAIAccount = vi.fn(() => null);

      mountMessagesCrossProviderRoute(app, {
        crossProviderFallback: true,
        hasAvailableAnthropicAccount: () => false,
        // modelRouting.openAIDefaultModel intentionally unset
        getOpenAIAccount,
        forwardOpenAI: async () => new Response("unused"),
      });
      app.use("/v1/messages", (req, res) => { nextSpy(); res.json({ ok: true }); });

      await withServer(app, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: "hi" }] }),
        });
        expect(res.status).toBe(200);
        expect(nextSpy).toHaveBeenCalledOnce();
        expect(getOpenAIAccount).not.toHaveBeenCalled();
      });
    });

    it("does not touch OpenAI at all when Anthropic still has capacity", async () => {
      const app = express();
      const nextSpy = vi.fn();
      const getOpenAIAccount = vi.fn(() => null);

      mountMessagesCrossProviderRoute(app, {
        crossProviderFallback: true,
        hasAvailableAnthropicAccount: () => true,
        modelRouting: { openAIDefaultModel: "gpt-5-codex" },
        getOpenAIAccount,
        forwardOpenAI: async () => new Response("unused"),
      });
      app.use("/v1/messages", (req, res) => { nextSpy(); res.json({ ok: true }); });

      await withServer(app, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: "hi" }] }),
        });
        expect(res.status).toBe(200);
        expect(nextSpy).toHaveBeenCalledOnce();
        expect(getOpenAIAccount).not.toHaveBeenCalled();
      });
    });

    it("falls through to next() (does not surface it) when OpenAI itself responds with an error status", async () => {
      const app = express();
      const nextSpy = vi.fn();

      mountMessagesCrossProviderRoute(app, {
        crossProviderFallback: true,
        hasAvailableAnthropicAccount: () => false,
        modelRouting: { openAIDefaultModel: "gpt-5-codex" },
        getOpenAIAccount: () => ({
          id: "codex",
          provider: "openai_subscription",
          accessToken: "access",
          refreshToken: "refresh",
          expiresAt: Date.now() + 60 * 60 * 1000,
          enabled: true,
        }),
        forwardOpenAI: async () => new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        }),
      });
      app.use("/v1/messages", (req, res) => { nextSpy(); res.status(200).json({ degraded: true }); });

      await withServer(app, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: "hi" }] }),
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ degraded: true });
        expect(nextSpy).toHaveBeenCalledOnce();
      });
    });

    it("falls through to next() (no crash) when prepareOpenAIAccount (token refresh) throws", async () => {
      const app = express();
      const nextSpy = vi.fn();

      mountMessagesCrossProviderRoute(app, {
        crossProviderFallback: true,
        hasAvailableAnthropicAccount: () => false,
        modelRouting: { openAIDefaultModel: "gpt-5-codex" },
        getOpenAIAccount: () => ({
          id: "codex",
          provider: "openai_subscription",
          accessToken: "access",
          refreshToken: "refresh",
          expiresAt: Date.now() + 60 * 60 * 1000,
          enabled: true,
        }),
        prepareOpenAIAccount: async () => { throw new Error("refresh endpoint unreachable"); },
        forwardOpenAI: async () => new Response("unused"),
      });
      app.use("/v1/messages", (req, res) => { nextSpy(); res.status(200).json({ degraded: true }); });

      await withServer(app, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: "hi" }] }),
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ degraded: true });
        expect(nextSpy).toHaveBeenCalledOnce();
      });
    });

    it("falls through to next() (no crash) when the OpenAI request itself throws", async () => {
      const app = express();
      const nextSpy = vi.fn();

      mountMessagesCrossProviderRoute(app, {
        crossProviderFallback: true,
        hasAvailableAnthropicAccount: () => false,
        modelRouting: { openAIDefaultModel: "gpt-5-codex" },
        getOpenAIAccount: () => ({
          id: "codex",
          provider: "openai_subscription",
          accessToken: "access",
          refreshToken: "refresh",
          expiresAt: Date.now() + 60 * 60 * 1000,
          enabled: true,
        }),
        forwardOpenAI: async () => { throw new Error("network unreachable"); },
      });
      app.use("/v1/messages", (req, res) => { nextSpy(); res.status(200).json({ degraded: true }); });

      await withServer(app, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: "hi" }] }),
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ degraded: true });
        expect(nextSpy).toHaveBeenCalledOnce();
      });
    });

    it("does not touch explicit openai/* routing behavior (onFallback never fires for it)", async () => {
      const app = express();
      const onFallback = vi.fn();

      mountMessagesCrossProviderRoute(app, {
        crossProviderFallback: true,
        hasAvailableAnthropicAccount: () => false,
        modelRouting: { openAIDefaultModel: "gpt-5-codex" },
        getOpenAIAccount: () => ({
          id: "codex",
          provider: "openai_subscription",
          accessToken: "access",
          refreshToken: "refresh",
          expiresAt: Date.now() + 60 * 60 * 1000,
          enabled: true,
        }),
        forwardOpenAI: jsonOpenAIResponse("Done."),
        onFallback,
      });

      await withServer(app, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "openai/gpt-5-codex", messages: [{ role: "user", content: "hi" }] }),
        });
        expect(res.status).toBe(200);
        expect(onFallback).not.toHaveBeenCalled();
      });
    });
  });
});
