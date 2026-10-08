import {
  describeModelPortContract,
  type ModelContractObserved,
  type ModelContractReply,
  nextContractReply,
} from "@fundroom/ai/testing";
import {
  ModelProviderError,
  type ModelRequest,
  type OutboundFetch,
  OutboundHttpError,
} from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_SUB_PROCESSOR,
  type AnthropicConfig,
  createAnthropicModel,
  messagesUrl,
} from "./index.js";

/*
 * The Anthropic adapter against a recording fake `OutboundFetch` (E3.12 §8, vendors §1): the
 * request shape (no temperature/thinking, output_config for JSON), every response and error
 * mapping branch (incl. the spend-cap 429), the single retry, deadline and abort, and that
 * nothing logs prompt or response text or the key.
 */

const NOW = new Date("2026-09-30T12:00:00Z");
const KEY = "sk-ant-test-secret-0123456789";
const PROMPT = "prompt-text-a41f";
const OUTPUT = "output-text-e07b";

interface Call {
  readonly url: string;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
  readonly redirect: RequestInit["redirect"];
}

type Answer = Response | Error | "hang";

function fakeServer(answers: Answer[]) {
  const calls: Call[] = [];
  const fetch: OutboundFetch = async (input, init) => {
    calls.push({
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      redirect: init?.redirect,
    });
    const next = answers.shift();
    if (next === undefined) throw new Error("fake server: no answer left");
    if (next === "hang") {
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch, calls };
}

const CFG: AnthropicConfig = {
  baseUrl: "https://api.anthropic.com",
  apiKey: KEY,
  model: "claude-opus-5",
  timeoutMs: 5_000,
};

function adapter(answers: Answer[], cfg: Partial<AnthropicConfig> = {}) {
  const server = fakeServer(answers);
  const logs: Record<string, unknown>[] = [];
  const port = createAnthropicModel(
    { fetch: server.fetch, now: () => NOW, log: (e) => logs.push(e) },
    { ...CFG, ...cfg },
  );
  return { port, calls: server.calls, logs };
}

function message(
  overrides: { content?: unknown; stop?: unknown; usage?: unknown; model?: unknown } = {},
): Response {
  return Response.json(
    {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "model" in overrides ? overrides.model : "claude-opus-5",
      content:
        "content" in overrides
          ? overrides.content
          : [
              { type: "thinking", thinking: "", signature: "sig" },
              { type: "text", text: `{"a":"${OUTPUT}"}` },
            ],
      stop_reason: "stop" in overrides ? overrides.stop : "end_turn",
      stop_sequence: null,
      usage:
        "usage" in overrides
          ? overrides.usage
          : {
              input_tokens: 10,
              output_tokens: 20,
              cache_creation_input_tokens: 3,
              cache_read_input_tokens: 4,
              service_tier: "standard",
            },
    },
    { headers: { "request-id": "req_018EeWyXxfu5pfWkrYcMdjWG" } },
  );
}

function apiError(
  status: number,
  type: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  return Response.json(
    { type: "error", error: { type, message: "msg", ...extra }, request_id: "req_x" },
    { status, headers: { "request-id": "req_x", ...headers } },
  );
}

const REQ: ModelRequest = {
  system: `You answer questions. ${PROMPT}`,
  messages: [{ role: "user", content: `<question>${PROMPT}</question>` }],
  maxOutputTokens: 1200,
};
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["a"],
  properties: { a: { type: "string" } },
};

async function failure(p: Promise<unknown>): Promise<ModelProviderError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ModelProviderError);
    return e as ModelProviderError;
  }
  throw new Error("expected a rejection");
}

function noLeaks(logs: readonly unknown[], error?: Error) {
  const texts = [...logs.map((l) => JSON.stringify(l)), error?.message ?? ""];
  for (const t of texts) {
    expect(t).not.toContain(PROMPT);
    expect(t).not.toContain(OUTPUT);
    expect(t).not.toContain(KEY);
  }
}

describe("messagesUrl", () => {
  it.each([
    ["https://api.anthropic.com", "https://api.anthropic.com/v1/messages"],
    ["https://api.anthropic.com/", "https://api.anthropic.com/v1/messages"],
    ["https://api.anthropic.com/v1", "https://api.anthropic.com/v1/messages"],
    ["http://127.0.0.1:9999/stub/", "http://127.0.0.1:9999/stub/v1/messages"],
  ])("%s → %s", (base, url) => {
    expect(messagesUrl(base)).toBe(url);
  });
});

describe("createAnthropicModel: request", () => {
  it("posts model, max_tokens, top-level system and messages with the version and key headers", async () => {
    const { port, calls } = adapter([message()]);
    await port.generate(REQ);
    const call = calls[0];
    expect(call?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(call?.redirect).toBe("manual");
    expect(call?.headers.get("x-api-key")).toBe(KEY);
    expect(call?.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(call?.headers.get("content-type")).toBe("application/json");
    expect(call?.headers.has("authorization")).toBe(false);
    // Exactly these keys: no temperature/top_p/top_k/thinking (400 on current models).
    expect(call?.body).toEqual({
      model: "claude-opus-5",
      max_tokens: 1200,
      system: REQ.system,
      messages: [{ role: "user", content: `<question>${PROMPT}</question>` }],
    });
  });

  it("JSON: output_config.format json_schema with the schema unchanged", async () => {
    const { port, calls } = adapter([message()]);
    await port.generate({ ...REQ, json: { name: "qa_answer", schema: SCHEMA } });
    expect(calls[0]?.body["output_config"]).toEqual({
      format: { type: "json_schema", schema: SCHEMA },
    });
    expect(calls[0]?.body["system"]).toBe(REQ.system);
  });
});

describe("createAnthropicModel: response", () => {
  it("joins text blocks only, sums cached input tokens, logs the request id and counts only", async () => {
    const { port, logs } = adapter([message()]);
    expect(await port.generate(REQ)).toEqual({
      text: `{"a":"${OUTPUT}"}`,
      finish: "stop",
      usage: { inputTokens: 17, outputTokens: 20 },
      model: "claude-opus-5",
    });
    expect(logs).toEqual([
      expect.objectContaining({
        event: "ai.model_call",
        provider: "anthropic",
        requestId: "req_018EeWyXxfu5pfWkrYcMdjWG",
        inputTokens: 17,
      }),
    ]);
    noLeaks(logs);
  });

  it("concatenates several text blocks in order", async () => {
    const { port } = adapter([
      message({
        content: [
          { type: "text", text: "a" },
          { type: "tool_use", id: "x", name: "y", input: {} },
          // A non-text block that happens to carry a `text` field is still skipped.
          { type: "thinking", thinking: "", text: "hidden" },
          { type: "text", text: "b" },
        ],
      }),
    ]);
    expect((await port.generate(REQ)).text).toBe("ab");
  });

  it.each([
    ["end_turn", "stop"],
    ["stop_sequence", "stop"],
    ["max_tokens", "length"],
    ["model_context_window_exceeded", "length"],
    ["refusal", "refusal"],
    ["pause_turn", "stop"],
  ])("stop_reason %s → %s", async (stop, finish) => {
    const { port, calls } = adapter([message({ stop }), message()]);
    expect((await port.generate(REQ)).finish).toBe(finish);
    expect(calls).toHaveLength(1);
  });

  it("missing usage counts 0; missing model falls back to the configured one", async () => {
    const { port } = adapter([message({ usage: undefined, model: undefined })]);
    expect(await port.generate(REQ)).toMatchObject({
      usage: { inputTokens: 0, outputTokens: 0 },
      model: "claude-opus-5",
    });
  });

  it("an answer without content, or not JSON, is unavailable and not retried", async () => {
    const a = adapter([Response.json({ type: "message" }), message()]);
    expect(await failure(a.port.generate(REQ))).toMatchObject({
      code: "unavailable",
      retryable: false,
    });
    expect(a.calls).toHaveLength(1);
    const b = adapter([new Response("not json"), message()]);
    expect(await failure(b.port.generate(REQ))).toMatchObject({ code: "unavailable" });
  });
});

describe("createAnthropicModel: errors", () => {
  it.each([
    [400, "invalid_request_error", {}, "bad_request"],
    [
      400,
      "invalid_request_error",
      { message: "prompt is too long: 250000 tokens > 200000 maximum" },
      "context_exceeded",
    ],
    [
      400,
      "invalid_request_error",
      {
        message:
          "You have reached your specified API usage limits. You will regain access on 2026-10-01",
      },
      "quota",
    ],
    [401, "authentication_error", {}, "auth"],
    [402, "billing_error", {}, "quota"],
    [403, "permission_error", {}, "auth"],
    [404, "not_found_error", { message: "model: claude-nope" }, "not_found"],
    [413, "request_too_large", {}, "context_exceeded"],
    [429, "rate_limit_error", { details: { error_code: "enforced_spend_limit_reached" } }, "quota"],
    [418, "whatever", {}, "bad_request"],
  ])("HTTP %s %s %j → %s, not retried", async (status, type, extra, code) => {
    const { port, calls, logs } = adapter([apiError(status, type, extra), message()]);
    const e = await failure(port.generate(REQ));
    expect(e).toMatchObject({ code, retryable: false });
    expect(calls).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      event: "ai.model_call_failed",
      status,
      code,
      requestId: "req_x",
    });
    noLeaks(logs, e);
  });

  it("never copies the vendor's message into the error", async () => {
    const { port } = adapter([
      apiError(400, "invalid_request_error", { message: `bad: ${PROMPT}` }),
    ]);
    expect((await failure(port.generate(REQ))).message).toBe(
      "the model server answered HTTP 400 (invalid_request_error)",
    );
  });

  it("429 rate_limit_error with retry-after is retried once and succeeds", async () => {
    const { port, calls } = adapter([
      apiError(429, "rate_limit_error", {}, { "retry-after": "0" }),
      message(),
    ]);
    expect((await port.generate(REQ)).finish).toBe("stop");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body).toEqual(calls[0]?.body);
  });

  it("429 with a retry-after over 10 s surfaces rate_limited with retryAfterMs", async () => {
    const { port, calls } = adapter([
      apiError(429, "rate_limit_error", {}, { "retry-after": "60" }),
      message(),
    ]);
    expect(await failure(port.generate(REQ))).toMatchObject({
      code: "rate_limited",
      retryable: true,
      retryAfterMs: 60_000,
    });
    expect(calls).toHaveLength(1);
  });

  it.each([
    [529, "overloaded_error"],
    [500, "api_error"],
    [504, "timeout_error"],
    [409, "conflict_error"],
  ])("HTTP %s %s is retried once", async (status, type) => {
    const ok = adapter([apiError(status, type, {}, { "retry-after": "0" }), message()]);
    expect((await ok.port.generate(REQ)).finish).toBe("stop");
    expect(ok.calls).toHaveLength(2);
    const bad = adapter([
      apiError(status, type, {}, { "retry-after": "0" }),
      apiError(status, type, {}, { "retry-after": "0" }),
      message(),
    ]);
    expect(await failure(bad.port.generate(REQ))).toMatchObject({
      code: "unavailable",
      retryable: true,
    });
    expect(bad.calls).toHaveLength(2);
  });

  it("an HTML 502 from a proxy is retryable unavailable", async () => {
    const { port, calls } = adapter([
      new Response("<html>502</html>", { status: 502, headers: { "retry-after": "0" } }),
      message(),
    ]);
    expect((await port.generate(REQ)).finish).toBe("stop");
    expect(calls).toHaveLength(2);
  });

  it("a 3xx is refused, not retried", async () => {
    const { port, calls } = adapter([
      new Response(null, { status: 307, headers: { location: "https://elsewhere.example/" } }),
      message(),
    ]);
    expect(await failure(port.generate(REQ))).toMatchObject({
      code: "unavailable",
      retryable: false,
    });
    expect(calls).toHaveLength(1);
  });

  it("a network error is retried once; guard errors map like the other adapter", async () => {
    const ok = adapter([new TypeError("fetch failed"), message()]);
    expect((await ok.port.generate(REQ)).finish).toBe("stop");
    const big = adapter([new OutboundHttpError("response_too_large", "cap"), message()]);
    expect(await failure(big.port.generate(REQ))).toMatchObject({
      code: "unavailable",
      retryable: false,
    });
    expect(big.calls).toHaveLength(1);
    const slow = adapter([new OutboundHttpError("timeout", "slow"), message()]);
    expect(await failure(slow.port.generate(REQ))).toMatchObject({
      code: "timeout",
      retryable: false,
    });
    expect(slow.calls).toHaveLength(1);
  });
});

describe("createAnthropicModel: deadline and abort", () => {
  it("the adapter's own timeout aborts a hanging call → timeout", async () => {
    const { port } = adapter(["hang"], { timeoutMs: 50 });
    expect(await failure(port.generate(REQ))).toMatchObject({ code: "timeout", retryable: false });
  });

  it("the caller's abort → timeout, no retry", async () => {
    const { port, calls } = adapter(["hang", message()]);
    const ac = new AbortController();
    const p = port.generate({ ...REQ, signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    expect(await failure(p)).toMatchObject({ code: "timeout", retryable: false });
    expect(calls).toHaveLength(1);
  });
});

describe("createAnthropicModel: provider info", () => {
  it("third-party Anthropic in the US, a sub-processor, the retention sentence", () => {
    const { port } = adapter([]);
    expect(port.info).toEqual({
      id: "anthropic",
      label: "Anthropic",
      model: "claude-opus-5",
      hosting: "third_party",
      location: "United States",
      jurisdiction: "us",
      trainsOnInputs: false,
      retention: expect.stringContaining("within 30 days"),
      subProcessor: ANTHROPIC_SUB_PROCESSOR,
    });
    expect(ANTHROPIC_SUB_PROCESSOR).toMatchObject({ name: "Anthropic", jurisdiction: "us" });
  });
});

/* The shared ModelPort contract suite through the same fake wire. */
function contractHarness() {
  const queue: ModelContractReply[] = [];
  const received: ModelContractObserved[] = [];
  const logs: Record<string, unknown>[] = [];
  const fetch: OutboundFetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      system: string;
      messages: { role: string; content: string }[];
      max_tokens: number;
      output_config?: { format?: { schema?: Record<string, unknown> } };
    };
    received.push({
      system: body.system,
      messages: body.messages,
      maxOutputTokens: body.max_tokens,
      schema: body.output_config?.format?.schema ?? null,
    });
    const reply = nextContractReply(queue);
    switch (reply.kind) {
      case "ok":
        return message({
          content: [{ type: "text", text: reply.text }],
          stop:
            reply.finish === "length"
              ? "max_tokens"
              : reply.finish === "refusal"
                ? "refusal"
                : "end_turn",
          usage: { input_tokens: reply.inputTokens, output_tokens: reply.outputTokens },
          model: reply.model,
        });
      case "error":
        switch (reply.code) {
          case "rate_limited":
            return apiError(
              429,
              "rate_limit_error",
              {},
              {
                "retry-after": String((reply.retryAfterMs ?? 0) / 1000),
              },
            );
          case "unavailable":
            return apiError(529, "overloaded_error", {}, { "retry-after": "0" });
          case "auth":
            return apiError(401, "authentication_error");
          case "quota":
            return apiError(429, "rate_limit_error", {
              details: { error_code: "enforced_spend_limit_reached" },
            });
          case "bad_request":
            return apiError(400, "invalid_request_error");
          case "not_found":
            return apiError(404, "not_found_error");
        }
        throw new Error("unreachable");
      case "hang":
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        });
    }
  };
  const port = createAnthropicModel(
    { fetch, now: () => new Date(), log: (e) => logs.push(e) },
    CFG,
  );
  return {
    port,
    backend: { reply: (...r: ModelContractReply[]) => queue.push(...r), received },
    logs,
    secrets: [KEY],
  };
}

describeModelPortContract("anthropic (scripted fetch)", contractHarness, { retriesOnce: true });
