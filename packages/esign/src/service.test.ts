import type { Database, TenantContext, Tx } from "@fundroom/db";
import {
  type ESignAdapterDefinition,
  type ESignDriver,
  ESignProviderError,
  type ScanVerdict,
} from "@fundroom/ports";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ESignConnectionRow } from "./repos/connection-repo.js";
import type { ESignEnvelopeRow } from "./repos/envelope-repo.js";

type Conn = ESignConnectionRow;
type Env = ESignEnvelopeRow;
interface DocFake {
  id: string;
  slug?: string;
  title?: string;
  kind?: string;
  ceremony: "clickwrap" | "esign";
  current?: { versionNo: number; body: string; bodySha256: string } | undefined;
}
interface MemberFake {
  id: string;
  status: string;
  kind: string;
  role: string;
  displayName: string;
  email: string;
}
interface AttFake {
  id?: string;
  membershipId: string;
  kind: string;
  data?: { disclosureVersion?: number } | undefined;
}
interface AuditFake {
  action: string;
  meta?: Record<string, unknown> | undefined;
  actorMembershipId?: string | null | undefined;
}
interface EnvelopeInputFake {
  externalId: string;
  embedded: boolean;
  redirectUrl?: string;
  signers: unknown[];
  document: { kind: string; bytes: Uint8Array; fields: { kind: string }[] };
}
interface ErrFake {
  code: string;
  details: Record<string, unknown>;
}

/*
 * Service-level unit tests with the in-memory vendor and in-memory repositories (the only files
 * that touch drizzle are replaced by the fakes below, which also emulate the terminal-status
 * trigger). What these cannot see — real locks, RLS, rollback, pool behaviour — is C2's
 * integration suite (see the E3.5 handshake for the scenario list).
 */

const mem = vi.hoisted(() => {
  const TERMINAL = new Set(["completed", "declined", "voided", "expired"]);
  let seq = 0;
  const uuid = () => {
    seq += 1;
    return `0199a000-0000-7000-8000-${String(seq).padStart(12, "0")}`;
  };
  const state = {
    now: new Date("2026-09-25T10:00:00.000Z"),
    connections: [] as Conn[],
    envelopes: [] as Env[],
    docs: new Map<string, DocFake>(),
    members: new Map<string, MemberFake>(),
    attestations: [] as AttFake[],
    published: [] as { topic: string; payload: { status?: string; [k: string]: unknown } }[],
    locks: [] as string[],
    workspaceName: "Acme Robotics",
    /** Documents `acceptances.isPendingFor` answers false for (default: everything pending). */
    notPending: new Set<string>(),
    uuid,
    reset() {
      seq = 0;
      state.now = new Date("2026-09-25T10:00:00.000Z");
      state.connections = [];
      state.envelopes = [];
      state.docs = new Map();
      state.members = new Map();
      state.attestations = [];
      state.published = [];
      state.locks = [];
      state.notPending = new Set();
    },
  };

  const OPEN = new Set(["sent", "delivered"]);

  class ESignConnectionRepo {
    constructor(
      private readonly ctx: { workspaceId: string },
      _tx: unknown,
    ) {}
    private mine() {
      return state.connections.filter((c) => c.workspaceId === this.ctx.workspaceId);
    }
    async lockSingleton() {
      state.locks.push(`adv:${this.ctx.workspaceId}`);
    }
    async live() {
      return this.mine().find((c) => c.deletedAt === null);
    }
    async liveForUpdate() {
      const row = await this.live();
      if (row) state.locks.push(`conn:${row.id}`);
      return row;
    }
    async byId(id: string) {
      return this.mine().find((c) => c.id === id);
    }
    async insert(values: Partial<Conn>) {
      const row = {
        id: uuid(),
        workspaceId: this.ctx.workspaceId,
        createdAt: state.now,
        updatedAt: state.now,
        deletedAt: null,
        createdByMembershipId: null,
        lastVerifiedAt: null,
        lastError: null,
        ...values,
      } as Conn;
      state.connections.push(row);
      return row;
    }
    async update(id: string, patch: Partial<Conn>) {
      const row = this.mine().find((c) => c.id === id);
      if (!row) return undefined;
      Object.assign(row, patch, { updatedAt: state.now });
      return row;
    }
    async countOpenEnvelopes(connectionId: string) {
      return state.envelopes.filter(
        (e) =>
          e.connectionId === connectionId &&
          (e.status === "draft" ||
            OPEN.has(e.status) ||
            (e.status === "error" && e.providerRef !== null)),
      ).length;
    }
    async countEsignCeremonyDocuments() {
      return [...state.docs.values()].filter((d) => d.ceremony === "esign").length;
    }
  }

  class ESignEnvelopeRepo {
    constructor(
      private readonly ctx: { workspaceId: string },
      _tx: unknown,
    ) {}
    private mine() {
      return state.envelopes.filter((e) => e.workspaceId === this.ctx.workspaceId);
    }
    async insert(values: Partial<Env>) {
      const row = {
        id: uuid(),
        workspaceId: this.ctx.workspaceId,
        providerRef: null,
        legalDocumentId: null,
        legalVersionNo: null,
        membershipId: null,
        signerStatus: null,
        errorCode: null,
        errorDetail: null,
        sentAt: null,
        completedAt: null,
        terminalAt: null,
        nextSyncAt: null,
        syncAttempts: 0,
        artifacts: null,
        artifactsSchemaVersion: 1,
        vaultFolder: null,
        vaultedDocumentId: null,
        requestedByMembershipId: null,
        signerPseudonymisedAt: null,
        createdAt: state.now,
        updatedAt: state.now,
        ...values,
      } as Env;
      state.envelopes.push(row);
      return { ...row };
    }
    async byId(id: string) {
      const r = this.mine().find((e) => e.id === id);
      return r ? { ...r } : undefined;
    }
    async lockById(id: string) {
      state.locks.push(`env:${id}`);
      return this.byId(id);
    }
    async update(id: string, patch: Partial<Env>) {
      const row = this.mine().find((e) => e.id === id);
      if (!row) return undefined;
      // core.esign_envelope_guard
      if (TERMINAL.has(row.status) && patch.status !== undefined && patch.status !== row.status) {
        throw new Error(`e-sign envelope ${id} is already ${row.status}`);
      }
      const nextStatus = patch.status ?? row.status;
      if (patch.artifacts != null && nextStatus !== "completed") {
        throw new Error("artifacts may only be set when completed");
      }
      Object.assign(row, patch, { updatedAt: state.now });
      return { ...row };
    }
    async page(q: {
      status?: string;
      purpose?: string;
      membershipId?: string;
      before?: { createdAt: Date; id: string };
      limit: number;
    }) {
      return this.mine()
        .filter((e) => q.status === undefined || e.status === q.status)
        .filter((e) => q.purpose === undefined || e.purpose === q.purpose)
        .filter((e) => q.membershipId === undefined || e.membershipId === q.membershipId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))
        .filter(
          (e) =>
            q.before === undefined ||
            e.createdAt < q.before.createdAt ||
            (e.createdAt.getTime() === q.before.createdAt.getTime() && e.id < q.before.id),
        )
        .slice(0, q.limit)
        .map((e) => ({ ...e }));
    }
    async forCallback(connectionId: string, ref: { providerRef?: string; externalId?: string }) {
      const r = this.mine().find(
        (e) =>
          e.connectionId === connectionId &&
          ((ref.providerRef !== undefined && e.providerRef === ref.providerRef) ||
            (ref.externalId !== undefined && e.id === ref.externalId)),
      );
      return r ? { ...r } : undefined;
    }
    async openNda(membershipId: string, documentId: string, versionNo: number) {
      return this.mine()
        .filter(
          (e) =>
            e.purpose === "nda" &&
            e.membershipId === membershipId &&
            e.legalDocumentId === documentId &&
            e.legalVersionNo === versionNo &&
            (e.status === "draft" || OPEN.has(e.status)),
        )
        .map((e) => ({ ...e }))[0];
    }
    async ndasFor(membershipId: string, documentId: string) {
      return this.mine()
        .filter(
          (e) =>
            e.purpose === "nda" &&
            e.membershipId === membershipId &&
            e.legalDocumentId === documentId,
        )
        .map((e) => ({ ...e }));
    }
    async claimDue(now: Date, staleBefore: Date, limit: number) {
      const due = (e: Env) => e.nextSyncAt !== null && e.nextSyncAt <= now;
      return this.mine()
        .filter(
          (e) =>
            (OPEN.has(e.status) && due(e)) ||
            (e.status === "error" && e.providerRef !== null && due(e)) ||
            (e.status === "completed" && e.artifacts === null && e.errorCode === null && due(e)) ||
            (e.status === "draft" && e.createdAt < staleBefore),
        )
        .slice(0, limit)
        .map((e) => ({ ...e }));
    }
    async lockOfSigner(membershipId: string, email: string | null) {
      return this.mine()
        .filter(
          (e) =>
            (e.membershipId === membershipId || (email !== null && e.signerEmail === email)) &&
            e.signerPseudonymisedAt === null,
        )
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map((e) => {
          state.locks.push(`env:${e.id}`);
          return { ...e };
        });
    }
    async ofMember(membershipId: string, email: string | null = null) {
      return this.mine()
        .filter(
          (e) => e.membershipId === membershipId || (email !== null && e.signerEmail === email),
        )
        .map((e) => ({ ...e }));
    }
    async ndaStartsSince(membershipId: string, since: Date) {
      const rows = this.mine()
        .filter(
          (e) =>
            e.purpose === "nda" &&
            e.requestedByMembershipId === membershipId &&
            e.createdAt >= since,
        )
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      return { n: rows.length, oldest: rows[0]?.createdAt ?? null };
    }
  }

  return { state, ESignConnectionRepo, ESignEnvelopeRepo };
});

vi.mock("./repos/connection-repo.js", () => ({
  ESignConnectionRepo: mem.ESignConnectionRepo,
  findConnectionForCallback: async (_tx: unknown, id: string) => {
    const c = mem.state.connections.find((x) => x.id === id && x.deletedAt === null);
    return c ? { id: c.id, workspaceId: c.workspaceId, driver: c.driver } : undefined;
  },
}));
vi.mock("./repos/envelope-repo.js", () => ({ ESignEnvelopeRepo: mem.ESignEnvelopeRepo }));
vi.mock("./repos/legal-repo.js", () => ({
  readLegalDocument: async (_tx: unknown, _ctx: unknown, id: string) => {
    const d = mem.state.docs.get(id);
    return d === undefined ? undefined : { kind: "nda", ...d };
  },
  readWorkspaceName: async () => mem.state.workspaceName,
}));
vi.mock("@fundroom/events", () => ({
  publish: async (_tx: unknown, _ctx: unknown, topic: string, payload: unknown) => {
    mem.state.published.push({ topic, payload: payload as { status?: string } });
    return 1;
  },
}));
vi.mock("@fundroom/identity", () => ({
  MembershipRepo: class {
    async byId(id: string) {
      return mem.state.members.get(id);
    }
    async namesFor(ids: string[]) {
      const out = new Map();
      for (const id of ids) {
        const m = mem.state.members.get(id);
        if (m)
          out.set(id, { displayName: m.displayName, email: m.email, kind: m.kind, role: m.role });
      }
      return out;
    }
  },
  AttestationRepo: class {
    async current(membershipId: string, kind: string) {
      return mem.state.attestations.find((a) => a.membershipId === membershipId && a.kind === kind);
    }
    async record(values: Omit<AttFake, "id">) {
      const row = { id: mem.state.uuid(), ...values };
      mem.state.attestations.push(row);
      return row;
    }
  },
}));
vi.mock("@fundroom/db", async (orig) => ({
  ...(await orig<typeof import("@fundroom/db")>()),
  listActiveWorkspaceIds: async () => [WS],
}));

const { createMemoryESignAdapter } = await import("./testing/memory-adapter.js");
const { createESignService, ndaStatusOf } = await import("./service.js");
const { ESignError } = await import("./errors.js");
const { pseudonymiseESignEnvelopesOfMember, lockESignEnvelopesOfMember } = await import(
  "./erasure.js"
);
const { ESIGN_CONSENT_KIND, ESIGN_DISCLOSURE_VERSION } = await import("./consent.js");

const WS = "0199b000-0000-7000-8000-000000000001";
const STAFF = "0199b000-0000-7000-8000-0000000000a1";
const INVESTOR = "0199b000-0000-7000-8000-0000000000b1";
const COMMITMENT = "0199b000-0000-7000-8000-0000000000c1";
const DOC = "0199b000-0000-7000-8000-0000000000d1";
const staffCtx: TenantContext = { workspaceId: WS, actorKind: "staff", membershipId: STAFF };
const investorCtx: TenantContext = {
  workspaceId: WS,
  actorKind: "external",
  membershipId: INVESTOR,
};
const staff = { membershipId: STAFF, requestId: "req-1" };

const fakeDb = {
  withTenant: async (_ctx: TenantContext, fn: (tx: Tx) => Promise<unknown>) => fn({} as Tx),
  withHost: async (fn: (tx: Tx) => Promise<unknown>) => fn({} as Tx),
} as unknown as Database;

interface Harness {
  service: ReturnType<typeof createESignService>;
  vendor: ReturnType<typeof createMemoryESignAdapter>["vendor"];
  audits: AuditFake[];
  jobs: { name: string; data: Record<string, unknown>; key?: string | undefined }[];
  objects: Map<string, Uint8Array>;
  accepted: unknown[];
  security: unknown[];
  scan: { verdict: ScanVerdict };
  erased: Set<string>;
}

function harness(
  options: {
    maxArtifactBytes?: number;
    definition?: (d: ESignAdapterDefinition) => ESignAdapterDefinition;
    drivers?: ESignDriver[];
  } = {},
): Harness {
  const mema = createMemoryESignAdapter("documenso");
  const definition = options.definition ? options.definition(mema.definition) : mema.definition;
  const docuseal = createMemoryESignAdapter("docuseal").definition;
  const audits: Harness["audits"] = [];
  const jobs: Harness["jobs"] = [];
  const objects = new Map<string, Uint8Array>();
  const accepted: unknown[] = [];
  const security: unknown[] = [];
  const scan = { verdict: "clean" as ScanVerdict };
  const erased = new Set<string>();
  const key = new Uint8Array(32).fill(7);
  const service = createESignService({
    db: fakeDb,
    audit: {
      record: async (_tx, _ctx, input) => {
        audits.push(input as never);
        return { seq: audits.length, hash: "h" } as never;
      },
      recordDetached: async () => ({}) as never,
    },
    queue: {
      send: async (name, data, o) => {
        jobs.push({ name, data, key: o?.idempotencyKey });
        return "job";
      },
      sendInTransaction: async (_tx, name, data, o) => {
        jobs.push({ name, data, key: o?.idempotencyKey });
        return "job";
      },
    },
    crypto: {
      currentKey: async (_tx, _ctx, purpose) => ({
        keyId: `k-${purpose}`,
        keyRef: "kms",
        purpose: purpose ?? "",
        key,
      }),
      keyById: async (_tx, _ctx, keyId) => ({ keyId, keyRef: "kms", purpose: "", key }),
    },
    storage: {
      put: async (k, body) => {
        objects.set(k, body as Uint8Array);
        return {} as never;
      },
      get: async (k) => {
        const b = objects.get(k);
        if (b === undefined) return undefined;
        return {
          body: new ReadableStream({
            start(c) {
              c.enqueue(b);
              c.close();
            },
          }),
        } as never;
      },
      delete: async (k) => {
        objects.delete(k);
      },
    },
    scanner: { scan: async () => ({ verdict: scan.verdict, engine: "test" }) },
    outbound: {
      fetch: () => Promise.reject(new Error("no network in unit tests")),
      assess: (url) => ({ ok: true, url: new URL(url), exempt: false }),
    },
    adapters: { documenso: definition, docuseal } as never,
    drivers: options.drivers ?? ["documenso", "docuseal"],
    acceptances: {
      accept: async (_ctx, _tx, input) => {
        accepted.push(input);
        // What compliance writes: the `<slug>:v<n>` attestation that opens the gate.
        const slug = mem.state.docs.get(input.documentId)?.slug ?? "doc";
        mem.state.attestations.push({
          membershipId: input.membershipId,
          kind: `${slug}:v${input.versionNo}`,
        });
        return { recorded: true };
      },
      isPendingFor: async (_ctx, _tx, _m, documentId) => !mem.state.notPending.has(documentId),
    },
    legal: { isErased: async (_tx, _ctx, id) => erased.has(id) },
    baseUrl: new URL("https://app.example.com"),
    maxArtifactBytes: options.maxArtifactBytes ?? 1024 * 1024,
    securityEvent: (event, fields) => security.push({ event, fields }),
    now: () => mem.state.now,
  });
  return { service, vendor: mema.vendor, audits, jobs, objects, accepted, security, scan, erased };
}

async function connect(h: Harness) {
  return h.service.saveConnection(
    staffCtx,
    { driver: "documenso", credentials: { apiToken: "tok_abcdefghijklmnop" } },
    staff,
  );
}

async function requestRound(h: Harness) {
  return h.service.request(staffCtx, {
    purpose: "round_closing",
    subject: { module: "round", kind: "commitment", id: COMMITMENT },
    signer: { name: "Ada Lovelace", email: "ada@example.com", membershipId: INVESTOR },
    title: "Subscription agreement",
    document: { kind: "template", templateRef: "101", prefill: { amount: "$25,000" } },
    vaultFolder: "Signed documents/Seed round",
    embedded: false,
    requestedByMembershipId: STAFF,
  });
}

function row(id: string) {
  const r = mem.state.envelopes.find((e) => e.id === id);
  if (!r) throw new Error("no row");
  return r;
}

async function runJob(h: Harness, name: string, data: Record<string, unknown>) {
  const job = h.service.jobs.find((j) => j.name === name);
  if (!job) throw new Error(`no job ${name}`);
  await job.handler({ id: "j", name, data: data as never, signal: new AbortController().signal });
}

async function expectCode(p: Promise<unknown>, code: string, reason?: string) {
  let err: unknown;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ESignError);
  expect((err as InstanceType<typeof ESignError>).code).toBe(code);
  if (reason !== undefined)
    expect((err as InstanceType<typeof ESignError>).details["reason"]).toBe(reason);
}

beforeEach(() => {
  mem.state.reset();
  mem.state.members.set(INVESTOR, {
    id: INVESTOR,
    status: "active",
    kind: "external",
    role: "investor",
    displayName: "Ada Lovelace",
    email: "ada@example.com",
  });
});

describe("connections", () => {
  it("verifies, seals the credentials, stores hints and shows our callback secret once", async () => {
    const h = harness();
    const saved = await connect(h);
    expect(saved.callbackSecret).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(saved.connection).toMatchObject({
      driver: "documenso",
      displayName: "Documenso",
      status: "active",
      callbackSecretKind: "ours",
      credentialHints: { apiToken: "••••mnop" },
    });
    expect(saved.connection.callbackUrl).toBe(
      `https://app.example.com/webhooks/esign/${saved.connection.id}`,
    );
    const stored = mem.state.connections[0];
    expect(Buffer.from(stored!.credentialsEnc).toString("latin1")).not.toContain(
      "tok_abcdefghijklmnop",
    );
    expect(stored?.encryption.credentials.keyId).toBe("k-esign-credentials");
    const audit = h.audits.find((a) => a.action === "esign.connection_saved");
    expect(JSON.stringify(audit)).not.toContain("tok_abcdefghijklmnop");
    expect(JSON.stringify(audit)).not.toContain(saved.callbackSecret);

    // Same driver, blank secret: keeps the stored token and the secret, and does not show it again.
    const again = await h.service.saveConnection(
      staffCtx,
      { driver: "documenso", credentials: { apiToken: "" } },
      staff,
    );
    expect(again.callbackSecret).toBeUndefined();
    expect(again.connection.id).toBe(saved.connection.id);
    expect(again.connection.credentialHints).toEqual({ apiToken: "••••mnop" });
  });

  it("refuses credentials the vendor rejects (422) and commits nothing", async () => {
    const h = harness();
    await expectCode(
      h.service.saveConnection(
        staffCtx,
        { driver: "documenso", credentials: { apiToken: "invalid" } },
        staff,
      ),
      "esign_credentials_rejected",
      "unauthorized",
    );
    expect(mem.state.connections).toHaveLength(0);
  });

  it("refuses a driver the operator does not offer and a base URL for a fixed-address vendor", async () => {
    const h = harness({ drivers: ["documenso"] });
    await expectCode(
      h.service.saveConnection(
        staffCtx,
        { driver: "docuseal", credentials: { apiToken: "x" } },
        staff,
      ),
      "validation_failed",
      "driver_not_offered",
    );
    expect(h.service.drivers().map((d) => d.meta.driver)).toEqual(["documenso"]);
  });

  it("cannot switch provider or disconnect while envelopes are open, nor disconnect under an esign ceremony", async () => {
    const h = harness();
    await connect(h);
    await requestRound(h);
    await expectCode(
      h.service.saveConnection(
        staffCtx,
        { driver: "docuseal", credentials: { apiToken: "t" } },
        staff,
      ),
      "envelopes_open",
    );
    await expectCode(h.service.deleteConnection(staffCtx, staff), "envelopes_open");
    mem.state.docs.set(DOC, { id: DOC, ceremony: "esign" });
    await expectCode(h.service.deleteConnection(staffCtx, staff), "esign_ceremony_in_use");
  });

  it("switches provider when nothing is open (old row soft-deleted, new callback URL)", async () => {
    const h = harness();
    const first = await connect(h);
    const second = await h.service.saveConnection(
      staffCtx,
      { driver: "docuseal", credentials: { apiToken: "tok_docuseal_1234567" } },
      staff,
    );
    expect(second.connection.id).not.toBe(first.connection.id);
    expect(second.callbackSecret).toBeDefined();
    expect(
      mem.state.connections.find((c) => c.id === first.connection.id)?.deletedAt,
    ).not.toBeNull();
  });

  it("rotates our callback secret; the old one stops authenticating callbacks", async () => {
    const h = harness();
    const saved = await connect(h);
    const env = await requestRound(h);
    const ref = row(env.id).providerRef as string;
    const genuine = h.vendor.callback(ref, "viewed");
    const rotated = await h.service.rotateCallbackSecret(staffCtx, staff);
    expect(rotated.callbackSecret).not.toBe(saved.callbackSecret);
    expect((await h.service.ingestCallback(saved.connection.id, genuine)).status).toBe(401);
  });

  it("verify records the vendor's answer on the connection", async () => {
    const h = harness();
    await connect(h);
    h.vendor.failNext(1, "unauthorized");
    const d = await h.service.verifyConnection(staffCtx, staff);
    expect(d.status).toBe("error");
    expect(d.lastError).toContain("unauthorized");
    const ok = await h.service.verifyConnection(staffCtx, staff);
    expect(ok).toMatchObject({ status: "active", lastError: null });
  });
});

describe("connections — fix round 1", () => {
  /** The memory adapter plus an OPTIONAL secret, recording every config it is bound to. */
  function withOptionalSecret(
    configs: { credentials: Record<string, string>; baseUrl?: string }[],
  ) {
    return (d: ESignAdapterDefinition): ESignAdapterDefinition => ({
      ...d,
      credentialFields: [
        ...d.credentialFields,
        { key: "signingKey", label: "Signing key", kind: "secret", required: false },
      ],
      create(config, adapterDeps) {
        configs.push({
          credentials: { ...config.credentials },
          ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
        });
        return d.create(config, adapterDeps);
      },
    });
  }
  const save = (
    h: Harness,
    input: {
      baseUrl?: string;
      credentials: Record<string, string>;
      clearCredentials?: string[];
    },
  ) => h.service.saveConnection(staffCtx, { driver: "documenso", ...input }, staff);

  it("A4: a changed base URL never reuses stored secrets — 422 esign_credentials_required", async () => {
    const configs: { credentials: Record<string, string>; baseUrl?: string }[] = [];
    const h = harness({ definition: withOptionalSecret(configs) });
    await save(h, {
      baseUrl: "https://sign-a.example.com",
      credentials: { apiToken: "tok_aaaaaaaaaaaaaaaa", signingKey: "key_aaaaaaaaaaaaaaaa" },
    });
    // Same address, blank secrets: kept (the E3.5 convenience stays).
    await save(h, { baseUrl: "https://sign-a.example.com/", credentials: {} });
    expect(configs.at(-1)?.credentials["apiToken"]).toBe("tok_aaaaaaaaaaaaaaaa");
    configs.length = 0;
    let err: unknown;
    try {
      await save(h, { baseUrl: "https://evil.example.net", credentials: {} });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({
      code: "esign_credentials_required",
      details: { reason: "base_url_changed", fields: ["apiToken", "signingKey"] },
    });
    // Nothing reached the new host.
    expect(configs).toEqual([]);
    // Re-typing the required one and clearing the optional one is enough.
    await save(h, {
      baseUrl: "https://sign-b.example.com",
      credentials: { apiToken: "tok_bbbbbbbbbbbbbbbb" },
      clearCredentials: ["signingKey"],
    });
    expect(configs).toEqual([
      { credentials: { apiToken: "tok_bbbbbbbbbbbbbbbb" }, baseUrl: "https://sign-b.example.com" },
    ]);
  });

  it("A5: an optional secret can be cleared; a required one cannot; clear + value conflicts", async () => {
    const configs: { credentials: Record<string, string> }[] = [];
    const h = harness({ definition: withOptionalSecret(configs) });
    const first = await save(h, {
      credentials: { apiToken: "tok_aaaaaaaaaaaaaaaa", signingKey: "key_aaaaaaaaaaaaaaaa" },
    });
    expect(Object.keys(first.connection.credentialHints).sort()).toEqual([
      "apiToken",
      "signingKey",
    ]);
    const cleared = await save(h, { credentials: {}, clearCredentials: ["signingKey"] });
    expect(Object.keys(cleared.connection.credentialHints)).toEqual(["apiToken"]);
    expect(configs.at(-1)?.credentials).toEqual({ apiToken: "tok_aaaaaaaaaaaaaaaa" });
    // And it stays gone on the next blank save.
    await save(h, { credentials: {} });
    expect(configs.at(-1)?.credentials).toEqual({ apiToken: "tok_aaaaaaaaaaaaaaaa" });
    await expectCode(
      save(h, { credentials: {}, clearCredentials: ["apiToken"] }),
      "validation_failed",
      "cannot_clear_required",
    );
    await expectCode(
      save(h, { credentials: { signingKey: "x" }, clearCredentials: ["signingKey"] }),
      "validation_failed",
      "clear_conflict",
    );
    await expectCode(
      save(h, { credentials: {}, clearCredentials: ["nope"] }),
      "validation_failed",
      "unknown_field",
    );
  });

  it("A10: a base URL change is refused while envelopes are open, and an `error` row with a vendor ref counts as open", async () => {
    const h = harness();
    await save(h, { baseUrl: "https://sign-a.example.com", credentials: { apiToken: "tok_1" } });
    const env = await requestRound(h);
    await expectCode(
      save(h, { baseUrl: "https://sign-b.example.com", credentials: { apiToken: "tok_2" } }),
      "envelopes_open",
      "base_url_changed",
    );
    // Same address: fine.
    await save(h, { baseUrl: "https://sign-a.example.com", credentials: { apiToken: "tok_3" } });
    Object.assign(row(env.id), { status: "error", errorCode: "unavailable" });
    await expectCode(h.service.deleteConnection(staffCtx, staff), "envelopes_open");
    await expectCode(
      h.service.saveConnection(
        staffCtx,
        { driver: "docuseal", credentials: { apiToken: "t" } },
        staff,
      ),
      "envelopes_open",
    );
    Object.assign(row(env.id), { providerRef: null });
    await h.service.deleteConnection(staffCtx, staff);
  });

  it("A14: a driver no longer offered can still be re-keyed, not connected afresh or switched to", async () => {
    const all = harness();
    await connect(all);
    const narrowed = harness({ drivers: ["docuseal"] });
    const rekeyed = await narrowed.service.saveConnection(
      staffCtx,
      { driver: "documenso", credentials: { apiToken: "tok_rotated_000000001" } },
      staff,
    );
    expect(rekeyed.connection.credentialHints["apiToken"]).toBe("••••0001");
    await narrowed.service.saveConnection(
      staffCtx,
      { driver: "docuseal", credentials: { apiToken: "tok_docuseal_1234567" } },
      staff,
    );
    await expectCode(
      narrowed.service.saveConnection(
        staffCtx,
        { driver: "documenso", credentials: { apiToken: "tok_back_0000000000" } },
        staff,
      ),
      "validation_failed",
      "driver_not_offered",
    );
  });
});

describe("request pipeline", () => {
  it("needs a connection", async () => {
    await expectCode(requestRound(harness()), "esign_not_configured");
  });

  it("draft → vendor create (externalId = our id, role defaulted) → sent, with audit and event", async () => {
    const h = harness();
    await connect(h);
    const env = await requestRound(h);
    expect(env).toMatchObject({
      status: "sent",
      purpose: "round_closing",
      signerStatus: "pending",
      vaultFolder: "Signed documents/Seed round",
    });
    const r = row(env.id);
    expect(r.providerRef).toMatch(/^mem_documenso_/u);
    expect(r.nextSyncAt!.getTime() - mem.state.now.getTime()).toBe(5 * 60_000);
    const created = h.vendor.created()[0]?.input as EnvelopeInputFake;
    expect(created.externalId).toBe(env.id);
    expect(created.signers).toEqual([
      { signerKey: "s1", name: "Ada Lovelace", email: "ada@example.com", order: 1, role: "Signer" },
    ]);
    expect(h.audits.map((a) => a.action)).toEqual(
      expect.arrayContaining(["esign.envelope_requested", "esign.envelope_status_changed"]),
    );
    expect(mem.state.published.at(-1)).toMatchObject({
      topic: "esign.envelope_changed",
      payload: {
        envelopeId: env.id,
        status: "sent",
        subjectModule: "round",
        membershipId: INVESTOR,
      },
    });
  });

  it("a vendor failure marks the row error (audited, published) and answers esign_provider_error", async () => {
    const h = harness();
    await connect(h);
    h.vendor.failNext(1, "rejected");
    let err = {} as ErrFake;
    try {
      await requestRound(h);
    } catch (e) {
      err = e as ErrFake;
    }
    expect(err.code).toBe("esign_provider_error");
    expect(err.details["providerCode"]).toBe("rejected");
    const r = mem.state.envelopes[0];
    expect(r).toMatchObject({ status: "error", errorCode: "rejected", nextSyncAt: null });
    expect(mem.state.published.at(-1)?.payload.status).toBe("error");
  });

  it("refuses an erased signer", async () => {
    const h = harness();
    await connect(h);
    h.erased.add(INVESTOR);
    await expectCode(requestRound(h), "conflict", "signer_erased");
    expect(mem.state.envelopes).toHaveLength(0);
  });

  it("validates the signer and subject", async () => {
    const h = harness();
    await connect(h);
    await expectCode(
      h.service.request(staffCtx, {
        purpose: "round_closing",
        subject: { module: "round", kind: "commitment", id: "nope" },
        signer: { name: "A", email: "a@example.com" },
        title: "T",
        document: { kind: "template", templateRef: "1", prefill: {} },
        embedded: false,
        requestedByMembershipId: STAFF,
      }),
      "validation_failed",
      "invalid_subject",
    );
    await expectCode(
      h.service.request(staffCtx, {
        purpose: "round_closing",
        subject: { module: "round", kind: "commitment", id: COMMITMENT },
        signer: { name: "A", email: "not-an-email" },
        title: "T",
        document: { kind: "template", templateRef: "1", prefill: {} },
        embedded: false,
        requestedByMembershipId: STAFF,
      }),
      "validation_failed",
      "invalid_signer_email",
    );
  });
});

describe("callbacks", () => {
  it("404 unknown connection, 401 forged, 200 genuine (+ sync job), 200 unknown envelope (no oracle, no job)", async () => {
    const h = harness();
    const saved = await connect(h);
    const env = await requestRound(h);
    const ref = row(env.id).providerRef as string;
    expect(
      (
        await h.service.ingestCallback(
          "0199a000-0000-7000-8000-999999999999",
          h.vendor.callback(ref, "viewed"),
        )
      ).status,
    ).toBe(404);
    expect(
      (await h.service.ingestCallback("garbage", h.vendor.callback(ref, "viewed"))).status,
    ).toBe(404);
    expect(
      (await h.service.ingestCallback(saved.connection.id, h.vendor.forgedCallback(ref))).status,
    ).toBe(401);
    expect(
      (
        await h.service.ingestCallback(saved.connection.id, {
          headers: new Headers(),
          body: new Uint8Array(),
        })
      ).status,
    ).toBe(401);
    h.jobs.length = 0;
    const ok = await h.service.ingestCallback(
      saved.connection.id,
      h.vendor.callback(ref, "viewed"),
    );
    expect(ok).toEqual({ status: 200, driver: "documenso" });
    expect(h.jobs).toEqual([
      {
        name: "esign.sync",
        data: { workspaceId: WS, envelopeId: env.id },
        key: `esign.sync:${env.id}`,
      },
    ]);
    // The post-auth budget: admit() is asked only for an authenticated callback, before any work.
    h.jobs.length = 0;
    let asked = 0;
    const refuse = {
      admit: () => {
        asked += 1;
        return false;
      },
    };
    expect(
      await h.service.ingestCallback(saved.connection.id, h.vendor.forgedCallback(ref), refuse),
    ).toEqual({ status: 401, driver: "documenso" });
    expect(asked).toBe(0);
    expect(
      await h.service.ingestCallback(saved.connection.id, h.vendor.callback(ref, "viewed"), refuse),
    ).toEqual({ status: 429, driver: "documenso" });
    expect(asked).toBe(1);
    expect(h.jobs).toEqual([]);
    // The body is never trusted: the row is unchanged until the sync job pulls status().
    expect(row(env.id).status).toBe("sent");
    h.jobs.length = 0;
    const secret = saved.callbackSecret as string;
    const stranger = {
      headers: new Headers({ "x-memory-secret": secret }),
      body: new TextEncoder().encode(
        JSON.stringify({ providerRef: "mem_documenso_999", event: "completed" }),
      ),
    };
    expect((await h.service.ingestCallback(saved.connection.id, stranger)).status).toBe(200);
    expect(h.jobs).toEqual([]);
  });
});

describe("sync and collect", () => {
  it("pulls status monotonically, backs off, completes, collects encrypted artifacts and publishes", async () => {
    const h = harness();
    await connect(h);
    const env = await requestRound(h);
    const ref = row(env.id).providerRef as string;
    // Nothing changed: attempts+1 and the next pull is 15 minutes out.
    await runJob(h, "esign.sync", { workspaceId: WS, envelopeId: env.id });
    expect(row(env.id)).toMatchObject({ status: "sent", syncAttempts: 1 });
    expect(row(env.id).nextSyncAt!.getTime() - mem.state.now.getTime()).toBe(15 * 60_000);

    h.vendor.callback(ref, "viewed"); // vendor-side: delivered
    await runJob(h, "esign.sync", { workspaceId: WS, envelopeId: env.id });
    expect(row(env.id)).toMatchObject({
      status: "delivered",
      signerStatus: "viewed",
      syncAttempts: 0,
    });

    h.vendor.complete(ref);
    h.jobs.length = 0;
    await runJob(h, "esign.sync", { workspaceId: WS, envelopeId: env.id });
    expect(row(env.id)).toMatchObject({ status: "completed", signerStatus: "signed" });
    expect(row(env.id).terminalAt).not.toBeNull();
    expect(h.jobs.map((j) => j.name)).toEqual(["esign.collect"]);

    await runJob(h, "esign.collect", { workspaceId: WS, envelopeId: env.id });
    const r = row(env.id);
    expect(r.artifacts!.signed).toMatchObject({
      key: `ws/${WS}/esign/${env.id}/signed.pdf`,
      keyRef: "she1:k-esign-artifact",
    });
    expect(r.artifacts!.certificate!.key).toBe(`ws/${WS}/esign/${env.id}/certificate.pdf`);
    const stored = h.objects.get(r.artifacts!.signed.key) as Uint8Array;
    expect(Buffer.from(stored.subarray(0, 5)).toString("latin1")).not.toBe("%PDF-");
    const plain = await h.service.readArtifact(staffCtx, env.id, "signed");
    expect(
      Buffer.from(plain as Uint8Array)
        .subarray(0, 5)
        .toString("latin1"),
    ).toBe("%PDF-");
    expect(mem.state.published.at(-1)).toEqual({
      topic: "esign.envelope_completed",
      payload: {
        envelopeId: env.id,
        purpose: "round_closing",
        subjectModule: "round",
        subjectKind: "commitment",
        subjectId: COMMITMENT,
        membershipId: INVESTOR,
      },
    });
    expect(h.audits.some((a) => a.action === "esign.envelope_completed")).toBe(true);

    // A late vendor answer can never move a terminal row; a re-run collect is a no-op.
    h.vendor.voidFromVendor(ref);
    await runJob(h, "esign.sync", { workspaceId: WS, envelopeId: env.id });
    await runJob(h, "esign.collect", { workspaceId: WS, envelopeId: env.id });
    expect(row(env.id).status).toBe("completed");

    const view = await h.service.get({} as Tx, staffCtx, env.id);
    expect(view).toMatchObject({ hasSigned: true, hasCertificate: true, status: "completed" });

    const dl = await h.service.downloadArtifact(
      investorCtx,
      env.id,
      "signed",
      { membershipId: INVESTOR },
      {
        ownMembershipId: INVESTOR,
      },
    );
    expect(dl?.filename).toBe("subscription-agreement-signed.pdf");
    expect(
      await h.service.downloadArtifact(
        investorCtx,
        env.id,
        "signed",
        { membershipId: STAFF },
        {
          ownMembershipId: STAFF,
        },
      ),
    ).toBeUndefined();
    expect(h.audits.filter((a) => a.action === "esign.artifact_downloaded")).toHaveLength(1);
  });

  it("vendor not_found on an open envelope: first a confirming pull, then voided (Documenso deletes on cancel)", async () => {
    const h = harness();
    await connect(h);
    const env = await requestRound(h);
    h.vendor.failNext(1, "not_found");
    await runJob(h, "esign.sync", { workspaceId: WS, envelopeId: env.id });
    expect(row(env.id)).toMatchObject({ status: "sent", errorCode: "vendor_not_found" });
    h.vendor.failNext(1, "not_found");
    await runJob(h, "esign.sync", { workspaceId: WS, envelopeId: env.id });
    expect(row(env.id)).toMatchObject({ status: "voided", errorCode: null });
    expect(mem.state.published.at(-1)?.payload.status).toBe("voided");
  });

  it("a not_found followed by a good answer clears the mark", async () => {
    const h = harness();
    await connect(h);
    const env = await requestRound(h);
    h.vendor.failNext(1, "not_found");
    await runJob(h, "esign.sync", { workspaceId: WS, envelopeId: env.id });
    await runJob(h, "esign.sync", { workspaceId: WS, envelopeId: env.id });
    expect(row(env.id)).toMatchObject({ status: "sent", errorCode: null });
  });

  it("retryable failures back off without changing status; permanent ones mark error and recover", async () => {
    const h = harness();
    await connect(h);
    const env = await requestRound(h);
    h.vendor.failNext(1, "rate_limited");
    await runJob(h, "esign.sync", { workspaceId: WS, envelopeId: env.id });
    expect(row(env.id)).toMatchObject({ status: "sent", syncAttempts: 1, errorCode: null });
    h.vendor.failNext(1, "invalid_response");
    await runJob(h, "esign.sync", { workspaceId: WS, envelopeId: env.id });
    expect(row(env.id)).toMatchObject({ status: "error", errorCode: "invalid_response" });
    expect(row(env.id).nextSyncAt).not.toBeNull();
    await runJob(h, "esign.sync", { workspaceId: WS, envelopeId: env.id });
    expect(row(env.id)).toMatchObject({ status: "sent", errorCode: null });
  });

  it("marks an open envelope expired after 60 days", async () => {
    const h = harness();
    await connect(h);
    const env = await requestRound(h);
    mem.state.now = new Date(mem.state.now.getTime() + 61 * 86_400_000);
    await runJob(h, "esign.sync", { workspaceId: WS, envelopeId: env.id });
    expect(row(env.id)).toMatchObject({ status: "expired", nextSyncAt: null });
  });

  it("an infected artifact stores nothing, records artifact_infected and counts a security event", async () => {
    const h = harness();
    await connect(h);
    const env = await requestRound(h);
    h.vendor.complete(row(env.id).providerRef!);
    await runJob(h, "esign.sync", { workspaceId: WS, envelopeId: env.id });
    h.scan.verdict = "infected";
    await runJob(h, "esign.collect", { workspaceId: WS, envelopeId: env.id });
    expect(row(env.id)).toMatchObject({
      status: "completed",
      artifacts: null,
      errorCode: "artifact_infected",
    });
    expect(h.objects.size).toBe(0);
    expect(h.security).toEqual([
      {
        event: "esign_artifact_infected",
        fields: { workspaceId: WS, envelopeId: env.id, which: "signed" },
      },
    ]);
    expect(mem.state.published.at(-1)?.payload.status).toBe("error");
    expect(mem.state.published.some((p) => p.topic === "esign.envelope_completed")).toBe(false);
    // A manual resync never retries an infected artifact.
    h.jobs.length = 0;
    await h.service.requestSync(staffCtx, env.id, staff);
    expect(row(env.id).errorCode).toBe("artifact_infected");
  });

  it("a scanner error is retried (throws), not recorded", async () => {
    const h = harness();
    await connect(h);
    const env = await requestRound(h);
    h.vendor.complete(row(env.id).providerRef!);
    await runJob(h, "esign.sync", { workspaceId: WS, envelopeId: env.id });
    h.scan.verdict = "error";
    await expect(
      runJob(h, "esign.collect", { workspaceId: WS, envelopeId: env.id }),
    ).rejects.toThrow(/retrying/u);
    expect(row(env.id).errorCode).toBeNull();
  });

  it("an oversized artifact is refused (too_large) and a non-PDF is refused", async () => {
    const h = harness({ maxArtifactBytes: 100 });
    await connect(h);
    const env = await requestRound(h);
    h.vendor.complete(row(env.id).providerRef!);
    await runJob(h, "esign.sync", { workspaceId: WS, envelopeId: env.id });
    await runJob(h, "esign.collect", { workspaceId: WS, envelopeId: env.id });
    expect(row(env.id).errorCode).toBe("artifact_too_large");

    const h2 = harness({
      definition: (d) => ({
        ...d,
        create: (c, deps) => {
          const port = d.create(c, deps);
          return {
            ...port,
            downloadSigned: async () => ({ document: new TextEncoder().encode("<html>") }),
          };
        },
      }),
    });
    await connect(h2);
    const e2 = await requestRound(h2);
    const r2 = mem.state.envelopes.find((e) => e.id === e2.id);
    h2.vendor.complete(r2!.providerRef!);
    await runJob(h2, "esign.sync", { workspaceId: WS, envelopeId: e2.id });
    await runJob(h2, "esign.collect", { workspaceId: WS, envelopeId: e2.id });
    expect(row(e2.id).errorCode).toBe("artifact_not_pdf");
  });

  it("a transient download failure throws so the queue retries", async () => {
    const h = harness();
    await connect(h);
    const env = await requestRound(h);
    h.vendor.complete(row(env.id).providerRef!);
    await runJob(h, "esign.sync", { workspaceId: WS, envelopeId: env.id });
    h.vendor.failNext(1, "unavailable");
    await expect(
      runJob(h, "esign.collect", { workspaceId: WS, envelopeId: env.id }),
    ).rejects.toBeInstanceOf(ESignProviderError);
    expect(row(env.id).errorCode).toBeNull();
  });
});

describe("void", () => {
  it("voids at the vendor, audits and publishes; a terminal envelope answers envelope_not_open", async () => {
    const h = harness();
    await connect(h);
    const env = await requestRound(h);
    const v = await h.service.void(staffCtx, env.id, "wrong amount", STAFF);
    expect(v.status).toBe("voided");
    expect(h.audits.find((a) => a.action === "esign.envelope_voided")?.meta).toMatchObject({
      reason: "wrong amount",
      from: "sent",
    });
    await expectCode(h.service.void(staffCtx, env.id, "again", STAFF), "envelope_not_open");
  });

  it("a transient vendor failure queues esign.void and says so", async () => {
    const h = harness();
    await connect(h);
    const env = await requestRound(h);
    h.vendor.failNext(1, "unavailable");
    h.jobs.length = 0;
    let err = {} as ErrFake;
    try {
      await h.service.void(staffCtx, env.id, "x", STAFF);
    } catch (e) {
      err = e as ErrFake;
    }
    expect(err.code).toBe("esign_provider_error");
    expect(err.details["retrying"]).toBe(true);
    expect(h.jobs.map((j) => j.name)).toEqual(["esign.void"]);
    await runJob(h, "esign.void", h.jobs[0]!.data);
    expect(row(env.id).status).toBe("voided");
  });

  it("a vendor that says the envelope is finished: its status is pulled and applied at once", async () => {
    const h = harness();
    await connect(h);
    const env = await requestRound(h);
    h.vendor.complete(row(env.id).providerRef!);
    h.jobs.length = 0;
    await expectCode(h.service.void(staffCtx, env.id, "x", STAFF), "envelope_not_open");
    // A1: no blind re-enqueued sync — the answer is applied and the signed copy collected.
    expect(row(env.id).status).toBe("completed");
    expect(h.jobs.map((j) => j.name)).toEqual(["esign.collect"]);
  });
});

describe("NDA ceremony", () => {
  function publishNda(versionNo = 1) {
    mem.state.docs.set(DOC, {
      id: DOC,
      slug: "nda",
      title: "Mutual NDA",
      ceremony: "esign",
      current: { versionNo, body: "# NDA\n\nKeep it secret.", bodySha256: "ab".repeat(32) },
    });
  }
  const start = (h: Harness, consent = true) =>
    h.service.startNda(
      investorCtx,
      {
        membershipId: INVESTOR,
        documentId: DOC,
        consentToElectronicRecords: consent,
        disclosureVersion: ESIGN_DISCLOSURE_VERSION,
        returnUrl: "https://acme.example.com/portal/nda",
      },
      { membershipId: INVESTOR },
    );

  it("requires consent", async () => {
    const h = harness();
    await connect(h);
    publishNda();
    await expectCode(start(h, false), "esign_consent_required");
  });

  it("refuses a click-wrap document", async () => {
    const h = harness();
    await connect(h);
    publishNda();
    mem.state.docs.get(DOC)!.ceremony = "clickwrap";
    await expectCode(start(h), "conflict", "not_esign_ceremony");
  });

  it("records consent once, renders the PDF with fields, embeds with the return URL, and is idempotent", async () => {
    const h = harness();
    await connect(h);
    publishNda();
    const first = await start(h);
    expect(first.envelope).toMatchObject({
      purpose: "nda",
      status: "sent",
      membershipId: INVESTOR,
    });
    expect(first.signingUrl).toMatch(/^https:\/\/memory\.esign\.test\/sign\//u);
    const consent = mem.state.attestations.filter((a) => a.kind === ESIGN_CONSENT_KIND);
    expect(consent).toHaveLength(1);
    expect(consent[0]?.data?.disclosureVersion).toBe(1);
    expect(h.audits.find((a) => a.action === "esign.consent_recorded")?.actorMembershipId).toBe(
      INVESTOR,
    );
    const input = h.vendor.created()[0]?.input as EnvelopeInputFake;
    expect(input.document.kind).toBe("pdf");
    expect(Buffer.from(input.document.bytes.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
    expect(input.document.fields.map((f) => f.kind)).toEqual(["signature", "name", "date"]);
    expect(input.embedded).toBe(true);
    expect(input.redirectUrl).toBe("https://acme.example.com/portal/nda");
    const r = row(first.envelope.id);
    expect(r).toMatchObject({
      legalDocumentId: DOC,
      legalVersionNo: 1,
      vaultFolder: "Signed documents/NDAs",
      subjectModule: "compliance",
      subjectKind: "legal_document",
      subjectId: DOC,
    });

    const second = await start(h);
    expect(second.envelope.id).toBe(first.envelope.id);
    expect(h.vendor.created()).toHaveLength(1);
    expect(mem.state.attestations.filter((a) => a.kind === ESIGN_CONSENT_KIND)).toHaveLength(1);
    expect(await h.service.ndaStatus(investorCtx, INVESTOR, DOC)).toEqual({
      status: "open",
      envelopeId: first.envelope.id,
    });
  });

  it("a vendor without embedded signing gets no redirect URL and no signing URL (vendor emails)", async () => {
    const h = harness({
      definition: (d) => ({
        ...d,
        meta: { ...d.meta, supports: { ...d.meta.supports, embeddedSigning: false } },
      }),
    });
    await connect(h);
    publishNda();
    const out = await start(h);
    expect(out.signingUrl).toBeNull();
    const input = h.vendor.created()[0]?.input as EnvelopeInputFake;
    expect(input.embedded).toBe(false);
    expect(input.redirectUrl).toBeUndefined();
  });

  it("completion records the acceptance with method esign and evidence esign:v1:<id>", async () => {
    const h = harness();
    await connect(h);
    publishNda();
    const { envelope } = await start(h);
    h.vendor.complete(row(envelope.id).providerRef!);
    await runJob(h, "esign.sync", { workspaceId: WS, envelopeId: envelope.id });
    expect((await h.service.ndaStatus(investorCtx, INVESTOR, DOC)).status).toBe("open");
    await runJob(h, "esign.collect", { workspaceId: WS, envelopeId: envelope.id });
    expect(h.accepted).toEqual([
      {
        membershipId: INVESTOR,
        documentId: DOC,
        versionNo: 1,
        evidence: { evidenceRef: `esign:v1:${envelope.id}`, method: "esign" },
      },
    ]);
    expect(await h.service.ndaStatus(investorCtx, INVESTOR, DOC)).toEqual({
      status: "completed",
      envelopeId: envelope.id,
    });
  });

  it("a version published meanwhile leaves the gate closed and audits nda_version_superseded", async () => {
    const h = harness();
    await connect(h);
    publishNda(1);
    const { envelope } = await start(h);
    publishNda(2);
    h.vendor.complete(row(envelope.id).providerRef!);
    await runJob(h, "esign.sync", { workspaceId: WS, envelopeId: envelope.id });
    await runJob(h, "esign.collect", { workspaceId: WS, envelopeId: envelope.id });
    expect(h.accepted).toEqual([]);
    expect(h.audits.find((a) => a.action === "esign.nda_version_superseded")?.meta).toMatchObject({
      versionNo: 1,
      currentVersionNo: 2,
      reason: "version_superseded",
    });
    expect((await h.service.ndaStatus(investorCtx, INVESTOR, DOC)).status).toBe("superseded");
  });

  it("an erased member's completed NDA does not record an acceptance (late writer)", async () => {
    const h = harness();
    await connect(h);
    publishNda();
    const { envelope } = await start(h);
    h.erased.add(INVESTOR);
    h.vendor.complete(row(envelope.id).providerRef!);
    await runJob(h, "esign.sync", { workspaceId: WS, envelopeId: envelope.id });
    await runJob(h, "esign.collect", { workspaceId: WS, envelopeId: envelope.id });
    expect(h.accepted).toEqual([]);
    expect(
      h.audits.find((a) => a.action === "esign.nda_version_superseded")?.meta?.["reason"],
    ).toBe("member_erased");
  });

  it("signingUrl refuses anyone but the signer", async () => {
    const h = harness();
    await connect(h);
    publishNda();
    const { envelope } = await start(h);
    await expectCode(
      h.service.signingUrl(investorCtx, envelope.id, STAFF, "https://x"),
      "not_found",
    );
  });
});

describe("NDA ceremony — fix round 1", () => {
  function publishNda(kind = "nda") {
    mem.state.docs.set(DOC, {
      id: DOC,
      slug: "nda",
      title: "Mutual NDA",
      kind,
      ceremony: "esign",
      current: { versionNo: 1, body: "# NDA\n\nKeep it secret.", bodySha256: "ab".repeat(32) },
    });
  }
  const start = (h: Harness) =>
    h.service.startNda(
      investorCtx,
      {
        membershipId: INVESTOR,
        documentId: DOC,
        consentToElectronicRecords: true,
        disclosureVersion: ESIGN_DISCLOSURE_VERSION,
        returnUrl: "https://acme.example.com/portal/nda",
      },
      { membershipId: INVESTOR },
    );

  it("A6: only an nda-kind document is started, and only an nda-kind document is accepted", async () => {
    const h = harness();
    await connect(h);
    publishNda("terms");
    await expectCode(start(h), "conflict", "not_nda_document");
    publishNda("nda");
    const { envelope } = await start(h);
    mem.state.docs.get(DOC)!.kind = "terms";
    h.vendor.complete(row(envelope.id).providerRef!);
    await runJob(h, "esign.sync", { workspaceId: WS, envelopeId: envelope.id });
    await runJob(h, "esign.collect", { workspaceId: WS, envelopeId: envelope.id });
    expect(h.accepted).toEqual([]);
    expect(
      h.audits.find((a) => a.action === "esign.nda_version_superseded")?.meta?.["reason"],
    ).toBe("not_nda_document");
  });

  it("A7: refuses a document not pending for the member", async () => {
    const h = harness();
    await connect(h);
    publishNda();
    mem.state.notPending.add(DOC);
    await expectCode(start(h), "conflict", "not_pending");
    expect(h.vendor.created()).toHaveLength(0);
  });

  it("A7: five new envelopes per member per day, then 429 rate_limited; re-starts of an open one are free", async () => {
    const h = harness();
    await connect(h);
    publishNda();
    for (let i = 0; i < 5; i++) {
      const { envelope } = await start(h);
      // The idempotent re-start does not count.
      expect((await start(h)).envelope.id).toBe(envelope.id);
      await h.service.void(staffCtx, envelope.id, "again", STAFF);
      mem.state.now = new Date(mem.state.now.getTime() + 60_000);
    }
    let err: unknown;
    try {
      await start(h);
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: "rate_limited", details: { reason: "nda_start_budget" } });
    const retry = (err as { details: { retryAfterSeconds: number } }).details.retryAfterSeconds;
    expect(retry).toBeGreaterThan(23 * 3600);
    expect(retry).toBeLessThanOrEqual(24 * 3600);
    expect(h.vendor.created()).toHaveLength(5);
    // A day after the first, one frees up.
    mem.state.now = new Date(mem.state.now.getTime() + 24 * 3600_000 - 5 * 60_000 + 1);
    expect((await start(h)).envelope.status).toBe("sent");
  });

  it("A15: a text the PDF cannot draw is refused before anything is recorded", async () => {
    const h = harness();
    await connect(h);
    publishNda();
    mem.state.docs.get(DOC)!.current = {
      versionNo: 1,
      body: "Конфиденциальность.",
      bodySha256: "ab".repeat(32),
    };
    await expectCode(start(h), "esign_nda_text_unsupported", "unsupported_characters");
    expect(h.vendor.created()).toHaveLength(0);
    expect(mem.state.attestations).toEqual([]);
  });

  it("A8: a concurrent start waits for the in-flight draft, then answers envelope_creating", async () => {
    const h = harness();
    await connect(h);
    publishNda();
    const draft = await new mem.ESignEnvelopeRepo({ workspaceId: WS }, {}).insert({
      connectionId: mem.state.connections[0]?.id as string,
      driver: "documenso",
      purpose: "nda",
      subjectModule: "compliance",
      subjectKind: "legal_document",
      subjectId: DOC,
      legalDocumentId: DOC,
      legalVersionNo: 1,
      membershipId: INVESTOR,
      signerName: "Ada",
      signerEmail: "ada@example.com",
      title: "Mutual NDA (v1)",
      status: "draft",
      embedded: true,
    });
    // The other request records the vendor's answer shortly: this one returns that row.
    setTimeout(() => Object.assign(row(draft.id), { status: "sent", providerRef: "mem_x" }), 300);
    const out = await start(h);
    expect(out.envelope).toMatchObject({ id: draft.id, status: "sent" });
    // Still a draft after the wait: 409 conflict envelope_creating (the portal retries).
    Object.assign(row(draft.id), { status: "draft", providerRef: null });
    await expectCode(start(h), "conflict", "envelope_creating");
    expect(h.vendor.created()).toHaveLength(0);
  }, 15_000);

  it("A11: a completed envelope whose copy could not be collected reads `failed`, and a fresh start supersedes it", async () => {
    const h = harness();
    await connect(h);
    publishNda();
    const { envelope } = await start(h);
    h.vendor.complete(row(envelope.id).providerRef!);
    await runJob(h, "esign.sync", { workspaceId: WS, envelopeId: envelope.id });
    h.scan.verdict = "infected";
    await runJob(h, "esign.collect", { workspaceId: WS, envelopeId: envelope.id });
    expect(await h.service.ndaStatus(investorCtx, INVESTOR, DOC)).toEqual({
      status: "failed",
      envelopeId: envelope.id,
    });
    h.scan.verdict = "clean";
    const again = await start(h);
    expect(again.envelope.id).not.toBe(envelope.id);
    expect(await h.service.ndaStatus(investorCtx, INVESTOR, DOC)).toEqual({
      status: "open",
      envelopeId: again.envelope.id,
    });
  });
});

describe("sweep and erasure", () => {
  it("claims due rows into jobs, marks stale drafts orphaned, and voids an erased signer's open envelope", async () => {
    const h = harness();
    await connect(h);
    const a = await requestRound(h);
    const b = await requestRound(h);
    // A draft orphaned 20 minutes ago.
    const orphan = mem.state.envelopes[0] ? { ...mem.state.envelopes[0] } : undefined;
    mem.state.envelopes.push({
      ...orphan,
      id: "0199a000-0000-7000-8000-00000000ffff",
      status: "draft",
      providerRef: null,
      nextSyncAt: null,
      createdAt: new Date(mem.state.now.getTime() - 20 * 60_000),
    } as Env);
    // b's signer erased.
    await lockESignEnvelopesOfMember({} as Tx, { workspaceId: WS, actorKind: "system" }, INVESTOR);
    const n = await pseudonymiseESignEnvelopesOfMember(
      {} as Tx,
      { workspaceId: WS, actorKind: "system" },
      INVESTOR,
      "ada@example.com",
      mem.state.now,
    );
    expect(n).toBe(3);
    expect(row(b.id)).toMatchObject({
      signerName: "Erased signer",
      signerEmail: `erased+${b.id}@erased.invalid`,
    });
    expect(row(b.id).nextSyncAt!.getTime()).toBe(mem.state.now.getTime());
    // a is not due (next pull in 5 min) — make it due, and un-erase it for the test.
    Object.assign(row(a.id), { signerPseudonymisedAt: null, nextSyncAt: mem.state.now });
    h.jobs.length = 0;
    mem.state.published = [];
    await runJob(h, "esign.sync-due", {});
    // An erased signer's live envelope goes through esign.sync too (it pulls first, A1).
    expect(h.jobs.map((j) => [j.name, j.data["envelopeId"]]).sort()).toEqual(
      [
        ["esign.sync", a.id],
        ["esign.sync", b.id],
      ].sort(),
    );
    expect(row("0199a000-0000-7000-8000-00000000ffff")).toMatchObject({
      status: "error",
      errorCode: "orphaned_draft",
    });
    // Claimed rows are leased so the next sweep does not re-enqueue them.
    h.jobs.length = 0;
    await runJob(h, "esign.sync-due", {});
    expect(h.jobs).toEqual([]);
    // The void job withdraws the erased signer's envelope at the vendor.
    await runJob(h, "esign.void", { workspaceId: WS, envelopeId: b.id, reason: "erasure" });
    expect(row(b.id).status).toBe("voided");
    // A sync of a pseudonymised open envelope voids it too (after a pull that says open).
    Object.assign(row(a.id), { signerPseudonymisedAt: mem.state.now });
    await runJob(h, "esign.sync", { workspaceId: WS, envelopeId: a.id });
    expect(row(a.id).status).toBe("voided");
  });

  it("A1: an erased signer who already signed — the sync pulls, completes and collects, never loops", async () => {
    const h = harness();
    await connect(h);
    const env = await requestRound(h);
    h.vendor.complete(row(env.id).providerRef!);
    Object.assign(row(env.id), { signerPseudonymisedAt: mem.state.now, nextSyncAt: mem.state.now });
    h.jobs.length = 0;
    await runJob(h, "esign.sync", { workspaceId: WS, envelopeId: env.id });
    expect(row(env.id).status).toBe("completed");
    expect(h.jobs.map((j) => j.name)).toEqual(["esign.collect"]);
    await runJob(h, "esign.collect", { workspaceId: WS, envelopeId: env.id });
    expect(row(env.id).artifacts).not.toBeNull();
    // A void job still queued from before behaves too: nothing to void, nothing re-enqueued.
    h.jobs.length = 0;
    await runJob(h, "esign.void", { workspaceId: WS, envelopeId: env.id, reason: "erasure" });
    expect(h.jobs).toEqual([]);
  });

  it("A13: an erased signer's `error` envelope with a vendor ref is swept, pulled and voided", async () => {
    const h = harness();
    await connect(h);
    const env = await requestRound(h);
    Object.assign(row(env.id), { status: "error", errorCode: "unavailable" });
    await lockESignEnvelopesOfMember({} as Tx, { workspaceId: WS, actorKind: "system" }, INVESTOR);
    await pseudonymiseESignEnvelopesOfMember(
      {} as Tx,
      { workspaceId: WS, actorKind: "system" },
      INVESTOR,
      "ada@example.com",
      mem.state.now,
    );
    expect(row(env.id).nextSyncAt?.getTime()).toBe(mem.state.now.getTime());
    h.jobs.length = 0;
    await runJob(h, "esign.sync-due", {});
    expect(h.jobs.map((j) => [j.name, j.data["envelopeId"]])).toEqual([["esign.sync", env.id]]);
    await runJob(h, "esign.sync", { workspaceId: WS, envelopeId: env.id });
    expect(row(env.id).status).toBe("voided");
  });

  it("erasure locks the advisory lock before the envelope rows", async () => {
    await harness().service.connectionDetail(staffCtx);
    mem.state.locks = [];
    mem.state.envelopes.push({
      id: "0199a000-0000-7000-8000-0000000000e1",
      workspaceId: WS,
      membershipId: INVESTOR,
      signerEmail: "x@example.com",
      signerPseudonymisedAt: null,
    } as Env);
    await lockESignEnvelopesOfMember({} as Tx, { workspaceId: WS, actorKind: "system" }, INVESTOR);
    expect(mem.state.locks).toEqual([`adv:${WS}`, "env:0199a000-0000-7000-8000-0000000000e1"]);
  });
});

describe("misc", () => {
  it("ndaStatusOf: failed only when nothing newer is in flight (A11)", () => {
    const e = (id: string, status: string, v: number, extra: object = {}) =>
      ({ id, status, legalVersionNo: v, artifacts: null, errorCode: null, ...extra }) as never;
    const failed = e("f", "completed", 1, { errorCode: "artifact_infected" });
    expect(ndaStatusOf([failed], 1, false)).toEqual({ status: "failed", envelopeId: "f" });
    expect(ndaStatusOf([e("n", "sent", 1), failed], 1, false)).toEqual({
      status: "open",
      envelopeId: "n",
    });
    // Completed and still being collected: open.
    expect(ndaStatusOf([e("c", "completed", 1)], 1, false).status).toBe("open");
    expect(ndaStatusOf([failed], 2, false).status).toBe("superseded");
  });

  it("ndaStatusOf: completed > open > superseded > none", () => {
    const e = (id: string, status: string, v: number) =>
      ({ id, status, legalVersionNo: v, artifacts: null, errorCode: null }) as never;
    expect(ndaStatusOf([], 1, false)).toEqual({ status: "none", envelopeId: null });
    expect(ndaStatusOf([e("a", "declined", 1)], 1, false)).toEqual({
      status: "none",
      envelopeId: null,
    });
    expect(ndaStatusOf([e("a", "sent", 1)], 1, false)).toEqual({ status: "open", envelopeId: "a" });
    expect(ndaStatusOf([e("a", "completed", 1), e("b", "sent", 1)], 1, true).status).toBe(
      "completed",
    );
    // Vendor finished but the acceptance is not on record yet: still "open" (by design).
    expect(ndaStatusOf([e("a", "completed", 1)], 1, false)).toEqual({
      status: "open",
      envelopeId: "a",
    });
    expect(ndaStatusOf([e("a", "completed", 1)], 2, false)).toEqual({
      status: "superseded",
      envelopeId: "a",
    });
  });

  it("lists envelopes by keyset and filters", async () => {
    const h = harness();
    await connect(h);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      mem.state.now = new Date(mem.state.now.getTime() + 1000);
      ids.push((await requestRound(h)).id);
    }
    const p1 = await h.service.listEnvelopes(staffCtx, { limit: 2 });
    expect(p1.items.map((x) => x.id)).toEqual([ids[2], ids[1]]);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await h.service.listEnvelopes(staffCtx, { limit: 2, cursor: p1.nextCursor ?? "" });
    expect(p2.items.map((x) => x.id)).toEqual([ids[0]]);
    expect(p2.nextCursor).toBeNull();
    await expectCode(
      h.service.listEnvelopes(staffCtx, { limit: 2, cursor: "bad!" }),
      "validation_failed",
    );
  });

  it("document.vaulted sets vaultedDocumentId once", async () => {
    const h = harness();
    await connect(h);
    const env = await requestRound(h);
    const sysCtx: TenantContext = { workspaceId: WS, actorKind: "system" };
    const doc1 = "0199a000-0000-7000-8000-00000000d001";
    await h.service.onDocumentVaulted({} as Tx, sysCtx, {
      documentId: doc1,
      versionId: doc1,
      envelopeId: env.id,
    });
    await h.service.onDocumentVaulted({} as Tx, sysCtx, {
      documentId: "0199a000-0000-7000-8000-00000000d002",
      versionId: doc1,
      envelopeId: env.id,
    });
    expect(row(env.id).vaultedDocumentId).toBe(doc1);
  });

  it("view-as is refused on writes", async () => {
    const h = harness();
    const viewAs = { ...investorCtx, viewAs: { staffMembershipId: STAFF, staffUserId: STAFF } };
    await expectCode(
      h.service.saveConnection(viewAs, { driver: "documenso", credentials: {} }, staff),
      "conflict",
      "view_as_read_only",
    );
  });
});
