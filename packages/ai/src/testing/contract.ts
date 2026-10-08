import {
  type ModelFinish,
  type ModelPort,
  ModelProviderError,
  type ModelRequest,
} from "@fundroom/ports";
import { describe, expect, it } from "vitest";

/**
 * The ModelPort contract suite (E3.12 contract §8). Every model adapter runs it against its own
 * scripted backend (a recording fake `OutboundFetch` speaking the vendor's wire format); the fake
 * model runs it too. The suite speaks only port terms: each harness translates a scripted
 * `ModelContractReply` into its wire answer and decodes what reached the wire back into a
 * `ModelContractObserved`.
 *
 * `setup()` builds a fresh port + backend per test. Passing a bare `() => ModelPort` (no
 * backend) runs only the static half (provider info).
 *
 * Latitude the suite allows, deliberately:
 * - a port either retries a retryable failure ONCE itself (`retriesOnce: true`, the real
 *   adapters) or surfaces it at once as a `ModelProviderError` with `retryable: true` (the fake);
 *   never more than one retry;
 * - on abort a port rejects promptly; a `ModelProviderError` it throws then has code `timeout`.
 */

/** One scripted backend answer. Retryable: `rate_limited`, `unavailable`. */
export type ModelContractReply =
  | {
      readonly kind: "ok";
      readonly text: string;
      readonly finish: Exclude<ModelFinish, "filtered">;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly model: string;
    }
  | {
      readonly kind: "error";
      readonly code:
        | "rate_limited"
        | "unavailable"
        | "auth"
        | "quota"
        | "bad_request"
        | "not_found";
      /** For `rate_limited`: the retry-after the backend announces. */
      readonly retryAfterMs?: number;
    }
  /** The backend never answers; it gives up only when the transport's signal aborts. */
  | { readonly kind: "hang" };

/** What reached the backend, in port terms. */
export interface ModelContractObserved {
  readonly system: string;
  readonly messages: readonly { readonly role: string; readonly content: string }[];
  readonly maxOutputTokens: number;
  /** The JSON schema the backend was asked to enforce; null when none. */
  readonly schema: Readonly<Record<string, unknown>> | null;
}

export interface ModelContractBackend {
  /** Queue the next answer(s), consumed one per request in order. */
  reply(...replies: ModelContractReply[]): void;
  /** Every request that reached the backend, in order. */
  readonly received: readonly ModelContractObserved[];
}

export interface ModelContractHarness {
  readonly port: ModelPort;
  readonly backend: ModelContractBackend;
  /** Every structured log event the port emitted (checked for prompt/response text). */
  readonly logs?: readonly unknown[];
  /** Credentials the port was given; no error message or log event may contain one. */
  readonly secrets?: readonly string[];
}

export interface ModelContractOptions {
  /** True when the port retries a retryable failure once itself (the HTTP adapters). */
  readonly retriesOnce: boolean;
}

export type ModelContractSetup = () => ModelContractHarness | ModelPort;

const PROMPT_MARKER = "contract-prompt-7f3a91";
const OUTPUT_MARKER = "contract-output-c2e815";

const SCHEMA: Readonly<Record<string, unknown>> = {
  type: "object",
  additionalProperties: false,
  required: ["title", "sections"],
  properties: {
    title: { type: "string" },
    sections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["heading", "markdown"],
        properties: { heading: { type: "string" }, markdown: { type: "string" } },
      },
    },
  },
};

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    system: `You write investor updates. ${PROMPT_MARKER}`,
    messages: [{ role: "user", content: `<notes>Revenue grew. ${PROMPT_MARKER}</notes>` }],
    maxOutputTokens: 777,
    ...overrides,
  };
}

function ok(overrides: Partial<Extract<ModelContractReply, { kind: "ok" }>> = {}) {
  return {
    kind: "ok",
    text: `{"title":"${OUTPUT_MARKER}","sections":[]}`,
    finish: "stop",
    inputTokens: 123,
    outputTokens: 45,
    model: "contract-model-1",
    ...overrides,
  } as const satisfies ModelContractReply;
}

function isHarness(v: ModelContractHarness | ModelPort): v is ModelContractHarness {
  return "backend" in v && "port" in v;
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected the promise to reject");
}

function assertNoLeaks(h: ModelContractHarness, error?: unknown): void {
  const texts = [
    ...(h.logs ?? []).map((e) => JSON.stringify(e)),
    ...(error instanceof Error ? [error.message, String(error.stack ?? "")] : []),
  ];
  for (const t of texts) {
    expect(t).not.toContain(PROMPT_MARKER);
    expect(t).not.toContain(OUTPUT_MARKER);
    for (const s of h.secrets ?? []) if (s.length > 0) expect(t).not.toContain(s);
  }
}

export function describeModelPortContract(
  name: string,
  setup: ModelContractSetup,
  options: ModelContractOptions = { retriesOnce: false },
): void {
  describe(`ModelPort contract: ${name}`, () => {
    const port = () => {
      const made = setup();
      return isHarness(made) ? made.port : made;
    };
    const harness = (): ModelContractHarness => {
      const made = setup();
      if (!isHarness(made)) throw new Error("this contract case needs a scripted backend");
      return made;
    };

    it("never claims training on inputs, states a retention sentence and a consistent hosting", () => {
      const { info } = port();
      // false = known not to train; null = not stated (third-party host). Never anything else.
      expect([false, null]).toContain(info.trainsOnInputs);
      // Operator-run: nothing leaves the host, so it is known.
      if (info.hosting === "self_hosted") expect(info.trainsOnInputs).toBe(false);
      expect(info.retention.trim().length).toBeGreaterThan(10);
      expect(info.label.trim()).not.toBe("");
      expect(info.model.trim()).not.toBe("");
      if (info.hosting === "self_hosted") {
        // Operator-run: never listed as a sub-processor (absent only on a test double).
        expect(info.subProcessor ?? null).toBeNull();
      } else if (info.subProcessor !== undefined) {
        expect(info.subProcessor).not.toBeNull();
        expect(info.subProcessor?.name.trim()).not.toBe("");
      }
    });

    const probe = setup();
    if (!isHarness(probe)) return;

    it("happy path: returns the text, finish, usage and model as reported, one request", async () => {
      const h = harness();
      h.backend.reply(ok());
      const req = request();
      const r = await h.port.generate(req);
      expect(r).toEqual({
        text: `{"title":"${OUTPUT_MARKER}","sections":[]}`,
        finish: "stop",
        usage: { inputTokens: 123, outputTokens: 45 },
        model: "contract-model-1",
      });
      expect(h.backend.received).toHaveLength(1);
      const seen = h.backend.received[0];
      expect(seen?.system).toContain(req.system);
      expect(seen?.messages).toEqual(req.messages);
      expect(seen?.maxOutputTokens).toBe(777);
      expect(seen?.schema).toBeNull();
      assertNoLeaks(h);
    });

    it("passes a multi-turn conversation through in order", async () => {
      const h = harness();
      h.backend.reply(ok());
      const messages = [
        { role: "user", content: "first" },
        { role: "assistant", content: "not json" },
        { role: "user", content: "Reply with JSON only that matches the schema." },
      ] as const;
      await h.port.generate(request({ messages }));
      expect(h.backend.received[0]?.messages).toEqual(messages);
    });

    it("passes the JSON schema through unchanged", async () => {
      const h = harness();
      h.backend.reply(ok());
      await h.port.generate(request({ json: { name: "update_draft", schema: SCHEMA } }));
      expect(h.backend.received[0]?.schema).toEqual(SCHEMA);
    });

    it("maps a truncated answer to finish length", async () => {
      const h = harness();
      h.backend.reply(ok({ finish: "length", text: '{"title":"cut' }));
      const r = await h.port.generate(request());
      expect(r.finish).toBe("length");
      expect(r.usage).toEqual({ inputTokens: 123, outputTokens: 45 });
    });

    it("maps a model refusal to finish refusal and does not retry it", async () => {
      const h = harness();
      h.backend.reply(ok({ finish: "refusal", text: "" }));
      const r = await h.port.generate(request());
      expect(r.finish).toBe("refusal");
      expect(h.backend.received).toHaveLength(1);
    });

    it("a retryable failure is retried once (or surfaced as retryable), then succeeds", async () => {
      const h = harness();
      h.backend.reply({ kind: "error", code: "rate_limited", retryAfterMs: 0 }, ok());
      if (options.retriesOnce) {
        const r = await h.port.generate(request());
        expect(r.finish).toBe("stop");
        expect(h.backend.received).toHaveLength(2);
      } else {
        const e = await rejection(h.port.generate(request()));
        expect(e).toBeInstanceOf(ModelProviderError);
        expect(e).toMatchObject({ code: "rate_limited", retryable: true });
        expect(h.backend.received).toHaveLength(1);
      }
    });

    it("never retries more than once", async () => {
      const h = harness();
      h.backend.reply(
        { kind: "error", code: "unavailable" },
        { kind: "error", code: "unavailable" },
        ok(),
      );
      const e = await rejection(h.port.generate(request()));
      expect(e).toBeInstanceOf(ModelProviderError);
      expect(e).toMatchObject({ code: "unavailable", retryable: true });
      expect(h.backend.received).toHaveLength(options.retriesOnce ? 2 : 1);
      assertNoLeaks(h, e);
    });

    it.each([
      ["auth", "auth"],
      ["quota", "quota"],
      ["bad_request", "bad_request"],
      ["not_found", "not_found"],
    ] as const)(
      "a non-retryable %s failure rejects at once with its code",
      async (code, expected) => {
        const h = harness();
        h.backend.reply({ kind: "error", code }, ok());
        const e = await rejection(h.port.generate(request()));
        expect(e).toBeInstanceOf(ModelProviderError);
        expect(e).toMatchObject({ code: expected, retryable: false });
        expect(h.backend.received).toHaveLength(1);
        assertNoLeaks(h, e);
      },
    );

    it("rejects promptly when the caller aborts mid-flight", async () => {
      const h = harness();
      h.backend.reply({ kind: "hang" });
      const controller = new AbortController();
      const started = Date.now();
      const pending = h.port.generate(request({ signal: controller.signal }));
      setTimeout(() => controller.abort(new Error("job cancelled")), 20);
      const e = await rejection(pending);
      expect(Date.now() - started).toBeLessThan(5_000);
      if (e instanceof ModelProviderError) expect(e.code).toBe("timeout");
      expect(h.backend.received.length).toBeLessThanOrEqual(1);
    });

    it("rejects without calling the backend when the signal is already aborted", async () => {
      const h = harness();
      h.backend.reply(ok());
      const e = await rejection(h.port.generate(request({ signal: AbortSignal.abort() })));
      expect(e).toBeDefined();
      if (e instanceof ModelProviderError) expect(e.code).toBe("timeout");
      expect(h.backend.received).toHaveLength(0);
    });
  });
}

/** Parses a scripted reply queue for harnesses: the next reply, or a loud failure. */
export function nextContractReply(queue: ModelContractReply[]): ModelContractReply {
  const next = queue.shift();
  if (next === undefined) throw new Error("contract backend: no scripted reply left");
  return next;
}
