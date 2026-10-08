import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type OutboundFetch, SanctionsProviderError } from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import { parseCsv, programsOf, value } from "./csv.js";
import { createOfacScreening, OFAC_USER_AGENT } from "./index.js";

/*
 * The OFAC adapter against an in-memory SLS (E3.10): the wire rules (User-Agent, exactly one
 * redirect to https *.amazonaws.com, caps, truncation), the parse (no header, quirky quoting,
 * `-0-`, aliases, vessels), the version, the disk cache, and failing closed.
 */

const BASE = "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/";
const S3 = "https://wc2h-sls-prod-public-published.s3.us-gov-west-1.amazonaws.com/Published/x/";

const SDN = [
  `36,"AEROCARIBBEAN AIRLINES",-0- ,"CUBA",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- `,
  `173,"ANGLO-CARIBBEAN CO., LTD.",-0- ,"CUBA",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- `,
  `7160,"ROSNEFT OIL COMPANY",-0- ,"UKRAINE-EO13662] [RUSSIA-EO14024",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,"Remark with ""quotes"", a comma
and a line break."`,
  `9001,"ADRIAN DARYA 1","vessel","IRAN",-0- ,"9116412","Crude Oil Tanker",-0- ,-0- ,"Iran",-0- ,-0- `,
  `9002,"SMITH, John","individual","SDGT",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,"DOB 1970."`,
  "\u001a",
].join("\r\n");
const ALT = [
  `36,12,"aka","AERO-CARIBBEAN",-0- `,
  `7160,55,"aka","NEFTYANAYA KOMPANIYA ROSNEFT",-0- `,
  `9001,56,"fka","HELIOS TRADING",-0- `,
].join("\r\n");
const CONS_PRIM = `17000,"PETROPARS LTD.",-0- ,"NS-MBS",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- `;
const CONS_ALT = `17000,1,"aka","PETRO PARS",-0- `;

type Files = Record<string, string | Uint8Array>;

const good = (): Files => ({
  "SDN.CSV": SDN,
  "ALT.CSV": ALT,
  "CONS_PRIM.CSV": CONS_PRIM,
  "CONS_ALT.CSV": CONS_ALT,
});

interface FakeSls {
  readonly fetch: OutboundFetch;
  readonly requests: { url: string; userAgent: string | null }[];
}

/**
 * A fake SLS: each export 302s to `redirect(name)` (default: the S3 URL), which serves the bytes.
 * `serve` may override the final response per file.
 */
function fakeSls(
  files: () => Files,
  options: {
    redirect?: (name: string) => string | null;
    serve?: (name: string, body: Uint8Array) => Response | undefined;
    down?: boolean;
  } = {},
): FakeSls {
  const requests: FakeSls["requests"] = [];
  const fetch: OutboundFetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const headers = new Headers(init?.headers);
    requests.push({ url: url.href, userAgent: headers.get("user-agent") });
    if (options.down) throw new TypeError("fetch failed");
    if (!headers.get("user-agent")) return new Response("forbidden", { status: 403 });
    const name = url.pathname.split("/").pop() ?? "";
    if (url.href.startsWith(BASE)) {
      const to = options.redirect ? options.redirect(name) : `${S3}${name}?X-Amz-Expires=3600`;
      if (to !== null) return new Response(null, { status: 302, headers: { location: to } });
    }
    if (url.searchParams.has("again")) {
      return new Response(null, { status: 302, headers: { location: `${S3}${name}` } });
    }
    const content = files()[name];
    if (content === undefined) return new Response("no such key", { status: 404 });
    const body = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const custom = options.serve?.(name, body);
    if (custom !== undefined) return custom;
    return new Response(body, {
      status: 200,
      headers: { "content-length": String(body.byteLength) },
    });
  };
  return { fetch, requests };
}

function adapter(
  sls: FakeSls,
  extra: {
    cacheDir?: string;
    now?: () => Date;
    maxFileBytes?: number;
    minPrimaryEntries?: number;
  } = {},
) {
  return createOfacScreening(
    {
      fetch: sls.fetch,
      baseUrl: BASE,
      apiKey: undefined,
      cacheDir: extra.cacheDir ?? mkdtempSync(join(tmpdir(), "ofac-cache-")),
      now: extra.now ?? (() => new Date("2026-09-27T06:00:00Z")),
    },
    {
      minPrimaryEntries: extra.minPrimaryEntries ?? 1,
      ...(extra.maxFileBytes === undefined ? {} : { maxFileBytes: extra.maxFileBytes }),
    },
  );
}

const subject = (name: string, country: string | null = null) =>
  ({ name, country, kind: "organization" }) as const;
const T = { threshold: 0.88 };

describe("OFAC CSV parsing", () => {
  it("handles quoting, doubled quotes, embedded line breaks, -0- and the EOF byte", () => {
    const rows = parseCsv(SDN);
    expect(rows).toHaveLength(5);
    expect(rows[2]?.[11]).toBe('Remark with "quotes", a comma\nand a line break.');
    expect(value(rows[0]?.[2])).toBeNull();
    expect(value(rows[1]?.[1])).toBe("ANGLO-CARIBBEAN CO., LTD.");
    expect(programsOf(rows[2]?.[3])).toEqual(["UKRAINE-EO13662", "RUSSIA-EO14024"]);
    expect(programsOf("-0- ")).toEqual([]);
  });

  it("throws on a truncated quoted field and on stray quotes", () => {
    expect(() => parseCsv(`1,"ACME`)).toThrow(/unterminated/u);
    expect(() => parseCsv(`1,"ACME"X,2`)).toThrow(/after a closing quote/u);
    expect(() => parseCsv(`1,AC"ME,2`)).toThrow(/quote inside/u);
  });
});

describe("createOfacScreening", () => {
  it("downloads all four exports with a User-Agent through one S3 redirect each", async () => {
    const sls = fakeSls(good);
    const port = adapter(sls);
    const version = await port.listVersion();
    expect(version).toMatch(/^ofac:[0-9a-f]{12}:jw4$/u);
    const names = sls.requests.map((r) => new URL(r.url).pathname.split("/").pop());
    expect(names).toEqual([
      "SDN.CSV",
      "SDN.CSV",
      "ALT.CSV",
      "ALT.CSV",
      "CONS_PRIM.CSV",
      "CONS_PRIM.CSV",
      "CONS_ALT.CSV",
      "CONS_ALT.CSV",
    ]);
    expect(sls.requests.every((r) => r.userAgent === OFAC_USER_AGENT)).toBe(true);
    expect(port.meta.subProcessor).toBeNull();
  });

  it("finds primary names, aliases and consolidated entries; skips vessels", async () => {
    const port = adapter(fakeSls(good));
    const hit = await port.screen(subject("Aero Caribbean Airlines Inc."), T);
    expect(hit.outcome).toBe("potential_match");
    expect(hit.matches[0]).toMatchObject({
      listEntryId: "sdn:36",
      source: "OFAC SDN",
      programs: ["CUBA"],
    });
    const alias = await port.screen(subject("Neftyanaya Kompaniya Rosneft"), T);
    expect(alias.matches[0]?.listEntryId).toBe("sdn:7160");
    expect(alias.matches[0]?.name).toBe(
      "ROSNEFT OIL COMPANY (a.k.a. NEFTYANAYA KOMPANIYA ROSNEFT)",
    );
    const cons = await port.screen(subject("Petro Pars GmbH"), T);
    expect(cons.matches[0]).toMatchObject({
      listEntryId: "cons:17000",
      source: "OFAC Consolidated (non-SDN)",
    });
    // A listed name spelled with look-alike Greek letters is read by appearance (jw4).
    const spoof = await port.screen(subject("Ρetro Ρars GmbH"), T);
    expect(spoof.matches[0]).toMatchObject({ listEntryId: "cons:17000" });
    // A vessel (and its former name) is not a party a company could be.
    expect((await port.screen(subject("Helios Trading"), T)).outcome).toBe("clear");
    expect((await port.screen(subject("Adrian Darya 1"), T)).outcome).toBe("clear");
    const clear = await port.screen(subject("Seed Host Ventures"), T);
    expect(clear).toEqual({ outcome: "clear", listVersion: hit.listVersion, matches: [] });
  });

  it("treats the country as informative only", async () => {
    const port = adapter(fakeSls(good));
    const a = await port.screen(subject("Aerocaribbean Airlines", "DE"), T);
    const b = await port.screen(subject("Aerocaribbean Airlines", null), T);
    expect(a).toEqual(b);
    expect(a.outcome).toBe("potential_match");
  });

  it("changes the version when any file changes", async () => {
    let files = good();
    const port = adapter(
      fakeSls(() => files),
      { now: () => new Date(Date.now() + 1) },
    );
    const v1 = await port.listVersion();
    files = { ...files, "CONS_ALT.CSV": `${CONS_ALT}\r\n17000,2,"aka","PARS PETRO",-0- ` };
    let t = Date.now() + 2 * 3600_000;
    const later = adapter(
      fakeSls(() => files),
      { now: () => new Date(t++) },
    );
    expect(await later.listVersion()).not.toBe(v1);
  });

  describe("redirects", () => {
    const cases: [string, (name: string) => string][] = [
      ["plain http to S3", (n) => `http://bucket.s3.amazonaws.com/${n}`],
      ["another host", (n) => `https://evil.example/${n}`],
      ["a look-alike host", (n) => `https://amazonaws.com.evil.example/${n}`],
      ["a redirect back to SLS", (n) => `${BASE}${n}`],
      ["a second redirect", (n) => `${S3}${n}?again=1`],
    ];
    it.each(cases)("refuses %s", async (_label, redirect) => {
      const port = adapter(fakeSls(good, { redirect }));
      await expect(port.listVersion()).rejects.toBeInstanceOf(SanctionsProviderError);
      await expect(port.screen(subject("Anything"), T)).rejects.toBeInstanceOf(
        SanctionsProviderError,
      );
    });

    it("says why on a second redirect", async () => {
      const port = adapter(fakeSls(good, { redirect: (n) => `${S3}${n}?again=1` }));
      await expect(port.listVersion()).rejects.toThrow(/more than one redirect/u);
    });

    it("accepts a direct 200 (no redirect)", async () => {
      const port = adapter(fakeSls(good, { redirect: () => null }));
      expect(await port.listVersion()).toMatch(/^ofac:/u);
    });
  });

  describe("fails closed", () => {
    it("on an HTTP error or a network failure", async () => {
      await expect(
        adapter(fakeSls(() => ({ ...good(), "CONS_ALT.CSV": undefined as never }))).listVersion(),
      ).rejects.toThrow(/CONS_ALT.CSV: HTTP 404/u);
      await expect(adapter(fakeSls(good, { down: true })).listVersion()).rejects.toBeInstanceOf(
        SanctionsProviderError,
      );
    });

    it("on a file over the cap, declared or streamed", async () => {
      await expect(adapter(fakeSls(good), { maxFileBytes: 100 }).listVersion()).rejects.toThrow(
        /cap/u,
      );
      const streamed = fakeSls(good, {
        serve: (_n, body) => new Response(body, { status: 200 }),
      });
      await expect(adapter(streamed, { maxFileBytes: 100 }).listVersion()).rejects.toThrow(/cap/u);
    });

    it("on a body shorter than its Content-Length", async () => {
      const sls = fakeSls(good, {
        serve: (name, body) =>
          name === "ALT.CSV"
            ? // Cut at a row boundary: it still parses, only the length gives it away.
              new Response(body.subarray(0, ALT.lastIndexOf("\r\n")), {
                status: 200,
                headers: { "content-length": String(body.byteLength) },
              })
            : undefined,
      });
      await expect(adapter(sls).listVersion()).rejects.toThrow(/truncated/u);
    });

    it("on a file that does not parse, an orphan alias or too few entries", async () => {
      await expect(
        adapter(fakeSls(() => ({ ...good(), "SDN.CSV": SDN.slice(0, 200) }))).listVersion(),
      ).rejects.toBeInstanceOf(SanctionsProviderError);
      await expect(
        adapter(
          fakeSls(() => ({ ...good(), "ALT.CSV": `${ALT}\r\n424242,9,"aka","NOBODY",-0- ` })),
        ).listVersion(),
      ).rejects.toThrow(/unknown entry/u);
      await expect(
        adapter(fakeSls(good), { minPrimaryEntries: 1000 }).listVersion(),
      ).rejects.toThrow(/fewer than/u);
    });

    it("keeps screening on the last good snapshot, but never past its maximum age", async () => {
      let broken = false;
      let now = new Date("2026-09-27T06:00:00Z");
      const port = adapter(
        fakeSls(() => (broken ? { ...good(), "SDN.CSV": `1,"UNTERMINATED` } : good())),
        { now: () => now },
      );
      const v1 = await port.listVersion();
      broken = true;
      now = new Date("2026-09-27T08:00:00Z");
      // The daily refresh sees the failure...
      await expect(port.listVersion()).rejects.toBeInstanceOf(SanctionsProviderError);
      // ...screening still uses the complete snapshot it has (a day old is fine)...
      now = new Date("2026-09-28T06:00:00Z");
      expect((await port.screen(subject("Aerocaribbean Airlines"), T)).listVersion).toBe(v1);
      // ...but not once it is older than 48 h: no list, no answer — never "clear".
      now = new Date("2026-09-29T06:00:01Z");
      await expect(port.screen(subject("Seed Host"), T)).rejects.toBeInstanceOf(
        SanctionsProviderError,
      );
    });
  });

  describe("disk cache", () => {
    it("writes one snapshot atomically and serves a new process from it", async () => {
      const cacheDir = mkdtempSync(join(tmpdir(), "ofac-cache-"));
      const first = adapter(fakeSls(good), { cacheDir });
      const version = await first.listVersion();
      const dir = version.split(":")[1] as string;
      expect(readdirSync(join(cacheDir, "ofac")).sort()).toEqual([dir, "current.json"].sort());
      const manifest = JSON.parse(readFileSync(join(cacheDir, "ofac", "current.json"), "utf8"));
      expect(manifest).toMatchObject({ version, dir });
      // A second process with SLS down screens from the cache.
      const down = fakeSls(good, { down: true });
      const second = adapter(down, { cacheDir });
      expect((await second.screen(subject("Aerocaribbean Airlines"), T)).listVersion).toBe(version);
      expect(down.requests).toHaveLength(0);
    });

    it("ignores a cache whose files no longer hash to its version", async () => {
      const cacheDir = mkdtempSync(join(tmpdir(), "ofac-cache-"));
      const version = await adapter(fakeSls(good), { cacheDir }).listVersion();
      const dir = version.split(":")[1] as string;
      // Still a consistent list — only the version check notices.
      writeFileSync(
        join(cacheDir, "ofac", dir, "SDN.CSV"),
        SDN.replace("AEROCARIBBEAN", "AEROKARIBIK"),
      );
      const second = adapter(fakeSls(good, { down: true }), { cacheDir });
      await expect(second.screen(subject("Aerocaribbean Airlines"), T)).rejects.toBeInstanceOf(
        SanctionsProviderError,
      );
    });

    it("ignores a cache older than the maximum age", async () => {
      const cacheDir = mkdtempSync(join(tmpdir(), "ofac-cache-"));
      await adapter(fakeSls(good), {
        cacheDir,
        now: () => new Date("2026-09-20T06:00:00Z"),
      }).listVersion();
      const second = adapter(fakeSls(good, { down: true }), { cacheDir });
      await expect(second.screen(subject("Anything"), T)).rejects.toBeInstanceOf(
        SanctionsProviderError,
      );
    });
  });
});
