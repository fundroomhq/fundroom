import { check } from "k6";
import { get } from "./lib/http.js";
import { openSessions, options as profileOptions, weighted } from "./lib/profile.js";

/*
 * Staff back office: the people list (and one person), engagement analytics (overview and hot
 * list) and the audit log. Heavier queries than the portal, far fewer users; run it at a
 * fraction of the investor rate (e.g. TARGET_RPS=20) or alongside investor-browse.
 *
 *   k6 run -e SCENARIO=load -e TARGET_RPS=20 load/k6/admin.js
 */
export const options = profileOptions("admin");

export function setup() {
  const data = openSessions({ investors: 1 });
  const people = get(data.owner, "/access/people?limit=50").json();
  return { ...data, memberIds: people.items.map((p) => p.membershipId) };
}

const ok2xx = { "status is 2xx": (r) => r.status >= 200 && r.status < 300 };

export function admin(data) {
  const s = data.owner;
  const someone = data.memberIds[Math.floor(Math.random() * data.memberIds.length)];
  const res = weighted([
    [25, () => get(s, "/access/people?limit=50", "/access/people")],
    [10, () => get(s, `/access/people/${someone}`, "/access/people/{id}")],
    [20, () => get(s, "/analytics/overview?days=30", "/analytics/overview")],
    [15, () => get(s, "/analytics/hot-list?days=30", "/analytics/hot-list")],
    [20, () => get(s, "/audit/events?limit=50", "/audit/events")],
    [10, () => get(s, "/me")],
  ])();
  check(res, ok2xx);
}
