import type { FundRoomSchemas } from "@fundroom/sdk";
import { toast } from "@fundroomhq/ui";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  currentLocale,
  matchLocale,
  resetLocaleForTests,
  resolveLocale,
  selectableLocales,
} from "../lib/locale.js";
import { m } from "../paraglide/messages.js";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me, membership, session } from "../test/fixtures.js";
import { apiError, installMockApi } from "../test/mock-api.js";
import { renderApp } from "../test/render.js";

/*
 * i18n coverage of the investor UI (E2.8).
 *
 * The proof is the pseudo-locale: every catalogue string renders accented and wrapped in ⟦ ⟧
 * under `en-XA`, so any run of plain ASCII letters left on an investor screen is either data
 * (a workspace name, a document title — listed per screen below) or a string that never went
 * through the catalogue. `untranslated()` walks every text node and every user-visible
 * attribute and returns the latter.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  resetLocaleForTests();
  // Sonner keeps toasts in a module-level store: one test's "saved" must not appear in the next.
  toast.dismiss();
});

const NOW = "2026-09-12T10:00:00.000Z";

/** Formatted by `Intl` (dates, month names), not by us: English data in `en-XA`. */
const INTL_WORDS =
  /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?|\b(?:AM|PM)\b|\bat\b/gu;

/** Removes pseudo-localised segments, the given data strings and Intl words; returns the rest. */
function residue(text: string, data: readonly string[]): string {
  let t = text.replace(/⟦[^⟧]*⟧/gu, " ");
  for (const d of [...data].sort((a, b) => b.length - a.length)) t = t.split(d).join(" ");
  return t.replace(INTL_WORDS, " ");
}

const ATTRIBUTES = ["aria-label", "placeholder", "title", "alt", "aria-description"] as const;

/** Every text node / attribute on `root` with ASCII letters outside pseudo segments and data. */
function untranslated(root: HTMLElement, data: readonly string[]): string[] {
  const leaks: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    const parent = n.parentElement;
    if (parent?.closest("script,style,svg,code")) continue;
    const text = n.textContent ?? "";
    if (/[A-Za-z]/u.test(residue(text, data))) leaks.push(`text: ${JSON.stringify(text)}`);
  }
  for (const el of root.querySelectorAll("*")) {
    for (const a of ATTRIBUTES) {
      const v = el.getAttribute(a);
      if (v !== null && /[A-Za-z]/u.test(residue(v, data)))
        leaks.push(`${a}: ${JSON.stringify(v)}`);
    }
  }
  return leaks;
}

/** The data every portal screen shows: workspace, user, nav labels from module manifests. */
const COMMON_DATA = ["Acme", "Ada Lovelace", "Ada", "Updates", "Data room", "FundRoom", "AL"];

function pseudoFixtures(over: Partial<FundRoomSchemas["ModulesBootstrap"]> = {}) {
  return {
    me: me({
      session: session({
        user: { displayName: "Ada Lovelace", mfaEnrolled: false, locale: "en-XA" },
      }),
    }),
    bootstrap: bootstrap({ pseudoLocale: true, ...over }),
  };
}

/** Forces `en-XA` the way a signed-in reader who chose it gets it. */
function asPseudoReader() {
  resetLocaleForTests({ user: "en-XA", pseudoAllowed: true });
}

describe("locale selection (lib/locale.ts)", () => {
  it("orders user choice > ?lang= > cookie > browser > workspace default > en", () => {
    const all = {
      user: "en-XA",
      query: "en",
      cookie: "en",
      navigator: ["en"],
      workspace: "en",
      pseudoAllowed: true,
    };
    expect(resolveLocale(all)).toBe("en-XA");
    expect(resolveLocale({ ...all, user: null, query: "en-XA" })).toBe("en-XA");
    expect(resolveLocale({ ...all, user: null, query: null, cookie: "en-XA" })).toBe("en-XA");
    expect(
      resolveLocale({ ...all, user: null, query: null, cookie: null, navigator: ["en-XA"] }),
    ).toBe("en-XA");
    expect(
      resolveLocale({
        pseudoAllowed: true,
        navigator: ["fr-FR", "de"],
        workspace: "en-XA",
      }),
    ).toBe("en-XA");
    expect(resolveLocale({ pseudoAllowed: true, navigator: ["fr"] })).toBe("en");
    // An unsupported tag is skipped, not a stop: the next input decides.
    expect(resolveLocale({ pseudoAllowed: true, user: "klingon", query: "en-XA" })).toBe("en-XA");
  });

  it("never selects the pseudo-locale unless it is allowed, and never by language fallback", () => {
    expect(resolveLocale({ user: "en-XA", pseudoAllowed: false })).toBe("en");
    expect(matchLocale("en-GB", true)).toBe("en");
    expect(matchLocale("EN-xa", true)).toBe("en-XA");
    // Not allowed: it is read as the English it pretends to be.
    expect(matchLocale("en-XA", false)).toBe("en");
    expect(selectableLocales(false)).toEqual(["en"]);
    expect(selectableLocales(true)).toEqual(["en", "en-XA"]);
  });

  it("follows the account's choice from /me and puts it on <html lang>", async () => {
    const f = pseudoFixtures();
    installMockApi({
      "GET /api/v1/me": () => [200, f.me],
      "GET /api/v1/modules": () => [200, f.bootstrap],
    });
    await renderApp("/");
    await waitFor(() => expect(currentLocale()).toBe("en-XA"));
    expect(document.documentElement.lang).toBe("en-XA");
    expect(document.documentElement.dir).toBe("ltr");
    expect(await screen.findByRole("navigation", { name: m.nav_primary() })).toBeInTheDocument();
  });

  it("ignores a stored pseudo-locale when the operator has not enabled it", async () => {
    installMockApi({
      "GET /api/v1/me": () => [200, pseudoFixtures().me],
      "GET /api/v1/modules": () => [200, bootstrap({ pseudoLocale: false })],
    });
    await renderApp("/");
    expect(
      await screen.findByRole("heading", { name: /Welcome, Ada Lovelace/u }),
    ).toBeInTheDocument();
    expect(currentLocale()).toBe("en");
  });
});

describe("language settings", () => {
  it("lets an investor choose a language: saved to the account, applied at once", async () => {
    const { calls } = installMockApi({
      "GET /api/v1/me": () => [200, me()],
      "GET /api/v1/modules": () => [200, bootstrap({ pseudoLocale: true })],
      "PUT /api/v1/me/locale": ({ body }) => [200, body],
    });
    const r = await renderApp("/settings");
    const select = await screen.findByLabelText("Language");
    expect(
      within(select).getByRole("option", { name: "Workspace default (English)" }),
    ).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
    const user = userEvent.setup();
    await user.selectOptions(select, "en-XA");
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PUT" && c.path === "/api/v1/me/locale")?.body).toEqual(
        {
          locale: "en-XA",
        },
      ),
    );
    await waitFor(() => expect(document.documentElement.lang).toBe("en-XA"));
    expect(m.language_title()).toMatch(/^⟦/u);
    expect((await screen.findAllByText(m.language_title())).length).toBeGreaterThan(0);
    // …and back to the workspace default.
    await user.selectOptions(await screen.findByLabelText(m.language_label()), "");
    await waitFor(() =>
      expect(calls.filter((c) => c.path === "/api/v1/me/locale").at(-1)?.body).toEqual({
        locale: null,
      }),
    );
    await waitFor(() => expect(document.documentElement.lang).toBe("en"));
  }, 20_000);

  it("does not offer the pseudo-locale where it is not enabled", async () => {
    installMockApi({
      "GET /api/v1/me": () => [200, me()],
      "GET /api/v1/modules": () => [200, bootstrap()],
    });
    await renderApp("/settings");
    const select = await screen.findByLabelText("Language");
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.getAttribute("value")),
    ).toEqual(["", "en"]);
  });

  it("lets an admin set the workspace default on the access settings page", async () => {
    const staff = bootstrap({
      pseudoLocale: true,
      membership: { id: "m-staff", kind: "staff", role: "owner" },
      permissions: ["access.read", "access.settings"],
      modules: [],
    });
    const { calls } = installMockApi({
      "GET /api/v1/me": () => [
        200,
        me({
          membership: membership({ kind: "staff", role: "owner" }),
          session: session({ population: "staff", authLevel: 2 }),
        }),
      ],
      "GET /api/v1/modules": () => [200, staff],
      "GET /api/v1/access/settings": () => [
        200,
        {
          requireMfaForStaff: true,
          requireMfaForExternal: false,
          inviteExpiryDays: 7,
          allowDelegates: true,
          maxDelegatesPerPrincipal: 3,
          requests: {
            enabled: false,
            autoApproveDomains: [],
            defaultGroupIds: [],
            pendingExpiryDays: 30,
          },
        },
      ],
      "PUT /api/v1/workspace/locale": ({ body }) => [200, body],
    });
    const r = await renderApp("/admin/settings/access");
    const select = await screen.findByLabelText("Default language", {}, { timeout: 5000 });
    const user = userEvent.setup();
    await user.selectOptions(select, "en-XA");
    const card = select.closest("form") as HTMLElement;
    await user.click(within(card).getByRole("button", { name: "Save default language" }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === "/api/v1/workspace/locale")?.body).toEqual({
        defaultLocale: "en-XA",
      }),
    );
    await expectNoA11yViolations(r.container);
  }, 20_000);
});

describe("investor screens under en-XA: no untranslated text", () => {
  it("sign-in screen", async () => {
    asPseudoReader();
    installMockApi({
      "GET /api/v1/me": () => apiError(401, "unauthenticated"),
      "GET /api/v1/modules": () => [
        200,
        bootstrap({ pseudoLocale: true, membership: null, permissions: [] }),
      ],
    });
    const r = await renderApp("/login");
    await screen.findAllByRole("button", { name: /^⟦/u }, { timeout: 5000 });
    expect(untranslated(r.container, COMMON_DATA)).toEqual([]);
  }, 20_000);

  it("portal home and navigation", async () => {
    asPseudoReader();
    const f = pseudoFixtures();
    installMockApi({
      "GET /api/v1/me": () => [200, f.me],
      "GET /api/v1/modules": () => [200, f.bootstrap],
    });
    const r = await renderApp("/");
    await screen.findByRole("navigation", { name: m.nav_primary() });
    await screen.findByRole("heading", { name: m.home_welcome({ name: "Ada Lovelace" }) });
    expect(untranslated(r.container, COMMON_DATA)).toEqual([]);
  }, 20_000);

  it("account settings (profile, memberships, language, analytics notice)", async () => {
    asPseudoReader();
    const f = pseudoFixtures();
    installMockApi({
      "GET /api/v1/me": () => [200, f.me],
      "GET /api/v1/modules": () => [200, f.bootstrap],
    });
    const r = await renderApp("/settings");
    await screen.findByText(m.language_subtitle(), {}, { timeout: 5000 });
    // `investor` and `active` are role/status codes shown verbatim by the memberships table.
    expect(untranslated(r.container, [...COMMON_DATA, "investor", "active"])).toEqual([]);
  }, 20_000);

  it("updates archive", async () => {
    asPseudoReader();
    const f = pseudoFixtures();
    installMockApi({
      "GET /api/v1/me": () => [200, f.me],
      "GET /api/v1/modules": () => [200, f.bootstrap],
      "GET /api/v1/updates/archive": () => [
        200,
        {
          posts: [
            {
              id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f01",
              slug: "september-2026-update",
              title: "September 2026 update",
              sentAt: NOW,
              versionNo: 1,
            },
          ],
          subscribed: true,
        },
      ],
    });
    const r = await renderApp("/updates");
    await screen.findByRole("link", { name: "September 2026 update" }, { timeout: 5000 });
    expect(untranslated(r.container, [...COMMON_DATA, "September 2026 update"])).toEqual([]);
  }, 20_000);

  it("an update, with its disclaimer and the reply thread", async () => {
    asPseudoReader();
    const f = pseudoFixtures();
    const postId = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f01";
    installMockApi({
      "GET /api/v1/me": () => [200, f.me],
      "GET /api/v1/modules": () => [200, f.bootstrap],
      "GET /api/v1/updates/archive/{slug}": () => [
        200,
        {
          post: { id: postId, slug: "q3", title: "Q3 update", sentAt: NOW, versionNo: 1 },
          version: { id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f02", versionNo: 1, createdAt: NOW },
          sections: [
            {
              key: "recap",
              title: "Recap",
              blocks: [
                {
                  id: "t",
                  type: "rich_text",
                  schemaVersion: 1,
                  data: { format: "markdown", text: "We shipped." },
                },
                {
                  id: "d",
                  type: "disclaimer",
                  schemaVersion: 1,
                  data: {
                    slug: "offering-disclaimer",
                    hydrated: {
                      slug: "offering-disclaimer",
                      title: "Offering disclaimer",
                      versionNo: 3,
                      body: "Not an offer.",
                      effectiveAt: NOW,
                    },
                  },
                },
              ],
            },
          ],
          viewer: "external",
        },
      ],
      "GET /api/v1/updates/posts/{id}/replies": () => [
        200,
        {
          threads: [
            {
              membershipId: "m1",
              displayName: "Ada",
              replies: [
                {
                  id: "r1",
                  authorMembershipId: "m1",
                  authorName: "Ada",
                  authorKind: "external",
                  body: "Congrats!",
                  createdAt: NOW,
                },
              ],
            },
          ],
        },
      ],
    });
    const r = await renderApp("/updates/q3");
    await screen.findByText("Congrats!", {}, { timeout: 5000 });
    // The author's words (title, section, body, disclaimer) are data; the chrome is not.
    const data = [
      "Q3 update",
      "Recap",
      "We shipped.",
      "Offering disclaimer",
      "Not an offer.",
      "Congrats!",
    ];
    expect(untranslated(r.container, [...COMMON_DATA, ...data])).toEqual([]);
  }, 20_000);

  it("data room browser", async () => {
    asPseudoReader();
    const allowed = {
      allowed: true,
      capabilities: ["view"],
      pendingGates: [],
      reason: "granted",
    } as const;
    const f = pseudoFixtures({
      modules: [
        {
          id: "data-room",
          version: "0.1.0",
          enabled: true,
          hidden: false,
          readOnly: false,
          flags: {},
          slots: {
            "investor.nav": [{ id: "data-room", label: "Data room", to: "/data-room", order: 20 }],
          },
        },
      ],
    });
    const doc = (id: string, title: string, index: string) => ({
      id,
      folderId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e00",
      title,
      index,
      sortOrder: 0,
      protection: { download: false, watermark: true, print: false },
      legalHold: false,
      currentVersionId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e04",
      contentType: "application/pdf",
      sizeBytes: 1234,
      pageCount: 3,
      renderStatus: "ready",
      scanStatus: "clean",
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
      purgeAfter: null,
      access: allowed,
    });
    installMockApi({
      "GET /api/v1/me": () => [200, f.me],
      "GET /api/v1/modules": () => [200, f.bootstrap],
      "GET /api/v1/data-room/tree": () => [
        200,
        {
          rootId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e00",
          folders: [
            {
              id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e01",
              parentId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e00",
              name: "Legal",
              path: "r.legal",
              index: "1",
              sortOrder: 1,
              createdAt: NOW,
              updatedAt: NOW,
              deletedAt: null,
              purgeAfter: null,
              access: allowed,
              passthrough: false,
            },
          ],
          documents: [doc("0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e02", "Pitch deck", "2")],
        },
      ],
    });
    const r = await renderApp("/data-room");
    await screen.findByText("Pitch deck", {}, { timeout: 5000 });
    // `PDF` is the file type, shown as data.
    expect(untranslated(r.container, [...COMMON_DATA, "Legal", "Pitch deck", "PDF"])).toEqual([]);
  }, 20_000);
});
