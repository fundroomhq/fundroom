import { describe, expect, it } from "vitest";
import { isForeignSender } from "./feedback.js";

/*
 * Foreign webhook events: another deployment sharing the provider account sends from another
 * address on our sending domain. Only that case is foreign; a workspace's own verified domain
 * and our own address keep the early-event retry.
 */
describe("isForeignSender", () => {
  const own = "no-reply@mail.fundroom.io";

  it("is another address on MAIL_FROM's domain, compared case-insensitively", () => {
    expect(isForeignSender("no-reply-staging@mail.fundroom.io", own)).toBe(true);
    expect(isForeignSender("no-reply-staging@Mail.FundRoom.io", "No-Reply@mail.fundroom.io")).toBe(
      true,
    );
  });

  it("is never our own address, another domain, or an event without a sender", () => {
    expect(isForeignSender("no-reply@mail.fundroom.io", own)).toBe(false);
    expect(isForeignSender("NO-REPLY@MAIL.FUNDROOM.IO", own)).toBe(false);
    expect(isForeignSender("ir@acme-ventures.test", own)).toBe(false);
    expect(isForeignSender("no-reply@fundroom.io", own)).toBe(false);
    expect(isForeignSender(undefined, own)).toBe(false);
    expect(isForeignSender("no-reply-staging@mail.fundroom.io", undefined)).toBe(false);
    expect(isForeignSender("not-an-address", own)).toBe(false);
  });
});
