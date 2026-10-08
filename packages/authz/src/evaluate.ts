import { BlockList, isIP } from "node:net";
import type {
  AccessVia,
  Capability,
  PendingGate,
  RequestFacts,
  ResourceRef,
  SubjectRef,
} from "@fundroom/ports";
import { CAPABILITIES } from "@fundroom/ports";
import {
  delegateScopeAdmitsKind,
  type Gate,
  isAncestorOrSelf,
  type Principal,
  type PrincipalAttestation,
  pathDepth,
  type Rule,
  SUBJECT_SPECIFICITY,
  subjectKey,
} from "./model.js";

/*
 * The pure resolver (ADR-0032 §1). Given every rule that applies to a principal and one
 * resource, decide each capability:
 *
 *   1. only rules on the resource itself or on an ancestor node (ltree path) count;
 *   2. the *nearest* rule wins (the resource itself, else the deepest ancestor);
 *   3. at equal depth the more specific subject wins (membership > link > group > role);
 *   4. at a full tie an exclude beats an allow (deny-safe).
 *
 * "Grants union across subjects" follows: any allow from any subject grants, unless a
 * nearer or more specific exclude says otherwise. "Nearest explicit rule per subject wins"
 * and "explicit exclude beats inherited allow" (ADR-0014) are both special cases of 2–3.
 *
 * A delegate (E3.2) is resolved twice with those same rules: its OWN rules
 * alone and the rules it BORROWS from its principal (`Rule.borrowed`) alone. If either side's
 * decisive rule for a capability is an exclude, the capability is denied — the principal's walls
 * bind the delegate and so do the delegate's own. Otherwise the allows of both sides unite. With
 * no borrowed rule (everyone who is not a delegate) this is exactly the single resolution above.
 */
export interface ResolvedNode {
  readonly capabilities: readonly Capability[];
  /** Every applicable rule, decisive ones flagged, most specific first. */
  readonly rules: readonly AccessVia[];
  /** Earliest `validUntil` among the decisive allow rules. */
  readonly expiresAt: Date | undefined;
}

/**
 * The subjects a grant may name this principal by, in no particular order — `SUBJECT_SPECIFICITY`
 * ranks them, not this list. `link` subjects (E2.3) come from the live `core.share_link_visit`
 * bindings the repository loaded: a grant written once against the link resolves for every
 * membership the link admitted, and stops resolving for all of them the moment it is revoked.
 */
export function subjectsOf(p: Principal): SubjectRef[] {
  return [
    { kind: "membership", id: p.membershipId },
    ...p.linkIds.map((id): SubjectRef => ({ kind: "link", id })),
    ...p.groupIds.map((id): SubjectRef => ({ kind: "group", id })),
    { kind: "role", role: p.role },
  ];
}

export function ruleIsLive(rule: Rule, now: Date): boolean {
  if (rule.validFrom !== undefined && rule.validFrom.getTime() > now.getTime()) return false;
  if (rule.validUntil !== undefined && rule.validUntil.getTime() <= now.getTime()) return false;
  return true;
}

/**
 * Rules whose resource is the node itself, or a node whose path is an ancestor of (or equal
 * to) the resource's path. The path branch ignores the kind on purpose (ADR-0034): a data
 * room folder's rule covers the documents inside it, which carry the folder's path and
 * their own kind. Flat resources have no path and are only ever matched by id.
 */
export function rulesCovering(rules: readonly Rule[], resource: ResourceRef): Rule[] {
  return rules.filter((r) => {
    if (r.resource.kind === resource.kind && r.resource.id === resource.id) return true;
    return (
      resource.path !== undefined &&
      r.resource.path !== undefined &&
      isAncestorOrSelf(r.resource.path, resource.path)
    );
  });
}

function depthOf(rule: Rule, resource: ResourceRef): number {
  // The node itself is always the deepest possible match.
  if (rule.resource.kind === resource.kind && rule.resource.id === resource.id) {
    return Number.MAX_SAFE_INTEGER;
  }
  return pathDepth(rule.resource.path);
}

/** Higher = wins. */
function rank(rule: Rule, resource: ResourceRef): [number, number, number] {
  return [
    depthOf(rule, resource),
    SUBJECT_SPECIFICITY[rule.subject.kind],
    rule.effect === "exclude" ? 1 : 0,
  ];
}

function compareRank(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** The winning rule per capability among `live`, by the single ranking. */
function decisiveOf(live: readonly Rule[], resource: ResourceRef): Map<Capability, Rule> {
  const decisive = new Map<Capability, Rule>();
  for (const cap of CAPABILITIES) {
    let best: Rule | undefined;
    for (const r of live) {
      if (r.capability !== cap) continue;
      if (best === undefined || compareRank(rank(r, resource), rank(best, resource)) > 0) best = r;
    }
    if (best !== undefined) decisive.set(cap, best);
  }
  return decisive;
}

export function resolveNode(
  applicable: readonly Rule[],
  resource: ResourceRef,
  now: Date,
): ResolvedNode {
  const live = rulesCovering(applicable, resource).filter((r) => ruleIsLive(r, now));
  // F4 (round 2): own and borrowed rules are resolved apart; an exclude on either side denies.
  const borrowedLive = live.filter((r) => r.borrowed === true);
  const own = borrowedLive.length === 0 ? live : live.filter((r) => r.borrowed !== true);
  const sides = [decisiveOf(own, resource)];
  if (borrowedLive.length > 0) sides.push(decisiveOf(borrowedLive, resource));
  const capabilities = CAPABILITIES.filter(
    (cap) =>
      sides.some((d) => d.get(cap)?.effect === "allow") &&
      !sides.some((d) => d.get(cap)?.effect === "exclude"),
  );
  let expiresAt: Date | undefined;
  for (const cap of capabilities) {
    for (const d of sides) {
      const r = d.get(cap);
      const until = r?.effect === "allow" ? r.validUntil : undefined;
      if (until !== undefined && (expiresAt === undefined || until < expiresAt)) expiresAt = until;
    }
  }
  const rules = live
    .map(
      (r): AccessVia => ({
        subject: r.subject,
        grantId: r.grantId,
        capability: r.capability,
        effect: r.effect,
        resource: r.resource,
        inherited: !(r.resource.kind === resource.kind && r.resource.id === resource.id),
        decisive: sides.some((d) => d.get(r.capability) === r),
        validUntil: r.validUntil,
      }),
    )
    .sort((a, b) => {
      const ra = rank(toRule(a), resource);
      const rb = rank(toRule(b), resource);
      return compareRank(rb, ra) || a.capability.localeCompare(b.capability);
    });
  return { capabilities, rules, expiresAt };
}

function toRule(v: AccessVia): Rule {
  return {
    grantId: v.grantId,
    subject: v.subject,
    resource: v.resource,
    capability: v.capability,
    effect: v.effect,
    validFrom: undefined,
    validUntil: v.validUntil,
  };
}

/**
 * The subjects a delegate borrows from its principal (E3.2): the principal's membership and live
 * groups — never its role (externals hold no role rights, and a `role:investor` rule is not the
 * principal's to lend) and never its share links (a link binds the people it admitted).
 */
export function delegatedSubjectsOf(p: Principal): SubjectRef[] {
  const d = p.delegation;
  if (d === undefined) return [];
  return [
    { kind: "membership", id: d.principalMembershipId },
    ...d.principalGroupIds.map((id): SubjectRef => ({ kind: "group", id })),
  ];
}

/**
 * Rules whose subject is one of the principal's subjects, plus — for a delegate — the principal's
 * rules its scope admits, marked `borrowed`. A borrowed *allow* counts only on a resource kind the
 * scope admits; a borrowed *exclude* counts whatever the scope (deny-safe: it can only take access
 * away, so a delegate never sees what its principal is excluded from). `resolveNode` resolves the
 * borrowed rules apart from the delegate's own (F4): an exclude on either side denies.
 */
export function rulesFor(rules: readonly Rule[], principal: Principal): Rule[] {
  const keys = new Set(subjectsOf(principal).map(subjectKey));
  const borrowed = new Set(delegatedSubjectsOf(principal).map(subjectKey));
  const scope = principal.delegation?.scope;
  const out: Rule[] = [];
  for (const r of rules) {
    const key = subjectKey(r.subject);
    if (keys.has(key)) out.push(r);
    else if (scope === undefined || !borrowed.has(key)) continue;
    else if (r.effect === "exclude" || delegateScopeAdmitsKind(scope, r.resource.kind))
      out.push({ ...r, borrowed: true });
  }
  return out;
}

/** Distinct resource nodes named by the rules (the nodes a principal gets a materialised row for). */
export function nodesOf(rules: readonly Rule[]): ResourceRef[] {
  const seen = new Map<string, ResourceRef>();
  for (const r of rules) {
    const key = `${r.resource.kind}:${r.resource.id}`;
    if (!seen.has(key)) seen.set(key, r.resource);
  }
  return [...seen.values()];
}

// --- gates -----------------------------------------------------------------------------------

/**
 * Gates that apply to this principal on this resource: workspace ∪ groups ∪ membership ∪ the
 * live share links they were admitted through ∪ the resource chain. A `link` gate is the one
 * that follows the *door* rather than the person — an NDA attached to a share link binds only
 * the visitors that link admitted, and stops binding them when the binding is revoked.
 */
export function gatesFor(
  gates: readonly Gate[],
  principal: Principal,
  resource: ResourceRef,
): Gate[] {
  // A delegate is bound by the gates on its principal and its principal's groups as well as its
  // own (E3.2), and satisfies them with its OWN attestations: borrowing a group's grant must not
  // mean skipping the group's NDA.
  const delegation = principal.delegation;
  const groups = new Set([...principal.groupIds, ...(delegation?.principalGroupIds ?? [])]);
  return gates.filter((g) => {
    switch (g.target.kind) {
      case "workspace":
        return true;
      case "group":
        return groups.has(g.target.id);
      case "membership":
        return (
          g.target.id === principal.membershipId ||
          g.target.id === delegation?.principalMembershipId
        );
      case "link":
        return principal.linkIds.includes(g.target.id);
      case "resource": {
        const t = g.target.resource;
        if (t.kind === resource.kind && t.id === resource.id) return true;
        return (
          resource.path !== undefined &&
          t.path !== undefined &&
          isAncestorOrSelf(t.path, resource.path)
        );
      }
      // Stryker disable all: unreachable, `Gate.target` is a closed union (see `gateOfRow`)
      default:
        return false;
    }
  });
}

// Stryker restore all
function sourceOf(g: Gate): string {
  switch (g.target.kind) {
    case "workspace":
      return "workspace";
    case "group":
      return `group:${g.target.id}`;
    case "membership":
      return "membership";
    case "link":
      return `link:${g.target.id}`;
    case "resource":
      return `resource:${g.target.resource.kind}:${g.target.resource.id}`;
  }
}

/**
 * The attestation kind an `nda` gate demands (`<slug>:v<n>`), and the whole of D4 in one place.
 *
 * `config.stamp` is filled in by `PolicyRepo.listLiveGates()` from the gate's `documentId` and
 * the document's *current* version, which is what makes re-acceptance on publish automatic:
 * publishing bumps `acl_version`, the rebuild re-reads the gate, the stamp moves to `:v<n+1>`
 * and every holder of the old one is pending again. No policy row is rewritten and no old
 * acceptance is lost (design/04 §4.7).
 *
 * A config that still carries a bare `{ version: "v3" }` and no document resolves to `nda:v3`,
 * exactly as before E2.3. And a `documentId` the repository could not resolve — a deleted
 * document, a document with no published version — falls through to `nda:v1`, a stamp nobody
 * holds, so the gate stays shut. Deny-safe is the only acceptable failure here: the alternative
 * is an NDA gate that opens because its document went missing.
 */
export function ndaStamp(config: Readonly<Record<string, unknown>>): string {
  const stamp = config["stamp"];
  if (typeof stamp === "string" && stamp.length > 0) return stamp;
  const version = typeof config["version"] === "string" ? config["version"] : "v1";
  return `nda:${version}`;
}

/**
 * Fills `config.stamp` on every `nda` gate whose `documentId` the caller resolved, leaving
 * every other gate untouched. Pure, so the repository owns the query and this owns the rule;
 * an unresolved document deliberately leaves the gate without a stamp (see `ndaStamp`).
 */
export function withResolvedStamps(
  gates: readonly Gate[],
  stamps: ReadonlyMap<string, string>,
): Gate[] {
  return gates.map((g) => {
    if (g.kind !== "nda") return g;
    const documentId = g.config["documentId"];
    if (typeof documentId !== "string") return g;
    const stamp = stamps.get(documentId);
    if (stamp === undefined) return g;
    return { ...g, config: { ...g.config, stamp } };
  });
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/**
 * Attestation-bound gates are settled at rebuild time (an attestation change bumps
 * `acl_version`); session-bound gates (`min_auth_level`, `ip_allowlist`) are carried through
 * as pending and settled per request by `settleGates()`.
 */
export function pendingGatesAtRebuild(
  gates: readonly Gate[],
  principal: Principal,
  resource: ResourceRef,
  now: Date,
): PendingGate[] {
  const out: PendingGate[] = [];
  for (const g of gatesFor(gates, principal, resource)) {
    const source = sourceOf(g);
    switch (g.kind) {
      case "nda": {
        const stamp = ndaStamp(g.config);
        const signed = principal.attestations.some((a) => a.kind === stamp);
        if (!signed) {
          const documentId = g.config["documentId"];
          out.push({
            kind: "nda",
            detail: {
              stamp,
              version: stamp.slice(stamp.lastIndexOf(":") + 1),
              documentId: typeof documentId === "string" ? documentId : null,
            },
            source,
          });
        }
        break;
      }
      case "accredited": {
        const maxAgeDays = num(g.config["maxAgeDays"], 365);
        const cutoff = now.getTime() - maxAgeDays * DAY_MS;
        const ok = principal.attestations.some(
          (a) => a.kind === "accredited" && a.signedAt.getTime() >= cutoff,
        );
        if (!ok) out.push({ kind: "accredited", detail: { maxAgeDays }, source });
        break;
      }
      case "min_auth_level":
        out.push({ kind: "min_auth_level", detail: { level: num(g.config["level"], 2) }, source });
        break;
      case "ip_allowlist": {
        const cidrs = Array.isArray(g.config["cidrs"])
          ? (g.config["cidrs"] as unknown[]).filter((c): c is string => typeof c === "string")
          : [];
        out.push({ kind: "ip_allowlist", detail: { cidrs: cidrs.join(",") }, source });
        break;
      }
    }
  }
  return dedupeGates(out);
}

const DAY_MS = 24 * 3600_000;

/**
 * The first instant at which one of `attestations` no longer satisfies its gate, taking the one
 * that lasts longest (any single one satisfies it). `maxAgeMs` is the `accredited` age limit:
 * signed exactly `maxAgeMs` ago still passes (see `pendingGatesAtRebuild`), so the gate lapses
 * a millisecond later. `undefined`: none of them satisfies it now, or one does indefinitely.
 */
function satisfiedUntil(
  attestations: readonly PrincipalAttestation[],
  maxAgeMs: number | undefined,
  now: Date,
): number | undefined {
  let best: number | undefined;
  for (const a of attestations) {
    let until = a.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
    if (maxAgeMs !== undefined) until = Math.min(until, a.signedAt.getTime() + maxAgeMs + 1);
    if (until <= now.getTime()) continue;
    if (best === undefined || until > best) best = until;
  }
  return best === Number.POSITIVE_INFINITY ? undefined : best;
}

/**
 * When the gate verdict `pendingGatesAtRebuild` gives now stops being true on its own, with no
 * write anywhere: an `accredited` attestation ages past `maxAgeDays`, an attestation reaches its
 * `expires_at`, or the membership itself does. Only gates the principal *currently satisfies*
 * can change this way (time never satisfies a pending one), so the answer is the earliest of
 * their lapse times, or `undefined` when nothing lapses.
 *
 * The rebuild stores this as the row's `expires_at` (min with the grants' `validUntil`), which
 * is what makes the reconciler and `check()` rebuild in time instead of letting an expired
 * accreditation keep opening the gate until some unrelated write bumps `acl_version`.
 */
export function gateVerdictExpiry(
  gates: readonly Gate[],
  principal: Principal,
  resource: ResourceRef,
  now: Date,
): Date | undefined {
  let earliest = principal.expiresAt?.getTime();
  for (const g of gatesFor(gates, principal, resource)) {
    let until: number | undefined;
    if (g.kind === "nda") {
      const stamp = ndaStamp(g.config);
      until = satisfiedUntil(
        principal.attestations.filter((a) => a.kind === stamp),
        undefined,
        now,
      );
    } else if (g.kind === "accredited") {
      until = satisfiedUntil(
        principal.attestations.filter((a) => a.kind === "accredited"),
        num(g.config["maxAgeDays"], 365) * DAY_MS,
        now,
      );
    }
    if (until !== undefined && (earliest === undefined || until < earliest)) earliest = until;
  }
  return earliest === undefined ? undefined : new Date(earliest);
}

/** The earlier of two optional instants; `undefined` means "never". */
export function earliestOf(a: Date | undefined, b: Date | undefined): Date | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a <= b ? a : b;
}

function dedupeGates(gates: readonly PendingGate[]): PendingGate[] {
  const seen = new Set<string>();
  const out: PendingGate[] = [];
  for (const g of gates) {
    const key = `${g.kind}:${JSON.stringify(g.detail)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(g);
  }
  return out;
}

/** Settles the session-bound gates with the request's facts; what is left still blocks. */
export function settleGates(
  pending: readonly PendingGate[],
  facts: RequestFacts = {},
): PendingGate[] {
  return pending.filter((g) => {
    switch (g.kind) {
      case "min_auth_level": {
        const level = num(g.detail["level"], 2);
        return facts.authLevel === undefined || facts.authLevel < level;
      }
      case "ip_allowlist": {
        const cidrs = String(g.detail["cidrs"] ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        return !ipAllowed(facts.ip, cidrs);
      }
      default:
        return true;
    }
  });
}

/** A CIDR prefix length as written: decimal digits only (range is checked by `BlockList`). */
const CIDR_PREFIX_RE = /^[0-9]{1,3}$/u;

/** An IPv4 client as a dual-stack socket reports it (`::ffff:192.0.2.1`). */
const V4_MAPPED_RE = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu;

/**
 * Whether the client address falls in one of `cidrs`, matched **within its own family** (review
 * R1-A7). Node's `BlockList` also matches an IPv4 address against IPv6 ranges through its
 * IPv4-mapped form, so `::/0` — "any IPv6 client" — admitted every IPv4 client too. An IPv4
 * client written in its mapped IPv6 form is read as the IPv4 address it is.
 */
export function ipAllowed(ip: string | undefined, cidrs: readonly string[]): boolean {
  // Stryker disable next-line ConditionalExpression,LogicalOperator: fast path only; `isIP(undefined)` is 0 and an empty BlockList matches nothing
  if (ip === undefined || cidrs.length === 0) return false;
  const client = V4_MAPPED_RE.exec(ip)?.[1] ?? ip;
  const family = isIP(client);
  // Stryker disable next-line ConditionalExpression: defence in depth; with family 0 every well-formed entry is skipped below and `check` of a non-address is false
  if (family === 0) return false;
  const list = new BlockList();
  for (const cidr of cidrs) {
    const parts = cidr.split("/");
    // `a/b/c` is malformed, not `a/b` with a trailing remark.
    if (parts.length > 2) continue;
    const [addr, prefix] = parts;
    // Stryker disable next-line ConditionalExpression: `split` always yields a first element; the guard only narrows the type
    if (addr === undefined) continue;
    const f = isIP(addr);
    // Also skips a malformed entry (family 0): it never grants access.
    if (f !== family) continue;
    // `Number("")` is 0, and `Number("0x8")`/`Number("1e1")` parse too: without this an entry
    // like `10.0.0.0/` became `/0` and admitted every address of its family (fail-open).
    if (prefix !== undefined && !CIDR_PREFIX_RE.test(prefix)) continue;
    const type = f === 6 ? "ipv6" : "ipv4";
    try {
      if (prefix === undefined) list.addAddress(addr, type);
      else list.addSubnet(addr, Number(prefix), type);
    } catch {
      // A malformed entry never grants access.
    }
  }
  return list.check(client, family === 6 ? "ipv6" : "ipv4");
}
