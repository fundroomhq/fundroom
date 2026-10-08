import { describe, expect, it } from "vitest";
import { createSmtpMailer, MailerError, maskEmail } from "./smtp-mailer.js";

describe("createSmtpMailer options", () => {
  const from = { address: "investors@example.com" };

  it("accepts smtp:// and smtps:// URLs", () => {
    expect(createSmtpMailer({ url: "smtp://localhost:1025", from }).driver).toBe("smtp");
    expect(createSmtpMailer({ url: "smtps://u:p@mail.example.com:465", from }).driver).toBe("smtp");
  });

  it("rejects other schemes and bad addresses", () => {
    expect(() => createSmtpMailer({ url: "http://localhost", from })).toThrow(MailerError);
    expect(() => createSmtpMailer({ url: "smtp://localhost", from: { address: "nope" } })).toThrow(
      /from\.address/u,
    );
    expect(() =>
      createSmtpMailer({ url: "smtp://localhost", from, replyTo: "not an email" }),
    ).toThrow(/replyTo/u);
  });

  it("refuses a non-email recipient before touching the network", async () => {
    const mailer = createSmtpMailer({ url: "smtp://127.0.0.1:1", from });
    await expect(mailer.send({ to: "nobody", subject: "x", text: "y" })).rejects.toMatchObject({
      code: "send_failed",
    });
  });
});

describe("maskEmail", () => {
  it("keeps the first character and the domain", () => {
    expect(maskEmail("alice@example.com")).toBe("a***@example.com");
    expect(maskEmail("garbage")).toBe("***");
  });
});
