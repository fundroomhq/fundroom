import type { MailerPort, OutboundEmail } from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import { createLogMailer, createMemoryMailer, createTemplatedMailer } from "./mailers.js";
import { registerTemplate } from "./render.js";

const brand = { productName: "FundRoom", workspaceName: "Acme" };

describe("createTemplatedMailer", () => {
  it("fills html from the template and keeps the caller's text", async () => {
    const inner = createMemoryMailer();
    const mailer = createTemplatedMailer(inner, { brand });
    await mailer.send({
      to: "a@example.com",
      subject: "s",
      text: "plain 123456",
      template: { name: "auth.otp", props: { code: "123456", ttlMinutes: 10 } },
    });
    const m = inner.sent[0];
    expect(m?.text).toBe("plain 123456");
    expect(m?.html).toContain("123456");
    expect(m?.html).toContain("Acme (FundRoom)");
  });

  it("does not override html the caller already rendered", async () => {
    const inner = createMemoryMailer();
    const mailer = createTemplatedMailer(inner, { brand });
    await mailer.send({
      to: "a@example.com",
      subject: "s",
      text: "t",
      html: "<p>mine</p>",
      template: { name: "auth.otp", props: { code: "1", ttlMinutes: 1 } },
    });
    expect(inner.sent[0]?.html).toBe("<p>mine</p>");
  });

  it("passes text-only through for unknown templates and render failures", async () => {
    const inner = createMemoryMailer();
    const events: string[] = [];
    const mailer = createTemplatedMailer(inner, { brand, log: (e) => events.push(e) });
    await mailer.send({
      to: "a@example.com",
      subject: "s",
      text: "t",
      template: { name: "x.y", props: {} },
    });
    registerTemplate("test.boom", () => {
      throw new Error("boom");
    });
    await mailer.send({
      to: "a@example.com",
      subject: "s",
      text: "t",
      template: { name: "test.boom", props: {} },
    });
    expect(inner.sent).toHaveLength(2);
    expect(inner.sent.every((m) => m.html === undefined)).toBe(true);
    expect(events).toEqual(["mail.template_unknown", "mail.template_failed"]);
  });

  it("resolves the brand per message and forwards health/webhooks", async () => {
    const seen: OutboundEmail[] = [];
    let health = 0;
    const inner: MailerPort = {
      driver: "fake",
      capabilities: { perMessageTracking: true, webhooks: true },
      async send(m) {
        seen.push(m);
        return { messageId: "<1@x>", acceptedAt: new Date() };
      },
      async healthCheck() {
        health += 1;
      },
      async parseWebhook() {
        return [];
      },
    };
    const mailer = createTemplatedMailer(inner, {
      brand: (m) => ({ productName: "FundRoom", workspaceName: m.tags?.[0] ?? "none" }),
    });
    const sent = await mailer.send({
      to: "a@example.com",
      subject: "s",
      text: "t",
      tags: ["Globex"],
      template: { name: "auth.otp", props: { code: "2", ttlMinutes: 1 } },
    });
    expect(sent.messageId).toBe("<1@x>");
    expect(seen[0]?.html).toContain("Globex (FundRoom)");
    await mailer.healthCheck();
    expect(health).toBe(1);
    expect(mailer.driver).toBe("fake");
    expect(await mailer.parseWebhook?.(new Request("https://x"))).toEqual([]);
    expect(mailer.capabilities).toEqual({ perMessageTracking: true, webhooks: true });
  });

  it("awaits an async resolver and keys it off workspaceId", async () => {
    const inner = createMemoryMailer();
    const seen: (string | undefined)[] = [];
    const mailer = createTemplatedMailer(inner, {
      brand: async (m) => {
        seen.push(m.workspaceId);
        await Promise.resolve();
        return {
          productName: "FundRoom",
          workspaceName: m.workspaceId === "ws_1" ? "Acme" : "Globex",
        };
      },
    });
    await mailer.send({
      to: "a@example.com",
      subject: "s",
      text: "t",
      workspaceId: "ws_1",
      template: { name: "auth.otp", props: { code: "1", ttlMinutes: 1 } },
    });
    await mailer.send({
      to: "b@example.com",
      subject: "s",
      text: "t",
      workspaceId: "ws_2",
      template: { name: "auth.otp", props: { code: "2", ttlMinutes: 1 } },
    });
    expect(seen).toEqual(["ws_1", "ws_2"]);
    expect(inner.sent[0]?.html).toContain("Acme (FundRoom)");
    expect(inner.sent[1]?.html).toContain("Globex (FundRoom)");
  });

  it("falls back to the default brand when the resolver rejects, and still sends", async () => {
    const inner = createMemoryMailer();
    const events: string[] = [];
    const mailer = createTemplatedMailer(inner, {
      brand: () => Promise.reject(new Error("settings unavailable")),
      defaultBrand: { productName: "FundRoom" },
      log: (e) => events.push(e),
    });
    await mailer.send({
      to: "a@example.com",
      subject: "s",
      text: "plain 123456",
      workspaceId: "ws_1",
      template: { name: "auth.otp", props: { code: "123456", ttlMinutes: 10 } },
    });
    expect(events).toEqual(["mail.brand_failed"]);
    const m = inner.sent[0];
    expect(m?.text).toBe("plain 123456");
    expect(m?.html).toContain("123456");
    expect(m?.html).toContain("FundRoom");
    expect(m?.html).not.toContain("Acme");
  });

  it("falls back the same way when a synchronous resolver throws", async () => {
    const inner = createMemoryMailer();
    const events: string[] = [];
    const mailer = createTemplatedMailer(inner, {
      brand: () => {
        throw new Error("boom");
      },
      defaultBrand: { productName: "FundRoom", workspaceName: "Instance" },
      log: (e) => events.push(e),
    });
    await mailer.send({
      to: "a@example.com",
      subject: "s",
      text: "t",
      template: { name: "auth.otp", props: { code: "9", ttlMinutes: 1 } },
    });
    expect(events).toEqual(["mail.brand_failed"]);
    expect(inner.sent[0]?.html).toContain("Instance (FundRoom)");
  });
});

describe("test/dev mailers", () => {
  it("memory mailer records, numbers and can fail on demand", async () => {
    const m = createMemoryMailer();
    const a = await m.send({ to: "a@example.com", subject: "1", text: "x" });
    expect(a.messageId).toMatch(/memory-1/u);
    m.failNext();
    await expect(m.send({ to: "a@example.com", subject: "2", text: "x" })).rejects.toThrow();
    await m.send({ to: "a@example.com", subject: "3", text: "x" });
    expect(m.sent.map((s) => s.subject)).toEqual(["1", "3"]);
    m.failNext(1, "b@example.com");
    await m.send({ to: "a@example.com", subject: "4", text: "x" });
    await expect(m.send({ to: "b@example.com", subject: "5", text: "x" })).rejects.toThrow();
    await m.send({ to: "b@example.com", subject: "6", text: "x" });
    expect(m.sent.map((s) => s.subject)).toEqual(["1", "3", "4", "6"]);
    m.clear();
    expect(m.sent).toHaveLength(0);
    await expect(m.healthCheck()).resolves.toBeUndefined();
  });

  it("log mailer prints the body on purpose", async () => {
    const lines: Record<string, unknown>[] = [];
    const m = createLogMailer({ log: (_e, f) => lines.push({ ...f }) });
    await m.send({ to: "a@example.com", subject: "s", text: "code 123456" });
    expect(m.driver).toBe("log");
    expect(lines[0]?.["to"]).toBe("a@example.com");
    expect(lines[0]?.["text"]).toBe("code 123456");
  });
});
