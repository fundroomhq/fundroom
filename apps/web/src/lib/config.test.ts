import { describe, expect, it } from "vitest";
import {
  devWebConfig,
  readWebConfig,
  refreshDevAuth,
  treeForPath,
  WebConfigError,
} from "./config.js";

function docWith(content: string | undefined) {
  return {
    querySelector: () =>
      content === undefined ? null : ({ getAttribute: () => content } as unknown as Element),
  };
}
const loc = { pathname: "/", origin: "http://localhost:5173", hostname: "localhost" };

const valid = {
  v: 1,
  instanceName: "FundRoom",
  serverVersion: "0.1.0",
  tenancy: "multi",
  basePath: "",
  routerBase: "/w/acme",
  apiBase: "/w/acme",
  tree: "app",
  workspace: { slug: "acme", name: "Acme & Co <b>" },
  canonicalOrigin: "https://acme.portal.test",
  embedOrigins: [],
  auth: { methods: ["email_otp"], passkeyRpId: "portal.test" },
  setupRequired: false,
  branding: { name: "Acme", tagline: null, logoUrl: null, tokens: { light: {}, dark: {} } },
};

describe("readWebConfig", () => {
  it("parses the injected meta", () => {
    const c = readWebConfig(docWith(JSON.stringify(valid)), loc);
    expect(c.routerBase).toBe("/w/acme");
    expect(c.workspace?.name).toBe("Acme & Co <b>");
  });
  it("accepts JSON that the server HTML-escaped and the DOM un-escaped", () => {
    // The DOM hands back the decoded attribute value; escaping is invisible here.
    const c = readWebConfig(docWith(JSON.stringify(valid)), loc);
    expect(c.auth.methods).toEqual(["email_otp"]);
  });
  it("reads the A-5 keys, and parses a page from an older server without them", () => {
    const c = readWebConfig(
      docWith(
        JSON.stringify({
          ...valid,
          signup: true,
          signupTerms: { version: 3, url: "https://portal.test/terms" },
          controlPlane: true,
          links: { terms: "https://portal.test/terms", privacy: null, support: null, status: null },
        }),
      ),
      loc,
    );
    expect(c.signupTerms).toEqual({ version: 3, url: "https://portal.test/terms" });
    expect(c.controlPlane).toBe(true);
    expect(c.links?.terms).toBe("https://portal.test/terms");
    const old = readWebConfig(docWith(JSON.stringify(valid)), loc);
    expect(old.links).toBeUndefined();
    expect(old.controlPlane).toBeUndefined();
  });
  it("falls back to the dev config without the meta", () => {
    const c = readWebConfig(docWith(undefined), { ...loc, pathname: "/admin/x" });
    expect(c.serverVersion).toBe("dev");
    expect(c.tree).toBe("admin");
    expect(c.canonicalOrigin).toBe("http://localhost:5173");
  });
  it("throws a clear error on invalid content", () => {
    expect(() => readWebConfig(docWith("{not json"), loc)).toThrow(WebConfigError);
    expect(() => readWebConfig(docWith(JSON.stringify({ ...valid, tree: "nope" })), loc)).toThrow(
      /tree/u,
    );
  });
  it("classifies the tree from the path in dev", () => {
    expect(treeForPath("/embed/acme/updates")).toBe("embed");
    expect(treeForPath("/administrator")).toBe("app");
    expect(treeForPath("/admin")).toBe("admin");
  });
});

describe("refreshDevAuth", () => {
  it("reads auth from /.well-known/fundroom.json under the base path (A-2)", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(url);
      return new Response(
        JSON.stringify({ auth: { methods: ["magic_link"], passkeyRpId: "portal.test" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const base = { ...devWebConfig(loc), basePath: "/investors" };
    const c = await refreshDevAuth(base, fetchImpl);
    expect(seen).toEqual(["/investors/.well-known/fundroom.json"]);
    expect(c.auth).toEqual({ methods: ["magic_link"], passkeyRpId: "portal.test" });
  });
});
