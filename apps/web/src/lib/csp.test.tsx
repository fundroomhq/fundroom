import {
  resetCspNonceForTests,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@fundroomhq/ui";
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_POLICY,
  defaultPolicyCreateHTML,
  installCspGuards,
  RADIX_SELECT_VIEWPORT_CSS,
} from "./csp.js";

afterEach(() => {
  for (const el of document.head.querySelectorAll('meta[property="csp-nonce"]')) el.remove();
  resetCspNonceForTests();
  delete (window as unknown as { __webpack_nonce__?: string }).__webpack_nonce__;
});

function withNonce(nonce: string): void {
  const meta = document.createElement("meta");
  meta.setAttribute("property", "csp-nonce");
  meta.setAttribute("nonce", nonce);
  document.head.append(meta);
}

describe("Trusted Types default policy", () => {
  it("passes a listed literal at an implicit sink", () => {
    expect(
      defaultPolicyCreateHTML(RADIX_SELECT_VIEWPORT_CSS, "TrustedHTML", "Element innerHTML"),
    ).toBe(RADIX_SELECT_VIEWPORT_CSS);
  });

  it("refuses (null → reported) any other string at an implicit sink", () => {
    expect(
      defaultPolicyCreateHTML("<img src=x onerror=alert(1)>", "TrustedHTML", "Element innerHTML"),
    ).toBeNull();
    expect(
      defaultPolicyCreateHTML(`${RADIX_SELECT_VIEWPORT_CSS} `, "TrustedHTML", "Element innerHTML"),
    ).toBeNull();
  });

  it("throws on explicit use, so nobody borrows it as a passthrough", () => {
    expect(() => defaultPolicyCreateHTML(RADIX_SELECT_VIEWPORT_CSS)).toThrow(TypeError);
  });

  it("lists the exact CSS Radix Select renders (a Radix upgrade that changes it fails here)", () => {
    render(
      <Select defaultOpen defaultValue="a">
        <SelectTrigger aria-label="Pick">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">A</SelectItem>
        </SelectContent>
      </Select>,
    );
    const styles = [...document.querySelectorAll("style")].map((s) => s.textContent);
    expect(styles).toContain(RADIX_SELECT_VIEWPORT_CSS);
  });
});

describe("installCspGuards", () => {
  it("hands the page nonce to get-nonce and creates the default policy once", () => {
    withNonce("n0nce");
    const created: string[] = [];
    const tt = {
      defaultPolicy: null as unknown,
      createPolicy(name: string) {
        created.push(name);
        this.defaultPolicy = {};
        return {};
      },
    };
    const win = Object.assign(Object.create(window), { trustedTypes: tt });
    installCspGuards(win);
    installCspGuards(win);
    expect((win as { __webpack_nonce__?: string }).__webpack_nonce__).toBe("n0nce");
    expect(created).toEqual([DEFAULT_POLICY]);
  });

  it("is a no-op for the nonce and policy where neither exists", () => {
    const win = Object.create(window);
    expect(() => installCspGuards(win)).not.toThrow();
    expect((win as { __webpack_nonce__?: string }).__webpack_nonce__).toBeUndefined();
  });
});
