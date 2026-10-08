/*
 * A DNS-over-HTTPS *JSON* endpoint in front of a plain DNS server.
 *
 * `@fundroom/dns-doh` deliberately speaks the Cloudflare/Google JSON API
 * (`GET ?name=<name>&type=<A|AAAA|CNAME|TXT>` with `accept: application/dns-json`, answered
 * with `{ "Status": <rcode>, "Answer": [{ "name", "type", "data" }] }`) because that is what
 * 1.1.1.1 and 8.8.8.8 serve. `pebble-challtestsrv` speaks plain DNS and RFC 8484 wire-format
 * DoH, and nothing in this rig speaks JSON — so this translates, in one direction, with no
 * record store of its own.
 *
 * Holding no records is the point: the zone lives in challtestsrv and *only* there, so the CA
 * (Pebble, pointed at it with `-dnsserver`) and the app (pointed here) necessarily see the same
 * answers. A shim with its own copy could have let the app verify a hostname the CA could not
 * resolve, and the test would have proved nothing.
 *
 * No workspace imports and no dependencies — `node:dns` and `node:http` only — for the same
 * reason the rest of `e2e/` has none: this has to exercise the shipped image from outside.
 *
 *   UPSTREAM_DNS  ip[:port] of the DNS server to forward to (default 127.0.0.1:8053)
 *   PORT          HTTP port to listen on (default 8053)
 */

import { Resolver } from "node:dns/promises";
import { createServer } from "node:http";

const UPSTREAM = process.env["UPSTREAM_DNS"] ?? "127.0.0.1:8053";
const PORT = Number(process.env["PORT"] ?? 8053);

/** RFC 1035 / 3596 type numbers — how the JSON API labels records. */
const TYPES = { A: 1, AAAA: 28, CNAME: 5, TXT: 16 };

/** DNS RCODEs the JSON API reports verbatim in `Status`. */
const NOERROR = 0;
const SERVFAIL = 2;
const NXDOMAIN = 3;
const REFUSED = 5;

const resolver = new Resolver({ timeout: 1500, tries: 2 });
resolver.setServers([UPSTREAM]);

/** A TXT record's JSON `data` is the presentation form: each chunk quoted, chunks joined. */
const quote = (chunks) =>
  chunks.map((chunk) => `"${chunk.replace(/(["\\])/gu, "\\$1")}"`).join(" ");

async function lookup(name, type) {
  switch (type) {
    case "CNAME":
      return (await resolver.resolveCname(name)).map((target) => ({
        type: TYPES.CNAME,
        data: target,
      }));
    case "TXT":
      return (await resolver.resolveTxt(name)).map((chunks) => ({
        type: TYPES.TXT,
        data: quote(chunks),
      }));
    case "A":
      return (await resolver.resolve4(name)).map((address) => ({ type: TYPES.A, data: address }));
    case "AAAA":
      return (await resolver.resolve6(name)).map((address) => ({
        type: TYPES.AAAA,
        data: address,
      }));
    default:
      return undefined;
  }
}

/*
 * c-ares reports "the name does not exist" and "the name exists with no record of this type"
 * as two different errors, and the distinction is load-bearing: the app's verifier treats
 * NXDOMAIN as "nothing published here" and NOERROR-with-no-answer as "wrong record type",
 * and it prints a different sentence for each. Collapsing them would have hidden the
 * difference the operator needs to see.
 */
function statusFor(code) {
  if (code === "ENOTFOUND") return NXDOMAIN;
  if (code === "ENODATA") return NOERROR;
  if (code === "EREFUSED") return REFUSED;
  return SERVFAIL;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://shim.invalid");
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
    return;
  }
  const name = url.searchParams.get("name");
  const type = (url.searchParams.get("type") ?? "A").toUpperCase();
  if (name === null || name === "" || !(type in TYPES)) {
    res.writeHead(400, { "content-type": "application/dns-json" });
    res.end(
      JSON.stringify({ Status: SERVFAIL, Comment: `bad question: name=${name} type=${type}` }),
    );
    return;
  }

  let body;
  try {
    const records = await lookup(name, type);
    body = { Status: NOERROR, Answer: records.map((record) => ({ name, ...record, TTL: 60 })) };
  } catch (error) {
    body = { Status: statusFor(error?.code), Answer: [], Comment: String(error?.code ?? error) };
  }
  // Every question and answer, so `docker compose logs doh` is the zone's transcript.
  process.stdout.write(`${type} ${name} -> ${body.Status} ${JSON.stringify(body.Answer ?? [])}\n`);
  res.writeHead(200, { "content-type": "application/dns-json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
});

server.listen(PORT, () => process.stdout.write(`doh-shim: :${PORT} -> dns ${UPSTREAM}\n`));
