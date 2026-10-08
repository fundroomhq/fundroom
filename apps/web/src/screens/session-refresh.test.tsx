import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureApi, createQueryClient } from "../lib/api.js";
import { bootstrapQuery, meQuery, refreshSession } from "../lib/queries.js";
import { bootstrap, login, me, session, testConfig } from "../test/fixtures.js";
import { apiError, installMockApi } from "../test/mock-api.js";
import { pathOf, renderApp } from "../test/render.js";

afterEach(() => vi.unstubAllGlobals());

/*
 * E3.2 regression (found by the real-Chromium e2e run): the sign-in screen asks for the
 * bootstrap while signed out (`requestAccessEnabled`), which answers `membership: null`. With a
 * 30 s staleTime and `refreshSession` refetching only `/me`, `_portal` and `/admin` then rendered
 * that signed-out answer right after sign-in: "You don't have access here" for an active member.
 */
function signInHandlers(signedInMe: ReturnType<typeof me>, member: ReturnType<typeof bootstrap>) {
  let signedIn = false;
  return installMockApi({
    "GET /api/v1/me": () => (signedIn ? [200, signedInMe] : apiError(401, "unauthenticated")),
    "GET /api/v1/modules": () =>
      signedIn
        ? [200, member]
        : [200, bootstrap({ membership: null, permissions: [], requestAccessEnabled: true })],
    "POST /api/v1/auth/otp/start": () => [
      200,
      { status: "sent", emailHint: "a***@b.co", ttlMinutes: 10 },
    ],
    "POST /api/v1/auth/otp/verify": () => {
      signedIn = true;
      return [200, login()];
    },
  });
}

async function signInWithCode() {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText(/Email address/u), "ada@example.com");
  await user.click(screen.getByRole("button", { name: /Email me a code/u }));
  await user.type(await screen.findByLabelText(/One-time code/u), "654321");
}

describe("sign-in refreshes the session-dependent cache", () => {
  it("shows the portal, not the no-access screen, to a member who just signed in", async () => {
    signInHandlers(me(), bootstrap());
    const r = await renderApp(
      "/",
      testConfig({ auth: { methods: ["email_otp"], passkeyRpId: "x" } }),
    );
    await waitFor(() => expect(pathOf(r.router)).toContain("/login"));
    // The sign-in screen has fetched (and cached) the signed-out bootstrap.
    expect(await screen.findByRole("link", { name: /Request access/iu })).toBeInTheDocument();

    await signInWithCode();

    await waitFor(() => expect(pathOf(r.router)).toBe("/"));
    expect(await screen.findByRole("heading", { name: /Welcome/u })).toBeInTheDocument();
    expect(screen.queryByText(/You don't have access here/u)).toBeNull();
  }, 20_000);

  it("shows the admin overview, not not-found, to staff who just signed in", async () => {
    const staff = { id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b70", kind: "staff" as const };
    signInHandlers(
      me({
        session: session({ population: "staff" }),
        membership: { ...staff, role: "owner", status: "active" },
      }),
      bootstrap({ membership: { ...staff, role: "owner" }, permissions: ["access.manage"] }),
    );
    const r = await renderApp(
      "/admin",
      testConfig({ tree: "admin", auth: { methods: ["email_otp"], passkeyRpId: "x" } }),
    );
    await waitFor(() => expect(pathOf(r.router)).toContain("/login"));
    expect(await screen.findByRole("link", { name: /Request access/iu })).toBeInTheDocument();

    await signInWithCode();

    await waitFor(() => expect(pathOf(r.router)).toBe("/admin"));
    expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument();
    expect(screen.queryByText(/Page not found/u)).toBeNull();
  }, 20_000);
});

describe("refreshSession", () => {
  const otherUser = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b99";

  async function setup(next: () => ReturnType<typeof me>) {
    configureApi(testConfig().apiBase);
    let current = () => me();
    installMockApi({
      "GET /api/v1/me": () => [200, current()],
      "GET /api/v1/modules": () => [
        200,
        bootstrap({
          permissions: [`${current().session.userId}@${current().session.authLevel}`],
        }),
      ],
    });
    const qc = createQueryClient();
    qc.setDefaultOptions({ queries: { ...qc.getDefaultOptions().queries, retry: false } });
    await qc.fetchQuery(meQuery);
    await qc.fetchQuery(bootstrapQuery);
    await qc.fetchQuery({
      queryKey: ["access", "people", {}],
      queryFn: () => ({ people: ["previous user's data"] }),
    });
    current = next;
    return qc;
  }

  it("drops every other cached answer when the identity changes", async () => {
    const qc = await setup(() => me({ session: session({ userId: otherUser }) }));
    await refreshSession(qc);
    expect(qc.getQueryData(meQuery.queryKey)?.session.userId).toBe(otherUser);
    expect(qc.getQueryData(bootstrapQuery.queryKey)?.permissions).toEqual([`${otherUser}@1`]);
    expect(qc.getQueryData(["access", "people", {}])).toBeUndefined();
  });

  it("keeps the cache but still refetches the bootstrap for the same identity", async () => {
    const qc = await setup(() => me({ session: session({ authLevel: 2 }) }));
    await refreshSession(qc);
    expect(qc.getQueryData(meQuery.queryKey)?.session.authLevel).toBe(2);
    // The bootstrap is refetched even though the identity did not change.
    expect(qc.getQueryData(bootstrapQuery.queryKey)?.permissions?.[0]).toMatch(/@2$/u);
    expect(qc.getQueryData(["access", "people", {}])).toEqual({
      people: ["previous user's data"],
    });
  });
});
