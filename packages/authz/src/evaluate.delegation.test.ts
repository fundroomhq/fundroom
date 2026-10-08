import { describe, expect, it } from "vitest";
import {
  delegatedSubjectsOf,
  gatesFor,
  pendingGatesAtRebuild,
  resolveNode,
  rulesFor,
} from "./evaluate.js";
import {
  DELEGATE_SCOPE_KINDS,
  type DelegateScopeName,
  delegateScopeAdmitsKind,
  type Gate,
  type Principal,
  type Rule,
} from "./model.js";
import { computeEffectiveRows } from "./rebuild.js";

/*
 * Delegation in the pure evaluator (E3.2): what a delegate borrows from its principal, what its
 * scope filters, and what it never borrows. The SQL side (has_access, search, audiences) and the
 * repository's liveness rules are proven end to end in apps/server/src/delegates.integration.test.ts.
 */
const NOW = new Date("2026-09-25T12:00:00Z");
const P = "01920000-0000-7000-8000-0000000000a1"; // principal
const D = "01920000-0000-7000-8000-0000000000d1"; // delegate
const BOARD = "01920000-0000-7000-8000-0000000000b1";
const OWN_GROUP = "01920000-0000-7000-8000-0000000000b2";
const LINK = "01920000-0000-7000-8000-0000000000c1";
const FOLDER = { kind: "folder", id: "01920000-0000-7000-8000-0000000000f1", path: "root.dr" };
const SUB = { kind: "folder", id: "01920000-0000-7000-8000-0000000000f2", path: "root.dr.x" };
const DOC = { kind: "document", id: "01920000-0000-7000-8000-0000000000f3", path: "root.dr.x" };
const POST = { kind: "post", id: "01920000-0000-7000-8000-0000000000e1" };
const PAGE = { kind: "page", id: "01920000-0000-7000-8000-0000000000e2" };

let n = 0;
function rule(over: Partial<Rule> & Pick<Rule, "subject" | "resource" | "capability">): Rule {
  n += 1;
  return {
    grantId: `01920000-0000-7000-8000-0000000001${n.toString(16).padStart(2, "0")}`,
    effect: "allow",
    validFrom: undefined,
    validUntil: undefined,
    ...over,
  };
}

function delegate(scope: DelegateScopeName, extra: Partial<Principal> = {}): Principal {
  return {
    membershipId: D,
    kind: "external",
    role: "delegate",
    groupIds: [],
    linkIds: [],
    attestations: [],
    delegation: { principalMembershipId: P, principalGroupIds: [BOARD], scope },
    ...extra,
  };
}

const principalRules = [
  rule({ subject: { kind: "membership", id: P }, resource: FOLDER, capability: "view" }),
  rule({ subject: { kind: "group", id: BOARD }, resource: POST, capability: "view" }),
  rule({ subject: { kind: "membership", id: P }, resource: PAGE, capability: "view" }),
];

describe("delegation: what a delegate borrows", () => {
  it("borrows the principal's membership and group subjects, never its role or links", () => {
    expect(delegatedSubjectsOf(delegate("all"))).toEqual([
      { kind: "membership", id: P },
      { kind: "group", id: BOARD },
    ]);
    const roleRule = rule({
      subject: { kind: "role", role: "investor" },
      resource: FOLDER,
      capability: "download",
    });
    const linkRule = rule({
      subject: { kind: "link", id: LINK },
      resource: FOLDER,
      capability: "edit",
    });
    // The principal's link is not the delegate's: it is not even in the Principal we hand over.
    const mine = rulesFor([roleRule, linkRule], delegate("all"));
    expect(mine).toEqual([]);
  });

  it("a non-delegate borrows nothing", () => {
    const investor: Principal = { ...delegate("all"), role: "investor", delegation: undefined };
    expect(delegatedSubjectsOf(investor)).toEqual([]);
    expect(rulesFor(principalRules, investor)).toEqual([]);
  });

  it("`all` inherits every allow of the principal", () => {
    expect(rulesFor(principalRules, delegate("all"))).toHaveLength(3);
    expect(resolveNode(rulesFor(principalRules, delegate("all")), DOC, NOW).capabilities).toEqual([
      "view",
    ]);
  });

  it("`data_room` inherits folder/document allows only", () => {
    const mine = rulesFor(principalRules, delegate("data_room"));
    expect(mine.map((r) => r.resource.kind)).toEqual(["folder"]);
    expect(resolveNode(mine, DOC, NOW).capabilities).toEqual(["view"]);
    expect(resolveNode(mine, POST, NOW).capabilities).toEqual([]);
    expect(resolveNode(mine, PAGE, NOW).capabilities).toEqual([]);
  });

  it("`updates` inherits post allows only", () => {
    const mine = rulesFor(principalRules, delegate("updates"));
    expect(mine.map((r) => r.resource.kind)).toEqual(["post"]);
    expect(resolveNode(mine, POST, NOW).capabilities).toEqual(["view"]);
    expect(resolveNode(mine, FOLDER, NOW).capabilities).toEqual([]);
  });

  it("inherits the principal's excludes whatever the scope (never sees what the principal cannot)", () => {
    const exclude = rule({
      subject: { kind: "membership", id: P },
      resource: SUB,
      capability: "view",
      effect: "exclude",
    });
    // An exclude on a kind outside the scope still comes along: it can only take access away.
    const offScope = rule({
      subject: { kind: "membership", id: P },
      resource: FOLDER,
      capability: "download",
      effect: "exclude",
    });
    const own = rule({
      subject: { kind: "membership", id: D },
      resource: FOLDER,
      capability: "download",
    });
    for (const scope of ["all", "data_room", "updates"] as const) {
      const mine = rulesFor([...principalRules, exclude, offScope, own], delegate(scope));
      expect(mine).toContainEqual({ ...exclude, borrowed: true });
      expect(mine).toContainEqual({ ...offScope, borrowed: true });
      // `view`: the borrowed exclude on the subfolder shadows the borrowed allow above it.
      // `download`: the principal's exclude binds the delegate despite its own allow (F4).
      expect(resolveNode(mine, DOC, NOW).capabilities).toEqual([]);
    }
    // The principal's exclude beats the delegate's own allow at the same node.
    const mine = rulesFor([own, offScope], delegate("data_room"));
    expect(resolveNode(mine, FOLDER, NOW).capabilities).toEqual([]);
  });

  it("an unknown scope admits no allow (fail closed) but still takes the excludes", () => {
    const d = delegate("bogus" as DelegateScopeName);
    expect(rulesFor(principalRules, d)).toEqual([]);
    expect(delegateScopeAdmitsKind("bogus" as DelegateScopeName, "folder")).toBe(false);
  });

  it("the scope kind lists are the ones the manifests declare (pinned in the integration test too)", () => {
    expect(DELEGATE_SCOPE_KINDS).toEqual({ data_room: ["folder", "document"], updates: ["post"] });
  });
});

describe("delegation: own and borrowed rules are resolved apart; either side's exclude denies (F4)", () => {
  it("an exclude on `role:delegate` beats an allow borrowed through the principal's group", () => {
    const groupAllow = rule({
      subject: { kind: "group", id: BOARD },
      resource: FOLDER,
      capability: "view",
    });
    const roleExclude = rule({
      subject: { kind: "role", role: "delegate" },
      resource: FOLDER,
      capability: "view",
      effect: "exclude",
    });
    const mine = rulesFor([groupAllow, roleExclude], delegate("all"));
    expect(resolveNode(mine, FOLDER, NOW).capabilities).toEqual([]);
    expect(resolveNode(mine, DOC, NOW).capabilities).toEqual([]);
    // The principal itself is not a delegate: the role rule does not apply to it.
    const principal: Principal = {
      ...delegate("all"),
      membershipId: P,
      role: "investor",
      groupIds: [BOARD],
      delegation: undefined,
    };
    expect(
      resolveNode(rulesFor([groupAllow, roleExclude], principal), FOLDER, NOW).capabilities,
    ).toEqual(["view"]);
  });

  it("an exclude on the delegate's own membership at a folder beats the principal's direct grant on a document inside it", () => {
    const docAllow = rule({
      subject: { kind: "membership", id: P },
      resource: DOC,
      capability: "view",
    });
    const ownExclude = rule({
      subject: { kind: "membership", id: D },
      resource: FOLDER,
      capability: "view",
      effect: "exclude",
    });
    const mine = rulesFor([docAllow, ownExclude], delegate("data_room"));
    expect(resolveNode(mine, DOC, NOW).capabilities).toEqual([]);
  });

  it("materialises that: a document rule has no path, so the rebuild places the node for the delegate's own rules", () => {
    // As stored: a document rule carries no path (ADR-0034 §4); where it sits comes from
    // `documentLocations`. The document's own row is what has_access answers from first.
    const flatDoc = { kind: "document", id: DOC.id };
    const docAllow = rule({
      subject: { kind: "membership", id: P },
      resource: flatDoc,
      capability: "view",
    });
    const ownExclude = rule({
      subject: { kind: "membership", id: D },
      resource: FOLDER,
      capability: "view",
      effect: "exclude",
    });
    const locations = new Map([[`document:${DOC.id}`, DOC.path]]);
    const rows = computeEffectiveRows(
      [delegate("data_room")],
      [docAllow, ownExclude],
      [],
      7,
      NOW,
      locations,
    );
    const docRow = rows.find((r) => r.resourceId === DOC.id);
    expect(docRow?.capabilities).toEqual([]);
    // The row keeps no path: a document row must not cover its siblings.
    expect(docRow?.resourcePath).toBeNull();
    // Borrowed ancestor rules are not pulled in: the principal's folder allow does not widen the
    // delegate's document row beyond the principal's own.
    const folderDownload = rule({
      subject: { kind: "membership", id: P },
      resource: FOLDER,
      capability: "download",
    });
    const widened = computeEffectiveRows(
      [delegate("all")],
      [docAllow, folderDownload],
      [],
      7,
      NOW,
      locations,
    );
    expect(widened.find((r) => r.resourceId === DOC.id)?.capabilities).toEqual(["view"]);
    // And a non-delegate's rows are untouched by locations.
    const investor: Principal = { ...delegate("all"), membershipId: P, delegation: undefined };
    const theirs = computeEffectiveRows([investor], [docAllow], [], 7, NOW, locations);
    expect(theirs.find((r) => r.resourceId === DOC.id)?.capabilities).toEqual(["view"]);
  });

  it("an exclude on one of the delegate's own groups beats a borrowed allow too", () => {
    const allow = rule({
      subject: { kind: "membership", id: P },
      resource: SUB,
      capability: "view",
    });
    const groupExclude = rule({
      subject: { kind: "group", id: OWN_GROUP },
      resource: FOLDER,
      capability: "view",
      effect: "exclude",
    });
    const mine = rulesFor([allow, groupExclude], delegate("all", { groupIds: [OWN_GROUP] }));
    expect(resolveNode(mine, SUB, NOW).capabilities).toEqual([]);
  });

  it("round 2 repro: a `role:delegate` allow above does not beat the principal's exclude below", () => {
    const roleAllow = rule({
      subject: { kind: "role", role: "delegate" },
      resource: FOLDER,
      capability: "view",
    });
    const principalExclude = rule({
      subject: { kind: "membership", id: P },
      resource: SUB,
      capability: "view",
      effect: "exclude",
    });
    const mine = rulesFor([roleAllow, principalExclude], delegate("all"));
    expect(resolveNode(mine, SUB, NOW).capabilities).toEqual([]);
    expect(resolveNode(mine, DOC, NOW).capabilities).toEqual([]);
    // Above the exclude, the delegate's own allow still counts.
    expect(resolveNode(mine, FOLDER, NOW).capabilities).toEqual(["view"]);
  });

  it("round 2 repro: the delegate's own folder allow does not beat the principal's exclude on a document inside (rebuild)", () => {
    const flatDoc = { kind: "document", id: DOC.id };
    const ownAllow = rule({
      subject: { kind: "membership", id: D },
      resource: FOLDER,
      capability: "view",
    });
    const principalExclude = rule({
      subject: { kind: "membership", id: P },
      resource: flatDoc,
      capability: "view",
      effect: "exclude",
    });
    const rows = computeEffectiveRows(
      [delegate("data_room")],
      [ownAllow, principalExclude],
      [],
      7,
      NOW,
      new Map([[`document:${DOC.id}`, DOC.path]]),
    );
    expect(rows.find((r) => r.resourceId === DOC.id)?.capabilities).toEqual([]);
    expect(rows.find((r) => r.resourceId === FOLDER.id)?.capabilities).toEqual(["view"]);
  });

  it("with no exclude on either side, the allows of both sides unite", () => {
    const ownDownload = rule({
      subject: { kind: "membership", id: D },
      resource: FOLDER,
      capability: "download",
    });
    const borrowedView = rule({
      subject: { kind: "membership", id: P },
      resource: FOLDER,
      capability: "view",
    });
    const resolved = resolveNode(
      rulesFor([ownDownload, borrowedView], delegate("data_room")),
      DOC,
      NOW,
    );
    expect(resolved.capabilities).toEqual(["view", "download"]);
    expect(resolved.rules.every((r) => r.decisive)).toBe(true);
  });

  it("a non-delegate resolves exactly as before: the nearer allow beats the farther exclude", () => {
    const investor: Principal = { ...delegate("all"), membershipId: P, delegation: undefined };
    const folderExclude = rule({
      subject: { kind: "membership", id: P },
      resource: FOLDER,
      capability: "view",
      effect: "exclude",
    });
    const subAllow = rule({
      subject: { kind: "membership", id: P },
      resource: SUB,
      capability: "view",
    });
    const mine = rulesFor([folderExclude, subAllow], investor);
    expect(mine.every((r) => r.borrowed === undefined)).toBe(true);
    expect(resolveNode(mine, DOC, NOW).capabilities).toEqual(["view"]);
    expect(resolveNode(mine, FOLDER, NOW).capabilities).toEqual([]);
  });
});

describe("delegation: gates", () => {
  const ndaOnBoard: Gate = {
    policyId: "01920000-0000-7000-8000-0000000002a1",
    kind: "nda",
    config: { version: "v3" },
    target: { kind: "group", id: BOARD },
  };
  const ipOnPrincipal: Gate = {
    policyId: "01920000-0000-7000-8000-0000000002a2",
    kind: "ip_allowlist",
    config: { cidrs: ["10.0.0.0/8"] },
    target: { kind: "membership", id: P },
  };
  const ndaOnOtherGroup: Gate = {
    ...ndaOnBoard,
    policyId: "01920000-0000-7000-8000-0000000002a3",
    target: { kind: "group", id: OWN_GROUP },
  };

  it("binds the delegate to its principal's group and membership gates", () => {
    const got = gatesFor([ndaOnBoard, ipOnPrincipal, ndaOnOtherGroup], delegate("all"), FOLDER);
    expect(got.map((g) => g.policyId)).toEqual([ndaOnBoard.policyId, ipOnPrincipal.policyId]);
  });

  it("the principal's signature does not satisfy the delegate's gate; its own does", () => {
    // The principal signed nda:v3 — irrelevant: attestations are the delegate's own.
    const unsigned = pendingGatesAtRebuild([ndaOnBoard], delegate("all"), FOLDER, NOW);
    expect(unsigned.map((g) => g.kind)).toEqual(["nda"]);
    const signed = pendingGatesAtRebuild(
      [ndaOnBoard],
      delegate("all", { attestations: [{ kind: "nda:v3", signedAt: NOW }] }),
      FOLDER,
      NOW,
    );
    expect(signed).toEqual([]);
  });
});

describe("delegation: materialised rows", () => {
  it("rows carry the principal's grants under the scope, keyed to the delegate", () => {
    const rows = computeEffectiveRows([delegate("data_room")], principalRules, [], 7, NOW);
    expect(rows.map((r) => [r.membershipId, r.resourceKind, r.capabilities])).toEqual([
      [D, "folder", ["view"]],
    ]);
  });

  it("rows expire with the Principal's expiresAt (the repository sets it to the earlier expiry)", () => {
    const until = new Date(NOW.getTime() + 3600_000);
    const rows = computeEffectiveRows(
      [delegate("all", { expiresAt: until })],
      principalRules,
      [],
      7,
      NOW,
    );
    expect(rows.length).toBe(3);
    for (const r of rows) expect(r.expiresAt).toEqual(until);
  });
});
