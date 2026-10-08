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
  chatCompletionsUrl,
  createOpenAiCompatibleModel,
  type OpenAiCompatibleConfig,
} from "./index.js";

/*
 * The OpenAI-compatible adapter against a recording fake `OutboundFetch` (E3.12 §8, vendors §2):
 * the request shape per config, every response and error mapping branch, the single retry, the
 * deadline and caller abort, and that nothing logs prompt or response text.
 */

const NOW = new Date("2026-09-30T12:00:00Z");
const KEY = "sk-test-secret-abcdef123456";
const PROMPT = "prompt-text-5d1c";
const OUTPUT = "output-text-9b7e";

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

const CFG: OpenAiCompatibleConfig = {
  baseUrl: "http://ollama:11434",
  apiKey: null,
  model: "qwen3.5:9b",
  hosting: "self_hosted",
  label: "Ollama at ollama:11434",
  location: null,
  jurisdiction: null,
  jsonMode: "json_schema",
  tokenParam: "max_tokens",
  timeoutMs: 5_000,
};

function adapter(answers: Answer[], cfg: Partial<OpenAiCompatibleConfig> = {}) {
  const server = fakeServer(answers);
  const logs: Record<string, unknown>[] = [];
  const port = createOpenAiCompatibleModel(
    { fetch: server.fetch, now: () => NOW, log: (e) => logs.push(e) },
    { ...CFG, ...cfg },
  );
  return { port, calls: server.calls, logs };
}

function completion(
  overrides: {
    content?: unknown;
    refusal?: string | null;
    finish?: unknown;
    usage?: unknown;
    model?: unknown;
  } = {},
): Response {
  return Response.json({
    id: "chatcmpl-1",
    object: "chat.completion",
    model: "model" in overrides ? overrides.model : "qwen3.5:9b-q4",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "content" in overrides ? overrides.content : `{"a":"${OUTPUT}"}`,
          refusal: overrides.refusal ?? null,
        },
        finish_reason: "finish" in overrides ? overrides.finish : "stop",
      },
    ],
    ...("usage" in overrides
      ? overrides.usage === undefined
        ? {}
        : { usage: overrides.usage }
      : { usage: { prompt_tokens: 44, completion_tokens: 48, total_tokens: 92 } }),
  });
}

function apiError(status: number, error: unknown, headers: Record<string, string> = {}): Response {
  return Response.json({ error }, { status, headers });
}

const REQ: ModelRequest = {
  system: `You draft updates. ${PROMPT}`,
  messages: [{ role: "user", content: `<notes>${PROMPT}</notes>` }],
  maxOutputTokens: 900,
};
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["a"],
  properties: { a: { type: "string" } },
};

function systemOf(call: Call | undefined): string {
  const messages = (call?.body["messages"] ?? []) as { content: string }[];
  return messages[0]?.content ?? "";
}

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

describe("chatCompletionsUrl", () => {
  it.each([
    ["http://ollama:11434", "http://ollama:11434/v1/chat/completions"],
    ["http://ollama:11434/", "http://ollama:11434/v1/chat/completions"],
    ["http://ollama:11434/v1", "http://ollama:11434/v1/chat/completions"],
    ["http://ollama:11434/v1/", "http://ollama:11434/v1/chat/completions"],
    ["https://gw.example.com/proxy/v1", "https://gw.example.com/proxy/v1/chat/completions"],
    ["https://api.openai.com/v1?x=1", "https://api.openai.com/v1/chat/completions"],
  ])("%s → %s", (base, url) => {
    expect(chatCompletionsUrl(base)).toBe(url);
  });
});

describe("createOpenAiCompatibleModel: request", () => {
  it("posts the system prompt first, temperature 0.2, max_tokens, no key, no store, no redirects", async () => {
    const { port, calls } = adapter([completion()]);
    await port.generate(REQ);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe("http://ollama:11434/v1/chat/completions");
    expect(call?.redirect).toBe("manual");
    expect(call?.headers.get("content-type")).toBe("application/json");
    expect(call?.headers.has("authorization")).toBe(false);
    expect(call?.body).toEqual({
      model: "qwen3.5:9b",
      messages: [
        { role: "system", content: REQ.system },
        { role: "user", content: `<notes>${PROMPT}</notes>` },
      ],
      temperature: 0.2,
      max_tokens: 900,
      stream: false,
    });
  });

  it("sends Bearer only when a key is set, max_completion_tokens when configured, store:false to a third party", async () => {
    const { port, calls } = adapter([completion()], {
      apiKey: KEY,
      tokenParam: "max_completion_tokens",
      hosting: "third_party",
      baseUrl: "https://api.openai.com/v1",
    });
    await port.generate(REQ);
    expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(calls[0]?.body["max_completion_tokens"]).toBe(900);
    expect(calls[0]?.body).not.toHaveProperty("max_tokens");
    expect(calls[0]?.body["store"]).toBe(false);
  });

  it("an empty key sends no Authorization header", async () => {
    const { port, calls } = adapter([completion()], { apiKey: "" });
    await port.generate(REQ);
    expect(calls[0]?.headers.has("authorization")).toBe(false);
  });

  it("json_schema: nested response_format with a sanitised name, system prompt unchanged", async () => {
    const { port, calls } = adapter([completion()]);
    await port.generate({ ...REQ, json: { name: "update draft/v1", schema: SCHEMA } });
    expect(calls[0]?.body["response_format"]).toEqual({
      type: "json_schema",
      json_schema: { name: "update_draft_v1", schema: SCHEMA, strict: true },
    });
    expect(systemOf(calls[0])).toBe(REQ.system);
  });

  it("json_object: response_format json_object and the schema appended to the system prompt", async () => {
    const { port, calls } = adapter([completion()], { jsonMode: "json_object" });
    await port.generate({ ...REQ, json: { name: "x", schema: SCHEMA } });
    expect(calls[0]?.body["response_format"]).toEqual({ type: "json_object" });
    const system = systemOf(calls[0]);
    expect(system.startsWith(REQ.system)).toBe(true);
    expect(system).toContain("JSON");
    expect(system).toContain(JSON.stringify(SCHEMA));
  });

  it("prompt: no response_format, the schema appended to the system prompt", async () => {
    const { port, calls } = adapter([completion()], { jsonMode: "prompt" });
    await port.generate({ ...REQ, json: { name: "x", schema: SCHEMA } });
    expect(calls[0]?.body).not.toHaveProperty("response_format");
    const system = systemOf(calls[0]);
    expect(system).toContain(JSON.stringify(SCHEMA));
  });
});

describe("createOpenAiCompatibleModel: response", () => {
  it("returns content, finish, usage and the server's model; logs counts only", async () => {
    const { port, logs } = adapter([completion()], { apiKey: KEY });
    expect(await port.generate(REQ)).toEqual({
      text: `{"a":"${OUTPUT}"}`,
      finish: "stop",
      usage: { inputTokens: 44, outputTokens: 48 },
      model: "qwen3.5:9b-q4",
    });
    expect(logs).toEqual([
      expect.objectContaining({ event: "ai.model_call", status: 200, inputTokens: 44 }),
    ]);
    noLeaks(logs);
  });

  it.each([
    ["length", "length"],
    ["content_filter", "filtered"],
    ["tool_calls", "stop"],
    [null, "stop"],
  ])("finish_reason %s → %s", async (reason, finish) => {
    const { port } = adapter([completion({ finish: reason })]);
    expect((await port.generate(REQ)).finish).toBe(finish);
  });

  it("message.refusal → finish refusal with the (null) content as empty text", async () => {
    const { port } = adapter([completion({ content: null, refusal: "I can't help with that." })]);
    expect(await port.generate(REQ)).toMatchObject({ text: "", finish: "refusal" });
  });

  it("joins content parts; missing usage counts 0; missing model falls back to the configured one", async () => {
    const { port } = adapter([
      completion({
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
        usage: undefined,
        model: undefined,
      }),
    ]);
    expect(await port.generate(REQ)).toEqual({
      text: "ab",
      finish: "stop",
      usage: { inputTokens: 0, outputTokens: 0 },
      model: "qwen3.5:9b",
    });
  });

  it("an answer without choices, or not JSON, is unavailable and not retried", async () => {
    const a = adapter([Response.json({ object: "chat.completion" }), completion()]);
    expect(await failure(a.port.generate(REQ))).toMatchObject({
      code: "unavailable",
      retryable: false,
    });
    expect(a.calls).toHaveLength(1);
    const b = adapter([new Response("<html>ok</html>", { status: 200 }), completion()]);
    expect(await failure(b.port.generate(REQ))).toMatchObject({ code: "unavailable" });
    expect(b.calls).toHaveLength(1);
  });
});

describe("createOpenAiCompatibleModel: errors", () => {
  it.each([
    [
      400,
      { message: "bad", type: "invalid_request_error", param: null, code: null },
      "bad_request",
    ],
    [
      400,
      { message: "too long", type: "invalid_request_error", code: "context_length_exceeded" },
      "context_exceeded",
    ],
    [
      400,
      {
        message: "This model's maximum context length is 4096 tokens",
        type: "BadRequestError",
        code: 400,
      },
      "context_exceeded",
    ],
    [422, { message: "unprocessable" }, "bad_request"],
    [401, { code: 401, message: "Invalid API Key", type: "authentication_error" }, "auth"],
    [403, { message: "unsupported_country_region_territory" }, "auth"],
    [402, { message: "billing" }, "quota"],
    [
      404,
      { message: 'model "qwen" not found, try pulling it first', type: "not_found_error" },
      "not_found",
    ],
    [413, "request too large", "context_exceeded"],
    [418, null, "bad_request"],
    [429, { message: "quota", type: "insufficient_quota", code: "insufficient_quota" }, "quota"],
    [429, { message: "spend", type: "requests", code: "project_spend_limit_exceeded" }, "quota"],
  ])("HTTP %s %j → %s, not retried", async (status, error, code) => {
    const { port, calls, logs } = adapter([apiError(status, error), completion()], { apiKey: KEY });
    const e = await failure(port.generate(REQ));
    expect(e).toMatchObject({ code, retryable: false });
    expect(calls).toHaveLength(1);
    expect(logs[0]).toMatchObject({ event: "ai.model_call_failed", status, code });
    noLeaks(logs, e);
  });

  it("never copies the vendor's message (it may echo input) into the error", async () => {
    const { port } = adapter([
      apiError(400, { message: `Invalid value: '${PROMPT}'`, type: "invalid_request_error" }),
    ]);
    const e = await failure(port.generate(REQ));
    expect(e.message).toBe("the model server answered HTTP 400 (invalid_request_error)");
  });

  it("429 rate limit with retry-after: 0 is retried once and succeeds", async () => {
    const { port, calls, logs } = adapter([
      apiError(
        429,
        { type: "rate_limit_error", code: "rate_limit_exceeded" },
        { "retry-after": "0" },
      ),
      completion(),
    ]);
    expect((await port.generate(REQ)).finish).toBe("stop");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body).toEqual(calls[0]?.body);
    expect(logs.map((l) => l["event"])).toEqual([
      "ai.model_call_failed",
      "ai.model_retry",
      "ai.model_call",
    ]);
  });

  it("honours retry-after-ms and an HTTP-date retry-after", async () => {
    const a = adapter([
      apiError(429, { type: "rate_limit_error" }, { "retry-after-ms": "30" }),
      completion(),
    ]);
    const t0 = Date.now();
    await a.port.generate(REQ);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
    const b = adapter([
      apiError(
        429,
        { type: "rate_limit_error" },
        { "retry-after": new Date(NOW.getTime() + 20).toUTCString() },
      ),
      completion(),
    ]);
    // HTTP dates have second precision: NOW + 20 ms rounds down to NOW → no wait, still one retry.
    await b.port.generate(REQ);
    expect(b.calls).toHaveLength(2);
  });

  it("a retry-after over 10 s is not waited for: rate_limited with retryAfterMs", async () => {
    const { port, calls } = adapter([
      apiError(429, { type: "rate_limit_error" }, { "retry-after": "30" }),
      completion(),
    ]);
    expect(await failure(port.generate(REQ))).toMatchObject({
      code: "rate_limited",
      retryable: true,
      retryAfterMs: 30_000,
    });
    expect(calls).toHaveLength(1);
  });

  it("503 (vLLM/llama.cpp numeric code, model loading) is retried; a second failure surfaces", async () => {
    const loading = () =>
      apiError(
        503,
        { code: 503, message: "Loading model", type: "unavailable_error" },
        { "retry-after": "0" },
      );
    const ok = adapter([loading(), completion()]);
    expect((await ok.port.generate(REQ)).finish).toBe("stop");
    const bad = adapter([loading(), loading(), completion()]);
    expect(await failure(bad.port.generate(REQ))).toMatchObject({
      code: "unavailable",
      retryable: true,
    });
    expect(bad.calls).toHaveLength(2);
  });

  it.each([500, 502, 504, 408, 409])("HTTP %s is retryable unavailable", async (status) => {
    const { port, calls } = adapter([
      new Response("<html>Bad Gateway</html>", { status, headers: { "retry-after": "0" } }),
      completion(),
    ]);
    expect((await port.generate(REQ)).finish).toBe("stop");
    expect(calls).toHaveLength(2);
  });

  it("a 3xx (redirect) is refused, not retried", async () => {
    const { port, calls } = adapter([
      new Response(null, { status: 302, headers: { location: "http://evil.example/" } }),
      completion(),
    ]);
    expect(await failure(port.generate(REQ))).toMatchObject({
      code: "unavailable",
      retryable: false,
    });
    expect(calls).toHaveLength(1);
  });

  it("a connection error (ECONNREFUSED) is retried once as unavailable", async () => {
    const refused = new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    });
    const ok = adapter([refused, completion()]);
    expect((await ok.port.generate(REQ)).finish).toBe("stop");
    const bad = adapter([refused, refused]);
    const e = await failure(bad.port.generate(REQ));
    expect(e).toMatchObject({ code: "unavailable", retryable: true });
    expect(e.message).toContain("ECONNREFUSED");
  });

  it.each([
    ["timeout", "timeout", false, 1],
    ["response_too_large", "unavailable", false, 1],
    ["too_many_redirects", "unavailable", false, 1],
    ["blocked_address", "unavailable", false, 1],
    ["dns_failed", "unavailable", true, 2],
  ] as const)("guard error %s → %s (retryable %s)", async (guardCode, code, retryable, n) => {
    const err = () => new OutboundHttpError(guardCode, "guard");
    const { port, calls } = adapter([err(), err()]);
    expect(await failure(port.generate(REQ))).toMatchObject({ code, retryable });
    expect(calls).toHaveLength(n);
  });
});

describe("createOpenAiCompatibleModel: deadline and abort", () => {
  it("the adapter's own timeout aborts a hanging call → timeout", async () => {
    const { port, calls } = adapter(["hang", completion()], { timeoutMs: 50 });
    const e = await failure(port.generate(REQ));
    expect(e).toMatchObject({ code: "timeout", retryable: false });
    expect(e.message).toContain("50 ms");
    expect(calls).toHaveLength(1);
  });

  it("the caller's abort mid-flight → timeout (cancelled), no retry", async () => {
    const { port, calls } = adapter(["hang", completion()]);
    const ac = new AbortController();
    const p = port.generate({ ...REQ, signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    const e = await failure(p);
    expect(e).toMatchObject({ code: "timeout", retryable: false });
    expect(e.message).toContain("cancelled");
    expect(calls).toHaveLength(1);
  });

  it("an abort during the retry wait stops at once", async () => {
    const { port, calls } = adapter([
      apiError(429, { type: "rate_limit_error" }, { "retry-after": "5" }),
      completion(),
    ]);
    const ac = new AbortController();
    const t0 = Date.now();
    const p = port.generate({ ...REQ, signal: ac.signal });
    setTimeout(() => ac.abort(), 30);
    expect(await failure(p)).toMatchObject({ code: "timeout" });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(calls).toHaveLength(1);
  });

  it("an already-aborted signal never reaches the server", async () => {
    const { port, calls } = adapter([completion()]);
    expect(await failure(port.generate({ ...REQ, signal: AbortSignal.abort() }))).toMatchObject({
      code: "timeout",
    });
    expect(calls).toHaveLength(0);
  });
});

describe("createOpenAiCompatibleModel: provider info", () => {
  it("self-hosted: operator-run, no sub-processor", () => {
    const { port } = adapter([]);
    expect(port.info).toEqual({
      id: "openai-compatible",
      label: "Ollama at ollama:11434",
      model: "qwen3.5:9b",
      hosting: "self_hosted",
      location: null,
      jurisdiction: null,
      trainsOnInputs: false,
      retention: expect.stringContaining("not sent to an outside AI provider"),
      subProcessor: null,
    });
  });

  it("third party: a sub-processor named by the label, with its location and jurisdiction", () => {
    const { port } = adapter([], {
      hosting: "third_party",
      label: "Example AI Inc.",
      location: "Frankfurt, Germany",
      jurisdiction: "eu",
    });
    expect(port.info.subProcessor).toEqual({
      name: "Example AI Inc.",
      purpose: "AI assist (workspaces that turn it on)",
      dataProcessed:
        "Prompts built from workspace content: update text, KPI values, data-room passages, investor questions",
      location: "Frankfurt, Germany",
      jurisdiction: "eu",
    });
    // The software cannot know a third-party host's terms: not stated, never "false".
    expect(port.info.trainsOnInputs).toBeNull();
    expect(port.info.retention).toContain("Example AI Inc.");
    expect(port.info.retention).toContain("store: false");
  });

  it("third party without a declared location/jurisdiction: 'not stated' and varies", () => {
    const { port } = adapter([], { hosting: "third_party", label: "X" });
    expect(port.info.subProcessor).toMatchObject({
      location: "Not stated by the host",
      jurisdiction: "varies",
    });
  });
});

/* The shared ModelPort contract suite through the same fake wire. */
function contractHarness() {
  const queue: ModelContractReply[] = [];
  const received: ModelContractObserved[] = [];
  const logs: Record<string, unknown>[] = [];
  const fetch: OutboundFetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: { role: string; content: string }[];
      max_tokens: number;
      response_format?: { json_schema?: { schema?: Record<string, unknown> } };
    };
    const [system, ...messages] = body.messages;
    received.push({
      system: system?.role === "system" ? system.content : "",
      messages,
      maxOutputTokens: body.max_tokens,
      schema: body.response_format?.json_schema?.schema ?? null,
    });
    const reply = nextContractReply(queue);
    switch (reply.kind) {
      case "ok":
        return completion({
          content: reply.finish === "refusal" ? null : reply.text,
          refusal: reply.finish === "refusal" ? "I can't help with that." : null,
          finish: reply.finish === "length" ? "length" : "stop",
          usage: { prompt_tokens: reply.inputTokens, completion_tokens: reply.outputTokens },
          model: reply.model,
        });
      case "error":
        switch (reply.code) {
          case "rate_limited":
            return apiError(
              429,
              { type: "rate_limit_error", code: "rate_limit_exceeded" },
              {
                "retry-after": String((reply.retryAfterMs ?? 0) / 1000),
              },
            );
          case "unavailable":
            return apiError(
              503,
              { code: 503, message: "Loading model", type: "unavailable_error" },
              {
                "retry-after": "0",
              },
            );
          case "auth":
            return apiError(401, { code: 401, type: "authentication_error" });
          case "quota":
            return apiError(429, { type: "insufficient_quota", code: "insufficient_quota" });
          case "bad_request":
            return apiError(400, { type: "invalid_request_error", code: null });
          case "not_found":
            return apiError(404, { type: "not_found_error" });
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
  const port = createOpenAiCompatibleModel(
    { fetch, now: () => new Date(), log: (e) => logs.push(e) },
    { ...CFG, apiKey: KEY },
  );
  return {
    port,
    backend: { reply: (...r: ModelContractReply[]) => queue.push(...r), received },
    logs,
    secrets: [KEY],
  };
}

describeModelPortContract("openai-compatible (scripted fetch)", contractHarness, {
  retriesOnce: true,
});
