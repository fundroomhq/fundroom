import type { PendingGate } from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import {
  gatesFor,
  ipAllowed,
  ndaStamp,
  nodesOf,
  pendingGatesAtRebuild,
  resolveNode,
  ruleIsLive,
  rulesCovering,
  rulesFor,
  settleGates,
  withResolvedStamps,
} from "./evaluate.js";
import type { Gate, Principal, Rule } from "./model.js";

/*
 * Boundary and precedence cases for the pure resolver, written against the survivors of the
 * first Stryker run (E2.10, `pnpm --filter @fundroom/authz mutation`). Each block names the
 * property it pins; most are deny-safety properties an innocent-looking refactor could break.
 */

const NOW = new Date("2026-09-11T12:00:00Z");
const MS = 1;
const DAY = 24 * 3600_000;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

const M = "01920000-0000-7000-8000-00000000000a";
const OTHER_M = "01920000-0000-7000-8000-00000000000d";
const G1 = "01920000-0000-7000-8000-00000000000b";
const G2 = "01920000-0000-7000-8000-00000000000c";
const ID = "01920000-0000-7000-8000-0000000000aa";
const ROOT = { kind: "folder", id: "01920000-0000-7000-8000-0000000000a0", path: "root" };
const A = { kind: "folder", id: "01920000-0000-7000-8000-0000000000a1", path: "root.a" };
const AB = { kind: "folder", id: "01920000-0000-7000-8000-0000000000a2", path: "root.a.b" };
const POST = { kind: "post", id: "01920000-0000-7000-8000-0000000000e0" };

const investor: Principal = {
  membershipId: M,
  kind: "external",
  role: "investor",
  groupIds: [G1, G2],
  linkIds: [],
  attestations: [],
};

let n = 0;
function rule(over: Partial<Rule> & Pick<Rule, "subject" | "resource" | "capability">): Rule {
  n += 1;
  return {
    grantId: `g${n}`,
    effect: "allow",
    validFrom: undefined,
    validUntil: undefined,
    ...over,
  };
}
const g1 = { kind: "group", id: G1 } as const;
const g2 = { kind: "group", id: G2 } as const;
const me = { kind: "membership", id: M } as const;

describe("ruleIsLive: validity is the half-open range [validFrom, validUntil)", () => {
  const base = rule({ subject: me, resource: A, capability: "view" });

  it("is live from the first millisecond of validFrom", () => {
    expect(ruleIsLive({ ...base, validFrom: NOW }, NOW)).toBe(true);
    expect(ruleIsLive({ ...base, validFrom: at(-MS) }, NOW)).toBe(true);
    expect(ruleIsLive({ ...base, validFrom: at(MS) }, NOW)).toBe(false);
  });

  it("is dead from the first millisecond of validUntil (matches Postgres `[from,until)`)", () => {
    expect(ruleIsLive({ ...base, validUntil: NOW }, NOW)).toBe(false);
    expect(ruleIsLive({ ...base, validUntil: at(-MS) }, NOW)).toBe(false);
    expect(ruleIsLive({ ...base, validUntil: at(MS) }, NOW)).toBe(true);
  });

  it("an open range is always live, a range with both ends is live only inside", () => {
    expect(ruleIsLive(base, NOW)).toBe(true);
    expect(ruleIsLive({ ...base, validFrom: at(-DAY), validUntil: at(DAY) }, NOW)).toBe(true);
    expect(ruleIsLive({ ...base, validFrom: at(DAY), validUntil: at(2 * DAY) }, NOW)).toBe(false);
  });

  it("resolveNode drops a rule at its expiry instant", () => {
    const r = rule({ subject: me, resource: A, capability: "view", validUntil: NOW });
    expect(resolveNode([r], A, NOW).capabilities).toEqual([]);
    expect(resolveNode([r], A, at(-MS)).capabilities).toEqual(["view"]);
  });
});

describe("rulesCovering: identity is (kind, id); inheritance is by path only", () => {
  it("a rule on the same id but another kind does not cover a flat resource", () => {
    const onPost = rule({ subject: me, resource: { kind: "post", id: ID }, capability: "view" });
    expect(rulesCovering([onPost], { kind: "update", id: ID })).toEqual([]);
    expect(rulesCovering([onPost], { kind: "post", id: ID })).toEqual([onPost]);
  });

  it("a path-less rule never inherits, even onto a path whose first label is 'undefined'", () => {
    const flat = rule({ subject: me, resource: { kind: "document", id: ID }, capability: "view" });
    expect(rulesCovering([flat], { kind: "folder", id: A.id, path: "undefined.x" })).toEqual([]);
  });

  it("a path rule does not cover a path-less resource of another id", () => {
    const folder = rule({ subject: me, resource: A, capability: "view" });
    expect(rulesCovering([folder], { kind: "folder", id: AB.id })).toEqual([]);
  });

  it("a sibling whose label merely starts with the ancestor's is not a descendant", () => {
    const folder = rule({ subject: me, resource: A, capability: "view" });
    expect(rulesCovering([folder], { kind: "folder", id: AB.id, path: "root.ab" })).toEqual([]);
    expect(rulesCovering([folder], { kind: "folder", id: AB.id, path: "root" })).toEqual([]);
  });
});

describe("resolveNode precedence", () => {
  it("an exclude beats an allow at a full tie in either input order", () => {
    const allow = rule({ subject: g1, resource: A, capability: "view" });
    const exclude = rule({ subject: g2, resource: A, capability: "view", effect: "exclude" });
    expect(resolveNode([allow, exclude], A, NOW).capabilities).toEqual([]);
    expect(resolveNode([exclude, allow], A, NOW).capabilities).toEqual([]);
  });

  it("the nearest rule wins in either input order", () => {
    const deepExclude = rule({ subject: g1, resource: AB, capability: "view", effect: "exclude" });
    const shallowAllow = rule({ subject: me, resource: ROOT, capability: "view" });
    expect(resolveNode([deepExclude, shallowAllow], AB, NOW).capabilities).toEqual([]);
    expect(resolveNode([shallowAllow, deepExclude], AB, NOW).capabilities).toEqual([]);
    const deepAllow = rule({ subject: g1, resource: A, capability: "view" });
    const shallowExclude = rule({
      subject: me,
      resource: ROOT,
      capability: "view",
      effect: "exclude",
    });
    expect(resolveNode([deepAllow, shallowExclude], AB, NOW).capabilities).toEqual(["view"]);
    expect(resolveNode([shallowExclude, deepAllow], AB, NOW).capabilities).toEqual(["view"]);
  });

  it("the more specific subject wins in either input order", () => {
    const person = rule({ subject: me, resource: A, capability: "view" });
    const group = rule({ subject: g1, resource: A, capability: "view", effect: "exclude" });
    expect(resolveNode([person, group], A, NOW).capabilities).toEqual(["view"]);
    expect(resolveNode([group, person], A, NOW).capabilities).toEqual(["view"]);
  });

  it("a rule on the same id under another kind is inherited by path, not treated as the node itself", () => {
    // Same id, different kind, reached through the path: it ranks at its path depth (1), so a
    // deeper exclude on `root.a` still shadows it.
    const sameIdOtherKind = rule({
      subject: me,
      resource: { kind: "album", id: A.id, path: "root" },
      capability: "view",
    });
    const deeper = rule({ subject: g1, resource: A, capability: "view", effect: "exclude" });
    const doc = { kind: "document", id: A.id, path: "root.a" };
    const r = resolveNode([sameIdOtherKind, deeper], doc, NOW);
    expect(r.capabilities).toEqual([]);
    expect(r.rules.map((x) => x.inherited)).toEqual([true, true]);
  });

  it("flags a rule on the node itself as not inherited, an ancestor's as inherited", () => {
    const own = rule({ subject: me, resource: AB, capability: "view" });
    const parent = rule({ subject: me, resource: A, capability: "download" });
    const r = resolveNode([parent, own], AB, NOW);
    expect(r.rules.map((x) => [x.grantId, x.inherited])).toEqual([
      [own.grantId, false],
      [parent.grantId, true],
    ]);
  });

  it("at a full tie between two allows the first listed stays decisive (stable explain output)", () => {
    const first = rule({ subject: g1, resource: A, capability: "view", validUntil: at(DAY) });
    const second = rule({ subject: g2, resource: A, capability: "view", validUntil: at(2 * DAY) });
    const r = resolveNode([first, second], A, NOW);
    expect(r.rules.find((x) => x.grantId === first.grantId)?.decisive).toBe(true);
    expect(r.rules.find((x) => x.grantId === second.grantId)?.decisive).toBe(false);
    expect(r.expiresAt).toEqual(at(DAY));
  });
});

describe("resolveNode expiresAt: the earliest expiry among the decisive allows", () => {
  it("takes the minimum across capabilities, whichever capability expires first", () => {
    const early = at(DAY);
    const late = at(2 * DAY);
    const viewLate = rule({ subject: me, resource: A, capability: "view", validUntil: late });
    const dlEarly = rule({ subject: me, resource: A, capability: "download", validUntil: early });
    expect(resolveNode([viewLate, dlEarly], A, NOW).expiresAt).toEqual(early);
    const viewEarly = rule({ subject: me, resource: A, capability: "view", validUntil: early });
    const dlLate = rule({ subject: me, resource: A, capability: "download", validUntil: late });
    expect(resolveNode([viewEarly, dlLate], A, NOW).expiresAt).toEqual(early);
  });

  it("an open-ended capability does not erase another capability's expiry", () => {
    const view = rule({ subject: me, resource: A, capability: "view", validUntil: at(DAY) });
    const download = rule({ subject: me, resource: A, capability: "download" });
    expect(resolveNode([view, download], A, NOW).expiresAt).toEqual(at(DAY));
    const openView = rule({ subject: me, resource: A, capability: "view" });
    const dl = rule({ subject: me, resource: A, capability: "download", validUntil: at(DAY) });
    expect(resolveNode([openView, dl], A, NOW).expiresAt).toEqual(at(DAY));
    expect(resolveNode([openView], A, NOW).expiresAt).toBeUndefined();
  });

  it("ignores the expiry of an exclude and of an allow that lost", () => {
    const exclude = rule({
      subject: me,
      resource: A,
      capability: "view",
      effect: "exclude",
      validUntil: at(DAY),
    });
    const loser = rule({ subject: g1, resource: A, capability: "view", validUntil: at(DAY) });
    expect(resolveNode([exclude, loser], A, NOW).expiresAt).toBeUndefined();
  });
});

describe("rulesFor / nodesOf", () => {
  it("a role grant names one role, not every role", () => {
    const delegateOnly = rule({
      subject: { kind: "role", role: "delegate" },
      resource: A,
      capability: "view",
    });
    expect(rulesFor([delegateOnly], investor)).toEqual([]);
    expect(rulesFor([delegateOnly], { ...investor, role: "delegate" })).toEqual([delegateOnly]);
  });

  it("nodesOf keeps the first resource object it saw for a node", () => {
    const first = rule({ subject: me, resource: A, capability: "view" });
    const again = rule({ subject: g1, resource: { ...A }, capability: "download" });
    const nodes = nodesOf([first, again]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toBe(first.resource);
  });
});

describe("gatesFor", () => {
  const gate = (target: Gate["target"], policyId = "p"): Gate => ({
    policyId,
    kind: "min_auth_level",
    config: { level: 2 },
    target,
  });

  it("a membership gate binds that membership only", () => {
    expect(gatesFor([gate({ kind: "membership", id: OTHER_M })], investor, A)).toEqual([]);
    expect(gatesFor([gate({ kind: "membership", id: M })], investor, A)).toHaveLength(1);
  });

  it("a resource gate on a flat resource matches exactly that (kind, id)", () => {
    const g = gate({ kind: "resource", resource: { kind: "post", id: ID } });
    expect(gatesFor([g], investor, { kind: "post", id: ID })).toEqual([g]);
    expect(gatesFor([g], investor, POST)).toEqual([]);
    expect(gatesFor([g], investor, { kind: "update", id: ID })).toEqual([]);
  });

  it("a resource gate follows the path downwards, never upwards or sideways", () => {
    const g = gate({ kind: "resource", resource: A });
    expect(gatesFor([g], investor, AB)).toEqual([g]);
    expect(gatesFor([g], investor, ROOT)).toEqual([]);
    expect(gatesFor([g], investor, { kind: "folder", id: ID, path: "root.ab" })).toEqual([]);
  });

  it("a path-less resource gate never inherits, even onto a path starting 'undefined'", () => {
    const g = gate({ kind: "resource", resource: { kind: "document", id: ID } });
    expect(gatesFor([g], investor, { kind: "folder", id: A.id, path: "undefined.x" })).toEqual([]);
  });
});

describe("pendingGatesAtRebuild", () => {
  const nda = (target: Gate["target"], config: Gate["config"] = { version: "v3" }): Gate => ({
    policyId: "p-nda",
    kind: "nda",
    config,
    target,
  });

  it("names the source of each gate", () => {
    const sources = pendingGatesAtRebuild(
      [
        nda({ kind: "group", id: G1 }, { version: "v1" }),
        nda({ kind: "membership", id: M }, { version: "v2" }),
        nda({ kind: "resource", resource: A }, { version: "v3" }),
      ],
      investor,
      AB,
      NOW,
    ).map((g) => g.source);
    expect(sources).toEqual([`group:${G1}`, "membership", `resource:folder:${A.id}`]);
  });

  it("an empty stamp falls back to the version, never to an empty attestation kind", () => {
    expect(ndaStamp({ stamp: "", version: "v4" })).toBe("nda:v4");
    expect(ndaStamp({ stamp: 7 })).toBe("nda:v1");
    const holdsEmpty: Principal = { ...investor, attestations: [{ kind: "", signedAt: NOW }] };
    expect(
      pendingGatesAtRebuild([nda({ kind: "workspace" }, { stamp: "" })], holdsEmpty, POST, NOW),
    ).toHaveLength(1);
  });

  it("withResolvedStamps returns the very same gate when the document is unresolved", () => {
    const g = nda({ kind: "workspace" }, { documentId: ID });
    const [out] = withResolvedStamps([g], new Map([["other", "x:v1"]]));
    expect(out).toBe(g);
    const [resolved] = withResolvedStamps([g], new Map([[ID, "mutual-nda:v2"]]));
    expect(resolved?.config).toEqual({ documentId: ID, stamp: "mutual-nda:v2" });
  });

  describe("accredited", () => {
    const acc = (config: Gate["config"]): Gate => ({
      policyId: "p-acc",
      kind: "accredited",
      config,
      target: { kind: "workspace" },
    });
    const signed = (kind: string, signedAt: Date): Principal => ({
      ...investor,
      attestations: [{ kind, signedAt }],
    });

    it("is settled by an accreditation signed exactly maxAgeDays ago, not a millisecond earlier", () => {
      const g = acc({ maxAgeDays: 30 });
      expect(pendingGatesAtRebuild([g], signed("accredited", at(-30 * DAY)), POST, NOW)).toEqual(
        [],
      );
      expect(
        pendingGatesAtRebuild([g], signed("accredited", at(-30 * DAY - MS)), POST, NOW),
      ).toEqual([{ kind: "accredited", detail: { maxAgeDays: 30 }, source: "workspace" }]);
    });

    it("honours a configured maxAgeDays rather than the 365-day default", () => {
      const hundredDaysAgo = signed("accredited", at(-100 * DAY));
      expect(pendingGatesAtRebuild([acc({ maxAgeDays: 30 })], hundredDaysAgo, POST, NOW)).toEqual([
        { kind: "accredited", detail: { maxAgeDays: 30 }, source: "workspace" },
      ]);
      expect(pendingGatesAtRebuild([acc({})], hundredDaysAgo, POST, NOW)).toEqual([]);
    });

    it("is not settled by some other recent attestation", () => {
      expect(pendingGatesAtRebuild([acc({})], signed("nda:v1", NOW), POST, NOW)).toHaveLength(1);
    });

    it("ignores a non-numeric or non-finite maxAgeDays and uses 365", () => {
      for (const bad of ["30", Number.NaN, Number.POSITIVE_INFINITY, null]) {
        expect(
          pendingGatesAtRebuild([acc({ maxAgeDays: bad })], investor, POST, NOW)[0]?.detail,
        ).toEqual({ maxAgeDays: 365 });
      }
    });
  });

  it("carries min_auth_level through with its configured level (default 2)", () => {
    const g = (config: Gate["config"]): Gate => ({
      policyId: "p-mal",
      kind: "min_auth_level",
      config,
      target: { kind: "workspace" },
    });
    expect(pendingGatesAtRebuild([g({ level: 1 })], investor, POST, NOW)).toEqual([
      { kind: "min_auth_level", detail: { level: 1 }, source: "workspace" },
    ]);
    expect(pendingGatesAtRebuild([g({ level: "1" })], investor, POST, NOW)[0]?.detail).toEqual({
      level: 2,
    });
    expect(
      pendingGatesAtRebuild([g({ level: Number.NaN })], investor, POST, NOW)[0]?.detail,
    ).toEqual({ level: 2 });
  });

  it("keeps only string CIDRs, and an ip_allowlist with none stays pending", () => {
    const g = (cidrs: unknown): Gate => ({
      policyId: "p-ip",
      kind: "ip_allowlist",
      config: { cidrs },
      target: { kind: "workspace" },
    });
    expect(
      pendingGatesAtRebuild([g(["10.0.0.0/8", 42, null, "192.168.0.0/16"])], investor, POST, NOW),
    ).toEqual([
      {
        kind: "ip_allowlist",
        detail: { cidrs: "10.0.0.0/8,192.168.0.0/16" },
        source: "workspace",
      },
    ]);
    const none = pendingGatesAtRebuild([g("10.0.0.0/8")], investor, POST, NOW);
    expect(none).toEqual([{ kind: "ip_allowlist", detail: { cidrs: "" }, source: "workspace" }]);
    expect(settleGates(none, { ip: "10.0.0.1" })).toEqual(none);
  });

  it("dedupes identical requirements from different sources, keeping the first", () => {
    const pending = pendingGatesAtRebuild(
      [
        nda({ kind: "workspace" }),
        nda({ kind: "group", id: G1 }),
        nda({ kind: "group", id: G2 }, { version: "v4" }),
      ],
      investor,
      POST,
      NOW,
    );
    expect(pending.map((g) => [g.source, g.detail["version"]])).toEqual([
      ["workspace", "v3"],
      [`group:${G2}`, "v4"],
    ]);
  });
});

describe("settleGates", () => {
  const mal = (level: unknown): PendingGate => ({
    kind: "min_auth_level",
    detail: { level } as PendingGate["detail"],
    source: "workspace",
  });
  const ipGate = (cidrs: string | undefined): PendingGate => ({
    kind: "ip_allowlist",
    detail: (cidrs === undefined ? {} : { cidrs }) as PendingGate["detail"],
    source: "workspace",
  });

  it("settles min_auth_level at exactly the required level, not below", () => {
    expect(settleGates([mal(1)], { authLevel: 1 })).toEqual([]);
    expect(settleGates([mal(1)], { authLevel: 0 })).toHaveLength(1);
    expect(settleGates([mal(2)], { authLevel: 2 })).toEqual([]);
    expect(settleGates([mal(2)], { authLevel: 1 })).toHaveLength(1);
    expect(settleGates([mal(1)], {})).toHaveLength(1);
  });

  it("an unreadable level means the strict default 2", () => {
    expect(settleGates([mal("1")], { authLevel: 1 })).toHaveLength(1);
    expect(settleGates([mal(undefined)], { authLevel: 1 })).toHaveLength(1);
    expect(settleGates([mal(undefined)], { authLevel: 2 })).toEqual([]);
  });

  it("tolerates spaces around the stored CIDRs", () => {
    expect(settleGates([ipGate("10.0.0.0/8, 192.168.0.0/16")], { ip: "192.168.1.1" })).toEqual([]);
  });

  it("an ip_allowlist without CIDRs is never settled", () => {
    expect(settleGates([ipGate(undefined)], { ip: "10.0.0.1" })).toHaveLength(1);
    expect(settleGates([ipGate("")], { ip: "10.0.0.1" })).toHaveLength(1);
  });

  it("leaves attestation gates alone whatever the facts", () => {
    const g: PendingGate = { kind: "nda", detail: { stamp: "nda:v1" }, source: "workspace" };
    expect(settleGates([g], { authLevel: 2, ip: "10.0.0.1" })).toEqual([g]);
  });
});

describe("ipAllowed", () => {
  it("matches IPv4 prefixes at their exact edges", () => {
    expect(ipAllowed("10.0.0.1", ["10.0.0.0/31"])).toBe(true);
    expect(ipAllowed("10.0.0.2", ["10.0.0.0/31"])).toBe(false);
    expect(ipAllowed("10.255.255.255", ["10.0.0.0/8"])).toBe(true);
    expect(ipAllowed("11.0.0.0", ["10.0.0.0/8"])).toBe(false);
    expect(ipAllowed("10.0.0.1", ["10.0.0.1/32"])).toBe(true);
    expect(ipAllowed("10.0.0.2", ["10.0.0.1/32"])).toBe(false);
  });

  it("matches IPv6 prefixes at their exact edges", () => {
    expect(ipAllowed("2001:db8:ffff:ffff::1", ["2001:db8::/32"])).toBe(true);
    expect(ipAllowed("2001:db9::", ["2001:db8::/32"])).toBe(false);
    expect(ipAllowed("2001:db8::1", ["2001:db8::1/128"])).toBe(true);
    expect(ipAllowed("2001:db8::2", ["2001:db8::1/128"])).toBe(false);
    expect(ipAllowed("2001:db8::2", ["2001:db8::1"])).toBe(false);
  });

  it("does not cross families, except an IPv4-mapped IPv6 address, which is the same host", () => {
    expect(ipAllowed("10.0.0.1", ["2001:db8::/32"])).toBe(false);
    expect(ipAllowed("2001:db8::1", ["10.0.0.0/8"])).toBe(false);
    expect(ipAllowed("::ffff:10.1.2.3", ["10.0.0.0/8"])).toBe(true);
    expect(ipAllowed("::ffff:11.1.2.3", ["10.0.0.0/8"])).toBe(false);
  });

  it("an IPv6 range never admits an IPv4 client, however it is written (R1-A7)", () => {
    // Node's BlockList matches IPv4 against IPv6 ranges via the mapped form: `::/0` was allow-all.
    expect(ipAllowed("8.8.8.8", ["::/0"])).toBe(false);
    expect(ipAllowed("8.8.8.8", ["::ffff:0:0/96"])).toBe(false);
    expect(ipAllowed("::ffff:8.8.8.8", ["::/0"])).toBe(false);
    expect(ipAllowed("::FFFF:10.1.2.3", ["10.0.0.0/8"])).toBe(true);
    expect(ipAllowed("::ffff:10.1.2.3", ["10.1.2.3"])).toBe(true);
    expect(ipAllowed("::ffff:10.12.13.14", ["10.0.0.0/8"])).toBe(true);
    // Only the whole mapped form is read as IPv4: not a v6 address that merely ends in one…
    expect(ipAllowed("1::ffff:10.1.2.3", ["10.0.0.0/8"])).toBe(false);
    // …nor a string that merely starts with one.
    expect(ipAllowed("::ffff:10.1.2.3x", ["10.0.0.0/8"])).toBe(false);
    // …and it still admits IPv6 clients, next to an IPv4 range that does its own job.
    expect(ipAllowed("2606:4700::1", ["::/0"])).toBe(true);
    expect(ipAllowed("8.8.8.8", ["::/0", "8.8.8.0/24"])).toBe(true);
    expect(ipAllowed("2606:4700::1", ["8.8.8.0/24", "2606:4700::/32"])).toBe(true);
  });

  it("an explicit /0 is honoured (the admin asked for it)", () => {
    expect(ipAllowed("8.8.8.8", ["0.0.0.0/0"])).toBe(true);
  });

  it("never admits an unparseable client address", () => {
    expect(ipAllowed("not-an-ip", ["0.0.0.0/0", "::/0"])).toBe(false);
    expect(ipAllowed("", ["0.0.0.0/0"])).toBe(false);
    expect(ipAllowed("10.0.0.1 ", ["10.0.0.0/8"])).toBe(false);
  });

  it("skips malformed entries without letting them widen the list (fail closed)", () => {
    // An empty or non-decimal prefix used to parse via Number(): "" → 0 made `10.0.0.0/` an
    // allow-all, and hex/exponent forms widened silently.
    for (const bad of [
      "10.0.0.0/",
      "2001:db8::/",
      "10.0.0.0/0x0",
      "10.0.0.0/1e0",
      "10.0.0.0/ 8",
      "10.0.0.0/+8",
      "10.0.0.0/8.0",
      "10.0.0.0/8/9",
      "10.0.0.0/33",
      "2001:db8::/129",
      "10.0.0.0/-1",
      "not-an-ip/8",
      "/8",
      "",
    ]) {
      expect({ bad, ok: ipAllowed("8.8.8.8", [bad]) }).toEqual({ bad, ok: false });
      expect({ bad, ok: ipAllowed("2606:4700::1", [bad]) }).toEqual({ bad, ok: false });
    }
    // …and a malformed entry does not poison the good ones next to it.
    expect(ipAllowed("10.1.1.1", ["10.0.0.0/", "not-an-ip", "10.0.0.0/8"])).toBe(true);
    expect(ipAllowed("10.1.1.1", ["10.0.0.0/8/9"])).toBe(false);
  });
});
