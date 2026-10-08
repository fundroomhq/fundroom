import { HOLD, INVESTORS, OWNER_EMAIL, RAMP, SOAK, TARGET_RPS } from "./config.js";
import { get, ok, setPhase } from "./http.js";
import { ensureContent } from "./seed.js";
import { signIn, stepUpOwner } from "./session.js";

/*
 * What every profile shares: the §16 budgets as thresholds, the scenario shapes, and a setup()
 * that opens the sessions the VUs use.
 *
 * Budgets: API p95 < 150 ms for reads and < 400 ms for writes, and
 * < 300 ms overall at 200 RPS per tenant on 2 vCPU; error rate < 1 %. Setup traffic (sign-in,
 * Mailpit, seeding) is tagged `phase:setup` and left out of the thresholds.
 */
export const thresholds = {
  "http_req_duration{kind:read,phase:run}": ["p(95)<150"],
  "http_req_duration{kind:write,phase:run}": ["p(95)<400"],
  "http_req_duration{phase:run}": ["p(95)<300"],
  "http_req_failed{phase:run}": ["rate<0.01"],
  checks: ["rate>0.99"],
};

/**
 * `SCENARIO=smoke|load|soak` picks one (default smoke). Each iteration of `load`/`soak` is exactly
 * one request, so the arrival rate *is* the request rate: `load` ramps to TARGET_RPS over RAMP,
 * holds it for HOLD, and ramps down; `soak` holds half of it for SOAK.
 */
export function scenarios(exec) {
  const which = __ENV.SCENARIO || "smoke";
  const all = {
    smoke: { executor: "constant-vus", vus: 1, duration: "30s", exec },
    load: {
      executor: "ramping-arrival-rate",
      exec,
      startRate: 1,
      timeUnit: "1s",
      preAllocatedVUs: Math.max(10, Math.ceil(TARGET_RPS / 4)),
      maxVUs: Math.max(50, TARGET_RPS * 2),
      stages: [
        { target: TARGET_RPS, duration: RAMP },
        { target: TARGET_RPS, duration: HOLD },
        { target: 0, duration: "15s" },
      ],
    },
    soak: {
      executor: "constant-arrival-rate",
      exec,
      rate: Math.max(1, Math.floor(TARGET_RPS / 2)),
      timeUnit: "1s",
      duration: SOAK === "0" ? "30m" : SOAK,
      preAllocatedVUs: Math.max(10, Math.ceil(TARGET_RPS / 8)),
      maxVUs: Math.max(50, TARGET_RPS),
    },
  };
  if (!all[which]) throw new Error(`SCENARIO must be one of ${Object.keys(all).join(", ")}`);
  return { [which]: all[which] };
}

export const options = (exec) => ({
  scenarios: scenarios(exec),
  thresholds,
  setupTimeout: "5m",
  summaryTrendStats: ["avg", "med", "p(90)", "p(95)", "p(99)", "max"],
});

/** Signs the owner and up to INVESTORS active investors in, and makes sure there is content. */
export function openSessions({ investors = INVESTORS } = {}) {
  setPhase("setup");
  const owner = stepUpOwner(signIn(OWNER_EMAIL));
  const people = ok(get(owner, "/access/people?kind=external&status=active&limit=200"), "people");
  const emails = people.items
    .filter((p) => p.kind === "external" && p.status === "active" && p.email)
    .map((p) => p.email)
    .slice(0, investors);
  const sessions = emails.map((e) => signIn(e));
  if (investors > 0 && sessions.length === 0) {
    throw new Error("no active investors: seed with `seed-demo --investors N` first");
  }
  const content = ensureContent(owner, sessions[0]);
  setPhase("run");
  return { owner, investors: sessions, ...content };
}

/** Picks from `[[weight, fn], …]` in proportion to the weights. */
export function weighted(entries) {
  const total = entries.reduce((n, [w]) => n + w, 0);
  let r = Math.random() * total;
  for (const [w, fn] of entries) {
    r -= w;
    if (r <= 0) return fn;
  }
  return entries[entries.length - 1][1];
}

export function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}
