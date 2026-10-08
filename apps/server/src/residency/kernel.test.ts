import { aiProviderKey } from "@fundroom/ai";
import { AiSettingsSchema } from "@fundroom/domain";
import type { ModelProviderInfo } from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import { aiEffectivelyOn, deploymentResidency, residencyFactsOf } from "./kernel.js";

/* E3.11 RR2-4: third parties the deployment sends data to must be sub-processor rows. */
type Env = Parameters<typeof residencyFactsOf>[0];
const BASE: Env = {
  DATA_REGION: "eu",
  DATA_REGION_LABEL: "Frankfurt",
  DATA_REGION_JURISDICTION: "eu",
  MAILER_DRIVER: "smtp",
  STORAGE_DRIVER: "fs",
  CUSTOM_DOMAIN_DRIVER: "caddy-ask",
  AV_DRIVER: "noop",
  AI_RESULT_RETENTION_HOURS: 168,
} as Env;

const names = (env: Partial<Env>) =>
  deploymentResidency({
    residency: residencyFactsOf({ ...BASE, ...env } as Env, () => null),
    billing: { port: null },
    sanctions: { port: null },
  }).subProcessors.map((s) => s.name);

describe("deployment sub-processor rows (RR2-4)", () => {
  it("lists a remote clamd, not an operator-run one", () => {
    expect(names({ AV_DRIVER: "clamd", CLAMD_HOST: "scanner.example.com" })).toEqual([
      "Virus scanning service (clamd, not identified)",
    ]);
    expect(names({ AV_DRIVER: "clamd", CLAMD_HOST: "clamav" })).toEqual([]);
    expect(names({ AV_DRIVER: "clamd", CLAMD_HOST: "10.0.0.5" })).toEqual([]);
  });

  it("lists a hosted OTLP collector, never an operator-run one, and never its URL", () => {
    expect(names({ OTEL_EXPORTER_OTLP_ENDPOINT: "https://otlp.vendor.example:4318" })).toEqual([
      "Telemetry collector (OTLP, not identified)",
    ]);
    expect(names({ OTEL_EXPORTER_OTLP_ENDPOINT: "https://api.eu1.honeycomb.io" })).toEqual([
      "Honeycomb (Hound Technology, Inc.)",
    ]);
    expect(names({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel-collector:4318" })).toEqual([]);
    const facts = deploymentResidency({
      residency: residencyFactsOf(
        {
          ...BASE,
          OTEL_EXPORTER_OTLP_ENDPOINT: "https://otlp.vendor.example:4318",
        } as Env,
        () => null,
      ),
      billing: { port: null },
      sanctions: { port: null },
    });
    expect(JSON.stringify(facts)).not.toContain("otlp.vendor.example");
    expect(facts.subProcessors[0]).toMatchObject({ jurisdiction: "varies", outsideRegion: null });
  });
});

/* E3.12: the configured AI model provider as a component and (third party only) a sub-processor. */
const SELF_HOSTED: ModelProviderInfo = {
  id: "openai-compatible",
  label: "Ollama at ollama:11434",
  model: "qwen3.5:9b",
  hosting: "self_hosted",
  location: null,
  jurisdiction: null,
  trainsOnInputs: false,
  retention: "Prompts stay on the operator's infrastructure.",
  subProcessor: null,
};
const THIRD_PARTY: ModelProviderInfo = {
  id: "anthropic",
  label: "Anthropic",
  model: "claude-x",
  hosting: "third_party",
  location: "United States",
  jurisdiction: "us",
  trainsOnInputs: false,
  retention: "Inputs and outputs are deleted within 30 days.",
  subProcessor: {
    name: "Anthropic, PBC",
    purpose: "AI assist (workspaces that turn it on)",
    dataProcessed: "Prompts built from workspace content",
    location: "United States",
    jurisdiction: "us",
  },
};

function withAi(info: ModelProviderInfo | null, env: Partial<Env> = {}) {
  return deploymentResidency({
    residency: residencyFactsOf({ ...BASE, ...env } as Env, () => info),
    billing: { port: null },
    sanctions: { port: null },
  });
}

describe("the AI model (E3.12)", () => {
  it("is no component and no sub-processor when no provider is configured", () => {
    const facts = withAi(null);
    expect(facts.components.map((c) => c.component)).not.toContain("ai");
    expect(facts.subProcessors).toEqual([]);
  });

  it("self-hosted: in the region by the operator's declaration, never a sub-processor", () => {
    const facts = withAi(SELF_HOSTED);
    expect(facts.components.find((c) => c.component === "ai")).toEqual({
      component: "ai",
      location: "Frankfurt",
      jurisdiction: "eu",
      inRegion: true,
    });
    expect(facts.subProcessors).toEqual([]);
  });

  it("third party: compared by jurisdiction, listed as a deployment sub-processor", () => {
    const facts = withAi(THIRD_PARTY);
    expect(facts.components.find((c) => c.component === "ai")).toEqual({
      component: "ai",
      location: "United States",
      jurisdiction: "us",
      inRegion: false,
    });
    expect(withAi(THIRD_PARTY, { DATA_REGION_JURISDICTION: "us" }).components.at(-1)).toMatchObject(
      { component: "ai", inRegion: true },
    );
    expect(facts.subProcessors).toEqual([
      expect.objectContaining({ name: "Anthropic, PBC", scope: "deployment", outsideRegion: true }),
    ]);
  });

  it("a third party that varies (or says nothing) is not claimed in the region", () => {
    const varies = withAi({ ...THIRD_PARTY, jurisdiction: "varies", subProcessor: null });
    expect(varies.components.at(-1)).toMatchObject({ component: "ai", inRegion: null });
    const unknown = withAi({
      ...THIRD_PARTY,
      location: null,
      jurisdiction: null,
      subProcessor: null,
    });
    expect(unknown.components.at(-1)).toMatchObject({ location: null, inRegion: null });
    // No adapter metadata: still a row (data leaves the deployment), never "None".
    expect(unknown.subProcessors.map((s) => [s.name, s.jurisdiction])).toEqual([
      ["Anthropic", "varies"],
    ]);
  });
});

describe("aiEffectivelyOn", () => {
  const ack = (info: ModelProviderInfo) => ({
    providerKey: aiProviderKey(info),
    hosting: info.hosting,
    at: "2026-09-30T10:00:00.000Z",
    byMembershipId: "0192f0e0-0000-7000-8000-000000000001",
  });
  const on = AiSettingsSchema.parse({
    enabled: true,
    features: { updateDraft: false, qaAnswer: true },
    acknowledgement: ack(THIRD_PARTY),
  });

  it("needs the switch, a feature and an acknowledgement of THIS provider", () => {
    expect(aiEffectivelyOn(on, THIRD_PARTY)).toBe(true);
    expect(aiEffectivelyOn({ ...on, enabled: false }, THIRD_PARTY)).toBe(false);
    expect(
      aiEffectivelyOn({ ...on, features: { updateDraft: false, qaAnswer: false } }, THIRD_PARTY),
    ).toBe(false);
    expect(aiEffectivelyOn({ ...on, acknowledgement: null }, THIRD_PARTY)).toBe(false);
    // The operator changed the model: the old acknowledgement no longer counts.
    expect(aiEffectivelyOn(on, { ...THIRD_PARTY, model: "claude-y" })).toBe(false);
    expect(aiEffectivelyOn(AiSettingsSchema.parse({}), THIRD_PARTY)).toBe(false);
  });
});
