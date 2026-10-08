import type { AuthzPort, Capability, ResourceRef, SubjectRef } from "@fundroom/ports";
import { beforeAll, describe, expect, it } from "vitest";

/*
 * Behavioural contract of `AuthzPort.check` / `listAccessible` for EXTERNAL principals (E3.13,
 * ADR-0061): one fixture world — a folder tree with documents, groups, a share link, a role rule,
 * excludes and validity windows — and the answers every engine composition must give on it. Run
 * against the Postgres service, and against the composed service with an external relationship
 * engine in `shadow` and `enforce` mode: the engine may never change these answers while it is in
 * sync.
 *
 * The caller materialises `AUTHZ_CONTRACT_FIXTURE` (the suite does not know the storage) and hands
 * back the port plus the ids it minted. Validity windows are relative to the moment the caller
 * builds the world (`contractWindow`).
 *
 * `listAccessible` follows the Postgres materialisation: it lists the nodes a member's own rules
 * name (with `view`), not every node `check` would allow below them.
 */

export type ContractMember = "alice" | "bob" | "carol" | "dave" | "erin" | "frank";
export type ContractFolder = "root" | "a" | "a1" | "b";
export type ContractDocument = "dRoot" | "dA" | "dA1" | "dB";
export type ContractNode = ContractFolder | ContractDocument;
export type ContractGroup = "g" | "h1" | "h2";
export type ContractLink = "l";
export type ContractWindow = "always" | "expired" | "future" | "current";

export type ContractSubject =
  | { readonly kind: "membership"; readonly member: ContractMember }
  | { readonly kind: "group"; readonly group: ContractGroup }
  | { readonly kind: "link"; readonly link: ContractLink }
  | { readonly kind: "role"; readonly role: "investor" };

export interface ContractRule {
  readonly name: string;
  readonly subject: ContractSubject;
  readonly node: ContractNode;
  readonly capability: Capability;
  readonly effect: "allow" | "exclude";
  readonly window: ContractWindow;
  /** Written and then revoked (`revoked_at` set): must count for nothing. */
  readonly revoked?: true | undefined;
}

export interface AuthzContractFixture {
  /** Parent first. `root` has none. */
  readonly folders: readonly {
    readonly name: ContractFolder;
    readonly parent: ContractFolder | null;
  }[];
  readonly documents: readonly {
    readonly name: ContractDocument;
    readonly folder: ContractFolder;
  }[];
  /** All external, active, role `investor`, not delegates. */
  readonly members: readonly ContractMember[];
  readonly groups: readonly {
    readonly name: ContractGroup;
    readonly members: readonly ContractMember[];
  }[];
  /** Live links with their (live) visitor bindings. */
  readonly links: readonly {
    readonly name: ContractLink;
    readonly visitors: readonly ContractMember[];
  }[];
  readonly rules: readonly ContractRule[];
}

export const AUTHZ_CONTRACT_FIXTURE: AuthzContractFixture = {
  folders: [
    { name: "root", parent: null },
    { name: "a", parent: "root" },
    { name: "a1", parent: "a" },
    { name: "b", parent: "root" },
  ],
  documents: [
    { name: "dRoot", folder: "root" },
    { name: "dA", folder: "a" },
    { name: "dA1", folder: "a1" },
    { name: "dB", folder: "b" },
  ],
  members: ["alice", "bob", "carol", "dave", "erin", "frank"],
  groups: [
    { name: "g", members: ["bob", "carol", "frank"] },
    { name: "h1", members: ["alice"] },
    { name: "h2", members: ["alice"] },
  ],
  links: [{ name: "l", visitors: ["erin"] }],
  rules: [
    rule("g-view-a", { kind: "group", group: "g" }, "a", "view"),
    rule("carol-exclude-a1", { kind: "membership", member: "carol" }, "a1", "view", "exclude"),
    rule("bob-view-dA", { kind: "membership", member: "bob" }, "dA", "view"),
    rule("bob-download-dA", { kind: "membership", member: "bob" }, "dA", "download"),
    rule("investors-view-b", { kind: "role", role: "investor" }, "b", "view"),
    rule("dave-exclude-b", { kind: "membership", member: "dave" }, "b", "view", "exclude"),
    rule("h1-comment-a", { kind: "group", group: "h1" }, "a", "comment"),
    rule("h2-exclude-comment-a", { kind: "group", group: "h2" }, "a", "comment", "exclude"),
    rule("l-view-a1", { kind: "link", link: "l" }, "a1", "view"),
    rule("g-exclude-dA1", { kind: "group", group: "g" }, "dA1", "view", "exclude"),
    rule("bob-view-dA1", { kind: "membership", member: "bob" }, "dA1", "view"),
    rule(
      "alice-view-root-expired",
      { kind: "membership", member: "alice" },
      "root",
      "view",
      "allow",
      "expired",
    ),
    rule(
      "alice-view-dRoot-future",
      { kind: "membership", member: "alice" },
      "dRoot",
      "view",
      "allow",
      "future",
    ),
    rule(
      "alice-edit-dA-current",
      { kind: "membership", member: "alice" },
      "dA",
      "edit",
      "allow",
      "current",
    ),
    {
      ...rule("alice-view-a-revoked", { kind: "membership", member: "alice" }, "a", "view"),
      revoked: true,
    },
  ],
};

function rule(
  name: string,
  subject: ContractSubject,
  node: ContractNode,
  capability: Capability,
  effect: "allow" | "exclude" = "allow",
  window: ContractWindow = "always",
): ContractRule {
  return { name, subject, node, capability, effect, window };
}

const DAY_MS = 24 * 3600_000;

/** The validity a fixture window means, relative to `now` (`undefined` = open). */
export function contractWindow(
  window: ContractWindow,
  now: Date,
): { readonly validFrom: Date | undefined; readonly validUntil: Date | undefined } {
  const t = now.getTime();
  switch (window) {
    case "always":
      return { validFrom: undefined, validUntil: undefined };
    case "expired":
      return { validFrom: new Date(t - 2 * DAY_MS), validUntil: new Date(t - DAY_MS) };
    case "future":
      return { validFrom: new Date(t + DAY_MS), validUntil: undefined };
    case "current":
      return { validFrom: new Date(t - DAY_MS), validUntil: new Date(t + DAY_MS) };
  }
}

/** A fixture subject as the port's `SubjectRef`, given the ids the caller minted. */
export function contractSubject(subject: ContractSubject, world: AuthzContractWorld): SubjectRef {
  switch (subject.kind) {
    case "membership":
      return { kind: "membership", id: world.members[subject.member] };
    case "group":
      return { kind: "group", id: world.groups[subject.group] };
    case "link":
      return { kind: "link", id: world.links[subject.link] };
    case "role":
      return { kind: "role", role: subject.role };
  }
}

/** The ids the caller minted for the fixture, and each node as `check` must be asked about it. */
export interface AuthzContractWorld {
  readonly workspaceId: string;
  readonly members: Readonly<Record<ContractMember, string>>;
  readonly groups: Readonly<Record<ContractGroup, string>>;
  readonly links: Readonly<Record<ContractLink, string>>;
  /** Folders with their own path; documents with the path they sit at (their folder's). */
  readonly nodes: Readonly<Record<ContractNode, ResourceRef>>;
}

export interface AuthzContractHarness {
  readonly port: AuthzPort;
  readonly world: AuthzContractWorld;
}

/** Expected `check` answers: [member, node, capability, allowed]. */
export const AUTHZ_CONTRACT_CHECKS: readonly (readonly [
  ContractMember,
  ContractNode,
  Capability,
  boolean,
])[] = [
  // Validity: expired and future rules count for nothing; a current one does.
  ["alice", "root", "view", false],
  ["alice", "dRoot", "view", false],
  ["alice", "dA", "edit", true],
  ["alice", "dA", "view", false],
  // A revoked rule counts for nothing.
  ["alice", "a", "view", false],
  // Full tie (same node, same specificity): the exclude wins.
  ["alice", "a", "comment", false],
  // Role rule.
  ["alice", "b", "view", true],
  ["alice", "dB", "view", true],
  ["alice", "a1", "view", false],
  // Group allow inherited down the tree.
  ["bob", "a", "view", true],
  ["bob", "a1", "view", true],
  ["bob", "dA", "view", true],
  ["bob", "dA", "download", true],
  ["bob", "a", "download", false],
  // Membership beats group at the same node.
  ["bob", "dA1", "view", true],
  ["bob", "b", "view", true],
  ["bob", "dB", "view", true],
  // A nearer exclude beats an inherited allow.
  ["carol", "a", "view", true],
  ["carol", "dA", "view", true],
  ["carol", "a1", "view", false],
  ["carol", "dA1", "view", false],
  ["carol", "b", "view", true],
  // Membership exclude beats the role allow at the same node.
  ["dave", "b", "view", false],
  ["dave", "dB", "view", false],
  ["dave", "a", "view", false],
  // Share-link subject.
  ["erin", "a1", "view", true],
  ["erin", "dA1", "view", true],
  ["erin", "a", "view", false],
  ["erin", "dA", "view", false],
  ["erin", "b", "view", true],
  // An exclude on a document beats the folder's allow.
  ["frank", "a", "view", true],
  ["frank", "dA", "view", true],
  ["frank", "a1", "view", true],
  ["frank", "dA1", "view", false],
];

/** Expected `listAccessible` ids per member and kind. */
export const AUTHZ_CONTRACT_LISTS: Readonly<
  Record<
    ContractMember,
    { readonly folder: readonly ContractFolder[]; readonly document: readonly ContractDocument[] }
  >
> = {
  alice: { folder: ["b"], document: [] },
  bob: { folder: ["a", "b"], document: ["dA", "dA1"] },
  carol: { folder: ["a", "b"], document: [] },
  dave: { folder: [], document: [] },
  erin: { folder: ["a1", "b"], document: [] },
  frank: { folder: ["a", "b"], document: [] },
};

const NOBODY = "00000000-0000-7000-8000-00000000dead";

export function describeAuthzPortContract(
  name: string,
  factory: () => Promise<AuthzContractHarness> | AuthzContractHarness,
): void {
  describe(`AuthzPort contract: ${name}`, () => {
    let h: AuthzContractHarness;
    beforeAll(async () => {
      h = await factory();
    }, 120_000);

    const principal = (m: ContractMember) => ({
      workspaceId: h.world.workspaceId,
      membershipId: h.world.members[m],
    });

    it.each(AUTHZ_CONTRACT_CHECKS)("check(%s, %s, %s) → %s", async (m, node, capability, want) => {
      const d = await h.port.check(principal(m), h.world.nodes[node], capability);
      expect(d.allowed, `${m} ${capability} ${node}: ${JSON.stringify(d)}`).toBe(want);
      // `capabilities` tells the same story as `allowed` for the asked capability (no gates here).
      expect(d.capabilities.includes(capability)).toBe(want);
      expect(d.reason).toBe(want ? "granted" : "no_grant");
    });

    it("an unknown membership is not a member", async () => {
      const d = await h.port.check(
        { workspaceId: h.world.workspaceId, membershipId: NOBODY },
        h.world.nodes.a,
        "view",
      );
      expect(d).toMatchObject({ allowed: false, capabilities: [], reason: "not_member" });
      expect(
        await h.port.listAccessible(
          { workspaceId: h.world.workspaceId, membershipId: NOBODY },
          "folder",
        ),
      ).toEqual([]);
    });

    it.each(Object.keys(AUTHZ_CONTRACT_LISTS) as ContractMember[])(
      "listAccessible(%s) lists exactly the expected folders and documents",
      async (m) => {
        const want = AUTHZ_CONTRACT_LISTS[m];
        for (const kind of ["folder", "document"] as const) {
          const got = await h.port.listAccessible(principal(m), kind);
          const ids = got.map((r) => r.id).sort();
          const expected = (want[kind] as readonly ContractNode[])
            .map((n) => h.world.nodes[n].id)
            .sort();
          expect(ids, `${m} ${kind}`).toEqual(expected);
          for (const r of got) {
            expect(r.kind).toBe(kind);
            expect(r.capabilities).toContain("view");
          }
        }
      },
    );
  });
}
