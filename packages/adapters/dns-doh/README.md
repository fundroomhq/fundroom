# @fundroom/dns-doh

`DnsResolverPort` over the JSON DNS-over-HTTPS API.
The default resolver for custom-domain verification and — after E2.1 — for the `updates` module's
sending-domain checks, which used to call `node:dns` directly.

```ts
const resolver = createDohResolver({ fetch: dohHttp.fetch });
const cname = await resolver.resolve("investors.acme.com", "CNAME");
const txt = await resolver.resolve("_fundroom-challenge.investors.acme.com", "TXT");
```

## Why not `node:dns`

Two reasons, and both are about who gets to answer.

**The endpoints are IP literals on purpose.** `https://1.1.1.1/dns-query` and
`https://8.8.8.8/resolve` involve no system resolver at all: nothing in `/etc/resolv.conf`, no
container DNS, no corporate split-horizon view and no `/etc/hosts` entry sits between us and the
customer's zone. A self-hoster whose LAN resolver happens to answer for `investors.acme.com` cannot
make us verify a hostname the workspace does not control — and DoH is used
specifically to dodge local resolver caching, which is the benign half of the same problem.

**A positive answer needs a quorum of two distinct resolvers.** Two of them must agree on the same
value set before `resolve` reports a non-empty answer. One poisoned, hijacked or
merely split-horizon resolver can then only *withhold* a verification, never grant one.

"Distinct" is load-bearing and was not always enforced. The endpoint list is deduped **by host**
before anything is asked, and `reduceAnswers` counts distinct resolver *identities* rather than
answers — because `DOH_ENDPOINTS=https://1.1.1.1/dns-query,https://1.1.1.1/dns-query` used to be
two entries that passed the prod config rule and then satisfied a quorum of two out of a single
cache, with nothing on screen to say the guarantee was gone. Deduped, that list is honestly a
single-resolver install: the quorum clamps to one, `dns.doh.quorum_clamped` is logged, and
`crossFieldRules` refuses it in prod (where it now counts distinct hosts too).

The residual is stated rather than solved: two *different* hosts can still be one operator and one
cache — `1.1.1.1` and `1.0.0.1` are both Cloudflare — and no string comparison knows that. It is
a deliberate decision.

The asymmetry is deliberate: a positive answer is a licence to issue a certificate for someone
else's hostname, while a negative answer costs a retry in five minutes. So a single negative is
reported immediately, and any disagreement collapses to the weaker answer — a real NXDOMAIN/NODATA
if one was seen, otherwise a synthetic `rcode: "other"` with no values, which `evaluate` renders as
"the resolvers disagreed or could not be reached". There is no path in `reduceAnswers` from "the
resolvers differ" to "verified".

An operator who configures a single endpoint and leaves `quorum` at 2 would be unable to verify
anything, which reads as a broken feature rather than a policy, so the quorum is clamped to the
endpoint count and `dns.doh.quorum_clamped` is logged. At one endpoint the guarantee above is gone;
that is the operator's call, made visibly.

## It never throws for a DNS problem

A transport failure, a non-200, unparseable JSON: each becomes an answer, logged
(`dns.doh.unreachable`, `dns.doh.http_error`) and reduced with the rest. The verify job must be
able to record "we could not tell" for one domain without unwinding the whole sweep. `healthCheck`
is the exception in the other direction — it probes every endpoint *bypassing* quorum and throws
only when none answered, because `/readyz` should be red when DoH is unreachable, not when two
healthy resolvers disagree about a round-robin address.

## Wiring

Give it its **own** `createOutboundHttp` instance — `{ timeoutMs: 2_000, maxResponseBytes: 64 * 1024,
maxRedirects: 0 }` — rather than the general-purpose 1 MiB / 5 s one. A resolver has a different
budget: the answers are tiny, they are on the path of a job that sweeps many domains, and a DoH
endpoint has no business redirecting us anywhere. The `fetch` is injected and must be the
SSRF-guarded one; this package never imports `undici` and never touches global `fetch`.

Two cheap checks beyond the quorum, neither reachable without two colluding resolvers and both
there so that it does not have to be the only lock on the door. An answer record is dropped unless
its **owner name** is the query name or somewhere the query's CNAME chain leads (`bailiwick`,
logged as `dns.doh.out_of_bailiwick`) — nothing in the JSON API stops a response carrying a record
for a name nobody asked about. And the real rcode is always reported, so a `Status: 2` response
that happens to carry a record is a SERVFAIL rather than an answer; `evaluate` requires
`rcode === "ok"` before a verdict can be positive.

TXT values arrive as the presentation form — one or more quoted strings, split at 255 octets by the
wire format — and are rejoined with the quoting removed, which is what `DnsAnswer.values` promises.
Every value is lower-cased and stripped of its root label so a caller never compares spellings.
When a query walks CNAMEs, the chain lands in `chain` (outermost first) and only the records of the
requested type land in `values`.
