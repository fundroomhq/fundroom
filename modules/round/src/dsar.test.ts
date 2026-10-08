import { describe, expect, it } from "vitest";
import { contactIdsFrom, roundDsar } from "./dsar.js";

describe("round DSAR exporter", () => {
  it("runs after the CRM exporter, whose contact ids link commitments to the member", () => {
    expect(roundDsar.after).toEqual(["crm"]);
  });

  it("takes only uuid contact ids from the CRM's export, once each", () => {
    const a = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b6a";
    const b = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b6b";
    expect(
      contactIdsFrom({
        contacts: [{ id: a }, { id: b }, { id: a }, { id: "x'; DROP" }, { id: 7 }, null, "s"],
      }),
    ).toEqual([a, b]);
    expect(contactIdsFrom(undefined)).toEqual([]);
    expect(contactIdsFrom({ contacts: "nope" })).toEqual([]);
  });
});
