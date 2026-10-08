import { describe, expect, it } from "vitest";
import { createNoopScanner } from "./noop-scanner.js";

describe("noop scanner", () => {
  it("answers skipped, drains streams and warns once", async () => {
    const events: string[] = [];
    const s = createNoopScanner({ log: (e) => events.push(e) });
    const stream = new Blob([new Uint8Array(1000)]).stream() as ReadableStream<Uint8Array>;
    expect(await s.scan({ body: stream, size: 1000 })).toEqual({
      verdict: "skipped",
      engine: "noop",
    });
    expect(await s.scan({ body: new Uint8Array(3) })).toMatchObject({ verdict: "skipped" });
    expect(events).toEqual(["avscan.noop"]);
    await expect(s.healthCheck()).resolves.toBeUndefined();
  });
});
