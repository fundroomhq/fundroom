# Runbook: sanctions screening

With a sanctions driver configured, every tenant company on a managed host is screened against sanctions
lists: once when its workspace is created, and again whenever a list changes. A new workspace is held until
its first screen clears, and every potential match waits for an operator's decision. This runbook is for the
operators who make those decisions and for whoever runs the install: choosing a driver, what the OFAC
download needs, the OpenSanctions licence, working the review queue, what a "potential match" is and is not,
re-screening, and failures.

Reference material: `packages/sanctions` (the service, the matcher and the jobs), `packages/adapters/sanctions-ofac`,
`packages/adapters/sanctions-opensanctions` and `apps/server/src/routes/platform-sanctions.ts`.

> Screening is a control, not a legal opinion. What threshold to use, how to decide a match and whether you
> must also screen owners, officers or investors are questions for your compliance counsel. OFAC itself
> recommends no threshold: "Users must make their own match threshold determinations based upon their own
> internal risk assessments."

## What has to be true first

- **The control plane is on** ([control-plane.md](control-plane.md)). `SANCTIONS_DRIVER` other than `none`
  requires it. `CONTROL_PLANE=on` in production with `SANCTIONS_DRIVER=none` is allowed, but `fundroom doctor`
  warns that new workspaces are admitted unscreened.
- **The company's legal name and country.** The subject is the tenant *company*: the workspace's legal name
  (else its display name) and country. Signup and the operator's **New workspace** form both ask for them.
  Workspaces that existed before the control plane was turned on have neither, and are screened on their
  display name with no country until an operator fills them in (workspace page → **Company**, or `PATCH
  /api/v1/platform/workspaces/{id}` with `legalName` / `country`; audited `workspace.legal_change`). A change
  re-screens the workspace.
- **A worker running.** Screens, list refreshes and re-screens are jobs (`sanctions.screen`,
  `sanctions.refresh`, `sanctions.rescreen`); see [queue-backlog.md](queue-backlog.md).

## Drivers

| `SANCTIONS_DRIVER` | Lists | Where matching happens | Licence |
|---|---|---|---|
| `none` (default) | — | — | — |
| `ofac` | US OFAC SDN list + the consolidated (non-SDN) lists | on this install; nothing about the tenant leaves it | US government data, public domain |
| `opensanctions` | OpenSanctions `sanctions` collection (many regimes) | a yente server you run, or the hosted OpenSanctions API | **CC BY-NC 4.0: a commercial data licence is required** |

UK and EU lists are not included in v1.

### `ofac`: what the download needs

The adapter downloads four exports from the OFAC Sanctions List Service —
`SDN.CSV`, `ALT.CSV`, `CONS_PRIM.CSV` and `CONS_ALT.CSV` — from `SANCTIONS_OFAC_URL` (default
`https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/`). The service has two quirks the
adapter handles and your network must allow:

- **It answers 403 without a `User-Agent`.** The adapter always sends one
  (`fundroom-sanctions-screening/1 …`); a proxy that strips it breaks the download.
- **Every file is a 302 to a pre-signed Amazon S3 URL** (`*.amazonaws.com`, in `us-gov-west-1` today, valid for
  an hour). The client follows exactly one redirect, over https, to an `*.amazonaws.com` host; the outbound
  client checks every redirect target before following it.

So egress needs HTTPS (443) to `sanctionslistservice.ofac.treas.gov` and to `*.amazonaws.com`. On Kubernetes
with `networkPolicy.egress` set, allow both; behind an egress proxy, allow both hostnames.

The snapshot is cached under `DATA_DIR/sanctions/ofac/` (`current.json` names the one in force), so a
restart does not re-download. A process that cannot write there keeps working from memory. Its version is
`ofac:<first 12 hex of the SHA-256>:<matcher version>`. A new matcher version (the rules changed) makes
every workspace due for a re-screen.

**It fails closed.** A failed, oversized, truncated (fewer than 1 000 SDN rows) or internally inconsistent
download is refused and the previous snapshot stays in force. A snapshot older than **48 hours** is not used
for screening at all: screens then fail (see [Errors](#errors)) until a download succeeds.

Before going live, check that all four files are there:

```
for f in SDN.CSV ALT.CSV CONS_PRIM.CSV CONS_ALT.CSV; do
  curl -sS -o /dev/null -w "$f %{http_code}\n" -L -A "check/1" \
    "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/$f"
done
```

All four must be `200`. `CONS_ALT.CSV` was not probed when the adapter was written. If it is missing, the
driver cannot load a list, and every screen errors.

### `opensanctions`: yente or the hosted API, and the licence

```
SANCTIONS_DRIVER=opensanctions
SANCTIONS_OPENSANCTIONS_URL=http://yente.internal:8000     # or https://api.opensanctions.org
SANCTIONS_OPENSANCTIONS_API_KEY=…                          # sent as Authorization: ApiKey …, only to api.opensanctions.org
SANCTIONS_OPENSANCTIONS_API_KEY_HOSTS=yente-proxy.internal # … or to hosts listed here (an authenticating proxy)
```

Each screen is one `POST /match/sanctions` for a `Company` with its name and country (15 s timeout, no
redirects). The list version is the dataset's catalogue version. The key is only ever sent over https: a
non-https URL is refused at startup whenever a key is set or the host is `api.opensanctions.org`, and so is a
key with a URL host that is neither the hosted API nor listed in `SANCTIONS_OPENSANCTIONS_API_KEY_HOSTS`.

- **yente** is the open-source matching server behind the hosted API. It has **no authentication or access
  control**: run it on a private network. The configured yente host is exempt from the private-address check,
  and nothing else is.
- **The hosted API** sees each screened company's name and country, so it is a sub-processor (OpenSanctions,
  Germany). List it in your DPA.
- **The licence.** OpenSanctions data is licensed Creative Commons Attribution-NonCommercial 4.0. Screening your
  own customers is a commercial use, whether you use yente with their data or their API, and OpenSanctions
  offers no exemption for commercial users. Buy a data licence before you turn this driver on. `fundroom doctor`
  repeats this warning for as long as the driver is set.

## What a screen does

| Outcome | New workspace (held, `pending_review`) | Live workspace (`active` or suspended) |
|---|---|---|
| `clear` | released → `active` | nothing |
| `potential_match` | **stays held**; appears in the review queue | nothing; appears in the review queue |
| `error` | **stays held**; the job retries | nothing; the job retries |

**Names the matcher cannot read.** The matcher transliterates Cyrillic and Greek, and reads words that mix
Latin with look-alike Cyrillic or Greek letters by appearance. With `ofac`, a name that has any word in
another script (Arabic, Hebrew, CJK, …) or nothing screenable at all is recorded as an `error` screening
(`list_version` `ofac:unscreenable:<matcher version>`). A new workspace stays held for an operator, who
screens the company another way (or corrects the legal name to its registered Latin form). It is not
retried until the name or the matcher changes. With `opensanctions`, only a name with no letters or digits
is refused; other scripts go to the service.

A new workspace is held from the moment it is created, in the same transaction, so it is never active before
its first screen. On a clean list that is usually seconds. Until then its owner is told "We are running a
standard check on new workspaces" (the screen is never named to the customer) and can still add a second
factor and open billing (where the install has billing), with **Check again** in the setup wizard; its investors see a "portal unavailable"
page.

A **re-screen never takes a live portal down by itself.** A fuzzy name match is a question, not a finding, and
an OFAC or yente outage must not suspend every customer at once. Only an operator's `confirmed` suspends a
live workspace.

Tenants never see screening data: not the matches, not the list, not that a screen happened. Their audit log
shows only the hold, the release and a suspension.

## Work the review queue

`/platform` → **Sanctions** lists open screenings, newest first: potential matches and errors with no decision
that a later screen has not superseded. (An error is superseded by any later screen of the workspace; a
potential match only by a later clear or match, never by a later error.)

For each one:

1. **Read the matches.** Each shows the list entry's name as listed (primary or alias), its score (0–1), its
   programmes and its source list (SDN or consolidated for `ofac`; the datasets for `opensanctions`). Open the
   workspace (slug, legal name, country, owners' emails) beside it.
2. **Decide whether it is the same party.** The score says how alike the *names* are, not how risky the
   company is. Look at what the name hides:
   - A different country, legal form or line of business, with a common word in the name ("Global Trading"),
     points to a false positive.
   - The same distinctive name, a matching alias, an address or country on the listed entry, or a programme
     that fits the business points the other way.
   - Country never clears a match on its own.
   - If you cannot tell, ask the customer for registration documents before deciding. The workspace can stay
     held while you wait.
3. **Record the decision** with a note (required, up to 2 000 characters) that says *why*. It is the record
   you will be asked for.
   - **Cleared**: not the listed party. A held workspace (`sanctions_review`) is released. Nothing else
     changes: an operator, billing or sanctions suspension stays until its own owner lifts it.
   - **Confirmed**: the listed party, or you will not serve them. The workspace gets the `sanctions` hold
     (suspended, reason `sanctions`, which outranks every other reason), and its provider subscription is
     cancelled. What you owe a regulator (blocking, reporting) is outside this product: follow your compliance
     procedure.
4. **An `error` row** is a screen that could not run. Fix the cause ([Errors](#errors)) and press
   **Re-screen** on the workspace; a clean screen releases a held workspace by itself. You may also decide an
   error row by hand: `cleared` releases it unscreened, so do that only if you screened the company another
   way, and say so in the note.

Only an open screening can be decided (`409 conflict` otherwise). Decisions are audited `sanctions.decision`
on the platform chain, with your note.

A **sanctions suspension is never lifted by a decision or a re-screen**. It is lifted only by an operator
unsuspending that hold on the workspace page (`hold: "sanctions"`), and only when both of these hold:

- a screening **newer than the confirmation** is a clean screen or a potential match decided `cleared` (an
  `error` screening never counts, cleared or not: nothing was compared);
- the operator lifting it is **not the one who confirmed** (four eyes).

Otherwise the answer is `409 sanctions_unresolved` (`not_cleared` / `four_eyes`). Releasing a
`sanctions_review` hold by hand needs the latest screening to be clear or cleared
([control-plane.md](control-plane.md#suspend-and-unsuspend)).

## Re-screening

- **When a list changes.** `sanctions.refresh` runs daily at `0 6 * * *` (UTC). It reads the current list version
  (for `ofac`, re-downloading if the snapshot is over an hour old) and fans out a screen for every live
  workspace not yet screened at that version. A fan-out cut short is finished by the next run.
- **By hand.** **Re-screen** on a workspace's console page queues one screen now.
- **Changing `SANCTIONS_MATCH_THRESHOLD`** (0.5–1, default 0.88) affects future screens only. It is not part of
  the list version, so it does not trigger a re-screen. Re-screen by hand if you need it applied now.

A company an operator cleared is flagged again (into the queue, no hold) after the next list change, if it
still matches. There is no memory of cleared matches in v1: decide it again, pointing to the earlier note.

## Errors

A screen that cannot run (list unavailable or stale, yente or the API down, a timeout) records **one**
`error` row per outage (`list_version = <driver>:unavailable`) and fails its job. pg-boss retries it up to
8 times, starting after a minute and backing off. A held workspace stays held throughout.

| Log line | Means |
|---|---|
| `sanctions.screen_failed` | a screen could not run; the error names the provider failure |
| `sanctions.refreshed` / `sanctions.rescreen_enqueued` | the daily refresh ran, and how many screens it queued |
| `sanctions.ofac_list_loaded` | a new OFAC snapshot is in force (version, entries) |
| `sanctions.ofac_cache_corrupt` | a cached snapshot no longer hashes to its version; it is ignored and re-downloaded |
| `sanctions.ofac_cache_write_failed` | `DATA_DIR/sanctions/` is not writable; the list is kept in memory only |

For `ofac`, the usual causes are egress (a firewall or proxy blocking `*.amazonaws.com`, or stripping
`User-Agent`), and a snapshot past 48 hours because refreshes have been failing. For `opensanctions`: yente
down or reindexing, or a wrong URL or key.

## Records and retention

`core.sanctions_screening` is readable only in host context. It is kept for **5 years** and has no foreign
key to the workspace, so it survives a workspace's deletion and purge as a legal record. It concerns a
company, not a person, so it is outside DSAR exports and erasure. A decision on a purged workspace is still
recorded; there is just no workspace status to change. Screens are audited `sanctions.screen` on the platform
chain.

## Keys this runbook refers to

| Key | Default | Notes |
|---|---|---|
| `SANCTIONS_DRIVER` | `none` | `ofac` or `opensanctions`; requires `CONTROL_PLANE=on` |
| `SANCTIONS_MATCH_THRESHOLD` | `0.88` | 0.5–1; at or above = potential match |
| `SANCTIONS_OFAC_URL` | the OFAC SLS exports directory | test seam; the adapter appends the file names; https required in staging and production |
| `SANCTIONS_OPENSANCTIONS_URL` | unset | required with `opensanctions` |
| `SANCTIONS_OPENSANCTIONS_API_KEY` (or `_FILE`) | unset | sent only to `api.opensanctions.org` or a host in `SANCTIONS_OPENSANCTIONS_API_KEY_HOSTS`; a key with any other URL host is refused at startup |
| `SANCTIONS_OPENSANCTIONS_API_KEY_HOSTS` | unset | comma list of extra hosts the key may go to (an authenticating proxy in front of yente) |
| `DATA_DIR` | `/data` | the OFAC cache lives in `sanctions/` under it |
