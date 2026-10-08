// @vitest-environment jsdom
// @vitest-environment-options { "url": "http://host.example/page" }
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { init } from "./loader.js";

/*
 * design/08 §7 "Mixed content". This needs its own file because the refusal is decided by the
 * page's own URL, and jsdom fixes that per test file.
 *
 * `http://localhost` is *not* covered by this test and must not be: browsers treat it as a secure
 * context and will store the Secure cookie, so a developer running a host page locally gets the
 * real portal. jsdom reports every `http:` document as insecure, which is why the fixture uses a
 * real-looking hostname rather than localhost.
 */
beforeEach(() => {
  document.body.replaceChildren();
  const container = document.createElement("div");
  container.id = "portal";
  document.body.append(container);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("an http: host page", () => {
  it("refuses to embed, shows the link and says why", async () => {
    const portal = await init({
      workspace: "acme",
      baseUrl: "https://portal.example",
      el: "#portal",
      path: "/updates",
    });

    expect(portal.state).toBe("fallback");
    // No frame at all: a sign-in inside it could never store its cookie.
    expect(document.querySelector("iframe")).toBeNull();
    const link = document.querySelector<HTMLAnchorElement>("[data-seed-host-fallback]");
    expect(link?.getAttribute("href")).toBe("https://portal.example/w/acme/updates");
    expect(link?.target).toBe("_blank");

    const warning = vi.mocked(console.warn).mock.calls[0]?.[0] as string;
    expect(warning).toContain("Partitioned");
    expect(warning).toContain("https:");
    expect(warning).toContain("http://localhost is fine");

    portal.destroy();
  });

  it("keeps refusing after a host router re-render", async () => {
    // Regression: the remount path called `mountFrame()` without re-checking the host page, so a
    // re-render put a live frame on a plain-http page. Nothing could sign in there, and the
    // explanation was replaced five seconds later by a fallback blaming the host's CSP.
    const portal = await init({
      workspace: "acme",
      baseUrl: "https://portal.example",
      el: "#portal",
    });
    expect(portal.state).toBe("fallback");

    const container = document.querySelector("#portal");
    container?.remove();
    const replacement = document.createElement("div");
    replacement.id = "portal";
    document.body.append(replacement);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(document.querySelector("iframe")).toBeNull();
    expect(portal.state).toBe("fallback");
    expect(replacement.querySelector("[data-seed-host-fallback]")).not.toBeNull();
    // Explained once, when it happened — not again on every re-render.
    expect(vi.mocked(console.warn)).toHaveBeenCalledTimes(1);

    portal.destroy();
  });
});
