import type { ModuleServices } from "@fundroom/module-kit";
import { type JsonObject, MailSuppressedError, type OutboundEmail } from "@fundroom/ports";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * `run()` driven end to end over fake repositories, for the two properties that only a *second*
 * run can show.
 *
 * Decision D5 promises every recipient of one audience a byte-identical `<img src>`. The memo
 * that delivers on it lives for one call of `run()` and is rebuilt on the next — and a send is
 * retried five times (`jobs.ts`) and re-enqueued when it stalls (`SEND_STALE_MINUTES`), with the
 * resumed run rendering exactly the recipients that were still `queued`. So the property is not
 * a property of the memo at all; it is a property of the *instant* the memo is built from, and
 * nothing that keys off the clock can hold it. That is what the first test here drives: one send,
 * a worker that dies after the first recipient, thirty-one minutes of wall clock, and the same
 * URL on both mails.
 *
 * The second is the other half of the same shape: a hydration that fails pathologically must
 * cost a chart, never a send. Both need the whole of `run()` — where the memo is created, where
 * the recipients are looped, and where a throw decides whether the rest of the list ever goes
 * out — so the repositories are faked and everything above them is the real code.
 */

const H = vi.hoisted(() => ({
  board: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b01",
  state: {
    send: undefined as unknown as Record<string, unknown>,
    version: undefined as unknown as Record<string, unknown>,
    post: undefined as unknown as Record<string, unknown>,
    recipients: [] as Record<string, unknown>[],
    settings: {} as Record<string, unknown>,
    /** Rows another run holds (`claimQueued` skips them, as `SKIP LOCKED` would). */
    locked: new Set<string>(),
    /** Per-membership overrides of the (active, never-expiring, external) membership row. */
    members: {} as Record<string, Record<string, unknown> | null>,
    /** Per-membership group ids; everyone is on the board list by default. */
    groups: {} as Record<string, string[]>,
    /** Every `PostRepo.transition` call, in order. */
    transitions: [] as { from: string; to: string }[],
    /** `workspaceIsActive` (E3.10 FR1): false = the workspace is held or suspended. */
    maySend: true,
  },
}));

vi.mock("../repos/updates-repo.js", () => ({
  PostRepo: class {
    async live() {
      return H.state.post;
    }
    async transition(_id: string, from: string, to: string) {
      H.state.transitions.push({ from, to });
      return undefined;
    }
  },
  VersionRepo: class {
    async byId() {
      return H.state.version;
    }
  },
  SendRepo: class {
    async byId() {
      return H.state.send;
    }
    async setStatus(_id: string, from: string, to: string, patch: Record<string, unknown> = {}) {
      if (H.state.send["status"] !== from) return undefined;
      H.state.send = { ...H.state.send, status: to, ...patch };
      return H.state.send;
    }
    async update(_id: string, patch: Record<string, unknown>) {
      H.state.send = { ...H.state.send, ...patch };
      return H.state.send;
    }
  },
  RecipientRepo: class {
    async forSend() {
      return H.state.recipients;
    }
    async createMany() {
      return 0;
    }
    async queued(_sendId: string, limit: number, exclude: readonly string[] = []) {
      return H.state.recipients
        .filter((r) => r["status"] === "queued" && !exclude.includes(r["id"] as string))
        .slice(0, limit);
    }
    async claimQueued(id: string) {
      if (H.state.locked.has(id)) return undefined;
      return H.state.recipients.find((r) => r["id"] === id && r["status"] === "queued");
    }
    async statusOf(id: string) {
      return H.state.recipients.find((r) => r["id"] === id)?.["status"];
    }
    async mark(id: string, patch: Record<string, unknown>) {
      const row = H.state.recipients.find((r) => r["id"] === id);
      if (row !== undefined) Object.assign(row, patch);
    }
    async counts() {
      const out = {
        queued: 0,
        sent: 0,
        delivered: 0,
        failed: 0,
        skipped: 0,
        bounced: 0,
        complained: 0,
      };
      for (const r of H.state.recipients) out[r["status"] as keyof typeof out] += 1;
      return out;
    }
  },
  UnsubscribeRepo: class {
    async membershipIds() {
      return new Set<string>();
    }
  },
  SendingDomainRepo: class {
    async current() {
      return undefined;
    }
  },
}));

vi.mock("@fundroom/identity", () => ({
  MembershipRepo: class {
    async byIds(ids: readonly string[]) {
      return ids.flatMap((id) => {
        const over = H.state.members[id];
        if (over === null) return [];
        return [{ id, kind: "external", status: "active", expiresAt: null, ...over }];
      });
    }
    async namesFor() {
      return new Map();
    }
    async listPeople() {
      return { items: [], nextCursor: null };
    }
  },
  GroupRepo: class {
    /** Both recipients are on the board list: one audience, two people. */
    async groupIdsFor(membershipId: string) {
      return H.state.groups[membershipId] ?? [H.board];
    }
  },
  maskEmail: (email: string) => email,
  // E2.8 i18n: the recipient's language for the mail chrome; these tests read English.
  recipientLocale: async () => "en",
}));

vi.mock("@fundroom/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@fundroom/db")>()),
  workspaceIsActive: async () => H.state.maySend,
  findWorkspaceById: async () => ({
    id: "w1",
    slug: "acme",
    name: "Acme",
    primaryHost: null,
    settings: H.state.settings,
  }),
}));

vi.mock("@fundroom/events", () => ({ publish: async () => undefined }));

const { createDeliveryService, DeliveryDeferredError, isRelayMailError, isTransientMailError } =
  await import("./delivery.js");

/** The send row's own timestamp: written once at insert, and not in `SendRepo.update`'s patch. */
const BOARD = H.board;
const OTHER = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b02";

const SEND_CREATED = new Date("2026-03-31T09:00:00.000Z");

interface Harness {
  readonly services: ModuleServices;
  readonly sent: { to: string; html: string }[];
  readonly hydrations: () => number;
  /** Every message handed to the mailer, whole. */
  readonly messages: OutboundEmail[];
  /** Memberships the consent question was asked for. */
  readonly asked: string[];
}

function harness(
  options: {
    readonly abortAfterFirst?: AbortController;
    readonly poison?: boolean;
    /** Addresses the (fake) suppression wrapper refuses, and how it refuses them. */
    readonly suppress?: ReadonlyMap<string, unknown>;
    /** Memberships whose `email_tracking` purpose is allowed. */
    readonly consented?: ReadonlySet<string>;
  } = {},
): Harness {
  const sent: { to: string; html: string }[] = [];
  const messages: OutboundEmail[] = [];
  const asked: string[] = [];
  let hydrations = 0;
  let logThrows = options.poison === true;
  /*
   * The fake metrics hydrator. Like the real one it stamps the chart token with the instant it
   * was given — `ctx.asOf` — and, like the real one before this fix, it falls back to its own
   * clock when it is not given one. That fallback is what makes this test able to fail.
   */
  const hydrate = async (_data: JsonObject, c: unknown): Promise<JsonObject> => {
    hydrations += 1;
    if (options.poison === true && hydrations === 1) throw new Error("chart could not be drawn");
    const viewer = (c as { viewer: { groupIds: readonly string[] } }).viewer;
    const asOf = (c as { asOf?: Date }).asOf ?? new Date();
    return {
      columns: 3,
      metrics: [
        {
          id: "d1",
          key: "arr",
          name: "ARR",
          unit: "currency",
          currency: "USD",
          decimals: 0,
          direction: "up_good",
          latest: { periodKey: "2026-03", periodLabel: "Mar 2026", value: "1240000" },
          previous: null,
          sparkline: ["1240000"],
        },
      ],
      chart: {
        url: `https://acme.test/api/v1/metrics/chart/${viewer.groupIds.join("-")}-${asOf.getTime()}.png`,
        alt: "ARR by month, to March 2026.",
        width: 600,
        height: 300,
      },
    };
  };

  const services = {
    db: { withTenant: async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn({}) },
    mailer: {
      send: async (m: OutboundEmail) => {
        const refusal = options.suppress?.get(m.to);
        if (refusal !== undefined) throw refusal;
        messages.push(m);
        sent.push({ to: m.to, html: m.html ?? "" });
        options.abortAfterFirst?.abort();
        return { messageId: `m${sent.length}`, acceptedAt: new Date() };
      },
    },
    now: () => new Date(),
    log: (_event: string, _fields?: unknown) => {
      if (logThrows) {
        logThrows = false;
        throw new Error("the log sink is down");
      }
    },
    audit: { record: async () => undefined },
    legal: {
      resolveDisclaimer: async () => undefined,
      allowsPurpose: async (_tx: unknown, _ctx: unknown, membershipId: string, purpose: string) => {
        asked.push(membershipId);
        return purpose === "email_tracking" && (options.consented?.has(membershipId) ?? false);
      },
    },
    enablement: { get: async () => ({ enabled: new Set(["metrics"]) }) },
    registry: {
      blockHydrators: new Map([
        ["metric_grid", { module: "metrics", hydrator: { type: "metric_grid", hydrate } }],
      ]),
    },
    workspaceUrl: (_w: unknown, path: string) => new URL(path, "https://acme.test"),
    baseUrl: new URL("https://acme.test"),
    crypto: {
      // Only the unsubscribe footer needs it, and only to HMAC a link.
      currentKey: async () => ({ keyId: "k1", key: new Uint8Array(32) }),
    },
  } as unknown as ModuleServices;
  return { services, sent, hydrations: () => hydrations, messages, asked };
}

const srcOf = (html: string): string | undefined => /<img src="([^"]+)"/u.exec(html)?.[1];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-31T09:00:01.000Z"));
  H.state.send = {
    id: "s1",
    workspaceId: "w1",
    postId: "p1",
    versionId: "v1",
    kind: "live",
    status: "queued",
    requestedBy: null,
    total: 2,
    sent: 0,
    failed: 0,
    skipped: 0,
    error: null,
    startedAt: null,
    finishedAt: null,
    createdAt: SEND_CREATED,
  };
  H.state.version = {
    id: "v1",
    title: "Q3",
    audience: { kind: "all" },
    visibility: {},
    doc: {
      sections: [
        {
          key: "kpis",
          title: "KPIs",
          blocks: [
            { id: "grid", type: "metric_grid", schemaVersion: 1, data: { definitionIds: ["d1"] } },
          ],
        },
      ],
    },
  };
  H.state.post = { id: "p1", slug: "q3", authorMembershipId: null };
  H.state.settings = {};
  H.state.locked = new Set();
  H.state.members = {};
  H.state.groups = {};
  H.state.transitions = [];
  H.state.maySend = true;
  H.state.recipients = [
    { id: "r1", membershipId: "m1", email: "ada@example.test", status: "queued" },
    { id: "r2", membershipId: "m2", email: "grace@example.test", status: "queued" },
  ];
});

describe("a send that is resumed after a crash", () => {
  it("hands the second recipient the same chart URL as the first", async () => {
    const abort = new AbortController();
    const first = harness({ abortAfterFirst: abort });
    const delivery = createDeliveryService(first.services);

    // The worker dies after one recipient: the send stays `running`, `r2` stays `queued`.
    await expect(delivery.run("w1", "s1", [], abort.signal)).rejects.toThrow(/aborted/u);
    expect(first.sent).toHaveLength(1);

    // The dispatcher notices the stall (`SEND_STALE_MINUTES` is 30) and re-enqueues it.
    vi.setSystemTime(new Date("2026-03-31T09:31:12.000Z"));
    const second = harness();
    await createDeliveryService(second.services).run("w1", "s1", [], undefined);
    expect(second.sent).toHaveLength(1);

    // Two people, one audience, one capability URL — across the crash. Minted from `now()` the
    // two would differ by thirty-one minutes and D5's audience would have become two cohorts.
    expect(first.sent[0]?.to).not.toBe(second.sent[0]?.to);
    expect(srcOf(first.sent[0]?.html ?? "")).toBeDefined();
    expect(srcOf(second.sent[0]?.html ?? "")).toBe(srcOf(first.sent[0]?.html ?? ""));
    // And it is the send row's instant that both were minted from.
    expect(srcOf(first.sent[0]?.html ?? "")).toContain(String(SEND_CREATED.getTime()));
  });
});

describe("a send whose KPI hydration fails pathologically", () => {
  it("delivers every recipient anyway, with the archive link in place of the chart", async () => {
    // The hydrator throws and the log sink throws while recording it, so the hydration rejects
    // from outside the per-block guard. Awaited outside `deliver`'s `try` and memoised as the
    // audience's answer, that used to throw out of `run` with both rows still `queued` — and
    // each of the five retries would have re-run the same pill.
    const h = harness({ poison: true });
    const result = await createDeliveryService(h.services).run("w1", "s1", [], undefined);

    expect(result.sent).toBe(2);
    expect(H.state.recipients.every((r) => r["status"] === "sent")).toBe(true);
    expect(h.sent[0]?.html).toContain("View the KPIs on the web");
    // The audience is not stuck with the failure: the next reader's hydration is attempted.
    expect(h.hydrations()).toBe(2);
    expect(srcOf(h.sent[1]?.html ?? "")).toBeDefined();
  });
});

describe("a recipient the workspace has suppressed (E2.6 decision 3)", () => {
  it("is marked skipped with `suppressed`, counted as skipped, and the send carries on", async () => {
    const h = harness({
      suppress: new Map([["ada@example.test", new MailSuppressedError("bounce")]]),
    });
    const result = await createDeliveryService(h.services).run("w1", "s1", [], undefined);
    expect(result).toMatchObject({ sent: 1, failed: 0, skipped: 1 });
    expect(H.state.recipients.find((r) => r["id"] === "r1")).toMatchObject({
      status: "skipped",
      error: "suppressed",
    });
    expect(H.state.recipients.find((r) => r["id"] === "r2")?.["status"]).toBe("sent");
  });

  it("recognises the refusal by its code too, not only by class identity", async () => {
    // A second copy of `@fundroom/ports` in the process makes a second class; the code is the contract.
    const foreign = Object.assign(new Error("recipient suppressed (complaint)"), {
      code: "suppressed",
    });
    const h = harness({ suppress: new Map([["grace@example.test", foreign]]) });
    const result = await createDeliveryService(h.services).run("w1", "s1", [], undefined);
    expect(result).toMatchObject({ sent: 1, skipped: 1, failed: 0 });
    expect(H.state.recipients.find((r) => r["id"] === "r2")?.["error"]).toBe("suppressed");
  });

  it("still marks any other error failed", async () => {
    const h = harness({ suppress: new Map([["ada@example.test", new Error("421 try later")]]) });
    const result = await createDeliveryService(h.services).run("w1", "s1", [], undefined);
    expect(result).toMatchObject({ sent: 1, failed: 1, skipped: 0 });
  });
});

describe("what each message asks of the provider (E2.6 decision 1)", () => {
  it("is broadcast mail with a post ref naming the recipient's membership", async () => {
    const h = harness();
    await createDeliveryService(h.services).run("w1", "s1", [], undefined);
    expect(h.messages.map((m) => [m.stream, m.ref])).toEqual([
      ["broadcast", { kind: "post", id: "p1", membershipId: "m1" }],
      ["broadcast", { kind: "post", id: "p1", membershipId: "m2" }],
    ]);
  });

  it("never tracks outside `engagement`, and does not even ask about consent", async () => {
    H.state.settings = { analytics: { mode: "essential" } };
    const h = harness({ consented: new Set(["m1", "m2"]) });
    await createDeliveryService(h.services).run("w1", "s1", [], undefined);
    expect(h.messages.every((m) => m.tracking === undefined)).toBe(true);
    expect(h.asked).toEqual([]);
  });

  it("tracks in `engagement` only the members whose email_tracking purpose is allowed", async () => {
    H.state.settings = { analytics: { mode: "engagement" } };
    const h = harness({ consented: new Set(["m1"]) });
    await createDeliveryService(h.services).run("w1", "s1", [], undefined);
    const byTo = new Map(h.messages.map((m) => [m.to, m.tracking]));
    expect(byTo.get("ada@example.test")).toEqual({ opens: true, clicks: true });
    expect(byTo.get("grace@example.test")).toBeUndefined();
    expect([...h.asked].sort()).toEqual(["m1", "m2"]);
  });

  it("never tracks a test send, and keeps the requester's membership off its ref", async () => {
    H.state.settings = { analytics: { mode: "engagement" } };
    H.state.send = { ...H.state.send, kind: "test", requestedBy: "m1" };
    H.state.recipients = [
      { id: "r1", membershipId: "m1", email: "someone@example.test", status: "queued" },
    ];
    const h = harness({ consented: new Set(["m1"]) });
    await createDeliveryService(h.services).run("w1", "s1", [], undefined);
    expect(h.messages[0]?.tracking).toBeUndefined();
    expect(h.messages[0]?.ref).toEqual({ kind: "post", id: "p1" });
    expect(h.asked).toEqual([]);
  });
});

describe("a transient mail failure (E2.10: an SMTP outage must not fail the list for good)", () => {
  /** What the SMTP adapter throws when the relay refuses the connection. */
  const refused = () =>
    Object.assign(new Error("could not send the message"), {
      name: "MailerError",
      code: "connection_failed",
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:25"), {
        code: "ECONNREFUSED",
      }),
    });

  it("leaves the row queued, sends the rest, and fails the run so the job is retried", async () => {
    const h = harness({ suppress: new Map([["ada@example.test", refused()]]) });
    const run = createDeliveryService(h.services).run("w1", "s1", [], undefined);
    await expect(run).rejects.toBeInstanceOf(DeliveryDeferredError);
    expect(H.state.recipients.find((r) => r["id"] === "r1")).toMatchObject({
      status: "queued",
      error: "retrying: could not send the message",
    });
    expect(H.state.recipients.find((r) => r["id"] === "r2")?.["status"]).toBe("sent");
    // Not closed: the send is still running, and the post has not moved.
    expect(H.state.send["status"]).toBe("running");

    // The retry sends only what is still queued — Grace gets no second copy.
    const again = harness();
    const result = await createDeliveryService(again.services).run("w1", "s1", [], undefined);
    expect(again.sent.map((m) => m.to)).toEqual(["ada@example.test"]);
    expect(result).toMatchObject({ sent: 2, failed: 0 });
    expect(H.state.recipients.find((r) => r["id"] === "r1")?.["error"]).toBeNull();
  });

  it("stops the run after a streak of transient failures instead of timing out on every name", async () => {
    H.state.recipients = Array.from({ length: 8 }, (_, i) => ({
      id: `r${i}`,
      membershipId: `m${i}`,
      email: `p${i}@example.test`,
      status: "queued",
    }));
    let attempts = 0;
    const h = harness();
    (h.services.mailer as { send: unknown }).send = async () => {
      attempts += 1;
      throw refused();
    };
    await expect(createDeliveryService(h.services).run("w1", "s1", [], undefined)).rejects.toThrow(
      /5 recipient\(s\) deferred/u,
    );
    expect(attempts).toBe(5);
    expect(H.state.recipients.every((r) => r["status"] === "queued")).toBe(true);
  });

  it("is final once the send is older than the retry window", async () => {
    vi.setSystemTime(new Date(SEND_CREATED.getTime() + 25 * 3_600_000));
    const h = harness({ suppress: new Map([["ada@example.test", refused()]]) });
    const result = await createDeliveryService(h.services).run("w1", "s1", [], undefined);
    expect(result).toMatchObject({ sent: 1, failed: 1 });
    expect(H.state.recipients.find((r) => r["id"] === "r1")).toMatchObject({
      status: "failed",
      error: "could not send the message",
    });
  });

  it("never hands the mailer a row another run holds, and does not close the send under it", async () => {
    H.state.locked.add("r1");
    const h = harness();
    await expect(
      createDeliveryService(h.services).run("w1", "s1", [], undefined),
    ).rejects.toBeInstanceOf(DeliveryDeferredError);
    expect(h.sent.map((m) => m.to)).toEqual(["grace@example.test"]);
    expect(H.state.send["status"]).toBe("running");
  });

  it("classifies: 4xx, sockets and retryable adapters are transient; 5xx and the unknown are final", () => {
    const smtp = (responseCode: number) =>
      Object.assign(new Error("could not send the message"), {
        code: "send_failed",
        cause: Object.assign(new Error(`${responseCode} nope`), {
          responseCode,
          code: "EENVELOPE",
        }),
      });
    expect(isTransientMailError(refused())).toBe(true);
    expect(isTransientMailError(smtp(421))).toBe(true);
    expect(isTransientMailError(smtp(451))).toBe(true);
    expect(isTransientMailError({ code: "rate_limited" })).toBe(true);
    expect(isTransientMailError({ code: "send_failed", retryable: true })).toBe(true);
    expect(isTransientMailError(Object.assign(new Error("x"), { code: "ETIMEDOUT" }))).toBe(true);

    expect(isTransientMailError(smtp(550))).toBe(false);
    // A 5xx reply wins over a wrapper that calls itself retryable.
    expect(
      isTransientMailError({ retryable: true, cause: { responseCode: 554, code: "EMESSAGE" } }),
    ).toBe(false);
    expect(isTransientMailError({ code: "rejected", retryable: false })).toBe(false);
    expect(isTransientMailError(new Error("421 try later"))).toBe(false);
    expect(isTransientMailError(Symbol("weird"))).toBe(false);
    expect(isTransientMailError(null)).toBe(false);
  });
});

describe("eligibility is checked when the message goes, not when the list was built (R1-A3)", () => {
  it("skips a member whose membership expired or was revoked since, and sends the rest", async () => {
    H.state.members = {
      m1: { expiresAt: new Date("2026-03-31T09:00:00.500Z") }, // lapsed half a second ago
    };
    const h = harness();
    const result = await createDeliveryService(h.services).run("w1", "s1", [], undefined);
    expect(h.sent.map((m) => m.to)).toEqual(["grace@example.test"]);
    expect(result).toMatchObject({ sent: 1, skipped: 1, failed: 0 });
    expect(H.state.recipients.find((r) => r["id"] === "r1")).toMatchObject({
      status: "skipped",
      error: "membership expired",
    });

    // A retry of a deferred row finds the member revoked in the meantime.
    H.state.recipients = [
      { id: "r3", membershipId: "m3", email: "cy@example.test", status: "queued" },
      { id: "r4", membershipId: "m4", email: "di@example.test", status: "queued" },
    ];
    H.state.send = { ...H.state.send, status: "running" };
    H.state.members = { m3: { status: "revoked" }, m4: null };
    const again = harness();
    await createDeliveryService(again.services).run("w1", "s1", [], undefined);
    expect(again.sent).toEqual([]);
    expect(H.state.recipients.map((r) => [r["id"], r["status"], r["error"]])).toEqual([
      ["r3", "skipped", "membership revoked"],
      ["r4", "skipped", "no longer a member"],
    ]);
  });

  it("skips a member who has left every group the update is addressed to", async () => {
    H.state.version = { ...H.state.version, audience: { kind: "groups", groupIds: [BOARD] } };
    H.state.groups = { m2: [OTHER] };
    const h = harness();
    await createDeliveryService(h.services).run("w1", "s1", [], undefined);
    expect(h.sent.map((m) => m.to)).toEqual(["ada@example.test"]);
    expect(H.state.recipients.find((r) => r["id"] === "r2")).toMatchObject({
      status: "skipped",
      error: "no longer in the audience",
    });
  });

  it("an `all` update goes to external members only, even if one became staff since", async () => {
    H.state.members = { m2: { kind: "staff" } };
    const h = harness();
    await createDeliveryService(h.services).run("w1", "s1", [], undefined);
    expect(h.sent.map((m) => m.to)).toEqual(["ada@example.test"]);
  });
});

describe("one stubborn mailbox does not hold the archive back (R1-A4)", () => {
  const tempfail = () =>
    Object.assign(new Error("could not send the message"), {
      code: "send_failed",
      cause: Object.assign(new Error("452 mailbox full"), {
        responseCode: 452,
        command: "RCPT TO",
        code: "EENVELOPE",
      }),
    });

  it("publishes the post once everyone was tried and some mail went out, while the row retries", async () => {
    const h = harness({ suppress: new Map([["ada@example.test", tempfail()]]) });
    await expect(
      createDeliveryService(h.services).run("w1", "s1", [], undefined),
    ).rejects.toBeInstanceOf(DeliveryDeferredError);
    expect(H.state.recipients.find((r) => r["id"] === "r1")?.["status"]).toBe("queued");
    expect(H.state.transitions).toEqual([{ from: "sending", to: "sent" }]);
    expect(H.state.send["status"]).toBe("running");
  });

  it("does not publish when nothing was accepted, or when the run stopped on an outage", async () => {
    const both = harness({
      suppress: new Map([
        ["ada@example.test", tempfail()],
        ["grace@example.test", tempfail()],
      ]),
    });
    await expect(
      createDeliveryService(both.services).run("w1", "s1", [], undefined),
    ).rejects.toBeInstanceOf(DeliveryDeferredError);
    expect(H.state.transitions).toEqual([]);

    H.state.recipients = Array.from({ length: 8 }, (_, i) => ({
      id: `r${i}`,
      membershipId: `m${i}`,
      email: `p${i}@example.test`,
      status: i === 0 ? "sent" : "queued",
    }));
    const down = harness();
    (down.services.mailer as { send: unknown }).send = async () => {
      throw tempfail();
    };
    await expect(
      createDeliveryService(down.services).run("w1", "s1", [], undefined),
    ).rejects.toBeInstanceOf(DeliveryDeferredError);
    expect(H.state.transitions).toEqual([]);
  });
});

describe("a relay-level refusal is not the recipients' fault (R1-A8)", () => {
  /** What nodemailer raises for bad credentials, wrapped as the SMTP adapter wraps it. */
  const authFailed = () =>
    Object.assign(new Error("could not send the message"), {
      code: "connection_failed",
      cause: Object.assign(new Error("Invalid login: 535 5.7.8 Authentication failed"), {
        code: "EAUTH",
        responseCode: 535,
        command: "AUTH PLAIN",
      }),
    });
  const smtp = (responseCode: number, command: string, code = "EENVELOPE") =>
    Object.assign(new Error("could not send the message"), {
      code: "send_failed",
      cause: Object.assign(new Error(`${responseCode} no`), { responseCode, command, code }),
    });

  it("classifies the relay's 5xx as transient, and a recipient's or message's 5xx as final", () => {
    expect(isRelayMailError(authFailed())).toBe(true);
    expect(isTransientMailError(authFailed())).toBe(true);
    expect(isTransientMailError(smtp(554, "CONN", "EPROTOCOL"))).toBe(true);
    expect(isTransientMailError(smtp(550, "MAIL FROM"))).toBe(true);
    expect(isTransientMailError(smtp(530, "auth login", "EAUTH"))).toBe(true);
    expect(isTransientMailError({ code: "unauthorized", status: 401 })).toBe(true);

    expect(isRelayMailError(smtp(550, "RCPT TO"))).toBe(false);
    expect(isTransientMailError(smtp(550, "RCPT TO"))).toBe(false);
    expect(isTransientMailError(smtp(554, "DATA", "EMESSAGE"))).toBe(false);
    expect(isRelayMailError(null)).toBe(false);
    expect(isRelayMailError(Symbol("weird"))).toBe(false);
  });

  it("halts the run on bad credentials and leaves every recipient queued for the retry", async () => {
    H.state.recipients = Array.from({ length: 8 }, (_, i) => ({
      id: `r${i}`,
      membershipId: `m${i}`,
      email: `p${i}@example.test`,
      status: "queued",
    }));
    let attempts = 0;
    const h = harness();
    (h.services.mailer as { send: unknown }).send = async () => {
      attempts += 1;
      throw authFailed();
    };
    await expect(
      createDeliveryService(h.services).run("w1", "s1", [], undefined),
    ).rejects.toBeInstanceOf(DeliveryDeferredError);
    expect(attempts).toBe(5);
    expect(H.state.recipients.every((r) => r["status"] === "queued")).toBe(true);
  });
});

describe("a held or suspended workspace (E3.10 FR1)", () => {
  it("sends nothing and leaves the send queued for the dispatcher to resume", async () => {
    H.state.maySend = false;
    const h = harness();
    const r = await createDeliveryService(h.services).run("w1", "s1", []);
    expect(h.sent).toEqual([]);
    expect(r).toMatchObject({ sendId: "s1", sent: 0 });
    expect(H.state.send["status"]).toBe("queued");
    expect(H.state.recipients.map((x) => x["status"])).toEqual(["queued", "queued"]);
    expect(H.state.transitions).toEqual([]);
  });

  it("stops before the next batch when the workspace is suspended mid-send, without finishing it", async () => {
    const h = harness();
    const send = h.services.mailer.send.bind(h.services.mailer);
    (h.services.mailer as { send: typeof send }).send = async (m) => {
      const out = await send(m);
      H.state.maySend = false; // suspended while the first batch was going out
      return out;
    };
    const delivery = createDeliveryService(h.services);
    // Both recipients are in the first batch (SEND_BATCH > 2): the batch in flight completes,
    // then the next claim finds the workspace suspended and the send stays unfinished.
    await delivery.run("w1", "s1", []);
    expect(h.sent.length).toBeGreaterThan(0);
    expect(H.state.send["status"]).not.toBe("finished");
  });
});
