# @fundroom/outbound-http

SSRF-guarded `OutboundHttpPort`. Every
outbound call the kernel or a module makes on someone else's behalf — webhooks, logo import,
OIDC discovery, HIBP, link previews — goes through this instead of the global `fetch`.

```ts
import { createOutboundHttp } from "@fundroom/outbound-http";

const http = createOutboundHttp({
  allowPrivate: config.raw.OUTBOUND_HTTP_ALLOW_PRIVATE,          // dev only
  allowedPrivateHosts: config.raw.OUTBOUND_HTTP_ALLOW_PRIVATE_HOSTS, // e.g. an internal IdP
  log,
});
const res = await http.fetch("https://hooks.example.com/fundroom", { method: "POST", body });
http.assess(url); // static check for "save webhook URL" forms, no I/O
```

What a request goes through, on **every hop**:

1. **URL policy** (`policy.ts`, pure): `http`/`https` only; no userinfo (`user:pass@` →
   `blocked_host`, also on a redirect `Location`, so credentials never leave in a URL); hostnames that only
   mean something inside a network are refused (`localhost`, `*.localhost`, `*.local`,
   `*.internal`, `*.home.arpa`, `*.in-addr.arpa`, `*.ip6.arpa`, `metadata.google.internal`);
   port must be 80 or 443 (`allowedPorts`); an IP literal is checked against the blocked
   ranges below.
2. **DNS pre-resolution** through an injectable `lookup`; every returned address must be
   routable — one private address among several refuses the target (no round-robin
   rebinding games). Empty or failing resolution → `dns_failed`.
3. **Pinned connect**: the undici `Agent`'s `connect.lookup` only ever returns the address
   that was just checked for that hostname (fail closed for anything unassessed), so the
   socket cannot go elsewhere between check and connect while `Host` and TLS SNI still carry
   the hostname.
4. **Redirects** are followed manually (`redirect: "manual"`): up to 5, each `Location`
   (absolute or relative) re-runs steps 1–3; `Authorization`, `Cookie` and
   `Proxy-Authorization` are dropped on a cross-origin hop; 303 (and 301/302 for POST)
   become GET without a body, 307/308 replay the buffered body.
5. **Limits**: one deadline for the whole request (5 s default; combined with the caller's
   `signal`), 1 MiB response cap enforced up front from `Content-Length` and, for chunked
   bodies, by a counting stream that errors the body with `response_too_large`.

Blocked ranges: v4 `0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`,
`192.0.0/24`, `192.0.2/24`, `192.88.99/24` (6to4 relay), `192.168/16`, `198.18/15`,
`198.51.100/24`, `203.0.113/24`, `224/4`, `240/4`, `255.255.255.255`; v6: everything outside
global unicast `2000::/3` (`::`, `::1`, IPv4-compatible `::/96`, SIIT `::ffff:0:0:0/96`,
local-use NAT64 `64:ff9b:1::/48`, `100::/64`, `5f00::/16`, `fc00::/7`, `fec0::/10`,
`fe80::/10`, `ff00::/8`, reserved space) plus `2001::/23` (Teredo, benchmarking, ORCHID),
`2001:db8::/32` and `3fff::/20`. IPv4-mapped (`::ffff:a.b.c.d`), NAT64 (`64:ff9b::/96`) and
6to4 (`2002:AABB:CCDD::/48`) are re-checked as the embedded v4 address. The lists were
reviewed against the IANA v4/v6 special-purpose registries (2026-09). Zone ids and
non-canonical spellings are blocked.

Errors are `OutboundHttpError` from `@fundroom/ports` with `code` ∈ `blocked_scheme`,
`blocked_host`, `blocked_port`, `blocked_address`, `dns_failed`, `too_many_redirects`,
`response_too_large`, `timeout` and `url` reduced to origin + path (no query string).

Exemptions: `allowedPrivateHosts` (exact hostname or IP literal; skips host, port and
address checks for that target — internal webhook receivers, an IdP on the LAN) and
`allowPrivate: true` (skips them for everything; dev only — the config layer refuses it in
staging/prod unless hosts are listed). The scheme and userinfo rules always apply.

Not here: proxy support, per-tenant egress allow-lists (a module concern on top of
`assess()`), response caching.
