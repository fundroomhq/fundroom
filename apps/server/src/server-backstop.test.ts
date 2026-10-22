import { afterAll, describe, expect, it } from "vitest";
import { installUnhandledRejectionBackstop } from "./server.js";
import { startTelemetry } from "./telemetry.js";

const telemetry = startTelemetry({ serviceName: "t", serviceVersion: "0" });
afterAll(() => telemetry.shutdown());

describe("unhandled rejection backstop (E-UP-25)", () => {
  it("registers once, logs at error level, counts, and does not exit", async () => {
    const before = process.listeners("unhandledRejection");
    const first: unknown[] = [];
    const second: Record<string, unknown>[] = [];
    installUnhandledRejectionBackstop(() => first.push(1));
    installUnhandledRejectionBackstop((event, fields) => second.push({ event, ...fields }));
    const added = process.listeners("unhandledRejection").filter((l) => !before.includes(l));
    expect(added).toHaveLength(1);
    // Called directly: emitting the event would also reach the test runner's own listener.
    const listener = added[0] as (reason: unknown, p: Promise<unknown>) => void;
    listener(new Error("clamd: write EPIPE"), Promise.resolve());
    expect(first).toEqual([]);
    expect(second).toMatchObject([
      { event: "process.unhandled_rejection", level: "error", error: "clamd: write EPIPE" },
    ]);
    const text = await telemetry.metricsText();
    expect(text).toMatch(/^fundroom_process_unhandled_rejections_total(?:\{[^}]*\})? 1$/mu);
    process.off("unhandledRejection", listener);
  });
});
