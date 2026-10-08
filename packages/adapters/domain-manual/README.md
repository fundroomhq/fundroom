# @fundroom/domain-manual

`CustomDomainProviderPort` for the operator who terminates TLS themselves (`manual`:
the self-hoster terminates TLS, FundRoom only verifies). Select with
`CUSTOM_DOMAIN_DRIVER=manual`.

For an install that already runs nginx, Traefik, cert-manager or a CDN in front of the app and
issues certificates there. FundRoom obtains no certificate and asks no CA for one — which is what
`MANUAL_TLS_NOTICE` says out loud next to the records, because the shape of `DnsInstruction` cannot
carry a caveat and a founder reading a DNS table would otherwise reasonably assume HTTPS appears by
itself.

## Ownership is still verified

The TXT challenge stays, and it is the *only* thing checked: `requires` is
`{ cname: false, txt: true }`, so `evaluate` gates on the challenge and ignores the CNAME entirely.
Verification here is not about certificates: it is
what stops workspace A from claiming workspace B's hostname and having the classifier resolve a
request to the wrong tenant (`Host` headers not matching a verified domain
are rejected before tenant resolution). An operator terminating their own TLS has changed who
issues the certificate, not who is allowed to claim a name.

`instructions()` returns only the TXT row unless the operator names an edge host. With this driver
the DNS usually already points at their own proxy, so inventing a CNAME row would tell the founder
to break a working setup; when `cnameTarget` is configured the CNAME appears as *advisory*
(`required: false`), because the operator's edge may be reached by an A record, an internal name or
a load balancer we know nothing about.

`required: false` on that row is now the literal truth rather than a presentation hint: it lines up
with `requires.cname === false`, so the record the screen calls optional is exactly the record the
verdict ignores. `MANUAL_TLS_NOTICE` says so next to the table — where the hostname routes is the
operator's decision, and any CNAME shown is guidance, not a requirement. The two used to disagree:
the row said advisory while `evaluate` failed the domain on it.

`activate` and `deactivate` are no-ops for the same reason as `caddy-ask`, arrived at from the
other end: there is no edge of ours to tell.
