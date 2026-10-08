# Runbook: CSP violation reports, Trusted Types and security.txt

Every HTML page the app serves carries a strict Content-Security-Policy that also enforces Trusted Types (`CSP_TRUSTED_TYPES=report` turns the Trusted Types part back into a report-only policy). Browsers that hit a policy post a report to the app's collector, which reduces it to a few fields, counts it and logs a capped sample. This runbook is for whoever operates the install: what the collector keeps and what it throws away, how to tell a real problem from noise, how Trusted Types is enforced and how to roll it back, and how to configure the install's `security.txt`.

Reference material: `packages/http/src/security-headers.ts` (the policies and why each directive is there), `apps/server/src/routes/ops.ts` (the collector and `security.txt`), `apps/web/src/lib/csp.ts` (how the SPA stays inside its own policy) and `e2e/tests/40-csp.test.ts` (the real-browser check that it does).

## The policies

**Enforced** (`Content-Security-Policy`), on every page (`app`, `admin` and `embed` profiles):

- `script-src 'nonce-…' 'strict-dynamic'`: only scripts carrying this response's nonce run, plus what they load. No `eval`.
- `style-src 'self' 'nonce-…'`: stylesheets from the app's own origin, and `<style>` elements carrying the nonce. There is **no `'unsafe-inline'`**, and there must not be one. A third-party component that injects an unnonced `<style>` is fixed at the component (see "The usual suspects" below), never by relaxing the policy.
- `frame-ancestors 'none'`, except on `/embed/<slug>`, where it lists the workspace's embed allow-list.
- `require-trusted-types-for 'script'; trusted-types default ProseMirrorClipboard` (with the default `CSP_TRUSTED_TYPES=enforce`): the browser refuses every place a plain string reaches a DOM sink that can run code (`innerHTML`, `script.src`, `eval`, …) and every Trusted Types policy created under a name not on the list. See "Trusted Types" below.
- `report-uri <BASE_PATH>/csp-report; report-to csp`, with `Reporting-Endpoints: csp="<BASE_PATH>/csp-report"`. On a request that came through a path mount both are absolute on the mount instead — `https://acme.com/investors/csp-report` — so the reports travel back through the host site's proxy, which must forward that path like any other under the prefix.

API (`/api/*`) responses get `default-src 'none'; frame-ancestors 'none'` and nothing else; hashed assets and the embed loader get no Trusted Types directives either — Trusted Types is a document control.

**Report-only** (`Content-Security-Policy-Report-Only`), only with `CSP_TRUSTED_TYPES=report`:

```
require-trusted-types-for 'script'; trusted-types default ProseMirrorClipboard; report-uri …; report-to csp
```

Nothing is blocked by this one; the same two directives are moved out of the enforced policy and only reported. It is the rollback switch (below), and what the security-hardening release shipped as the rollout stage. With enforcement on, no report-only header is sent at all.

## What the collector records

`POST <BASE_PATH>/csp-report` accepts both formats browsers send:

| Content type | Sent by | Shape |
|---|---|---|
| `application/csp-report` | the legacy `report-uri` directive (Firefox, older Chromium) | one `{"csp-report": {…}}` object |
| `application/reports+json` | the Reporting API, via `report-to csp` (current Chromium) | an array of reports; only `type: "csp-violation"` entries are read, at most 20 per body |

Each violation is reduced to these fields and nothing else:

| Field | What it holds | What is removed |
|---|---|---|
| `directive` | the effective directive: `style-src-elem`, `script-src`, `require-trusted-types-for`, `trusted-types`, … | anything that is not a bare directive name becomes `unknown` |
| `blockedURI` | a CSP keyword (`inline`, `eval`, `trusted-types-sink`, `trusted-types-policy`) or the blocked resource's **origin + path** | query string, fragment; a `data:` / `blob:` / extension URL is reduced to its scheme |
| `documentURI` | the page's **path only** | origin, query string, fragment, and every path segment that looks like an identifier (a uuid, a long token, a number, anything with an `@`) — replaced by `:id` |
| `sourceFile` | the script that caused it, origin + path | query string, fragment |
| `disposition` | `enforce` (the browser blocked it) or `report` (report-only: it did not) | |
| `trustedTypes` | Trusted Types reports only: the sink (`Element innerHTML`) or the refused policy name | the rest of the browser's sample, which is the value that was assigned |

The raw report is never stored or logged. That matters because a report is generated from the visitor's own URL: before the security-hardening release the log carried the whole body, so a violation on `/login/verify?email=…` logged the address and one on `/s/<token>` logged a live share-link token.

Then, for every normalised violation:

- **The metric** `fundroom_csp_violations_total{directive, blocked, disposition}` is incremented, where `blocked` is the blocked origin or keyword. This is the aggregate to watch; it is served at `/metrics` with everything else. Anyone can post to the collector, so the labels are bounded: after 200 distinct `(directive, blocked, disposition)` sets in one process, every new set is counted as `directive="other", blocked="other"`.
- **A log line** `csp.report` at `warn`, with the fields above — at most 60 a minute for the **whole process**. The cap is deliberately global and not per client: a per-IP budget would have to key on `X-Forwarded-For`, which the caller writes.

The collector answers `204` to everything, including garbage (nothing here is an oracle), and `413` once a body passes 16 KiB. The limit is enforced as the body streams in, so a chunked request with no `Content-Length` is cut off rather than buffered.

## Reading violations

Start from the metric, not the log: the log is a capped sample.

```
curl -s -H "Authorization: Bearer $METRICS_TOKEN" https://portal.example.com/metrics | grep fundroom_csp_violations_total
```

Then decide which of these it is.

**1. `disposition="enforce"` from the app's own assets** (`sourceFile` under `/assets/`): a regression. Something in the SPA injected a style or ran code the policy does not allow, and a visitor saw a broken or unstyled page. The shipped app produces **zero** of these on every page the e2e suite covers (`e2e/tests/40-csp.test.ts`); file a bug with the directive, the document path and the source file. The fix belongs in the component, not in the policy.

**2. `blocked` is an origin you do not recognise, `sourceFile` is empty or an extension scheme** (`chrome-extension`, `moz-extension`, `safari-web-extension`): the visitor's browser extensions, which inject scripts and styles into every page they visit. This is the bulk of real-world CSP noise and nothing to act on. The policy is doing its job.

**3. `directive="frame-ancestors"`**: someone framed a page that may not be framed. On `/embed/<slug>` this is a host missing from the workspace's embed allow-list — see [embed-troubleshooting.md](embed-troubleshooting.md), and look for `embed.origin_rejected` in the audit log, which names the origin. Anywhere else it is an attempt to frame the portal, which the policy refused.

**4. `directive="require-trusted-types-for"` or `"trusted-types"`**: Trusted Types. With `disposition="enforce"` (the default) the browser refused the assignment; with `disposition="report"` the install runs `CSP_TRUSTED_TYPES=report` and nothing was blocked. Read the next section.

**5. A sudden flood of distinct `blocked` origins, or `other` climbing**: someone is posting forged reports. The endpoint costs a JSON parse and a counter increment; the log is capped and the label set is bounded. Nothing to do unless it shows up as load, in which case rate-limit `POST /csp-report` at the edge.

### The usual suspects (what the security-hardening release fixed, so you recognise a regression)

A first real-browser run before the security-hardening release recorded, on **every** page load: two `style-src-elem` violations from sonner (the toaster) injecting its stylesheet at module load; one from input-otp on every one-time-code screen; a `script-src` `eval` violation (plus a Trusted Types report) from Zod probing `new Function("")` on every page that parsed an API response; one from Radix Dialog's scroll lock (react-style-singleton) each time a dialog opened; one plus a Trusted Types report from Radix Select's viewport each time a select opened; and one plus a Trusted Types report from TipTap's editor styles. None of them showed on screen except as slightly-off styling, which is why earlier epics noted "two violations per page load" without finding the source. How each is now handled is written up at the top of `apps/web/src/lib/csp.ts`; if one of those sources reappears after a dependency upgrade, that file and `apps/web/vite.config.ts` (`sonnerWithoutRuntimeCss`, which fails the build if sonner renames its injector) are where to look.

## Trusted Types

**Where it stands.** Enforced, in the enforced CSP of every `app`, `admin` and `embed` document, whether or not a report collector is configured. The SPA produces **no** Trusted Types violations on the pages the e2e suite covers, including the rich-text editor and a copy-and-paste inside it (`e2e/tests/40-csp.test.ts` asserts the header and zero violations in real Chromium). Two policies are allowed, and the `trusted-types` directive lists exactly them:

- `default` — the SPA's own, created before anything renders (`apps/web/src/lib/csp.ts`). The browser calls it whenever a plain string reaches an HTML sink. It lets through a short list of exact third-party literals (today: the CSS Radix Select's viewport renders through `dangerouslySetInnerHTML`) and returns `null` for everything else, which the browser refuses (a `TypeError` at the sink) and reports. It throws if called explicitly, so it cannot be borrowed as a "make this string trusted" function.
- `ProseMirrorClipboard` — prosemirror-view's own, used to parse pasted HTML in a detached document.

First-party code uses no HTML sink at all: no `innerHTML`, no `dangerouslySetInnerHTML`, no `eval`. Markdown is rendered as React elements (`apps/web/src/lib/markdown.tsx`).

**What a report means.** `directive="require-trusted-types-for"` with `trustedTypes="Element innerHTML"` (or another sink) is a string that reached a sink without a policy; `directive="trusted-types"` with `blockedURI="trusted-types-policy"` is a policy created under a name not on the list, and `trustedTypes` is that name. Extensions produce both, and under enforcement an extension's own injection is simply refused on our pages — noise, not a fault. From the app's own assets (`sourceFile` under `/assets/`) it is a **regression that broke something for the visitor**: the assignment was refused, so whatever the component was rendering is missing or the action threw. Fix it at the source.

**Rolling back** (a regression in production you cannot fix at once, typically after a dependency upgrade): set `CSP_TRUSTED_TYPES=report` and restart. The two directives move to a `Content-Security-Policy-Report-Only` header, so nothing is refused while reports keep arriving with `disposition="report"`; every other directive stays enforced. Report mode needs the collector (the shipped server always mounts it). Fix the source, confirm the violation is gone with the e2e spec, and go back to the default `enforce`. Do not leave an install on `report`: that re-opens DOM XSS sinks that enforcement closes.

**Keeping it at zero.**

1. Every dependency upgrade is a potential breakage that only a real browser sees; `e2e/tests/40-csp.test.ts` (Chromium) is the gate, and a Trusted Types violation there now fails as an *enforced* one.
2. Watch `fundroom_csp_violations_total{directive=~"require-trusted-types-for|trusted-types", disposition="enforce"}` filtered to first-party `sourceFile`s.
3. Firefox and Safari ignore the directives until they ship Trusted Types; the nonce CSP is what protects their users.

A new entry in the default policy's list, or a new policy name, is a security decision and belongs in code review, not in configuration: the list is a constant in `apps/web/src/lib/csp.ts` and the policy names are a constant in `security-headers.ts`.

## security.txt

The server answers `GET <BASE_PATH>/.well-known/security.txt` ([RFC 9116](https://www.rfc-editor.org/rfc/rfc9116)), and `GET <BASE_PATH>/security.txt` with a `301` to it:

```
Contact: mailto:security@fundroom.com
Contact: https://github.com/fundroomhq/fundroom/security/advisories/new
Expires: 2027-03-22T12:00:00Z
Policy: https://github.com/fundroomhq/fundroom/blob/main/SECURITY.md
Preferred-Languages: en
Canonical: https://portal.example.com/.well-known/security.txt
```

`text/plain; charset=utf-8`, `Cache-Control: public, max-age=86400`. `Expires` is always 180 days from the moment of the request, so the file never goes stale on an install nobody touches.

| Variable | Default | Effect |
|---|---|---|
| `SECURITY_TXT` | `true` | `false` answers 404 on both paths |
| `SECURITY_TXT_CONTACT` | the FundRoom project's addresses (above) | comma-separated `mailto:` / `https:` URIs, one `Contact:` line each |
| `SECURITY_TXT_POLICY` | the project's `SECURITY.md` | an `https:` URL |

**Set `SECURITY_TXT_CONTACT` on any install you operate.** The defaults point at the FundRoom project, which is right for a vulnerability in the software and wrong for a problem with *your* deployment — a misconfigured bucket, an exposed admin, a leaked export. A researcher who finds one should reach you. `SECURITY_TXT_POLICY` should then point at your own disclosure policy.

**The `BASE_PATH` caveat.** In path-mount mode (`BASE_PATH=/investors`) the file is served at `/investors/.well-known/security.txt`, and `Canonical` says so. RFC 9116 clients only look at the **root** of the origin, `https://example.org/.well-known/security.txt`, which the app never sees. If the origin is yours, serve the file there from whatever owns the root — a reverse-proxy rule to the prefixed path, or a static file with the same content (and your own `Expires`, which then does not roll by itself). If the origin belongs to someone else, their `security.txt` is the one that counts, and yours is only reachable by people who already know the prefix. Through a path mount (`PATH_MOUNTS`) the file is also reachable at `<mount>/.well-known/security.txt`; its `Canonical` is still built from `BASE_URL`, never from the mount the request came through.

A custom domain or a tenant subdomain serves the same file with the same `Canonical` — the install's `BASE_URL` — because the operator, not the workspace, is who receives security reports.

Check it:

```
curl -si https://portal.example.com/.well-known/security.txt
```
