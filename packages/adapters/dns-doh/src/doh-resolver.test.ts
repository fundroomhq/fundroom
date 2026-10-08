import type { OutboundFetch } from "@fundroom/ports";
import { describe, expect, it, vi } from "vitest";
import { createDohResolver, DEFAULT_DOH_ENDPOINTS } from "./doh-resolver.js";

const CF = "https://1.1.1.1/dns-query";
const GOOG = "https://8.8.8.8/resolve";

interface Rr {
  readonly name: string;
  readonly type: number;
  readonly data: string;
}

function body(status: number, answer: readonly Rr[] = []): string {
  return JSON.stringify({ Status: status, Answer: answer });
}

function json(payload: string, init: ResponseInit = {}): Response {
  return new Response(payload, { status: 200, ...init });
}

/** A fetch that answers per endpoint host, so a test can give each resolver its own view. */
function fetchBy(handlers: Readonly<Record<string, (url: URL) => Response | Promise<Response>>>): {
  fetch: OutboundFetch;
  calls: URL[];
} {
  const calls: URL[] = [];
  const fetch: OutboundFetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    const handler = handlers[url.host];
    if (handler === undefined) throw new Error(`connect ECONNREFUSED ${url.host}`);
    return await handler(url);
  };
  return { fetch, calls };
}

const cnameAnswer = [{ name: "investors.acme.com.", type: 5, data: "edge.fundroom.app." }];
const txtAnswer = [{ name: "_fundroom-challenge.investors.acme.com.", type: 16, data: '"tok3n"' }];

describe("createDohResolver", () => {
  it("defaults to the two IP-literal endpoints", () => {
    expect(DEFAULT_DOH_ENDPOINTS).toEqual([CF, GOOG]);
  });

  it("self-identifies as the doh driver", () => {
    const { fetch } = fetchBy({});
    expect(createDohResolver({ fetch }).driver).toBe("doh");
  });

  it("asks for the JSON API and passes name and type as query parameters", async () => {
    const { fetch, calls } = fetchBy({
      "1.1.1.1": () => json(body(0, cnameAnswer)),
      "8.8.8.8": () => json(body(0, cnameAnswer)),
    });
    const spy = vi.fn(fetch);
    const resolver = createDohResolver({ fetch: spy });
    await resolver.resolve("investors.acme.com", "CNAME");

    expect(calls.map((url) => url.host).sort()).toEqual(["1.1.1.1", "8.8.8.8"]);
    expect(calls[0]?.searchParams.get("name")).toBe("investors.acme.com");
    expect(calls[0]?.searchParams.get("type")).toBe("CNAME");
    expect(spy.mock.calls[0]?.[1]).toMatchObject({
      headers: { accept: "application/dns-json" },
    });
  });

  it("returns a positive answer when both endpoints agree", async () => {
    const { fetch } = fetchBy({
      "1.1.1.1": () => json(body(0, cnameAnswer)),
      "8.8.8.8": () => json(body(0, cnameAnswer)),
    });
    const answer = await createDohResolver({ fetch }).resolve("investors.acme.com", "CNAME");
    expect(answer).toMatchObject({
      name: "investors.acme.com",
      type: "CNAME",
      values: ["edge.fundroom.app"],
      rcode: "ok",
    });
    expect(answer.resolver).toContain("1.1.1.1");
  });

  it("does NOT verify when two resolvers disagree (split brain)", async () => {
    const { fetch } = fetchBy({
      "1.1.1.1": () => json(body(0, cnameAnswer)),
      "8.8.8.8": () =>
        json(body(0, [{ name: "investors.acme.com.", type: 5, data: "attacker.example." }])),
    });
    const log = vi.fn();
    const answer = await createDohResolver({ fetch, log }).resolve("investors.acme.com", "CNAME");
    expect(answer.values).toEqual([]);
    expect(answer.rcode).toBe("other");
    expect(log).toHaveBeenCalledWith("dns.doh.no_quorum", expect.anything());
  });

  it("does NOT verify when only one resolver sees the record", async () => {
    const { fetch } = fetchBy({
      "1.1.1.1": () => json(body(0, cnameAnswer)),
      "8.8.8.8": () => json(body(0, [])),
    });
    const answer = await createDohResolver({ fetch }).resolve("investors.acme.com", "CNAME");
    expect(answer.values).toEqual([]);
  });

  it("does NOT verify when only one resolver is reachable", async () => {
    const { fetch } = fetchBy({ "1.1.1.1": () => json(body(0, cnameAnswer)) });
    const answer = await createDohResolver({ fetch }).resolve("investors.acme.com", "CNAME");
    expect(answer.values).toEqual([]);
    expect(answer.rcode).toBe("other");
  });

  it("ignores value order and duplicates when comparing the two views", async () => {
    const two = (a: string, b: string) => [
      { name: "acme.com.", type: 1, data: a },
      { name: "acme.com.", type: 1, data: b },
    ];
    const { fetch } = fetchBy({
      "1.1.1.1": () => json(body(0, two("203.0.113.7", "203.0.113.8"))),
      "8.8.8.8": () => json(body(0, two("203.0.113.8", "203.0.113.7"))),
    });
    const answer = await createDohResolver({ fetch }).resolve("acme.com", "A");
    expect(answer.values).toEqual(["203.0.113.7", "203.0.113.8"]);
  });

  it("reports NXDOMAIN as soon as the endpoints agree it is negative", async () => {
    const { fetch } = fetchBy({
      "1.1.1.1": () => json(body(3)),
      "8.8.8.8": () => json(body(3)),
    });
    const answer = await createDohResolver({ fetch }).resolve("nope.acme.com", "CNAME");
    expect(answer).toMatchObject({ rcode: "nxdomain", values: [] });
  });

  it("maps SERVFAIL and REFUSED", async () => {
    const codes = [
      [2, "servfail"],
      [5, "refused"],
      [9, "other"],
    ] as const;
    for (const [status, expected] of codes) {
      const { fetch } = fetchBy({
        "1.1.1.1": () => json(body(status)),
        "8.8.8.8": () => json(body(status)),
      });
      const answer = await createDohResolver({ fetch }).resolve("acme.com", "TXT");
      expect(answer.rcode, String(status)).toBe(expected);
    }
  });

  it("reports a single negative even when the other endpoint is unreachable", async () => {
    const { fetch } = fetchBy({ "1.1.1.1": () => json(body(3)) });
    const answer = await createDohResolver({ fetch }).resolve("nope.acme.com", "CNAME");
    expect(answer).toMatchObject({ rcode: "nxdomain", resolver: "1.1.1.1" });
  });

  it("never throws when every endpoint is unreachable", async () => {
    const { fetch } = fetchBy({});
    const answer = await createDohResolver({ fetch }).resolve("acme.com", "TXT");
    expect(answer).toEqual({
      name: "acme.com",
      type: "TXT",
      values: [],
      rcode: "other",
      resolver: "none",
      chain: undefined,
    });
  });

  it("never throws on a non-200 or on unparseable JSON", async () => {
    const { fetch } = fetchBy({
      "1.1.1.1": () => json("not json"),
      "8.8.8.8": () => json("{}", { status: 502 }),
    });
    const log = vi.fn();
    const answer = await createDohResolver({ fetch, log }).resolve("acme.com", "TXT");
    expect(answer.values).toEqual([]);
    expect(log).toHaveBeenCalledWith("dns.doh.http_error", expect.anything());
  });

  it("joins chunked TXT strings and drops the quoting", async () => {
    const chunked = [
      { name: "_fundroom-challenge.acme.com.", type: 16, data: '"abcdef" "ghijkl"' },
    ];
    const { fetch } = fetchBy({
      "1.1.1.1": () => json(body(0, chunked)),
      "8.8.8.8": () => json(body(0, chunked)),
    });
    const answer = await createDohResolver({ fetch }).resolve(
      "_fundroom-challenge.acme.com",
      "TXT",
    );
    expect(answer.values).toEqual(["abcdefghijkl"]);
  });

  it("lower-cases and strips the trailing dot off every value", async () => {
    const mixed = [{ name: "acme.com.", type: 5, data: "Edge.FundRoom.App." }];
    const { fetch } = fetchBy({
      "1.1.1.1": () => json(body(0, mixed)),
      "8.8.8.8": () => json(body(0, mixed)),
    });
    const answer = await createDohResolver({ fetch }).resolve("acme.com", "CNAME");
    expect(answer.values).toEqual(["edge.fundroom.app"]);
  });

  it("records the CNAME chain outermost first and keeps the final value separate", async () => {
    const chained = [
      { name: "investors.acme.com.", type: 5, data: "proxy.example.net." },
      { name: "proxy.example.net.", type: 5, data: "edge.fundroom.app." },
      { name: "edge.fundroom.app.", type: 1, data: "203.0.113.7" },
    ];
    const { fetch } = fetchBy({
      "1.1.1.1": () => json(body(0, chained)),
      "8.8.8.8": () => json(body(0, chained)),
    });
    const answer = await createDohResolver({ fetch }).resolve("investors.acme.com", "A");
    expect(answer.chain).toEqual(["proxy.example.net", "edge.fundroom.app"]);
    expect(answer.values).toEqual(["203.0.113.7"]);
  });

  it("ignores records of a type we did not ask for", async () => {
    const noise = [
      { name: "acme.com.", type: 16, data: '"v=spf1 -all"' },
      { name: "acme.com.", type: 46, data: "signature" },
    ];
    const { fetch } = fetchBy({
      "1.1.1.1": () => json(body(0, noise)),
      "8.8.8.8": () => json(body(0, noise)),
    });
    const answer = await createDohResolver({ fetch }).resolve("acme.com", "TXT");
    expect(answer.values).toEqual(["v=spf1 -all"]);
  });

  it("honours a quorum of 3 across three endpoints", async () => {
    const endpoints = [CF, GOOG, "https://9.9.9.9/dns-query"];
    const agree = { "1.1.1.1": () => json(body(0, cnameAnswer)) };
    const twoOfThree = fetchBy({
      ...agree,
      "8.8.8.8": () => json(body(0, cnameAnswer)),
      "9.9.9.9": () => json(body(0, [])),
    });
    const answer = await createDohResolver({
      fetch: twoOfThree.fetch,
      endpoints,
      quorum: 3,
    }).resolve("investors.acme.com", "CNAME");
    expect(answer.values).toEqual([]);

    const allThree = fetchBy({
      ...agree,
      "8.8.8.8": () => json(body(0, cnameAnswer)),
      "9.9.9.9": () => json(body(0, cnameAnswer)),
    });
    const verified = await createDohResolver({
      fetch: allThree.fetch,
      endpoints,
      quorum: 3,
    }).resolve("investors.acme.com", "CNAME");
    expect(verified.values).toEqual(["edge.fundroom.app"]);
  });

  it("verifies on two of three when quorum is 2, naming both resolvers", async () => {
    const { fetch } = fetchBy({
      "1.1.1.1": () => json(body(0, cnameAnswer)),
      "8.8.8.8": () => json(body(0, cnameAnswer)),
      "9.9.9.9": () => json(body(0, [])),
    });
    const answer = await createDohResolver({
      fetch,
      endpoints: [CF, GOOG, "https://9.9.9.9/dns-query"],
    }).resolve("investors.acme.com", "CNAME");
    expect(answer.values).toEqual(["edge.fundroom.app"]);
    expect(answer.resolver).toBe("1.1.1.1+8.8.8.8");
  });

  it("clamps an impossible quorum to the endpoint count and logs it", async () => {
    const { fetch } = fetchBy({ "1.1.1.1": () => json(body(0, txtAnswer)) });
    const log = vi.fn();
    const resolver = createDohResolver({ fetch, endpoints: [CF], log });
    expect(log).toHaveBeenCalledWith("dns.doh.quorum_clamped", {
      requested: 2,
      quorum: 1,
      endpoints: 1,
    });
    const answer = await resolver.resolve("_fundroom-challenge.investors.acme.com", "TXT");
    expect(answer.values).toEqual(["tok3n"]);
  });

  it("falls back to the defaults when endpoints is empty", async () => {
    const { fetch, calls } = fetchBy({
      "1.1.1.1": () => json(body(0, cnameAnswer)),
      "8.8.8.8": () => json(body(0, cnameAnswer)),
    });
    await createDohResolver({ fetch, endpoints: [] }).resolve("investors.acme.com", "CNAME");
    expect(calls).toHaveLength(2);
  });

  it("healthCheck passes when any endpoint answers", async () => {
    const { fetch } = fetchBy({
      "1.1.1.1": () => json(body(0, [{ name: "example.com.", type: 1, data: "93.184.215.14" }])),
    });
    await expect(createDohResolver({ fetch }).healthCheck()).resolves.toBeUndefined();
  });

  it("healthCheck throws when no endpoint answers", async () => {
    const { fetch } = fetchBy({});
    await expect(createDohResolver({ fetch }).healthCheck()).rejects.toThrow(
      /no DoH endpoint answered/u,
    );
  });
});

/*
 * Quorum is about resolver *identity*, not answer count (E2.1 S4).
 *
 * Confirmed empirically before the fix: `DOH_ENDPOINTS=<cf>,<cf>` passed the prod config rule
 * (which only checked `length < 2`) and then satisfied a quorum of 2, because `reduceAnswers`
 * counted answers. One resolver, one cache, and ADR-0039 decision 6 silently downgraded.
 */
describe("two identical endpoints are one resolver", () => {
  it("dedupes the endpoint list by host and clamps the quorum to what is left", async () => {
    const logged: { event: string; fields?: Readonly<Record<string, unknown>> }[] = [];
    const { fetch, calls } = fetchBy({ "1.1.1.1": () => json(body(0, cnameAnswer)) });
    const resolver = createDohResolver({
      fetch,
      endpoints: [CF, CF],
      log: (event, fields) => logged.push({ event, ...(fields === undefined ? {} : { fields }) }),
    });
    await resolver.resolve("investors.acme.com", "CNAME");
    // Asked once, not twice: the second entry was the same resolver.
    expect(calls.map((url) => url.host)).toEqual(["1.1.1.1"]);
    expect(logged.map((l) => l.event)).toContain("dns.doh.endpoints_deduped");
    // And the operator is told the guarantee is gone, rather than it passing quietly.
    expect(logged.map((l) => l.event)).toContain("dns.doh.quorum_clamped");
  });

  it("refuses to reach a quorum of two from one resolver counted twice", async () => {
    /*
     * The sharp case. Three endpoints, two of them the same host: Cloudflare says the CNAME
     * points at our edge, Google says it points somewhere else. Counting *answers* found two for
     * Cloudflare's value and called quorum met — a verdict minted by a single resolver while the
     * only independent one disagreed. Counting distinct resolvers (and deduping the list before
     * asking at all) gives one apiece, no quorum, and the weaker answer.
     */
    const { fetch } = fetchBy({
      "1.1.1.1": () => json(body(0, cnameAnswer)),
      "8.8.8.8": () =>
        json(body(0, [{ name: "investors.acme.com.", type: 5, data: "other.example.net." }])),
    });
    const resolver = createDohResolver({ fetch, endpoints: [CF, CF, GOOG] });
    const answer = await resolver.resolve("investors.acme.com", "CNAME");
    expect(answer.values).toEqual([]);
    expect(answer.rcode).toBe("other");
  });

  it("a deduped list is exactly a single-resolver install: clamped, logged, and prod refuses it", async () => {
    // `[CF, CF]` is not "quorum met"; it is one resolver. The adapter clamps rather than
    // refusing, because a legitimate single-resolver dev install has to keep working — and
    // `crossFieldRules` is what turns that into a configuration error in prod.
    const { fetch } = fetchBy({ "1.1.1.1": () => json(body(0, cnameAnswer)) });
    const answer = await createDohResolver({ fetch, endpoints: [CF, CF] }).resolve(
      "investors.acme.com",
      "CNAME",
    );
    expect(answer.resolver).toBe("1.1.1.1");
  });

  it("still reaches a quorum of two from two genuinely different hosts", async () => {
    const { fetch } = fetchBy({
      "1.1.1.1": () => json(body(0, cnameAnswer)),
      "8.8.8.8": () => json(body(0, cnameAnswer)),
    });
    const answer = await createDohResolver({ fetch, endpoints: [CF, GOOG] }).resolve(
      "investors.acme.com",
      "CNAME",
    );
    expect(answer.values).toEqual(["edge.fundroom.app"]);
  });
});

/*
 * Bailiwick and rcode (E2.1 M11). Neither is reachable without two colluding resolvers, so
 * decision 6 still holds — this is the cheap defence in depth that was missing, and it makes the
 * adapter internally consistent with `modules/updates`' `lookupTxt`, which already treats
 * SERVFAIL as "we could not look".
 */
describe("defence in depth", () => {
  it("drops an answer record whose owner name is an unrelated host", async () => {
    const smuggled = [{ name: "attacker.example.", type: 16, data: '"tok3n"' }, ...txtAnswer];
    const { fetch } = fetchBy({
      "1.1.1.1": () => json(body(0, smuggled)),
      "8.8.8.8": () => json(body(0, smuggled)),
    });
    const logged: string[] = [];
    const answer = await createDohResolver({ fetch, log: (event) => logged.push(event) }).resolve(
      "_fundroom-challenge.investors.acme.com",
      "TXT",
    );
    // The in-bailiwick record survives; the smuggled one does not, and it is logged.
    expect(answer.values).toEqual(["tok3n"]);
    expect(logged).toContain("dns.doh.out_of_bailiwick");
  });

  it("keeps records reached through the CNAME chain, in whatever order they arrive", async () => {
    const chained = [
      { name: "proxy.example.net.", type: 1, data: "203.0.113.7" },
      { name: "investors.acme.com.", type: 5, data: "proxy.example.net." },
    ];
    const { fetch } = fetchBy({
      "1.1.1.1": () => json(body(0, chained)),
      "8.8.8.8": () => json(body(0, chained)),
    });
    const answer = await createDohResolver({ fetch }).resolve("investors.acme.com", "A");
    expect(answer.values).toEqual(["203.0.113.7"]);
    expect(answer.chain).toEqual(["proxy.example.net"]);
  });

  it("reports the rcode a SERVFAIL carrying an answer really had", async () => {
    // Status 2 with a record in it. `evaluate` now requires `rcode === "ok"` for a positive
    // verdict, so surfacing the real rcode is what closes it.
    const { fetch } = fetchBy({
      "1.1.1.1": () => json(body(2, cnameAnswer)),
      "8.8.8.8": () => json(body(2, cnameAnswer)),
    });
    const answer = await createDohResolver({ fetch }).resolve("investors.acme.com", "CNAME");
    expect(answer.rcode).toBe("servfail");
  });
});
