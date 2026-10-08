import type { OfferingStatus, TenantContext, Tx } from "@fundroom/db";
import type { AccreditationAnswersInput, ModuleServices } from "@fundroom/module-kit";
import { describe, expect, it } from "vitest";
import type { RoundError } from "../errors.js";
import { createInterestService, INTEREST_RATE } from "./interest.js";

/*
 * The interest path (E2.5 D4) with the kernel standing in: a fake `legal`, a fake accreditation
 * port and a fake transaction that answers the four statements the service issues.
 *
 * Every decision pinned here is a rule from design/04 rather than a product choice — which path
 * an offering status implies, when a verification is opened, when an acceptance is refused — so
 * a change to one of them should have to change a sentence in this file.
 */

const WORKSPACE = "01920000-0000-7000-8000-000000000001";
const ROUND = "01920000-0000-7000-8000-0000000000a1";
const MEMBER = "01920000-0000-7000-8000-0000000000d1";
const STAFF = "01920000-0000-7000-8000-0000000000d9";
const SUBMISSION = "01920000-0000-7000-8000-0000000000f1";
const VERIFICATION = "01920000-0000-7000-8000-0000000000c1";
const tenant: TenantContext = {
  workspaceId: WORKSPACE,
  actorKind: "external",
  membershipId: MEMBER,
};
const NOW = new Date("2026-03-15T12:00:00.000Z");

function sqlText(node: unknown, out: string[] = []): string {
  if (node === null || typeof node !== "object") return out.join("");
  const c = node as Record<string, unknown>;
  const chunks = c["queryChunks"];
  if (Array.isArray(chunks)) {
    for (const k of chunks) sqlText(k, out);
    return out.join("");
  }
  const value = c["value"];
  if (!("encoder" in c) && Array.isArray(value)) out.push(...(value as string[]));
  return out.join("");
}

const roundRow = (over: Record<string, unknown> = {}) => ({
  id: ROUND,
  name: "Seed 2026",
  stage: "seed",
  instrumentKind: "safe",
  status: "open",
  targetAmount: "2000000.000000",
  currency: "USD",
  minimumInvestment: null,
  opensAt: null,
  closesAt: null,
  openedAt: NOW,
  closedAt: null,
  showProgress: true,
  summary: null,
  createdBy: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

const submissionRow = (over: Record<string, unknown> = {}) => ({
  id: SUBMISSION,
  roundId: ROUND,
  membershipId: MEMBER,
  amount: "250000.000000",
  currency: "USD",
  subject: "individual",
  entityName: null,
  note: null,
  accreditationPath: "self_attested",
  nonAccredited: false,
  accreditationStamp: null,
  disclaimerStamp: "offering-disclaimer:v3",
  offeringStatus: "506b",
  status: "submitted",
  verificationId: null,
  commitmentId: null,
  decidedBy: null,
  decidedAt: null,
  decisionNote: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

const verificationRow = (over: Record<string, unknown> = {}) => ({
  id: VERIFICATION,
  membershipId: MEMBER,
  interestSubmissionId: SUBMISSION,
  provider: "manual",
  providerRef: null,
  method: null,
  status: "pending",
  evidenceKey: null,
  evidenceSha256: null,
  evidenceContentType: null,
  evidenceBytes: null,
  evidenceNote: null,
  evidenceUploadedAt: null,
  evidencePurgedAt: null,
  decidedBy: null,
  decidedAt: null,
  decisionNote: null,
  expiresAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

const commitmentRow = (over: Record<string, unknown> = {}) => ({
  id: "01920000-0000-7000-8000-0000000000e1",
  roundId: ROUND,
  membershipId: MEMBER,
  organizationId: null,
  contactId: null,
  displayName: null,
  amount: "250000.000000",
  status: "soft",
  note: null,
  interestSubmissionId: SUBMISSION,
  signedDocumentId: null,
  wiredAt: null,
  createdBy: STAFF,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

interface HarnessOptions {
  readonly round?: Record<string, unknown> | null | undefined;
  readonly accredited?: boolean | undefined;
  /** What `data.method` says: `self_certified` unless a test says somebody checked. */
  readonly accreditationMethod?: string | undefined;
  readonly submission?: Record<string, unknown> | null | undefined;
  readonly allowed?: boolean | undefined;
  readonly nonAccreditedCount?: number | undefined;
  readonly certify?: (() => never) | undefined;
  readonly startThrows?: boolean | undefined;
  /** E3.7: the workspace's effective provider (`manual` unless a test connects a vendor). */
  readonly driver?: "manual" | "verifyinvestor" | undefined;
  /** E3.7: the member already has this pending verification. */
  readonly pending?: Record<string, unknown> | undefined;
}

function harness(options: HarnessOptions = {}) {
  const statements: string[] = [];
  const audits: Record<string, unknown>[] = [];
  const events: { topic: string; payload: Record<string, unknown> }[] = [];
  const certified: unknown[] = [];
  const started: unknown[] = [];
  const logs: string[] = [];
  const jobs: { name: string; data: unknown }[] = [];
  const vendorCalls: string[] = [];

  const tx = {
    async execute(query: unknown) {
      const text = sqlText(query).replace(/\s+/gu, " ").trim();
      statements.push(text.slice(0, 60));
      if (text.includes("FROM round.round")) {
        return { rows: options.round === null ? [] : [roundRow(options.round)] };
      }
      if (text.includes("INTO round.interest_submission")) return { rows: [submissionRow()] };
      if (text.includes("UPDATE round.interest_submission SET status =")) {
        return { rows: [submissionRow({ status: "accepted", commitmentId: commitmentRow().id })] };
      }
      if (text.includes("UPDATE round.interest_submission")) return { rows: [] };
      if (text.includes("count(*)::int AS n FROM round.interest_submission")) {
        return { rows: [{ n: options.nonAccreditedCount ?? 0 }] };
      }
      if (text.includes("FROM round.interest_submission")) {
        return { rows: options.submission === null ? [] : [submissionRow(options.submission)] };
      }
      if (text.includes("INTO round.verification")) {
        return { rows: [verificationRow({ provider: options.driver ?? "manual" })] };
      }
      if (text.includes("FROM round.verification") && text.includes("status = 'pending'")) {
        return { rows: options.pending === undefined ? [] : [verificationRow(options.pending)] };
      }
      if (text.includes("UPDATE round.verification")) return { rows: [verificationRow()] };
      if (text.includes("INTO round.commitment")) return { rows: [commitmentRow()] };
      if (text.includes("INSERT INTO core.outbox") || text.includes("core.outbox")) {
        return { rows: [{ id: 1 }] };
      }
      return { rows: [] };
    },
    insert: () => tx,
    values: () => tx,
    returning: async () => [{ id: 1 }],
  };

  const services = {
    db: {
      withTenant: <T>(_ctx: TenantContext, fn: (tx: Tx) => Promise<T>) => fn(tx as unknown as Tx),
    },
    rateLimiter: {
      async hit() {
        const allowed = options.allowed ?? true;
        return { allowed, remaining: allowed ? 4 : 0, retryAfterMs: allowed ? 0 : 900_000 };
      },
    },
    legal: {
      async stampFor() {
        return "offering-disclaimer:v3";
      },
      async accreditation() {
        return {
          accredited: options.accredited ?? false,
          method: options.accreditationMethod ?? "self_certified",
        };
      },
      async certifyAccreditation(_tx: unknown, _ctx: unknown, input: unknown) {
        if (options.certify !== undefined) options.certify();
        certified.push(input);
        const answers = (input as { answers: AccreditationAnswersInput }).answers;
        return {
          stamp: "accreditation:v1",
          accredited: answers.categories.length > 0,
          nonAccredited: answers.categories.length === 0,
        };
      },
    },
    // E3.7: `ModuleServices.accreditation` is `AccreditationServices`. The submission only asks
    // which provider is effective; a vendor is never called from it (the start is a job).
    accreditation: {
      async effective(_tx: unknown, ctx: unknown) {
        started.push(ctx);
        const driver = options.driver ?? "manual";
        return driver === "manual"
          ? {
              driver,
              label: "Manual review",
              requires: { evidenceUpload: true, adminDecision: true },
            }
          : {
              driver,
              label: "VerifyInvestor.com",
              requires: { evidenceUpload: false, adminDecision: false },
              connectionId: "01920000-0000-7000-8000-0000000000b1",
            };
      },
      async start() {
        vendorCalls.push("start");
        throw new Error("the vendor must not be called from a submission");
      },
      async check() {
        vendorCalls.push("check");
        throw new Error("the vendor must not be called from a submission");
      },
    },
    queue: {
      async sendInTransaction(_tx: unknown, name: string, data: unknown) {
        jobs.push({ name, data });
        return "job-1";
      },
    },
    audit: {
      async record(_tx: unknown, _ctx: unknown, input: Record<string, unknown>) {
        audits.push(input);
        return {};
      },
    },
    now: () => NOW,
    log: (event: string) => logs.push(event),
  } as unknown as ModuleServices;

  // `publish` writes straight to the outbox through the same `tx.execute`, so the events are
  // read back off the statement list rather than through a second seam.
  return { services, statements, audits, events, certified, started, logs, jobs, vendorCalls };
}

const actor = { membershipId: MEMBER, requestId: "req-1", sessionId: "sess-1" };

const submit = (h: ReturnType<typeof harness>, over: Record<string, unknown> = {}) =>
  createInterestService(h.services).submit({
    ctx: tenant,
    membershipId: MEMBER,
    offeringStatus: "506b" as OfferingStatus,
    amount: "250000",
    subject: "individual",
    actor,
    ...over,
  });

const auditActions = (h: ReturnType<typeof harness>) => h.audits.map((a) => a["action"]);

describe("the rate limit", () => {
  it("is five an hour per member", () => {
    expect(INTEREST_RATE).toEqual({ max: 5, windowMs: 3_600_000 });
  });

  it("refuses the sixth before it reads anything", async () => {
    const h = harness({ allowed: false });
    await expect(submit(h)).rejects.toMatchObject({ code: "rate_limited" });
    // Nothing was read: the limit is the first thing checked, because a submission fans out
    // into an audit row, an outbox event, a notification and possibly an attestation.
    expect(h.statements).toEqual([]);
  });

  it("reports how long to wait", async () => {
    const h = harness({ allowed: false });
    await submit(h).catch((error: RoundError) => {
      expect(error.details).toMatchObject({ retryAfterMs: 900_000 });
    });
  });
});

describe("validation", () => {
  it("refuses an amount that is not a positive decimal", async () => {
    await expect(submit(harness(), { amount: "nope" })).rejects.toMatchObject({
      code: "validation_failed",
      details: { field: "amount" },
    });
    await expect(submit(harness(), { amount: "0" })).rejects.toMatchObject({
      code: "validation_failed",
    });
  });

  it("asks an entity to name itself", async () => {
    await expect(submit(harness(), { subject: "entity" })).rejects.toMatchObject({
      code: "validation_failed",
      details: { field: "entityName" },
    });
  });

  it("refuses when no round is open", async () => {
    await expect(submit(harness({ round: { status: "closed" } }))).rejects.toMatchObject({
      code: "round_not_open",
    });
    await expect(submit(harness({ round: null }))).rejects.toMatchObject({
      code: "round_not_open",
    });
  });

  it("refuses an amount under the round's minimum, naming it and its currency", async () => {
    const h = harness({ round: { minimumInvestment: "500000.000000" } });
    await expect(submit(h, { amount: "250000" })).rejects.toMatchObject({
      code: "below_minimum",
      details: { minimum: "500000.00", currency: "USD" },
    });
  });

  it("accepts an amount exactly at the minimum", async () => {
    const h = harness({ round: { minimumInvestment: "250000.000000" } });
    await expect(submit(h, { amount: "250000" })).resolves.toBeDefined();
  });
});

describe("the accreditation path", () => {
  it("is self-attested under 506(b)", async () => {
    const h = harness();
    const result = await submit(h, { offeringStatus: "506b" });
    expect(result.eligibility.path).toBe("self_attested");
    expect(result.eligibility.questionnaire).toBe(true);
    expect(result.verification).toBeUndefined();
  });

  it("is self-certified under 506(c) at or above the individual threshold", async () => {
    const h = harness();
    const result = await submit(h, { offeringStatus: "506c", amount: "200000" });
    expect(result.eligibility.path).toBe("self_certified");
    expect(result.eligibility.thresholdMet).toBe(true);
    // The safe harbour is written representations, not a document review: no verification.
    expect(result.verification).toBeUndefined();
  });

  it("needs verification under 506(c) below the threshold", async () => {
    const h = harness();
    const result = await submit(h, { offeringStatus: "506c", amount: "50000" });
    expect(result.eligibility.path).toBe("verification_required");
    expect(result.verification?.status).toBe("pending");
    expect(h.started).toHaveLength(1);
  });

  it("needs verification for an entity below the million-dollar threshold", async () => {
    const h = harness();
    const result = await submit(h, {
      offeringStatus: "506c",
      subject: "entity",
      entityName: "Lovelace Ventures LP",
      amount: "500000",
    });
    expect(result.eligibility.path).toBe("verification_required");
  });

  it("opens no verification for a member somebody has already checked", async () => {
    /*
     * §R's "already accredited" branch: re-verifying somebody the kernel already holds a
     * *verified* attestation for would ask an investor to upload a tax return the company has
     * decided it does not need. A self-certification does not count. The *path* is still stored
     * as computed — what rule applied on the day is the fact worth keeping.
     */
    const h = harness({ accredited: true, accreditationMethod: "verified:document_review" });
    const result = await submit(h, { offeringStatus: "506c", amount: "50000" });
    expect(result.eligibility.path).toBe("verification_required");
    expect(result.verification).toBeUndefined();
    expect(h.started).toEqual([]);
  });

  it("asks nothing of a non-US offering", async () => {
    const h = harness();
    const result = await submit(h, { offeringStatus: "non_us" });
    expect(result.eligibility.path).toBe("none");
    expect(result.eligibility.questionnaire).toBe(false);
    expect(h.certified).toEqual([]);
  });

  it("refuses outright in a status where the module should not be reachable", async () => {
    // Unreachable in practice — `disabledWhen` 404s every route — so the refusal exists to make
    // a gate that somehow let it through visible rather than merely broken.
    await expect(submit(harness(), { offeringStatus: "informational" })).rejects.toMatchObject({
      code: "round_not_open",
      details: { offeringStatus: "informational" },
    });
  });
});

describe("the questionnaire", () => {
  const answers: AccreditationAnswersInput = {
    categories: ["us.income"],
    section: "us",
    questionnaireVersion: 1,
  };

  it("records the answers through the kernel, never by touching core.attestation", async () => {
    const h = harness();
    await submit(h, { accreditation: answers, consent: true });
    expect(h.certified).toHaveLength(1);
    expect(h.certified[0]).toMatchObject({ membershipId: MEMBER, answers });
    // Nothing in this module writes an attestation itself (D5).
    expect(h.statements.some((x) => x.includes("attestation"))).toBe(false);
  });

  it("refuses the answers without the electronic-records consent", async () => {
    await expect(
      submit(harness(), { accreditation: answers, consent: false }),
    ).rejects.toMatchObject({ code: "validation_failed", details: { field: "consent" } });
  });

  it("records 'none of these apply' as a real answer", async () => {
    // Rule 506(b) allows up to 35 sophisticated non-accredited purchasers, so an empty
    // `categories` is the answer the count acts on — not a missing one.
    const h = harness();
    await submit(h, { accreditation: { categories: [] }, consent: true });
    expect(h.certified).toHaveLength(1);
  });

  it("lets the kernel's refusal through untranslated", async () => {
    /*
     * A workspace that has published no `accreditation` document gets
     * `accreditation_unavailable` (409) from `ModuleServices.legal` — already an `ApiError`, and
     * already the right one. Catching it here to re-wrap it would only lose the detail.
     */
    const boom = new Error("no accreditation document");
    const h = harness({
      certify: () => {
        throw boom;
      },
    });
    await expect(submit(h, { accreditation: answers, consent: true })).rejects.toBe(boom);
  });
});

describe("what a submission publishes", () => {
  it("audits with ids and the amount, and publishes the ids-only event", async () => {
    const h = harness();
    await submit(h);
    expect(auditActions(h)).toEqual(["round.interest_submitted"]);
    expect(h.audits[0]).toMatchObject({
      resourceKind: "interest_submission",
      subjectMembershipId: MEMBER,
      // An amount is allowed on an audit row — it is fenced to the workspace and the row exists
      // so somebody can prove what was recorded.
      meta: expect.objectContaining({ amount: "250000.00", currency: "USD" }),
    });
  });

  it("audits the verification request separately", async () => {
    const h = harness();
    await submit(h, { offeringStatus: "506c", amount: "50000" });
    expect(auditActions(h)).toEqual(["round.verification_requested", "round.interest_submitted"]);
  });

  it("opens a manual verification with nothing to start", async () => {
    const h = harness();
    const result = await submit(h, { offeringStatus: "506c", amount: "50000" });
    expect(result.verification?.provider).toBe("manual");
    expect(h.jobs).toEqual([]);
    expect(h.statements.some((s) => s.includes("pg_advisory_xact_lock"))).toBe(true);
  });

  it("keeps the submission when a vendor is connected: the start is a job, never a call here (E3.7)", async () => {
    const h = harness({ driver: "verifyinvestor" });
    const result = await submit(h, { offeringStatus: "506c", amount: "50000" });
    expect(result.submission.id).toBe(SUBMISSION);
    expect(result.verification?.provider).toBe("verifyinvestor");
    // Enqueued in the submission's own transaction, so it exists exactly when the row does and
    // runs only after the commit; a vendor that is down cannot fail the submission.
    expect(h.vendorCalls).toEqual([]);
    expect(h.jobs).toEqual([
      {
        name: "round.verification_start",
        data: { workspaceId: WORKSPACE, verificationId: VERIFICATION, subject: "individual" },
      },
    ]);
  });

  it("attaches the member's pending verification instead of opening a second one", async () => {
    const pending = "01920000-0000-7000-8000-0000000000c9";
    const h = harness({
      driver: "verifyinvestor",
      pending: { id: pending, provider: "verifyinvestor" },
    });
    const result = await submit(h, { offeringStatus: "506c", amount: "50000" });
    expect(result.submission.verificationId).toBe(pending);
    expect(h.jobs).toEqual([]);
    expect(auditActions(h)).toEqual(["round.interest_submitted"]);
  });
});

describe("accepting", () => {
  const accept = (h: ReturnType<typeof harness>, status: OfferingStatus = "506b") =>
    createInterestService(h.services).accept(
      { workspaceId: WORKSPACE, actorKind: "staff", membershipId: STAFF },
      SUBMISSION,
      {},
      status,
      { membershipId: STAFF },
    );

  it("creates the commitment and decides the submission", async () => {
    const h = harness();
    const result = await accept(h);
    expect(result.commitment?.amount).toBe("250000.00");
    expect(result.submission.status).toBe("accepted");
    expect(auditActions(h)).toEqual(["round.interest_accepted", "round.commitment_created"]);
  });

  it("refuses a 506(c) acceptance for an unverified investor", async () => {
    /*
     * design/04: under Rule 506(c) every purchaser must pass accreditation *before* acceptance.
     * This is the refusal that makes that true rather than aspirational.
     */
    const h = harness({
      accredited: false,
      submission: { accreditationPath: "verification_required" },
    });
    await expect(accept(h, "506c")).rejects.toMatchObject({ code: "accreditation_required" });
  });

  it("allows it once somebody has checked, and not on a self-certification alone", async () => {
    /*
     * The distinction the 506(c) flow turns on. A self-certification writes an `accredited` row
     * too — with `data.method: "self_certified"` — and treating that as verification would let
     * an investor tick a box and be accepted, which is exactly the step 506(c) adds over 506(b).
     */
    const selfCertified = harness({
      accredited: true,
      accreditationMethod: "self_certified",
      submission: { accreditationPath: "verification_required" },
    });
    await expect(accept(selfCertified, "506c")).rejects.toMatchObject({
      code: "accreditation_required",
    });
    const h = harness({
      accredited: true,
      accreditationMethod: "verified:third_party",
      submission: { accreditationPath: "verification_required" },
    });
    await expect(accept(h, "506c")).resolves.toMatchObject({ warnings: [] });
  });

  it("allows it on the minimum-investment safe harbour, with the stamp", async () => {
    const h = harness({
      accredited: false,
      submission: { accreditationPath: "self_certified", accreditationStamp: "accreditation:v1" },
    });
    await expect(accept(h, "506c")).resolves.toBeDefined();
  });

  it("refuses the safe-harbour path without the written representations", async () => {
    // A `self_certified` path with no stamp means the questionnaire was never answered, so
    // there are no representations to rely on.
    const h = harness({
      accredited: false,
      submission: { accreditationPath: "self_certified", accreditationStamp: null },
    });
    await expect(accept(h, "506c")).rejects.toMatchObject({ code: "accreditation_required" });
  });

  it("warns once 35 non-accredited purchasers have been accepted, and never blocks", async () => {
    const h = harness({ nonAccreditedCount: 35 });
    await expect(accept(h)).resolves.toMatchObject({ warnings: ["non_accredited_limit"] });
    const below = harness({ nonAccreditedCount: 34 });
    await expect(accept(below)).resolves.toMatchObject({ warnings: [] });
  });

  it("refuses a submission that is not open", async () => {
    const h = harness({ submission: { status: "declined" } });
    await expect(accept(h)).rejects.toMatchObject({ code: "conflict" });
  });

  it("answers not_found for a submission that is not there", async () => {
    const h = harness({ submission: null });
    await expect(accept(h)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("declining and withdrawing", () => {
  it("declines and audits", async () => {
    const h = harness();
    const result = await createInterestService(h.services).decline(
      { workspaceId: WORKSPACE, actorKind: "staff", membershipId: STAFF },
      SUBMISSION,
      { note: "not this round" },
      { membershipId: STAFF },
    );
    expect(result.commitment).toBeUndefined();
    expect(auditActions(h)).toEqual(["round.interest_declined"]);
  });

  it("lets a member withdraw their own submission", async () => {
    const h = harness();
    await createInterestService(h.services).withdraw(tenant, SUBMISSION, MEMBER, actor);
    expect(auditActions(h)).toEqual(["round.interest_withdrawn"]);
  });

  it("answers not_found when the submission belongs to somebody else", async () => {
    // RLS already hides other people's rows from an external actor; the check is what makes the
    // refusal a 404 rather than an accidental 500 when a *staff* caller passes an id.
    const h = harness({ submission: { membershipId: STAFF } });
    await expect(
      createInterestService(h.services).withdraw(tenant, SUBMISSION, MEMBER, actor),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
