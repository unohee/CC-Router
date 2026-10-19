import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter, once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Response as ExpressResponse } from "express";
import { createOllamaStreamTransformer, forwardToOllama, transformOllamaMessage } from "../providers/ollama/transport.js";

const ev = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

// The shape Ollama 0.23.3 streams: an unsigned thinking block first, then text
// and a tool call.
const UPSTREAM = [
  ev("message_start", { message: { id: "m1", type: "message", role: "assistant", model: "glm:cloud", content: [], usage: { input_tokens: 42, cache_read_input_tokens: 7, output_tokens: 0 } } }),
  ev("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }),
  ev("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "hmm ünïcødé" } }),
  ev("content_block_stop", { index: 0 }),
  ev("ping", {}),
  ev("content_block_start", { index: 1, content_block: { type: "text", text: "" } }),
  ev("content_block_delta", { index: 1, delta: { type: "text_delta", text: "héllo" } }),
  ev("content_block_stop", { index: 1 }),
  ev("content_block_start", { index: 2, content_block: { type: "tool_use", id: "t1", name: "Read", input: {} } }),
  ev("content_block_delta", { index: 2, delta: { type: "input_json_delta", partial_json: "{\"path\":" } }),
  ev("content_block_delta", { index: 2, delta: { type: "input_json_delta", partial_json: "\"a\"}" } }),
  ev("content_block_stop", { index: 2 }),
  ev("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } }),
  ev("message_stop", {}),
].join("");

function parse(out: string): Array<{ event: string; data: Record<string, unknown> }> {
  return out.split("\n\n").filter(Boolean).map(block => {
    const lines = block.split("\n");
    return {
      event: lines.find(l => l.startsWith("event: "))!.slice(7),
      data: JSON.parse(lines.find(l => l.startsWith("data: "))!.slice(6)),
    };
  });
}

function runWhole(text: string) {
  const t = createOllamaStreamTransformer({ publicModel: "claude-sonnet-4-6" });
  const out = t.push(text) + t.end();
  return { out, t };
}

describe("Ollama stream transformer", () => {
  it("strips thinking, renumbers later blocks and rewrites the model", () => {
    const { out, t } = runWhole(UPSTREAM);
    const events = parse(out);
    expect(events.map(e => e.event)).toEqual([
      "message_start", "ping",
      "content_block_start", "content_block_delta", "content_block_stop",
      "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop",
      "message_delta", "message_stop",
    ]);
    expect(out).not.toContain("thinking");
    expect((events[0].data["message"] as { model: string }).model).toBe("claude-sonnet-4-6");
    expect(events.filter(e => "index" in e.data).map(e => e.data["index"])).toEqual([0, 0, 0, 1, 1, 1, 1]);
    // The tool call keeps its argument deltas, now under index 1.
    const json = events.filter(e => (e.data["delta"] as { type?: string } | undefined)?.type === "input_json_delta")
      .map(e => (e.data["delta"] as { partial_json: string }).partial_json).join("");
    expect(JSON.parse(json)).toEqual({ path: "a" });
    expect(t.usage()).toEqual({ input_tokens: 42, output_tokens: 9, cache_read_input_tokens: 7 });
    expect(t.completed()).toBe(true);
    expect(t.sawError()).toBe(false);
  });

  it("gives identical output however the bytes are split", () => {
    const { out: expected } = runWhole(UPSTREAM);
    const bytes = new TextEncoder().encode(UPSTREAM);
    for (let cut = 1; cut < bytes.length; cut++) {
      const decoder = new TextDecoder();
      const t = createOllamaStreamTransformer({ publicModel: "claude-sonnet-4-6" });
      const out = t.push(decoder.decode(bytes.slice(0, cut), { stream: true }))
        + t.push(decoder.decode(bytes.slice(cut), { stream: true }))
        + t.push(decoder.decode())
        + t.end();
      if (out !== expected) throw new Error(`differs when split at byte ${cut}`);
    }
    // And one byte at a time.
    const decoder = new TextDecoder();
    const t = createOllamaStreamTransformer({ publicModel: "claude-sonnet-4-6" });
    let out = "";
    for (const b of bytes) out += t.push(decoder.decode(new Uint8Array([b]), { stream: true }));
    out += t.push(decoder.decode()) + t.end();
    expect(out).toBe(expected);
  });

  it("tolerates CRLF delimiters, a missing final blank line and non-JSON data", () => {
    const crlf = UPSTREAM.replace(/\n/g, "\r\n");
    expect(parse(runWhole(crlf).out).length).toBe(11);
    const t = createOllamaStreamTransformer();
    const out = t.push(": keep-alive\n\ndata: not-json\n\n") + t.push(ev("message_stop", {}).trimEnd()) + t.end();
    expect(out).toBe(": keep-alive\n\ndata: not-json\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
  });

  it("strips thinking listed up front in message_start.content", () => {
    const t = createOllamaStreamTransformer({ publicModel: "claude-sonnet-4-6" });
    const out = t.push(ev("message_start", { message: {
      id: "m", type: "message", role: "assistant", model: "glm:cloud",
      content: [{ type: "thinking", thinking: "x" }, { type: "redacted_thinking", data: "y" }, { type: "text", text: "hi" }],
      usage: { input_tokens: 1, output_tokens: 0 },
    } })) + t.end();
    const message = parse(out)[0].data["message"] as { content: { type: string }[] };
    expect(message.content).toEqual([{ type: "text", text: "hi" }]);
    expect(out).not.toContain("thinking");
  });

  it("strips redacted_thinking and reports an incomplete or failed stream", () => {
    const t = createOllamaStreamTransformer();
    const out = t.push(
      ev("content_block_start", { index: 0, content_block: { type: "redacted_thinking", data: "x" } })
      + ev("content_block_stop", { index: 0 })
      + ev("content_block_start", { index: 1, content_block: { type: "text", text: "" } })
      + ev("error", { error: { type: "overloaded_error", message: "x" } }),
    ) + t.end();
    expect(out).not.toContain("redacted");
    expect(parse(out)[0].data["index"]).toBe(0);
    expect(t.completed()).toBe(false);
    expect(t.sawError()).toBe(true);
  });
});

describe("transformOllamaMessage", () => {
  it("filters thinking blocks, rewrites the model and reads usage", () => {
    const { message, usage } = transformOllamaMessage({
      id: "m", type: "message", role: "assistant", model: "glm:cloud",
      content: [{ type: "thinking", thinking: "x" }, { type: "redacted_thinking", data: "y" }, { type: "text", text: "hi" }],
      stop_reason: "end_turn", usage: { input_tokens: 3, cache_read_input_tokens: 1, output_tokens: 2 },
    }, "claude-opus-4-1");
    expect(message).toMatchObject({ model: "claude-opus-4-1", content: [{ type: "text", text: "hi" }] });
    expect(usage).toEqual({ input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 1 });
  });
});

// forwardToOllama against a real local HTTP server (real fetch/undici, so the
// abort and timeout behaviour is the production one) and a minimal stand-in
// for the Express response.

class FakeRes extends EventEmitter {
  statusCode = 0;
  body = "";
  headers: Record<string, string> = {};
  headersSent = false;
  writableEnded = false;
  destroyed = false;
  status(code: number) { this.statusCode = code; return this; }
  setHeader(name: string, value: string) { this.headers[name] = value; }
  flushHeaders() { this.headersSent = true; }
  write(text: string) { this.headersSent = true; this.body += text; return true; }
  end() { this.writableEnded = true; this.emit("finish"); this.emit("close"); return this; }
  json(value: unknown) { this.headersSent = true; this.body = JSON.stringify(value); return this.end(); }
  /** The client hanging up. */
  hangUp() { this.destroyed = true; this.emit("close"); }
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => { s.closeAllConnections(); s.close(() => r()); })));
});

async function upstream(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

const STREAM_EVENTS = [
  ev("message_start", { message: { id: "m", type: "message", role: "assistant", model: "glm:cloud", content: [], usage: { input_tokens: 3, output_tokens: 0 } } }),
  ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
  ...Array.from({ length: 10 }, (_, i) => ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: `t${i} ` } })),
  ev("content_block_stop", { index: 0 }),
  ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 10 } }),
  ev("message_stop", {}),
];

function forward(baseUrl: string, res: FakeRes, timeoutMs: number, stream = true) {
  return forwardToOllama({
    baseUrl, upstreamModel: "glm:cloud", publicModel: "claude-sonnet-4-6",
    body: { model: "claude-sonnet-4-6", stream, max_tokens: 16, messages: [] }, timeoutMs,
  }, res as unknown as ExpressResponse);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe("forwardToOllama", () => {
  it("does not cut a stream that keeps sending past timeoutMs: the timeout is idle, not total", async () => {
    const base = await upstream((req, res) => {
      req.resume();
      res.writeHead(200, { "content-type": "text/event-stream" });
      let i = 0;
      const tick = setInterval(() => {
        res.write(STREAM_EVENTS[i++]);
        if (i === STREAM_EVENTS.length) { clearInterval(tick); res.end(); }
      }, 50); // 14 events x 50ms = ~700ms total, longer than the 400ms timeout but never idle for it
    });
    const res = new FakeRes();
    const outcome = await forward(base, res, 400);
    expect(outcome).toEqual({ ok: true, status: 200, usage: { input_tokens: 3, output_tokens: 10 } });
    expect(res.body).toContain("message_stop");
    expect(res.body).toContain("t9 ");
  });

  it("ends a stream that goes quiet for timeoutMs and reports it as failed after start", async () => {
    const base = await upstream((req, res) => {
      req.resume();
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(STREAM_EVENTS[0] + STREAM_EVENTS[1]); // then silence
    });
    const res = new FakeRes();
    const outcome = await forward(base, res, 150);
    expect(outcome).toMatchObject({ ok: true, failedAfterStart: true });
    expect(res.writableEnded).toBe(true);
    expect(res.body).not.toContain("message_stop");
  });

  it("returns unwritten when the response headers do not arrive within timeoutMs", async () => {
    const base = await upstream((req) => { req.resume(); });
    const res = new FakeRes();
    const outcome = await forward(base, res, 150);
    expect(outcome).toMatchObject({ ok: false, reason: "network" });
    if (!outcome.ok) expect(outcome.detail).toMatch(/no data from Ollama/);
    expect(res.headersSent).toBe(false);
  });

  it("returns unwritten on a refused connection, an empty stream and a socket dropped after the headers", async () => {
    const closed = await upstream(() => {});
    await new Promise<void>(r => servers.pop()!.close(() => r()));
    expect(await forward(closed, new FakeRes(), 1000)).toMatchObject({ ok: false, reason: "network" });

    const empty = await upstream((req, res) => { req.resume(); res.writeHead(200, { "content-type": "text/event-stream" }); res.end(); });
    expect(await forward(empty, new FakeRes(), 1000)).toMatchObject({ ok: false, reason: "invalid_response", detail: "stream carried no events" });

    const dropped = await upstream((req, res) => {
      req.resume();
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      setTimeout(() => res.socket?.destroy(), 20);
    });
    const res = new FakeRes();
    const outcome = await forward(dropped, res, 1000);
    expect(outcome.ok).toBe(false);
    expect(res.headersSent).toBe(false);
  });

  it("reports a stream cut mid-way, or ending without message_stop, as failed after start", async () => {
    const cut = await upstream((req, res) => {
      req.resume();
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(STREAM_EVENTS[0] + STREAM_EVENTS[1] + STREAM_EVENTS[2]);
      setTimeout(() => res.socket?.destroy(), 20);
    });
    const a = new FakeRes();
    expect(await forward(cut, a, 1000)).toMatchObject({ ok: true, failedAfterStart: true, usage: { input_tokens: 3 } });
    expect(a.body).toContain("t0 ");

    const unfinished = await upstream((req, res) => {
      req.resume();
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(STREAM_EVENTS.slice(0, 4).join(""));
    });
    const b = new FakeRes();
    expect(await forward(unfinished, b, 1000)).toMatchObject({ ok: true, failedAfterStart: true });
  });

  it("aborts the upstream when the client hangs up, and does not call it a failure", async () => {
    let upstreamClosed = 0;
    const waiting = await upstream((req, res) => {
      req.resume();
      res.on("close", () => { upstreamClosed++; });
      // Never answers: the client hangs up first.
    });
    const before = new FakeRes();
    const pending = forward(waiting, before, 10_000);
    await sleep(80);
    before.hangUp();
    expect(await pending).toMatchObject({ ok: false, reason: "client_closed" });

    const streaming = await upstream((req, res) => {
      req.resume();
      res.on("close", () => { upstreamClosed++; });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(STREAM_EVENTS[0] + STREAM_EVENTS[1]); // then keeps generating
    });
    const during = new FakeRes();
    const midway = forward(streaming, during, 10_000);
    while (!during.body) await sleep(10);
    during.hangUp();
    const outcome = await midway;
    expect(outcome).toMatchObject({ ok: true, clientClosed: true });
    expect(outcome).not.toHaveProperty("failedAfterStart");

    await sleep(100);
    expect(upstreamClosed).toBe(2);
  });

  it("bounds a non-streaming answer by inactivity, not by total time", async () => {
    const body = JSON.stringify({ id: "m", type: "message", role: "assistant", model: "glm:cloud", content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "hi" }], usage: { input_tokens: 1, output_tokens: 1 } });
    const base = await upstream((req, res) => {
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      let i = 0;
      const tick = setInterval(() => {
        res.write(body.slice(i, i + 10)); i += 10;
        if (i >= body.length) { clearInterval(tick); res.end(); }
      }, 30); // well over 150ms in total
    });
    const res = new FakeRes();
    expect(await forward(base, res, 150, false)).toMatchObject({ ok: true, status: 200 });
    expect(JSON.parse(res.body)).toMatchObject({ model: "claude-sonnet-4-6", content: [{ type: "text", text: "hi" }] });
  });
});
