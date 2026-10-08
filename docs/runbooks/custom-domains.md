# Runbook: add, repair or move a custom domain

A custom domain is a hostname the customer owns — `investors.acme.com` — serving one workspace's portal instead of `<slug>.<your domain>`. This runbook is for whoever operates the install. It covers adding a domain, reading its state, the two DNS records and why both exist, apex domains, certificates that will not issue, moving a domain between workspaces, and running custom domains through [Cloudflare for SaaS](#cloudflare-for-saas) instead of the shipped edge, including in front of a platform that routes by `Host`, such as Railway.

Reference material: `packages/custom-domains` (what a hostname reduces to and when it counts as verified), the provider adapters under `packages/adapters/domain-*`, and the edge configuration in `deploy/caddy/Caddyfile`.

## What has to be true first

- **The domain is added and verified in the app — in either tenancy mode.** What differs between the modes is only *why*.
  - **`TENANCY_MODE=multi`**: the verified row is what maps the hostname to a workspace. Routing depends on it as much as certificate issuance does; an unverified hostname 404s.
  - **`TENANCY_MODE=single`**: routing already accepts the hostname. The classifier calls every `Host` it does not recognise the canonical one, because a single-tenant install has exactly one workspace and the operator owns the edge — so requests on the new hostname reach the portal with or without a row. You still add and verify the domain, because **`ask` answers 404 for an unverified hostname in both modes** and the edge will not obtain a certificate without a 200. Skip this and the hostname resolves, reaches Caddy, and never completes a TLS handshake.
- **The edge terminates TLS for hostnames it has never seen before.** The bundled `caddy` service does, using on-demand TLS: for any hostname that is not `FUNDROOM_DOMAIN` it asks the app whether to issue a certificate and aborts the handshake if the answer is not 200. If you terminate TLS somewhere else — an nginx you manage, a CDN, a corporate load balancer — set `CUSTOM_DOMAIN_DRIVER=manual`: the app then verifies DNS and shows the records, and issuing the certificate is your job.
- **`CUSTOM_DOMAIN_CNAME_TARGET`**, if the hostname customers should point at is not the install's own. It defaults to the `BASE_URL` host, which is correct for a single install. A fleet of edge nodes names the edge here instead.
- **Port 80 and port 443 reachable from the public internet**, both over IPv4 and — if the customer's zone has AAAA records anywhere on the path — IPv6. ACME validation comes from the CA, not from you, and it arrives on one of those two ports.
- The person doing this needs `domains.manage` in the workspace, and a **fresh** session: adding, verifying and removing a domain are step-up actions, so the admin will be asked to re-authenticate even if they are already signed in.

## Add a domain

1. In the workspace, go to **Settings → Domains** and add the hostname. Only hostnames are accepted: no IP literals, no wildcards, no port, no path, and not the install's own canonical host or a subdomain of it (those already route, and accepting one would be a tenant-resolution bypass). Internationalised names are converted to punycode; what the records screen shows is the `xn--…` form, which is what the customer must type into their DNS editor.
2. The screen now shows **two records**. Send the customer both. Nothing happens until both exist.
3. Press **Verify now** once the customer says the records are live, or wait: a job re-checks every pending domain every five minutes with backoff, for up to **72 hours**.
4. When both records resolve the domain moves to `dns_ok`, and from that moment the edge is allowed to obtain a certificate. The certificate itself is obtained on the **first HTTPS request** to the hostname — so open `https://investors.acme.com` in a browser. The first load is slow (a second or two while ACME runs); reload and it is instant, and the domain flips to `active`.

### The two records, and why both

| Type | Name | Value | What it does |
|---|---|---|---|
| `CNAME` | `investors.acme.com` | the CNAME target (`CUSTOM_DOMAIN_CNAME_TARGET`, else the canonical host) | Routes the traffic. Without it nothing arrives. |
| `TXT` | `_fundroom-challenge.investors.acme.com` | the workspace's challenge token | Proves the customer controls the name. |

The CNAME alone is not proof of control, and not only in theory: a customer who fronts their DNS with a proxy (Cloudflare's orange cloud, for one) publishes a record we cannot see — the proxy answers with **its** addresses, and our resolver never observes our own target on the other end. Authorising a domain on the strength of a CNAME we can only partly see would mean authorising it on the strength of whatever the proxy chose to say. The TXT record is a value only this workspace could have been told, at a name only the zone's owner can create, and it resolves identically through every proxy.

Domains verified before the rename carry their TXT record at `_seedhost-challenge.<hostname>`. That label is still accepted, and will stay accepted, so nobody has to republish: the verifier looks up `_fundroom-challenge` first and the old label only when the new one does not carry the token, and the explanation on the row says which label matched. Instructions and the records list show only `_fundroom-challenge`. The cost is one more TXT lookup per check for a domain whose new label does not carry the token (one still on the old record, or one with no record yet); with DoH degraded, such a check waits for two timeouts in a row. Republishing under `_fundroom-challenge` removes it.

The TXT record is also what makes a domain *move* safely. It is derived from the workspace and the hostname together, so the token differs per workspace; a domain cannot be carried into another workspace without the zone's owner publishing a new value.

Both records are **derived, not stored**: the screen recomputes them every time it renders. If you change `CUSTOM_DOMAIN_CNAME_TARGET`, every pending domain's instructions change with it — no stale copy to clean up, and no way for the instructions to disagree with what the verifier actually checks.

### Verification uses DNS-over-HTTPS, and two resolvers must agree

Checks go to two DoH resolvers (`DOH_ENDPOINTS`; Cloudflare then Google by default, addressed by IP so the host's own resolver and its cache are not involved). A **positive** verdict needs both to return the same answer. One resolver that is poisoned, or that sees a split-horizon view of the zone, cannot verify a domain on its own. The practical consequence for you: immediately after a DNS change, verification can fail for a few minutes purely because one resolver still has the old answer cached. That is not a misconfiguration. Wait for the TTL.

## Read the state

| State | Means | Leaves when |
|---|---|---|
| `pending` | Added; DNS not confirmed yet. No certificate will be issued. | Both records resolve → `dns_ok`. 72 h with no success → `failed`. |
| `dns_ok` | Records confirmed. The edge **may** issue a certificate; none exists yet. | First HTTPS request completes → `active`. |
| `active` | Serving. This is now the workspace's primary origin. | Weekly re-verification fails repeatedly, or you remove it → `pending`. |
| `failed` | Gave up after 72 h. | Press **Verify now** → `pending`. |

The row carries `lastCheckedAt`, the exact answer the last resolver gave, and a one-sentence explanation. Read that answer before theorising: "no TXT record at `_fundroom-challenge.investors.acme.com`" and "TXT present but does not match" are different problems with different owners.

Two things are deliberately *not* symmetric here:

- The `ask` endpoint answers 200 for `dns_ok` **and** `active`, not only `active`. It has to: `active` means "a certificate exists", and the certificate cannot exist until the edge has been allowed to request one. Gating on `active` would deadlock every new domain.
- A verified domain (`dns_ok` or `active`) can belong to only one workspace at a time; a `pending` row is not exclusive. Two workspaces may both have `investors.acme.com` pending — one of them typed it by mistake, or is mid-migration. Only one can ever verify it.

Lookups are cached in-process for **60 seconds**. Every change you make — adding, removing, demoting a domain — can take up to a minute to be visible at the edge. Do not conclude something is broken before that.

## Apex domains (`acme.com` with no subdomain)

Recommend a subdomain. `investors.acme.com` or `portal.acme.com` costs the customer nothing, keeps their marketing site independent, and avoids all of the following.

If they insist on the apex:

1. **ALIAS / ANAME / CNAME-flattening at their DNS provider** — the answer to recommend. Cloudflare, Route 53, DNSimple, Namecheap, Porkbun and Bunny all offer it under one of those names. The provider publishes A/AAAA records that track our target's addresses, so the apex keeps working when our addresses change. Verification accepts this: a flattened apex answers A/AAAA rather than CNAME, and an address that points at us satisfies the routing half of the check. The TXT record is unaffected — `_fundroom-challenge.acme.com` is an ordinary subdomain and always publishable.
2. **Plain A/AAAA records at our addresses** — only offer this where the addresses are genuinely stable and you are prepared to keep them stable, because the customer's apex breaks the day they change and you will be the one who has to notice. Never hand these out for an install whose IP comes from a VPS you may rebuild.

   How the check knows an address "points at us": when the name holds A/AAAA records instead of a CNAME, the verifier resolves **the CNAME target's own** A/AAAA through the same resolvers and accepts the apex when the two sets intersect. That needs no configuration and stays correct when the edge's address changes. If your edge answers on stable anycast addresses that its own DNS does not describe, name them in `CUSTOM_DOMAIN_EDGE_ADDRESSES` (comma-separated IPs) and they are used instead of resolving the target.
3. Their apex serving a redirect to a subdomain that is CNAMEd to us. Ugly in the address bar for one hop, and completely reliable.

An apex domain also means every service on that name — their website, their mail — shares a zone with the portal. Say so before it becomes a surprise.

## A certificate will not issue

The domain is `dns_ok` (or `active` and the certificate is expiring), and HTTPS fails: a browser warning, a handshake that resets, or a Caddy log line about ACME.

Work through these in order.

**1. Is the hostname reaching your edge at all?** Watch the edge with `docker compose logs -f caddy` while someone loads the hostname. No log line at all means the request never arrived, which is a DNS or firewall problem and not a certificate problem — check the CNAME resolves to your target (`dig +short investors.acme.com`) before reading any further.

**2. Is the app allowing issuance?** Ask it the way the edge does, from inside the Compose network:

```
docker compose exec caddy wget -S --spider "http://app:3000/internal/tls/ask?domain=investors.acme.com"
```

`HTTP/1.1 200 OK` means the app will allow a certificate for that hostname. `404` means it will not, and the domain's state is the reason — re-read it above. **Run this from inside the network.** `/internal/*` is refused at the edge on purpose (a public `ask` is a domain-enumeration oracle and a way to put database load on the handshake path), so the same request from outside returns 404 whatever the domain's state is, and tells you nothing.

**3. CAA records.** A `CAA … issue` record that does not name the CA we use forbids issuance, and the CA checks them, not us — so this failure appears only in the ACME error, never in DNS verification.

```
dig +short CAA investors.acme.com
dig +short CAA acme.com
```

The CA walks up from the hostname through its parents, and because the hostname is a CNAME it also considers the target's zone — so check **your** edge domain too. An empty answer everywhere is fine: no CAA means no restriction. If the customer has CAA records for another CA (a corporate DigiCert policy is the usual cause), they must add one naming ours — `letsencrypt.org`, plus `sectigo.com` if you want the ZeroSSL fallback to remain usable. Ask them to add rather than replace.

**4. Rate limits.** Let's Encrypt's per-registered-domain limit (50 certificates a week) is almost never what you hit with customer domains: each one is its own registered domain. The limits that actually bite are:

- **Failed validations** — a handful per hostname per hour. Every retry against a broken configuration spends one. Stop retrying, fix the cause, then retry once.
- **Duplicate certificates** — a small number per week for the exact same set of names. Reached by scripting issuance in a loop, or by wiping the edge's certificate storage repeatedly. `caddy_data` is a named volume for exactly this reason: do not delete it to "start clean".

A rate limit is a wait, not a fix. The ACME error names the limit and when it resets. If the install is wedged and the domain must work today, `ACME_CA` can point at another ACME server (see `deploy/compose/.env.example`) — but that is a deliberate change with its own trust implications, not a routine remedy.

**5. The challenge itself.** On-demand TLS validates over HTTP-01 (port 80) or TLS-ALPN-01 (port 443). Both must be open to the world; a firewall that allows 443 only will fail HTTP-01 silently. Watch for a stray `AAAA` record on the customer's hostname pointing somewhere that is not us — the CA will happily use it, reach the wrong server, and fail validation while an IPv4 browser sees nothing wrong.

**6. The edge itself.** If Caddy is not running, nothing above applies, so read its log before blaming DNS: `docker compose logs caddy`, and validate the file after any edit with `docker compose exec caddy caddy validate --config /etc/caddy/Caddyfile`. One failure is worth recognising on sight: **`wrong argument count or unexpected line ending after '<directive>'` means an environment placeholder expanded to nothing.** Caddy substitutes an empty string for a `{$VAR}` whose variable is unset *and* for one set to empty, and an argument that becomes empty disappears rather than becoming `""` — so `email {$ACME_EMAIL}` stops the whole edge from starting on any install that never set `ACME_EMAIL`. That shipped with an early reference stack and is fixed by quoting (`email "{$ACME_EMAIL}"`), which is how the file reads now; apply the same rule to any optional placeholder you add yourself.

## Repair a domain that used to work

`active` domains are re-verified weekly. A failure does **not** demote immediately: it takes three consecutive weekly failures, because taking a working portal offline over one bad resolver answer is worse than a late demotion. When a domain does get demoted to `pending`, the workspace's URLs revert to its slug host (in `single` mode, to `BASE_URL`) and mail sent from then on uses that host.

The usual causes, in order of how often they turn out to be the cause:

1. The customer removed or edited the TXT record — often while tidying up "unused" records, sometimes when migrating DNS providers wholesale. Re-send the record and press **Verify now**.
2. The customer moved the hostname behind a proxy and changed the CNAME target to it. The TXT check still passes; routing no longer points at us.
3. The zone was transferred and the records did not come along.

Re-adding is not necessary and not desirable: the existing row keeps its history and its token. Fix DNS, verify, wait up to a minute for the cache.

## Move a domain to another workspace

Both workspaces will need a hand from the customer's DNS administrator — this is not a purely internal operation, by design.

1. In the **new** workspace, add the hostname. It sits at `pending` alongside the old workspace's row; that is expected and allowed.
2. Read the new workspace's TXT value. It is different — the token is derived from the workspace and the hostname together.
3. In the **old** workspace, remove the domain. This is the step that releases the claim: while the old row is `dns_ok` or `active`, nothing else can verify that hostname.
4. Have the customer replace the TXT value with the new one. The CNAME does not change.
5. Verify in the new workspace and make one HTTPS request to mint the certificate.

Between steps 3 and 5 the hostname is dark: it resolves to your edge, and the edge has nothing to serve for it. Schedule accordingly, and tell the people who use the portal.

## Remove a domain

Removing it demotes the workspace to its slug host — in `single` mode, to `BASE_URL` — immediately (within the cache TTL). Two consequences to state out loud before you do it:

- **Everyone signed in on the custom domain is signed out.** Session cookies are `__Host-` cookies, which are scoped to exactly one hostname and cannot be shared with another. This is inherent to changing the hostname a portal lives on, not a bug and not something a setting can avoid: moving a portal between origins means everyone signs in again. The same is true in the other direction, the first time a domain goes `active`. With `CENTRAL_AUTH=on` ([central-auth.md](central-auth.md)) "signing in again" is one **Continue** for anyone signed in on the canonical host.
- **Links already sent by email keep pointing at the old hostname.** The edge will refuse them once the domain is gone. If the change is planned, send the announcement from the new origin *after* the switch, not before.

The certificate stays in the edge's storage until it expires. Nothing serves it once the app stops allowing the hostname, so there is nothing to clean up.

## Cloudflare for SaaS

`CUSTOM_DOMAIN_DRIVER=cloudflare-saas` hands certificates for customer hostnames to [Cloudflare for
SaaS](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/): Cloudflare terminates
TLS for `investors.acme.com` and forwards to your origin. It suits a managed host with many custom domains
that already sits behind Cloudflare. It works in any tenancy mode and does not need the control plane.

### What changes, and what does not

- **Our two records still come first.** The customer publishes the same CNAME and `_fundroom-challenge` TXT,
  and verification works as above. Only when both resolve (`pending → dns_ok`) does the app register the
  hostname with Cloudflare. Cloudflare is never asked to issue a certificate for a name nobody has proved
  they control.
- **`dns_ok` now means "registered with Cloudflare, waiting for Cloudflare".** The app polls Cloudflare, and
  the domain becomes `active` (the workspace's primary origin) only when Cloudflare reports **both** the
  hostname and its certificate `active`. The first request does not promote it, because Cloudflare routes a
  hostname before its certificate is ready.
- **Cloudflare's own records are optional extras.** The domain screen may list Cloudflare's ownership TXT
  (`_cf-custom-hostname.<host>`) and certificate-validation TXT records, marked optional. With the CNAME in
  place Cloudflare validates on its own over HTTP. The TXT records are for a customer who cannot wait, or whose
  zone blocks HTTP validation.
- **Failure.** If Cloudflare reports the hostname `moved`, `deleted` or blocked, or its certificate validation
  timed out, the domain becomes `failed` (the sentence says why) and the Cloudflare hostname is deleted.
  **Verify now** starts again from `pending` (and counts against the plan's `customDomains` limit again).
  Removing, demoting or failing a domain queues a `domains.provider-release` job that deletes the Cloudflare
  hostname, retried for about three days. The job skips a hostname that is verified again anywhere by then, and
  it and a new registration serialise on a per-hostname lock, so a stale release never deletes a hostname that
  was just registered again.
- **By id, not by search.** The app stores Cloudflare's id for each hostname and asks about it by id. If a
  search ever finds nothing (a listing lagging a create), the state is "unknown" and nothing changes; only a
  404 for the stored id counts as gone.
- **CAA.** Below Enterprise, Cloudflare picks the CA for each certificate. A customer whose zone has CAA
  records must allow all three CAs Cloudflare may use: `letsencrypt.org`, `pki.goog` and `ssl.com` (add
  `issue` records; do not replace their own). The Caddy advice in [A certificate will not
  issue](#a-certificate-will-not-issue) names different CAs; it does not apply here.

### Set up Cloudflare (once)

1. **The SaaS zone.** The zone your install's domain lives in (say `example.com`) must be on Cloudflare, with
   Cloudflare for SaaS enabled (**SSL/TLS → Custom Hostnames**). The plan includes 100 custom hostnames, and
   each further one is billed monthly (Free/Pro/Business, as of 2026-09).
2. **Fallback origin.** Create a **proxied** DNS record pointing at your origin (the edge in front of the
   app), e.g. `proxy-fallback.example.com`, and set it as the fallback origin under Custom Hostnames. Wait until
   it shows **Active**; no custom hostname routes before that. Cloudflare connects to it with the *customer's*
   hostname as `Host`, which is exactly what tenant resolution keys on. If your origin refuses hosts it does
   not know (Railway does), follow [An origin that routes by `Host`](#an-origin-that-routes-by-host-railway-and-similar)
   for steps 2 and 3 instead.
3. **The CNAME target.** Create a **proxied** record customers will point at, e.g. `customers.example.com`
   CNAME `proxy-fallback.example.com`, and set `CUSTOM_DOMAIN_CNAME_TARGET=customers.example.com`. The domain
   screen tells customers to CNAME to it, and our verification checks it.
4. **API token.** Create a custom API token with **Zone → SSL and Certificates → Edit**, limited to that one
   zone. Set `CLOUDFLARE_API_TOKEN` (or `_FILE`) and `CLOUDFLARE_ZONE_ID` (the 32-character zone id from the
   zone's overview page).
5. **Origin TLS.** Decide how Cloudflare reaches the origin (the zone's SSL/TLS mode and the origin's
   certificate) following Cloudflare's documentation for SaaS fallback origins, and test it with one hostname
   before onboarding customers.

```
CUSTOM_DOMAIN_DRIVER=cloudflare-saas
CUSTOM_DOMAIN_CNAME_TARGET=customers.example.com
CLOUDFLARE_API_TOKEN=…
CLOUDFLARE_ZONE_ID=023e105f4ecef8ad9ca31a8372d0c353
```

The app calls `https://api.cloudflare.com/client/v4` through its own guarded client: 5 s timeout, 1 MiB
answers, no redirects. `CLOUDFLARE_API_BASE` exists for test fakes only, and production refuses any other
value.

### An origin that routes by `Host` (Railway and similar)

Some platforms will not take the customer's hostname as `Host`. Railway routes by `Host`, refuses a host
that is not one of the service's own domains, overwrites `X-Forwarded-Host` with the host it routed on, and
caps custom domains at 20 per service on Pro. Put a Cloudflare Worker in front instead. The Worker fetches
the platform by the service's own host (`<name>.up.railway.app`) and tells the app the customer's hostname
and the visitor's address in **private headers**, proven by a **shared secret**. The FundRoom
hosted edition runs this way; its Worker and the Cloudflare declarations are in `fundroom-web`
(`infra/edge/`, `pnpm edge plan|apply`).

**What the Worker must do.** Its rules are part of the security boundary: once the secret matches, the app
believes whatever the Worker says.

1. Pass `/.well-known/acme-challenge/*` and `/.well-known/pki-validation/*` through untouched (the routes
   below also keep them away from the Worker). Certificate validation must never be modified.
2. Redirect `http:` to `https:` (308).
3. Remove every inbound `X-Fundroom-*`, `X-Forwarded-Host`, `X-Forwarded-Prefix`, `Forwarded`, `X-Real-IP`,
   `X-Forwarded-For` and `True-Client-IP` header, and the hop-by-hop headers, so a visitor cannot send its
   own.
4. Set `X-Fundroom-Forwarded-Host` to the request's hostname, lower-cased; `X-Fundroom-Client-IP` to the
   incoming `CF-Connecting-IP` (omitted when absent); `X-Fundroom-Edge` to the secret.
5. Fetch `https://<service host><path><query>` with the original method, headers and streamed body,
   `cache: "no-store"`, without following redirects, and return the answer unchanged. The app adds
   `Vary: X-Fundroom-Forwarded-Host`, but Cloudflare's cache does not key on `Vary` by default, so `no-store`
   is what keeps one tenant's response out of another's.
6. Answer 404 for every host in its own zone, except `GET`/`HEAD /healthz` on the CNAME target host (forwarded
   as the canonical host, so an uptime check proves Worker → platform → app with the secret). The zone's own
   names must never serve the app's pages.
7. Fail closed. A missing binding answers 500 and a failed upstream fetch 502, neither echoing the error or
   the secret.

**Cloudflare, instead of steps 2 and 3 above:**

- **Fallback origin:** an originless record, e.g. `fallback.example.com AAAA 100::`, **proxied**, set as the
  fallback origin. Nothing listens there; the Worker answers every request first.
- **CNAME target:** `portals.example.com` CNAME `fallback.example.com`, **proxied**, and
  `CUSTOM_DOMAIN_CNAME_TARGET=portals.example.com`.
- **Worker routes:** `*/*` → the Worker, set to **fail closed** (on the Workers Free plan, an exhausted
  daily quota then answers Cloudflare error 1027 instead of skipping the Worker; production wants Workers
  Paid). Add routes with **no Worker** for `*/.well-known/acme-challenge/*`, `*/.well-known/pki-validation/*`
  and every proxied hostname of the zone that is not for the app, such as the marketing site
  (`example.com/*`, `www.example.com/*`). Anything else proxied in the zone goes through the Worker to the
  app.
- **The install's own hosts** (the canonical host and `<slug>.` hosts) stay **DNS-only** records pointing at
  the platform, which serves them with its own certificate. They reach the app without the Worker, as
  ordinary requests.
- **The Worker's secret binding** `EDGE_SHARED_SECRET` holds the same value as the app's.

**The app:**

```
CUSTOM_DOMAIN_DRIVER=cloudflare-saas
CUSTOM_DOMAIN_CNAME_TARGET=portals.example.com
CLOUDFLARE_API_TOKEN=…
CLOUDFLARE_ZONE_ID=…
TRUST_PROXY=true
CLIENT_IP_HEADER=X-Real-IP                       # the platform's own header, for requests not through the Worker
FORWARDED_HOST_HEADER=X-Fundroom-Forwarded-Host
FORWARDED_CLIENT_IP_HEADER=X-Fundroom-Client-IP
EDGE_SHARED_SECRET=…                             # openssl rand -hex 32; the Worker holds the same value
```

- `FORWARDED_HOST_HEADER` and `EDGE_SHARED_SECRET` are set together or not at all.
  `FORWARDED_CLIENT_IP_HEADER` needs them and must name a different header. Both names must start with
  `X-Fundroom-` (the namespace the Worker strips from every inbound request) and may not be
  `X-Fundroom-Edge`, which carries the secret and is not configurable.
- `CLIENT_IP_HEADER` may never start with `X-Fundroom-`: it is read on every request, so any client could
  set it.
- The secret is 32 to 256 printable ASCII characters without spaces (it travels as a header value). It is
  redacted everywhere and accepts `EDGE_SHARED_SECRET_FILE`.
- Edge forwarding cannot be combined with `PATH_MOUNTS`.
- `fundroom doctor` warns:
  - when `TRUST_PROXY=false`. Edge-forwarded requests are unaffected, but direct traffic (the canonical and
    `<slug>.` hosts) gets its scheme, host and origins from the socket, and an edge request without a client
    IP is recorded with the proxy's address;
  - when `FORWARDED_CLIENT_IP_HEADER` is unset: every custom-domain visitor then shares the Worker's egress
    address in rate limits, IP allowlists and audit rows;
  - while `EDGE_SHARED_SECRET_PREVIOUS` is set.

**What the app does with a request:**

| The request carries | The app |
|---|---|
| no `X-Fundroom-Edge` | treats it as an ordinary request and never reads the forwarded headers. With `TENANCY_MODE=multi`, a request straight to the platform host is a 404 for an unknown host. |
| an `X-Fundroom-Edge` that matches neither secret | answers **403 `edge_unauthorized`** and logs `http.edge_secret_mismatch` (warn). The Worker's secret and the app's differ. |
| a matching secret, but no valid `X-Fundroom-Forwarded-Host` | answers **400 `invalid_request`** ("the edge sent no valid forwarded host") and logs `http.edge_forwarded_host_invalid` with `reason` `missing` or `invalid`. The Worker sends the host under another name than `FORWARDED_HOST_HEADER`, or a value with a port, a trailing dot, an IP or more than one name. |
| a matching secret and a valid host | serves the request as `https://<that host>`: tenant resolution, cookies, CSRF, HSTS and links all see the customer's hostname. The response gets `Vary: X-Fundroom-Forwarded-Host`. |

The 403 and 400 are answered before the access log and HTTP metrics run. Their record is the two log
events, which carry the method, the redacted path, the client's network (truncated to /24 or /48) and the
reason, never a header value, and the counter `fundroom.security.events{event="edge_refused", code, reason}`.
A burst of `mismatch` from many networks is someone guessing; `mismatch` on every customer-domain request is
a Worker and app that disagree.

**Rotating the secret (routine).** Every step keeps every request accepted:

1. On the app, set `EDGE_SHARED_SECRET_PREVIOUS` to the current value and `EDGE_SHARED_SECRET` to a new one
   (`openssl rand -hex 32`). Deploy. The app now accepts both.
2. Update the Worker's `EDGE_SHARED_SECRET` binding to the new value.
3. On the app, unset `EDGE_SHARED_SECRET_PREVIOUS`. Deploy. `fundroom doctor` stops warning.

**After a suspected leak, do not use `EDGE_SHARED_SECRET_PREVIOUS`.** It keeps the leaked value valid for as
long as it is set. Generate a new secret, set it as `EDGE_SHARED_SECRET` on the app (with `_PREVIOUS` unset)
and on the Worker at the same time, and deploy both. Customer domains answer 403 `edge_unauthorized` until
both sides carry the new value; accept that window. The install's own hosts are not affected.

**The visitor's address.** Behind the Worker, the platform's own client header (Railway's `X-Real-IP`)
names the Worker's egress address, not the visitor. The visitor arrives in `X-Fundroom-Client-IP`, which
the app believes only on a request whose secret matched and only when it is an IP literal; otherwise it
falls back to the ordinary derivation below. Leave `CLOUDFLARE_TRUSTED_PROXY` off: the app's peer is the
platform's edge, and the secret already vouches for the address. Keep `CLIENT_IP_HEADER` on the platform's
own header (`X-Real-IP`) for direct traffic; config refuses any `X-Fundroom-*` name there.

**Request size.** Cloudflare's Free and Pro plans refuse request bodies over 100 MB, and Railway closes a
request whose body takes more than 5 minutes to upload. Document uploads are not affected with
`STORAGE_DRIVER=s3`: the browser sends 8 MiB parts straight to the bucket on presigned URLs, never through
the Worker or the app. With `STORAGE_DRIVER=fs`, uploads go through the app in 8 MiB tus chunks.

### Rate limits

Cloudflare allows 1 200 API requests per 5 minutes per user, and blocks every call for five minutes after a
429. The install spends from its own budgets, kept in the database rate limiter so every process shares them.
Each call draws on them innermost first:

| Budget | Size | Applies to |
|---|---|---|
| per workspace | 60 per 5 minutes | every call about that workspace's domains |
| interactive | 600 per 5 minutes | an admin's **Verify now** (and a removal's direct call when no release job can be queued) |
| install | 900 per 5 minutes | every call |

- **Background reserve.** The background sweep and the release job always keep at least 300 calls that admin
  traffic cannot take.
- **Headroom.** A quarter of Cloudflare's limit stays free for your own tooling on the same token; don't give
  the token to anything that needs more.
- **Changes per workspace.** With this driver a workspace may add or remove at most **10 domains per hour**
  (`429 rate_limited` with `retryAfterMs`).
- **Polling.** After registration each check addresses the hostname by Cloudflare's id (one request). A
  `dns_ok` hostname is polled every sweep (5 minutes) for its first hour, every 15 minutes for its first
  day, then hourly. **Verify now** within a minute of the last check answers the stored state.
- **When a budget runs out,** or Cloudflare answers 429, the app stops calling until the window or
  `retry-after` passes (default 5 minutes, at most 15), keeps each row as it is and records the error on it.

### Apex domains

Custom hostnames at a zone apex need Cloudflare's Enterprise apex proxying. On other plans the customer's DNS
host must flatten the apex to `CUSTOM_DOMAIN_CNAME_TARGET` (ALIAS / ANAME / CNAME flattening), which our
verification accepts as described in [Apex domains](#apex-domains-acmecom-with-no-subdomain). Recommend a
subdomain.

### The real client address behind Cloudflare

Behind Cloudflare every request arrives from a Cloudflare address, so rate limits, audit rows and
`PLATFORM_OPERATOR_CIDRS` would all see Cloudflare instead of the visitor. This section is for an origin
Cloudflare connects to directly. Behind a Worker in front of a platform that routes by `Host`, the visitor
arrives in `FORWARDED_CLIENT_IP_HEADER` instead; see [The visitor's
address](#an-origin-that-routes-by-host-railway-and-similar). Otherwise, turn on:

```
TRUST_PROXY=true
TRUST_PROXY_HOPS=1              # proxies between Cloudflare and the app that append to X-Forwarded-For
CLOUDFLARE_TRUSTED_PROXY=on
```

The app first works out who connected, as `TRUST_PROXY` / `TRUST_PROXY_HOPS` always have: the socket peer,
or the right entry of `X-Forwarded-For`. **Only if that address is inside Cloudflare's published ranges** does
it take the client from `CF-Connecting-IP`. A request that reaches the origin without passing through
Cloudflare cannot choose its address by sending the header. With the shipped Caddy edge and
`EDGE_TRUSTED_PROXIES` empty, Caddy puts the Cloudflare edge's address in `X-Forwarded-For`, so
`TRUST_PROXY_HOPS=1` is right.

- Leave `CLIENT_IP_HEADER` **unset**. Set to `CF-Connecting-IP`, it would be believed from any peer, without
  the range check.
- `CLOUDFLARE_TRUSTED_PROXY=on` does nothing without `TRUST_PROXY=true`, and `fundroom doctor` warns about
  that.
- The ranges are vendored in `@fundroom/http` with the date they were fetched. `fundroom doctor` warns once
  they are more than 180 days old. Upgrade, or compare with <https://www.cloudflare.com/ips-v4> and
  <https://www.cloudflare.com/ips-v6>.

## Keys this runbook refers to

| Key | Where | Default |
|---|---|---|
| `TENANCY_MODE` | app | `single`; either mode works — `multi` is what makes the verified row decide *which* workspace the hostname serves |
| `CUSTOM_DOMAIN_DRIVER` | app | `caddy-ask` (`manual` = verify only; `cloudflare-saas` = Cloudflare issues and serves) |
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ZONE_ID` | app | unset; required with `cloudflare-saas` |
| `CLOUDFLARE_API_BASE` | app | `https://api.cloudflare.com/client/v4` (test seam; refused otherwise in production) |
| `CLOUDFLARE_TRUSTED_PROXY` | app | `off`; `on` reads `CF-Connecting-IP` from Cloudflare addresses only (needs `TRUST_PROXY=true`) |
| `FORWARDED_HOST_HEADER` | app | unset; the private header an edge Worker names the customer's hostname in (`X-Fundroom-Forwarded-Host`), believed only with `EDGE_SHARED_SECRET` |
| `FORWARDED_CLIENT_IP_HEADER` | app | unset; the private header the Worker names the visitor's address in (`X-Fundroom-Client-IP`), read under the same secret |
| `EDGE_SHARED_SECRET` / `EDGE_SHARED_SECRET_PREVIOUS` | app (and the Worker's secret binding) | unset; the value the Worker sends in `X-Fundroom-Edge`, and the old one during a rotation |
| `CUSTOM_DOMAIN_CNAME_TARGET` | app | the `BASE_URL` host |
| `CUSTOM_DOMAIN_EDGE_ADDRESSES` | app | unset — the CNAME target's own addresses are resolved instead |
| `DOH_ENDPOINTS` | app | Cloudflare, then Google (at least two **distinct** hosts in production) |
| `ACME_EMAIL` | `caddy` | empty (no ACME contact address) |
| `ACME_CA` / `ACME_CA_ROOT` | `caddy` | empty — Let's Encrypt, then ZeroSSL |

The portal domain is unrelated to the workspace's **sending** domain (Settings → Updates), which signs outgoing mail with DKIM and has its own records, its own verification and its own states. They look alike and are checked by the same resolver; neither one implies the other, and a workspace can have either, both or neither.
