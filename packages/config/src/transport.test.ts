import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tryLoadConfig } from "./load.js";
import { isPrivateHost } from "./network.js";
import { pgTransportOf, smtpTransportOf } from "./transport.js";

/* R2-01: the F-08/F-09 transport rules must read DATABASE_URL / SMTP_URL the way pg and nodemailer
 * do. Each case is checked twice: config's verdict, and — through the drivers' own parsers — that
 * an accepted URL to a public host really is encrypted and verified. */

const here = fileURLToPath(new URL(".", import.meta.url));
const fromDb = createRequire(`${here}../../db/package.json`);
const pgcs = createRequire(fromDb.resolve("pg"))("pg-connection-string") as {
  parse(s: string): { host?: string | null; ssl?: unknown; sslmode?: string };
};
const nm = createRequire(`${here}../../adapters/email-smtp/package.json`)(
  "nodemailer/lib/shared",
) as {
  parseConnectionUrl(s: string): {
    host?: string;
    secure?: boolean;
    requireTLS?: unknown;
    ignoreTLS?: unknown;
    tls?: { rejectUnauthorized?: unknown };
  };
};

const prod: Record<string, string> = {
  APP_ENV: "prod",
  BASE_URL: "https://ir.example.com",
  DATABASE_URL: "postgres://u:p@db:5432/seedhost",
  FUNDROOM_SECRET_KEY: randomBytes(32).toString("base64"),
  MAIL_FROM: "ir@example.com",
  SMTP_URL: "smtps://u:p@smtp.example.com:465",
  AV_ACCEPT_UNSCANNED: "true",
};
const accepted = (key: string, value: string) => {
  const r = tryLoadConfig({ env: { ...prod, [key]: value } });
  return r.ok || !r.error.issues.some((i) => i.key === key);
};

describe("R2-01 DATABASE_URL is judged the way pg reads it", () => {
  it.each([
    ["postgres://u:p@db.example.com/x?sslmode=verify-full", true],
    ["postgres://u:p@db.example.com/x?sslmode=disable&sslmode=verify-full", true],
    // pg: the last sslmode wins.
    ["postgres://u:p@db.example.com/x?sslmode=verify-full&sslmode=disable", false],
    ["postgres://u:p@db.example.com/x?sslmode=verify-full&sslmode=require", false],
    // pg: a `host` parameter replaces the URL host.
    ["postgres://u:p@localhost/x?host=db.example.com", false],
    ["postgres://u:p@db/x?host=db.example.com&sslmode=disable", false],
    ["postgres://u:p@db.example.com/x?host=db", true],
    ["postgres://u:p@localhost/x?host=/run/postgresql", true],
    ["postgres://u:p@/x?host=/run/postgresql", true],
    // The fragment is not part of the query.
    ["postgres://u:p@db.example.com/x#?sslmode=verify-full", false],
    ["postgres://u:p@db.example.com/x?a=1#&sslmode=verify-full", false],
    // Numeric single labels are addresses to getaddrinfo (0x08080808 = 8.8.8.8).
    ["postgres://u:p@0x08080808/x", false],
    ["postgres://u:p@010.0.0.1/x", false],
    ["postgres://u:p@db:5432/x", true],
  ])("%s → accepted=%s", (url, ok) => {
    expect(accepted("DATABASE_URL", url)).toBe(ok);
    const pg = pgcs.parse(url);
    const ours = pgTransportOf(url);
    expect(ours.sslmode).toBe(pg.sslmode);
    expect(ours.host).toBe(pg.host?.startsWith("/") ? "" : pg.host);
    if (ok && !isPrivateHost(ours.host ?? "x.example")) {
      expect(["verify-full", "verify-ca"]).toContain(pg.sslmode);
      expect(pg.ssl).toBeTypeOf("object");
    }
  });
});

describe("R2-01 SMTP_URL is judged the way nodemailer reads it", () => {
  it.each([
    ["smtps://u:p@smtp.example.com:465", true],
    ["smtp://u:p@smtp.example.com:587?requireTLS=true", true],
    ["smtps://u:p@smtp.example.com:465?tls.rejectUnauthorized=true", true],
    ["smtp://u:p@smtp.example.com:587?requireTLS=true&ignoreTLS=false", true],
    ["smtp://u:p@smtp.example.com:587?requireTLS=true&ignoreTLS=0", true],
    ["smtp://u:p@smtp.example.com:587?requireTLS=true&ignoreTLS=1", false],
    ["smtp://u:p@smtp.example.com:587?requireTLS=true&ignoreTLS=yes", false],
    ["smtps://u:p@smtp.example.com:465?tls.rejectUnauthorized=0", false],
    ["smtps://u:p@smtp.example.com:465?tls.rejectUnauthorized=", false],
    ["smtps://u:p@smtp.example.com:465?tls.rejectUnauthorized=false", false],
    // Repeats become a list in nodemailer.
    ["smtp://u:p@smtp.example.com:587?requireTLS=true&requireTLS=false", false],
    // No URL host: nodemailer takes `host` from the query.
    ["smtp://?host=smtp.example.com&port=587", false],
    ["smtp://?host=smtp.example.com&port=587&requireTLS=true", true],
    ["smtp://?host=postfix&port=25", true],
    // With a URL host, nodemailer ignores the `host` parameter.
    ["smtp://postfix:25?host=smtp.example.com", true],
    // `secure` is fixed by the scheme; the parameter is ignored.
    ["smtp://u:p@smtp.example.com:587?secure=true", false],
    ["smtp://u:p@smtp.example.com\\@postfix:587", false],
    ["smtp://postfix:25", true],
  ])("%s → accepted=%s", (url, ok) => {
    expect(accepted("SMTP_URL", url)).toBe(ok);
    const o = nm.parseConnectionUrl(url);
    const ours = smtpTransportOf(url);
    if (!ours.ambiguous) expect(ours.host ?? "").toBe(o.host ?? "");
    if (ok && !isPrivateHost(String(o.host ?? ""))) {
      expect(o.secure === true || o.requireTLS === true).toBe(true);
      expect(Boolean(o.ignoreTLS)).toBe(false);
    }
    if (ok) {
      const tls = o.tls;
      expect(tls?.rejectUnauthorized === undefined || tls.rejectUnauthorized === true).toBe(true);
    }
  });
});
