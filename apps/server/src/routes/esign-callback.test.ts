import { describe, expect, it } from "vitest";
import { classifyRequest } from "../tenancy.js";
import {
  DROPBOX_SIGN_ACK,
  ESIGN_CALLBACK_MAX_BYTES,
  type ESignCallbackIngest,
  esignCallbackRoutes,
  esignCallbackUrl,
} from "./esign-callback.js";

/*
 * The callback route's pipeline (E3.5): one 401 for every unauthenticated shape, a budget that
 * junk can never spend, the Dropbox Sign ack, and the ops classification of the path.
 */
const CONN = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b6a";
const OTHER = "0192f1a0-5c3e-7d2a-9a3b-6a5b4c3d2e1f";
const GOOD = "genuine";

function fixture(
  options: {
    maxPerMinute?: number;
    perConnection?: number;
    preAuth?: number;
    bypassFailures?: number;
    /** Tests default to no floor; the timing test sets one. */
    shedFloorMs?: number;
    /** Simulated authentication work (lookup + transaction + unseal) in ms. */
    authMs?: number;
    driver?: "documenso" | "dropbox-sign";
    throws?: boolean;
  } = {},
) {
  const log: { event: string; fields: Record<string, unknown> }[] = [];
  let minute = 1_000_000;
  let work = 0;
  let lookups = 0;
  const workFor = new Map<string, number>();
  const ingest: ESignCallbackIngest = async (connectionId, request, { admit }) => {
    lookups += 1;
    if (options.authMs !== undefined) await new Promise((r) => setTimeout(r, options.authMs));
    if (options.throws) throw new Error(`boom ${new TextDecoder().decode(request.body)}`);
    if (![CONN, OTHER].includes(connectionId) || request.headers.get("x-sig") !== GOOD)
      return { status: 401 };
    const driver = options.driver ?? "documenso";
    if (!admit()) return { status: 429, driver };
    work += 1;
    workFor.set(connectionId, (workFor.get(connectionId) ?? 0) + 1);
    return { status: 200, driver };
  };
  const app = esignCallbackRoutes({
    ingest: () => ingest,
    log: (event, fields) => log.push({ event, fields: fields as Record<string, unknown> }),
    budget: {
      perMinute: options.maxPerMinute,
      perConnectionPerMinute: options.perConnection,
      preAuthPerMinute: options.preAuth,
      bypassFailuresPerMinute: options.bypassFailures,
      shedFloorMs: options.shedFloorMs ?? 0,
      now: () => minute,
    },
  });
  const post = (sig: string, id = CONN, body = "{}") =>
    app.request(`https://x.test/webhooks/esign/${id}`, {
      method: "POST",
      headers: { "x-sig": sig, "content-type": "application/json" },
      body,
    });
  return {
    post,
    log,
    work: () => work,
    workFor: (id: string) => workFor.get(id) ?? 0,
    lookups: () => lookups,
    tick: () => {
      minute += 60_000;
    },
  };
}

describe("e-sign callback route", () => {
  it("answers one 401 for a bad signature, an unknown connection and a non-uuid id", async () => {
    const { post, work } = fixture();
    const bodies = [
      await post("forged"),
      await post(GOOD, "0192f1a0-5c3e-7d2a-9a3b-000000000000"),
      await post(GOOD, "not-a-uuid"),
    ];
    for (const res of bodies) {
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: { code: "unauthenticated" } });
    }
    expect(work()).toBe(0);
  });

  it("a flood of forged callbacks never starves the genuine vendor", async () => {
    const { post, work } = fixture({ maxPerMinute: 5 });
    for (let i = 0; i < 200; i++) expect((await post(`forged-${i}`)).status).toBe(401);
    expect((await post(GOOD)).status).toBe(200);
    expect(work()).toBe(1);
  });

  it("past the budget answers 200 (never a non-2xx the vendor would count) and does no work", async () => {
    const { post, work, tick } = fixture({ maxPerMinute: 3 });
    for (let i = 0; i < 3; i++) expect((await post(GOOD)).status).toBe(200);
    const over = await post(GOOD);
    expect(over.status).toBe(200);
    expect(await over.json()).toEqual({ ok: true });
    expect(work()).toBe(3);
    tick();
    expect((await post(GOOD)).status).toBe(200);
    expect(work()).toBe(4);
  });

  it("keys the budget by connection: one tenant's flood leaves the others their share", async () => {
    const { post, workFor } = fixture({ perConnection: 5, maxPerMinute: 20 });
    for (let i = 0; i < 100; i++) expect((await post(GOOD, CONN)).status).toBe(200);
    expect(workFor(CONN)).toBe(5);
    for (let i = 0; i < 5; i++) expect((await post(GOOD, OTHER)).status).toBe(200);
    expect(workFor(OTHER)).toBe(5);
  });

  it("the process-wide backstop still caps the sum of all connections", async () => {
    const { post, work } = fixture({ perConnection: 5, maxPerMinute: 7 });
    for (let i = 0; i < 5; i++) await post(GOOD, CONN);
    for (let i = 0; i < 5; i++) await post(GOOD, OTHER);
    expect(work()).toBe(7);
  });

  it("sheds a never-seen id past the pre-auth ceiling with one 200 body and no lookup", async () => {
    const { post, lookups, work, tick } = fixture({ preAuth: 10 });
    for (let i = 0; i < 10; i++) await post(`forged-${i}`);
    expect(lookups()).toBe(10);
    // Never a 401 (junk must not switch off every tenant's callbacks) and one body for any id.
    const shed = await post(GOOD);
    const forged = await post("forged");
    const unknown = await post(GOOD, "0192f1a0-5c3e-7d2a-9a3b-000000000000");
    for (const res of [shed, forged, unknown]) {
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(DROPBOX_SIGN_ACK);
    }
    expect(lookups()).toBe(10);
    expect(work()).toBe(0);
    // Under the ceiling again, unknown / forged are the usual 401.
    tick();
    expect((await post("forged")).status).toBe(401);
    expect((await post(GOOD)).status).toBe(200);
    expect(work()).toBe(1);
  });

  it("a connection that authenticated recently keeps its wake-ups through a junk flood", async () => {
    const { post, lookups, workFor } = fixture({ preAuth: 10, perConnection: 3 });
    expect((await post(GOOD, CONN)).status).toBe(200);
    // Junk uuids fill the ceiling: 401 while under it, then the shed 200.
    for (let i = 0; i < 50; i++) {
      const junk = `0192f1a0-5c3e-7d2a-9a3b-${String(i).padStart(12, "0")}`;
      expect((await post(GOOD, junk)).status).toBe(i < 9 ? 401 : 200);
    }
    const before = lookups();
    // CONN bypasses the ceiling (up to its per-connection budget); OTHER never authenticated.
    expect(await (await post(GOOD, CONN)).json()).toEqual({ ok: true });
    expect(workFor(CONN)).toBe(2);
    expect(await (await post(GOOD, OTHER)).text()).toBe(DROPBOX_SIGN_ACK);
    expect(workFor(OTHER)).toBe(0);
    expect(lookups()).toBe(before + 1);
    // A forged callback naming the recent id while shedding: the same ack as a never-seen id.
    const forged = await post("forged", CONN);
    expect(forged.status).toBe(200);
    expect(await forged.text()).toBe(DROPBOX_SIGN_ACK);
    // The bypass is capped at the per-connection budget (3 authenticated a minute here; the
    // forged one above spent none of it): two more genuine ones pass, the next is shed without a
    // lookup.
    expect((await post(GOOD, CONN)).status).toBe(200);
    expect(workFor(CONN)).toBe(3);
    expect((await post(GOOD, CONN)).status).toBe(200); // authenticated, over the post-auth budget
    expect(workFor(CONN)).toBe(3);
    const spent = lookups();
    expect(await (await post(GOOD, CONN)).text()).toBe(DROPBOX_SIGN_ACK);
    expect(lookups()).toBe(spent);
    expect(workFor(CONN)).toBe(3);
  });

  it("R3C-1: forged callbacks naming a recent id do not spend its authenticated bypass", async () => {
    const { post, workFor, lookups } = fixture({ preAuth: 1, perConnection: 5 });
    expect((await post(GOOD, CONN)).status).toBe(200); // authenticates; fills the ceiling
    // Five forgeries naming CONN while shedding (as many as its whole authenticated budget).
    for (let i = 0; i < 5; i++) {
      const res = await post(`forged-${i}`, CONN);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(DROPBOX_SIGN_ACK);
    }
    // The genuine vendor still bypasses: its wake-up is queued, not shed.
    expect(await (await post(GOOD, CONN)).json()).toEqual({ ok: true });
    expect(workFor(CONN)).toBe(2);
    // The forgeries spend only their own sub-budget: past it, CONN is shed without a lookup.
    const f = fixture({ preAuth: 1, perConnection: 5, bypassFailures: 3 });
    await f.post(GOOD, CONN);
    for (let i = 0; i < 3; i++) await f.post(`forged-${i}`, CONN);
    const before = f.lookups();
    expect(await (await f.post(GOOD, CONN)).text()).toBe(DROPBOX_SIGN_ACK);
    expect(f.lookups()).toBe(before);
    expect(f.workFor(CONN)).toBe(1);
    expect(lookups()).toBe(7);
  });

  it("R3C-1: a concurrent burst of forgeries cannot overrun the failure sub-budget", async () => {
    const { post, lookups } = fixture({
      preAuth: 1,
      perConnection: 5,
      bypassFailures: 4,
      authMs: 5,
    });
    await post(GOOD, CONN);
    await Promise.all(Array.from({ length: 50 }, (_, i) => post(`forged-${i}`, CONN)));
    expect(lookups()).toBe(1 + 4);
  });

  it("R3C-2: while shedding, a forged callback to a recent id takes as long as shed junk", async () => {
    const FLOOR = 60;
    const { post } = fixture({ preAuth: 1, shedFloorMs: FLOOR, authMs: 15 });
    await post(GOOD, CONN); // CONN authenticated recently; the ceiling is now full
    const time = async (sig: string, id: string) => {
      const t = performance.now();
      const res = await post(sig, id);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(DROPBOX_SIGN_ACK);
      return performance.now() - t;
    };
    const junk: number[] = [];
    const recent: number[] = [];
    for (let i = 0; i < 5; i++) {
      junk.push(await time(GOOD, `0192f1a0-5c3e-7d2a-9a3b-${String(i).padStart(12, "0")}`));
      recent.push(await time(`forged-${i}`, CONN));
    }
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
    // Both are held to the floor (timers fire a little late, never early)...
    expect(median(junk)).toBeGreaterThanOrEqual(FLOOR - 2);
    expect(median(recent)).toBeGreaterThanOrEqual(FLOOR - 2);
    // ...so the authentication work behind the forged one is not visible.
    expect(Math.abs(median(recent) - median(junk))).toBeLessThan(6);
  });

  it("R3C-2: a callback that authenticates while shedding is not held to the floor", async () => {
    const { post, workFor } = fixture({ preAuth: 1, shedFloorMs: 500 });
    await post(GOOD, CONN);
    const t = performance.now();
    expect(await (await post(GOOD, CONN)).json()).toEqual({ ok: true });
    expect(performance.now() - t).toBeLessThan(250);
    expect(workFor(CONN)).toBe(2);
  });

  it("forgets a recent authentication after a few minutes", async () => {
    const { post, workFor, tick } = fixture({ preAuth: 1 });
    await post(GOOD, CONN);
    for (let i = 0; i < 6; i++) tick();
    await post("forged", OTHER); // fills the new minute's ceiling
    expect(await (await post(GOOD, CONN)).text()).toBe(DROPBOX_SIGN_ACK);
    expect(workFor(CONN)).toBe(1);
  });

  it("logs the first rejection of a minute and a summary when it rolls, not one per request", async () => {
    const { post, log, tick } = fixture();
    for (let i = 0; i < 50; i++) await post("forged");
    tick();
    await post("forged");
    const summary = log.filter((l) => l.event === "esign.callback_summary");
    expect(summary).toHaveLength(1);
    expect(summary[0]?.fields).toMatchObject({ rejected: 50 });
    expect(log.length).toBe(1);
  });

  it("answers Dropbox Sign with its ack text, everyone else with JSON", async () => {
    const dropbox = fixture({ driver: "dropbox-sign" });
    const res = await dropbox.post(GOOD);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(DROPBOX_SIGN_ACK);
    const documenso = fixture();
    expect(await (await documenso.post(GOOD)).json()).toEqual({ ok: true });
  });

  it("refuses bodies past 256 KiB before ingestion", async () => {
    const { post, work } = fixture();
    const res = await post(GOOD, CONN, "x".repeat(ESIGN_CALLBACK_MAX_BYTES + 1));
    expect(res.status).toBe(413);
    expect(work()).toBe(0);
  });

  it("answers 500 when ingestion throws, logging only the error's name", async () => {
    const { post, log } = fixture({ throws: true });
    const res = await post(GOOD, CONN, "secret-payload");
    expect(res.status).toBe(500);
    expect(JSON.stringify(log)).not.toContain("secret-payload");
  });

  it("is an ops path on the canonical host, and the URL an admin pastes points there", () => {
    const options = { mode: "multi" as const, canonicalHost: "portal.test", basePath: "" };
    expect(
      classifyRequest({ host: "portal.test", path: `/webhooks/esign/${CONN}` }, options)?.tree,
    ).toBe("ops");
    // Nested, upper-case or non-uuid segments are not the callback.
    for (const path of [
      `/webhooks/esign/${CONN}/x`,
      `/webhooks/esign/${CONN.toUpperCase()}`,
      "/webhooks/esign/documenso",
    ])
      expect(classifyRequest({ host: "portal.test", path }, options)?.tree).not.toBe("ops");
    expect(esignCallbackUrl(new URL("https://portal.test/"), CONN)).toBe(
      `https://portal.test/webhooks/esign/${CONN}`,
    );
  });
});
