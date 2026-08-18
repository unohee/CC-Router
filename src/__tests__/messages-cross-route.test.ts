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

    it("routes to OpenAI with the model overridden to the configured default when Anthropic is exhausted", async () => {
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
          body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 64, messages: [{ role: "user", content: "hi" }] }),
        });
        expect(res.status).toBe(200);
        expect(forwardedBodies[0]?.model).toBe("gpt-5-codex");
        expect(nextSpy).not.toHaveBeenCalled();
        expect(onFallback).toHaveBeenCalledWith({ openAIAccountId: "codex", upstreamModel: "gpt-5-codex" });
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
