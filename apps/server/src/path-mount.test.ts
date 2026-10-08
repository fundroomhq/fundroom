import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "./env.js";
import { ownOriginsFor } from "./mail/feedback.js";
import {
  canonicalBaseOf,
  canonicalPathOf,
  mergeVary,
  pathMountResolution,
  varyByMount,
} from "./path-mount.js";

const MOUNTS = [
  { origin: "https://acme.com", prefix: "/investors" },
  { origin: "https://caddy.test", prefix: "/portal" },
];

function probeApp(options: { basePath?: string; trustProxy?: boolean } = {}) {
  const logged: unknown[] = [];
  const app = new Hono<AppEnv>();
  app.use(
    "*",
    pathMountResolution({
      mounts: MOUNTS,
      basePath: options.basePath ?? "/investors",
      trustProxy: options.trustProxy ?? false,
      log: (event, fields) => logged.push({ event, ...fields }),
    }),
  );
  app.get("*", (c) =>
    c.json({
      publicBase: c.get("publicBase"),
      publicOrigin: c.get("publicOrigin"),
      mount: c.get("pathMount") ?? null,
    }),
  );
  return { app, logged };
}

describe("pathMountResolution", () => {
  it("is BASE_PATH and the request's origin without a (matching) X-Forwarded-Prefix", async () => {
    const { app } = probeApp();
    const res = await app.request("https://portal.test/investors/x");
    expect(await res.json()).toEqual({
      publicBase: "/investors",
      publicOrigin: "https://portal.test",
      mount: null,
    });
  });

  it("takes the matched mount's prefix and origin (replace shape)", async () => {
    const { app } = probeApp();
    const res = await app.request("https://portal.test/investors/x", {
      headers: { "x-forwarded-prefix": "/portal" },
    });
    expect(await res.json()).toEqual({
      publicBase: "/portal",
      publicOrigin: "https://caddy.test",
      mount: { origin: "https://caddy.test", prefix: "/portal" },
    });
  });

  it("strip shape: BASE_PATH empty, the mount supplies the public base", async () => {
    const { app } = probeApp({ basePath: "" });
    const res = await app.request("https://portal.test/x", {
      headers: { "x-forwarded-prefix": "/investors/" },
    });
    expect(await res.json()).toMatchObject({
      publicBase: "/investors",
      publicOrigin: "https://acme.com",
    });
  });

  it("ignores a prefix that is not allow-listed, and logs each distinct value once", async () => {
    const { app, logged } = probeApp();
    for (const prefix of ["/evil", "/evil", "/investors,/portal", "/other"]) {
      const res = await app.request("https://portal.test/investors/x", {
        headers: { "x-forwarded-prefix": prefix },
      });
      expect(await res.json()).toMatchObject({ publicBase: "/investors", mount: null });
    }
    expect(logged).toHaveLength(3);
    expect(logged[0]).toMatchObject({ event: "http.path_mount_ignored", level: "debug" });
  });

  it("with TRUST_PROXY a forwarded host only selects the mount, never rejects it (E3.9 correction)", async () => {
    const { app } = probeApp({ trustProxy: true });
    // An edge that overwrote X-Forwarded-Host (the portal's own Caddy behind a Worker/Vercel/WP
    // proxy) must not unmount the request: the first listed mount with the prefix is used.
    const other = await app.request("http://app:3000/investors/x", {
      headers: { "x-forwarded-prefix": "/investors", "x-forwarded-host": "evil.test" },
    });
    expect(await other.json()).toMatchObject({
      publicBase: "/investors",
      publicOrigin: "https://acme.com",
    });
    const own = await app.request("http://app:3000/investors/x", {
      headers: { "x-forwarded-prefix": "/investors", "x-forwarded-host": "acme.com" },
    });
    expect(await own.json()).toMatchObject({ publicOrigin: "https://acme.com" });
  });
});

describe("offPasskeyOrigin (E3.9 FR1 B5)", () => {
  function app(baseUrl: string, mounts: { origin: string; prefix: string }[], basePath: string) {
    const a = new Hono<AppEnv>();
    a.use(
      "*",
      pathMountResolution({ mounts, basePath, trustProxy: false, baseUrl: new URL(baseUrl) }),
    );
    a.get("*", (c) => c.json({ off: c.get("offPasskeyOrigin") === true }));
    return a;
  }
  const off = async (a: Hono<AppEnv>, prefix?: string) =>
    (
      (await (
        await a.request(
          "https://portal.test/x",
          prefix === undefined ? {} : { headers: { "x-forwarded-prefix": prefix } },
        )
      ).json()) as { off: boolean }
    ).off;

  it("is set on a mount on another origin, and on the direct portal when BASE_URL is a mount", async () => {
    const preserve = app("https://portal.test/investors", MOUNTS, "/investors");
    expect(await off(preserve)).toBe(false);
    expect(await off(preserve, "/portal")).toBe(true);
    const strip = app("https://acme.com/investors", [MOUNTS[0] as never], "");
    expect(await off(strip, "/investors")).toBe(false);
    expect(await off(strip)).toBe(true);
  });

  it("FR2 B9: any request whose public origin is not the RP origin, mounts or not", async () => {
    const plain = app("https://other.test", [], "");
    expect(await off(plain)).toBe(true);
    const own = app("https://portal.test", [], "");
    expect(await off(own)).toBe(false);
    // Multi tenancy opts out: tenant subdomains keep today's rules.
    const multi = new Hono<AppEnv>();
    multi.use(
      "*",
      pathMountResolution({
        mounts: [],
        basePath: "",
        trustProxy: false,
        baseUrl: new URL("https://other.test"),
        checkUnmountedOrigin: false,
      }),
    );
    multi.get("*", (c) => c.json({ off: c.get("offPasskeyOrigin") === true }));
    expect(await off(multi)).toBe(false);
  });

  it("FR2 B10: a configured prefix that did not resolve (shared, ambiguous) refuses passkeys, warns once", async () => {
    const logged: Record<string, unknown>[] = [];
    const shared = [
      { origin: "https://acme.com", prefix: "/investors" },
      { origin: "https://www.acme.com", prefix: "/investors" },
    ];
    const a = new Hono<AppEnv>();
    a.use(
      "*",
      pathMountResolution({
        mounts: shared,
        basePath: "",
        trustProxy: false,
        baseUrl: new URL("https://portal.test"),
        log: (event, fields) => logged.push({ event, ...fields }),
      }),
    );
    a.get("*", (c) =>
      c.json({
        off: c.get("offPasskeyOrigin") === true,
        base: c.get("publicBase"),
        mount: c.get("pathMount") ?? null,
      }),
    );
    for (let i = 0; i < 3; i++) {
      const res = await a.request("https://portal.test/x", {
        headers: { "x-forwarded-prefix": "/investors/" },
      });
      // Presented as the portal's own (cookies as without the header), but no passkeys.
      expect(await res.json()).toEqual({ off: true, base: "", mount: null });
    }
    expect(logged.filter((l) => l["event"] === "http.path_mount_ambiguous")).toHaveLength(1);
    expect(logged[0]).toMatchObject({ level: "warn", prefix: "/investors" });
    // Without the header: the portal's own origin, passkeys fine.
    expect(await (await a.request("https://portal.test/x")).json()).toMatchObject({ off: false });
  });
});

describe("varyByMount", () => {
  const app = new Hono<AppEnv>();
  app.use("*", varyByMount());
  app.get("/private", (c) => {
    c.header("Cache-Control", "private, no-store");
    c.header("Vary", "Origin");
    return c.text("x");
  });
  app.get("/nostore", (c) => {
    c.header("Cache-Control", "no-store");
    return c.text("x");
  });
  app.get("/public", (c) => {
    c.header("Cache-Control", "public, max-age=300");
    return c.text("x");
  });
  app.get("/none", (c) => c.text("x"));

  it("appends Cookie and X-Forwarded-Prefix to private/no-store responses only", async () => {
    expect((await app.request("/private")).headers.get("vary")).toBe(
      "Origin, Cookie, X-Forwarded-Prefix",
    );
    expect((await app.request("/nostore")).headers.get("vary")).toBe("Cookie, X-Forwarded-Prefix");
    expect((await app.request("/public")).headers.get("vary")).toBeNull();
    expect((await app.request("/none")).headers.get("vary")).toBeNull();
  });
  it("FR2 B11: with PATH_MOUNTS set, public cacheable responses vary by X-Forwarded-Prefix", async () => {
    const mounted = new Hono<AppEnv>();
    mounted.use("*", varyByMount({ mountsConfigured: true }));
    mounted.get("/public", (c) => {
      c.header("Cache-Control", "public, max-age=31536000, immutable");
      return c.text("x");
    });
    mounted.get("/private", (c) => {
      c.header("Cache-Control", "private, no-store");
      return c.text("x");
    });
    mounted.get("/none", (c) => c.text("x"));
    expect((await mounted.request("/public")).headers.get("vary")).toBe("X-Forwarded-Prefix");
    expect((await mounted.request("/private")).headers.get("vary")).toBe(
      "Cookie, X-Forwarded-Prefix",
    );
    expect((await mounted.request("/none")).headers.get("vary")).toBeNull();
  });
});

describe("ownOriginsFor (E3.9 FR1 B8)", () => {
  it("a base with a path owns only URLs under it; a bare origin owns its origin", () => {
    const bases = ["https://acme.com/investors", "https://ir.acme.test"];
    expect(ownOriginsFor("https://acme.com/investors/updates/1", bases)).toEqual([
      "https://acme.com",
    ]);
    expect(ownOriginsFor("https://acme.com/investors", bases)).toEqual(["https://acme.com"]);
    expect(ownOriginsFor("https://acme.com/pricing", bases)).toEqual([]);
    expect(ownOriginsFor("https://acme.com/investorsx", bases)).toEqual([]);
    expect(ownOriginsFor("https://ir.acme.test/anything", bases)).toEqual(["https://ir.acme.test"]);
    expect(ownOriginsFor("https://evil.test/", bases)).toEqual([]);
    expect(ownOriginsFor("not a url", bases)).toEqual([]);
  });
});

describe("helpers", () => {
  it("mergeVary never duplicates and keeps *", () => {
    expect(mergeVary(null, ["Cookie"])).toBe("Cookie");
    expect(mergeVary("cookie, Accept", ["Cookie", "X-Forwarded-Prefix"])).toBe(
      "cookie, Accept, X-Forwarded-Prefix",
    );
    expect(mergeVary("*", ["Cookie"])).toBe("*");
  });

  it("canonicalBaseOf is BASE_URL's origin + path without a trailing slash", () => {
    expect(canonicalBaseOf(new URL("https://acme.com/investors/"))).toBe(
      "https://acme.com/investors",
    );
    expect(canonicalBaseOf(new URL("https://portal.test"))).toBe("https://portal.test");
    expect(canonicalPathOf(new URL("https://portal.test/"))).toBe("");
    expect(canonicalPathOf(new URL("https://acme.com/investors"))).toBe("/investors");
  });
});
