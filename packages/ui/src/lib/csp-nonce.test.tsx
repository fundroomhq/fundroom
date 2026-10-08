import { afterEach, describe, expect, it } from "vitest";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "../components/input-otp.js";
import { render } from "../test/render.js";
import { getCspNonce, readCspNonce, resetCspNonceForTests } from "./csp-nonce.js";

function addMeta(nonce: string): HTMLMetaElement {
  const meta = document.createElement("meta");
  meta.setAttribute("property", "csp-nonce");
  meta.setAttribute("nonce", nonce);
  document.head.append(meta);
  return meta;
}

afterEach(() => {
  for (const el of document.head.querySelectorAll('meta[property="csp-nonce"], style')) el.remove();
  resetCspNonceForTests();
});

describe("CSP nonce", () => {
  it("is undefined on a page without one", () => {
    expect(readCspNonce()).toBeUndefined();
    expect(getCspNonce()).toBeUndefined();
  });

  it("prefers the .nonce property, which survives the browser hiding the attribute", () => {
    const meta = addMeta("");
    // What a browser does after parsing: the attribute reads "", the IDL property keeps it.
    Object.defineProperty(meta, "nonce", { value: "from-idl", configurable: true });
    expect(readCspNonce()).toBe("from-idl");
  });

  it("falls back to the attribute (jsdom) and memoises", () => {
    const meta = addMeta("abc123");
    expect(getCspNonce()).toBe("abc123");
    meta.remove();
    expect(getCspNonce()).toBe("abc123");
  });

  it("is stamped on input-otp's injected <style>", () => {
    addMeta("otp-nonce");
    render(
      <InputOTP maxLength={2} aria-label="Code">
        <InputOTPGroup>
          <InputOTPSlot index={0} />
          <InputOTPSlot index={1} />
        </InputOTPGroup>
      </InputOTP>,
    );
    const style = document.getElementById("input-otp-style");
    expect(style?.getAttribute("nonce")).toBe("otp-nonce");
  });
});
