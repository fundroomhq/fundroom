import { createHash } from "node:crypto";
import type { RelationshipRule, RelationshipSnapshot, SubjectRef } from "@fundroom/ports";
import {
  GRANT_SUBJECT_RELATION,
  MEMBER_RELATION,
  openFgaTypeTable,
  PARENT_RELATION,
  ruleRelation,
  SUBJECT_TYPES,
  VALID_WINDOW_CONDITION,
} from "./model.js";

/*
 * Projection of a RelationshipSnapshot onto OpenFGA tuples (E3.13). Per snapshot:
 *
 *   <parentType>:<parent>  parent              <type>:<node>        one per node with a parent
 *   user:<membership>      member              group|link|role:<x>  one per member × group/link/role
 *   <subject user(set)>    subject [window]    grant:<rule>         one per rule
 *   grant:<rule>#subject   <cap>_<tier>_<eff>  <type>:<resource>    one per rule
 *
 * The grant object id carries a short hash of everything the rule says, so editing a rule (its
 * window, say) yields new tuple keys: the sync writes the new ones before deleting the old ones
 * and never has to rewrite a key in place.
 */

export interface TupleCondition {
  readonly name: string;
  readonly context: Readonly<Record<string, unknown>>;
}

export interface TupleKey {
  readonly user: string;
  readonly relation: string;
  readonly object: string;
  readonly condition?: TupleCondition | undefined;
}

/** Earliest/latest instants the window condition uses for an open bound. */
export const OPEN_NOT_BEFORE = "0001-01-01T00:00:00.000Z";
export const OPEN_NOT_AFTER = "9999-12-31T23:59:59.999Z";

const SAFE_ID_RE = /^[A-Za-z0-9_.-]{1,128}$/u;

/**
 * An id as it appears after `type:` in OpenFGA. Plain ids (uuids, role names) pass through; any
 * other id becomes `~` + base64url(sha256(id)) — `~` never appears in a plain id, so the two
 * spaces cannot collide, and nothing ever needs to be decoded (callers keep their own ids).
 */
export function encodeId(id: string): string {
  if (SAFE_ID_RE.test(id)) return id;
  return `~${createHash("sha256").update(id, "utf8").digest("base64url")}`;
}

export function objectOf(type: string, id: string): string {
  return `${type}:${encodeId(id)}`;
}

export function userOf(membershipId: string): string {
  return objectOf(SUBJECT_TYPES.user, membershipId);
}

/** The user / userset a rule's subject names. */
export function subjectUserOf(subject: SubjectRef): string {
  switch (subject.kind) {
    case "membership":
      return userOf(subject.id);
    case "link":
      return `${objectOf(SUBJECT_TYPES.link, subject.id)}#${MEMBER_RELATION}`;
    case "group":
      return `${objectOf(SUBJECT_TYPES.group, subject.id)}#${MEMBER_RELATION}`;
    case "role":
      return `${objectOf(SUBJECT_TYPES.role, subject.role)}#${MEMBER_RELATION}`;
  }
}

/** ISO instant (ms precision, as `packages/authz` compares) or a TypeError for garbage. */
export function normaliseInstant(value: string | null, open: string, what: string): string {
  if (value === null) return open;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new TypeError(`authz-openfga: invalid ${what} '${value}'`);
  return new Date(ms).toISOString();
}

export function windowOf(rule: Pick<RelationshipRule, "id" | "validFrom" | "validUntil">): {
  readonly notBefore: string;
  readonly notAfter: string;
} {
  return {
    notBefore: normaliseInstant(rule.validFrom, OPEN_NOT_BEFORE, `validFrom of rule ${rule.id}`),
    notAfter: normaliseInstant(rule.validUntil, OPEN_NOT_AFTER, `validUntil of rule ${rule.id}`),
  };
}

function grantObjectId(rule: RelationshipRule, notBefore: string, notAfter: string): string {
  const subject =
    rule.subject.kind === "role"
      ? `role:${rule.subject.role}`
      : `${rule.subject.kind}:${rule.subject.id}`;
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        subject,
        rule.resource.kind,
        rule.resource.id,
        rule.capability,
        rule.effect,
        notBefore,
        notAfter,
      ]),
    )
    .digest("base64url")
    .slice(0, 12);
  return `${encodeId(rule.id)}.${digest}`;
}

/** `user|relation|object` — what OpenFGA keys a tuple by. */
export function tupleIdentity(t: Pick<TupleKey, "user" | "relation" | "object">): string {
  return `${t.user}|${t.relation}|${t.object}`;
}

/** A comparable form of a tuple's condition (`""` when none); instants normalised. */
export function conditionSignature(condition: TupleCondition | null | undefined): string {
  if (condition === null || condition === undefined || condition.name === "") return "";
  const ctx = condition.context ?? {};
  const keys = Object.keys(ctx).sort();
  const parts = keys.map((k) => {
    const v = ctx[k];
    if (typeof v === "string") {
      const ms = Date.parse(v);
      return `${k}=${Number.isFinite(ms) ? new Date(ms).toISOString() : v}`;
    }
    return `${k}=${JSON.stringify(v)}`;
  });
  return `${condition.name}(${parts.join(",")})`;
}

export interface Projection {
  /** Desired tuples by `tupleIdentity`. */
  readonly tuples: ReadonlyMap<string, TupleKey>;
  /** Resource kind → OpenFGA type name, for every kind the snapshot mentions. */
  readonly types: ReadonlyMap<string, string>;
  /** Nodes whose parent chain is longer than the depth limit, or cyclic (no parent edge written). */
  readonly tooDeep: number;
  /** The longest parent chain (ancestor hops) within the limit. */
  readonly maxDepth: number;
}

/**
 * Every resource kind of a snapshot: the kernel's declared `kinds` (stable: the model, and so its
 * hash, does not change when the first document of a kind appears) plus whatever its nodes,
 * their parents and its rules mention.
 */
export function kindsOf(snapshot: RelationshipSnapshot): Set<string> {
  const kinds = new Set<string>(snapshot.kinds ?? []);
  for (const n of snapshot.nodes) {
    kinds.add(n.kind);
    if (n.parent !== null) kinds.add(n.parent.kind);
  }
  for (const r of snapshot.rules) kinds.add(r.resource.kind);
  return kinds;
}

export function projectSnapshot(snapshot: RelationshipSnapshot, depthLimit: number): Projection {
  const types = openFgaTypeTable(kindsOf(snapshot));
  const typeOf = (kind: string): string => types.get(kind) as string;
  const tuples = new Map<string, TupleKey>();
  const add = (t: TupleKey): void => {
    tuples.set(tupleIdentity(t), t);
  };

  const parentOf = new Map<string, string>();
  for (const n of snapshot.nodes) {
    if (n.parent === null) continue;
    const object = objectOf(typeOf(n.kind), n.id);
    const parent = objectOf(typeOf(n.parent.kind), n.parent.id);
    parentOf.set(object, parent);
  }

  for (const m of snapshot.members) {
    const user = userOf(m.membershipId);
    add({ user, relation: MEMBER_RELATION, object: objectOf(SUBJECT_TYPES.role, m.role) });
    for (const g of m.groupIds) {
      add({ user, relation: MEMBER_RELATION, object: objectOf(SUBJECT_TYPES.group, g) });
    }
    for (const l of m.linkIds) {
      add({ user, relation: MEMBER_RELATION, object: objectOf(SUBJECT_TYPES.link, l) });
    }
  }

  for (const r of snapshot.rules) {
    const { notBefore, notAfter } = windowOf(r);
    const grant = objectOf(SUBJECT_TYPES.grant, grantObjectId(r, notBefore, notAfter));
    // Only a bounded rule carries the condition: evaluating it costs (≈3× per check on v1.21).
    const open = r.validFrom === null && r.validUntil === null;
    add({
      user: subjectUserOf(r.subject),
      relation: GRANT_SUBJECT_RELATION,
      object: grant,
      ...(open
        ? {}
        : {
            condition: {
              name: VALID_WINDOW_CONDITION,
              context: { not_before: notBefore, not_after: notAfter },
            },
          }),
    });
    add({
      user: `${grant}#${GRANT_SUBJECT_RELATION}`,
      relation: ruleRelation(r.capability, r.subject.kind, r.effect),
      object: objectOf(typeOf(r.resource.kind), r.resource.id),
    });
  }

  // Parent-chain lengths. A node more than `depthLimit` hops below its root (or on a cycle) gets
  // NO parent edge: the server then never walks further than the limit, whatever is asked
  // (OpenFGA refuses beyond its resolve-node limit and, with duplicated edges, the cost grows
  // with every hop). Checks on such nodes are refused by the engine before any call.
  const depth = new Map<string, number>();
  for (const start of parentOf.keys()) {
    const chain: string[] = [];
    const onChain = new Set<string>();
    let cur = start;
    let base: number;
    for (;;) {
      const known = depth.get(cur);
      if (known !== undefined) {
        base = known;
        break;
      }
      if (onChain.has(cur)) {
        base = Number.POSITIVE_INFINITY; // a cycle never resolves
        break;
      }
      chain.push(cur);
      onChain.add(cur);
      const parent = parentOf.get(cur);
      if (parent === undefined) {
        base = -1; // `cur` is a root: depth 0
        break;
      }
      cur = parent;
    }
    for (let i = chain.length - 1; i >= 0; i--) {
      base += 1;
      depth.set(chain[i] as string, base);
    }
  }
  let tooDeep = 0;
  let maxDepth = 0;
  for (const [object, parent] of parentOf) {
    const d = depth.get(object) ?? Number.POSITIVE_INFINITY;
    if (d > depthLimit) {
      tooDeep++;
      continue;
    }
    if (d > maxDepth) maxDepth = d;
    add({ user: parent, relation: PARENT_RELATION, object });
  }

  return { tuples, types, tooDeep, maxDepth };
}
