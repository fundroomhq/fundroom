import { describe, expect, it } from "vitest";
import {
  gatesFor,
  ipAllowed,
  ndaStamp,
  nodesOf,
  pendingGatesAtRebuild,
  resolveNode,
  rulesFor,
  settleGates,
  subjectsOf,
  withResolvedStamps,
} from "./evaluate.js";
import type { Gate, Principal, Rule } from "./model.js";
import { computeEffectiveRows } from "./rebuild.js";

const NOW = new Date("2026-09-11T12:00:00Z");
const M = "01920000-0000-7000-8000-00000000000a";
const G1 = "01920000-0000-7000-8000-00000000000b";
const G2 = "01920000-0000-7000-8000-00000000000c";
const FOLDER_A = { kind: "folder", id: "01920000-0000-7000-8000-0000000000a0", path: "root.a" };
const FOLDER_AB = { kind: "folder", id: "01920000-0000-7000-8000-0000000000ab", path: "root.a.b" };
const DOC_ABC = { kind: "folder", id: "01920000-0000-7000-8000-000000000abc", path: "root.a.b.c" };
const POST = { kind: "post", id: "01920000-0000-7000-8000-0000000000e0" };
const LINK = "01920000-0000-7000-8000-0000000000f1";
const OTHER_LINK = "01920000-0000-7000-8000-0000000000f2";
const NDA_DOC = "01920000-0000-7000-8000-0000000000d1";

let n = 0;
function rule(over: Partial<Rule> & Pick<Rule, "subject" | "resource" | "capability">): Rule {
  n += 1;
  return {
    grantId: `01920000-0000-7000-8000-0000000000${n.toString(16).padStart(2, "0")}`,
    effect: "allow",
    validFrom: undefined,
    validUntil: undefined,
    ...over,
  };
}

const investor: Principal = {
  membershipId: M,
  kind: "external",
  role: "investor",
  groupIds: [G1],
  linkIds: [],
  attestations: [],
};

/** The same person, admitted through a share link (E2.3): one extra subject, nothing else. */
const visitor: Principal = { ...investor, linkIds: [LINK] };

describe("resolveNode", () => {
  it("unions allows across subjects", () => {
    const rules = [
      rule({ subject: { kind: "membership", id: M }, resource: FOLDER_A, capability: "view" }),
      rule({ subject: { kind: "group", id: G1 }, resource: FOLDER_A, capability: "download" }),
    ];
    const r = resolveNode(rulesFor(rules, investor), DOC_ABC, NOW);
    expect(r.capabilities).toEqual(["view", "download"]);
    expect(r.rules.every((x) => x.inherited && x.decisive)).toBe(true);
  });

  it("nearest rule wins: a subfolder exclude shadows the parent's allow for that subject", () => {
    const rules = [
      rule({ subject: { kind: "group", id: G1 }, resource: FOLDER_A, capability: "view" }),
      rule({
        subject: { kind: "group", id: G1 },
        resource: FOLDER_AB,
        capability: "view",
        effect: "exclude",
      }),
    ];
    expect(resolveNode(rulesFor(rules, investor), FOLDER_A, NOW).capabilities).toEqual(["view"]);
    expect(resolveNode(rulesFor(rules, investor), DOC_ABC, NOW).capabilities).toEqual([]);
  });

  it("a deeper allow from another subject beats a shallower exclude (nearest wins across subjects)", () => {
    const rules = [
      rule({
        subject: { kind: "membership", id: M },
        resource: FOLDER_A,
        capability: "view",
        effect: "exclude",
      }),
      rule({ subject: { kind: "group", id: G1 }, resource: FOLDER_AB, capability: "view" }),
    ];
    expect(resolveNode(rulesFor(rules, investor), DOC_ABC, NOW).capabilities).toEqual(["view"]);
    expect(resolveNode(rulesFor(rules, investor), FOLDER_A, NOW).capabilities).toEqual([]);
  });

  it("at equal depth the person-level exclude beats the group allow ('exclude here only')", () => {
    const rules = [
      rule({ subject: { kind: "group", id: G1 }, resource: FOLDER_AB, capability: "view" }),
      rule({
        subject: { kind: "membership", id: M },
        resource: FOLDER_AB,
        capability: "view",
        effect: "exclude",
      }),
    ];
    const r = resolveNode(rulesFor(rules, investor), DOC_ABC, NOW);
    expect(r.capabilities).toEqual([]);
    expect(r.rules[0]).toMatchObject({ subject: { kind: "membership" }, decisive: true });
    expect(r.rules[1]).toMatchObject({ subject: { kind: "group" }, decisive: false });
  });

  it("two groups tie: exclude wins (deny-safe)", () => {
    const p = { ...investor, groupIds: [G1, G2] };
    const rules = [
      rule({ subject: { kind: "group", id: G1 }, resource: FOLDER_A, capability: "view" }),
      rule({
        subject: { kind: "group", id: G2 },
        resource: FOLDER_A,
        capability: "view",
        effect: "exclude",
      }),
    ];
    expect(resolveNode(rulesFor(rules, p), FOLDER_A, NOW).capabilities).toEqual([]);
  });

  it("the node itself beats every ancestor, whatever the subject", () => {
    const rules = [
      rule({ subject: { kind: "membership", id: M }, resource: FOLDER_A, capability: "view" }),
      rule({
        subject: { kind: "role", role: "investor" },
        resource: DOC_ABC,
        capability: "view",
        effect: "exclude",
      }),
    ];
    expect(resolveNode(rulesFor(rules, investor), DOC_ABC, NOW).capabilities).toEqual([]);
  });

  it("ignores other kinds, unrelated branches and out-of-validity rules", () => {
    const rules = [
      rule({ subject: { kind: "membership", id: M }, resource: POST, capability: "view" }),
      rule({
        subject: { kind: "membership", id: M },
        resource: { kind: "folder", id: "01920000-0000-7000-8000-0000000000ff", path: "root.z" },
        capability: "view",
      }),
      rule({
        subject: { kind: "membership", id: M },
        resource: FOLDER_A,
        capability: "download",
        validUntil: new Date("2026-09-01T00:00:00Z"),
      }),
      rule({
        subject: { kind: "membership", id: M },
        resource: FOLDER_A,
        capability: "comment",
        validFrom: new Date("2026-10-01T00:00:00Z"),
      }),
      rule({
        subject: { kind: "membership", id: M },
        resource: FOLDER_A,
        capability: "view",
        validUntil: new Date("2026-12-31T00:00:00Z"),
      }),
    ];
    const r = resolveNode(rulesFor(rules, investor), DOC_ABC, NOW);
    expect(r.capabilities).toEqual(["view"]);
    expect(r.expiresAt).toEqual(new Date("2026-12-31T00:00:00Z"));
    expect(resolveNode(rulesFor(rules, investor), POST, NOW).capabilities).toEqual(["view"]);
  });

  it("flat resources match by id only", () => {
    const rules = [
      rule({ subject: { kind: "membership", id: M }, resource: POST, capability: "view" }),
    ];
    const other = { kind: "post", id: "01920000-0000-7000-8000-0000000000e1" };
    expect(resolveNode(rules, other, NOW).capabilities).toEqual([]);
    expect(resolveNode(rules, POST, NOW).capabilities).toEqual(["view"]);
  });

  it("nodesOf dedupes resources across rules", () => {
    const rules = [
      rule({ subject: { kind: "membership", id: M }, resource: FOLDER_A, capability: "view" }),
      rule({ subject: { kind: "group", id: G1 }, resource: FOLDER_A, capability: "download" }),
      rule({ subject: { kind: "group", id: G1 }, resource: POST, capability: "view" }),
    ];
    expect(nodesOf(rules).map((r) => r.id)).toEqual([FOLDER_A.id, POST.id]);
  });
});

describe("gates", () => {
  const gates: Gate[] = [
    { policyId: "p1", kind: "nda", config: { version: "v3" }, target: { kind: "workspace" } },
    {
      policyId: "p2",
      kind: "accredited",
      config: { maxAgeDays: 365 },
      target: { kind: "group", id: G1 },
    },
    {
      policyId: "p3",
      kind: "min_auth_level",
      config: { level: 2 },
      target: { kind: "resource", resource: FOLDER_A },
    },
    {
      policyId: "p4",
      kind: "ip_allowlist",
      config: { cidrs: ["10.0.0.0/8", "2001:db8::/32"] },
      target: { kind: "membership", id: M },
    },
    { policyId: "p5", kind: "nda", config: { version: "v9" }, target: { kind: "group", id: G2 } },
  ];

  it("selects gates by workspace, group, membership and resource chain", () => {
    expect(gatesFor(gates, investor, DOC_ABC).map((g) => g.policyId)).toEqual([
      "p1",
      "p2",
      "p3",
      "p4",
    ]);
    expect(gatesFor(gates, investor, POST).map((g) => g.policyId)).toEqual(["p1", "p2", "p4"]);
  });

  it("settles attestation gates at rebuild and leaves session gates pending", () => {
    const signed: Principal = {
      ...investor,
      attestations: [
        { kind: "nda:v3", signedAt: NOW },
        { kind: "accredited", signedAt: new Date("2026-01-01T00:00:00Z") },
      ],
    };
    const pending = pendingGatesAtRebuild(gates, signed, DOC_ABC, NOW);
    expect(pending.map((g) => g.kind)).toEqual(["min_auth_level", "ip_allowlist"]);

    const unsigned = pendingGatesAtRebuild(gates, investor, DOC_ABC, NOW);
    expect(unsigned.map((g) => g.kind)).toEqual([
      "nda",
      "accredited",
      "min_auth_level",
      "ip_allowlist",
    ]);
    expect(unsigned[0]).toMatchObject({ detail: { version: "v3" }, source: "workspace" });
  });

  it("an accreditation older than maxAgeDays counts as missing", () => {
    const stale: Principal = {
      ...investor,
      attestations: [{ kind: "accredited", signedAt: new Date("2024-01-01T00:00:00Z") }],
    };
    expect(pendingGatesAtRebuild(gates, stale, POST, NOW).map((g) => g.kind)).toContain(
      "accredited",
    );
  });

  it("settleGates clears session gates with matching facts", () => {
    const pending = pendingGatesAtRebuild(gates, investor, DOC_ABC, NOW);
    expect(settleGates(pending, { authLevel: 2, ip: "10.1.2.3" }).map((g) => g.kind)).toEqual([
      "nda",
      "accredited",
    ]);
    expect(settleGates(pending, { authLevel: 1, ip: "192.168.1.1" }).map((g) => g.kind)).toEqual([
      "nda",
      "accredited",
      "min_auth_level",
      "ip_allowlist",
    ]);
    expect(settleGates(pending).map((g) => g.kind)).toHaveLength(4);
  });

  it("ipAllowed handles v4, v6, single addresses and junk", () => {
    expect(ipAllowed("10.0.0.1", ["10.0.0.0/8"])).toBe(true);
    expect(ipAllowed("11.0.0.1", ["10.0.0.0/8"])).toBe(false);
    expect(ipAllowed("2001:db8::1", ["2001:db8::/32"])).toBe(true);
    expect(ipAllowed("203.0.113.7", ["203.0.113.7"])).toBe(true);
    expect(ipAllowed("203.0.113.7", ["not-an-ip", "10.0.0.0/99"])).toBe(false);
    expect(ipAllowed(undefined, ["10.0.0.0/8"])).toBe(false);
    expect(ipAllowed("10.0.0.1", [])).toBe(false);
  });
});

describe("computeEffectiveRows", () => {
  it("emits one row per (membership, node), including shadowed nodes with no capability", () => {
    const rules = [
      rule({ subject: { kind: "group", id: G1 }, resource: FOLDER_A, capability: "view" }),
      rule({ subject: { kind: "group", id: G1 }, resource: FOLDER_A, capability: "download" }),
      rule({
        subject: { kind: "membership", id: M },
        resource: FOLDER_AB,
        capability: "view",
        effect: "exclude",
      }),
    ];
    const other: Principal = {
      membershipId: "01920000-0000-7000-8000-00000000000d",
      kind: "external",
      role: "investor",
      groupIds: [],
      linkIds: [],
      attestations: [],
    };
    const rows = computeEffectiveRows([investor, other], rules, [], 7, NOW);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      membershipId: M,
      resourceId: FOLDER_A.id,
      resourcePath: "root.a",
      capabilities: ["view", "download"],
      aclVersion: 7,
    });
    // The exclude node is stored with an empty capability set so has_access() stops there.
    expect(rows[1]).toMatchObject({
      membershipId: M,
      resourceId: FOLDER_AB.id,
      capabilities: ["download"],
    });
  });

  it("dormant or unrelated members produce nothing", () => {
    const rules = [
      rule({ subject: { kind: "group", id: G2 }, resource: FOLDER_A, capability: "view" }),
    ];
    expect(computeEffectiveRows([investor], rules, [], 1, NOW)).toEqual([]);
  });
});

describe("path inheritance across kinds (ADR-0034)", () => {
  it("a folder rule covers a document that carries the folder's path; document rules stay id-only", async () => {
    const { resolveNode: resolve } = await import("./evaluate.js");
    const now = new Date();
    const folderRule = {
      grantId: "g1",
      subject: { kind: "group", id: "grp" } as const,
      resource: { kind: "folder", id: "f1", path: "r.f1" },
      capability: "view" as const,
      effect: "allow" as const,
      validFrom: undefined,
      validUntil: undefined,
    };
    const docExclude = {
      ...folderRule,
      grantId: "g2",
      subject: { kind: "membership", id: "m1" } as const,
      resource: { kind: "document", id: "d1" },
      effect: "exclude" as const,
    };
    const inherited = resolve([folderRule], { kind: "document", id: "d1", path: "r.f1" }, now);
    expect(inherited.capabilities).toEqual(["view"]);
    expect(inherited.rules[0]?.inherited).toBe(true);
    const shadowed = resolve(
      [folderRule, docExclude],
      { kind: "document", id: "d1", path: "r.f1" },
      now,
    );
    expect(shadowed.capabilities).toEqual([]);
    // Another document in the same folder is not touched by d1's rule.
    const sibling = resolve(
      [folderRule, docExclude],
      { kind: "document", id: "d2", path: "r.f1" },
      now,
    );
    expect(sibling.capabilities).toEqual(["view"]);
  });
});

describe("link subjects (E2.3)", () => {
  it("emits one subject per live link, ranked between membership and group", () => {
    const p: Principal = { ...investor, linkIds: [LINK, OTHER_LINK] };
    expect(subjectsOf(p)).toEqual([
      { kind: "membership", id: M },
      { kind: "link", id: LINK },
      { kind: "link", id: OTHER_LINK },
      { kind: "group", id: G1 },
      { kind: "role", role: "investor" },
    ]);
  });

  it("resolves a grant written against the link, so one grant row serves every visitor it admitted", () => {
    const rules = [
      rule({ subject: { kind: "link", id: LINK }, resource: FOLDER_A, capability: "view" }),
    ];
    expect(resolveNode(rulesFor(rules, visitor), DOC_ABC, NOW).capabilities).toEqual(["view"]);
    expect(resolveNode(rulesFor(rules, visitor), DOC_ABC, NOW).rules[0]).toMatchObject({
      subject: { kind: "link", id: LINK },
      decisive: true,
      inherited: true,
    });
  });

  it("contributes nothing once the binding is gone: a revoked, paused or expired link leaves linkIds empty", () => {
    // `PrincipalRepo` filters revoked bindings and non-active links out of `linkIds`; at this
    // layer that is simply a principal with no link subject, and the grant must stop resolving.
    const rules = [
      rule({ subject: { kind: "link", id: LINK }, resource: FOLDER_A, capability: "view" }),
    ];
    expect(rulesFor(rules, investor)).toEqual([]);
    expect(resolveNode(rulesFor(rules, investor), DOC_ABC, NOW).capabilities).toEqual([]);
    // And a visitor holding a *different* link is no better off than a stranger.
    const elsewhere: Principal = { ...investor, linkIds: [OTHER_LINK] };
    expect(resolveNode(rulesFor(rules, elsewhere), DOC_ABC, NOW).capabilities).toEqual([]);
  });

  it("ranks membership > link > group > role at equal depth, so the narrower rule always decides", () => {
    const p: Principal = { ...investor, linkIds: [LINK] };
    const role = rule({
      subject: { kind: "role", role: "investor" },
      resource: FOLDER_A,
      capability: "view",
    });
    const group = rule({
      subject: { kind: "group", id: G1 },
      resource: FOLDER_A,
      capability: "view",
      effect: "exclude",
    });
    const link = rule({
      subject: { kind: "link", id: LINK },
      resource: FOLDER_A,
      capability: "view",
    });
    const member = rule({
      subject: { kind: "membership", id: M },
      resource: FOLDER_A,
      capability: "view",
      effect: "exclude",
    });
    const at = (rules: Rule[]) => resolveNode(rulesFor(rules, p), FOLDER_A, NOW).capabilities;
    expect(at([role, group, link, member])).toEqual([]); // membership excludes
    expect(at([role, group, link])).toEqual(["view"]); // link allows over the group exclude
    expect(at([role, group])).toEqual([]); // group excludes over the role allow
    expect(at([role])).toEqual(["view"]);
  });

  it("an exclude on the link beats an allow inherited from an ancestor", () => {
    const rules = [
      rule({ subject: { kind: "group", id: G1 }, resource: FOLDER_A, capability: "view" }),
      rule({
        subject: { kind: "link", id: LINK },
        resource: FOLDER_AB,
        capability: "view",
        effect: "exclude",
      }),
    ];
    expect(resolveNode(rulesFor(rules, visitor), FOLDER_A, NOW).capabilities).toEqual(["view"]);
    expect(resolveNode(rulesFor(rules, visitor), DOC_ABC, NOW).capabilities).toEqual([]);
  });

  it("a link gate binds only the visitors that link admitted, and names the link as its source", () => {
    const gate: Gate = {
      policyId: "p-link",
      kind: "nda",
      config: { stamp: "mutual-nda:v2" },
      target: { kind: "link", id: LINK },
    };
    expect(gatesFor([gate], visitor, POST).map((g) => g.policyId)).toEqual(["p-link"]);
    expect(gatesFor([gate], investor, POST)).toEqual([]);
    expect(gatesFor([gate], { ...investor, linkIds: [OTHER_LINK] }, POST)).toEqual([]);
    expect(pendingGatesAtRebuild([gate], visitor, POST, NOW)).toEqual([
      {
        kind: "nda",
        detail: { stamp: "mutual-nda:v2", version: "v2", documentId: null },
        source: `link:${LINK}`,
      },
    ]);
  });
});

describe("the nda gate names a document, not a version (E2.3 decision D4)", () => {
  const gate: Gate = {
    policyId: "p-nda",
    kind: "nda",
    config: { documentId: NDA_DOC },
    target: { kind: "workspace" },
  };
  /** What `PolicyRepo.listLiveGates()` reads out of `legal_document.current_version_id`. */
  const atVersion = (n: number) => new Map([[NDA_DOC, `mutual-nda:v${n}`]]);
  const holderOf = (stamp: string): Principal => ({
    ...investor,
    attestations: [{ kind: stamp, signedAt: new Date("2026-01-01T00:00:00Z") }],
  });

  it("settles when the principal holds the stamp the repository resolved", () => {
    const resolved = withResolvedStamps([gate], atVersion(2));
    expect(pendingGatesAtRebuild(resolved, holderOf("mutual-nda:v2"), POST, NOW)).toEqual([]);
    expect(
      pendingGatesAtRebuild(resolved, investor, POST, NOW).map((g) => g.detail["stamp"]),
    ).toEqual(["mutual-nda:v2"]);
  });

  it("puts every holder of the old stamp back to pending when a new version publishes, with no policy rewrite", () => {
    // This is the whole of "re-acceptance on version change": publishing bumps acl_version, the
    // rebuild re-reads the gate, the stamp moves, and the unchanged config still says documentId.
    const holder = holderOf("mutual-nda:v2");
    expect(
      pendingGatesAtRebuild(withResolvedStamps([gate], atVersion(2)), holder, POST, NOW),
    ).toEqual([]);
    expect(
      pendingGatesAtRebuild(withResolvedStamps([gate], atVersion(3)), holder, POST, NOW),
    ).toEqual([
      {
        kind: "nda",
        detail: { stamp: "mutual-nda:v3", version: "v3", documentId: NDA_DOC },
        source: "workspace",
      },
    ]);
    expect(gate.config).toEqual({ documentId: NDA_DOC });
  });

  it("stays shut when the document cannot be resolved, because an NDA that opens on a missing row is worse than one that never opens", () => {
    const unresolved = withResolvedStamps([gate], new Map());
    expect(
      pendingGatesAtRebuild(unresolved, holderOf("mutual-nda:v2"), POST, NOW).map(
        (g) => g.detail["stamp"],
      ),
    ).toEqual(["nda:v1"]);
  });

  it("still honours a legacy { version } config, which the repository leaves untouched", () => {
    const legacy: Gate = {
      policyId: "p-legacy",
      kind: "nda",
      config: { version: "v3" },
      target: { kind: "workspace" },
    };
    expect(withResolvedStamps([legacy], atVersion(9))).toEqual([legacy]);
    expect(pendingGatesAtRebuild([legacy], holderOf("nda:v3"), POST, NOW)).toEqual([]);
    expect(pendingGatesAtRebuild([legacy], investor, POST, NOW)).toEqual([
      {
        kind: "nda",
        detail: { stamp: "nda:v3", version: "v3", documentId: null },
        source: "workspace",
      },
    ]);
    expect(ndaStamp({ version: "v3" })).toBe("nda:v3");
    expect(ndaStamp({})).toBe("nda:v1");
  });

  it("withResolvedStamps leaves gates of other kinds alone", () => {
    const accredited: Gate = {
      policyId: "p-acc",
      kind: "accredited",
      config: { documentId: NDA_DOC, maxAgeDays: 365 },
      target: { kind: "workspace" },
    };
    expect(withResolvedStamps([accredited], atVersion(4))).toEqual([accredited]);
  });
});
