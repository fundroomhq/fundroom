import { describe, expect, it } from "vitest";
import { classifyRequest, slugHostLocation, stripBasePath } from "./tenancy.js";

const multi = { mode: "multi" as const, canonicalHost: "portal.example.com", basePath: "" };
const single = { mode: "single" as const, canonicalHost: "localhost:3000", basePath: "" };

describe("classifyRequest", () => {
  it("resolves tenant subdomains in multi mode and rejects unknown hosts", () => {
    expect(
      classifyRequest({ host: "acme.portal.example.com", path: "/updates" }, multi),
    ).toMatchObject({
      tree: "app",
      host: "tenant",
      slug: "acme",
    });
    expect(classifyRequest({ host: "PORTAL.example.com:443", path: "/" }, multi)).toMatchObject({
      host: "canonical",
      slug: undefined,
    });
    expect(classifyRequest({ host: "evil.com", path: "/" }, multi)).toMatchObject({
      host: "unknown",
    });
    expect(classifyRequest({ host: "a.b.portal.example.com", path: "/" }, multi)).toMatchObject({
      host: "unknown",
    });
  });

  it("accepts any host in single mode", () => {
    expect(classifyRequest({ host: "10.0.0.5:3000", path: "/" }, single)).toMatchObject({
      host: "canonical",
    });
  });

  it("recognises route trees and path slugs", () => {
    expect(classifyRequest({ host: "localhost:3000", path: "/api/v1/me" }, single)).toMatchObject({
      tree: "api",
    });
    expect(
      classifyRequest({ host: "localhost:3000", path: "/admin/people" }, single),
    ).toMatchObject({ tree: "admin" });
    expect(
      classifyRequest({ host: "localhost:3000", path: "/embed/acme/updates" }, single),
    ).toMatchObject({
      tree: "embed",
      slug: "acme",
      embed: true,
      path: "/embed/acme/updates",
    });
    expect(
      classifyRequest({ host: "localhost:3000", path: "/w/acme/api/v1/me" }, single),
    ).toMatchObject({
      tree: "api",
      slug: "acme",
      path: "/api/v1/me",
    });
    expect(classifyRequest({ host: "localhost:3000", path: "/w/acme" }, single)).toMatchObject({
      tree: "app",
      path: "/",
    });
    expect(
      classifyRequest({ host: "localhost:3000", path: "/embed/Bad_Slug" }, single),
    ).toBeUndefined();
    for (const p of [
      "/healthz",
      "/readyz",
      "/metrics",
      "/.well-known/fundroom.json",
      "/.well-known/seed-host.json",
      "/csp-report",
    ]) {
      expect(classifyRequest({ host: "localhost:3000", path: p }, single)?.tree).toBe("ops");
    }
  });

  it("reserves /embed/<version>/<file> for the loader and refuses version-shaped slugs (E2.2)", () => {
    // The loader is served by the app, not a CDN (E2.2 decision 9), so `v1` and `0.1.0` are the
    // namespace and a workspace can never claim either — `v1` is otherwise a perfectly legal
    // slug, and one that resolved would shadow the loader for the whole install.
    for (const p of [
      "/embed/v1/embed.js",
      "/embed/v1/manifest.json",
      "/embed/0.1.0/embed.mjs",
      // A pre-release is pinned under its own version too (the 1.0 release candidates are).
      "/embed/1.0.0-rc.0/embed.js",
    ]) {
      expect(classifyRequest({ host: "localhost:3000", path: p }, single)).toMatchObject({
        tree: "asset",
        slug: undefined,
        embed: false,
        path: p,
      });
    }
    // A version prefix with nothing, a directory under it, or a file name with a slash in it
    // names no artifact: 404 here rather than falling through to the SPA, which would answer an
    // HTML document to a `<script src>`.
    for (const p of ["/embed/v1", "/embed/v1/", "/embed/v1/a/b", "/embed/0.1.0"]) {
      expect(classifyRequest({ host: "localhost:3000", path: p }, single)).toBeUndefined();
    }
    // A tenant host does not lend the asset tree its slug: the loader has no workspace.
    expect(
      classifyRequest({ host: "acme.portal.example.com", path: "/embed/v1/embed.js" }, multi),
    ).toMatchObject({ tree: "asset", host: "tenant", slug: undefined });
    // Everything else under `/embed/<slug>` is unchanged.
    expect(
      classifyRequest({ host: "localhost:3000", path: "/embed/v1x/embed.js" }, single),
    ).toMatchObject({ tree: "embed", slug: "v1x" });
  });

  it("keeps /embed/<slug>/api in the embed context so the cookie recipe is right (E2.2)", () => {
    // The API under the embed prefix is an API request that is *still* framed: `embed` stays
    // true, so `cookieModeFor` picks `SameSite=None; Partitioned`, and the prefix is stripped
    // from `path` so the routes mount exactly as they do elsewhere.
    expect(
      classifyRequest({ host: "localhost:3000", path: "/embed/acme/api/v1/me" }, single),
    ).toMatchObject({ tree: "api", slug: "acme", embed: true, path: "/api/v1/me" });
    // The bare prefix, with no version under it, is still the API tree — and 404s there rather
    // than falling through to the SPA.
    expect(
      classifyRequest({ host: "localhost:3000", path: "/embed/acme/api" }, single),
    ).toMatchObject({ tree: "api", slug: "acme", embed: true, path: "/api" });
    // The document itself keeps its prefix and its tree.
    expect(
      classifyRequest({ host: "localhost:3000", path: "/embed/acme/updates" }, single),
    ).toMatchObject({ tree: "embed", slug: "acme", embed: true, path: "/embed/acme/updates" });
    // The loader carve-out is ahead of all of it and has no workspace at all.
    expect(
      classifyRequest({ host: "localhost:3000", path: "/embed/v1/embed.js" }, single),
    ).toMatchObject({ tree: "asset", slug: undefined, embed: false });
    // A path that merely starts with the letters is not the API: `/apiary` is a page.
    expect(
      classifyRequest({ host: "localhost:3000", path: "/embed/acme/apiary" }, single),
    ).toMatchObject({ tree: "embed", path: "/embed/acme/apiary" });
    // Under a base path, both halves still work.
    const based = { ...single, basePath: "/investors" };
    expect(
      classifyRequest({ host: "localhost:3000", path: "/investors/embed/acme/api/v1/me" }, based),
    ).toMatchObject({ tree: "api", slug: "acme", embed: true, path: "/api/v1/me" });
  });

  it("routes the accreditation vendor callback (E3.7) to ops: one lower-case uuid, no slug", () => {
    const id = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b6a";
    expect(
      classifyRequest({ host: "portal.example.com", path: `/webhooks/accreditation/${id}` }, multi),
    ).toMatchObject({ tree: "ops", slug: undefined });
    expect(
      classifyRequest({ host: "localhost:3000", path: `/webhooks/accreditation/${id}` }, single),
    ).toMatchObject({ tree: "ops" });
    for (const path of [
      `/webhooks/accreditation/${id.toUpperCase()}`,
      `/webhooks/accreditation/${id}/x`,
      "/webhooks/accreditation/not-a-uuid",
    ]) {
      expect(classifyRequest({ host: "localhost:3000", path }, single)).toMatchObject({
        tree: "app",
      });
    }
    expect(
      classifyRequest(
        { host: "localhost:3000", path: `/w/acme/webhooks/accreditation/${id}` },
        single,
      ),
    ).toMatchObject({ tree: "app", slug: "acme" });
  });

  it("routes the integrations ops paths (E3.6): booking webhooks and the OAuth handshake", () => {
    const id = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b6a";
    // Booking webhook: any host without a slug, one lower-case uuid, nothing nested.
    expect(
      classifyRequest({ host: "portal.example.com", path: `/webhooks/integrations/${id}` }, multi),
    ).toMatchObject({ tree: "ops", slug: undefined });
    expect(
      classifyRequest({ host: "localhost:3000", path: `/webhooks/integrations/${id}` }, single),
    ).toMatchObject({ tree: "ops" });
    expect(
      classifyRequest(
        { host: "localhost:3000", path: `/webhooks/integrations/${id.toUpperCase()}` },
        single,
      ),
    ).toMatchObject({ tree: "app" });
    expect(
      classifyRequest({ host: "localhost:3000", path: `/webhooks/integrations/${id}/x` }, single),
    ).toMatchObject({ tree: "app" });
    expect(
      classifyRequest(
        { host: "localhost:3000", path: `/w/acme/webhooks/integrations/${id}` },
        single,
      ),
    ).toMatchObject({ tree: "app", slug: "acme" });
    // OAuth start/callback: canonical host and no slug only.
    for (const path of ["/oauth/integrations/start", "/oauth/integrations/callback"]) {
      expect(classifyRequest({ host: "portal.example.com", path }, multi)).toMatchObject({
        tree: "ops",
        host: "canonical",
        slug: undefined,
      });
      expect(classifyRequest({ host: "localhost:3000", path }, single)).toMatchObject({
        tree: "ops",
      });
      expect(classifyRequest({ host: "acme.portal.example.com", path }, multi)).toMatchObject({
        tree: "app",
        slug: "acme",
      });
      expect(classifyRequest({ host: "investors.acme.com", path }, multi)).toMatchObject({
        tree: "app",
        host: "unknown",
      });
      expect(
        classifyRequest({ host: "portal.example.com", path: `/w/acme${path}` }, multi),
      ).toMatchObject({ tree: "app", slug: "acme" });
    }
    expect(
      classifyRequest({ host: "localhost:3000", path: "/oauth/integrations/other" }, single),
    ).toMatchObject({ tree: "app" });
    const based = { ...single, basePath: "/investors" };
    expect(
      classifyRequest(
        { host: "localhost:3000", path: "/investors/oauth/integrations/callback" },
        based,
      ),
    ).toMatchObject({ tree: "ops", path: "/oauth/integrations/callback" });
  });

  it("routes the SSO IdP endpoints and SCIM (E3.8) to ops: canonical host, no slug", () => {
    const id = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b6a";
    const ssoPaths = [
      `/sso/oidc/${id}/callback`,
      `/sso/saml/${id}/acs`,
      `/sso/saml/${id}/metadata`,
    ];
    const scimPaths = ["/scim/v2", "/scim/v2/Users", `/scim/v2/Users/${id}`, "/scim/v2/Groups"];
    for (const path of [...ssoPaths, ...scimPaths]) {
      expect(classifyRequest({ host: "portal.example.com", path }, multi)).toMatchObject({
        tree: "ops",
        host: "canonical",
        slug: undefined,
        path,
      });
      expect(classifyRequest({ host: "localhost:3000", path }, single)).toMatchObject({
        tree: "ops",
      });
      // Never on a tenant host, a /w/<slug> path or an unknown (custom-domain) host.
      expect(classifyRequest({ host: "acme.portal.example.com", path }, multi)).toMatchObject({
        tree: "app",
        slug: "acme",
      });
      expect(classifyRequest({ host: "investors.acme.com", path }, multi)).toMatchObject({
        tree: "app",
        host: "unknown",
      });
      expect(
        classifyRequest({ host: "portal.example.com", path: `/w/acme${path}` }, multi),
      ).toMatchObject({ tree: "app", slug: "acme" });
    }
    for (const path of [
      `/sso/oidc/${id.toUpperCase()}/callback`,
      `/sso/oidc/${id}/acs`,
      `/sso/saml/${id}/callback`,
      `/sso/saml/${id}/acs/x`,
      "/sso/saml/not-a-uuid/acs",
      "/sso",
      "/scim",
      "/scim/v1/Users",
      "/scim/v2x",
    ]) {
      expect(classifyRequest({ host: "localhost:3000", path }, single)).toMatchObject({
        tree: "app",
      });
    }
    // After the base path.
    const based = { ...single, basePath: "/investors" };
    expect(
      classifyRequest({ host: "localhost:3000", path: `/investors/sso/saml/${id}/acs` }, based),
    ).toMatchObject({ tree: "ops", path: `/sso/saml/${id}/acs` });
    expect(
      classifyRequest({ host: "localhost:3000", path: "/investors/scim/v2/Users" }, based),
    ).toMatchObject({ tree: "ops", path: "/scim/v2/Users" });
  });

  it("lets the host slug win over a path slug on a tenant host (E3.10)", () => {
    // `acme.<canonical>/w/beta/...` names two workspaces; before E3.10 the path slug won and the
    // request rendered beta on acme's host (a tenant could host a page for another tenant).
    for (const path of ["/w/beta", "/w/beta/api/v1/me", "/embed/beta", "/embed/beta/api/v1/me"]) {
      expect(
        classifyRequest({ host: "acme.portal.example.com", path }, multi),
        path,
      ).toBeUndefined();
    }
    // The same slug in both places still routes (and keeps its embed context).
    expect(
      classifyRequest({ host: "acme.portal.example.com", path: "/w/acme/api/v1/me" }, multi),
    ).toMatchObject({ tree: "api", host: "tenant", slug: "acme", path: "/api/v1/me" });
    expect(
      classifyRequest({ host: "acme.portal.example.com", path: "/embed/acme/updates" }, multi),
    ).toMatchObject({ tree: "embed", host: "tenant", slug: "acme", embed: true });
    // On the canonical host a path slug is still the only slug.
    expect(
      classifyRequest({ host: "portal.example.com", path: "/w/beta/api/v1/me" }, multi),
    ).toMatchObject({ tree: "api", host: "canonical", slug: "beta" });
    // The embed loader's reserved namespace is unaffected.
    expect(
      classifyRequest({ host: "acme.portal.example.com", path: "/embed/v1/embed.js" }, multi),
    ).toMatchObject({ tree: "asset" });
  });

  it("classifies the billing webhook as ops on the canonical host only (E3.10)", () => {
    const path = "/webhooks/billing/stripe";
    expect(classifyRequest({ host: "portal.example.com", path }, multi)).toMatchObject({
      tree: "ops",
      host: "canonical",
      slug: undefined,
      path,
    });
    expect(classifyRequest({ host: "acme.portal.example.com", path }, multi)).toMatchObject({
      tree: "app",
    });
    expect(
      classifyRequest({ host: "portal.example.com", path: `/w/acme${path}` }, multi),
    ).toMatchObject({ tree: "app", slug: "acme" });
    expect(
      classifyRequest({ host: "portal.example.com", path: "/webhooks/billing/other" }, multi),
    ).toMatchObject({ tree: "app" });
    // Central auth is app-tree on purpose: it needs the tenant host's resolution and the session.
    expect(
      classifyRequest({ host: "acme.portal.example.com", path: "/auth/central/start" }, multi),
    ).toMatchObject({ tree: "app", host: "tenant", slug: "acme" });
  });

  it("with the control plane on, sends /w/<slug> on the canonical host to the slug host (E3.10 FR1)", () => {
    const cp = { ...multi, slugHostRedirect: { protocol: "https:" } };
    const host = "portal.example.com";
    // `redirect` is the target's origin (+ base); the middleware appends the raw rest.
    expect(classifyRequest({ host, path: "/w/acme/documents/x" }, cp)).toMatchObject({
      slug: "acme",
      redirect: "https://acme.portal.example.com",
    });
    // The API under it is not served on the operator console's origin at all.
    expect(classifyRequest({ host, path: "/w/acme/api/v1/me" }, cp)).toBeUndefined();
    expect(classifyRequest({ host, path: "/w/acme/api" }, cp)).toBeUndefined();
    // With a base path, the target keeps it.
    expect(
      classifyRequest({ host, path: "/ir/w/acme/admin" }, { ...cp, basePath: "/ir" })?.redirect,
    ).toBe("https://acme.portal.example.com/ir");
    // Everything else is untouched: the canonical host's own pages, and the slug host itself.
    expect(classifyRequest({ host, path: "/platform" }, cp)?.redirect).toBeUndefined();
    expect(
      classifyRequest({ host: "acme.portal.example.com", path: "/w/acme/x" }, cp)?.redirect,
    ).toBeUndefined();
    // Control plane off: the path slug is served as before.
    expect(classifyRequest({ host, path: "/w/acme/api/v1/me" }, multi)).toMatchObject({
      tree: "api",
      slug: "acme",
    });
    expect(classifyRequest({ host, path: "/w/acme/x" }, multi)?.redirect).toBeUndefined();
  });

  it("builds the slug-host Location from the RAW path, percent-encoding kept (E3.10 FR3)", () => {
    const to = "https://acme.portal.example.com";
    expect(slugHostLocation(to, "https://portal.example.com/w/acme/documents/x?tab=2", "")).toBe(
      `${to}/documents/x?tab=2`,
    );
    expect(slugHostLocation(to, "https://portal.example.com/w/acme", "")).toBe(`${to}/`);
    // An encoded slash, question mark, space and non-ASCII stay encoded: one segment, no query.
    expect(
      slugHostLocation(to, "https://portal.example.com/w/acme/docs/a%2Fb%3Fc%20d%C3%A9", ""),
    ).toBe(`${to}/docs/a%2Fb%3Fc%20d%C3%A9`);
    expect(slugHostLocation(`${to}/ir`, "https://portal.example.com/ir/w/acme/x%2Fy", "/ir")).toBe(
      `${to}/ir/x%2Fy`,
    );
  });

  it("handles the base path (ADR-0022)", () => {
    const opts = { ...single, basePath: "/investors" };
    expect(
      classifyRequest({ host: "localhost:3000", path: "/investors/api/v1/me" }, opts),
    ).toMatchObject({ tree: "api", path: "/api/v1/me" });
    expect(classifyRequest({ host: "localhost:3000", path: "/investors" }, opts)).toMatchObject({
      tree: "app",
      path: "/",
    });
    expect(classifyRequest({ host: "localhost:3000", path: "/other" }, opts)).toBeUndefined();
    expect(stripBasePath("/investorsx", "/investors")).toBeUndefined();
  });
});
