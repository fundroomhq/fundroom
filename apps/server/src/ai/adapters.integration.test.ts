import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createAnthropicModel } from "@fundroom/ai-anthropic";
import { createOpenAiCompatibleModel } from "@fundroom/ai-openai-compatible";
import { createOutboundHttp } from "@fundroom/outbound-http";
import { type ModelPort, ModelProviderError, type ModelRequest } from "@fundroom/ports";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createAiModel } from "./wiring.js";

/*
 * Both model adapters over REAL HTTP (E3.12 §8): a node:http stub speaking the OpenAI chat
 * completions and Anthropic Messages protocols on 127.0.0.1, reached through the real
 * `createOutboundHttp` guard exactly as `createAiModel` (wiring.ts) builds it — the configured
 * base host is the one private host allowed, no redirects, a 4 MiB answer cap, the AI deadline.
 *
 * Proves: an operator-run private model server is reachable (and only because its host is
 * named); a 3xx is refused, never followed; an oversized answer is refused (declared length and
 * counted chunked stream); a hanging server times out; a 503 is retried once over the wire; a
 * caller abort tears the call down.
 */

const KEY = "sk-integration-secret-778899";

type Behaviour =
  | { kind: "ok" }
  | { kind: "redirect" }
  | { kind: "huge"; chunked: boolean }
  | { kind: "hang" }
  | { kind: "status"; status: number; headers?: Record<string, string> };

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: Record<string, unknown>;
}

let server: Server;
let base: string;
const seen: Seen[] = [];
let script: Behaviour[] = [];
const hanging = new Set<ServerResponse>();

function openAiAnswer(body: Record<string, unknown>) {
  return {
    id: "chatcmpl-it",
    object: "chat.completion",
    model: String(body["model"]),
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: '{"ok":true}', refusal: null },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 31, completion_tokens: 5, total_tokens: 36 },
  };
}

function anthropicAnswer(body: Record<string, unknown>) {
  return {
    id: "msg_it",
    type: "message",
    role: "assistant",
    model: String(body["model"]),
    content: [{ type: "text", text: '{"ok":true}' }],
    stop_reason: "end_turn",
    usage: { input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 2 },
  };
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  const body = raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>);
  const path = req.url ?? "";
  seen.push({ method: req.method ?? "", path, headers: req.headers, body });
  if (path === "/elsewhere") {
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
    return;
  }
  const behaviour = script.shift() ?? { kind: "ok" };
  switch (behaviour.kind) {
    case "ok": {
      const answer = path.endsWith("/v1/messages") ? anthropicAnswer(body) : openAiAnswer(body);
      res
        .writeHead(200, { "content-type": "application/json", "request-id": "req_it_1" })
        .end(JSON.stringify(answer));
      return;
    }
    case "redirect":
      res.writeHead(307, { location: `${base}/elsewhere` }).end();
      return;
    case "huge": {
      const payload = Buffer.alloc(5 * 1024 * 1024, 0x61);
      if (behaviour.chunked) {
        res.writeHead(200, { "content-type": "application/json" });
        res.write('{"x":"');
        for (let i = 0; i < 5; i++)
          res.write(payload.subarray(i * 1024 * 1024, (i + 1) * 1024 * 1024));
        res.end('"}');
      } else {
        res
          .writeHead(200, {
            "content-type": "application/json",
            "content-length": String(payload.length),
          })
          .end(payload);
      }
      return;
    }
    case "hang":
      hanging.add(res);
      return;
    case "status":
      res
        .writeHead(behaviour.status, { "content-type": "application/json", ...behaviour.headers })
        .end(
          JSON.stringify({
            error: { code: behaviour.status, type: "unavailable_error", message: "Loading model" },
          }),
        );
      return;
  }
}

beforeAll(async () => {
  server = createServer((req, res) => {
    handle(req, res).catch(() => res.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  base = `http://127.0.0.1:${address.port}`;
});

afterEach(() => {
  seen.length = 0;
  script = [];
  for (const res of hanging) res.destroy();
  hanging.clear();
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const REQ: ModelRequest = {
  system: "Answer in JSON.",
  messages: [{ role: "user", content: "Say ok." }],
  maxOutputTokens: 300,
  json: {
    name: "ok",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["ok"],
      properties: { ok: { type: "boolean" } },
    },
  },
};

const closers: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const close of closers) await close();
});

/** A port built by the real wiring: the stub's base URL is the operator-named host. */
function wired(provider: "openai-compatible" | "anthropic", timeoutMs = 10_000): ModelPort {
  const wiring = createAiModel(
    {
      APP_ENV: "test",
      OUTBOUND_HTTP_ALLOW_PRIVATE_HOSTS: undefined,
      AI_PROVIDER: provider,
      AI_BASE_URL: provider === "anthropic" ? `${base}/` : `${base}/v1`,
      AI_API_KEY: KEY,
      AI_MODEL: provider === "anthropic" ? "claude-opus-5" : "qwen3.5:9b",
      AI_HOSTING: undefined,
      AI_PROVIDER_LABEL: undefined,
      AI_PROVIDER_LOCATION: undefined,
      AI_PROVIDER_JURISDICTION: undefined,
      AI_JSON_MODE: "json_schema",
      AI_TOKEN_PARAM: "max_tokens",
      AI_TIMEOUT_MS: timeoutMs,
      AI_MAX_OUTPUT_TOKENS: 4000,
      AI_MAX_INPUT_CHARS: 60_000,
      AI_CONCURRENCY: 2,
      AI_MONTHLY_TOKEN_BUDGET: 2_000_000,
      AI_REQUESTS_PER_USER_HOUR: 30,
      AI_RESULT_RETENTION_HOURS: 168,
    },
    { userAgent: "fundroom-ai-it", now: () => new Date(), log: () => {} },
  );
  closers.push(() => wiring.close());
  if (wiring.model === null) throw new Error("no model");
  return wiring.model;
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

describe.each(["openai-compatible", "anthropic"] as const)("%s over real HTTP", (provider) => {
  const path = provider === "anthropic" ? "/v1/messages" : "/v1/chat/completions";

  it("reaches the operator's private model server (its host is the one allowed) and parses the answer", async () => {
    const port = wired(provider);
    const r = await port.generate(REQ);
    expect(r.text).toBe('{"ok":true}');
    expect(r.finish).toBe("stop");
    expect(r.usage).toEqual(
      provider === "anthropic"
        ? { inputTokens: 22, outputTokens: 5 }
        : { inputTokens: 31, outputTokens: 5 },
    );
    expect(seen).toHaveLength(1);
    const s = seen[0];
    expect(s?.method).toBe("POST");
    expect(s?.path).toBe(path);
    expect(s?.headers["user-agent"]).toBe("fundroom-ai-it");
    if (provider === "anthropic") {
      expect(s?.headers["x-api-key"]).toBe(KEY);
      expect(s?.headers["anthropic-version"]).toBe("2023-06-01");
      expect(s?.body["output_config"]).toEqual({
        format: { type: "json_schema", schema: REQ.json?.schema },
      });
      expect(s?.body).not.toHaveProperty("temperature");
    } else {
      expect(s?.headers["authorization"]).toBe(`Bearer ${KEY}`);
      expect(s?.body["response_format"]).toMatchObject({ type: "json_schema" });
      // 127.0.0.1 is operator-run → self_hosted → no store flag.
      expect(s?.body).not.toHaveProperty("store");
      expect(port.info.hosting).toBe("self_hosted");
      expect(port.info.trainsOnInputs).toBe(false);
    }
  });

  it("refuses a 3xx and never follows it", async () => {
    script = [{ kind: "redirect" }];
    const e = await failure(wired(provider).generate(REQ));
    expect(e).toMatchObject({ code: "unavailable", retryable: false });
    expect(e.message).toContain("redirect");
    expect(seen.map((s) => s.path)).toEqual([path]);
  });

  it.each([false, true])("refuses an answer over 4 MiB (chunked %s)", async (chunked) => {
    script = [{ kind: "huge", chunked }];
    const e = await failure(wired(provider).generate(REQ));
    expect(e).toMatchObject({ code: "unavailable", retryable: false });
    expect(e.message).toContain("size cap");
    expect(seen).toHaveLength(1);
  });

  it("times out on a server that never answers", async () => {
    script = [{ kind: "hang" }];
    const started = Date.now();
    const e = await failure(wired(provider, 400).generate(REQ));
    expect(e).toMatchObject({ code: "timeout", retryable: false });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(seen).toHaveLength(1);
  });

  it("retries a 503 (model loading) once over the wire", async () => {
    script = [{ kind: "status", status: 503, headers: { "retry-after": "0" } }, { kind: "ok" }];
    const r = await wired(provider).generate(REQ);
    expect(r.finish).toBe("stop");
    expect(seen).toHaveLength(2);
  });

  it("a caller abort tears the call down", async () => {
    script = [{ kind: "hang" }];
    const ac = new AbortController();
    const p = wired(provider).generate({ ...REQ, signal: ac.signal });
    setTimeout(() => ac.abort(new Error("job cancelled")), 50);
    const e = await failure(p);
    expect(e).toMatchObject({ code: "timeout", retryable: false });
  });
});

describe("the private host is reachable only because it is named", () => {
  it("the same guard without the host in allowedPrivateHosts refuses 127.0.0.1", async () => {
    const outbound = createOutboundHttp({
      allowPrivate: false,
      allowedPrivateHosts: [],
      maxRedirects: 0,
      timeoutMs: 5_000,
      maxResponseBytes: 4 * 1024 * 1024,
      maxConcurrentLookups: 4,
    });
    closers.push(() => outbound.close());
    const deps = { fetch: outbound.fetch, now: () => new Date() };
    const ports = [
      createOpenAiCompatibleModel(deps, {
        baseUrl: base,
        apiKey: KEY,
        model: "m",
        hosting: "self_hosted",
        label: "stub",
        location: null,
        jurisdiction: null,
        jsonMode: "json_schema",
        tokenParam: "max_tokens",
        timeoutMs: 5_000,
      }),
      createAnthropicModel(deps, { baseUrl: base, apiKey: KEY, model: "m", timeoutMs: 5_000 }),
    ];
    for (const port of ports) {
      const e = await failure(port.generate(REQ));
      expect(e).toMatchObject({ code: "unavailable", retryable: false });
      expect(e.message).toContain("outbound policy");
      expect(e.message).not.toContain(KEY);
    }
    expect(seen).toHaveLength(0);
  });
});
