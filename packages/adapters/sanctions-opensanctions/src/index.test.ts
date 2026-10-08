import { type OutboundFetch, SanctionsProviderError } from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import { createOpenSanctionsScreening } from "./index.js";

/*
 * The OpenSanctions adapter against an in-memory yente (E3.10): the request shape, the ApiKey
 * header only when configured, threshold handling (ours, not yente's `match`), the catalog
 * version, and failing closed on every malformed or failed answer.
 */

interface Call {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly body: unknown;
}

function fakeYente(
  respond: (call: Call) => Response | Promise<Response>,
  catalog: unknown = { datasets: [{ name: "sanctions", version: "20260927061502-abc" }] },
) {
  const calls: Call[] = [];
  const fetch: OutboundFetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const call: Call = {
      method: init?.method ?? "GET",
      url,
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    if (url.pathname.endsWith("/catalog")) return Response.json(catalog);
    return respond(call);
  };
  return { fetch, calls };
}

const results = (list: unknown[]) =>
  Response.json({ responses: { q: { status: 200, results: list } } });

function adapter(fetch: OutboundFetch, apiKey?: string, baseUrl = "http://yente.internal:8000") {
  return createOpenSanctionsScreening({
    fetch,
    baseUrl,
    apiKey,
    cacheDir: "/nonexistent",
    now: () => new Date("2026-09-27T06:00:00Z"),
  });
}

const subject = { name: "Rosneft Trading SA", country: "CH", kind: "organization" } as const;

describe("createOpenSanctionsScreening", () => {
  it("posts a Company query to /match/sanctions with our threshold", async () => {
    const yente = fakeYente(() =>
      results([
        {
          id: "NK-abc",
          caption: "Rosneft Oil Company",
          score: 0.93,
          match: true,
          datasets: ["us_ofac_sdn", "eu_fsf"],
        },
        // Under our threshold even though yente calls it a match.
        { id: "NK-def", caption: "Rosneft Trading", score: 0.8, match: true, datasets: [] },
      ]),
    );
    const port = adapter(yente.fetch);
    const r = await port.screen(subject, { threshold: 0.88 });
    expect(r).toEqual({
      outcome: "potential_match",
      listVersion: "opensanctions:sanctions:20260927061502-abc",
      matches: [
        {
          listEntryId: "NK-abc",
          name: "Rosneft Oil Company",
          score: 0.93,
          programs: ["us_ofac_sdn", "eu_fsf"],
          source: "OpenSanctions",
        },
      ],
    });
    const match = yente.calls.find((c) => c.method === "POST");
    expect(match?.url.pathname).toBe("/match/sanctions");
    expect(match?.url.searchParams.get("threshold")).toBe("0.88");
    expect(match?.body).toEqual({
      queries: {
        q: { schema: "Company", properties: { name: ["Rosneft Trading SA"], country: ["ch"] } },
      },
    });
    expect(match?.headers.get("authorization")).toBeNull();
    expect(port.meta.subProcessor).toBeNull();
  });

  it("is clear when nothing reaches the threshold, and sends no country when unknown", async () => {
    const yente = fakeYente(() => results([]));
    const r = await adapter(yente.fetch).screen(
      { name: "Seed Host", country: null, kind: "organization" },
      { threshold: 0.88 },
    );
    expect(r.outcome).toBe("clear");
    const body = yente.calls.find((c) => c.method === "POST")?.body as {
      queries: { q: { properties: Record<string, unknown> } };
    };
    expect(body.queries.q.properties).toEqual({ name: ["Seed Host"] });
  });

  it("sends `Authorization: ApiKey` only when a key is configured (hosted API)", async () => {
    const yente = fakeYente(() => results([]));
    const port = adapter(yente.fetch, "k3y", "https://api.opensanctions.org");
    await port.screen(subject, { threshold: 0.88 });
    expect(yente.calls.every((c) => c.headers.get("authorization") === "ApiKey k3y")).toBe(true);
    expect(port.meta.subProcessor?.name).toBe("OpenSanctions");
  });

  it("never sends the key to any other host, unless that host is named for it", async () => {
    const yente = fakeYente(() => results([]));
    await adapter(yente.fetch, "k3y", "http://yente.internal:8000").screen(subject, {
      threshold: 0.88,
    });
    expect(yente.calls.length).toBeGreaterThan(0);
    expect(yente.calls.every((c) => c.headers.get("authorization") === null)).toBe(true);
    const proxied = fakeYente(() => results([]));
    const port = createOpenSanctionsScreening(
      {
        fetch: proxied.fetch,
        baseUrl: "https://sanctions-proxy.internal",
        apiKey: "k3y",
        cacheDir: "/nonexistent",
        now: () => new Date("2026-09-27T06:00:00Z"),
      },
      { apiKeyHosts: ["Sanctions-Proxy.internal"] },
    );
    await port.screen(subject, { threshold: 0.88 });
    expect(proxied.calls.every((c) => c.headers.get("authorization") === "ApiKey k3y")).toBe(true);
    // Never in the clear, even to a named host.
    const clear = fakeYente(() => results([]));
    await createOpenSanctionsScreening(
      {
        fetch: clear.fetch,
        baseUrl: "http://sanctions-proxy.internal",
        apiKey: "k3y",
        cacheDir: "/nonexistent",
        now: () => new Date("2026-09-27T06:00:00Z"),
      },
      { apiKeyHosts: ["sanctions-proxy.internal"] },
    ).screen(subject, { threshold: 0.88 });
    expect(clear.calls.every((c) => c.headers.get("authorization") === null)).toBe(true);
  });

  it("reads the list version from the catalog", async () => {
    const port = adapter(fakeYente(() => results([])).fetch);
    expect(await port.listVersion()).toBe("opensanctions:sanctions:20260927061502-abc");
  });

  describe("fails closed", () => {
    const bad: [string, () => Response][] = [
      ["a 500", () => new Response("boom", { status: 500 })],
      ["a redirect", () => new Response(null, { status: 302, headers: { location: "/x" } })],
      ["not JSON", () => new Response("<html>", { status: 200 })],
      ["no responses", () => Response.json({})],
      ["a query error", () => Response.json({ responses: { q: { status: 400, results: [] } } })],
      ["no results array", () => Response.json({ responses: { q: { status: 200 } } })],
      ["a result without a score", () => results([{ id: "x", caption: "X" }])],
      ["a score out of range", () => results([{ id: "x", score: 7 }])],
    ];
    it.each(bad)("on %s", async (_label, respond) => {
      await expect(
        adapter(fakeYente(respond).fetch).screen(subject, { threshold: 0.88 }),
      ).rejects.toBeInstanceOf(SanctionsProviderError);
    });

    it("on a network failure", async () => {
      const fetch: OutboundFetch = async () => {
        throw new TypeError("fetch failed");
      };
      await expect(adapter(fetch).screen(subject, { threshold: 0.88 })).rejects.toBeInstanceOf(
        SanctionsProviderError,
      );
    });

    it("on a catalog without the dataset", async () => {
      const yente = fakeYente(() => results([]), { datasets: [{ name: "peps", version: "1" }] });
      await expect(adapter(yente.fetch).listVersion()).rejects.toThrow(/no version/u);
      await expect(
        adapter(yente.fetch).screen(subject, { threshold: 0.88 }),
      ).rejects.toBeInstanceOf(SanctionsProviderError);
    });
  });
});
