import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { node, tracing } from "@opentelemetry/sdk-node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REDACTED_PATH, redactOutboundUrl } from "./telemetry.js";

/*
 * E3.11 R3-7: with OTLP export on, the undici instrumentation would record every outbound URL in
 * full — a presigned bundle link's signature, a Slack webhook's secret path. The real
 * instrumentation, with the hook `instrumentation.ts` installs, must keep only the origin.
 */
const exporter = new tracing.InMemorySpanExporter();
const provider = new node.NodeTracerProvider({
  spanProcessors: [new tracing.SimpleSpanProcessor(exporter)],
});
const instrumentation = new UndiciInstrumentation({ startSpanHook: redactOutboundUrl });
let server: Server;
let origin: string;

beforeAll(async () => {
  instrumentation.setTracerProvider(provider);
  instrumentation.enable();
  server = createServer((_req, res) => res.end("ok"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  instrumentation.disable();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await provider.shutdown();
});

describe("outbound span redaction", () => {
  it("keeps only the origin of an outbound URL", () => {
    expect(
      redactOutboundUrl({ origin: "https://hooks.slack.com", path: "/services/T0/B0/secret" }),
    ).toEqual({
      "url.full": `https://hooks.slack.com${REDACTED_PATH}`,
      "url.path": REDACTED_PATH,
      "url.query": "",
    });
  });

  it("records no path or query secret in a real undici span", async () => {
    const secretPath = "/services/T000/B000/XXXXwebhooksecretXXXX";
    const secretQuery = "?X-Amz-Signature=deadbeefsignature&X-Amz-Credential=AKIAEXAMPLE";
    const res = await fetch(`${origin}${secretPath}${secretQuery}`);
    expect(await res.text()).toBe("ok");
    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThan(0);
    const dump = JSON.stringify(spans.map((s) => s.attributes));
    expect(dump).not.toContain("webhooksecret");
    expect(dump).not.toContain("deadbeefsignature");
    expect(dump).not.toContain("AKIAEXAMPLE");
    expect(spans.at(-1)?.attributes["url.full"]).toBe(`${origin}${REDACTED_PATH}`);
    expect(spans.at(-1)?.attributes["server.address"]).toBe("127.0.0.1");
  });
});

describe("inbound span redaction (RR2-1)", () => {
  it("records no share-link token or query secret on a real @hono/otel server span", async () => {
    const { Hono } = await import("hono");
    const { inboundTracing } = await import("./telemetry.js");
    const spans = new tracing.InMemorySpanExporter();
    const tp = new node.NodeTracerProvider({
      spanProcessors: [new tracing.SimpleSpanProcessor(spans)],
    });
    const app = new Hono();
    app.use(
      "*",
      inboundTracing({ serviceName: "t", serviceVersion: "0", tracer: tp.getTracer("t") }),
    );
    app.get("/api/v1/links/:token", (c) => c.json({ ok: true }));
    const res = await app.request(
      "http://h.example/api/v1/links/SECRETSHARETOKEN?token=MAGICQ&code=OAUTHCODE",
    );
    expect(res.status).toBe(200);
    const finished = spans.getFinishedSpans();
    expect(finished).toHaveLength(1);
    const dump = JSON.stringify(finished.map((s) => ({ n: s.name, a: s.attributes })));
    for (const secret of ["SECRETSHARETOKEN", "MAGICQ", "OAUTHCODE"]) {
      expect(dump).not.toContain(secret);
    }
    expect(finished[0]?.attributes["url.full"]).toBe(`http://h.example${REDACTED_PATH}`);
    expect(finished[0]?.attributes["http.route"]).toBe("/api/v1/links/:token");
    await tp.shutdown();
  });
});
