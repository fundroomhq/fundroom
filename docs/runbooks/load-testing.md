# Runbook: load and fault testing

Two harnesses answer two different questions. **k6** (`load/k6/`) asks *how fast is it under the traffic we expect* and checks the answer against the performance budget in `load/README.md`. **Toxiproxy** (`apps/server/src/faults.integration.test.ts`) asks *what happens when a dependency misbehaves* — Postgres slow, black-holed, cut or restarted; S3 silent; SMTP down — and checks that every request ends inside a stated bound and that the process heals without a restart. This runbook is for whoever runs either one: a maintainer before a release, an operator sizing a host, CI.

Reference: `load/README.md` (the scripts, the performance budget and a laptop baseline), `load/compose.load.yaml` (the stack overlay).

## The budget

| Measure | Budget | Where it is checked |
|---|---|---|
| API p95, reads | < 150 ms | k6 threshold `http_req_duration{kind:read,phase:run}` |
| API p95, writes | < 400 ms | k6 threshold `http_req_duration{kind:write,phase:run}` |
| API p95, all | < 300 ms at 200 RPS per tenant on 2 vCPU | k6 threshold `http_req_duration{phase:run}` |
| Error rate | < 1 % | k6 threshold `http_req_failed{phase:run}` |

k6 exits non-zero when any threshold fails. The budget is stated for a 2 vCPU host with Postgres beside it; a laptop run is a smoke signal and a trend line, not a verdict (see `load/README.md` for what one laptop measured).

## Running k6 against a local stack

Needs Docker. k6 runs from the `grafana/k6` image, so nothing is installed on the host. Check disk first: the image build adds ~600 MB and some build cache (`df -h /`; run `pnpm docker:clean` below ~15 GiB free).

```sh
# 1. A fresh stack: the CI compose file plus the load overlay (RATE_LIMIT_MULTIPLIER=100).
export E2E_APP_PORT=3300 E2E_MAILPIT_PORT=8325
docker compose -p seedhost-load -f deploy/compose/compose.ci.yaml -f load/compose.load.yaml \
  up -d --wait --build

# 2. Seed it. seed-demo makes a workspace, an owner (founder@example.com) and investors; it
#    refuses when TENANCY_MODE=single already has a workspace, so seed a *fresh* stack and do
#    not run the setup wizard first. Sign-in is by email code only (Mailpit catches it).
docker compose -p seedhost-load -f deploy/compose/compose.ci.yaml -f load/compose.load.yaml \
  run --rm app seed-demo --investors 50

# 3. Smoke (1 VU, 30 s), from inside the stack's network.
docker run --rm --network seedhost-load_default -v "$PWD/load/k6:/scripts:ro" grafana/k6 run \
  -e TARGET_URL=http://app:3000 -e PUBLIC_ORIGIN=http://localhost:3300 \
  -e MAILPIT_URL=http://mailpit:8025 /scripts/smoke.js

#    The first run enrols a TOTP factor for the owner and prints OWNER_TOTP_SECRET=… — keep it.

# 4. Load: ramp to TARGET_RPS, hold, ramp down. Scale the target to the host you are on.
docker run --rm --network seedhost-load_default -v "$PWD/load/k6:/scripts:ro" grafana/k6 run \
  -e TARGET_URL=http://app:3000 -e PUBLIC_ORIGIN=http://localhost:3300 \
  -e MAILPIT_URL=http://mailpit:8025 -e OWNER_TOTP_SECRET=<from step 3> \
  -e SCENARIO=load -e TARGET_RPS=200 -e RAMP=1m -e HOLD=3m /scripts/investor-browse.js

# 5. Tear down: volumes, dangling images, the k6 image.
docker compose -p seedhost-load -f deploy/compose/compose.ci.yaml -f load/compose.load.yaml down -v
docker image prune -f
docker rmi grafana/k6
```

Why each flag is there:

- **`TARGET_URL` vs `PUBLIC_ORIGIN`.** k6 reaches the app at `http://app:3000` on the compose network, but the app was configured with `BASE_URL=http://localhost:3300`: it resolves the workspace from the `Host` header and refuses an unsafe request whose `Origin` is not its own. The scripts send `Host` and `Origin` from `PUBLIC_ORIGIN`. Running k6 on the compose network (rather than `--network host`, which does not reach the host's `localhost` on Docker Desktop for macOS, or `host.docker.internal`, which adds a NAT hop to every request) keeps the measurement about the app.
- **The session cookie is sent by hand.** It is `__Host-sid` with `Secure`, and k6's cookie jar, like a browser, will not send a `Secure` cookie over plain http. `load/k6/lib/http.js` sets the `Cookie` header itself.
- **`RATE_LIMIT_MULTIPLIER=100`.** `setup()` signs the owner and up to `INVESTORS` investors in from one IP; the sign-in limits are 5 codes per address and 20 per IP per window. The multiplier scales every limit ceiling at once (one choke point, `createPostgresRateLimiter`); config refuses anything but 1 in `APP_ENV=prod` and whenever `APP_ENV` is not set explicitly (the overlay sets `APP_ENV=test`). Without it setup fails on the 21st sign-in with HTTP 429.
- **The owner's second factor.** Owners and admins need auth level 2 on every staff route, and a seed-demo owner has none. `setup()` enrols TOTP over the API (`/auth/totp/enrol` + `/confirm`), steps up with `/auth/totp/verify`, and prints the secret. Enrolment is once per owner: later runs against the same stack must pass `-e OWNER_TOTP_SECRET=…`, or setup fails with "TOTP enrolment refused".
- **Content.** seed-demo creates people, not documents or updates. `setup()` uploads one small PDF over tus (as the admin UI does), grants it to the investor role, and publishes one update to the web archive, unless the room already has them (`SEED_CONTENT=false` to skip). Two of those calls are step-up routes, satisfied by the TOTP step-up just made.

## Running k6 against staging

The same scripts, pointed elsewhere. Staging must have been seeded with `seed-demo` (and you need the owner's TOTP secret — pass `OWNER_TOTP_SECRET`) (not a real workspace: the load run writes analytics heartbeats and, on first run, a document and an update) and must allow the sign-ins — either run it with `RATE_LIMIT_MULTIPLIER` (only possible when `APP_ENV` is explicitly set to something other than `prod`) or set `INVESTORS` low enough to stay inside the limits (≤ 4 per window).

```sh
docker run --rm -v "$PWD/load/k6:/scripts:ro" grafana/k6 run \
  -e TARGET_URL=https://staging.example.com -e MAILPIT_URL=https://mail.staging.example.com \
  -e SCENARIO=load -e TARGET_RPS=200 /scripts/investor-browse.js
```

`MAILPIT_URL` must be a Mailpit (or a Mailpit-compatible API) that receives staging's mail; sign-in has no other route in.

## Reading a result

k6 prints one line per threshold with ✓ or ✗, then the trends. What to look at, in order:

1. **`http_req_failed{phase:run}`** — anything above 0 is worth a look before the latencies are. k6 counts every status ≥ 400 as failed. A burst of 429s means a limit you did not multiply (or a staging stack without the multiplier); 503s with `service_unavailable` mean the pool or a dependency ran out (see "Fault tests" below).
2. **p95 by `kind`.** Reads and writes have separate budgets. A read budget missed only on `/data-room/documents/{id}/pages/{n}` is page rendering: the first request for each page per viewer renders and watermarks it, later ones are cached (see `document-rendering.md`).
3. **`dropped_iterations`** in a `load` run means k6 could not start iterations fast enough (VUs exhausted because responses slowed): the app did not keep up with `TARGET_RPS`, and the latency numbers understate how bad it was.
4. **The server side.** `/metrics` (with `METRICS_TOKEN`) has the `http_server_request_duration` histogram per route, which separates time in the app from time on the wire; `docker stats` shows whether the app or Postgres hit the CPU ceiling first.

## Scenarios

| Script | What | Default scenario |
|---|---|---|
| `smoke.js` | Every endpoint of both profiles once per iteration, 1 VU, 30 s, with checks. Run it first; CI runs it. | smoke |
| `investor-browse.js` | One request per iteration from the investor mix: `/me`, `/modules`, gates, data-room tree, a document, its page images, the viewer heartbeat (the write), updates archive and one update. | `SCENARIO=smoke\|load\|soak` |
| `admin.js` | People list and detail, analytics overview and hot list, audit log. | same |

`load` is a `ramping-arrival-rate`: each iteration is one request, so the arrival rate is the request rate. `soak` holds half of `TARGET_RPS` for `SOAK` (default 30 m) — run it before a release that touched pooling, caching or the job queue, and watch the app's memory (`docker stats`) and the p95 drifting over time rather than its level.

## Fault tests (Toxiproxy)

`apps/server/src/faults.integration.test.ts` runs in the integration suite (it needs Docker, ~70 s): the whole server against Postgres, Mailpit and SeaweedFS, each behind Toxiproxy. It is the executable form of the bounds below; run it after touching the database layer, an adapter's transport, or readiness:

```sh
pnpm build && npx vitest run --project integration apps/server/src/faults.integration.test.ts
```

| Fault | What must happen | Bound (test config → shipped default) |
|---|---|---|
| DB replies slower than the statement timeout (network) | the request fails with a 5xx envelope; the pool is healthy after | `DATABASE_STATEMENT_TIMEOUT_MS` + grace (2 s → 3 s; 30 s → 35 s) |
| DB black-holed (TCP up, no replies) | every in-flight request fails, more of them than the pool holds; no connection is left wedged | same, and connect/checkout ≤ min(10 s, that) |
| DB cut (refused) | `/healthz` 200; `/readyz` 503 with `database: fail`; recovery with no restart | probe 5 s |
| Every DB connection reset or terminated mid-traffic | each request ends (200 or 5xx); **the process does not crash**; the pool and the job queue recover | as above |
| S3 black-holed | `/readyz` 503 with `storage: fail`; get/put fail with a storage error | probe 5 s; adapter `maxAttempts × (connect + socket idle)` = 2 × (5 s + 30 s) |
| SMTP black-holed | sign-in (`POST /auth/otp/start`, which sends inline) answers 503 `mail_failed` | nodemailer connect/greeting 10 s, socket 30 s |
| SMTP refused while a job sends | the job is retried by pg-boss and the mail is delivered once, after recovery | queue `retryLimit` |

Operator knobs behind those bounds:

- **Database.** Everything derives from `DATABASE_STATEMENT_TIMEOUT_MS` (default 30 s): the server cancels a slow statement at that bound; the client abandons a query whose replies stop arriving (and destroys its connection, so it is never handed out again) a grace period later (half the timeout, 1–5 s); getting a connection is bounded by min(10 s, the same). A transaction that sets `statement_timeout = 0` (tenant export/import) lifts the client bound with it. `DATABASE_STATEMENT_TIMEOUT_MS=0` turns all three off. Migrations run on their own pool with no client bound.
- **SMTP.** Timeouts ride on the `SMTP_URL` query string, e.g. `smtp://relay:587?connectionTimeout=5000&greetingTimeout=5000&socketTimeout=15000`. Sign-in codes are sent inside the request, so these are also the worst case a user waits on a dead relay.
- **S3.** 5 s connect and 30 s socket-idle per attempt, two attempts (`createS3Storage` options; not yet environment variables). The idle bound never cuts off a large transfer that keeps moving.

## When a run goes wrong

- **setup() fails with HTTP 429** on `/auth/otp/start`: the stack is not running with `RATE_LIMIT_MULTIPLIER`, or the same addresses were used within the window by an earlier run. Restart the stack with the overlay, or wait 15 minutes.
- **setup() fails "no sign-in code … in Mailpit"**: `MAILPIT_URL` is not the Mailpit that receives the app's mail, or the app cannot reach SMTP (`docker compose logs app | grep mail`).
- **setup() fails "TOTP enrolment refused"**: an earlier run (or a person) enrolled the owner's factor. Pass `-e OWNER_TOTP_SECRET=…` from that run; if it is lost, start from a fresh stack (`down -v`).
- **setup() fails with 403 `step_up_required`**: the TOTP step-up did not take (a clock far off between the k6 container and the app, or a wrong secret).
- **"the uploaded PDF never became viewable"**: the worker role is not running (the compose app runs `api,web,worker`), or rendering failed — `document-rendering.md`.
- **Everything is 404**: `PUBLIC_ORIGIN` does not match the app's `BASE_URL`, so the `Host` header resolves no workspace.
