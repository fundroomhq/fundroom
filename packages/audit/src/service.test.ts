import type { Database, TenantContext, Tx } from "@fundroom/db";
import { describe, expect, it } from "vitest";
import {
  AuditInputError,
  AuditViewAsReadOnlyError,
  auditMeta,
  createAuditService,
} from "./service.js";

const WS = "01920000-0000-7000-8000-000000000001";
const M = "01920000-0000-7000-8000-000000000002";
const S = "01920000-0000-7000-8000-000000000003";

const viewing: TenantContext = {
  workspaceId: WS,
  actorKind: "external",
  membershipId: M,
  userId: M,
  viewAs: { staffMembershipId: S, staffUserId: S },
};

function untouchable(): Database {
  const fail = () => {
    throw new Error("the database must not be touched");
  };
  return { withTenant: fail, withHost: fail } as unknown as Database;
}

describe("view as investor", () => {
  it("refuses record() under a view-as context before touching the transaction", async () => {
    const audit = createAuditService({ db: untouchable() });
    const tx = new Proxy({}, { get: () => () => Promise.reject(new Error("tx used")) }) as Tx;
    const error = await audit
      .record(tx, viewing, { action: "document.viewed", resourceKind: "document" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuditViewAsReadOnlyError);
    // Duck-typed to the API envelope: `toApiError` adopts `{ code, status }` as 403.
    expect(error).toMatchObject({ code: "view_as_read_only", status: 403 });
  });

  it("refuses recordDetached() without opening a transaction", async () => {
    const audit = createAuditService({ db: untouchable() });
    await expect(
      audit.recordDetached(viewing, { action: "document.viewed", resourceKind: "document" }),
    ).rejects.toBeInstanceOf(AuditViewAsReadOnlyError);
  });
});

describe("apiKeyId (E3.4)", () => {
  const KEY = "01920000-0000-7000-8000-0000000000aa";

  it("is stored as meta.apiKeyId, over whatever meta carried", () => {
    expect(auditMeta({})).toEqual({});
    expect(auditMeta({ meta: { a: 1 } })).toEqual({ a: 1 });
    expect(auditMeta({ apiKeyId: KEY })).toEqual({ apiKeyId: KEY });
    expect(auditMeta({ meta: { a: 1, apiKeyId: "forged" }, apiKeyId: KEY })).toEqual({
      a: 1,
      apiKeyId: KEY,
    });
  });

  it("refuses something that is not a key id before touching the transaction", async () => {
    const audit = createAuditService({ db: untouchable() });
    const tx = new Proxy({}, { get: () => () => Promise.reject(new Error("tx used")) }) as Tx;
    const staff: TenantContext = {
      workspaceId: WS,
      actorKind: "staff",
      membershipId: M,
      userId: M,
    };
    await expect(
      audit.record(tx, staff, {
        action: "api_key.created",
        resourceKind: "api_key",
        apiKeyId: "shk_not-an-id",
      }),
    ).rejects.toBeInstanceOf(AuditInputError);
  });
});
