import type { ScannerInfo, ScanResult, VirusScanPort } from "@fundroom/ports";
import { afterAll, describe, expect, it } from "vitest";
import { avscanHealthOf, instrumentScanner } from "./avscan-signals.js";
import { startTelemetry } from "./telemetry.js";

const telemetry = startTelemetry({ serviceName: "t", serviceVersion: "0" });
afterAll(() => telemetry.shutdown());

function fakeScanner(overrides: Partial<VirusScanPort> & { results?: ScanResult[] } = {}) {
  const results = [...(overrides.results ?? [])];
  let healthy = true;
  let info: ScannerInfo | null = null;
  const scanner: VirusScanPort = {
    driver: "clamd",
    maxScanBytes: 1024,
    async scan() {
      return results.shift() ?? { verdict: "clean", engine: "fake" };
    },
    async healthCheck() {
      if (!healthy) throw new Error("connect ECONNREFUSED");
    },
    async info() {
      return info;
    },
    ...overrides,
  };
  return {
    scanner,
    setHealthy: (h: boolean) => {
      healthy = h;
    },
    setInfo: (i: ScannerInfo | null) => {
      info = i;
    },
  };
}

/** `name{labels} value` lines of the Prometheus text for one metric (labels in any order). */
function series(text: string, name: string, labels: Record<string, string> = {}): number[] {
  return text
    .split("\n")
    .filter((l) => l.startsWith(`${name}{`) || l.startsWith(`${name} `))
    .filter((l) => Object.entries(labels).every(([k, v]) => l.includes(`${k}="${v}"`)))
    .map((l) => Number(l.slice(l.lastIndexOf(" ") + 1)));
}

describe("instrumented scanner", () => {
  it("counts scans, errors by reason and infected files as security events", async () => {
    const { scanner } = fakeScanner({
      results: [
        { verdict: "clean", engine: "fake" },
        { verdict: "infected", engine: "fake", detail: "Eicar-Test-Signature" },
        { verdict: "error", engine: "fake", reason: "too_large", retryable: false },
        { verdict: "error", engine: "fake" },
        { verdict: "clean", engine: "fake" },
      ],
    });
    const signals = instrumentScanner(scanner);
    const s = signals.scanner;
    expect(s.driver).toBe("clamd");
    expect(s.maxScanBytes).toBe(1024);
    const body = new Uint8Array(1);
    await s.scan({ body, source: "data-room" });
    await s.scan({ body, source: "data-room" });
    await s.scan({ body, source: "esign" });
    await s.scan({ body, source: "round" });
    await s.scan({ body, source: "Not A Label!" });
    const text = await telemetry.metricsText();
    expect(
      series(text, "fundroom_avscan_scans_total", { verdict: "clean", source: "data-room" }),
    ).toEqual([1]);
    expect(
      series(text, "fundroom_avscan_scans_total", { verdict: "infected", source: "data-room" }),
    ).toEqual([1]);
    expect(
      series(text, "fundroom_avscan_scans_total", { verdict: "clean", source: "other" }),
    ).toEqual([1]);
    expect(
      series(text, "fundroom_avscan_errors_total", { kind: "too_large", source: "esign" }),
    ).toEqual([1]);
    expect(
      series(text, "fundroom_avscan_errors_total", { kind: "unknown", source: "round" }),
    ).toEqual([1]);
    expect(
      series(text, "fundroom_avscan_duration_count", { verdict: "error", source: "esign" }),
    ).toEqual([1]);
    expect(
      series(text, "fundroom_security_events_total", {
        event: "avscan_infected",
        code: "data-room",
      }),
    ).toEqual([1]);
    // No probe without `probe: true` (the noop scanner): no gauges, health is skipped.
    expect(signals.health()).toEqual({ status: "skipped", driver: "clamd" });
    expect(series(text, "fundroom_avscan_up")).toEqual([]);
    signals.stop();
  });

  it("probes into a cache the gauges and /platform/health read, and stops", async () => {
    const fake = fakeScanner();
    const now = Date.parse("2026-10-22T08:00:00Z");
    fake.setInfo({
      engine: "fake",
      version: "1.4.2",
      signatureVersion: "27431",
      signatureDate: new Date(now - 3600_000),
    });
    const signals = instrumentScanner(fake.scanner, { probe: true, now: () => now });
    expect(signals.health().status).toBe("fail");
    signals.start(); // first probe right away, then every minute (unref'd)
    expect((await signals.refresh()).status).toBe("ok");
    expect(avscanHealthOf(signals.scanner)).toMatchObject({
      status: "ok",
      driver: "clamd",
      detail: "ClamAV 1.4.2",
    });
    expect(avscanHealthOf(fake.scanner)).toBeNull();
    let text = await telemetry.metricsText();
    expect(series(text, "fundroom_avscan_up", { driver: "clamd" })).toEqual([1]);
    expect(series(text, "fundroom_avscan_signature_age_seconds", { driver: "clamd" })).toEqual([
      3600,
    ]);

    fake.setHealthy(false);
    const failed = await signals.refresh();
    expect(failed).toMatchObject({ status: "fail", detail: "connect ECONNREFUSED" });
    text = await telemetry.metricsText();
    expect(series(text, "fundroom_avscan_up", { driver: "clamd" })).toEqual([0]);
    // The last known signature date keeps ageing while the daemon is down.
    expect(series(text, "fundroom_avscan_signature_age_seconds", { driver: "clamd" })).toEqual([
      3600,
    ]);

    signals.stop();
    signals.stop(); // idempotent
  });

  it("times out a probe that hangs, without throwing", async () => {
    const fake = fakeScanner({ healthCheck: () => new Promise<void>(() => {}) });
    const signals = instrumentScanner(fake.scanner, { probe: true, probeTimeoutMs: 50 });
    const h = await signals.refresh();
    expect(h.status).toBe("fail");
    expect(h.detail).toContain("timed out");
    signals.stop();
  });
});
