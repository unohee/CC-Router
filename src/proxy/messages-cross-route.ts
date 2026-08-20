import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import { selectRoute } from "../providers/route-selector.js";
import { anthropicToOpenAIResponses } from "../protocol/anthropic-to-openai.js";
import { openAIResponseToAnthropicMessage } from "../protocol/openai-response-to-anthropic.js";
import { createOpenAIStreamToAnthropicNormalizer } from "../protocol/openai-stream-to-anthropic.js";
import { encodeSseEvent, parseSseLines } from "../protocol/sse.js";
import { forwardOpenAICodexResponse } from "../providers/openai/codex-transport.js";
import type { AnthropicMessagesRequest } from "../protocol/anthropic-types.js";
import type { OpenAIFunctionCall, OpenAIResponseCompleted, OpenAIResponseOutputItem } from "../protocol/openai-responses-types.js";
import type { OpenAISubscriptionAccount } from "../providers/openai/token-refresher.js";
import type { ModelRoutingConfig } from "../protocol/model-ref.js";

declare module "express-serve-static-core" {
  interface Request {
    _ccRawBody?: Buffer;
  }
}

type ForwardOpenAI = typeof forwardOpenAICodexResponse;

export interface MessagesCrossProviderRouteOptions {
  getOpenAIAccount: () => OpenAISubscriptionAccount | null;
  prepareOpenAIAccount?: (account: OpenAISubscriptionAccount) => Promise<boolean>;
  forwardOpenAI?: ForwardOpenAI;
  modelRouting?: ModelRoutingConfig;
}

function isAnthropicMessagesRequest(value: unknown): value is AnthropicMessagesRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { messages?: unknown }).messages)
  );
}

async function sendOpenAIAsAnthropic(
  upstream: globalThis.Response,
  res: Response,
  requestedStream: boolean,
): Promise<void> {
  const contentType = upstream.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    if (requestedStream) {
      await sendOpenAIStreamAsAnthropic(upstream, res);
      return;
    }

    res.status(upstream.status).json(await collectOpenAIStreamAsAnthropicMessage(upstream));
    return;
  }

  if (!contentType.includes("application/json")) {
    res.status(upstream.status);
    res.setHeader("content-type", contentType || "text/plain");
    res.send(await upstream.text());
    return;
  }

  const json = await upstream.json() as OpenAIResponseCompleted;
  res.status(upstream.status).json(openAIResponseToAnthropicMessage(json));
}

async function collectOpenAIStreamAsAnthropicMessage(upstream: globalThis.Response): Promise<ReturnType<typeof openAIResponseToAnthropicMessage>> {
  const reader = upstream.body?.getReader();
  if (!reader) {
    return openAIResponseToAnthropicMessage({ id: "", model: "", output: [], usage: {} });
  }

  const decoder = new TextDecoder();
  let remainder = "";
  let id = "";
  let model = "";
  let usage: OpenAIResponseCompleted["usage"] = {};
  const textByIndex = new Map<number, string>();
  const argumentsByIndex = new Map<number, string>();
  const callsByIndex = new Map<number, OpenAIFunctionCall>();

  const applyEvent = (event: unknown) => {
    if (typeof event !== "object" || event === null) return;
    const openAIEvent = event as {
      type?: string;
      delta?: string;
      arguments?: string;
      output_index?: number;
      item?: { type?: string; call_id?: string; name?: string; arguments?: string };
      response?: {
        id?: string;
        model?: string;
        usage?: OpenAIResponseCompleted["usage"];
      };
    };
    const outputIndex = openAIEvent.output_index ?? 0;

    if (openAIEvent.type === "response.created") {
      id = openAIEvent.response?.id ?? id;
      model = openAIEvent.response?.model ?? model;
      return;
    }

    if (openAIEvent.type === "response.output_text.delta") {
      textByIndex.set(outputIndex, (textByIndex.get(outputIndex) ?? "") + (openAIEvent.delta ?? ""));
      return;
    }

    if (openAIEvent.type === "response.output_item.added") {
      const item = openAIEvent.item;
      if (item?.type === "function_call" && item.call_id) {
        callsByIndex.set(outputIndex, {
          type: "function_call",
          call_id: item.call_id,
          name: item.name ?? "",
          arguments: item.arguments ?? "",
        });
      }
      return;
    }

    if (openAIEvent.type === "response.function_call_arguments.delta") {
      argumentsByIndex.set(outputIndex, (argumentsByIndex.get(outputIndex) ?? "") + (openAIEvent.delta ?? ""));
      return;
    }

    if (openAIEvent.type === "response.function_call_arguments.done") {
      if (!argumentsByIndex.has(outputIndex) && openAIEvent.arguments) {
        argumentsByIndex.set(outputIndex, openAIEvent.arguments);
      }
      return;
    }

    if (openAIEvent.type === "response.output_item.done") {
      const item = openAIEvent.item;
      if (item?.type === "function_call" && item.call_id) {
        callsByIndex.set(outputIndex, {
          type: "function_call",
          call_id: item.call_id,
          name: item.name ?? "",
          arguments: item.arguments || argumentsByIndex.get(outputIndex) || "",
        });
      }
      return;
    }

    if (openAIEvent.type === "response.completed") {
      id = openAIEvent.response?.id ?? id;
      model = openAIEvent.response?.model ?? model;
      usage = openAIEvent.response?.usage ?? usage;
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    const parsed = parseSseLines(remainder + decoder.decode(value, { stream: true }));
    remainder = parsed.remainder;
    parsed.events.forEach(applyEvent);
  }

  const tail = decoder.decode();
  if (tail || remainder) {
    parseSseLines(remainder + tail + "\n").events.forEach(applyEvent);
  }

  const output: OpenAIResponseOutputItem[] = [...new Set([...textByIndex.keys(), ...callsByIndex.keys()])]
    .sort((a, b) => a - b)
    .flatMap((index): OpenAIResponseOutputItem[] => {
      const call = callsByIndex.get(index);
      if (call) return [{ ...call, arguments: call.arguments || argumentsByIndex.get(index) || "" }];
      const text = textByIndex.get(index);
      return text ? [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      }] : [];
    });

  return openAIResponseToAnthropicMessage({ id, model, output, usage });
}

async function sendOpenAIStreamAsAnthropic(upstream: globalThis.Response, res: Response): Promise<void> {
  res.status(upstream.status);
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache");
  res.flushHeaders?.();

  const normalizer = createOpenAIStreamToAnthropicNormalizer();
  const reader = upstream.body?.getReader();
  if (!reader) {
    res.end();
    return;
  }

  const decoder = new TextDecoder();
  let remainder = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      const parsed = parseSseLines(remainder + decoder.decode(value, { stream: true }));
      remainder = parsed.remainder;
      for (const event of parsed.events) {
        for (const mapped of normalizer.convert(event as Parameters<typeof normalizer.convert>[0])) {
          res.write(encodeSseEvent(mapped));
        }
      }
    }

    const tail = decoder.decode();
    if (tail || remainder) {
      const parsed = parseSseLines(remainder + tail + "\n");
      for (const event of parsed.events) {
        for (const mapped of normalizer.convert(event as Parameters<typeof normalizer.convert>[0])) {
          res.write(encodeSseEvent(mapped));
        }
      }
    }
  } finally {
    res.end();
  }
}

export function mountMessagesCrossProviderRoute(
  app: Express,
  opts: MessagesCrossProviderRouteOptions,
): void {
  const forwardOpenAI = opts.forwardOpenAI ?? forwardOpenAICodexResponse;
  const prepareOpenAIAccount = opts.prepareOpenAIAccount ?? (async () => true);

  app.post(
    "/v1/messages",
    express.json({
      limit: "10mb",
      verify: (req, _res, buf) => {
        (req as Request)._ccRawBody = Buffer.from(buf);
      },
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      if (!isAnthropicMessagesRequest(req.body)) {
        res.status(400).json({
          type: "error",
          error: {
            type: "invalid_request_error",
            message: "Expected Anthropic Messages request with messages array",
          },
        });
        return;
      }

      const route = selectRoute(req.body.model, opts.modelRouting);
      if (route.provider !== "openai_subscription") {
        next();
        return;
      }

      const account = opts.getOpenAIAccount();
      if (!account) {
        res.status(503).json({
          type: "error",
          error: {
            type: "no_accounts",
            message: "No OpenAI subscription accounts are configured",
          },
        });
        return;
      }

      const ready = await prepareOpenAIAccount(account);
      if (!ready) {
        res.status(401).json({
          type: "error",
          error: {
            type: "authentication_error",
            message: "OpenAI subscription token refresh failed",
          },
        });
        return;
      }

      const body = anthropicToOpenAIResponses(req.body, opts.modelRouting);
      const upstream = await forwardOpenAI({
        account,
        body,
        stream: body.stream === true,
      });
      await sendOpenAIAsAnthropic(upstream, res, req.body.stream === true);
    },
  );
}
