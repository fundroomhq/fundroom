import type { AuditInput, AuditService } from "@fundroom/audit";
import { describe, expect, it } from "vitest";
import { currentApiKeyId, runAsApiKey, withApiKeyAudit } from "./api-key-context.js";

/*
 * `meta.apiKeyId` threading (E3.4-A): the container's audit service fills `apiKeyId` from the
 * request's async context, so an entry written anywhere under an admitted key request carries
 * it without its caller knowing about keys.
 */
const KEY = "01a0db00-0000-7000-8000-0000000000aa";
const OTHER = "01a0db00-0000-7000-8000-0000000000ab";

function recorder() {
  const seen: AuditInput[] = [];
  const audit = {
    record: async (_tx: unknown, _ctx: unknown, input: AuditInput) => {
      seen.push(input);
      return {} as never;
    },
    recordDetached: async (_ctx: unknown, input: AuditInput) => {
      seen.push(input);
      return {} as never;
    },
    ensurePartitions: async () => 0,
  } as unknown as AuditService;
  return { seen, audit: withApiKeyAudit(audit) };
}

const input: AuditInput = { action: "api_key.created", resourceKind: "api_key" } as AuditInput;

describe("withApiKeyAudit", () => {
  it("adds apiKeyId inside a key request, across awaits, for both record paths", async () => {
    const { seen, audit } = recorder();
    await runAsApiKey(KEY, async () => {
      await new Promise((r) => setTimeout(r, 1));
      await audit.record({} as never, {} as never, input);
      await audit.recordDetached({} as never, input);
    });
    expect(seen.map((s) => s.apiKeyId)).toEqual([KEY, KEY]);
  });

  it("is a pass-through outside one, and an explicit apiKeyId wins", async () => {
    const { seen, audit } = recorder();
    expect(currentApiKeyId()).toBeUndefined();
    await audit.record({} as never, {} as never, input);
    await runAsApiKey(KEY, () =>
      audit.record({} as never, {} as never, { ...input, apiKeyId: OTHER }),
    );
    expect(seen[0]).toBe(input);
    expect(seen[0]?.apiKeyId).toBeUndefined();
    expect(seen[1]?.apiKeyId).toBe(OTHER);
  });

  it("concurrent requests keep their own key", async () => {
    const { seen, audit } = recorder();
    await Promise.all([
      runAsApiKey(KEY, async () => {
        await new Promise((r) => setTimeout(r, 5));
        await audit.record({} as never, {} as never, { ...input, resourceId: "a" });
      }),
      runAsApiKey(OTHER, async () => {
        await audit.record({} as never, {} as never, { ...input, resourceId: "b" });
      }),
      audit.record({} as never, {} as never, { ...input, resourceId: "c" }),
    ]);
    const by = Object.fromEntries(seen.map((s) => [s.resourceId, s.apiKeyId]));
    expect(by).toEqual({ a: KEY, b: OTHER, c: undefined });
  });
});
