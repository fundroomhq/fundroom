import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { configWarnings, doctorReport } from "./doctor.js";
import { loadConfig, tryLoadConfig } from "./load.js";
import {
  aiRequestReservation,
  effectiveAiBaseUrl,
  effectiveAiHosting,
  SECRET_KEYS,
} from "./schema.js";

/*
 * AI assist configuration (E3.12). What these pin: an install that sets none of the keys loads
 * with AI off (no new refusal); each provider's required keys; openai-compatible-only keys are
 * refused elsewhere; effective hosting (anthropic third-party, operator-run hosts self-hosted,
 * AI_HOSTING overrides); a third-party openai-compatible provider must name itself and its
 * jurisdiction; in prod-like, third-party traffic is https and a key never crosses plain http to
 * a host that is not operator-run; the anthropic base is a test seam in prod; the key is a
 * redacted secret; doctor prints one summary row.
 */
const KEY = randomBytes(32).toString("base64");
const minimal = {
  BASE_URL: "http://localhost:3000",
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  FUNDROOM_SECRET_KEY: KEY,
};
const prod = {
  ...minimal,
  APP_ENV: "prod",
  BASE_URL: "https://portal.example.com",
  DATABASE_URL: "postgres://u:p@db:5432/db",
  MAIL_FROM: "ir@example.com",
  SMTP_URL: "smtps://u:p@smtp.example.com:465",
  AV_ACCEPT_UNSCANNED: "true",
};
const ollama = {
  AI_PROVIDER: "openai-compatible",
  AI_BASE_URL: "http://ollama:11434",
  AI_MODEL: "qwen3.5:9b",
};
const anthropic = { AI_PROVIDER: "anthropic", AI_API_KEY: "sk-ant-x", AI_MODEL: "claude-opus-5" };
const hosted = {
  AI_PROVIDER: "openai-compatible",
  AI_BASE_URL: "https://api.inference.example.com/v1",
  AI_MODEL: "m",
  AI_API_KEY: "k",
  AI_PROVIDER_LABEL: "Example Inference",
  AI_PROVIDER_JURISDICTION: "us",
};

function problems(env: Record<string, string>): Record<string, string> {
  const r = tryLoadConfig({ env });
  if (r.ok) return {};
  return Object.fromEntries(r.error.issues.map((i) => [i.key, i.message]));
}

describe("AI assist config (E3.12)", () => {
  it("defaults: off, documented limits, no refusal", () => {
    const c = loadConfig({ env: minimal });
    expect(c.raw.AI_PROVIDER).toBe("none");
    expect(c.raw.AI_JSON_MODE).toBe("json_schema");
    expect(c.raw.AI_TOKEN_PARAM).toBe("max_tokens");
    expect(c.raw.AI_TIMEOUT_MS).toBe(180_000);
    expect(c.raw.AI_MAX_OUTPUT_TOKENS).toBe(4000);
    expect(c.raw.AI_MAX_INPUT_CHARS).toBe(60_000);
    expect(c.raw.AI_CONCURRENCY).toBe(2);
    expect(c.raw.AI_MONTHLY_TOKEN_BUDGET).toBe(2_000_000);
    expect(c.raw.AI_REQUESTS_PER_USER_HOUR).toBe(30);
    expect(c.raw.AI_RESULT_RETENTION_HOURS).toBe(168);
    expect(effectiveAiHosting(c.raw)).toBeNull();
    expect(problems(prod)).toEqual({});
  });

  it("a provider needs a model; openai-compatible needs a base URL; anthropic needs a key", () => {
    expect(problems({ ...minimal, ...ollama })).toEqual({});
    expect(problems({ ...minimal, ...ollama, AI_MODEL: "" })).toHaveProperty("AI_MODEL");
    const { AI_MODEL: _m, ...noModel } = ollama;
    expect(problems({ ...minimal, ...noModel })).toHaveProperty("AI_MODEL");
    const { AI_BASE_URL: _b, ...noBase } = ollama;
    expect(problems({ ...minimal, ...noBase })).toHaveProperty("AI_BASE_URL");
    expect(problems({ ...minimal, ...anthropic })).toEqual({});
    const { AI_API_KEY: _k, ...noKey } = anthropic;
    expect(problems({ ...minimal, ...noKey })).toHaveProperty("AI_API_KEY");
  });

  it("openai-compatible-only keys are refused with other providers", () => {
    for (const [k, v] of [
      ["AI_HOSTING", "self_hosted"],
      ["AI_JSON_MODE", "prompt"],
      ["AI_TOKEN_PARAM", "max_completion_tokens"],
    ] as const) {
      expect(problems({ ...minimal, ...anthropic, [k]: v })).toHaveProperty(k);
      expect(problems({ ...minimal, [k]: v })).toHaveProperty(k);
      expect(problems({ ...minimal, ...ollama, [k]: v })).toEqual({});
    }
  });

  it("effective hosting", () => {
    const c = (env: Record<string, string>) => loadConfig({ env: { ...minimal, ...env } }).raw;
    expect(effectiveAiHosting(c(anthropic))).toBe("third_party");
    expect(effectiveAiBaseUrl(c(anthropic))).toBe("https://api.anthropic.com");
    expect(effectiveAiHosting(c(ollama))).toBe("self_hosted");
    for (const base of [
      "http://10.0.0.5:8000",
      "http://llm.internal:8080",
      "http://localhost:11434",
      "http://[fd00::1]:8000",
    ]) {
      expect(effectiveAiHosting(c({ ...ollama, AI_BASE_URL: base }))).toBe("self_hosted");
    }
    expect(effectiveAiHosting(c(hosted))).toBe("third_party");
    // An operator may declare a public name as their own, or a private one as someone else's.
    expect(effectiveAiHosting(c({ ...hosted, AI_HOSTING: "self_hosted" }))).toBe("self_hosted");
    expect(
      effectiveAiHosting(
        c({
          ...ollama,
          AI_HOSTING: "third_party",
          AI_PROVIDER_LABEL: "Partner GPU",
          AI_PROVIDER_JURISDICTION: "eu",
        }),
      ),
    ).toBe("third_party");
  });

  it("a third-party openai-compatible provider names itself and its jurisdiction", () => {
    expect(problems({ ...minimal, ...hosted })).toEqual({});
    const { AI_PROVIDER_LABEL: _l, ...noLabel } = hosted;
    expect(problems({ ...minimal, ...noLabel })).toHaveProperty("AI_PROVIDER_LABEL");
    const { AI_PROVIDER_JURISDICTION: _j, ...noJur } = hosted;
    expect(problems({ ...minimal, ...noJur })).toHaveProperty("AI_PROVIDER_JURISDICTION");
    expect(problems({ ...minimal, ...hosted, AI_PROVIDER_JURISDICTION: "mars" })).toHaveProperty(
      "AI_PROVIDER_JURISDICTION",
    );
    expect(problems({ ...minimal, ...hosted, AI_PROVIDER_JURISDICTION: "varies" })).toEqual({});
    // Self-hosted needs neither.
    expect(problems({ ...minimal, ...ollama })).toEqual({});
  });

  it("prod-like: plain http only to an operator-run host, never to a third party", () => {
    expect(problems({ ...prod, ...hosted })).toEqual({});
    expect(
      problems({ ...prod, ...hosted, AI_BASE_URL: "http://api.inference.example.com" }),
    ).toHaveProperty("AI_BASE_URL");
    expect(
      problems({
        ...prod,
        ...hosted,
        APP_ENV: "staging",
        AI_BASE_URL: "http://api.inference.example.com",
      }),
    ).toHaveProperty("AI_BASE_URL");
    // Self-hosted on the operator's network: plain http, with or without a key, is fine.
    expect(problems({ ...prod, ...ollama })).toEqual({});
    expect(problems({ ...prod, ...ollama, AI_API_KEY: "k" })).toEqual({});
    // Fix R3-M3/R1-L3: a public host declared self-hosted is still reached over https only, with
    // or without a key (prompts carry workspace documents); https to it stays allowed.
    for (const base of ["http://llm.example.com", "http://203.0.113.5:8000"]) {
      for (const key of [{}, { AI_API_KEY: "k" }]) {
        const p = problems({
          ...prod,
          ...ollama,
          ...key,
          AI_BASE_URL: base,
          AI_HOSTING: "self_hosted",
        });
        expect(p, base).toHaveProperty("AI_BASE_URL");
        expect(p["AI_BASE_URL"]).toContain("not an operator-run host");
      }
    }
    expect(
      problems({
        ...prod,
        ...ollama,
        APP_ENV: "staging",
        AI_BASE_URL: "http://llm.example.com",
        AI_HOSTING: "self_hosted",
      }),
    ).toHaveProperty("AI_BASE_URL");
    expect(
      problems({
        ...prod,
        ...ollama,
        AI_BASE_URL: "https://llm.example.com",
        AI_HOSTING: "self_hosted",
        AI_API_KEY: "k",
      }),
    ).toEqual({});
    // An operator-run host declared third-party still needs https (existing rule).
    expect(
      problems({
        ...prod,
        ...ollama,
        AI_HOSTING: "third_party",
        AI_PROVIDER_LABEL: "Partner GPU",
        AI_PROVIDER_JURISDICTION: "eu",
      }),
    ).toHaveProperty("AI_BASE_URL");
    // Outside prod-like, http to a hosted provider is allowed (local fakes).
    expect(
      problems({ ...minimal, ...hosted, AI_BASE_URL: "http://api.inference.example.com" }),
    ).toEqual({});
  });

  it("anthropic base-URL errors show the anthropic example, never an Ollama one (fix R3-L5)", () => {
    const r = tryLoadConfig({
      env: { ...prod, ...anthropic, AI_BASE_URL: "https://proxy.example.com" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const issue = r.error.issues.find((i) => i.key === "AI_BASE_URL");
    expect(issue?.example).toBe("https://api.anthropic.com");
    expect(r.error.message).not.toContain("ollama");
    const staging = tryLoadConfig({
      env: { ...prod, ...anthropic, APP_ENV: "staging", AI_BASE_URL: "http://proxy.example.com" },
    });
    expect(staging.ok).toBe(false);
    if (staging.ok) return;
    expect(staging.error.message).not.toContain("ollama");
    // The pin itself stays prod-only, like STRIPE_API_BASE / CLOUDFLARE_API_BASE.
    expect(
      problems({
        ...prod,
        ...anthropic,
        APP_ENV: "staging",
        AI_BASE_URL: "https://proxy.example.com",
      }),
    ).toEqual({});
  });

  it("doctor warns when self_hosted is declared for a host that is not evidently operator-run", () => {
    const warns = (env: Record<string, string>) =>
      configWarnings(loadConfig({ env: { ...minimal, ...env } })).map((w) => w.key);
    expect(
      warns({ ...ollama, AI_BASE_URL: "https://llm.example.com", AI_HOSTING: "self_hosted" }),
    ).toContain("AI_HOSTING");
    expect(warns({ ...ollama, AI_HOSTING: "self_hosted" })).not.toContain("AI_HOSTING");
    expect(
      warns({
        ...ollama,
        AI_BASE_URL: "https://llm.example.com",
        AI_PROVIDER_LABEL: "X",
        AI_PROVIDER_JURISDICTION: "us",
      }),
    ).not.toContain("AI_HOSTING");
  });

  it("the anthropic base URL is a test seam in prod", () => {
    expect(problems({ ...prod, ...anthropic })).toEqual({});
    expect(problems({ ...prod, ...anthropic, AI_BASE_URL: "https://api.anthropic.com/" })).toEqual(
      {},
    );
    expect(
      problems({ ...prod, ...anthropic, AI_BASE_URL: "https://proxy.example.com" }),
    ).toHaveProperty("AI_BASE_URL");
    expect(problems({ ...minimal, ...anthropic, AI_BASE_URL: "http://127.0.0.1:9999" })).toEqual(
      {},
    );
  });

  it("the monthly budget covers at least one request's reservation (fix RR1-M3/L1)", () => {
    const c = loadConfig({ env: { ...minimal, ...ollama } }).raw;
    // Two prompts at a worst case of 1 token/char, three outputs' worth (fix RR3-L6).
    expect(aiRequestReservation(c)).toBe(2 * 60_000 + 3 * 4000);
    expect(aiRequestReservation({ AI_MAX_OUTPUT_TOKENS: 256, AI_MAX_INPUT_CHARS: 4001 })).toBe(
      2 * 4001 + 3 * 256,
    );
    // The largest limits still leave a valid budget range under the schema max.
    expect(
      problems({
        ...minimal,
        ...ollama,
        AI_MAX_INPUT_CHARS: "400000",
        AI_MAX_OUTPUT_TOKENS: "32000",
        AI_MONTHLY_TOKEN_BUDGET: "896000",
      }),
    ).toEqual({});
    // The shipped defaults are consistent.
    expect(c.AI_MONTHLY_TOKEN_BUDGET).toBeGreaterThanOrEqual(aiRequestReservation(c));
    expect(problems({ ...minimal, ...ollama, AI_MONTHLY_TOKEN_BUDGET: "131999" })).toHaveProperty(
      "AI_MONTHLY_TOKEN_BUDGET",
    );
    expect(problems({ ...minimal, ...ollama, AI_MONTHLY_TOKEN_BUDGET: "132000" })).toEqual({});
    expect(
      problems({
        ...minimal,
        ...ollama,
        AI_MONTHLY_TOKEN_BUDGET: "100000",
        AI_MAX_INPUT_CHARS: "400000",
      }),
    ).toHaveProperty("AI_MONTHLY_TOKEN_BUDGET");
    // Irrelevant (and never refused) while AI is off.
    expect(problems({ ...minimal, AI_MONTHLY_TOKEN_BUDGET: "1000" })).toEqual({});
  });

  it("validates ranges", () => {
    expect(problems({ ...minimal, AI_TIMEOUT_MS: "1000" })).toHaveProperty("AI_TIMEOUT_MS");
    expect(problems({ ...minimal, AI_CONCURRENCY: "33" })).toHaveProperty("AI_CONCURRENCY");
    expect(problems({ ...minimal, AI_MONTHLY_TOKEN_BUDGET: "999" })).toHaveProperty(
      "AI_MONTHLY_TOKEN_BUDGET",
    );
    expect(problems({ ...minimal, AI_PROVIDER: "openai" })).toHaveProperty("AI_PROVIDER");
  });

  it("the key is a redacted secret and doctor prints one summary row", () => {
    expect(SECRET_KEYS.has("AI_API_KEY")).toBe(true);
    const c = loadConfig({ env: { ...minimal, ...anthropic } });
    const report = doctorReport(c, {});
    expect(report.rows.find((r) => r.key === "AI_API_KEY")?.value).not.toContain("sk-ant-x");
    const derived = Object.fromEntries(report.derived.map((r) => [r.key, r.value]));
    expect(derived["aiAssist"]).toBe("anthropic (third_party, claude-opus-5)");
    const off = Object.fromEntries(
      doctorReport(loadConfig({ env: minimal }), {}).derived.map((r) => [r.key, r.value]),
    );
    expect(off["aiAssist"]).toBe("off");
    const local = Object.fromEntries(
      doctorReport(loadConfig({ env: { ...minimal, ...ollama } }), {}).derived.map((r) => [
        r.key,
        r.value,
      ]),
    );
    expect(local["aiAssist"]).toBe("openai-compatible (self_hosted, qwen3.5:9b)");
  });
});
