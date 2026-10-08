import type { Attestation, TenantContext, Tx } from "@fundroom/db";
import { describe, expect, it } from "vitest";
import { ComplianceError, isComplianceError } from "../errors.js";
import type { AcceptanceService, AcceptInput, AcceptResult } from "./acceptances.js";
import {
  type AccreditationStore,
  type AttestationStore,
  createAccreditationVerificationService,
} from "./accreditation-verification.js";

/*
 * The accreditation half of `LegalServices` (E2.5 D5), against fakes.
 *
 * Everything asserted here is a rule about an evidence record that outlives the offering by six
 * years: which document a self-certification is bound to, that a verification with nothing behind
 * it is refused, and that the two provenances stay distinguishable. None of it needs Postgres,
 * and a rule that needed Postgres to be checked would be a rule nobody checked.
 */

const NOW = new Date("2026-09-22T10:00:00.000Z");
const CTX = { workspaceId: "01920000-0000-7000-8000-0000000000w0" } as unknown as TenantContext;
const TX = {} as Tx;
const MEMBER = "01920000-0000-7000-8000-0000000000m1";
const STAFF = "01920000-0000-7000-8000-0000000000s1";
const DOC = "01920000-0000-7000-8000-0000000000d1";
const ACTOR = { membershipId: STAFF, requestId: "req-1", sessionId: "sess-1" };
const YEAR_OUT = new Date("2027-09-22T10:00:00.000Z");

function attestation(over: Partial<Attestation> = {}): Attestation {
  return {
    id: "01920000-0000-7000-8000-0000000000a1",
    expiresAt: YEAR_OUT,
    data: {},
    ...over,
  } as Attestation;
}

interface Recorded {
  readonly membershipId: string;
  readonly kind: string;
  readonly signedAt: Date;
  readonly expiresAt?: Date | undefined;
  readonly data: Readonly<Record<string, unknown>>;
  readonly evidenceRef?: string | undefined;
}

/** One fake store plus the calls it saw, so an assertion can read what would have been written. */
function fakes(
  options: {
    readonly held?: { readonly expiresAt: Date | null; readonly data: unknown } | undefined;
    /** `null` = the workspace has published no accreditation document. */
    readonly document?: { documentId: string; versionNo: number } | null | undefined;
    readonly accept?: ((input: AcceptInput) => AcceptResult) | undefined;
  } = {},
) {
  const recorded: Recorded[] = [];
  const accepted: AcceptInput[] = [];
  const exposures: { membershipId: string; at: Date }[] = [];
  const attestations: AttestationStore = {
    current: async () => await Promise.resolve(options.held),
    record: async (values) => {
      recorded.push(values);
      return await Promise.resolve({ id: `att-${recorded.length}` });
    },
  };
  const store: AccreditationStore = {
    attestations: () => attestations,
    publishedAccreditationDocument: async () =>
      await Promise.resolve(
        options.document === null
          ? undefined
          : (options.document ?? { documentId: DOC, versionNo: 3 }),
      ),
    noteExposure: async (_tx, _ctx, membershipId, at) => {
      exposures.push({ membershipId, at });
      await Promise.resolve();
    },
  };
  const acceptances = {
    accept: async (_ctx, _tx, input) => {
      accepted.push(input);
      return await Promise.resolve(
        options.accept?.(input) ?? {
          attestation: attestation(),
          stamp: "accreditation-self-certification:v3",
          recorded: true,
          accreditation: attestation({ expiresAt: YEAR_OUT }),
        },
      );
    },
    pendingFor: async () => await Promise.resolve([]),
    resourcePendingFor: async () => await Promise.resolve([]),
    isPendingFor: async () => await Promise.resolve(false),
    register: async () => await Promise.resolve([]),
    registerPage: async () => await Promise.resolve({ entries: [], nextCursor: undefined }),
  } satisfies AcceptanceService;
  const service = createAccreditationVerificationService(
    { db: {} as never, audit: {} as never, now: () => NOW },
    { acceptances, store },
  );
  return { service, recorded, accepted, exposures };
}

describe("accreditation()", () => {
  it("answers false rather than throwing when nobody has certified", async () => {
    const { service } = fakes({ held: undefined });
    // Every offering-aware screen asks this and none of them can act on an exception.
    expect(await service.accreditation(TX, CTX, MEMBER)).toEqual({ accredited: false });
  });

  it("reports the live row's expiry, method and the acceptance it came from", async () => {
    const { service } = fakes({
      held: {
        expiresAt: YEAR_OUT,
        data: { method: "self_certified", slug: "accreditation-self-certification", versionNo: 3 },
      },
    });
    expect(await service.accreditation(TX, CTX, MEMBER)).toEqual({
      accredited: true,
      expiresAt: YEAR_OUT,
      method: "self_certified",
      stamp: "accreditation-self-certification:v3",
    });
  });

  it("omits the stamp for a verified row, because nothing was agreed to", async () => {
    const { service } = fakes({
      held: { expiresAt: null, data: { method: "verified:document_review" } },
    });
    const out = await service.accreditation(TX, CTX, MEMBER);
    expect(out).toEqual({ accredited: true, method: "verified:document_review" });
    expect(out.stamp).toBeUndefined();
  });

  it("survives a row whose data is null or shaped unexpectedly", async () => {
    const { service } = fakes({ held: { expiresAt: null, data: null } });
    expect(await service.accreditation(TX, CTX, MEMBER)).toEqual({ accredited: true });
    const odd = fakes({ held: { expiresAt: null, data: { method: 7, slug: "x" } } });
    expect(await odd.service.accreditation(TX, CTX, MEMBER)).toEqual({ accredited: true });
  });
});

describe("certifyAccreditation()", () => {
  it("binds the acceptance to the workspace's published questionnaire, not to a slug", async () => {
    const { service, accepted } = fakes();
    const out = await service.certifyAccreditation(TX, CTX, {
      membershipId: MEMBER,
      answers: { categories: ["us.income"], section: "us" },
      evidence: { uaFamily: "chrome" },
      actor: ACTOR,
    });
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({
      membershipId: MEMBER,
      documentId: DOC,
      versionNo: 3,
      accreditation: { categories: ["us.income"], section: "us" },
      actor: { membershipId: STAFF, requestId: "req-1", sessionId: "sess-1" },
      evidence: { uaFamily: "chrome" },
    });
    expect(out).toEqual({
      stamp: "accreditation-self-certification:v3",
      accredited: true,
      expiresAt: YEAR_OUT,
      nonAccredited: false,
    });
  });

  it("reports no category as a real answer, not as a failure", async () => {
    const { service } = fakes();
    // "None of these apply" is what a 506(b) purchaser says, and the >35 count acts on it.
    const out = await service.certifyAccreditation(TX, CTX, {
      membershipId: MEMBER,
      answers: { categories: [], note: "I have been investing for fifteen years." },
      actor: ACTOR,
    });
    expect(out.nonAccredited).toBe(true);
  });

  it("refuses when the workspace has published no accreditation document", async () => {
    const { service, accepted } = fakes({ document: null });
    const error = await service
      .certifyAccreditation(TX, CTX, {
        membershipId: MEMBER,
        answers: { categories: ["us.income"] },
        actor: ACTOR,
      })
      .catch((e: unknown) => e);
    expect(isComplianceError(error)).toBe(true);
    expect((error as ComplianceError).code).toBe("accreditation_document_missing");
    // Nothing was written: a self-certification with no text behind it is evidence of nothing.
    expect(accepted).toEqual([]);
  });

  it("refuses malformed answers rather than recording an empty certification", async () => {
    const { service, accepted } = fakes();
    await expect(
      service.certifyAccreditation(TX, CTX, {
        membershipId: MEMBER,
        answers: { categories: ["Not A Category Id"] },
        actor: ACTOR,
      }),
    ).rejects.toThrow(ComplianceError);
    expect(accepted).toEqual([]);
  });

  it("reads back the standing row when the version was already accepted", async () => {
    // A double-click or a second interest submission in the same year: `accept` is idempotent and
    // returns no accreditation row, but the member *is* accredited and the form must not say no.
    const { service } = fakes({
      held: { expiresAt: YEAR_OUT, data: { method: "self_certified" } },
      accept: () => ({
        attestation: attestation(),
        stamp: "accreditation-self-certification:v3",
        recorded: false,
      }),
    });
    expect(
      await service.certifyAccreditation(TX, CTX, {
        membershipId: MEMBER,
        answers: { categories: ["us.net_worth"] },
        actor: ACTOR,
      }),
    ).toEqual({
      stamp: "accreditation-self-certification:v3",
      accredited: true,
      expiresAt: YEAR_OUT,
      nonAccredited: false,
    });
  });

  it("does not invent an actor's request or session id", async () => {
    const { service, accepted } = fakes();
    await service.certifyAccreditation(TX, CTX, {
      membershipId: MEMBER,
      answers: { categories: [] },
      actor: { membershipId: MEMBER },
    });
    expect(accepted[0]?.actor).toEqual({ membershipId: MEMBER });
  });
});

describe("recordVerifiedAccreditation()", () => {
  it("writes one dated row whose method says the issuer checked", async () => {
    const { service, recorded } = fakes();
    const out = await service.recordVerifiedAccreditation(TX, CTX, {
      membershipId: MEMBER,
      method: "document_review",
      evidenceRef: "round/verification/ws/v1",
      expiresAt: YEAR_OUT,
      actor: ACTOR,
    });
    expect(out.attestationId).toBe("att-1");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      membershipId: MEMBER,
      kind: "accredited",
      signedAt: NOW,
      expiresAt: YEAR_OUT,
      evidenceRef: "round/verification/ws/v1",
    });
    // The `verified:` prefix is the whole point: the register's first question is whether the
    // issuer took steps of its own or took the investor's word.
    expect(recorded[0]?.data).toMatchObject({
      method: "verified:document_review",
      evidenceRef: "round/verification/ws/v1",
      questionnaireVersion: 1,
      decidedBy: STAFF,
      decidedAt: NOW.toISOString(),
    });
  });

  it("refuses a verification with no evidence behind it (design/04 §1.6)", async () => {
    const { service, recorded } = fakes();
    for (const bad of [
      { method: "", evidenceRef: "ref" },
      { method: "third_party", evidenceRef: "   " },
    ]) {
      await expect(
        service.recordVerifiedAccreditation(TX, CTX, {
          membershipId: MEMBER,
          expiresAt: YEAR_OUT,
          actor: ACTOR,
          ...bad,
        }),
      ).rejects.toThrow(ComplianceError);
    }
    // A row asserting reasonable steps with nothing behind it is worse than no row at all.
    expect(recorded).toEqual([]);
  });

  it("writes no click-wrap row: nothing was agreed to", async () => {
    const { service, recorded, accepted } = fakes();
    await service.recordVerifiedAccreditation(TX, CTX, {
      membershipId: MEMBER,
      method: "professional_letter",
      evidenceRef: "ref",
      expiresAt: YEAR_OUT,
      questionnaireVersion: 2,
      actor: ACTOR,
    });
    expect(accepted).toEqual([]);
    expect(recorded.map((r) => r.kind)).toEqual(["accredited"]);
    expect(recorded[0]?.data).toMatchObject({ questionnaireVersion: 2 });
  });
});

describe("recordVerifiedAccreditation() by a provider (E3.7)", () => {
  it("names the vendor and no person: decidedBy null, provider set, method prefixed", async () => {
    const { service, recorded } = fakes();
    await service.recordVerifiedAccreditation(TX, CTX, {
      membershipId: MEMBER,
      method: "third_party",
      evidenceRef: "vendor:verifyinvestor:vr:42",
      expiresAt: YEAR_OUT,
      actor: { provider: "verifyinvestor" },
    });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.data).toMatchObject({
      method: "verified:third_party",
      decidedBy: null,
      provider: "verifyinvestor",
      evidenceRef: "vendor:verifyinvestor:vr:42",
    });
    expect(recorded[0]?.data).not.toHaveProperty("requestId");
  });

  it("a staff decision carries no provider key", async () => {
    const { service, recorded } = fakes();
    await service.recordVerifiedAccreditation(TX, CTX, {
      membershipId: MEMBER,
      method: "document_review",
      evidenceRef: "ref",
      expiresAt: YEAR_OUT,
      actor: ACTOR,
    });
    expect(recorded[0]?.data).not.toHaveProperty("provider");
    expect(recorded[0]?.data).toMatchObject({ decidedBy: STAFF });
  });

  it("refuses an unknown provider or an actor that names nobody (untyped callers)", async () => {
    const { service, recorded } = fakes();
    for (const actor of [
      { provider: "acme-bureau" },
      { provider: "" },
      { membershipId: " " },
      {},
    ]) {
      await expect(
        service.recordVerifiedAccreditation(TX, CTX, {
          membershipId: MEMBER,
          method: "third_party",
          evidenceRef: "ref",
          expiresAt: YEAR_OUT,
          actor: actor as never,
        }),
      ).rejects.toThrow(ComplianceError);
    }
    expect(recorded).toEqual([]);
  });
});

describe("noteExposure()", () => {
  it("stamps the service's clock, so a retried render is not a second timestamp", async () => {
    const { service, exposures } = fakes();
    await service.noteExposure(TX, CTX, MEMBER);
    await service.noteExposure(TX, CTX, MEMBER);
    // Idempotence itself lives in the repository's `IS NULL` predicate; what is asserted here is
    // that this passes the injected clock rather than reaching for `new Date()` of its own.
    expect(exposures).toEqual([
      { membershipId: MEMBER, at: NOW },
      { membershipId: MEMBER, at: NOW },
    ]);
  });
});
