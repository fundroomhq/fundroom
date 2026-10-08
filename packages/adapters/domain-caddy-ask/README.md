# @fundroom/domain-caddy-ask

`CustomDomainProviderPort` for Caddy's on-demand TLS. The default provider for every install, and the reason custom domains need no
per-domain configuration anywhere.

```caddy
on_demand_tls {
  ask http://app:3000/internal/tls/ask
}
```

## `activate` and `deactivate` are no-ops, and that is the design

Caddy asks us about a hostname *during the TLS handshake*; we answer 200 for `dns_ok|active` and
ACME issues the certificate on the spot. The `ask` endpoint **is** the activation mechanism, so
there is nothing for `activate` to register — the row's status is what `ask` reads — and nothing
for `deactivate` to tear down, because a removed row makes the next handshake fail on its own.

The two hooks exist for the providers that are not like this: Cloudflare for SaaS has to POST a
custom hostname, a Traefik HTTP provider has to appear in a served list, cert-manager needs an
`Ingress` and a `Certificate` per host. Those adapters have real work to do here. This one does
not, and pretending otherwise (a warm-up request, a cache poke) would be ceremony that can fail.

`instructions()` delegates to `expectedRecords` in `@fundroom/custom-domains` rather than building
its own rows: the expected records are derived on every read and never stored, so
moving the edge host changes what the admin screen says without a migration or a backfill. Both
rows are required — the CNAME makes traffic arrive, the TXT proves who controls the name, and a
hostname delegated through a proxy can have its CNAME pointed at us by anyone who runs that proxy.
That is declared, not implied: `requires` is `{ cname: true, txt: true }`, and `evaluate` in
`@fundroom/custom-domains` gates on exactly the records this says, so a `required: true` row and a
checked record can never drift apart (they did, for the `manual` driver).

Because the CNAME is gated on, `createCaddyAskProvider` **refuses an empty `cnameTarget`** at
construction. `cnameOk` is false for every possible answer when there is no target, so an empty one
would mean "no domain on this install can ever verify", visible only as a 72-hour timeout on a zone
with nothing wrong with it. The container defaults the target to the canonical host, so the error
only fires when `CUSTOM_DOMAIN_CNAME_TARGET` was deliberately set to something blank — and a
startup error naming the variable is the one honest failure mode for that.

Note what is *not* here: no DNS credentials, no ACME account, no certificate handling. Verification
is `DnsResolverPort` plus the pure state machine in `@fundroom/custom-domains`; issuance is Caddy's.
