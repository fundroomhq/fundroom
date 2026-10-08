# Load profiles (k6)

k6 scripts that measure the API against the performance budget: **p95 < 150 ms for reads, < 400 ms for writes, < 300 ms overall at 200 RPS per tenant on 2 vCPU, error rate < 1 %**. The thresholds are in the scripts, so k6 exits non-zero when a run misses the budget.

The full procedure — booting a stack, seeding it, running against staging, reading a result, and the Toxiproxy fault tests that sit beside this — is in [`docs/runbooks/load-testing.md`](../docs/runbooks/load-testing.md). The short version:

```sh
export E2E_APP_PORT=3300 E2E_MAILPIT_PORT=8325
docker compose -p seedhost-load -f deploy/compose/compose.ci.yaml -f load/compose.load.yaml up -d --wait --build
docker compose -p seedhost-load -f deploy/compose/compose.ci.yaml -f load/compose.load.yaml run --rm app seed-demo --investors 50
docker run --rm --network seedhost-load_default -v "$PWD/load/k6:/scripts:ro" grafana/k6 run \
  -e TARGET_URL=http://app:3000 -e PUBLIC_ORIGIN=http://localhost:3300 -e MAILPIT_URL=http://mailpit:8025 \
  /scripts/smoke.js          # prints OWNER_TOTP_SECRET=…; pass it with -e on every later run
docker run --rm --network seedhost-load_default -v "$PWD/load/k6:/scripts:ro" grafana/k6 run \
  -e TARGET_URL=http://app:3000 -e PUBLIC_ORIGIN=http://localhost:3300 -e MAILPIT_URL=http://mailpit:8025 \
  -e OWNER_TOTP_SECRET=<from the smoke run> -e SCENARIO=load -e TARGET_RPS=200 /scripts/investor-browse.js
docker compose -p seedhost-load -f deploy/compose/compose.ci.yaml -f load/compose.load.yaml down -v
docker image prune -f && docker rmi grafana/k6
```

## Layout

| File | |
|---|---|
| `k6/smoke.js` | 1 VU for 30 s through every endpoint below, with checks. CI runs this. |
| `k6/investor-browse.js` | The portal: `/me`, `/modules`, compliance gates, data-room tree, a document, its watermarked page images, the viewer heartbeat (write), the updates archive and one update. |
| `k6/admin.js` | Back office: people list and one person, analytics overview and hot list, audit log. |
| `k6/lib/config.js` | Every `-e` setting and its default. |
| `k6/lib/http.js` | `Host`/`Origin`/`Cookie` handling and the `kind`/`name`/`phase` tags. |
| `k6/lib/session.js` | Email-code sign-in through Mailpit; the owner's TOTP enrolment and step-up. |
| `k6/lib/totp.js` | RFC 6238 codes for that step-up. |
| `k6/lib/seed.js` | Tops up a `seed-demo` workspace with one PDF and one published update. |
| `k6/lib/profile.js` | Thresholds, the `smoke`/`load`/`soak` scenarios, `setup()`. |
| `compose.load.yaml` | Overlay for `deploy/compose/compose.ci.yaml`: `RATE_LIMIT_MULTIPLIER=100`. |

`SCENARIO=load` ramps a `ramping-arrival-rate` to `TARGET_RPS` (default 200) over `RAMP` (1m), holds it for `HOLD` (3m) and ramps down; each iteration is one request, so iterations per second are requests per second. `SCENARIO=soak` holds half the rate for `SOAK`.

Four things the scripts do that are easy to get wrong by hand:

- **Sign-in happens once, in `setup()`.** The sign-in limits (5 codes per address, 20 per IP per window) would stop a per-iteration login at once, and the budget is about browsing, not signing in. The stack needs `RATE_LIMIT_MULTIPLIER` to open more than ~4 sessions; the overlay sets 100.
- **The session cookie is set as a header.** It is `__Host-sid; Secure`, which k6's jar will not send over plain http.
- **`Host` and `Origin` come from `PUBLIC_ORIGIN`**, the app's `BASE_URL`, not from the URL k6 dials.
- **The owner steps up to auth level 2.** Owners and admins need a second factor on every staff route, and a seed-demo owner has none, so the first run enrols TOTP over the API and prints the secret (`OWNER_TOTP_SECRET=…`). Enrolment cannot be repeated: pass the secret back with `-e OWNER_TOTP_SECRET=…` on every later run against the same stack.

## Baseline on a laptop (not a target)

Measured 2026-09-23 on an Apple-silicon MacBook (10 cores; Docker Desktop VM with 10 vCPU / 8 GB shared by the app, Postgres, Mailpit and k6), `compose.ci.yaml` + `compose.load.yaml`, `seed-demo --investors 50` (38 active), one 2-page PDF and one published update, k6 on the compose network. Every threshold passed; zero failed requests; no dropped iterations.

| Run | Rate | Requests | p95 reads | p95 writes | p95 all | p99 all | max | Errors |
|---|---|---|---|---|---|---|---|---|
| `smoke.js` (1 VU, 30 s) | ~9 req/s | 308 | 14.4 ms | 4.0 ms | 14.2 ms | 17.8 ms | 338 ms | 0 % |
| `investor-browse.js` load (30 s ramp, 60 s hold, 30 investors) | 200 req/s held | 16 515 | 29.9 ms | 13.2 ms | 28.4 ms | 141 ms | 456 ms | 0 % |
| `admin.js` load (15 s ramp, 45 s hold) | 20 req/s held | 1 208 | 17.0 ms | — | 17.0 ms | 21.3 ms | 39 ms | 0 % |

The investor tail (p99, max) is most likely page images: the first request for each page per viewer renders and watermarks it, later requests are served from the encrypted cache (per-endpoint trends were not split out in this run; a threshold per `name` tag would show it).

These numbers exist so a later run on the same kind of machine has something to be compared with. They are not the budget above, which is stated for a dedicated 2 vCPU host; a laptop running Docker Desktop shares its CPUs between the app, Postgres, Mailpit, k6 itself and everything else open, and its numbers move by tens of percent from one run to the next.
