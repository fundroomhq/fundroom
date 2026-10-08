import { describe, expect, it } from "vitest";
import {
  ContactsQuery,
  CreateContactBody,
  CreatePipelineItemBody,
  CrmDecimalSchema,
  OrganizationsQuery,
  PatchTaskBody,
  PipelineQuery,
  PutStagesBody,
} from "./contracts.js";

/*
 * The query and body schemas, which is where a caller's raw strings stop being raw. Three of
 * these decide things the SQL underneath depends on: the cursor must be a uuid before it
 * reaches `id > $1::uuid`, the limit must be bounded before it reaches `LIMIT`, and `roundId`
 * has a third state that a uuid schema alone cannot express.
 */

const UUID = "0192f1a0-0000-7000-8000-000000000001";

describe("list queries", () => {
  it("defaults the page size to 50 and coerces the string a browser sends", () => {
    expect(ContactsQuery.parse({}).limit).toBe(50);
    expect(ContactsQuery.parse({ limit: "25" }).limit).toBe(25);
    expect(OrganizationsQuery.parse({ limit: "200" }).limit).toBe(200);
  });

  it("caps the page at 200 and refuses nought", () => {
    expect(ContactsQuery.safeParse({ limit: "201" }).success).toBe(false);
    expect(ContactsQuery.safeParse({ limit: "0" }).success).toBe(false);
    expect(OrganizationsQuery.safeParse({ limit: "1000" }).success).toBe(false);
  });

  /** The cursor is the last id of the previous page and goes straight into `::uuid`. */
  it("refuses a cursor that is not a uuid", () => {
    expect(ContactsQuery.safeParse({ cursor: "abc" }).success).toBe(false);
    expect(ContactsQuery.parse({ cursor: UUID }).cursor).toBe(UUID);
  });

  it("trims a search term and bounds its length", () => {
    expect(ContactsQuery.parse({ q: "  ada  " }).q).toBe("ada");
    expect(ContactsQuery.safeParse({ q: "x".repeat(121) }).success).toBe(false);
  });

  it("carries the organisation and tag filters through", () => {
    const parsed = ContactsQuery.parse({ organizationId: UUID, tag: "board" });
    expect(parsed).toMatchObject({ organizationId: UUID, tag: "board" });
  });

  it("refuses an organisation filter that is not a uuid", () => {
    expect(ContactsQuery.safeParse({ organizationId: "acme" }).success).toBe(false);
  });
});

describe("the pipeline round filter", () => {
  it("accepts an absent roundId, the `none` sentinel and a uuid", () => {
    expect(PipelineQuery.parse({}).roundId).toBeUndefined();
    expect(PipelineQuery.parse({ roundId: "none" }).roundId).toBe("none");
    expect(PipelineQuery.parse({ roundId: UUID }).roundId).toBe(UUID);
  });

  /*
   * An empty string is what a browser sends for an unset `<select>`, and it must not be
   * mistaken for the sentinel — that would silently show "cards with no round" to somebody who
   * asked for all of them.
   */
  it("refuses an empty string and any other word", () => {
    expect(PipelineQuery.safeParse({ roundId: "" }).success).toBe(false);
    expect(PipelineQuery.safeParse({ roundId: "all" }).success).toBe(false);
  });
});

describe("bodies", () => {
  it("lets a linked contact arrive with no name, because the member supplies it", () => {
    expect(CreateContactBody.parse({ membershipId: UUID }).displayName).toBe("");
    expect(CreateContactBody.parse({ displayName: "  Ada  " }).displayName).toBe("Ada");
  });

  it("bounds a contact's tags", () => {
    expect(CreateContactBody.safeParse({ displayName: "Ada", tags: ["a", "b"] }).success).toBe(
      true,
    );
    expect(
      CreateContactBody.safeParse({
        displayName: "Ada",
        tags: Array.from({ length: 51 }, (_, i) => `t${i}`),
      }).success,
    ).toBe(false);
  });

  it("needs at least one stage in a ladder replacement and defaults isTerminal", () => {
    expect(PutStagesBody.safeParse({ stages: [] }).success).toBe(false);
    expect(PutStagesBody.parse({ stages: [{ name: "Lead" }] }).stages[0]).toEqual({
      name: "Lead",
      isTerminal: false,
    });
  });

  it("refuses a stage key the column CHECK would refuse", () => {
    expect(PutStagesBody.safeParse({ stages: [{ key: "IC", name: "IC" }] }).success).toBe(false);
    expect(PutStagesBody.safeParse({ stages: [{ key: "custom_ic", name: "IC" }] }).success).toBe(
      true,
    );
  });

  /** Money is a decimal string on the wire; `numeric(20, 6)` does not survive a double. */
  it("takes a forecast as decimal text and refuses anything else", () => {
    expect(CrmDecimalSchema.parse("250000")).toBe("250000");
    expect(CrmDecimalSchema.parse("1234.567890")).toBe("1234.567890");
    expect(CrmDecimalSchema.safeParse("1e6").success).toBe(false);
    expect(CrmDecimalSchema.safeParse("250,000").success).toBe(false);
    expect(CrmDecimalSchema.safeParse("x".repeat(33)).success).toBe(false);
  });

  it("takes a card's currency as ISO 4217 and nothing looser", () => {
    expect(CreatePipelineItemBody.safeParse({ contactId: UUID, currency: "USD" }).success).toBe(
      true,
    );
    expect(CreatePipelineItemBody.safeParse({ contactId: UUID, currency: "usd" }).success).toBe(
      false,
    );
  });

  it("distinguishes clearing a task's due date from leaving it alone", () => {
    expect(PatchTaskBody.parse({}).dueAt).toBeUndefined();
    expect(PatchTaskBody.parse({ dueAt: null }).dueAt).toBeNull();
    expect(PatchTaskBody.parse({ dueAt: "2026-10-01T09:00:00.000Z" }).dueAt).toBe(
      "2026-10-01T09:00:00.000Z",
    );
  });

  it("takes a stage on a new card by key or by id, and neither is required", () => {
    expect(CreatePipelineItemBody.safeParse({ contactId: UUID }).success).toBe(true);
    expect(
      CreatePipelineItemBody.safeParse({ contactId: UUID, stageKey: "soft_committed" }).success,
    ).toBe(true);
    expect(CreatePipelineItemBody.safeParse({ contactId: UUID, stageId: UUID }).success).toBe(true);
  });
});
