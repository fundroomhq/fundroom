import { describe, expect, it } from "vitest";
import { checksumOf, MigrationFormatError, parseMigration, stripComments } from "./parse.js";

describe("parseMigration", () => {
  it("accepts NNNN_snake_case.sql and splits on statement breakpoints", () => {
    const m = parseMigration(
      "0002_add_invites.sql",
      "CREATE TABLE a (id int);\n--> statement-breakpoint\nCREATE TABLE b (id int);\n",
    );
    expect(m.name).toBe("0002_add_invites");
    expect(m.sequence).toBe(2);
    expect(m.transactional).toBe(true);
    expect(m.chunks).toEqual(["CREATE TABLE a (id int);", "CREATE TABLE b (id int);"]);
    expect(m.checksum).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("rejects bad file names", () => {
    for (const name of ["1_x.sql", "0001-x.sql", "0001_X.sql", "0001_x.SQL", "0001_x y.sql"]) {
      expect(() => parseMigration(name, "SELECT 1")).toThrow(MigrationFormatError);
    }
  });

  it("rejects empty migrations (comments only)", () => {
    expect(() => parseMigration("0001_x.sql", "-- nothing\n/* here */")).toThrow(/no SQL/u);
  });

  it("drops chunks that contain only comments", () => {
    const m = parseMigration(
      "0001_x.sql",
      "-- header\n--> statement-breakpoint\nSELECT 1;\n--> statement-breakpoint\n-- trailing\n",
    );
    expect(m.chunks).toEqual(["SELECT 1;"]);
  });

  it("refuses CONCURRENTLY inside a transactional file", () => {
    expect(() =>
      parseMigration("0003_idx.sql", "CREATE INDEX CONCURRENTLY IF NOT EXISTS i ON t (a);"),
    ).toThrow(/no-transaction/u);
  });

  it("allows CONCURRENTLY with the no-transaction header", () => {
    const m = parseMigration(
      "0003_idx.sql",
      "-- seedhost: no-transaction\nCREATE INDEX CONCURRENTLY IF NOT EXISTS i ON t (a);",
    );
    expect(m.transactional).toBe(false);
  });

  it("ignores CONCURRENTLY mentioned only in comments", () => {
    const m = parseMigration("0003_idx.sql", "-- not CONCURRENTLY here\nCREATE INDEX i ON t (a);");
    expect(m.transactional).toBe(true);
  });

  it("refuses session-level SET but accepts SET LOCAL and UPDATE ... SET", () => {
    // sql-hygiene-allow: this test deliberately contains the forbidden pattern
    expect(() => parseMigration("0001_x.sql", "SET search_path = core;")).toThrow(/SET LOCAL/u);
    expect(() => parseMigration("0001_x.sql", "SELECT 1;\nSET ROLE x;")).toThrow(/SET LOCAL/u);
    expect(
      parseMigration("0001_x.sql", "SET LOCAL lock_timeout = '1s'; SELECT 1;").chunks,
    ).toHaveLength(1);
    expect(parseMigration("0001_x.sql", "UPDATE t SET a = 1;").chunks).toHaveLength(1);
  });

  it("checksums are stable across line endings", () => {
    expect(checksumOf("a\r\nb")).toBe(checksumOf("a\nb"));
    expect(checksumOf("a")).not.toBe(checksumOf("b"));
  });

  it("stripComments removes line and block comments", () => {
    expect(stripComments("SELECT 1; -- x\n/* y\nz */ SELECT 2;").replace(/\s+/gu, " ").trim()).toBe(
      "SELECT 1; SELECT 2;",
    );
  });
});
