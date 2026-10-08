import type { Database } from "@fundroom/db";
import type { DirectoryPort } from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import { directoryHostname } from "./hostname.js";
import { createLocalDirectory } from "./local.js";
import { createDirectoryRouting } from "./routing.js";

function fake(overrides: Partial<DirectoryPort>): { dir: DirectoryPort; calls: string[] } {
  const calls: string[] = [];
  const base = createLocalDirectory({ db: {} as Database });
  const dir: DirectoryPort = {
    ...base,
    mode: "shared",
    lookupSlug: async (s) => {
      calls.push(`s:${s}`);
      return { cellId: "us-1", state: "active" };
    },
    lookupHost: async (h) => {
      calls.push(`h:${h}`);
      return null;
    },
    ...overrides,
  };
  return { dir, calls };
}

describe("directory routing cache (E3.11 §7)", () => {
  it("caches within the TTL, expires after it, and never asks for impossible keys", async () => {
    let t = 0;
    const { dir, calls } = fake({});
    const r = createDirectoryRouting({ directory: dir, now: () => t });
    expect(await r.slug("Acme")).toEqual({ cellId: "us-1", state: "active" });
    expect(await r.slug("acme")).toEqual({ cellId: "us-1", state: "active" });
    expect(await r.host("IR.Acme.com:443")).toBeNull();
    expect(await r.host("ir.acme.com")).toBeNull();
    expect(calls).toEqual(["s:acme", "h:ir.acme.com"]);
    t = 30_001;
    await r.slug("acme");
    expect(calls).toHaveLength(3);
    expect(await r.slug("../etc")).toBeNull();
    expect(await r.host("10.0.0.1")).toBeNull();
    expect(await r.workspace("not-a-uuid")).toBeNull();
    expect(calls).toHaveLength(3);
  });

  it("budget: over it answers null without asking; the next window asks again", async () => {
    let t = 0;
    const { dir, calls } = fake({});
    const r = createDirectoryRouting({ directory: dir, budget: 2, now: () => t });
    await r.slug("a");
    await r.slug("b");
    expect(await r.slug("c")).toBeNull();
    expect(calls).toHaveLength(2);
    t = 1_000;
    expect(await r.slug("c")).toEqual({ cellId: "us-1", state: "active" });
  });

  it("errors and timeouts are misses, not cached, with a back-off window", async () => {
    let t = 0;
    let fail = true;
    const { dir } = fake({
      lookupSlug: async () => {
        if (fail) throw new Error("down");
        return { cellId: "us-1", state: "active" };
      },
    });
    const events: string[] = [];
    const r = createDirectoryRouting({
      directory: dir,
      now: () => t,
      downMs: 5_000,
      log: (e) => events.push(e),
    });
    expect(await r.slug("a")).toBeNull();
    fail = false;
    expect(await r.slug("a")).toBeNull(); // backing off
    t = 5_001;
    expect(await r.slug("a")).toEqual({ cellId: "us-1", state: "active" });
    expect(events).toEqual(["directory.lookup_failed"]);

    const hang = fake({ lookupSlug: () => new Promise(() => {}) });
    const slow = createDirectoryRouting({ directory: hang.dir, timeoutMs: 20 });
    expect(await slow.slug("a")).toBeNull();
  });

  it("local mode never asks", async () => {
    const { dir, calls } = fake({});
    const r = createDirectoryRouting({ directory: { ...dir, mode: "local" } });
    expect(await r.slug("acme")).toBeNull();
    expect(calls).toEqual([]);
  });

  it("normalises hostnames exactly like the domains package", () => {
    expect(directoryHostname("IR.Acme.COM.:8443")).toBe("ir.acme.com");
    expect(directoryHostname("bücher.de")).toBe("xn--bcher-kva.de");
    expect(directoryHostname("[::1]")).toBeUndefined();
    expect(directoryHostname("portal.example")).toBeUndefined(); // reserved TLD
  });
});

describe("R2-6: the relocation check has its own budget", () => {
  it("random-slug traffic exhausting the key budget does not starve workspace() lookups", async () => {
    const { dir } = fake({
      lookupWorkspace: async () => ({ entryId: "e", cellId: "us-1", state: "active" }),
    });
    const r = createDirectoryRouting({ directory: dir, budget: 3, now: () => 0 });
    for (let i = 0; i < 10; i += 1) await r.slug(`rnd-${i}`);
    expect(await r.slug("rnd-x")).toBeNull();
    expect(await r.workspace("0190a0b0-0000-7000-8000-000000000001")).toEqual({
      cellId: "us-1",
      state: "active",
    });
  });
});
