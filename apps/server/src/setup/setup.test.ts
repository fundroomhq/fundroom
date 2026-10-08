import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { slugFromName } from "../routes/setup.js";
import { createSetupGate } from "./gate.js";
import { ensureSecretKey, secretKeyWarning } from "./secret-key.js";
import {
  disabledSetupToken,
  removeSetupTokenFile,
  resolveSetupToken,
  SETUP_TOKEN_FILE,
  setupTokenBanner,
} from "./token.js";
import { waitForDatabase } from "./wait-db.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "fundroom-setup-"));
}

describe("ensureSecretKey", () => {
  it("leaves configured keys alone", () => {
    const env = { SECRET_KEY_RING: "v1:abc" };
    expect(ensureSecretKey({ env, dataDir: tmp() })).toEqual({
      action: "configured",
      via: "SECRET_KEY_RING",
    });
    expect(env).toEqual({ SECRET_KEY_RING: "v1:abc" });
  });

  it.each([
    "FUNDROOM_SECRET_KEY",
    "FUNDROOM_SECRET_KEY_FILE",
    "SEEDHOST_SECRET_KEY",
    "SEEDHOST_SECRET_KEY_FILE",
    "SECRET_KEY_RING_FILE",
  ])("treats %s (any name the loader reads, old ones included) as configured", (name) => {
    // A-2: an install still on the old name must never get a second, generated key.
    const dir = tmp();
    const env: NodeJS.ProcessEnv = { DATA_DIR: dir, [name]: "x" };
    expect(ensureSecretKey({ env })).toEqual({ action: "configured", via: name });
    expect(env).toEqual({ DATA_DIR: dir, [name]: "x" });
    expect(existsSync(join(dir, "secret.key"))).toBe(false);
  });

  it("generates once into DATA_DIR with mode 0600 and reuses it afterwards", () => {
    const dir = tmp();
    const env: NodeJS.ProcessEnv = { DATA_DIR: dir };
    const first = ensureSecretKey({ env });
    expect(first).toEqual({ action: "generated", path: join(dir, "secret.key") });
    expect(env["FUNDROOM_SECRET_KEY_FILE"]).toBe(join(dir, "secret.key"));
    const raw = readFileSync(join(dir, "secret.key"), "utf8");
    expect(Buffer.from(raw.trim(), "base64")).toHaveLength(32);
    if (process.platform !== "win32")
      expect(statSync(join(dir, "secret.key")).mode & 0o777).toBe(0o600);

    const again: NodeJS.ProcessEnv = { DATA_DIR: dir };
    expect(ensureSecretKey({ env: again })).toEqual({
      action: "reused",
      path: join(dir, "secret.key"),
    });
    expect(readFileSync(join(dir, "secret.key"), "utf8")).toBe(raw);
    expect(secretKeyWarning(join(dir, "secret.key"))).toContain("GENERATED");
  });

  it("only reuses an existing key when generation is off", () => {
    const dir = tmp();
    const env: NodeJS.ProcessEnv = { DATA_DIR: dir };
    expect(ensureSecretKey({ env, generate: false })).toEqual({
      action: "unavailable",
      reason: `${join(dir, "secret.key")} does not exist`,
    });
    expect(env["FUNDROOM_SECRET_KEY_FILE"]).toBeUndefined();
    ensureSecretKey({ env: { DATA_DIR: dir } });
    expect(ensureSecretKey({ env, generate: false })).toEqual({
      action: "reused",
      path: join(dir, "secret.key"),
    });
    expect(env["FUNDROOM_SECRET_KEY_FILE"]).toBe(join(dir, "secret.key"));
  });

  it("does nothing when the data dir is missing, unwritable or holds an empty key", () => {
    expect(ensureSecretKey({ env: {}, dataDir: join(tmp(), "missing") })).toMatchObject({
      action: "unavailable",
      reason: expect.stringContaining("does not exist"),
    });
    const dir = tmp();
    writeFileSync(join(dir, "secret.key"), "");
    expect(ensureSecretKey({ env: {}, dataDir: dir })).toMatchObject({
      action: "unavailable",
      reason: expect.stringContaining("empty"),
    });
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      const ro = tmp();
      chmodSync(ro, 0o500);
      expect(ensureSecretKey({ env: {}, dataDir: ro })).toMatchObject({
        action: "unavailable",
        reason: expect.stringContaining("not writable"),
      });
      chmodSync(ro, 0o700);
    }
  });
});

describe("resolveSetupToken", () => {
  it("prefers SETUP_TOKEN, then the file, then generates and persists", () => {
    const dir = tmp();
    const fromEnv = resolveSetupToken({ configured: "0123456789abcdef0123", dataDir: dir });
    expect(fromEnv.source).toBe("env");
    expect(fromEnv.verify("0123456789abcdef0123")).toBe(true);
    expect(fromEnv.verify("0123456789abcdef0124")).toBe(false);
    expect(fromEnv.verify(" 0123456789abcdef0123 ")).toBe(true);

    const generated = resolveSetupToken({ dataDir: dir, random: () => randomBytes(24) });
    expect(generated.source).toBe("generated");
    expect(generated.path).toBe(join(dir, "setup-token"));
    const value = readFileSync(join(dir, "setup-token"), "utf8").trim();
    expect(generated.verify(value)).toBe(true);

    const reread = resolveSetupToken({ dataDir: dir });
    expect(reread.source).toBe("file");
    expect(reread.verify(value)).toBe(true);
    expect(setupTokenBanner(reread, "http://localhost:3000/setup")).toContain(value);

    reread.consume();
    expect(reread.verify(value)).toBe(false);
    expect(readFileSync(join(dir, "setup-token"), "utf8")).toBe("");
    expect(resolveSetupToken({ dataDir: dir }).source).toBe("generated");
  });

  it("works without a writable data dir (logs only)", () => {
    const t = resolveSetupToken({ dataDir: join(tmp(), "nope") });
    expect(t.source).toBe("generated");
    expect(t.path).toBeUndefined();
    expect(t.reveal()).toHaveLength(32);
    expect(setupTokenBanner(t, "u")).toContain("this process only");
  });
});

describe("createSetupGate", () => {
  it("caches only the settled state and can be invalidated", async () => {
    let n = 0;
    const list = vi.fn(async () => n);
    const gate = createSetupGate({ db: {} as never, cacheMs: 1000, now: () => 0, count: list });
    expect(await gate.required()).toBe(true);
    expect(await gate.required()).toBe(true);
    expect(list).toHaveBeenCalledTimes(2); // "required" is never cached
    n = 1;
    expect(await gate.required()).toBe(false);
    expect(await gate.required()).toBe(false);
    expect(list).toHaveBeenCalledTimes(3); // "complete" is
    gate.invalidate();
    expect(await gate.required()).toBe(false);
    expect(list).toHaveBeenCalledTimes(4);
  });
});

describe("first-run setup under the control plane (E-UP-11)", () => {
  it("a disabled gate is never required and never asks the database", async () => {
    const count = vi.fn(async () => 0);
    const gate = createSetupGate({ db: {} as never, disabled: true, count });
    expect(await gate.required()).toBe(false);
    gate.invalidate();
    expect(await gate.required()).toBe(false);
    expect(count).not.toHaveBeenCalled();
  });

  it("a disabled token verifies nothing and has nothing to reveal", () => {
    const t = disabledSetupToken();
    expect(t.path).toBeUndefined();
    expect(t.verify("")).toBe(false);
    expect(t.verify("anything-at-all-0123456789")).toBe(false);
    expect(() => t.reveal()).toThrow(/off under the control plane/u);
  });
});

describe("removeSetupTokenFile (E-UP-11 fix round 1 L7)", () => {
  it("removes a present file, reports an absent one, and never throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "fundroom-token-rm-"));
    writeFileSync(join(dir, SETUP_TOKEN_FILE), "old-token\n");
    expect(removeSetupTokenFile(dir)).toBe(true);
    expect(existsSync(join(dir, SETUP_TOKEN_FILE))).toBe(false);
    expect(removeSetupTokenFile(dir)).toBe(false);
    // Unremovable: the name is a non-empty directory (rmSync without `recursive` refuses).
    mkdirSync(join(dir, SETUP_TOKEN_FILE));
    writeFileSync(join(dir, SETUP_TOKEN_FILE, "x"), "x");
    expect(removeSetupTokenFile(dir)).toBe(false);
    expect(existsSync(join(dir, SETUP_TOKEN_FILE))).toBe(true);
    expect(removeSetupTokenFile(join(dir, "missing-dir"))).toBe(false);
  });
});

describe("waitForDatabase", () => {
  afterEach(() => vi.useRealTimers());

  it("retries until the ping succeeds and gives up at the timeout", async () => {
    let t = 0;
    const log = vi.fn();
    let ok = 0;
    const attempts = await waitForDatabase({
      connectionString: "postgres://u:p@h/db",
      timeoutMs: 5000,
      intervalMs: 1000,
      log,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      ping: async () => {
        ok += 1;
        if (ok < 3) throw new Error("connect ECONNREFUSED postgres://u:p@h/db");
        return true;
      },
    });
    expect(attempts).toBe(3);
    expect(log).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(log.mock.calls)).not.toContain("u:p@");

    t = 0;
    await expect(
      waitForDatabase({
        connectionString: "x",
        timeoutMs: 2500,
        intervalMs: 1000,
        now: () => t,
        sleep: async (ms) => {
          t += ms;
        },
        ping: async () => false,
      }),
    ).rejects.toThrow(/within 2500 ms \(4 attempts\)/u);
  });
});

describe("slugFromName", () => {
  it("derives a DNS label from a company name", () => {
    expect(slugFromName("Acme Inc.")).toBe("acme-inc");
    expect(slugFromName("  Ärger & Söhne GmbH ")).toBe("arger-sohne-gmbh");
    expect(slugFromName("!!!")).toBe("workspace");
    expect(slugFromName("a".repeat(80))).toHaveLength(63);
  });
});
