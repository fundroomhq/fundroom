import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GitHubRelease } from "./index-builder.js";
import {
  INDEX_CACHE_CONTROL,
  INDEX_CONTENT_TYPE,
  type IndexStore,
  main,
  publishReleaseIndex,
  type StoredIndex,
  verifyPublicIndex,
} from "./index-publisher.js";

const gh = (tag: string): GitHubRelease => ({
  tag_name: tag,
  html_url: `https://github.com/fundroomhq/fundroom/releases/tag/${tag}`,
  published_at: "2026-10-09T18:30:00Z",
  draft: false,
  notes: null,
});

function memoryStore(initial?: string, headers = true) {
  let object: StoredIndex | undefined =
    initial === undefined
      ? undefined
      : { body: initial, contentType: INDEX_CONTENT_TYPE, cacheControl: INDEX_CACHE_CONTROL };
  const puts: string[] = [];
  const store: IndexStore = {
    get: async () => object,
    put: async (body) => {
      puts.push(body);
      object = headers
        ? { body, contentType: INDEX_CONTENT_TYPE, cacheControl: INDEX_CACHE_CONTROL }
        : { body, contentType: "binary/octet-stream" };
    },
  };
  return {
    store,
    puts,
    get object() {
      return object;
    },
  };
}

/** A public URL serving `served()` (or a fixed answer), as fetch. */
function publicFetch(served: () => string | undefined, contentType = "application/json") {
  const urls: string[] = [];
  const f = (async (input: string | URL | Request) => {
    urls.push(String(input));
    const body = served();
    return body === undefined
      ? new Response("missing", { status: 404 })
      : new Response(body, { headers: { "content-type": contentType } });
  }) as typeof fetch;
  return { fetch: f, urls };
}

const noSleep = { sleep: async () => {}, attempts: 3 };

describe("publishReleaseIndex", () => {
  it("builds, uploads with the headers, reads back over S3 and the public URL", async () => {
    const mem = memoryStore();
    const pub = publicFetch(() => mem.object?.body);
    const r = await publishReleaseIndex({
      store: mem.store,
      releases: [gh("v1.0.0-rc.0")],
      firstPublish: true,
      publicUrl: "https://releases.fundroom.io/index.json",
      verify: { ...noSleep, fetch: pub.fetch },
    });
    expect(r.uploaded).toBe(true);
    expect(mem.puts).toEqual([r.body]);
    expect(r.index.latest).toBeUndefined();
    // A cache-busted read (the new bytes), then the URL readers use.
    expect(pub.urls[0]).toMatch(/^https:\/\/releases\.fundroom\.io\/index\.json\?v=[0-9a-f]{16}$/u);
    expect(pub.urls.at(-1)).toBe("https://releases.fundroom.io/index.json");
  });

  it("carries the published index over and skips an unchanged upload", async () => {
    const mem = memoryStore();
    await publishReleaseIndex({
      store: mem.store,
      releases: [gh("v1.0.0")],
      markSecurity: ["1.0.0"],
      firstPublish: true,
    });
    const again = await publishReleaseIndex({ store: mem.store, releases: [gh("v1.0.0")] });
    expect(again.uploaded).toBe(false);
    expect(again.index.releases[0]?.security).toBe(true);
    expect(mem.puts).toHaveLength(1);
  });

  it("an empty bucket needs first-publish, and first-publish needs an empty bucket", async () => {
    const mem = memoryStore();
    await expect(
      publishReleaseIndex({ store: mem.store, releases: [gh("v1.0.0")] }),
    ).rejects.toThrow(/no index\.json.*first-publish.*drop every security flag/u);
    expect(mem.puts).toEqual([]);
    await publishReleaseIndex({ store: mem.store, releases: [gh("v1.0.0")], firstPublish: true });
    await expect(
      publishReleaseIndex({ store: mem.store, releases: [gh("v1.0.0")], firstPublish: true }),
    ).rejects.toThrow(/already holds an index/u);
  });

  it("refuses a published index that does not validate, unless told to ignore it", async () => {
    const mem = memoryStore("<html>not an index</html>");
    await expect(
      publishReleaseIndex({ store: mem.store, releases: [gh("v1.0.0")] }),
    ).rejects.toThrow(/does not validate.*ignore-current/u);
    const r = await publishReleaseIndex({
      store: mem.store,
      releases: [gh("v1.0.0")],
      ignoreCurrent: true,
    });
    expect(r.uploaded).toBe(true);
  });

  it("a build failure uploads nothing; a dry run uploads nothing", async () => {
    const mem = memoryStore();
    await expect(
      publishReleaseIndex({ store: mem.store, releases: [], firstPublish: true }),
    ).rejects.toThrow(/not built: GitHub lists no published/u);
    await publishReleaseIndex({ store: mem.store, releases: [gh("v1.0.0")], dryRun: true });
    expect(mem.puts).toEqual([]);
  });

  it("fails when the bucket does not keep the headers", async () => {
    const mem = memoryStore(undefined, false);
    await expect(
      publishReleaseIndex({ store: mem.store, releases: [gh("v1.0.0")], firstPublish: true }),
    ).rejects.toThrow(/Content-Type "binary\/octet-stream"/u);
  });
});

describe("verifyPublicIndex", () => {
  const body = `${JSON.stringify({ schemaVersion: 1, releases: [{ version: "1.0.0-rc.0", date: "2026-10-09", url: "https://github.com/x", security: false }] })}\n`;

  it("retries until the new bytes propagate", async () => {
    let n = 0;
    const pub = publicFetch(() => (++n < 3 ? "{}" : body));
    await verifyPublicIndex("https://releases.fundroom.io/index.json", body, {
      ...noSleep,
      fetch: pub.fetch,
    });
    expect(n).toBe(4);
  });

  it("retries the plain URL too (a transient CDN error is not a failure)", async () => {
    let plain = 0;
    const f = (async (input: string | URL | Request) => {
      const busted = String(input).includes("?v=");
      if (!busted && ++plain < 3) return new Response("bad gateway", { status: 502 });
      return new Response(body, { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    await verifyPublicIndex("https://releases.fundroom.io/index.json", body, {
      ...noSleep,
      fetch: f,
    });
    expect(plain).toBe(3);
    plain = -100;
    await expect(
      verifyPublicIndex("https://releases.fundroom.io/index.json", body, { ...noSleep, fetch: f }),
    ).rejects.toThrow(/releases\.fundroom\.io\/index\.json does not serve.*HTTP 502/u);
  });

  it("fails on stale bytes, a wrong content type, or an error page", async () => {
    const url = "https://releases.fundroom.io/index.json";
    await expect(
      verifyPublicIndex(url, body, { ...noSleep, fetch: publicFetch(() => "{}").fetch }),
    ).rejects.toThrow(/different bytes/u);
    await expect(
      verifyPublicIndex(url, body, {
        ...noSleep,
        fetch: publicFetch(() => body, "text/html").fetch,
      }),
    ).rejects.toThrow(/content-type/u);
    await expect(
      verifyPublicIndex(url, body, { ...noSleep, fetch: publicFetch(() => undefined).fetch }),
    ).rejects.toThrow(/HTTP 404/u);
  });
});

describe("main", () => {
  const dir = mkdtempSync(join(tmpdir(), "release-index-main-"));
  const releasesFile = join(dir, "releases.json");
  writeFileSync(releasesFile, JSON.stringify([[gh("v1.0.0-rc.0"), gh("chart-v0.1.0")]]));
  const full = {
    R2_RELEASES_ENDPOINT: "https://0123456789abcdef.r2.cloudflarestorage.com",
    R2_RELEASES_BUCKET: "fundroom-releases",
    R2_RELEASES_ACCESS_KEY_ID: "id",
    R2_RELEASES_SECRET_ACCESS_KEY: "secret",
    RELEASE_INDEX_URL: "https://releases.fundroom.io/index.json",
  };
  const run = async (argv: string[], env: Record<string, string>) => {
    const lines: string[] = [];
    const code = await main(argv, env, { log: (l) => lines.push(l) });
    return { code, out: lines.join("\n") };
  };

  it("fails loudly, naming every missing key, when the environment is not configured", async () => {
    const { code, out } = await run(["--releases", releasesFile], { GITHUB_ACTIONS: "true" });
    expect(code).toBe(1);
    expect(out).toMatch(/^::error::The GitHub Environment `releases` is not configured/u);
    for (const k of Object.keys(full)) expect(out).toContain(k);
    const partial = await run(["--releases", releasesFile], { ...full, R2_RELEASES_BUCKET: " " });
    expect(partial.code).toBe(1);
    expect(partial.out).toMatch(/R2_RELEASES_BUCKET unset/u);
  });

  it("requires https", async () => {
    const { code, out } = await run(["--releases", releasesFile], {
      ...full,
      RELEASE_INDEX_URL: "http://releases.fundroom.io/index.json",
    });
    expect(code).toBe(1);
    expect(out).toMatch(/RELEASE_INDEX_URL must be https/u);
  });

  it("usage errors exit 2", async () => {
    expect((await run([], full)).code).toBe(2);
    expect((await run(["--releases", releasesFile, "--bogus"], full)).code).toBe(2);
  });

  it("a dry run with no environment builds the index from GitHub alone", async () => {
    const out = join(dir, "index.json");
    const r = await run(["--releases", releasesFile, "--dry-run", "--out", out], {});
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/skipped \(not a v<x\.y\.z> tag\): chart-v0\.1\.0/u);
    expect(r.out).toMatch(/latest \(none: no stable release\)/u);
    expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({
      schemaVersion: 1,
      releases: [{ version: "1.0.0-rc.0" }],
    });
  });

  it("a bad releases file fails", async () => {
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ message: "Bad credentials" }));
    const r = await run(["--releases", bad, "--dry-run"], {});
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/expected a JSON array/u);
  });
});

describe("the bundled publisher (scripts/bundle.mjs, what the workflow's publish job runs)", () => {
  it("runs with Node alone: no node_modules next to it", async () => {
    const { execFileSync } = await import("node:child_process");
    const dir = mkdtempSync(join(tmpdir(), "release-index-bundle-"));
    // A variable specifier: the script is plain JS, outside the typed sources.
    const script = new URL("../scripts/bundle.mjs", import.meta.url).href;
    const { bundle } = (await import(script)) as { bundle: (outfile: string) => Promise<string> };
    await bundle(join(dir, "release-index.mjs"));
    const releases = join(dir, "releases.json");
    writeFileSync(releases, JSON.stringify([gh("v1.0.0-rc.1"), gh("v1.0.0-rc.0")]));
    const out = join(dir, "index.json");
    execFileSync(
      process.execPath,
      [join(dir, "release-index.mjs"), "--releases", releases, "--dry-run", "--out", out],
      { cwd: dir, env: { PATH: process.env["PATH"] ?? "" }, stdio: "pipe" },
    );
    expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({
      schemaVersion: 1,
      releases: [{ version: "1.0.0-rc.1" }, { version: "1.0.0-rc.0" }],
    });
  });
});
