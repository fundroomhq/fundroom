/*
 * Shared `IntegrationAdapter` contract suite for the KPI adapters (copied verbatim between
 * `@fundroom/integration-quickbooks`, `-xero` and `-stripe`; no shared test package by design).
 * Every adapter must: describe itself completely, expose the frozen metric catalogue, map vendor
 * statuses and guard errors to the typed failures, never follow a redirect, never leak the token in
 * a failure detail, and never throw for a remote problem.
 */
import {
  type IntegrationAdapter,
  type IntegrationAuth,
  type IntegrationProvider,
  type KpiReadRequest,
  type KpiSourceMetric,
  type OutboundFetch,
  OutboundHttpError,
} from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import { fakeFetch, type Handler, json } from "./fake-fetch.js";

export interface ContractSubject {
  provider: IntegrationProvider;
  metrics: readonly KpiSourceMetric[];
  create(fetch: OutboundFetch, now: Date): IntegrationAdapter;
  auth: IntegrationAuth;
  now: Date;
  /** A valid read of every metric over a few past months. */
  kpiRequest: KpiReadRequest;
  /** Hosts a production adapter may talk to. */
  hosts: readonly string[];
  /** A handler that makes both `verify` and `kpi.read` succeed. */
  happy: Handler;
}

const SECRET_MARKER = "tok_SECRET_do_not_leak";

export function runAdapterContract(subject: ContractSubject): void {
  const auth: IntegrationAuth = {
    ...subject.auth,
    accessToken: `${subject.auth.accessToken}${SECRET_MARKER}`,
  };

  const run = async (handler: Handler) => {
    const fake = fakeFetch(handler);
    const adapter = subject.create(fake.fetch, subject.now);
    const kpi = adapter.kpi;
    if (kpi === undefined) throw new Error("adapter has no kpi capability");
    const verify = await adapter.verify(auth);
    const read = await kpi.read(auth, subject.kpiRequest);
    return { verify, read, calls: fake.calls };
  };

  describe(`IntegrationAdapter contract (${subject.provider})`, () => {
    it("describes itself completely", () => {
      const adapter = subject.create(fakeFetch(subject.happy).fetch, subject.now);
      const meta = adapter.meta;
      expect(meta.provider).toBe(subject.provider);
      expect(meta.capabilities).toContain("kpi");
      expect(meta.displayName.length).toBeGreaterThan(0);
      expect(meta.scopeExplanation.length).toBeGreaterThan(1);
      for (const value of Object.values(meta.subProcessor))
        expect(value?.length).toBeGreaterThan(0);
      expect(meta.subProcessor.dpaUrl).toMatch(/^https:\/\//u);
      if (meta.auth === "oauth2") {
        const oauth = meta.oauth;
        expect(oauth).toBeDefined();
        for (const url of [oauth?.authorizeUrl, oauth?.tokenUrl, oauth?.revokeUrl]) {
          if (url !== undefined) expect(new URL(url).protocol).toBe("https:");
        }
        expect(oauth?.scopes.length).toBeGreaterThan(0);
        expect(adapter.exchangeCode).toBeTypeOf("function");
        expect(adapter.refresh).toBeTypeOf("function");
        expect(adapter.revoke).toBeTypeOf("function");
      } else {
        expect(meta.credentialFields?.length).toBeGreaterThan(0);
        expect(meta.oauth).toBeUndefined();
      }
    });

    it("exposes the frozen metric catalogue", () => {
      const adapter = subject.create(fakeFetch(subject.happy).fetch, subject.now);
      expect(adapter.kpi?.metrics).toEqual(subject.metrics);
    });

    it("reads successfully, only over https to the vendor, never following redirects", async () => {
      const { verify, read, calls } = await run(subject.happy);
      expect(verify.ok).toBe(true);
      expect(read.ok).toBe(true);
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.url.protocol).toBe("https:");
        expect(subject.hosts).toContain(call.url.hostname);
        expect(call.redirect).toBe("manual");
      }
      if (read.ok) {
        expect(read.value.series.map((s) => s.metric)).toEqual(subject.kpiRequest.metrics);
        for (const series of read.value.series) {
          for (const point of series.points) {
            expect(point.month).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/u);
            expect(point.value).toMatch(/^-?\d+(\.\d+)?$/u);
          }
        }
      }
    });

    it.each([
      [401, "unauthorized"],
      [403, "forbidden"],
      [404, "not_found"],
      [429, "rate_limited"],
      [500, "unavailable"],
      [503, "unavailable"],
      [302, "transport"],
    ] as const)("maps HTTP %i to %s", async (status, reason) => {
      const { verify, read } = await run(() =>
        json({ error: { message: `vendor says ${SECRET_MARKER}` } }, status, {
          location: "https://evil.example/",
        }),
      );
      expect(verify).toMatchObject({ ok: false, reason });
      expect(read).toMatchObject({ ok: false, reason });
    });

    it.each([
      ["timeout", "transport"],
      ["blocked_address", "transport"],
      ["too_many_redirects", "transport"],
      ["response_too_large", "too_large"],
    ] as const)("maps the outbound guard's %s to %s", async (code, reason) => {
      const { verify, read } = await run(() => {
        throw new OutboundHttpError(code, `guard ${code}`);
      });
      expect(verify).toMatchObject({ ok: false, reason });
      expect(read).toMatchObject({ ok: false, reason });
    });

    it("maps a plain network error to transport", async () => {
      const { verify, read } = await run(() => {
        throw new TypeError("fetch failed");
      });
      expect(verify).toMatchObject({ ok: false, reason: "transport" });
      expect(read).toMatchObject({ ok: false, reason: "transport" });
    });

    it("maps a non-JSON 200 to malformed", async () => {
      const { verify, read } = await run(
        () => new Response("<html>maintenance</html>", { status: 200 }),
      );
      expect(verify).toMatchObject({ ok: false, reason: "malformed" });
      expect(read).toMatchObject({ ok: false, reason: "malformed" });
    });

    it("refuses a declared body over 2 MiB as too_large", async () => {
      const { verify, read } = await run(
        () =>
          new Response("{}", {
            status: 200,
            headers: { "content-length": String(3 * 1024 * 1024) },
          }),
      );
      expect(verify).toMatchObject({ ok: false, reason: "too_large" });
      expect(read).toMatchObject({ ok: false, reason: "too_large" });
    });

    it("never puts the token or a vendor message in a failure detail", async () => {
      for (const status of [400, 401, 403, 429, 500]) {
        const { verify, read } = await run(() => json({ message: SECRET_MARKER }, status));
        for (const result of [verify, read]) {
          expect(result.ok).toBe(false);
          expect(JSON.stringify(result)).not.toContain(SECRET_MARKER);
        }
      }
    });

    it("answers aborted without calling the vendor when the signal is already aborted", async () => {
      const fake = fakeFetch(subject.happy);
      const adapter = subject.create(fake.fetch, subject.now);
      const controller = new AbortController();
      controller.abort();
      const read = await adapter.kpi?.read(auth, {
        ...subject.kpiRequest,
        signal: controller.signal,
      });
      expect(read).toEqual({ ok: false, reason: "unavailable", detail: "aborted" });
      expect(fake.calls).toHaveLength(0);
    });

    it("passes the signal to every fetch and answers aborted (not transport) when a call is aborted", async () => {
      const controller = new AbortController();
      let n = 0;
      const fake = fakeFetch(async (req) => {
        expect(req.signal).toBe(controller.signal);
        n += 1;
        if (n === 2) {
          controller.abort();
          throw new DOMException("This operation was aborted", "AbortError");
        }
        return subject.happy(req);
      });
      const adapter = subject.create(fake.fetch, subject.now);
      const read = await adapter.kpi?.read(auth, {
        ...subject.kpiRequest,
        signal: controller.signal,
      });
      expect(read).toEqual({ ok: false, reason: "unavailable", detail: "aborted" });
      expect(fake.calls).toHaveLength(2);
    });

    it("answers not_found for an unknown metric without calling the vendor", async () => {
      const fake = fakeFetch(subject.happy);
      const adapter = subject.create(fake.fetch, subject.now);
      const read = await adapter.kpi?.read(auth, { ...subject.kpiRequest, metrics: ["nope"] });
      expect(read).toMatchObject({ ok: false, reason: "not_found" });
      expect(fake.calls).toHaveLength(0);
    });

    it("answers malformed for an invalid month range without calling the vendor", async () => {
      const fake = fakeFetch(subject.happy);
      const adapter = subject.create(fake.fetch, subject.now);
      const read = await adapter.kpi?.read(auth, { ...subject.kpiRequest, fromMonth: "2026-13" });
      expect(read).toMatchObject({ ok: false, reason: "malformed" });
      expect(fake.calls).toHaveLength(0);
    });
  });
}
