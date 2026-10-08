import { randomUUID } from "node:crypto";
import { createWorkspace, systemContext, updateOfferingStatus } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import type { EventPayload, EventTopic } from "@fundroom/domain";
import { createMemoryESignAdapter } from "@fundroom/esign/testing";
import type { EventHandler } from "@fundroom/events";
import { provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import { ModuleEnablementRepo } from "@fundroom/module-kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import { bearer, mintTestApiKey } from "./test/api-keys.js";
import {
  type Actor,
  type ErrorBody,
  esignTestConfig,
  freshSecrets,
  harness,
  json,
  memoryCallback,
  waitFor,
} from "./test/esign-harness.js";
import { awaitMail } from "./test/sign-in-mail.js";

/*
 * The round closing workflow (E3.5 §6, ADR-0053), end to end on a real server and database with
 * the in-memory e-sign vendor standing in for Documenso:
 *
 *  - closing settings (template + prefill map) merge field by field;
 *  - send-for-signature preconditions and their error codes, the prefill the vendor receives
 *    (amount formatted in the round currency, the valuation cap from the current terms);
 *  - send → vendor completes → genuine callback → kernel sync + collect → the round mirror goes
 *    `completed`, the commitment moves soft → `signed` with `signed_at`, `round.signature_completed`
 *    once, the staff alert → (when the data room vaults it) `signed_document_id`;
 *  - outbox redelivery of every handled event is a no-op;
 *  - declined / voided → the staff `esign.envelope_attention` alert (esign.read holders only);
 *  - confirm (wired only, idempotent) → exactly one investor mail;
 *  - the investor's own card, a delegate's read-only view of their principal's, a narrow
 *    delegate's 404; the permission / 404 matrix; an API key on the key-callable read;
 *  - two concurrent sends for one commitment → exactly one envelope at the vendor;
 *  - a vendor failure releases the claim;
 *  - fix C1: a kernel `error` is recoverable — an envelope in error that is then signed signs the
 *    commitment, `completed` wins over a reordered `error`, and no re-send while it is live;
 *  - fix C2: an envelope orphaned by a failed send is attached to its released claim and audited;
 *  - fix C3: the round's template role reaches the vendor as the signer role.
 */
let pg: TestPostgres;
let env: ReturnType<typeof freshSecrets>;
let running: RunningServer;
let mailer: MemoryMailer;
const mem = createMemoryESignAdapter("documenso");
const h = harness(
  () => running,
  () => mailer,
);
const { request, member, sql, callback, signIn } = h;

let acmeId: string;
let owner: Actor;
let counsel: Actor;
let viewer: Actor;
let ada: Actor;
let bob: Actor;
let adaDelegate: Actor;
let narrowDelegate: Actor;
let roundId: string;
let callbackSecret: string;
let connectionId: string;

interface SignatureRequestBody {
  id: string;
  roundId: string;
  commitmentId: string;
  envelopeId: string | null;
  status: string;
  templateRef: string | null;
  sentAt: string;
  completedAt: string | null;
  signedDocumentId: string | null;
}

interface ClosingBody {
  roundId: string;
  currency: string;
  summary: Record<string, { count: number; amount: string } | string>;
  commitments: {
    commitmentId: string;
    investor: { membershipId: string | null; name: string | null };
    amount: string;
    status: string;
    checklist: { stage: string; documentsSent: boolean; signed: boolean; signedAt: string | null };
    signatureRequest: SignatureRequestBody | null;
    signedDocumentId: string | null;
  }[];
  tasks: unknown[];
}

interface InvestorClosingBody {
  round: { id: string; name: string } | null;
  commitments: {
    commitmentId: string;
    status: string;
    checklist: { stage: string };
    signatureRequest: { id: string; status: string } | null;
    canSign: boolean;
    signedDocumentAvailable: boolean;
    envelopeId: string | null;
  }[];
  readOnly: boolean;
}

const post = (actor: Actor, path: string, body: unknown = {}) =>
  request("acme", path, { method: "POST", cookie: actor.cookie, body: JSON.stringify(body) });

async function createCommitment(
  input: { membershipId?: string; displayName?: string; amount: string; status?: string },
  actor: Actor = owner,
): Promise<string> {
  const res = await post(actor, `/api/v1/round/rounds/${roundId}/commitments`, input);
  expect(res.status, await res.clone().text()).toBe(201);
  return (await json<{ id: string }>(res)).id;
}

const sendFor = (commitmentId: string, body: unknown = {}, actor: Actor = owner) =>
  post(actor, `/api/v1/round/commitments/${commitmentId}/signature-request`, body);

async function reasonOf(res: Response): Promise<string | undefined> {
  const body = await json<ErrorBody>(res);
  return body.error.reason ?? body.error.code;
}

async function providerRefOf(envelopeId: string): Promise<string> {
  const [row] = await sql<{ provider_ref: string | null }>(
    acmeId,
    `SELECT provider_ref FROM core.esign_envelope WHERE id = '${envelopeId}'`,
  );
  if (!row?.provider_ref) throw new Error("envelope has no provider ref");
  return row.provider_ref;
}

async function requestRow(id: string) {
  const [row] = await sql<{
    status: string;
    envelope_id: string | null;
    signed_document_id: string | null;
  }>(
    acmeId,
    `SELECT status, envelope_id, signed_document_id FROM round.signature_request WHERE id = '${id}'`,
  );
  return row;
}

async function commitmentRow(id: string) {
  const [row] = await sql<{
    status: string;
    signed_at: string | null;
    confirmed_at: string | null;
    signed_document_id: string | null;
  }>(
    acmeId,
    `SELECT status::text AS status, signed_at::text AS signed_at, confirmed_at::text AS confirmed_at,
            signed_document_id
       FROM round.commitment WHERE id = '${id}'`,
  );
  return row;
}

const count = async (query: string): Promise<number> =>
  (await sql<{ n: number }>(acmeId, `SELECT count(*)::int AS n FROM ${query}`))[0]?.n ?? 0;

const outboxCount = (topic: string, where = "true") =>
  running.container.db.withHost(async (tx) => {
    const r = await tx.execute(
      `SELECT count(*)::int AS n FROM core.outbox WHERE topic = '${topic}' AND ${where}`,
    );
    return (r.rows as { n: number }[])[0]?.n ?? 0;
  });

/** Completes at the vendor and knocks: a genuine callback, as the vendor would send it. */
async function vendorSays(envelopeId: string, event: "completed" | "declined"): Promise<void> {
  const ref = await providerRefOf(envelopeId);
  if (event === "completed") mem.vendor.complete(ref);
  else mem.vendor.decline(ref);
  const res = await callback(
    connectionId,
    memoryCallback(callbackSecret, { providerRef: ref, event }),
  );
  expect(res.status).toBe(200);
}

function roundHandler(topic: EventTopic, via: RunningServer = running): EventHandler {
  const sub = via.container.subscriptions
    .subscribersFor(topic)
    .find((x) => x.id.startsWith("round."));
  if (!sub) throw new Error(`no round subscriber for ${topic}`);
  return sub.handler;
}

/** Hands an event straight to round's subscriber the way the dispatcher does (a redelivery). */
async function redeliver<T extends EventTopic>(
  topic: T,
  payload: EventPayload<T>,
  outboxId = 1,
  via: RunningServer = running,
) {
  const ctx = systemContext(acmeId);
  await via.container.db.withTenant(ctx, (tx) =>
    roundHandler(topic, via)(
      {
        outboxId,
        topic,
        workspaceId: acmeId,
        payload,
        schemaVersion: 1,
        createdAt: new Date(),
      },
      {
        tx,
        ctx,
        job: {
          id: `test-${outboxId}`,
          name: `event.${topic}`,
          data: { outboxId },
          signal: new AbortController().signal,
        },
      },
    ),
  );
}

async function alerts(eventType: string, resourceId: string) {
  return sql<{ membership_id: string }>(
    acmeId,
    `SELECT membership_id FROM notify.notification
      WHERE event_type = '${eventType}' AND resource_id = '${resourceId}'
      ORDER BY membership_id`,
  );
}

/** An investor turned into a delegate of `principal` (what accepting a delegate invite writes). */
async function delegateOf(principal: Actor, email: string, scope: string): Promise<Actor> {
  const deps = running.container.identityDeps;
  const { userId } = await provisionUser(deps, { email, displayName: email.split("@")[0] });
  const m = await provisionMembership(deps, {
    workspaceId: acmeId,
    userId,
    kind: "external",
    role: "investor",
    source: "test",
  });
  await sql(
    acmeId,
    `UPDATE core.membership SET role = 'delegate', principal_membership_id = '${principal.membershipId}',
            delegate_scope = '${scope}'
      WHERE id = '${m.id}'`,
  );
  return { membershipId: m.id, cookie: await signIn("acme", email) };
}

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  mailer = createMemoryMailer();
  env = freshSecrets(pg.connectionString);
  running = await startServer({
    config: esignTestConfig(env, { JOBS_POLL_INTERVAL_MS: "500" }),
    logger: createLogger({ level: "error" }),
    mailer,
    esignAdapters: { documenso: mem.definition },
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
  acmeId = (await createWorkspace(running.container.db, { slug: "acme", name: "Acme" })).id;
  const ctx = systemContext(acmeId);
  await running.container.db.withTenant(ctx, async (tx) => {
    await updateOfferingStatus(tx, acmeId, "506b" as never);
    await new ModuleEnablementRepo(ctx, tx).set("round", true);
  });
  running.container.resolver.invalidate();
  running.container.enablement.invalidate(acmeId);
  owner = await member("acme", acmeId, "owner@acme.test", "staff", "owner");
  counsel = await member("acme", acmeId, "counsel@acme.test", "staff", "legal");
  viewer = await member("acme", acmeId, "viewer@acme.test", "staff", "viewer");
  ada = await member("acme", acmeId, "ada@investor.test", "external", "investor");
  bob = await member("acme", acmeId, "bob@investor.test", "external", "investor");
  adaDelegate = await delegateOf(ada, "assistant@investor.test", "all");
  narrowDelegate = await delegateOf(ada, "lawyer@investor.test", "data_room");

  // A planning round with terms; opened in the first describe.
  const created = await post(owner, "/api/v1/round/rounds", {
    name: "Seed 2026",
    stage: "seed",
    instrumentKind: "safe",
    targetAmount: "2000000",
    currency: "USD",
  });
  expect(created.status, await created.clone().text()).toBe(201);
  roundId = (await json<{ id: string }>(created)).id;
  const terms = await request("acme", `/api/v1/round/rounds/${roundId}/terms`, {
    method: "PUT",
    cookie: owner.cookie,
    body: JSON.stringify({
      terms: {
        kind: "safe",
        variant: "post_money",
        valuationCap: "10000000",
        discountPercent: "20",
      },
    }),
  });
  expect(terms.status, await terms.clone().text()).toBe(201);
}, 240_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("settings and preconditions", () => {
  it("closing settings merge field by field and read back on GET", async () => {
    const patch = (body: unknown) =>
      request("acme", "/api/v1/round/settings", {
        method: "PATCH",
        cookie: owner.cookie,
        body: JSON.stringify(body),
      });
    let res = await patch({
      closing: {
        prefill: {
          "Investor Name": "investor_name",
          "Investor Email": "investor_email",
          "Purchase Amount": "amount",
          "Valuation Cap": "valuation_cap",
          Company: "company_name",
          Round: "round_name",
          Date: "date",
        },
      },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await json<{ closing: unknown }>(res)).closing).toMatchObject({
      subscriptionTemplateRef: null,
    });
    // Unknown sources are refused.
    res = await patch({ closing: { prefill: { x: "social_security_number" } } });
    expect(res.status).toBe(400);
    const get = await json<{ closing: { prefill: Record<string, string> } }>(
      await request("acme", "/api/v1/round/settings", { cookie: owner.cookie }),
    );
    expect(Object.keys(get.closing.prefill)).toHaveLength(7);
  });

  it("refuses a planning round, then a non-soft commitment, before anything else", async () => {
    const soft = await createCommitment({ membershipId: ada.membershipId, amount: "1000" });
    const planning = await sendFor(soft);
    expect(planning.status).toBe(409);
    expect(await reasonOf(planning)).toBe("round_not_open");
    const open = await post(owner, `/api/v1/round/rounds/${roundId}/open`);
    expect(open.status, await open.clone().text()).toBe(200);
    const wired = await createCommitment({
      membershipId: bob.membershipId,
      amount: "1000",
      status: "wired",
    });
    const res = await sendFor(wired);
    expect(res.status).toBe(409);
    expect(await reasonOf(res)).toBe("commitment_not_signable");
  });

  it("409 esign_not_configured without a vendor, then subscription_template_missing", async () => {
    const soft = await createCommitment({ membershipId: ada.membershipId, amount: "1000" });
    const none = await sendFor(soft);
    expect(none.status).toBe(409);
    expect((await json<ErrorBody>(none)).error.code).toBe("esign_not_configured");

    const put = await request("acme", "/api/v1/esign/connection", {
      method: "PUT",
      cookie: owner.cookie,
      body: JSON.stringify({ driver: "documenso", credentials: { apiToken: "doc-token-5678" } }),
    });
    expect(put.status, await put.clone().text()).toBe(200);
    const saved = await json<{ connection: { id: string }; callbackSecret: string }>(put);
    connectionId = saved.connection.id;
    callbackSecret = saved.callbackSecret;

    const noTemplate = await sendFor(soft);
    expect(noTemplate.status).toBe(409);
    expect(await reasonOf(noTemplate)).toBe("subscription_template_missing");

    const set = await request("acme", "/api/v1/round/settings", {
      method: "PATCH",
      cookie: owner.cookie,
      body: JSON.stringify({ closing: { subscriptionTemplateRef: "tpl-subscription-1" } }),
    });
    const settings = await json<{ closing: { subscriptionTemplateRef: string; prefill: object } }>(
      set,
    );
    // The template-only patch kept the prefill map.
    expect(settings.closing.subscriptionTemplateRef).toBe("tpl-subscription-1");
    expect(Object.keys(settings.closing.prefill)).toHaveLength(7);
  });

  it("a commitment naming no member needs a signer (422 signer_email_missing), then sends to them", async () => {
    const paper = await createCommitment({ displayName: "Angel on paper", amount: "5000" });
    const missing = await sendFor(paper);
    expect(missing.status).toBe(422);
    expect((await json<ErrorBody>(missing)).error.code).toBe("signer_email_missing");
    const before = mem.vendor.created().length;
    const sent = await sendFor(paper, {
      signer: { name: "Angela Paper", email: "angela@paper.test" },
    });
    expect(sent.status, await sent.clone().text()).toBe(201);
    const input = mem.vendor.created()[before]?.input as {
      signers: { email: string; name: string }[];
    };
    expect(input.signers.map((s) => [s.name, s.email])).toEqual([
      ["Angela Paper", "angela@paper.test"],
    ]);
  });
});

describe("send → sign → signed (the happy path)", () => {
  let commitmentId: string;
  let sr: SignatureRequestBody;

  it("sends the template, prefilled from the commitment, the terms and the workspace", async () => {
    commitmentId = await createCommitment({
      membershipId: ada.membershipId,
      amount: "250000",
      status: "verbal",
    });
    const before = mem.vendor.created().length;
    const res = await sendFor(commitmentId, { message: "Please sign by Friday." });
    expect(res.status, await res.clone().text()).toBe(201);
    sr = await json<SignatureRequestBody>(res);
    expect(sr).toMatchObject({
      commitmentId,
      roundId,
      status: "sent",
      templateRef: "tpl-subscription-1",
    });
    expect(sr.envelopeId).not.toBeNull();
    expect(mem.vendor.created()).toHaveLength(before + 1);
    const input = mem.vendor.created()[before]?.input as {
      externalId: string;
      title: string;
      message: string;
      embedded: boolean;
      signers: { name: string; email: string }[];
      document: { kind: string; templateRef: string; prefill: Record<string, string> };
    };
    expect(input.externalId).toBe(sr.envelopeId);
    expect(input.embedded).toBe(false);
    expect(input.message).toBe("Please sign by Friday.");
    expect(input.signers.map((s) => s.email)).toEqual(["ada@investor.test"]);
    expect(input.document).toMatchObject({ kind: "template", templateRef: "tpl-subscription-1" });
    expect(input.document.prefill).toMatchObject({
      "Investor Name": "ada",
      "Investor Email": "ada@investor.test",
      "Purchase Amount": "$250,000.00",
      "Valuation Cap": "$10,000,000.00",
      Company: "Acme",
      Round: "Seed 2026",
    });
    expect(input.document.prefill["Date"]).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    const [envelope] = await sql<{ vault_folder: string; purpose: string; subject_id: string }>(
      acmeId,
      `SELECT vault_folder, purpose, subject_id FROM core.esign_envelope WHERE id = '${sr.envelopeId}'`,
    );
    expect(envelope).toEqual({
      vault_folder: "Signed documents/Seed 2026",
      purpose: "round_closing",
      subject_id: commitmentId,
    });
    expect(
      await count(
        `audit.event WHERE action = 'round.signature_requested' AND resource_id = '${sr.id}'`,
      ),
    ).toBe(1);
  });

  it("refuses a second open request for the same commitment (409 signature_request_open)", async () => {
    const res = await sendFor(commitmentId);
    expect(res.status).toBe(409);
    expect(await reasonOf(res)).toBe("signature_request_open");
  });

  it("shows documents sent to staff and 'waiting for you' to the investor", async () => {
    const staff = await json<ClosingBody>(
      await request("acme", `/api/v1/round/rounds/${roundId}/closing`, { cookie: owner.cookie }),
    );
    const row = staff.commitments.find((c) => c.commitmentId === commitmentId);
    expect(row?.checklist.stage).toBe("documents_sent");
    expect(row?.investor).toMatchObject({ membershipId: ada.membershipId, name: "ada" });
    expect(row?.signatureRequest?.id).toBe(sr.id);
    const mine = await json<InvestorClosingBody>(
      await request("acme", "/api/v1/round/current/closing", { cookie: ada.cookie }),
    );
    const card = mine.commitments.find((c) => c.commitmentId === commitmentId);
    expect(card).toMatchObject({ canSign: true, signedDocumentAvailable: false, envelopeId: null });
    expect(mine.readOnly).toBe(false);
  });

  it("vendor completes → callback → commitment signed, once, and staff are told", async () => {
    await vendorSays(sr.envelopeId as string, "completed");
    const done = await waitFor(
      "commitment signed",
      async () => {
        const c = await commitmentRow(commitmentId);
        return c?.status === "signed" && c.signed_at !== null ? c : undefined;
      },
      30_000,
    );
    expect(done.signed_at).not.toBeNull();
    expect((await requestRow(sr.id))?.status).toBe("completed");
    await waitFor(
      "envelope_completed handled",
      async () =>
        (await outboxCount(
          "esign.envelope_completed",
          `payload->>'envelopeId' = '${sr.envelopeId}'`,
        )) > 0,
      30_000,
    );
    // Staff holding round.manage (owner, counsel as `legal`) hear about it; the viewer does not.
    const told = await waitFor("signature alert", async () => {
      const a = await alerts("round.signature_completed", commitmentId);
      return a.length >= 2 ? a : undefined;
    });
    expect(told.map((a) => a.membership_id).sort()).toEqual(
      [owner.membershipId, counsel.membershipId].sort(),
    );
    expect(
      await outboxCount(
        "round.signature_completed",
        `payload->>'commitmentId' = '${commitmentId}'`,
      ),
    ).toBe(1);
  });

  it("links the vaulted signed copy (when the data room vaults it)", async () => {
    const vaults = running.container.subscriptions
      .subscribersFor("esign.envelope_completed")
      .some((s) => s.id.startsWith("data-room."));
    if (!vaults) return; // data-room vaulting (package E) not compiled in yet.
    const linked = await waitFor(
      "signed document linked",
      async () => {
        const r = await requestRow(sr.id);
        return r?.signed_document_id ?? undefined;
      },
      30_000,
    );
    expect((await commitmentRow(commitmentId))?.signed_document_id).toBe(linked);
  });

  it("the investor's card offers the signed copy; the kernel serves it to them", async () => {
    const mine = await json<InvestorClosingBody>(
      await request("acme", "/api/v1/round/current/closing", { cookie: ada.cookie }),
    );
    const card = mine.commitments.find((c) => c.commitmentId === commitmentId);
    expect(card).toMatchObject({
      status: "signed",
      canSign: false,
      signedDocumentAvailable: true,
      envelopeId: sr.envelopeId,
    });
    expect(card?.checklist.stage).toBe("signed");
    const pdf = await request("acme", `/api/v1/esign/me/envelopes/${sr.envelopeId}/signed.pdf`, {
      cookie: ada.cookie,
    });
    expect(pdf.status).toBe(200);
  });

  it("outbox redelivery of every handled event changes nothing", async () => {
    const envelopeId = sr.envelopeId as string;
    const snapshot = async () => ({
      completed: await outboxCount(
        "round.signature_completed",
        `payload->>'commitmentId' = '${commitmentId}'`,
      ),
      changed: await outboxCount(
        "round.commitment_changed",
        `payload->>'commitmentId' = '${commitmentId}'`,
      ),
      audits: await count(`audit.event WHERE resource_id IN ('${sr.id}', '${commitmentId}')`),
      request: await requestRow(sr.id),
      commitment: await commitmentRow(commitmentId),
    });
    const before = await snapshot();
    const subject = {
      purpose: "round_closing" as const,
      subjectModule: "round",
      subjectKind: "commitment",
      subjectId: commitmentId,
      membershipId: ada.membershipId,
    };
    for (const status of ["sent", "delivered", "completed"] as const)
      await redeliver("esign.envelope_changed", { envelopeId, status, ...subject });
    await redeliver("esign.envelope_completed", { envelopeId, ...subject });
    await redeliver("esign.envelope_completed", { envelopeId, ...subject });
    expect(await snapshot()).toEqual(before);
    // A vaulted event for the same envelope twice links once (first writer wins).
    const doc = before.request?.signed_document_id ?? randomUUID();
    await redeliver("document.vaulted", { documentId: doc, versionId: randomUUID(), envelopeId });
    await redeliver("document.vaulted", {
      documentId: randomUUID(),
      versionId: randomUUID(),
      envelopeId,
    });
    expect((await requestRow(sr.id))?.signed_document_id).toBe(doc);
    expect((await commitmentRow(commitmentId))?.signed_document_id).toBe(doc);
    // An envelope the round never sent (an NDA, another module's subject) is ignored.
    await redeliver("esign.envelope_changed", {
      envelopeId: randomUUID(),
      status: "completed",
      purpose: "nda",
      subjectModule: "compliance",
      subjectKind: "legal_document",
      subjectId: randomUUID(),
      membershipId: null,
    });
  });

  it("a completed signature never regresses a wired commitment nor resurrects a withdrawn one", async () => {
    for (const later of ["wired", "withdrawn"] as const) {
      const id = await createCommitment({ membershipId: bob.membershipId, amount: "700" });
      const sent = await json<SignatureRequestBody>(await sendFor(id));
      const patch = await request("acme", `/api/v1/round/commitments/${id}`, {
        method: "PATCH",
        cookie: owner.cookie,
        body: JSON.stringify({ status: later }),
      });
      expect(patch.status).toBe(200);
      await vendorSays(sent.envelopeId as string, "completed");
      await waitFor("mirror completed", async () =>
        (await requestRow(sent.id))?.status === "completed" ? true : undefined,
      );
      const c = await commitmentRow(id);
      expect(c?.status, later).toBe(later);
      expect(c?.signed_at).not.toBeNull();
    }
  });
});

describe("declined and voided → staff attention", () => {
  it("a declined agreement alerts esign.read holders (owner, counsel), not the viewer; a new one may be sent", async () => {
    const id = await createCommitment({ membershipId: bob.membershipId, amount: "3000" });
    const sent = await json<SignatureRequestBody>(await sendFor(id));
    await vendorSays(sent.envelopeId as string, "declined");
    await waitFor(
      "mirror declined",
      async () => ((await requestRow(sent.id))?.status === "declined" ? true : undefined),
      30_000,
    );
    expect((await commitmentRow(id))?.status).toBe("soft");
    const told = await waitFor("attention alert", async () => {
      const a = await alerts("esign.envelope_attention", sent.envelopeId as string);
      return a.length >= 2 ? a : undefined;
    });
    expect(told.map((a) => a.membership_id).sort()).toEqual(
      [owner.membershipId, counsel.membershipId].sort(),
    );
    // Terminal: the next send is free.
    const again = await sendFor(id);
    expect(again.status).toBe(201);
    const second = await json<SignatureRequestBody>(again);

    // Void it: the vendor is told, the mirror goes voided, staff are alerted, a second void is 409.
    const voided = await post(owner, `/api/v1/round/signature-requests/${second.id}/void`, {
      reason: "Wrong amount",
    });
    expect(voided.status, await voided.clone().text()).toBe(200);
    expect((await json<SignatureRequestBody>(voided)).status).toBe("voided");
    const twice = await post(owner, `/api/v1/round/signature-requests/${second.id}/void`, {});
    expect(twice.status).toBe(409);
    expect((await json<ErrorBody>(twice)).error.code).toBe("envelope_not_open");
    await waitFor("void alert", async () => {
      const a = await alerts("esign.envelope_attention", second.envelopeId as string);
      return a.length >= 2 ? a : undefined;
    });
    expect(
      await count(
        `audit.event WHERE action = 'round.signature_voided' AND resource_id = '${second.id}'`,
      ),
    ).toBe(1);
  });
});

describe("a kernel `error` is not the end (E3.5 fixes C1, C2)", () => {
  const subjectOf = (commitmentId: string) => ({
    purpose: "round_closing" as const,
    subjectModule: "round",
    subjectKind: "commitment",
    subjectId: commitmentId,
    membershipId: bob.membershipId,
  });

  async function kernelRow(envelopeId: string) {
    const [row] = await sql<{ status: string; error_code: string | null }>(
      acmeId,
      `SELECT status, error_code FROM core.esign_envelope WHERE id = '${envelopeId}'`,
    );
    return row;
  }

  /** The vendor refuses one status pull permanently: the kernel marks the envelope `error`. */
  async function kernelErrors(envelopeId: string): Promise<void> {
    const ref = await providerRefOf(envelopeId);
    mem.vendor.failNext(1, "unauthorized");
    const res = await callback(
      connectionId,
      memoryCallback(callbackSecret, { providerRef: ref, event: "viewed" }),
    );
    expect(res.status).toBe(200);
    await waitFor(
      "kernel error",
      async () => ((await kernelRow(envelopeId))?.status === "error" ? true : undefined),
      30_000,
    );
  }

  it("an envelope in `error` that the investor then signs still signs the commitment; no re-send meanwhile", async () => {
    const id = await createCommitment({ membershipId: bob.membershipId, amount: "5100" });
    const sent = await json<SignatureRequestBody>(await sendFor(id));
    const envelopeId = sent.envelopeId as string;
    await kernelErrors(envelopeId);
    await waitFor(
      "mirror error",
      async () => ((await requestRow(sent.id))?.status === "error" ? true : undefined),
      30_000,
    );
    // The envelope is still live at the vendor: a second agreement would be a duplicate.
    const before = mem.vendor.created().length;
    const again = await sendFor(id);
    expect(again.status).toBe(409);
    expect(await reasonOf(again)).toBe("signature_request_open");
    expect(mem.vendor.created().length).toBe(before);

    // The investor signs it anyway: callback → sync (recovers) → collect → signed.
    await vendorSays(envelopeId, "completed");
    const done = await waitFor(
      "commitment signed",
      async () => {
        const c = await commitmentRow(id);
        return c?.status === "signed" && c.signed_at !== null ? c : undefined;
      },
      30_000,
    );
    expect(done.signed_at).not.toBeNull();
    expect(await requestRow(sent.id)).toMatchObject({
      status: "completed",
      envelope_id: envelopeId,
    });
    await waitFor(
      "envelope_completed handled",
      async () =>
        (await outboxCount(
          "esign.envelope_completed",
          `payload->>'envelopeId' = '${envelopeId}'`,
        )) > 0,
      30_000,
    );
    await waitFor("signature completed published", async () =>
      (await outboxCount("round.signature_completed", `payload->>'commitmentId' = '${id}'`)) === 1
        ? true
        : undefined,
    );
    // A late / redelivered `error` or `sent` never moves a completed mirror.
    for (const status of ["error", "sent", "delivered"] as const)
      await redeliver("esign.envelope_changed", { envelopeId, status, ...subjectOf(id) });
    expect((await requestRow(sent.id))?.status).toBe("completed");
    expect(
      await outboxCount("round.signature_completed", `payload->>'commitmentId' = '${id}'`),
    ).toBe(1);
  });

  it("`error` then `completed` (a permanent collect failure, events reordered) ends signed, once; stale events stay monotonic", async () => {
    const id = await createCommitment({ membershipId: bob.membershipId, amount: "5200" });
    const sent = await json<SignatureRequestBody>(await sendFor(id));
    const envelopeId = sent.envelopeId as string;
    // The kernel row goes `error` (a failed pull) and the mirror follows.
    await sql(
      acmeId,
      `UPDATE core.esign_envelope SET status = 'error', error_code = 'unauthorized' WHERE id = '${envelopeId}'`,
    );
    await redeliver("esign.envelope_changed", { envelopeId, status: "error", ...subjectOf(id) });
    expect((await requestRow(sent.id))?.status).toBe("error");
    // A stale `sent` redelivered while the kernel is still in error does not mask the error.
    await redeliver("esign.envelope_changed", { envelopeId, status: "sent", ...subjectOf(id) }, 2);
    expect((await requestRow(sent.id))?.status).toBe("error");
    // The vendor completes; collection fails permanently: the row reads `completed` with an
    // error code, and the kernel publishes `error` — before the `completed` event is handled.
    await sql(
      acmeId,
      `UPDATE core.esign_envelope SET status = 'completed', completed_at = now(), terminal_at = now(),
              error_code = 'artifact_not_pdf' WHERE id = '${envelopeId}'`,
    );
    await redeliver("esign.envelope_changed", { envelopeId, status: "error", ...subjectOf(id) }, 3);
    await redeliver(
      "esign.envelope_changed",
      { envelopeId, status: "completed", ...subjectOf(id) },
      4,
    );
    await redeliver("esign.envelope_completed", { envelopeId, ...subjectOf(id) }, 5);
    expect((await requestRow(sent.id))?.status).toBe("completed");
    expect((await commitmentRow(id))?.status).toBe("signed");
    for (const status of ["error", "sent", "delivered", "declined"] as const)
      await redeliver("esign.envelope_changed", { envelopeId, status, ...subjectOf(id) }, 6);
    expect((await requestRow(sent.id))?.status).toBe("completed");
    expect(
      await outboxCount("round.signature_completed", `payload->>'commitmentId' = '${id}'`),
    ).toBe(1);
  });

  it("an `error` request with a live envelope is voidable; then a new one may be sent", async () => {
    const id = await createCommitment({ membershipId: bob.membershipId, amount: "5300" });
    const sent = await json<SignatureRequestBody>(await sendFor(id));
    await kernelErrors(sent.envelopeId as string);
    await waitFor(
      "mirror error",
      async () => ((await requestRow(sent.id))?.status === "error" ? true : undefined),
      30_000,
    );
    const voided = await post(owner, `/api/v1/round/signature-requests/${sent.id}/void`, {
      reason: "Vendor credentials rotated",
    });
    expect(voided.status, await voided.clone().text()).toBe(200);
    expect((await json<SignatureRequestBody>(voided)).status).toBe("voided");
    expect((await kernelRow(sent.envelopeId as string))?.status).toBe("voided");
    const again = await sendFor(id);
    expect(again.status, await again.clone().text()).toBe(201);
  });

  const releasedClaim = async (commitmentId: string, age: string) =>
    (
      await sql<{ id: string }>(
        acmeId,
        `INSERT INTO round.signature_request (workspace_id, round_id, commitment_id, status, template_ref, created_at, terminal_at)
         VALUES ('${acmeId}', '${roundId}', '${commitmentId}', 'error', 'tpl-subscription-1', now() - interval '${age}', now())
         RETURNING id`,
      )
    )[0]?.id as string;

  const kernelEnvelopeFor = (commitmentId: string) =>
    running.container.esign.request(
      { workspaceId: acmeId, actorKind: "staff", membershipId: owner.membershipId },
      {
        purpose: "round_closing",
        subject: { module: "round", kind: "commitment", id: commitmentId },
        signer: { name: "bob", email: "bob@investor.test", membershipId: bob.membershipId },
        title: "Seed 2026 — subscription agreement",
        document: { kind: "template", templateRef: "tpl-subscription-1", prefill: {} },
        embedded: false,
        requestedByMembershipId: owner.membershipId,
      },
    );

  const orphanAudits = (requestId: string) =>
    count(`audit.event WHERE action = 'round.signature_orphaned' AND resource_id = '${requestId}'`);

  it("an envelope the vendor holds for a released claim is attached to it and audited, never re-sent (C2)", async () => {
    const id = await createCommitment({ membershipId: bob.membershipId, amount: "5400" });
    // The send's request() failed after the vendor created the envelope: claim released.
    const claim = await releasedClaim(id, "1 minute");
    const sentBefore = mem.vendor.created().length;
    const envelope = await kernelEnvelopeFor(id);
    const adopted = await waitFor(
      "orphan attached",
      async () => {
        const r = await requestRow(claim);
        return r?.envelope_id === envelope.id ? r : undefined;
      },
      30_000,
    );
    // It is live at the vendor, so the mirror tracks it again — and nothing re-sent it.
    expect(adopted.status).toBe("sent");
    expect(mem.vendor.created().length).toBe(sentBefore + 1);
    expect(await orphanAudits(claim)).toBe(1);
    // A redelivery does not audit twice; a Send is refused while it is live.
    await redeliver("esign.envelope_changed", {
      envelopeId: envelope.id,
      status: "sent",
      ...subjectOf(id),
    });
    expect(await orphanAudits(claim)).toBe(1);
    const again = await sendFor(id);
    expect(again.status).toBe(409);
    expect(await reasonOf(again)).toBe("signature_request_open");
  });

  it("an orphaned draft (the kernel's second transaction failed) is attached and audited; staff decide on a re-send (C2)", async () => {
    const id = await createCommitment({ membershipId: bob.membershipId, amount: "5500" });
    const envelope = await kernelEnvelopeFor(id);
    await new Promise((r) => setTimeout(r, 1500)); // its own `sent` event found no claim
    const claim = await releasedClaim(id, "1 hour");
    // What the kernel's stale-draft sweep leaves: `error`/`orphaned_draft`, never sent, no ref.
    await sql(
      acmeId,
      `UPDATE core.esign_envelope SET status = 'error', error_code = 'orphaned_draft', provider_ref = NULL,
              sent_at = NULL WHERE id = '${envelope.id}'`,
    );
    await redeliver("esign.envelope_changed", {
      envelopeId: envelope.id,
      status: "error",
      ...subjectOf(id),
    });
    expect(await requestRow(claim)).toMatchObject({ status: "error", envelope_id: envelope.id });
    expect(await orphanAudits(claim)).toBe(1);
    // A plain refused create (never sent, not an orphan) is not attached to anything.
    const other = await createCommitment({ membershipId: bob.membershipId, amount: "5600" });
    mem.vendor.failNext(1, "rejected");
    const failed = await sendFor(other);
    expect(failed.status).toBe(502);
    expect(
      await count(
        `audit.event WHERE action = 'round.signature_request_failed' AND meta->>'commitmentId' = '${other}' AND meta->>'orphanRisk' = 'false'`,
      ),
    ).toBe(1);
    // Nothing is live that we know of: the admin may send again (their call, never ours).
    const again = await sendFor(id);
    expect(again.status, await again.clone().text()).toBe(201);
  });
});

describe("the template's signer role (E3.5 fix C3)", () => {
  const patchClosing = (closing: unknown) =>
    request("acme", "/api/v1/round/settings", {
      method: "PATCH",
      cookie: owner.cookie,
      body: JSON.stringify({ closing }),
    });

  it("defaults to Signer and is sent as the envelope's signer role once set", async () => {
    const got = await json<{ closing: { templateRole: string } }>(
      await request("acme", "/api/v1/round/settings", { cookie: owner.cookie }),
    );
    expect(got.closing.templateRole).toBe("Signer");
    const set = await patchClosing({ templateRole: " Investor " });
    expect(set.status, await set.clone().text()).toBe(200);
    const saved = await json<{
      closing: { templateRole: string; subscriptionTemplateRef: string };
    }>(set);
    expect(saved.closing).toMatchObject({
      templateRole: "Investor",
      subscriptionTemplateRef: "tpl-subscription-1",
    });
    expect((await patchClosing({ templateRole: "  " })).status).toBe(400);
    try {
      const id = await createCommitment({ membershipId: bob.membershipId, amount: "5700" });
      const before = mem.vendor.created().length;
      const res = await sendFor(id);
      expect(res.status, await res.clone().text()).toBe(201);
      const input = mem.vendor.created()[before]?.input as { signers: { role?: string }[] };
      expect(input.signers.map((s) => s.role)).toEqual(["Investor"]);
    } finally {
      expect((await patchClosing({ templateRole: "Signer" })).status).toBe(200);
    }
  });
});

describe("confirmation", () => {
  it("only a wired commitment; once; the investor gets exactly one mail", async () => {
    const id = await createCommitment({
      membershipId: ada.membershipId,
      amount: "10000",
      status: "signed",
    });
    const early = await post(owner, `/api/v1/round/commitments/${id}/confirm`);
    expect(early.status).toBe(409);
    expect(await reasonOf(early)).toBe("commitment_not_wired");
    await request("acme", `/api/v1/round/commitments/${id}`, {
      method: "PATCH",
      cookie: owner.cookie,
      body: JSON.stringify({ status: "wired" }),
    });
    const since = mailer.sent.length;
    const ok = await post(owner, `/api/v1/round/commitments/${id}/confirm`);
    expect(ok.status, await ok.clone().text()).toBe(200);
    const body = await json<{ confirmedAt: string | null; status: string }>(ok);
    expect(body.confirmedAt).not.toBeNull();
    const again = await post(owner, `/api/v1/round/commitments/${id}/confirm`);
    expect(again.status).toBe(200);
    expect((await json<{ confirmedAt: string }>(again)).confirmedAt).toBe(body.confirmedAt);
    const mail = await awaitMail(mailer, {
      to: "ada@investor.test",
      since,
      match: (m) => m.subject === "Acme confirmed your commitment",
    });
    expect(mail.text).toContain("/round");
    await new Promise((r) => setTimeout(r, 1500));
    expect(
      mailer.sent.slice(since).filter((m) => m.subject === "Acme confirmed your commitment"),
    ).toHaveLength(1);
    expect(
      await outboxCount("round.commitment_confirmed", `payload->>'commitmentId' = '${id}'`),
    ).toBe(1);
    const closing = await json<ClosingBody>(
      await request("acme", `/api/v1/round/rounds/${roundId}/closing`, { cookie: owner.cookie }),
    );
    expect(closing.commitments.find((c) => c.commitmentId === id)?.checklist.stage).toBe(
      "confirmed",
    );
    expect(closing.summary["confirmed"]).toMatchObject({ count: 1, amount: "10000.00" });
    expect(closing.summary["currency"]).toBe("USD");
  });
});

describe("who sees what", () => {
  it("investors, narrow delegates and non-managers are refused the staff routes", async () => {
    const id = await createCommitment({ membershipId: bob.membershipId, amount: "900" });
    // An investor probing the admin tree learns nothing (404).
    for (const [path, method] of [
      [`/api/v1/round/commitments/${id}/signature-request`, "POST"],
      [`/api/v1/round/commitments/${id}/confirm`, "POST"],
      [`/api/v1/round/signature-requests/${randomUUID()}/void`, "POST"],
      [`/api/v1/round/rounds/${roundId}/closing`, "GET"],
    ] as const) {
      const res = await request("acme", path, {
        method,
        cookie: bob.cookie,
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    // A staff viewer reads the checklist (round.read) and cannot send or confirm.
    const read = await request("acme", `/api/v1/round/rounds/${roundId}/closing`, {
      cookie: viewer.cookie,
    });
    expect(read.status).toBe(200);
    const send = await sendFor(id, {}, viewer);
    expect([403, 404]).toContain(send.status);
    // Unknown ids are 404.
    expect((await sendFor(randomUUID())).status).toBe(404);
    expect((await post(owner, `/api/v1/round/commitments/${randomUUID()}/confirm`)).status).toBe(
      404,
    );
    expect(
      (
        await request("acme", `/api/v1/round/rounds/${randomUUID()}/closing`, {
          cookie: owner.cookie,
        })
      ).status,
    ).toBe(404);
  });

  it("an API key holding round.read reads the closing checklist", async () => {
    const key = await mintTestApiKey(running.container.db, {
      workspaceId: acmeId,
      creatorMembershipId: owner.membershipId,
      scopes: ["round.read"],
    });
    const res = await request("acme", `/api/v1/round/rounds/${roundId}/closing`, {
      headers: bearer(key.token),
    });
    expect(res.status, await res.clone().text()).toBe(200);
  });

  it("each investor sees only their own commitments", async () => {
    const mine = await json<InvestorClosingBody>(
      await request("acme", "/api/v1/round/current/closing", { cookie: bob.cookie }),
    );
    const bobs = await sql<{ id: string }>(
      acmeId,
      `SELECT id FROM round.commitment WHERE round_id = '${roundId}' AND membership_id = '${bob.membershipId}'`,
    );
    expect(mine.commitments.map((c) => c.commitmentId).sort()).toEqual(
      bobs.map((r) => r.id).sort(),
    );
    expect(mine.round?.id).toBe(roundId);
  });

  it("a delegate (scope all) sees the principal's card read-only; a narrow delegate gets 404", async () => {
    const adas = await json<InvestorClosingBody>(
      await request("acme", "/api/v1/round/current/closing", { cookie: ada.cookie }),
    );
    const theirs = await request("acme", "/api/v1/round/current/closing", {
      cookie: adaDelegate.cookie,
    });
    expect(theirs.status, await theirs.clone().text()).toBe(200);
    const view = await json<InvestorClosingBody>(theirs);
    expect(view.readOnly).toBe(true);
    expect(view.commitments.map((c) => c.commitmentId).sort()).toEqual(
      adas.commitments.map((c) => c.commitmentId).sort(),
    );
    expect(view.commitments.length).toBeGreaterThan(0);
    for (const c of view.commitments) {
      expect(c.canSign).toBe(false);
      expect(c.signedDocumentAvailable).toBe(false);
      expect(c.envelopeId).toBeNull();
    }
    const narrow = await request("acme", "/api/v1/round/current/closing", {
      cookie: narrowDelegate.cookie,
    });
    expect(narrow.status).toBe(404);
  });
});

describe("races and failures", () => {
  it("two concurrent sends for one commitment → exactly one envelope at the vendor", async () => {
    const id = await createCommitment({ membershipId: bob.membershipId, amount: "4200" });
    const before = mem.vendor.created().length;
    const results = await Promise.all([sendFor(id), sendFor(id), sendFor(id)]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409]);
    expect(mem.vendor.created().length).toBe(before + 1);
    expect(await count(`round.signature_request WHERE commitment_id = '${id}'`)).toBe(1);
    expect(
      await count(`core.esign_envelope WHERE subject_id = '${id}' AND purpose = 'round_closing'`),
    ).toBe(1);
  });

  it("a vendor failure releases the claim: 502 now, a clean send next", async () => {
    const id = await createCommitment({ membershipId: bob.membershipId, amount: "4300" });
    mem.vendor.failNext(1, "rejected");
    const failed = await sendFor(id);
    expect(failed.status).toBe(502);
    expect((await json<ErrorBody>(failed)).error.code).toBe("esign_provider_error");
    const [row] = await sql<{ status: string }>(
      acmeId,
      `SELECT status FROM round.signature_request WHERE commitment_id = '${id}'`,
    );
    expect(row?.status).toBe("error");
    const retry = await sendFor(id);
    expect(retry.status, await retry.clone().text()).toBe(201);
  });

  /** An envelope the kernel creates for `commitmentId` as if a send had reached the vendor. */
  async function kernelEnvelopeFor(commitmentId: string) {
    return running.container.esign.request(
      { workspaceId: acmeId, actorKind: "staff", membershipId: owner.membershipId },
      {
        purpose: "round_closing",
        subject: { module: "round", kind: "commitment", id: commitmentId },
        signer: { name: "bob", email: "bob@investor.test", membershipId: bob.membershipId },
        title: "Seed 2026 — subscription agreement",
        document: { kind: "template", templateRef: "tpl-subscription-1", prefill: {} },
        embedded: false,
        requestedByMembershipId: owner.membershipId,
      },
    );
  }

  const insertClaim = async (commitmentId: string, age: string) =>
    (
      await sql<{ id: string }>(
        acmeId,
        `INSERT INTO round.signature_request (workspace_id, round_id, commitment_id, status, template_ref, created_at)
         VALUES ('${acmeId}', '${roundId}', '${commitmentId}', 'pending', 'tpl-subscription-1', now() - interval '${age}')
         RETURNING id`,
      )
    )[0]?.id as string;

  it("a crashed send (pending claim, envelope at the vendor) is healed by the envelope event", async () => {
    const id = await createCommitment({ membershipId: bob.membershipId, amount: "4400" });
    const claim = await insertClaim(id, "1 minute");
    const blocked = await sendFor(id);
    expect(blocked.status).toBe(409);
    expect(await reasonOf(blocked)).toBe("signature_request_open");
    // The vendor call happened (the kernel published `esign.envelope_changed` sent), tx2 never did.
    const envelope = await kernelEnvelopeFor(id);
    const adopted = await waitFor(
      "claim adopted",
      async () => {
        const r = await requestRow(claim);
        return r?.envelope_id === envelope.id ? r : undefined;
      },
      30_000,
    );
    expect(adopted.status).toBe("sent");
  });

  it("an envelope older than the claim is never adopted; a stale claim is expired by the next send", async () => {
    const id = await createCommitment({ membershipId: bob.membershipId, amount: "4500" });
    const old = await kernelEnvelopeFor(id);
    // Its own event found no claim and did nothing; now a newer claim appears.
    await new Promise((r) => setTimeout(r, 1500));
    const claim = await insertClaim(id, "0 seconds");
    await redeliver("esign.envelope_changed", {
      envelopeId: old.id,
      status: "sent",
      purpose: "round_closing",
      subjectModule: "round",
      subjectKind: "commitment",
      subjectId: id,
      membershipId: bob.membershipId,
    });
    expect(await requestRow(claim)).toMatchObject({ status: "pending", envelope_id: null });
    // Age the claim past the TTL: the next send expires it and goes through.
    await sql(
      acmeId,
      `UPDATE round.signature_request SET created_at = now() - interval '20 minutes' WHERE id = '${claim}'`,
    );
    const sent = await sendFor(id);
    expect(sent.status, await sent.clone().text()).toBe(201);
    expect((await requestRow(claim))?.status).toBe("error");
  });
});

describe("a one-connection pool", () => {
  it("send → mirror handlers → closing reads → confirm → void without a nested acquire", async () => {
    const single = await startServer({
      config: esignTestConfig(env, {
        DATABASE_POOL_MAX: "1",
        ROLES: "api",
        JOBS_POLL_INTERVAL_MS: "500",
      }),
      logger: createLogger({ level: "error" }),
      mailer,
      esignAdapters: { documenso: mem.definition },
      listenEnabled: false,
      migrate: false,
      announceSetup: false,
    });
    // Its own relay would legitimately serialise the only connection (E3.4).
    await single.container.relay.stop();
    try {
      const opts = { server: single };
      const run = async () => {
        const id = await createCommitment({ membershipId: bob.membershipId, amount: "6100" });
        const sent = await request("acme", `/api/v1/round/commitments/${id}/signature-request`, {
          method: "POST",
          cookie: owner.cookie,
          body: "{}",
          ...opts,
        });
        expect(sent.status, await sent.clone().text()).toBe(201);
        const sr = await json<SignatureRequestBody>(sent);
        const envelopeId = sr.envelopeId as string;
        const subject = {
          purpose: "round_closing" as const,
          subjectModule: "round",
          subjectKind: "commitment",
          subjectId: id,
          membershipId: bob.membershipId,
        };
        await redeliver(
          "esign.envelope_changed",
          { envelopeId, status: "delivered", ...subject },
          1,
          single,
        );
        await redeliver("esign.envelope_completed", { envelopeId, ...subject }, 2, single);
        await redeliver(
          "document.vaulted",
          { documentId: randomUUID(), versionId: randomUUID(), envelopeId },
          3,
          single,
        );
        for (const path of [`/api/v1/round/rounds/${roundId}/closing`, "/api/v1/round/settings"]) {
          const r = await request("acme", path, { cookie: owner.cookie, ...opts });
          expect(r.status, path).toBe(200);
        }
        for (const actor of [bob, adaDelegate]) {
          const r = await request("acme", "/api/v1/round/current/closing", {
            cookie: actor.cookie,
            ...opts,
          });
          expect(r.status).toBe(200);
        }
        await request("acme", `/api/v1/round/commitments/${id}`, {
          method: "PATCH",
          cookie: owner.cookie,
          body: JSON.stringify({ status: "wired" }),
          ...opts,
        });
        const confirm = await request("acme", `/api/v1/round/commitments/${id}/confirm`, {
          method: "POST",
          cookie: owner.cookie,
          ...opts,
        });
        expect(confirm.status).toBe(200);
        const other = await createCommitment({ membershipId: bob.membershipId, amount: "6200" });
        const second = await json<SignatureRequestBody>(
          await request("acme", `/api/v1/round/commitments/${other}/signature-request`, {
            method: "POST",
            cookie: owner.cookie,
            body: "{}",
            ...opts,
          }),
        );
        const voided = await request("acme", `/api/v1/round/signature-requests/${second.id}/void`, {
          method: "POST",
          cookie: owner.cookie,
          body: "{}",
          ...opts,
        });
        expect(voided.status, await voided.clone().text()).toBe(200);
        return true;
      };
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("pool deadlock: timed out")), 45_000),
      );
      expect(await Promise.race([run(), timeout])).toBe(true);
    } finally {
      await single.stop();
    }
  }, 90_000);
});
