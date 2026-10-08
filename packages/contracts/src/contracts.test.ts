import { describe, expect, it } from "vitest";
import {
  API_ERROR_CODES,
  ApiError,
  ErrorBodySchema,
  toApiError,
  validationIssues,
} from "./errors.js";
import {
  API_PREFIX,
  buildOpenApiDocument,
  COMMON_ERROR_STATUSES,
  createApi,
  createRoute,
  EMAIL_PATTERN,
  EmailSchema,
  errorResponses,
  jsonBody,
  jsonResponse,
  kernel,
  platform,
  SlugSchema,
  z,
} from "./index.js";

describe("ApiError", () => {
  it("maps codes to statuses and renders the envelope", () => {
    const e = new ApiError("rate_limited", "slow down", { retryAfterMs: 1500 });
    expect(e.status).toBe(429);
    expect(e.toBody("req-1")).toEqual({
      error: { code: "rate_limited", message: "slow down", requestId: "req-1", retryAfterMs: 1500 },
    });
    expect(ErrorBodySchema.safeParse(e.toBody()).success).toBe(true);
  });

  it("adopts foreign errors with a catalogued code and matching status", () => {
    class AuthError extends Error {
      code = "unauthenticated";
      status = 401;
      details = { retryAfterMs: 2000 };
    }
    const adopted = toApiError(new AuthError("nope"));
    expect(adopted?.code).toBe("unauthenticated");
    expect(adopted?.headers["Retry-After"]).toBe("2");
    expect(toApiError({ code: "unauthenticated", status: 500 })).toBeUndefined();
    expect(toApiError({ code: "whatever" })).toBeUndefined();
    expect(toApiError(new Error("x"))).toBeUndefined();
  });

  it("every code has a 4xx/5xx status", () => {
    for (const status of Object.values(API_ERROR_CODES)) expect(status).toBeGreaterThanOrEqual(400);
  });

  it("formats validation issues with the request part", () => {
    expect(
      validationIssues([{ path: ["email"], message: "bad", code: "invalid_format" }], "json"),
    ).toEqual([{ path: "json.email", message: "bad", code: "invalid_format" }]);
  });
});

describe("createApi", () => {
  const app = createApi();
  app.openapi(
    createRoute({
      method: "post",
      path: "/things",
      request: { body: jsonBody(z.object({ name: z.string().min(2) })) },
      responses: {
        200: jsonResponse(z.object({ name: z.string() }), "ok"),
        ...errorResponses(...COMMON_ERROR_STATUSES),
      },
    }),
    (c) => c.json({ name: c.req.valid("json").name }, 200),
  );

  it("turns validation failures into the envelope", async () => {
    const res = await app.request("/things", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "a", extra: 1 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; issues: { path: string }[] } };
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.issues.map((i) => i.path)).toEqual(expect.arrayContaining(["json.name"]));
    expect(body.error.issues.some((i) => i.path === "json")).toBe(true); // unrecognised key
  });

  it("builds an OpenAPI 3.1 document with the session scheme and error components", () => {
    const doc = buildOpenApiDocument(app as never, { version: "0.0.1" });
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.servers?.[0]?.url).toBe(API_PREFIX);
    expect(doc.components?.securitySchemes).toHaveProperty("session");
    expect(doc.components?.schemas).toHaveProperty("Error");
    const post = doc.paths?.["/things"]?.post;
    expect(Object.keys(post?.responses ?? {}).sort()).toEqual([
      "200",
      "400",
      "404",
      "429",
      "500",
      "503",
    ]);
    const body = post?.requestBody as {
      content: Record<string, { schema: { additionalProperties?: boolean } }>;
    };
    expect(body.content["application/json"]?.schema.additionalProperties).toBe(false);
  });

  it("refuses undocumented error statuses", () => {
    expect(() => errorResponses(418)).toThrow(/no description/u);
  });
});

describe("kernel schemas", () => {
  it("accept a capability doc", () => {
    expect(
      kernel.CapabilityDocSchema.safeParse({
        apiVersion: "v1",
        serverVersion: "0.1.0",
        minEmbedSdk: "0.1.0",
        apiBase: "/api/v1",
        tenancy: "single",
        features: [],
        auth: { methods: ["email_otp"], passkeyRpId: "localhost" },
      }).success,
    ).toBe(true);
  });
});

describe("EmailSchema", () => {
  const ok = (v: string) => EmailSchema.safeParse(v).success;

  it("takes ordinary addresses", () => {
    for (const v of [
      "ada@example.com",
      "o'neil+tag@mail.example.co.uk",
      "a.b_c-d@x-y.io",
      `${"a".repeat(64)}@example.com`,
      `a@${"b".repeat(63)}.com`,
    ]) {
      expect(ok(v), v).toBe(true);
    }
  });

  it("refuses what no mail server delivers to", () => {
    for (const v of [
      "a@b-.com", // label ends with a hyphen
      "a@-b.com", // label starts with one
      `a@${"b".repeat(64)}.com`, // label over 63
      `a@${Array.from({ length: 4 }, () => "b".repeat(62)).join(".")}.com`, // domain over 253
      `${"a".repeat(65)}@example.com`, // local part over 64
      "a..b@example.com",
      "a@example.c",
      "a|b@example.com", // RFC 5322 allows it; the API does not
      "a@x_y.com",
    ]) {
      expect(ok(v), v).toBe(false);
    }
  });

  it("states the same rule in the document it validates by", () => {
    const api = createApi();
    api.openapi(
      createRoute({
        method: "post",
        path: "/e",
        request: { body: jsonBody(z.object({ email: EmailSchema })) },
        responses: { 200: jsonResponse(z.object({}), "ok") },
      }),
      (c) => c.json({}, 200),
    );
    const doc = buildOpenApiDocument(api as never, { version: "0" });
    expect(JSON.stringify(doc)).toContain(JSON.stringify(EMAIL_PATTERN.source));
  });
});

describe("SlugSchema", () => {
  it("documents a pattern that accepts exactly what it validates", () => {
    const api = createApi();
    api.openapi(
      createRoute({
        method: "post",
        path: "/s",
        request: { body: jsonBody(z.object({ slug: SlugSchema })) },
        responses: { 200: jsonResponse(z.object({}), "ok") },
      }),
      (c) => c.json({}, 200),
    );
    const doc = JSON.stringify(buildOpenApiDocument(api as never, { version: "0" }));
    const documented = /"slug":\{[^}]*"pattern":"((?:[^"\\]|\\.)*)"/u.exec(doc)?.[1];
    expect(documented).toBeDefined();
    const pattern = new RegExp(JSON.parse(`"${documented}"`) as string, "u");
    for (const v of ["acme", "a", "v", "v1x", "x-1", "v0", "v12", "-a", "a-", "Acme", "1.2.3"]) {
      expect(pattern.test(v), v).toBe(SlugSchema.safeParse(v).success);
    }
  });
});

describe("PlanLimits (A-3 entitlements)", () => {
  const ok = (limits: unknown) => platform.PlanLimitsSchema.safeParse(limits).success;

  it("accepts module and feature lists next to the numeric limits; absent and [] both parse", () => {
    expect(ok({ staffSeats: 3, modules: ["data-room", "updates"], features: ["sso", "ai"] })).toBe(
      true,
    );
    expect(ok({ modules: [], features: [] })).toBe(true);
    expect(ok({})).toBe(true);
  });

  it("refuses duplicates, unknown features, malformed module ids and unknown keys", () => {
    expect(ok({ modules: ["crm", "crm"] })).toBe(false);
    expect(ok({ features: ["sso", "sso"] })).toBe(false);
    expect(ok({ features: ["teleport"] })).toBe(false);
    expect(ok({ modules: ["Data Room"] })).toBe(false);
    expect(ok({ modules: "crm" })).toBe(false);
    expect(ok({ seats: 3 })).toBe(false);
  });

  it("names module and feature as plan_limit kinds", () => {
    expect(platform.PlanLimitKindSchema.options).toEqual(
      expect.arrayContaining(["module", "feature", "staffSeats"]),
    );
  });
});
