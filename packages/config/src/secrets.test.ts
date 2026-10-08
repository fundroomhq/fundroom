import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fingerprintKey } from "./key-ring.js";
import { envSpellings, resolveEnv, valueFingerprint } from "./secrets.js";

const KEYS = ["DATABASE_URL", "PORT"] as const;

describe("resolveEnv", () => {
  it("takes plain env values and records the source", () => {
    const r = resolveEnv({ DATABASE_URL: "postgres://x", PORT: "80" }, KEYS);
    expect(r.issues).toEqual([]);
    expect(r.values).toEqual({ DATABASE_URL: "postgres://x", PORT: "80" });
    expect(r.sources["DATABASE_URL"]).toEqual({ value: "postgres://x", source: "env" });
  });

  it("reads NAME_FILE and strips only the trailing newline", () => {
    const files: Record<string, string> = { "/run/secrets/db": "postgres://from-file \n" };
    const r = resolveEnv({ DATABASE_URL_FILE: "/run/secrets/db" }, KEYS, (p) => {
      const v = files[p];
      if (v === undefined) throw Object.assign(new Error("nope"), { code: "ENOENT" });
      return v;
    });
    expect(r.issues).toEqual([]);
    expect(r.values["DATABASE_URL"]).toBe("postgres://from-file ");
    expect(r.sources["DATABASE_URL"]).toEqual({
      value: "postgres://from-file ",
      source: "file",
      path: "/run/secrets/db",
    });
  });

  it("rejects NAME and NAME_FILE both set instead of picking one silently", () => {
    const r = resolveEnv({ DATABASE_URL: "a", DATABASE_URL_FILE: "/x" }, KEYS, () => "b");
    expect(r.values["DATABASE_URL"]).toBeUndefined();
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]?.key).toBe("DATABASE_URL");
    expect(r.issues[0]?.message).toMatch(/both DATABASE_URL and DATABASE_URL_FILE/u);
  });

  it("reports unreadable and empty files with the file key", () => {
    const missing = resolveEnv({ DATABASE_URL_FILE: "/missing" }, KEYS, () => {
      throw Object.assign(new Error("x"), { code: "ENOENT" });
    });
    expect(missing.issues[0]).toEqual({
      key: "DATABASE_URL_FILE",
      message: "could not read /missing: file not found.",
    });

    const empty = resolveEnv({ DATABASE_URL_FILE: "/empty" }, KEYS, () => "\n");
    expect(empty.issues[0]?.message).toBe("/empty is empty.");
  });

  it("ignores empty strings and unknown *_FILE variables", () => {
    let opened = 0;
    const r = resolveEnv({ DATABASE_URL: "", OTHER_FILE: "/never" }, KEYS, () => {
      opened += 1;
      return "x";
    });
    expect(opened).toBe(0);
    expect(r.values).toEqual({});
  });
});

describe("resolveEnv: legacy names (A-2)", () => {
  const LEGACY = { NEW_KEY: "OLD_KEY" } as const;
  const K = ["NEW_KEY"] as const;
  const files: Record<string, string> = {
    "/run/secrets/new": "from-new-file\n",
    "/run/secrets/old": "from-old-file\n",
  };
  const readFile = (p: string) => {
    const v = files[p];
    if (v === undefined) throw Object.assign(new Error("nope"), { code: "ENOENT" });
    return v;
  };

  it("reads the new name and records no legacy use", () => {
    const r = resolveEnv({ NEW_KEY: "n" }, K, readFile, LEGACY);
    expect(r.issues).toEqual([]);
    expect(r.values).toEqual({ NEW_KEY: "n" });
    expect(r.legacy).toEqual([]);
  });

  it("falls back to the old name and records it", () => {
    const r = resolveEnv({ OLD_KEY: "o" }, K, readFile, LEGACY);
    expect(r.issues).toEqual([]);
    expect(r.values).toEqual({ NEW_KEY: "o" });
    expect(r.sources["NEW_KEY"]).toEqual({ value: "o", source: "env" });
    expect(r.legacy).toEqual([{ key: "NEW_KEY", legacy: "OLD_KEY" }]);
  });

  it("falls back to the old name's _FILE twin and records that spelling", () => {
    const r = resolveEnv({ OLD_KEY_FILE: "/run/secrets/old" }, K, readFile, LEGACY);
    expect(r.issues).toEqual([]);
    expect(r.values).toEqual({ NEW_KEY: "from-old-file" });
    expect(r.sources["NEW_KEY"]).toEqual({
      value: "from-old-file",
      source: "file",
      path: "/run/secrets/old",
    });
    expect(r.legacy).toEqual([{ key: "NEW_KEY", legacy: "OLD_KEY_FILE" }]);
  });

  it('treats empty strings as unset on both sides (Compose passes an unset variable as "")', () => {
    const onlyNew = resolveEnv(
      { NEW_KEY: "n", OLD_KEY: "", OLD_KEY_FILE: "" },
      K,
      readFile,
      LEGACY,
    );
    expect(onlyNew.issues).toEqual([]);
    expect(onlyNew.values).toEqual({ NEW_KEY: "n" });
    expect(onlyNew.legacy).toEqual([]);
    const onlyOld = resolveEnv(
      { NEW_KEY: "", NEW_KEY_FILE: "", OLD_KEY: "o" },
      K,
      readFile,
      LEGACY,
    );
    expect(onlyOld.issues).toEqual([]);
    expect(onlyOld.values).toEqual({ NEW_KEY: "o" });
  });

  it.each([
    [{ NEW_KEY: "secret-new", OLD_KEY: "secret-old" }, ["NEW_KEY", "OLD_KEY"]],
    [{ NEW_KEY_FILE: "/run/secrets/new", OLD_KEY: "secret-old" }, ["NEW_KEY_FILE", "OLD_KEY"]],
    [{ NEW_KEY: "secret-new", OLD_KEY_FILE: "/run/secrets/old" }, ["NEW_KEY", "OLD_KEY_FILE"]],
    [
      { NEW_KEY_FILE: "/run/secrets/new", OLD_KEY_FILE: "/run/secrets/old" },
      ["NEW_KEY_FILE", "OLD_KEY_FILE"],
    ],
  ])(
    "refuses any new spelling together with any old one holding a different value: %o",
    (env, names) => {
      const r = resolveEnv(env, K, readFile, LEGACY);
      expect(r.values).toEqual({});
      expect(r.legacy).toEqual([]);
      expect(r.issues).toHaveLength(1);
      const { key, message } = r.issues[0] ?? { key: "", message: "" };
      expect(key).toBe("NEW_KEY");
      for (const n of names) expect(message).toContain(n);
      // Neither value is ever shown; each is identified by an 8-hex sha256 fingerprint.
      for (const secret of ["secret-new", "secret-old", "from-new-file", "from-old-file"]) {
        expect(message).not.toContain(secret);
      }
      const prints = message.match(/sha256:[0-9a-f]{8}\b/gu) ?? [];
      expect(prints).toHaveLength(2);
      expect(new Set(prints).size).toBe(2);
    },
  );

  it("fingerprints a value that is not a key by the first 8 hex of its sha256 (reproducible with sha256sum)", () => {
    const r = resolveEnv({ NEW_KEY: "secret-new", OLD_KEY: "secret-old" }, K, readFile, LEGACY);
    const expected = createHash("sha256").update("secret-old").digest("hex").slice(0, 8);
    expect(valueFingerprint("secret-old")).toBe(`sha256:${expected}`);
    expect(r.issues[0]?.message).toContain(
      `OLD_KEY (sha256:${expected} of the text, not a valid key)`,
    );
  });

  it("fingerprints a key exactly as doctor does (sha256:<12 hex> of the decoded bytes)", () => {
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    const r = resolveEnv(
      // Base64 for one, hex for the other: the fingerprint is of the bytes, not the text.
      { NEW_KEY: newKey.toString("hex"), OLD_KEY: `${oldKey.toString("base64")}` },
      K,
      readFile,
      LEGACY,
    );
    const message = r.issues[0]?.message ?? "";
    expect(message).toContain(`OLD_KEY (key ${fingerprintKey(oldKey)})`);
    expect(message).toContain(`NEW_KEY (key ${fingerprintKey(newKey)})`);
    expect(message).not.toContain(oldKey.toString("base64"));
    expect(message).not.toContain(newKey.toString("hex"));
  });

  it("does not tell the operator to keep the new name: the old one usually holds the data's key", () => {
    const r = resolveEnv({ NEW_KEY: "secret-new", OLD_KEY: "secret-old" }, K, readFile, LEGACY);
    const message = r.issues[0]?.message ?? "";
    expect(message).not.toMatch(/keep only NEW_KEY/iu);
    expect(message).toContain(
      "On an upgraded install OLD_KEY normally holds the key your existing data was encrypted with",
    );
    expect(message).toContain("`fundroom doctor`");
  });

  it.each([
    [{ NEW_KEY: "same", OLD_KEY: "same" }, "OLD_KEY", "NEW_KEY", "env"],
    // File contents lose their trailing newline, exactly as when only one name is set.
    [
      { NEW_KEY: "from-old-file", OLD_KEY_FILE: "/run/secrets/old" },
      "OLD_KEY_FILE",
      "NEW_KEY",
      "env",
    ],
    [
      { NEW_KEY_FILE: "/run/secrets/old", OLD_KEY: "from-old-file" },
      "OLD_KEY",
      "NEW_KEY_FILE",
      "file",
    ],
    [
      { NEW_KEY_FILE: "/run/secrets/old", OLD_KEY_FILE: "/run/secrets/old" },
      "OLD_KEY_FILE",
      "NEW_KEY_FILE",
      "file",
    ],
  ])(
    "accepts a new and an old spelling holding the same value: %o",
    (env, legacyName, sameAs, source) => {
      const r = resolveEnv(env, K, readFile, LEGACY);
      expect(r.issues).toEqual([]);
      expect(r.values["NEW_KEY"]).toBe("NEW_KEY" in env ? env.NEW_KEY : "from-old-file");
      expect(r.sources["NEW_KEY"]?.source).toBe(source);
      expect(r.legacy).toEqual([{ key: "NEW_KEY", legacy: legacyName, sameAs }]);
    },
  );

  it("still refuses when one side is ambiguous, even if a value matches", () => {
    const r = resolveEnv(
      { NEW_KEY: "o", OLD_KEY: "o", OLD_KEY_FILE: "/run/secrets/old" },
      K,
      readFile,
      LEGACY,
    );
    expect(r.values).toEqual({});
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]?.message).toMatch(/do not hold the same value/u);
  });

  it("compares values byte for byte (no case folding, inner whitespace kept)", () => {
    for (const [a, b] of [
      ["abc", "ABC"],
      ["abc", "abc "],
      ["a bc", "abc"],
    ] as const) {
      const r = resolveEnv({ NEW_KEY: a, OLD_KEY: b }, K, readFile, LEGACY);
      expect(r.values).toEqual({});
      expect(r.issues).toHaveLength(1);
    }
  });

  it("keeps the NAME / NAME_FILE conflict rule for the old name", () => {
    const r = resolveEnv({ OLD_KEY: "o", OLD_KEY_FILE: "/run/secrets/old" }, K, readFile, LEGACY);
    expect(r.values).toEqual({});
    expect(r.issues[0]?.message).toMatch(/both OLD_KEY and OLD_KEY_FILE/u);
  });

  it("lists every spelling of a key", () => {
    expect(envSpellings("NEW_KEY", LEGACY)).toEqual([
      "NEW_KEY",
      "NEW_KEY_FILE",
      "OLD_KEY",
      "OLD_KEY_FILE",
    ]);
    expect(envSpellings("OTHER", LEGACY)).toEqual(["OTHER", "OTHER_FILE"]);
  });
});
