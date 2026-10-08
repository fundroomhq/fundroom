import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { doctorReport } from "./doctor.js";
import { loadConfig, tryLoadConfig } from "./load.js";

/*
 * E3.11 R2-1: DIRECTORY_DATABASE_URL gets the same transport rule as DATABASE_URL (E2.10 F-09) in
 * staging/prod — a private host or `sslmode=verify-full|verify-ca`, with its own escape hatch
 * DIRECTORY_DATABASE_ACCEPT_UNVERIFIED_TLS. The directory carries every cell's export public key
 * (the trust root of a move) and the move rows, and is reached across regions by design.
 */

const prod: Record<string, string> = {
  APP_ENV: "prod",
  BASE_URL: "https://ir.example.com",
  DATABASE_URL: "postgres://u:p@db:5432/seedhost",
  FUNDROOM_SECRET_KEY: randomBytes(32).toString("base64"),
  MAIL_FROM: "ir@example.com",
  SMTP_URL: "smtps://u:p@smtp.example.com:465",
  AV_ACCEPT_UNSCANNED: "true",
  TENANCY_MODE: "multi",
  CONTROL_PLANE: "on",
  DATA_REGION: "eu",
  DATA_REGION_JURISDICTION: "eu",
  STORAGE_DRIVER: "s3",
  S3_BUCKET: "b",
  S3_REGION: "eu-central-1",
  S3_ACCESS_KEY_ID: "k",
  S3_SECRET_ACCESS_KEY: "s",
};

function keysOf(env: Record<string, string>): string[] {
  const r = tryLoadConfig({ env });
  return r.ok ? [] : r.error.issues.map((i) => i.key);
}

describe("directory transport (E3.11 R2-1)", () => {
  it.each([
    ["postgres://u:p@directory.internal:5432/d", true],
    ["postgres://u:p@10.9.8.7:5432/d", true],
    ["postgres://u:p@dir.example.com:5432/d?sslmode=verify-full", true],
    ["postgres://u:p@dir.example.com:5432/d?sslmode=verify-ca&sslrootcert=/ca.pem", true],
    ["postgres://u:p@dir.example.com:5432/d", false],
    ["postgres://u:p@dir.example.com:5432/d?sslmode=require", false],
    ["postgres://u:p@dir.example.com:5432/d?sslmode=verify-full&sslmode=disable", false],
  ])("prod %s → accepted=%s", (url, accepted) => {
    const keys = keysOf({ ...prod, DIRECTORY_DATABASE_URL: url });
    expect(keys.includes("DIRECTORY_DATABASE_URL")).toBe(!accepted);
  });

  it("has its own escape hatch (the cell database's does not cover it); dev/test not enforced", () => {
    const pub = "postgres://u:p@dir.example.com:5432/d?sslmode=require";
    expect(
      keysOf({ ...prod, DIRECTORY_DATABASE_URL: pub, DATABASE_ACCEPT_UNVERIFIED_TLS: "true" }),
    ).toContain("DIRECTORY_DATABASE_URL");
    expect(
      keysOf({
        ...prod,
        DIRECTORY_DATABASE_URL: pub,
        DIRECTORY_DATABASE_ACCEPT_UNVERIFIED_TLS: "true",
      }),
    ).not.toContain("DIRECTORY_DATABASE_URL");
    expect(keysOf({ ...prod, APP_ENV: "test", DIRECTORY_DATABASE_URL: pub })).not.toContain(
      "DIRECTORY_DATABASE_URL",
    );
  });

  it("doctor says how the directory connection is protected, never the URL", () => {
    const derived = (url: string, extra: Record<string, string> = {}) => {
      const c = loadConfig({
        env: { ...prod, APP_ENV: "test", DIRECTORY_DATABASE_URL: url, ...extra },
      });
      return doctorReport(c, {}).derived.find((r) => r.key === "directory")?.value;
    };
    expect(derived("postgres://u:pw@dir.example.com/d?sslmode=verify-full")).toBe(
      "shared (tls verify-full)",
    );
    expect(derived("postgres://u:pw@directory.internal/d")).toBe("shared (private host)");
    expect(derived("postgres://u:pw@dir.example.com/d?sslmode=require")).toBe(
      "shared (sslmode require)",
    );
    expect(
      derived("postgres://u:pw@dir.example.com/d", {
        DIRECTORY_DATABASE_ACCEPT_UNVERIFIED_TLS: "true",
      }),
    ).toBe("shared (UNVERIFIED TLS accepted)");
  });
});
