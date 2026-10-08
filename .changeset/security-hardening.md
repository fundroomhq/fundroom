---
"@fundroom/server": minor
"@fundroom/config": minor
"@fundroom/contracts": minor
"@fundroom/sdk": minor
"@fundroom/web": minor
"@fundroomhq/ui": patch
"@fundroom/identity": minor
"@fundroom/authz": patch
"@fundroom/db": minor
"@fundroom/audit": patch
"@fundroom/http": minor
"@fundroom/outbound-http": patch
"@fundroom/crypto": patch
"@fundroom/storage-s3": patch
"@fundroom/module-updates": patch
"@fundroom/module-data-room": patch
"@fundroom/module-metrics": patch
---

Security hardening, following an ASVS 5.0 Level 2 review and an internal penetration test.

**Upgrading: production and staging now refuse to boot on settings they used to accept.** Each error names its fix, and `docs/runbooks/install-and-upgrade.md` has an "Upgrading to the security-hardening release" section.
1. `AV_DRIVER=noop` needs `AV_ACCEPT_UNSCANNED=true`, or run ClamAV (`AV_DRIVER=clamd`).
   - Helm: set `config.av.acceptUnscanned`.
   - PaaS services created from an older template: add the variable to web and worker.
2. SMTP to a public relay needs `smtps://…:465` or `?requireTLS=true`.
   - Refused: `tls.rejectUnauthorized` set to anything but `true`, a truthy `ignoreTLS`, a repeated option, and backslashes or spaces in the URL.
3. A public database host needs `sslmode=verify-full` or `verify-ca`.
   - The last `sslmode` in the URL wins, and a `host=` parameter counts as the host.
   - For a private CA, add `sslrootcert=`. Helm: `postgresql.external.caSecret`.
   - `DATABASE_ACCEPT_UNVERIFIED_TLS=true` is only for a host that really is private.
4. `METRICS_ENABLED=true` needs `METRICS_TOKEN`. Without either, `/metrics` is off in prod. Caddy now refuses `/metrics` unless `EDGE_EXPOSE_METRICS=true`.
5. Compose requires `POSTGRES_PASSWORD`. An existing stack whose `.env` never set it was created with `seedhost`: set that, then rotate the password.
6. `RATE_LIMIT_MULTIPLIER` (new, for k6 and ZAP runs) other than 1 is refused in prod, and whenever `APP_ENV` is not set explicitly.
7. Client IP:
   - `TRUST_PROXY=true` now means one trusted hop counted from the right of `X-Forwarded-For`. `TRUST_PROXY_HOPS` sets more hops, and `CLIENT_IP_HEADER` names a platform header. The Fly, Render and Railway templates set one.
   - `X-Forwarded-Host` and `-Proto` take their rightmost entry.
   - Caddy trusts forwarded headers only from `EDGE_TRUSTED_PROXIES`, default loopback. Behind a CDN or load balancer, set it and `TRUST_PROXY_HOPS=2`.
8. HSTS:
   - `includeSubDomains` can be sent without `preload` (`HSTS_INCLUDE_SUBDOMAINS`).
   - `includeSubDomains` and `preload` go only to the `BASE_URL` host and its subdomains, so customers' custom domains get plain `max-age`.

**Authentication and sessions**
- Managing a second factor needs the second factor.
  - Once a user has a TOTP or a passkey, disabling or enrolling TOTP, adding or removing a passkey, regenerating recovery codes, and setting or removing a password all need auth level 2 plus a recent sign-in.
  - A PIN-less passkey step-up in the same session also counts.
  - Every factor change signs out the user's other sessions and emails a security notice. Previously, someone holding a mailbox could replace an owner's second factor.
- Session tokens:
  - The session token rotates on step-up and on login (the previous session is revoked, including share-link and embed logins).
  - Concurrent step-ups keep the winner's token.
- Passwords:
  - Changing or removing an existing password needs `currentPassword`.
  - Signing out other sessions needs a recent sign-in.
- OIDC:
  - Logins are level 1 unless the ID token's `amr`/`acr` shows MFA (`OIDC_MFA_ACR`) or `OIDC_TRUST_MFA=true`.
  - The flow is bound to the starting browser (`__Host-oidc_req`).
  - The ID-token signature is verified.
  - `returnTo` must be same-origin, inside `BASE_PATH`.
- Sign-in answers the same for known and unknown addresses, including while mail is failing.
  - `/auth/otp/start` and `/auth/magic-link/start` no longer answer 503. Failures are logged as `auth.sign_in_mail_failed`.
  - Unknown addresses get a decoy challenge. Challenges are deleted 6 h after expiry.
- TOTP and recovery codes:
  - The rate-limit slot is consumed before the code is checked.
  - A code cannot be used twice concurrently.
  - Recovery codes are stored as salted scrypt hashes; old codes still verify.
- Other:
  - Magic links last 10 minutes.
  - scrypt is `N=2^16, r=8, p=2`, and old hashes are rehashed at login.
  - Logout sends `Clear-Site-Data: "cache", "storage"`.
  - Step-up, recovery-code use and regeneration, and password removal are audited.

**Authorization**
- Grant validity was never enforced: `validity` was mis-parsed, so grants with an end date never expired. They now do, fail-closed.
- Membership `expires_at` is enforced everywhere: request middleware, permissions, `/me`, and the last-owner count. An owner membership cannot carry an expiry. Only an owner can edit another owner.
- Access rows expire at the earliest of these dates:
  - grant end;
  - accreditation age-out;
  - attestation expiry;
  - membership expiry.
- Sharing one data-room document no longer grants its folder. The server derives every rule's path from the resource: grants, policies, invites and share links.
  - A client path that doesn't match gets 400 `resource_path_mismatch`.
  - An unknown or foreign id gets 404 `unknown_resource`.
  - A data-room trigger and one-off repair clear over-broad document rule paths already stored.
- `ip_allowlist`:
  - Malformed entries (`10.0.0.0/`) are ignored fail-closed and rejected by the API.
  - Entries match per address family, so `::/0` no longer admits IPv4.
- Two owners demoting each other concurrently can no longer leave a workspace without an owner.

**Browser**
- Zero CSP violations on the key screens (sonner, input-otp, Radix Select and Dialog, TipTap and Zod no longer inject un-nonced styles or `new Function`).
- Headers:
  - `worker-src 'none'`.
  - CORP is `same-origin` on app, admin and api, `cross-origin` on the embed loader and email chart images, and `same-site` on framed `/embed/*`.
  - Every tenant 404 now carries security headers.
- Trusted Types stays report-only: `trusted-types default ProseMirrorClipboard`.
- `Reporting-Endpoints` is an absolute URL.
- `/csp-report` streams under a 16 KiB limit and accepts `application/reports+json`. Reports are normalised without queries or ids and counted in `fundroom_csp_violations_total`.
- `/.well-known/security.txt` (`SECURITY_TXT`, `SECURITY_TXT_CONTACT`, `SECURITY_TXT_POLICY`) is served, and `/security.txt` redirects to it.
- The SPA works on plain-http origins, where `crypto.randomUUID` is unavailable. Sign-out clears the query cache, and passkey autofill is aborted before an email-code request.

**Operations**
- `fundroom break-glass open|sql|close|list` is host-operator access past RLS (migration 0015, `seedhost_host` role).
  - It needs a ticket, lasts at most 60 minutes and stays pending until owners are mailed.
  - Statements are vetted by Postgres `PREPARE` and run in a security-definer function that cannot switch roles. They are read-only unless `--write`.
  - Each statement is audited in the tenant chain (hash) and the platform chain (text).
  - Owners are mailed on open and after every write.
  - `sql` output is `row_to_json`, and EXPLAIN and SHOW are not accepted.
- `fundroom evidence access-reviews|operators|break-glass`, plus a monthly change-management bundle (`evidence.yml`).
- Faults:
  - A connection reset no longer crashes the process.
  - A black-holed database no longer hangs requests. A client-side query bound follows `statement_timeout`; a timed-out COMMIT raises `ClientTimeoutError` 08007.
  - A failed `begin` no longer leaks a pool slot.
  - S3 has connect and socket timeouts.
- Update sends retry transient mail failures for 24 h without double-sending. Recipients whose membership lapsed are skipped, and one failing mailbox no longer holds the post out of the archive.
- `/metrics` and the access log label by route template, so token-bearing paths never appear. `/readyz` shows details only to loopback callers without `TRUST_PROXY`, or with the metrics token.
- Anonymous `/setup/status` after setup answers only `{ required: false }`. The setup mail probe is limited to the caller's own or staff addresses, needs level 2, and allows 5 per hour.
- Authorization denials and CSRF rejections are logged as `security.*` events and counted in `fundroom_security_events_total`.
- Hardening:
  - AES-GCM tag length is pinned.
  - Download filenames are sanitised (RFC 6266/8187).
  - The outbound guard refuses userinfo URLs and IPv6 forms that embed IPv4 or special ranges.
- OpenAPI `pattern`s no longer carry a leaked `/u` flag.

**Tooling**
- Toxiproxy fault tests run in the integration suite.
- `40-csp` real-browser checks run in the a11y job.
- Stryker on `@fundroom/authz` runs weekly (`break: 95`).
- A ZAP baseline, passive API scans and a weekly active scan run in `zap.yml`, gated by `.zap/rules.tsv`.
- k6 profiles live in `load/` (`load.yml`, on demand).
- `minimumReleaseAge` is 7 days.
- CODEOWNERS paths are corrected.
