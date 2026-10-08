import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSmtpMailer, MailerError, type SmtpMailer } from "./smtp-mailer.js";

/*
 * Against Mailpit (the dev Compose mail sink, design/07 §1.2). SMTP on 1025, HTTP API on 8025.
 * Set FUNDROOM_TEST_MAILPIT_IMAGE to pin a version.
 */
const IMAGE = process.env["FUNDROOM_TEST_MAILPIT_IMAGE"] ?? "axllent/mailpit:v1.31.1";

interface MailpitSummary {
  ID: string;
  MessageID: string;
  From: { Name: string; Address: string };
  To: { Name: string; Address: string }[];
  Subject: string;
}

interface MailpitMessage extends MailpitSummary {
  Text: string;
  HTML: string;
  ReplyTo: { Name: string; Address: string }[];
}

let container: StartedTestContainer;
let api: string;
let mailer: SmtpMailer;
const logged: { event: string; fields: Record<string, unknown> }[] = [];

beforeAll(async () => {
  container = await new GenericContainer(IMAGE)
    .withExposedPorts(1025, 8025)
    .withWaitStrategy(Wait.forHttp("/api/v1/info", 8025))
    .start();
  const host = container.getHost();
  api = `http://${host}:${container.getMappedPort(8025)}`;
  mailer = createSmtpMailer({
    url: `smtp://${host}:${container.getMappedPort(1025)}`,
    from: { address: "investors@acme.test", name: "Acme Investor Relations" },
    replyTo: "ir@acme.test",
    log: (event, fields) => logged.push({ event, fields: { ...fields } }),
  });
});

afterAll(async () => {
  mailer?.close();
  await container?.stop();
});

async function json<T>(path: string): Promise<T> {
  const res = await fetch(`${api}${path}`);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function headers(id: string): Promise<Record<string, string[]>> {
  return json<Record<string, string[]>>(`/api/v1/message/${id}/headers`);
}

describe("smtp mailer against Mailpit", () => {
  it("healthCheck talks to the server", async () => {
    await expect(mailer.healthCheck()).resolves.toBeUndefined();
  });

  it("delivers text + html with the sender, reply-to and custom headers", async () => {
    const sent = await mailer.send({
      to: "alice@example.com",
      subject: "123456 is your code",
      text: "Your code is 123456",
      html: "<p>Your code is <strong>123456</strong></p>",
      headers: { "List-Unsubscribe": "<https://acme.test/unsubscribe>" },
      tags: ["auth", "otp"],
    });
    expect(sent.messageId).toMatch(/^<.+@.+>$/u);
    expect(sent.acceptedAt).toBeInstanceOf(Date);

    const list = await json<{ messages: MailpitSummary[] }>("/api/v1/messages");
    const summary = list.messages.find((m) => m.Subject === "123456 is your code");
    expect(summary).toBeDefined();
    if (!summary) throw new Error("unreachable");
    expect(summary.From).toEqual({
      Name: "Acme Investor Relations",
      Address: "investors@acme.test",
    });
    expect(summary.To[0]?.Address).toBe("alice@example.com");

    const full = await json<MailpitMessage>(`/api/v1/message/${summary.ID}`);
    expect(full.Text.trim()).toBe("Your code is 123456");
    expect(full.HTML).toContain("<strong>123456</strong>");
    expect(full.ReplyTo[0]?.Address).toBe("ir@acme.test");

    const h = await headers(summary.ID);
    expect(h["List-Unsubscribe"]?.[0]).toBe("<https://acme.test/unsubscribe>");
    expect(h["Message-Id"]?.[0] ?? h["Message-ID"]?.[0]).toBe(sent.messageId);
    // Tags stay off the wire.
    expect(Object.keys(h).some((k) => /fundroom|seed-host|tags/iu.test(k))).toBe(false);

    const line = logged.find((l) => l.event === "mail.sent");
    expect(line?.fields["to"]).toBe("a***@example.com");
    expect(line?.fields["tags"]).toEqual(["auth", "otp"]);
    expect(line?.fields["messageId"]).toBe(sent.messageId);
  });

  it("wraps an unreachable server in MailerError connection_failed", async () => {
    const dead = createSmtpMailer({
      url: "smtp://127.0.0.1:1",
      from: { address: "x@acme.test" },
      connectionTimeoutMs: 2000,
    });
    await expect(
      dead.send({ to: "a@example.com", subject: "s", text: "t" }),
    ).rejects.toBeInstanceOf(MailerError);
    await expect(dead.healthCheck()).rejects.toMatchObject({ code: "connection_failed" });
    dead.close();
  });
});
