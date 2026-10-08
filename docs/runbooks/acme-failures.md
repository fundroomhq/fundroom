# Runbook: certificate issuance failures (ACME)

The reference Compose stack terminates TLS in the bundled `caddy` service, which obtains every certificate itself over ACME: Let's Encrypt first, ZeroSSL as the fallback. This runbook is for whoever operates that stack. It covers the install's **own** hostname (`FUNDROOM_DOMAIN`), the `<slug>.<your domain>` hostnames of a multi-tenant install, and the parts of a failure that are the same for every hostname — reading Caddy's error, CAA, rate limits, the fallback CA, `ACME_CA`. A **customer's custom domain** that will not get a certificate has its own runbook, because most of those failures are the domain's state in the app rather than ACME: start at [custom-domains.md](custom-domains.md#a-certificate-will-not-issue) and come back here for the ACME half.

Reference material: the edge configuration itself is `deploy/caddy/Caddyfile`, and its comments are part of this runbook.

## What has to be true first

- **Caddy fronts the app.** If TLS terminates somewhere else — an ingress with cert-manager, a PaaS router, a load balancer you manage — none of this applies: that edge issues certificates, and the app should run with `CUSTOM_DOMAIN_DRIVER=manual`.
- **`FUNDROOM_DOMAIN` is the host in `BASE_URL`.** Caddy obtains a certificate for `FUNDROOM_DOMAIN` at startup; the app treats the `BASE_URL` host as canonical. Compose derives `BASE_URL` from `FUNDROOM_DOMAIN` unless you set it yourself, and if you did, they must still name the same host.
- **The hostname resolves to this machine** over IPv4, and over IPv6 too if it has an AAAA record anywhere.
- **Ports 80 and 443 reach Caddy from the public internet.** The CA validates from outside, over HTTP-01 (port 80) or TLS-ALPN-01 (port 443). Nothing you run from the host itself proves those ports are open to the world.
- **`ACME_EMAIL` is set** in `deploy/compose/.env`. It is optional, but it is the contact on the ACME account, and ZeroSSL's account setup wants an address — treat the fallback as unavailable without one.
- **The `caddy_data` volume is the same volume it was yesterday.** It holds the ACME account and every certificate. Deleting it "to start clean" is how installs walk into duplicate-certificate rate limits (see question 5).

## Which hostname is failing

| Hostname | Who decides whether to issue | Where to go |
|---|---|---|
| `FUNDROOM_DOMAIN` (the canonical host) | Caddy, at startup, with no question asked of the app | Questions 1–7 below |
| `<slug>.<FUNDROOM_DOMAIN>` in `TENANCY_MODE=multi` | Nobody: **the shipped edge cannot issue these** | "Slug subdomains in multi-tenant mode" below |
| A customer's custom domain | The app, through the on-demand `ask` endpoint | [custom-domains.md](custom-domains.md#a-certificate-will-not-issue), then questions 4–7 here |

## Diagnose

**1. Is Caddy running, and did it accept its configuration?**

```
docker compose ps caddy
docker compose logs --tail=200 caddy
docker compose exec caddy caddy validate --config /etc/caddy/Caddyfile
```

A container that restarts in a loop with `wrong argument count or unexpected line ending after '<directive>'` has an environment placeholder that expanded to nothing — unset and empty variables both do that in a Caddyfile, and the shipped file quotes its optional ones (`email "{$ACME_EMAIL}"`) for exactly that reason. [custom-domains.md](custom-domains.md) question 6 has the long version. If you edited the Caddyfile, apply the same rule to every optional placeholder you added.

**2. What did the CA actually say?** Caddy logs the ACME problem document, and its `type` names the cause. Read it before theorising:

```
docker compose logs caddy 2>&1 | grep -iE "obtain|acme|challenge|rateLimited|caa" | tail -n 40
```

| Problem type (suffix of `urn:ietf:params:acme:error:`) | Means | Question |
|---|---|---|
| `dns` | The CA could not resolve the name, or got NXDOMAIN | 3 |
| `connection` / `unauthorized` / `incorrectResponse` | The CA reached *something*, and it was not this Caddy answering the challenge | 3, 6 |
| `caa` | A CAA record forbids this CA | 4 |
| `rateLimited` | A rate limit, which the message names along with when it resets | 5 |
| `tls` | The TLS-ALPN-01 handshake failed; usually something in front of Caddy terminating TLS | 6 |

A line saying one issuer failed and the next is being tried is the ZeroSSL fallback working as designed, not a second problem.

**3. Does the name resolve to this machine, from outside?**

```
dig +short A investors.example.com @1.1.1.1
dig +short AAAA investors.example.com @1.1.1.1
curl -4 -sI http://investors.example.com/ | head -n 1
```

Use a public resolver, not the host's own: split-horizon DNS that answers correctly inside your network is a classic way to pass every local check and fail validation. **A stray AAAA record is the most common cause that looks like nothing:** the CA prefers IPv6, reaches whatever that address is, and fails, while every IPv4 browser works. Delete the AAAA record or make it point here.

**4. Is a CAA record in the way?**

```
dig +short CAA investors.example.com
dig +short CAA example.com
```

The CA walks up from the hostname to the zone apex and uses the first CAA set it finds. Empty all the way up means no restriction. Otherwise the set must allow `letsencrypt.org` — and `sectigo.com` as well if the ZeroSSL fallback is to stay usable, because ZeroSSL issues under Sectigo. Add those values next to whatever is there; do not replace a corporate policy you did not write.

**5. Is it a rate limit?** The error names it. For the canonical host the one that bites is the **duplicate-certificate** limit — a handful of certificates per week for exactly the same name — reached by recreating the `caddy_data` volume repeatedly, or by running several fresh stacks for the same name while testing. The **failed-validation** limit is reached by retrying a broken setup: every restart of Caddy with a broken DNS record spends attempts. Stop, fix the cause, then let one attempt run.

A rate limit is a wait, not a fix. Two things help while you wait:

- **The fallback.** When Let's Encrypt refuses, Caddy tries ZeroSSL on its own. If the log shows ZeroSSL failing too, it is usually the missing `ACME_EMAIL` (see "What has to be true first") or a CAA set that allows only Let's Encrypt.
- **The staging CA, for debugging without spending the real limits.** Set `ACME_CA=https://acme-staging-v02.api.letsencrypt.org/directory` in `deploy/compose/.env` and `docker compose up -d caddy`. Staging certificates are not trusted by browsers; the point is to see validation succeed. **`ACME_CA` replaces only the first issuer — ZeroSSL production stays behind it**, so a staging attempt that fails falls straight through to a real ZeroSSL certificate. Unset `ACME_CA` again the moment staging works, and restart Caddy.

`ACME_CA` can also point at any other ACME server (the e2e suite points it at a local Pebble, with `ACME_CA_ROOT` naming the PEM bundle that server's directory is signed by). Doing that in production is a trust decision for the install, not a remedy for a bad afternoon.

**6. Is something between the internet and Caddy?** A cloud firewall that allows 443 but not 80 fails HTTP-01 silently while TLS-ALPN-01 may still pass — or the reverse. A CDN or proxy that terminates TLS in front of Caddy makes TLS-ALPN-01 impossible and HTTP-01 depend on the proxy passing `/.well-known/acme-challenge/` through untouched. If you put Cloudflare's proxy in front, the answer is usually to let Cloudflare hold the public certificate and give Caddy one it can obtain (or Cloudflare's origin certificate) — which is an edge redesign, not a fix to make at 2 a.m.

**7. Has the certificate simply expired?** Caddy renews about a third of the way before expiry and retries on its own, so an expired certificate means renewals have been failing for weeks — the log has the reason, and questions 2–6 apply. Read the live expiry from outside:

```
echo | openssl s_client -connect investors.example.com:443 -servername investors.example.com 2>/dev/null | openssl x509 -noout -issuer -enddate
```

Nothing in the app watches the canonical host's certificate for you. `GET /api/v1/ops/health` (the admin **Health** page) reports expiry for a workspace's verified **custom domains** only. Point your uptime monitor's certificate check at the canonical host.

## Slug subdomains in multi-tenant mode

In `TENANCY_MODE=multi` the app routes `acme.<FUNDROOM_DOMAIN>` to the `acme` workspace — and the shipped edge cannot put a certificate on it. The Caddyfile has one site block for `FUNDROOM_DOMAIN` and the on-demand block for everything else, and the `ask` endpoint answers 200 only for the canonical host itself and for verified custom domains. A slug subdomain gets 404, so Caddy aborts the handshake. Confirm it from inside the Compose network:

```
docker compose exec caddy wget -S --spider "http://app:3000/internal/tls/ask?domain=acme.investors.example.com"
```

`404 Not Found` is the expected answer for a slug host; that is not a bug in your install.

What works today, in order of effort:

1. **The path form on the canonical host.** Every workspace is also reachable at `https://<FUNDROOM_DOMAIN>/w/<slug>`, on the certificate you already have.
2. **A custom domain per workspace.** Each workspace that wants its own hostname adds one ([custom-domains.md](custom-domains.md)); on-demand TLS covers it.
3. **A wildcard certificate for `*.<FUNDROOM_DOMAIN>`.** A wildcard can only be validated by DNS-01, which needs a Caddy build containing your DNS provider's module (the stock `caddy:2-alpine` image has none), provider credentials in the `caddy` container, and a `*.{$FUNDROOM_DOMAIN}` site block importing `fundroom`. That is a change to your edge, not a setting; keep the `@internal` refusal the shared snippet carries.

## After any change here

Watch one issuance end to end — `docker compose logs -f caddy` while a browser loads the hostname — rather than trusting a restart. Then check the issuer from outside with the `openssl` line in question 7: `Let's Encrypt` or `ZeroSSL` in production, `(STAGING)` means you left `ACME_CA` set.

## Keys this runbook refers to

| Key | Where | Default |
|---|---|---|
| `FUNDROOM_DOMAIN` | `caddy` (and Compose's default `BASE_URL`) | `localhost` |
| `BASE_URL` | app | `https://${FUNDROOM_DOMAIN}` in Compose |
| `ACME_EMAIL` | `caddy` | empty (no contact on the ACME account) |
| `ACME_CA` | `caddy` | empty — Let's Encrypt production, then ZeroSSL |
| `ACME_CA_ROOT` | `caddy` (reaches it as `SSL_CERT_FILE`) | empty |
| `TENANCY_MODE` | app | `single` |
| `CUSTOM_DOMAIN_DRIVER` | app | `caddy-ask` (`manual` when another edge terminates TLS) |
