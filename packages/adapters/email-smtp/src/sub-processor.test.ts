import { describe, expect, it } from "vitest";
import { smtpSubProcessor } from "./smtp-mailer.js";

describe("smtpSubProcessor (E3.11 R3-2)", () => {
  it("treats a relay next to the app as the operator's own", () => {
    for (const url of [
      "smtp://mailpit:1025",
      "smtp://localhost:25",
      "smtp://10.1.2.3:587",
      "smtps://relay.internal:465",
    ]) {
      expect(smtpSubProcessor(url), url).toBeNull();
    }
  });

  it("lists a public relay as an unidentified third party, never naming its host", () => {
    for (const url of [
      "smtp://apikey:SG.secret@smtp.sendgrid.net:587",
      "smtps://user:pw@smtp.gmail.com:465",
    ]) {
      const meta = smtpSubProcessor(url);
      expect(meta).toMatchObject({
        name: "Email relay (SMTP, not identified)",
        jurisdiction: "varies",
      });
      const text = JSON.stringify(meta);
      expect(text).not.toMatch(/sendgrid|gmail|secret|pw/u);
    }
  });
});
