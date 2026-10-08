import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  IMPORT_INTERRUPTED,
  importPostRow,
  importRecipientRow,
  importSendRow,
  updatesPortability,
} from "./portability.js";
import {
  post,
  postVersion,
  recipient,
  reply,
  send,
  sendingDomain,
  unsubscribe,
} from "./schema/updates.js";

const NOW = new Date("2026-09-23T12:00:00.000Z");
const ctx = {
  workspaceId: "w2",
  sourceWorkspaceId: "w1",
  now: NOW,
  mapId: (id: string) => id,
  remapLtree: (p: string) => p,
  remapKey: (k: string) => k,
};
const spec = (name: string) => {
  const t = updatesPortability.tables.find((x) => x.table === name);
  if (t === undefined) throw new Error(`no spec for ${name}`);
  return t;
};

describe("updates portability spec", () => {
  it("lists every table of the schema in FK order", () => {
    const tables = [post, postVersion, send, recipient, reply, unsubscribe, sendingDomain].map(
      (t) => getTableConfig(t).name,
    );
    expect(updatesPortability.tables.map((t) => t.table)).toEqual(tables);
  });

  it("skips the sending domain as a secret (its DKIM private key is NOT NULL)", () => {
    expect(spec("sending_domain")).toMatchObject({ mode: "skip", reason: "secret" });
    expect(updatesPortability.tables.filter((t) => t.mode === "skip")).toHaveLength(1);
  });

  it("post: an import never sends — schedules become drafts, a stuck send settles", () => {
    const importRow = spec("post").importRow;
    expect(importRow).toBeDefined();
    const scheduled = { id: "p", state: "scheduled", scheduled_for: "2026-10-01T00:00:00Z" };
    expect(importRow?.(scheduled, ctx)).toEqual({ id: "p", state: "draft", scheduled_for: null });
    expect(
      importPostRow({
        state: "sending",
        sent_at: "2026-09-01T00:00:00Z",
        published_version_id: "v",
      }),
    ).toMatchObject({ state: "sent" });
    expect(
      importPostRow({ state: "sending", sent_at: null, published_version_id: "v" }),
    ).toMatchObject({ state: "draft", scheduled_for: null });
    for (const state of ["draft", "sent", "archived"]) {
      const row = { state, sent_at: null };
      expect(importPostRow(row)).toBe(row);
    }
  });

  it("send: queued/running come back failed with the reason; finished history is untouched", () => {
    expect(spec("send").importRow?.({ status: "queued", finished_at: null }, ctx)).toEqual({
      status: "failed",
      error: IMPORT_INTERRUPTED,
      finished_at: NOW.toISOString(),
    });
    expect(
      importSendRow({ status: "running", finished_at: "2026-01-01T00:00:00Z" }, NOW),
    ).toMatchObject({
      finished_at: "2026-01-01T00:00:00Z",
    });
    const done = { status: "finished", error: null };
    expect(importSendRow(done, NOW)).toBe(done);
  });

  it("recipient: a still-queued address is marked failed, delivered ones stay", () => {
    expect(spec("recipient").importRow?.({ status: "queued", error: null }, ctx)).toEqual({
      status: "failed",
      error: IMPORT_INTERRUPTED,
    });
    const delivered = { status: "delivered" };
    expect(importRecipientRow(delivered)).toBe(delivered);
  });

  it("asks for a search rebuild of the imported workspace", async () => {
    const asked: string[] = [];
    await updatesPortability.afterImport?.({
      tx: {} as never,
      ctx: { workspaceId: "w2" } as never,
      services: {
        search: { requestReindex: async (_tx: unknown, _ctx: unknown, m: string) => asked.push(m) },
      } as never,
    });
    expect(asked).toEqual(["updates"]);
  });
});
