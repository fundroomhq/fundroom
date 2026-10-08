import { describe, expect, it } from "vitest";
import { parseClamdReply } from "./clamd-scanner.js";

describe("parseClamdReply", () => {
  it("maps OK / FOUND / ERROR", () => {
    expect(parseClamdReply("stream: OK\0")).toEqual({ verdict: "clean" });
    expect(parseClamdReply("stream: Eicar-Test-Signature FOUND\0")).toEqual({
      verdict: "infected",
      detail: "Eicar-Test-Signature",
    });
    expect(parseClamdReply("INSTREAM size limit exceeded. ERROR\0")).toEqual({
      verdict: "error",
      detail: "INSTREAM size limit exceeded. ERROR",
    });
    expect(parseClamdReply("")).toEqual({ verdict: "error", detail: "empty reply" });
  });
});
