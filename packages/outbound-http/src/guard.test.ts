import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { OutboundHttpError } from "@fundroom/ports";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AddressLookup, createOutboundHttp, type OutboundHttpOptions } from "./guard.js";

/*
 * Two local servers on 127.0.0.1. The injected resolver maps `public.test` and
 * `other.test` to them so the guard treats them as public names; `allowedPrivateHosts`
 * lets the connection reach loopback. Every request the servers see is recorded.
 */
interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

let a: Server;
let b: Server;
let portA = 0;
let portB = 0;
const seenA: Seen[] = [];
const seenB: Seen[] = [];

function record(list: Seen[], req: IncomingMessage, cb: (body: string) => void): void {
  let body = "";
  req.on("data", (c: Buffer) => {
    body += c.toString();
  });
  req.on("end", () => {
    list.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
    cb(body);
  });
}

function handlerA(req: IncomingMessage, res: ServerResponse): void {
  record(seenA, req, (body) => {
    const url = new URL(req.url ?? "/", "http://public.test");
    switch (url.pathname) {
      case "/ok":
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("hello");
        return;
      case "/echo":
        res.writeHead(200, { "content-type": "text/plain", "x-method": req.method ?? "" });
        res.end(body);
        return;
      case "/to-metadata":
        res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" });
        res.end();
        return;
      case "/to-localhost":
        res.writeHead(302, { location: "http://localhost/" });
        res.end();
        return;
      case "/loop":
        res.writeHead(302, { location: "/loop" });
        res.end();
        return;
      case "/to-userinfo":
        res.writeHead(302, { location: `http://user:pw@public.test:${portA}/ok` });
        res.end();
        return;
      case "/hop":
        res.writeHead(307, { location: "/echo" });
        res.end();
        return;
      case "/see-other":
        res.writeHead(303, { location: "/echo" });
        res.end();
        return;
      case "/cross":
        res.writeHead(302, { location: `http://other.test:${portB}/echo-auth` });
        res.end();
        return;
      case "/same-auth":
        res.writeHead(302, { location: "/echo-auth" });
        res.end();
        return;
      case "/echo-auth":
        res.writeHead(200, { "x-auth": req.headers.authorization ?? "none" });
        res.end("");
        return;
      case "/big-known": {
        const buf = Buffer.alloc(2 * 1024 * 1024, "x");
        res.writeHead(200, { "content-length": String(buf.length) });
        res.end(buf);
        return;
      }
      case "/big-chunked": {
        res.writeHead(200, { "transfer-encoding": "chunked" });
        const chunk = Buffer.alloc(64 * 1024, "y");
        let sent = 0;
        const push = (): void => {
          while (sent < 2 * 1024 * 1024) {
            sent += chunk.length;
            if (!res.write(chunk)) {
              res.once("drain", push);
              return;
            }
          }
          res.end();
        };
        push();
        return;
      }
      case "/slow":
        setTimeout(() => {
          res.writeHead(200);
          res.end("late");
        }, 1500);
        return;
      case "/slow-body":
        res.writeHead(200, { "transfer-encoding": "chunked" });
        res.write("start");
        setTimeout(() => res.end("end"), 1500);
        return;
      default:
        res.writeHead(404);
        res.end();
    }
  });
}

function handlerB(req: IncomingMessage, res: ServerResponse): void {
  record(seenB, req, () => {
    res.writeHead(200, { "x-auth": req.headers.authorization ?? "none" });
    res.end("b");
  });
}

beforeAll(async () => {
  a = createServer(handlerA);
  b = createServer(handlerB);
  await new Promise<void>((r) => a.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => b.listen(0, "127.0.0.1", r));
  portA = (a.address() as AddressInfo).port;
  portB = (b.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => a.close(() => r()));
  await new Promise<void>((r) => b.close(() => r()));
});

const loopback: AddressLookup = async (hostname) => {
  if (hostname === "public.test" || hostname === "other.test") {
    return [{ address: "127.0.0.1", family: 4 }];
  }
  if (hostname === "rebind.test")
    return [
      { address: "1.1.1.1", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ];
  if (hostname === "nowhere.test") return [];
  throw new Error(`ENOTFOUND ${hostname}`);
};

function client(overrides: Partial<OutboundHttpOptions> = {}) {
  return createOutboundHttp({
    lookup: loopback,
    allowedPrivateHosts: ["public.test", "other.test"],
    timeoutMs: 800,
    ...overrides,
  });
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    if (e instanceof OutboundHttpError) return e.code;
    throw e;
  }
}

describe("createOutboundHttp", () => {
  it("blocks loopback literals under the default policy", async () => {
    const http = createOutboundHttp({ lookup: loopback });
    await expect(codeOf(http.fetch(`http://127.0.0.1:${portA}/ok`))).resolves.toBe("blocked_port");
    await expect(codeOf(http.fetch(`http://127.0.0.1/ok`))).resolves.toBe("blocked_address");
    await expect(codeOf(http.fetch(`http://public.test:${portA}/ok`))).resolves.toBe(
      "blocked_port",
    );
    await http.close();
  });

  it("blocks a public name that resolves (partly) to a private address", async () => {
    const http = createOutboundHttp({ lookup: loopback });
    await expect(codeOf(http.fetch("http://rebind.test/"))).resolves.toBe("blocked_address");
    await expect(codeOf(http.fetch("http://nowhere.test/"))).resolves.toBe("dns_failed");
    await expect(codeOf(http.fetch("http://unknown.test/"))).resolves.toBe("dns_failed");
    await http.close();
  });

  it("reaches an allowed host, keeps the hostname in Host, pins the address", async () => {
    const http = client();
    const res = await http.fetch(`http://public.test:${portA}/ok`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
    const last = seenA.at(-1);
    expect(last?.headers.host).toBe(`public.test:${portA}`);
    expect(last?.headers["user-agent"]).toBe("FundRoom");
    await http.close();
  });

  it("never resolves a hostname that was not assessed (fails closed)", async () => {
    const http = client();
    const verdict = http.assess(`http://public.test:${portA}/`);
    expect(verdict.ok).toBe(true);
    expect(http.assess("http://10.1.1.1/")).toMatchObject({ ok: false, code: "blocked_address" });
    await http.close();
  });

  it("sends the request body and method", async () => {
    const http = client();
    const res = await http.fetch(`http://public.test:${portA}/echo`, {
      method: "POST",
      body: JSON.stringify({ a: 1 }),
      headers: { "content-type": "application/json" },
    });
    expect(await res.text()).toBe('{"a":1}');
    expect(res.headers.get("x-method")).toBe("POST");
    await http.close();
  });

  it("accepts a Request object as input", async () => {
    const http = client();
    const res = await http.fetch(
      new Request(`http://public.test:${portA}/echo`, { method: "PUT", body: "r" }),
    );
    expect(await res.text()).toBe("r");
    expect(res.headers.get("x-method")).toBe("PUT");
    await http.close();
  });

  it("re-checks every redirect hop", async () => {
    const http = client();
    await expect(codeOf(http.fetch(`http://public.test:${portA}/to-metadata`))).resolves.toBe(
      "blocked_address",
    );
    await expect(codeOf(http.fetch(`http://public.test:${portA}/to-localhost`))).resolves.toBe(
      "blocked_host",
    );
    await http.close();
  });

  it("follows relative redirects and replays the body on 307, drops it on 303", async () => {
    const http = client();
    const r307 = await http.fetch(`http://public.test:${portA}/hop`, {
      method: "POST",
      body: "again",
    });
    expect(await r307.text()).toBe("again");
    expect(r307.headers.get("x-method")).toBe("POST");
    const r303 = await http.fetch(`http://public.test:${portA}/see-other`, {
      method: "POST",
      body: "gone",
    });
    expect(await r303.text()).toBe("");
    expect(r303.headers.get("x-method")).toBe("GET");
    await http.close();
  });

  it("stops after maxRedirects", async () => {
    const http = client();
    await expect(codeOf(http.fetch(`http://public.test:${portA}/loop`))).resolves.toBe(
      "too_many_redirects",
    );
    const two = client({ maxRedirects: 2 });
    await expect(codeOf(two.fetch(`http://public.test:${portA}/loop`))).resolves.toBe(
      "too_many_redirects",
    );
    await http.close();
    await two.close();
  });

  it("asks redirectAllowed before following, with the target and the hop number", async () => {
    const asked: [string, number][] = [];
    const before = seenB.length;
    const refuse = client({
      redirectAllowed: (to, hop) => {
        asked.push([to.hostname, hop]);
        return false;
      },
    });
    await expect(codeOf(refuse.fetch(`http://public.test:${portA}/cross`))).resolves.toBe(
      "blocked_host",
    );
    expect(asked).toEqual([["other.test", 1]]);
    // Refused before any request reached the target.
    expect(seenB.length).toBe(before);
    const allow = client({ redirectAllowed: (to) => to.hostname === "other.test" });
    expect((await allow.fetch(`http://public.test:${portA}/cross`)).status).toBe(200);
    await refuse.close();
    await allow.close();
  });

  it("drops Authorization on a cross-origin redirect but keeps it same-origin", async () => {
    const http = client();
    const cross = await http.fetch(`http://public.test:${portA}/cross`, {
      headers: { authorization: "Bearer secret", cookie: "sid=1" },
    });
    expect(cross.headers.get("x-auth")).toBe("none");
    expect(seenB.at(-1)?.headers.cookie).toBeUndefined();
    const same = await http.fetch(`http://public.test:${portA}/same-auth`, {
      headers: { authorization: "Bearer secret" },
    });
    expect(same.headers.get("x-auth")).toBe("Bearer secret");
    await http.close();
  });

  it("caps the body by Content-Length and by counting chunks", async () => {
    const http = client();
    await expect(codeOf(http.fetch(`http://public.test:${portA}/big-known`))).resolves.toBe(
      "response_too_large",
    );
    const res = await http.fetch(`http://public.test:${portA}/big-chunked`);
    expect(res.status).toBe(200);
    await expect(codeOf(res.arrayBuffer())).resolves.toBe("response_too_large");
    const roomy = client({ maxResponseBytes: 3 * 1024 * 1024 });
    const ok = await roomy.fetch(`http://public.test:${portA}/big-chunked`);
    expect((await ok.arrayBuffer()).byteLength).toBe(2 * 1024 * 1024);
    await http.close();
    await roomy.close();
  });

  it("truncates instead of failing when asked to (status kept, body cut at the cap)", async () => {
    const http = client({ oversizeResponse: "truncate", maxResponseBytes: 1024 });
    const known = await http.fetch(`http://public.test:${portA}/big-known`);
    expect(known.status).toBe(200);
    expect((await known.arrayBuffer()).byteLength).toBe(0);
    const chunked = await http.fetch(`http://public.test:${portA}/big-chunked`);
    expect(chunked.status).toBe(200);
    expect((await chunked.arrayBuffer()).byteLength).toBe(1024);
    await http.close();
  });

  it("caps concurrent DNS lookups when asked to, failing fast without starting another", async () => {
    let started = 0;
    const http = createOutboundHttp({
      timeoutMs: 200,
      maxConcurrentLookups: 2,
      lookup: () => {
        started++;
        return new Promise(() => {});
      },
    });
    await expect(codeOf(http.fetch("https://a.example/"))).resolves.toBe("timeout");
    await expect(codeOf(http.fetch("https://b.example/"))).resolves.toBe("timeout");
    // Both hung lookups still hold their slots after their requests timed out.
    await expect(codeOf(http.fetch("https://c.example/"))).resolves.toBe("dns_failed");
    expect(started).toBe(2);
    await http.close();
    // Unlimited by default.
    let n = 0;
    const open = createOutboundHttp({
      timeoutMs: 100,
      lookup: () => {
        n++;
        return new Promise(() => {});
      },
    });
    for (const h of ["a", "b", "c"]) await codeOf(open.fetch(`https://${h}.example/`));
    expect(n).toBe(3);
    await open.close();
  });

  it("a caller's abort stops waiting for DNS and surfaces as the caller's abort", async () => {
    const http = createOutboundHttp({ timeoutMs: 5_000, lookup: () => new Promise(() => {}) });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const started = Date.now();
    await expect(
      http.fetch("https://slow-dns.example/", { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - started).toBeLessThan(2_000);
    await http.close();
  });

  it("bounds the DNS lookup by the request deadline", async () => {
    const http = createOutboundHttp({
      timeoutMs: 300,
      lookup: () => new Promise(() => {}),
    });
    const started = Date.now();
    await expect(codeOf(http.fetch("https://slow-dns.example/"))).resolves.toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2_000);
    await http.close();
  });

  it("times out slow responses", async () => {
    const http = client({ timeoutMs: 300 });
    await expect(codeOf(http.fetch(`http://public.test:${portA}/slow`))).resolves.toBe("timeout");
    await http.close();
  });

  it("honours the caller's abort signal separately from the deadline", async () => {
    const http = client({ timeoutMs: 5000 });
    const controller = new AbortController();
    const p = http.fetch(`http://public.test:${portA}/slow`, { signal: controller.signal });
    controller.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    await http.close();
  });

  it("rejects the scheme before touching DNS", async () => {
    let calls = 0;
    const http = createOutboundHttp({
      lookup: async (h) => {
        calls++;
        return loopback(h);
      },
    });
    await expect(codeOf(http.fetch("ftp://public.test/"))).resolves.toBe("blocked_scheme");
    expect(calls).toBe(0);
    await http.close();
  });

  it("refuses a URL with credentials as an OutboundHttpError, never a bare TypeError (P2b-01)", async () => {
    let calls = 0;
    const http = client({
      lookup: async (h) => {
        calls++;
        return loopback(h);
      },
    });
    const before = seenA.length;
    for (const url of [
      "http://spoofed.example.com@127.0.0.1/",
      `http://user@public.test:${portA}/ok`,
      `http://user:secret@public.test:${portA}/ok`,
      new URL(`http://:secret@public.test:${portA}/ok`),
    ]) {
      const error = await http.fetch(url).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(OutboundHttpError);
      expect((error as OutboundHttpError).code).toBe("blocked_host");
      expect((error as OutboundHttpError).message).toMatch(/credentials/u);
      // The redacted URL never repeats the userinfo.
      expect((error as OutboundHttpError).url ?? "").not.toMatch(/secret|user|spoofed/u);
    }
    // A relative URL is refused the same way, not with the Request constructor's TypeError.
    await expect(codeOf(http.fetch("/relative"))).resolves.toBe("blocked_scheme");
    expect(calls).toBe(0);
    expect(seenA.length).toBe(before);
    // A redirect to a userinfo URL is refused per hop, too.
    await expect(codeOf(http.fetch(`http://public.test:${portA}/to-userinfo`))).resolves.toBe(
      "blocked_host",
    );
    await http.close();
  });

  it("close() destroys the pool", async () => {
    const http = client();
    await http.fetch(`http://public.test:${portA}/ok`);
    await http.close();
    await expect(http.fetch(`http://public.test:${portA}/ok`)).rejects.toBeInstanceOf(Error);
  });
});
