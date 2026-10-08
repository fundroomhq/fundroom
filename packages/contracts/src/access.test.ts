import { describe, expect, it } from "vitest";
import { PolicyConfigSchema } from "./access.js";

/* E2.10: `ip_allowlist` entries are validated at the API instead of silently matching nothing. */
describe("PolicyConfigSchema.cidrs", () => {
  it.each(["203.0.113.7", "203.0.113.0/24", "0.0.0.0/0", "2001:db8::1", "2001:db8::/32", "::/0"])(
    "accepts %s",
    (cidr) => {
      expect(PolicyConfigSchema.safeParse({ cidrs: [cidr] }).success).toBe(true);
    },
  );

  it.each([
    "10.0.0.0/",
    "10.0.0.0/33",
    "2001:db8::/129",
    "10.0.0.0/0x8",
    "1.2.3.4/1e1",
    "a/b/c",
    "10.0.0.0/8/8",
    " 10.0.0.1",
    "999.1.1.1",
    "fe80::1%eth0",
    "example.com",
    "",
  ])("refuses %j", (cidr) => {
    expect(PolicyConfigSchema.safeParse({ cidrs: ["10.0.0.0/8", cidr] }).success).toBe(false);
  });
});
