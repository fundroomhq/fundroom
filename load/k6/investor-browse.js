import { check } from "k6";
import { get, post } from "./lib/http.js";
import { openSessions, pick, options as profileOptions, weighted } from "./lib/profile.js";

/*
 * Investor browsing (the portal's hot path): portal home, the data room list, a document and its
 * watermarked page images, the updates archive and one update, plus the viewer's dwell heartbeat —
 * the one write an investor makes continuously. Each iteration is one request drawn from the mix
 * below, weighted roughly like a real session (the SPA fetches /me and /modules on every
 * navigation; the viewer beats every few seconds while a page is on screen).
 *
 *   k6 run -e SCENARIO=load -e TARGET_RPS=200 load/k6/investor-browse.js
 */
export const options = profileOptions("browse");

export function setup() {
  return openSessions();
}

const ok2xx = { "status is 2xx": (r) => r.status >= 200 && r.status < 300 };

export function browse(data) {
  const me = pick(data.investors);
  const doc = data.document;
  const mix = [
    [15, () => get(me, "/me")],
    [10, () => get(me, "/modules")],
    [5, () => get(me, "/compliance/gates")],
    [20, () => get(me, "/data-room/tree")],
    [10, () => get(me, "/updates/archive")],
  ];
  if (doc) {
    mix.push(
      [10, () => get(me, `/data-room/documents/${doc.id}`, "/data-room/documents/{id}")],
      [
        15,
        () =>
          get(
            me,
            `/data-room/documents/${doc.id}/pages/${1 + Math.floor(Math.random() * doc.pageCount)}`,
            "/data-room/documents/{id}/pages/{n}",
            { responseType: "none" },
          ),
      ],
      [
        10,
        () =>
          post(
            me,
            "/analytics/heartbeat",
            {
              resourceKind: "document",
              resourceId: doc.id,
              versionId: doc.versionId,
              page: 1 + Math.floor(Math.random() * doc.pageCount),
              ms: 5000,
            },
            "/analytics/heartbeat",
          ),
      ],
    );
  }
  if (data.updateSlug) {
    mix.push([5, () => get(me, `/updates/archive/${data.updateSlug}`, "/updates/archive/{slug}")]);
  }
  check(weighted(mix)(), ok2xx);
}
