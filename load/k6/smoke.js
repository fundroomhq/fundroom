import { check, group, sleep } from "k6";
import { get, post } from "./lib/http.js";
import { openSessions, thresholds } from "./lib/profile.js";

/*
 * Smoke: one VU for 30 s walking every endpoint the two profiles use, in order, with a check on
 * each. It proves the scripts, the stack and the seed data agree before anyone spends a load run
 * on them, and it is what CI runs (load.yml). Same thresholds as the load profiles.
 *
 *   k6 run load/k6/smoke.js
 */
export const options = {
  scenarios: { smoke: { executor: "constant-vus", vus: 1, duration: __ENV.DURATION || "30s" } },
  thresholds,
  setupTimeout: "5m",
  summaryTrendStats: ["avg", "med", "p(90)", "p(95)", "p(99)", "max"],
};

export function setup() {
  return openSessions({ investors: 2 });
}

const ok2xx = (name) => ({ [`${name} is 2xx`]: (r) => r.status >= 200 && r.status < 300 });

export default function (data) {
  const investor = data.investors[0];
  const doc = data.document;
  group("investor", () => {
    check(get(investor, "/me"), ok2xx("me"));
    check(get(investor, "/modules"), ok2xx("modules"));
    check(get(investor, "/data-room/tree"), ok2xx("data-room tree"));
    if (doc) {
      check(
        get(investor, `/data-room/documents/${doc.id}`, "/data-room/documents/{id}"),
        ok2xx("document"),
      );
      check(
        get(
          investor,
          `/data-room/documents/${doc.id}/pages/1`,
          "/data-room/documents/{id}/pages/{n}",
          {
            responseType: "none",
          },
        ),
        ok2xx("page image"),
      );
      check(
        post(investor, "/analytics/heartbeat", {
          resourceKind: "document",
          resourceId: doc.id,
          versionId: doc.versionId,
          page: 1,
          ms: 5000,
        }),
        ok2xx("heartbeat"),
      );
    }
    check(get(investor, "/updates/archive"), ok2xx("updates archive"));
    if (data.updateSlug) {
      check(
        get(investor, `/updates/archive/${data.updateSlug}`, "/updates/archive/{slug}"),
        ok2xx("update"),
      );
    }
  });
  group("staff", () => {
    const s = data.owner;
    check(get(s, "/access/people?limit=50", "/access/people"), ok2xx("people"));
    check(get(s, "/analytics/overview?days=30", "/analytics/overview"), ok2xx("analytics"));
    check(get(s, "/audit/events?limit=50", "/audit/events"), ok2xx("audit"));
  });
  sleep(1);
}
