import { describe, expect, it } from "vitest";
import {
  parseWorkspaceSettings,
  RoundSettingsSchema,
  WorkspaceSettingsSchema,
} from "./workspace-settings.js";

describe("round settings (E2.5)", () => {
  it("defaults an absent block to ninety days and USD", () => {
    // `round: {}` is what a workspace that has never opened the settings screen stores, and the
    // evidence-purge job runs against every workspace — so the default has to be a real answer,
    // not `undefined` that a job would then have to invent a number for.
    // E3.5: the closing block defaults to "no subscription template yet".
    const closing = { subscriptionTemplateRef: null, templateRole: "Signer", prefill: {} };
    // E3.7: a 14-day re-verification reminder, no auto-start.
    const reverification = { reminderDays: 14, autoStart: false };
    expect(RoundSettingsSchema.parse(undefined)).toEqual({
      evidenceRetentionDays: 90,
      defaultCurrency: "USD",
      closing,
      reverification,
    });
    expect(parseWorkspaceSettings({}).round).toEqual({
      evidenceRetentionDays: 90,
      defaultCurrency: "USD",
      closing,
      reverification,
    });
    expect(parseWorkspaceSettings({ round: {} }).round.evidenceRetentionDays).toBe(90);
  });

  it("keeps what an admin set and refuses what the purge job could not act on", () => {
    expect(
      parseWorkspaceSettings({ round: { evidenceRetentionDays: 30, defaultCurrency: " EUR " } })
        .round,
    ).toEqual({
      evidenceRetentionDays: 30,
      defaultCurrency: "EUR",
      closing: { subscriptionTemplateRef: null, templateRole: "Signer", prefill: {} },
      reverification: { reminderDays: 14, autoStart: false },
    });
    // Zero would mean "purge before the decision is reviewable"; ten years is the outer bound,
    // past which the file outlives the six years the *decision* has to be kept.
    expect(RoundSettingsSchema.safeParse({ evidenceRetentionDays: 0 }).success).toBe(false);
    expect(RoundSettingsSchema.safeParse({ evidenceRetentionDays: 3651 }).success).toBe(false);
    expect(RoundSettingsSchema.safeParse({ evidenceRetentionDays: 1.5 }).success).toBe(false);
    expect(RoundSettingsSchema.safeParse({ defaultCurrency: "dollars" }).success).toBe(false);
    // Lower case is refused rather than upcased, exactly as `metrics.defaultCurrency` is: the
    // column's CHECK is `^[A-Z]{3}$`, and a settings form that quietly accepted `eur` would
    // store a value the database would then refuse on the next round.
    expect(RoundSettingsSchema.safeParse({ defaultCurrency: "eur" }).success).toBe(false);
  });

  it("is registered on the workspace schema beside every other module's block", () => {
    expect(Object.keys(WorkspaceSettingsSchema.shape)).toContain("round");
    // A malformed `access` block falls back to defaults rather than locking everyone out; the
    // fallback rebuilds every block by name, so a block missing from it would be silently lost.
    const recovered = parseWorkspaceSettings({
      access: "nonsense",
      round: { evidenceRetentionDays: 45 },
    });
    expect(recovered.round.evidenceRetentionDays).toBe(45);
  });
});

describe("event-free settings invariants", () => {
  it("keeps unknown blocks so a newer server's settings survive a rollback", () => {
    const parsed = parseWorkspaceSettings({ round: {}, unheardOf: { x: 1 } }) as Record<
      string,
      unknown
    >;
    expect(parsed["unheardOf"]).toEqual({ x: 1 });
  });
});

describe("data-room Q&A settings (E3.3)", () => {
  it("defaults to off with the documented SLA and budgets", () => {
    expect(parseWorkspaceSettings({}).dataRoom.qa).toEqual({
      enabled: false,
      requireApproval: false,
      slaHours: 72,
      reminderLeadHours: 24,
      defaultVisibility: "asker",
      allowFolderQuestions: true,
      maxOpenPerAsker: 25,
    });
  });

  it("drops only a malformed qa block, keeping the rest of the data-room settings", () => {
    const parsed = parseWorkspaceSettings({
      dataRoom: { purgeAfterDays: 90, qa: { enabled: true, slaHours: 0 } },
    });
    expect(parsed.dataRoom.purgeAfterDays).toBe(90);
    expect(parsed.dataRoom.qa.enabled).toBe(false);
    expect(parsed.dataRoom.qa.slaHours).toBe(72);
  });
});

describe("round closing settings (E3.5)", () => {
  it("keeps a template ref and a prefill map of known sources, and refuses unknown sources", () => {
    const round = parseWorkspaceSettings({
      round: {
        closing: {
          subscriptionTemplateRef: " tpl_123 ",
          prefill: { investor: "investor_name", amt: "amount" },
        },
      },
    }).round;
    expect(round.closing).toEqual({
      subscriptionTemplateRef: "tpl_123",
      templateRole: "Signer",
      prefill: { investor: "investor_name", amt: "amount" },
    });
    expect(
      RoundSettingsSchema.safeParse({ closing: { prefill: { x: "social_security_number" } } })
        .success,
    ).toBe(false);
  });

  it("the template's signer role defaults to Signer, is trimmed, and is never blank (fix C3)", () => {
    const role = (templateRole: unknown) =>
      RoundSettingsSchema.safeParse({ closing: { templateRole } });
    expect(RoundSettingsSchema.parse({}).closing.templateRole).toBe("Signer");
    expect(role(" Investor ").data?.closing.templateRole).toBe("Investor");
    expect(role("  ").success).toBe(false);
    expect(role("x".repeat(101)).success).toBe(false);
  });
});

describe("round re-verification settings (E3.7)", () => {
  it("defaults to a 14-day reminder without auto-start and bounds the reminder to 1..60 days", () => {
    expect(RoundSettingsSchema.parse({}).reverification).toEqual({
      reminderDays: 14,
      autoStart: false,
    });
    expect(
      parseWorkspaceSettings({ round: { reverification: { reminderDays: 30, autoStart: true } } })
        .round.reverification,
    ).toEqual({ reminderDays: 30, autoStart: true });
    const days = (reminderDays: unknown) =>
      RoundSettingsSchema.safeParse({ reverification: { reminderDays } }).success;
    expect(days(1)).toBe(true);
    expect(days(60)).toBe(true);
    expect(days(0)).toBe(false);
    expect(days(61)).toBe(false);
    expect(days(1.5)).toBe(false);
    expect(RoundSettingsSchema.safeParse({ reverification: { autoStart: "yes" } }).success).toBe(
      false,
    );
  });
});

describe("AI assist settings (E3.12)", () => {
  const ack = {
    providerKey: "openai-compatible|self_hosted|Ollama at ollama:11434|qwen3.5:9b",
    hosting: "self_hosted",
    at: "2026-09-30T10:00:00.000Z",
    byMembershipId: "0199a000-0000-7000-8000-000000000001",
  } as const;

  it("defaults to off, no budget override and no acknowledgement", () => {
    expect(parseWorkspaceSettings({}).ai).toEqual({
      enabled: false,
      features: { updateDraft: false, qaAnswer: false },
      monthlyTokenBudget: null,
      acknowledgement: null,
    });
    expect(parseWorkspaceSettings({ ai: { enabled: true } }).ai.features).toEqual({
      updateDraft: false,
      qaAnswer: false,
    });
  });

  it("keeps a valid block", () => {
    const ai = {
      enabled: true,
      features: { updateDraft: true, qaAnswer: false },
      monthlyTokenBudget: 50_000,
      acknowledgement: ack,
    };
    expect(parseWorkspaceSettings({ ai }).ai).toEqual(ai);
  });

  it("a malformed ai block falls back to AI off and leaves every other block alone", () => {
    for (const bad of [
      { enabled: "yes" },
      { monthlyTokenBudget: 10 },
      { acknowledgement: { ...ack, hosting: "moon" } },
      { acknowledgement: { ...ack, byMembershipId: "x" } },
      { acknowledgement: { ...ack, providerKey: "k".repeat(401) } },
    ]) {
      const parsed = parseWorkspaceSettings({
        ai: { enabled: true, features: { updateDraft: true, qaAnswer: true }, ...bad },
        dataRoom: { purgeAfterDays: 90 },
        access: { inviteExpiryDays: 3 },
      });
      expect(parsed.ai.enabled).toBe(false);
      expect(parsed.ai.features.updateDraft).toBe(false);
      expect(parsed.ai.acknowledgement).toBeNull();
      expect(parsed.dataRoom.purgeAfterDays).toBe(90);
      expect(parsed.access.inviteExpiryDays).toBe(3);
    }
  });

  it("the last-resort parse also resets ai", () => {
    const parsed = parseWorkspaceSettings({
      ai: { enabled: "yes" },
      access: { nonsense: 1, inviteExpiryDays: -1 },
      content: 5,
    });
    expect(parsed.ai.enabled).toBe(false);
  });
});
