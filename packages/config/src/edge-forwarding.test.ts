import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { configWarnings, doctorReport, formatDoctorReport } from "./doctor.js";
import { loadConfig, tryLoadConfig } from "./load.js";
import { SECRET_KEYS } from "./schema.js";

/*
 * Edge forwarding (E-UP-7, ADR-0064): a Cloudflare Worker in front of a host-routed PaaS passes
 * the customer hostname and visitor IP in private headers, believed only under a shared secret.
 * What these pin: nothing changes when unset; the header names refuse every proxy-written name;
 * host header and secret come together; the IP header needs the host header and differs from it;
 * the previous secret needs (and differs from) the current one; PATH_MOUNTS never meets edge
 * forwarding; both secrets are redacted and readable from files; doctor's two warnings.
 */
const KEY = randomBytes(32).toString("base64");
const SECRET = "edge-secret-0123456789abcdef0123456789abcdef";
const OLD_SECRET = "old-edge-secret-0123456789abcdef0123456789ab";
const minimal = {
  BASE_URL: "https://portal.example.com",
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  FUNDROOM_SECRET_KEY: KEY,
};
const edge = {
  ...minimal,
  TRUST_PROXY: "true",
  FORWARDED_HOST_HEADER: "X-Fundroom-Forwarded-Host",
  FORWARDED_CLIENT_IP_HEADER: "X-Fundroom-Client-IP",
  EDGE_SHARED_SECRET: SECRET,
};

function problems(env: Record<string, string | undefined>): Record<string, string> {
  const r = tryLoadConfig({ env });
  if (r.ok) return {};
  return Object.fromEntries(r.error.issues.map((i) => [i.key, i.message]));
}

function load(env: Record<string, string | undefined>) {
  const r = tryLoadConfig({ env });
  if (!r.ok) throw r.error;
  return r;
}

describe("edge forwarding config (E-UP-7)", () => {
  it("is off by default", () => {
    const c = loadConfig({ env: minimal });
    expect(c.raw.FORWARDED_HOST_HEADER).toBeUndefined();
    expect(c.raw.FORWARDED_CLIENT_IP_HEADER).toBeUndefined();
    expect(c.raw.EDGE_SHARED_SECRET).toBeUndefined();
    expect(c.raw.EDGE_SHARED_SECRET_PREVIOUS).toBeUndefined();
  });

  it("loads the FundRoom edge's settings", () => {
    const c = loadConfig({ env: { ...edge, EDGE_SHARED_SECRET_PREVIOUS: OLD_SECRET } });
    expect(c.raw).toMatchObject({
      FORWARDED_HOST_HEADER: "X-Fundroom-Forwarded-Host",
      FORWARDED_CLIENT_IP_HEADER: "X-Fundroom-Client-IP",
      EDGE_SHARED_SECRET: SECRET,
      EDGE_SHARED_SECRET_PREVIOUS: OLD_SECRET,
    });
    // The client IP header is optional.
    expect(problems({ ...edge, FORWARDED_CLIENT_IP_HEADER: undefined })).toEqual({});
  });

  it.each([
    "Host",
    "host",
    "Forwarded",
    "X-Forwarded-Host",
    "x-forwarded-for",
    "X-FORWARDED-PREFIX",
    "X-Real-IP",
    "x-real-ip",
    "X-Fundroom-Edge",
    "x-fundroom-edge",
    "CF-Connecting-IP",
    "cf-ray",
  ])("refuses the proxy-written or reserved header name %s for both headers", (name) => {
    expect(problems({ ...edge, FORWARDED_HOST_HEADER: name })["FORWARDED_HOST_HEADER"]).toMatch(
      /private header only your edge sets/u,
    );
    expect(
      problems({ ...edge, FORWARDED_CLIENT_IP_HEADER: name })["FORWARDED_CLIENT_IP_HEADER"],
    ).toMatch(/private header only your edge sets/u);
  });

  it("requires both edge headers to be X-Fundroom-* (the namespace the edge strips)", () => {
    for (const name of ["X-Edge-Forwarded-Host", "X-Client-IP", "True-Client-IP", "X-Fundroom"]) {
      expect(problems({ ...edge, FORWARDED_HOST_HEADER: name })["FORWARDED_HOST_HEADER"]).toMatch(
        /must start with X-Fundroom-.*strips every inbound X-Fundroom-\* header/u,
      );
      expect(
        problems({ ...edge, FORWARDED_CLIENT_IP_HEADER: name })["FORWARDED_CLIENT_IP_HEADER"],
      ).toMatch(/must start with X-Fundroom-/u);
    }
    expect(
      problems({
        ...edge,
        FORWARDED_HOST_HEADER: "x-fundroom-host",
        FORWARDED_CLIENT_IP_HEADER: "X-FUNDROOM-IP",
      }),
    ).toEqual({});
  });

  it("a malformed name gets the one format message, not the namespace one too", () => {
    const issuesFor = (key: string, value: string) => {
      const r = tryLoadConfig({ env: { ...edge, [key]: value } });
      return r.ok ? [] : r.error.issues.filter((i) => i.key === key).map((i) => i.message);
    };
    for (const [key, value] of [
      ["FORWARDED_HOST_HEADER", " X-Fundroom-Forwarded-Host"],
      ["FORWARDED_CLIENT_IP_HEADER", "X-Client IP"],
    ] as const) {
      expect(issuesFor(key, value)).toEqual([
        expect.stringMatching(/^must be an HTTP header name such as X-Fundroom-/u),
      ]);
    }
    // A well-formed name outside the namespace still gets the namespace message, once.
    expect(issuesFor("FORWARDED_HOST_HEADER", "X-Client-Host")).toEqual([
      expect.stringMatching(/^must start with X-Fundroom-/u),
    ]);
  });

  it("refuses something that is not a header name", () => {
    expect(problems({ ...edge, FORWARDED_HOST_HEADER: "X Fundroom Host" })).toHaveProperty(
      "FORWARDED_HOST_HEADER",
    );
    expect(problems({ ...edge, FORWARDED_CLIENT_IP_HEADER: "a".repeat(65) })).toHaveProperty(
      "FORWARDED_CLIENT_IP_HEADER",
    );
  });

  it("FORWARDED_HOST_HEADER requires EDGE_SHARED_SECRET", () => {
    expect(problems({ ...edge, EDGE_SHARED_SECRET: undefined })).toEqual({
      EDGE_SHARED_SECRET: expect.stringMatching(/required with FORWARDED_HOST_HEADER/u),
    });
  });

  it("EDGE_SHARED_SECRET requires FORWARDED_HOST_HEADER", () => {
    expect(problems({ ...minimal, EDGE_SHARED_SECRET: SECRET })).toEqual({
      FORWARDED_HOST_HEADER: expect.stringMatching(/required with EDGE_SHARED_SECRET/u),
    });
  });

  it("FORWARDED_CLIENT_IP_HEADER requires FORWARDED_HOST_HEADER", () => {
    expect(problems({ ...minimal, FORWARDED_CLIENT_IP_HEADER: "X-Fundroom-Client-IP" })).toEqual({
      FORWARDED_CLIENT_IP_HEADER: expect.stringMatching(/only read with edge forwarding on/u),
    });
  });

  it("the two header names must differ, case-insensitively", () => {
    expect(problems({ ...edge, FORWARDED_CLIENT_IP_HEADER: "x-fundroom-forwarded-host" })).toEqual({
      FORWARDED_CLIENT_IP_HEADER: expect.stringMatching(/must differ from FORWARDED_HOST_HEADER/u),
    });
  });

  it("the secrets must be 32 to 256 printable characters", () => {
    expect(problems({ ...edge, EDGE_SHARED_SECRET: "x".repeat(31) })).toEqual({
      EDGE_SHARED_SECRET: expect.stringMatching(/at least 32 characters/u),
    });
    expect(problems({ ...edge, EDGE_SHARED_SECRET: "x".repeat(32) })).toEqual({});
    expect(problems({ ...edge, EDGE_SHARED_SECRET: "x".repeat(257) })).toHaveProperty(
      "EDGE_SHARED_SECRET",
    );
    expect(problems({ ...edge, EDGE_SHARED_SECRET: `${"x".repeat(32)} y` })).toHaveProperty(
      "EDGE_SHARED_SECRET",
    );
    expect(problems({ ...edge, EDGE_SHARED_SECRET_PREVIOUS: "y".repeat(31) })).toHaveProperty(
      "EDGE_SHARED_SECRET_PREVIOUS",
    );
  });

  it("EDGE_SHARED_SECRET_PREVIOUS requires EDGE_SHARED_SECRET", () => {
    expect(
      problems({
        ...edge,
        FORWARDED_HOST_HEADER: undefined,
        FORWARDED_CLIENT_IP_HEADER: undefined,
        EDGE_SHARED_SECRET: undefined,
        EDGE_SHARED_SECRET_PREVIOUS: OLD_SECRET,
      }),
    ).toEqual({
      EDGE_SHARED_SECRET_PREVIOUS: expect.stringMatching(/only accepted during a rotation/u),
    });
  });

  it("EDGE_SHARED_SECRET_PREVIOUS must differ from EDGE_SHARED_SECRET (and never echoes it)", () => {
    const r = tryLoadConfig({ env: { ...edge, EDGE_SHARED_SECRET_PREVIOUS: SECRET } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.issues.map((i) => i.key)).toEqual(["EDGE_SHARED_SECRET_PREVIOUS"]);
    expect(r.error.issues[0]?.message).toMatch(/must differ from EDGE_SHARED_SECRET/u);
    expect(r.error.message).not.toContain(SECRET);
  });

  it("refuses FORWARDED_HOST_HEADER with PATH_MOUNTS, and allows each alone", () => {
    const mounts = { PATH_MOUNTS: "https://acme.com/investors" };
    expect(problems({ ...edge, ...mounts })).toEqual({
      FORWARDED_HOST_HEADER: expect.stringMatching(/cannot be combined with PATH_MOUNTS/u),
    });
    expect(problems({ ...minimal, ...mounts })).toEqual({});
    expect(problems(edge)).toEqual({});
  });

  it("CLIENT_IP_HEADER is never an X-Fundroom-* header, whatever else is configured", () => {
    const refused = {
      CLIENT_IP_HEADER: expect.stringMatching(/must not be an X-Fundroom-\* header/u),
    };
    for (const name of ["X-Fundroom-Client-IP", "x-fundroom-forwarded-host", "X-FUNDROOM-OTHER"]) {
      // With edge forwarding configured…
      expect(problems({ ...edge, CLIENT_IP_HEADER: name })).toEqual(refused);
      // …with only the host header (no FORWARDED_CLIENT_IP_HEADER)…
      expect(
        problems({ ...edge, FORWARDED_CLIENT_IP_HEADER: undefined, CLIENT_IP_HEADER: name }),
      ).toEqual(refused);
      // …and with no edge forwarding at all.
      expect(problems({ ...minimal, TRUST_PROXY: "true", CLIENT_IP_HEADER: name })).toEqual(
        refused,
      );
    }
    // The platform's own header (Railway's X-Real-IP), with or without the edge, is fine.
    expect(problems({ ...edge, CLIENT_IP_HEADER: "X-Real-IP" })).toEqual({});
    expect(problems({ ...minimal, TRUST_PROXY: "true", CLIENT_IP_HEADER: "X-Real-IP" })).toEqual(
      {},
    );
    expect(
      problems({ ...minimal, TRUST_PROXY: "true", CLIENT_IP_HEADER: "X-Fundroomish-IP" }),
    ).toEqual({});
  });

  it("does not require TRUST_PROXY (doctor warns instead)", () => {
    expect(problems({ ...edge, TRUST_PROXY: "false" })).toEqual({});
  });
});

describe("edge forwarding secrets (E-UP-7)", () => {
  it("both secrets are redacted everywhere doctor prints", () => {
    expect(SECRET_KEYS.has("EDGE_SHARED_SECRET")).toBe(true);
    expect(SECRET_KEYS.has("EDGE_SHARED_SECRET_PREVIOUS")).toBe(true);
    const r = load({ ...edge, EDGE_SHARED_SECRET_PREVIOUS: OLD_SECRET });
    const report = doctorReport(r.config, r.sources);
    const text = `${JSON.stringify(report)}\n${formatDoctorReport(report)}`;
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(OLD_SECRET);
    // The header names are not secret.
    expect(text).toContain("X-Fundroom-Forwarded-Host");
  });

  it("reads both secrets from *_FILE", () => {
    const files: Record<string, string> = {
      "/run/secrets/edge": `${SECRET}\n`,
      "/run/secrets/edge-old": `${OLD_SECRET}\n`,
    };
    const r = tryLoadConfig({
      env: {
        ...edge,
        EDGE_SHARED_SECRET: undefined,
        EDGE_SHARED_SECRET_FILE: "/run/secrets/edge",
        EDGE_SHARED_SECRET_PREVIOUS_FILE: "/run/secrets/edge-old",
      },
      readFile: (p) => files[p] ?? "",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.raw.EDGE_SHARED_SECRET).toBe(SECRET);
    expect(r.config.raw.EDGE_SHARED_SECRET_PREVIOUS).toBe(OLD_SECRET);
    expect(r.sources["EDGE_SHARED_SECRET"]).toBe("file");
    expect(r.sources["EDGE_SHARED_SECRET_PREVIOUS"]).toBe("file");
  });

  it("refuses EDGE_SHARED_SECRET and its _FILE together", () => {
    expect(
      problems({ ...edge, EDGE_SHARED_SECRET_FILE: "/run/secrets/edge" })["EDGE_SHARED_SECRET"],
    ).toMatch(/both EDGE_SHARED_SECRET and EDGE_SHARED_SECRET_FILE are set/u);
  });
});

describe("edge forwarding doctor warnings (E-UP-7)", () => {
  const KEYS = [
    "FORWARDED_HOST_HEADER",
    "FORWARDED_CLIENT_IP_HEADER",
    "EDGE_SHARED_SECRET_PREVIOUS",
  ];
  const edgeWarnings = (env: Record<string, string | undefined>) =>
    configWarnings(load(env).config).filter((w) => KEYS.includes(w.key));

  it("says nothing for a complete edge behind a trusted proxy, or with forwarding off", () => {
    expect(edgeWarnings(edge)).toEqual([]);
    expect(edgeWarnings(minimal)).toEqual([]);
    expect(edgeWarnings({ ...minimal, TRUST_PROXY: "false" })).toEqual([]);
  });

  it("warns when FORWARDED_HOST_HEADER is set and TRUST_PROXY is off (direct traffic breaks)", () => {
    expect(edgeWarnings({ ...edge, TRUST_PROXY: "false" })).toEqual([
      {
        key: "FORWARDED_HOST_HEADER",
        message: expect.stringMatching(
          /edge-forwarded requests are unaffected.*direct requests.*Set TRUST_PROXY=true/u,
        ),
      },
    ]);
  });

  it("warns when the edge sends no client IP header (everyone shares its egress address)", () => {
    expect(edgeWarnings({ ...edge, FORWARDED_CLIENT_IP_HEADER: undefined })).toEqual([
      {
        key: "FORWARDED_CLIENT_IP_HEADER",
        message: expect.stringMatching(/shares the edge's egress address/u),
      },
    ]);
  });

  it("warns (does not refuse) when the two names look swapped", () => {
    const swapped = {
      ...edge,
      FORWARDED_HOST_HEADER: "X-Fundroom-Client-IP",
      FORWARDED_CLIENT_IP_HEADER: "X-Fundroom-Forwarded-Host",
    };
    expect(problems(swapped)).toEqual({});
    expect(edgeWarnings(swapped)).toEqual([
      {
        key: "FORWARDED_HOST_HEADER",
        message: expect.stringMatching(
          /looks like an IP header.*every edge request would answer 400/u,
        ),
      },
    ]);
    // Case-insensitive, and "ip" alone counts.
    expect(
      edgeWarnings({
        ...edge,
        FORWARDED_HOST_HEADER: "x-fundroom-ip",
        FORWARDED_CLIENT_IP_HEADER: "X-FUNDROOM-HOST",
      }).map((w) => w.key),
    ).toEqual(["FORWARDED_HOST_HEADER"]);
    // Only one side looking wrong is not a swap.
    expect(edgeWarnings({ ...edge, FORWARDED_HOST_HEADER: "X-Fundroom-Ip-Host-Name" })).toEqual([]);
    expect(edgeWarnings({ ...edge, FORWARDED_CLIENT_IP_HEADER: "X-Fundroom-Host-Addr" })).toEqual(
      [],
    );
  });

  it("warns while a rotation is unfinished", () => {
    const warnings = edgeWarnings({ ...edge, EDGE_SHARED_SECRET_PREVIOUS: OLD_SECRET });
    expect(warnings).toEqual([
      {
        key: "EDGE_SHARED_SECRET_PREVIOUS",
        message: expect.stringMatching(/Finish the rotation/u),
      },
    ]);
    expect(JSON.stringify(warnings)).not.toContain(OLD_SECRET);
  });
});
