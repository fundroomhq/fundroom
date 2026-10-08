import { describe, expect, it } from "vitest";
import { sesSubProcessor } from "./ses-mailer.js";

describe("sesSubProcessor (E3.11)", () => {
  it("locates SES in the region the adapter calls", () => {
    expect(sesSubProcessor("eu-west-1")).toMatchObject({
      location: "AWS eu-west-1 (Ireland)",
      jurisdiction: "eu",
    });
    expect(sesSubProcessor("us-west-2").jurisdiction).toBe("us");
    expect(sesSubProcessor("eu-central-2").jurisdiction).toBe("ch");
    expect(sesSubProcessor("us-gov-west-1").jurisdiction).toBe("us");
    expect(sesSubProcessor("me-central-1")).toMatchObject({
      location: "AWS me-central-1",
      jurisdiction: "other",
    });
  });
});
