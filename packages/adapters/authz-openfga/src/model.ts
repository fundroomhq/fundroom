import { createHash } from "node:crypto";
import { CAPABILITIES, type Capability, type GrantEffect, type SubjectRef } from "@fundroom/ports";

/*
 * The generated OpenFGA authorization model (E3.13, ADR-0061) that encodes ADR-0032 resolution.
 *
 * For a principal, one capability and one node, `packages/authz` `resolveNode` takes the live rules
 * on the node and its ancestors and picks the decisive one by (depth, subject specificity, exclude
 * beats allow). Read top-down along the parent chain, that is:
 *
 *   at the node itself, if any live rule of the principal's subjects names it, the most specific
 *   tier present decides — allow unless that tier also holds an exclude; with no live rule here,
 *   the parent decides; with no parent, deny.
 *
 * OpenFGA has no ordering, but this is expressible with set operations because every step only
 * asks "is there a live rule of tier t here?". Per resource type and capability `c`:
 *
 *   c_<tier>_allow / c_<tier>_exclude   direct relations, one per tier (membership, link, group,
 *                                        role), holding `grant:<id>#subject` usersets
 *   below_r = (r_allow − r_exclude) ∪ ((c from parent) − (r_allow ∪ r_exclude))
 *   below_g = (g_allow − g_exclude) ∪ (below_r − (g_allow ∪ g_exclude))
 *   below_l = (l_allow − l_exclude) ∪ (below_g − (l_allow ∪ l_exclude))
 *   c       = (m_allow − m_exclude) ∪ (below_l − (m_allow ∪ m_exclude))
 *
 * written inline (one relation per capability, so a parent hop costs one resolution level).
 * Expanded, a tier's allow counts only where neither its own exclude nor any more specific tier
 * has a live rule here, and the parent counts only where no tier has one.
 *
 * Liveness: every rule is a `grant` object whose `subject` tuple carries the `valid_window`
 * condition when the rule is bounded, so a rule outside its window is simply absent for that
 * check — both from the allow side and from the "is there a rule here" side — exactly like
 * `ruleIsLive` filtering before the ranking. Open-ended rules carry no condition (condition
 * evaluation roughly triples check cost on v1.21). A rule is a separate object (rather than a
 * direct conditioned tuple on the resource) because two rules can share (subject, resource,
 * capability, effect) with different windows, and OpenFGA keys a tuple by (user, relation,
 * object) only.
 *
 * Capabilities resolve independently (evaluate.ts has no implication between them).
 */

export const OPENFGA_SCHEMA_VERSION = "1.1";

/** Subject-side types. A resource kind whose type name equals one of these is refused. */
export const SUBJECT_TYPES = {
  user: "user",
  group: "group",
  link: "link",
  role: "role",
  grant: "grant",
} as const;

export const RESERVED_TYPE_NAMES: ReadonlySet<string> = new Set(Object.values(SUBJECT_TYPES));

/** Relation on group/link/role objects holding the users that belong to them. */
export const MEMBER_RELATION = "member";
/** Relation on a grant object holding its (conditioned) subject. */
export const GRANT_SUBJECT_RELATION = "subject";
export const PARENT_RELATION = "parent";
export const VALID_WINDOW_CONDITION = "valid_window";

/** ADR-0032 subject specificity, most specific first (membership 3 > link 2 > group 1 > role 0). */
export const TIERS = [
  "membership",
  "link",
  "group",
  "role",
] as const satisfies readonly SubjectRef["kind"][];
export type Tier = (typeof TIERS)[number];

/** `view_membership_allow`, `edit_role_exclude`, … */
export function ruleRelation(capability: Capability, tier: Tier, effect: GrantEffect): string {
  return `${capability}_${tier}_${effect}`;
}

/**
 * The OpenFGA type name for a resource kind (`data-room.document` → `data_room_document`). OpenFGA
 * type names may not contain `:`, `#`, `@` or whitespace; we keep to `[a-z0-9_]` so names stay
 * readable in traces. Two kinds that map to the same name are refused by `buildOpenFgaModel`.
 */
export function openFgaTypeName(kind: string): string {
  return kind.toLowerCase().replace(/[^a-z0-9_]/gu, "_");
}

/** Every resource kind with its OpenFGA type name (the "document mapping table"). */
export function openFgaTypeTable(kinds: Iterable<string>): ReadonlyMap<string, string> {
  const table = new Map<string, string>();
  const owner = new Map<string, string>();
  for (const kind of [...new Set(kinds)].sort()) {
    if (kind.length === 0) throw new TypeError("authz-openfga: empty resource kind");
    const name = openFgaTypeName(kind);
    if (RESERVED_TYPE_NAMES.has(name)) {
      throw new TypeError(`authz-openfga: resource kind '${kind}' maps to reserved type '${name}'`);
    }
    const other = owner.get(name);
    if (other !== undefined) {
      throw new TypeError(
        `authz-openfga: resource kinds '${other}' and '${kind}' both map to type '${name}'`,
      );
    }
    owner.set(name, kind);
    table.set(kind, name);
  }
  return table;
}

type Userset = Readonly<Record<string, unknown>>;

const computed = (relation: string): Userset => ({ computedUserset: { relation } });
const union = (children: readonly Userset[]): Userset =>
  children.length === 1 ? (children[0] as Userset) : { union: { child: children } };
const difference = (base: Userset, subtract: Userset): Userset => ({
  difference: { base, subtract },
});

const TIMESTAMP = { type_name: "TYPE_NAME_TIMESTAMP" } as const;

export interface OpenFgaModel {
  readonly schema_version: string;
  readonly type_definitions: readonly Readonly<Record<string, unknown>>[];
  readonly conditions: Readonly<Record<string, unknown>>;
}

/**
 * The authorization model for a set of resource kinds. Deterministic: the same kinds (in any
 * order, with duplicates) always produce byte-identical JSON, so `modelHash` changes only when the
 * kinds do.
 */
export function buildOpenFgaModel(kinds: Iterable<string>): OpenFgaModel {
  const table = openFgaTypeTable(kinds);
  const resourceTypes = [...new Set(table.values())].sort();
  const grantUserset = [{ type: SUBJECT_TYPES.grant, relation: GRANT_SUBJECT_RELATION }];
  const conditioned = (type: string, relation?: string) =>
    relation === undefined
      ? { type, condition: VALID_WINDOW_CONDITION }
      : { type, relation, condition: VALID_WINDOW_CONDITION };

  const typeDefinitions: Record<string, unknown>[] = [
    { type: SUBJECT_TYPES.user },
    ...[SUBJECT_TYPES.group, SUBJECT_TYPES.link, SUBJECT_TYPES.role].map((type) => ({
      type,
      relations: { [MEMBER_RELATION]: { this: {} } },
      metadata: {
        relations: { [MEMBER_RELATION]: { directly_related_user_types: [{ type: "user" }] } },
      },
    })),
    {
      type: SUBJECT_TYPES.grant,
      relations: { [GRANT_SUBJECT_RELATION]: { this: {} } },
      metadata: {
        relations: {
          [GRANT_SUBJECT_RELATION]: {
            directly_related_user_types: [
              { type: SUBJECT_TYPES.user },
              conditioned(SUBJECT_TYPES.user),
              { type: SUBJECT_TYPES.link, relation: MEMBER_RELATION },
              conditioned(SUBJECT_TYPES.link, MEMBER_RELATION),
              { type: SUBJECT_TYPES.group, relation: MEMBER_RELATION },
              conditioned(SUBJECT_TYPES.group, MEMBER_RELATION),
              { type: SUBJECT_TYPES.role, relation: MEMBER_RELATION },
              conditioned(SUBJECT_TYPES.role, MEMBER_RELATION),
            ],
          },
        },
      },
    },
  ];

  for (const type of resourceTypes) {
    const relations: Record<string, Userset> = { [PARENT_RELATION]: { this: {} } };
    const metadata: Record<string, unknown> = {
      [PARENT_RELATION]: {
        directly_related_user_types: resourceTypes.map((t) => ({ type: t })),
      },
    };
    for (const cap of CAPABILITIES) {
      for (const tier of TIERS) {
        const allow = ruleRelation(cap, tier, "allow");
        const exclude = ruleRelation(cap, tier, "exclude");
        relations[allow] = { this: {} };
        relations[exclude] = { this: {} };
        metadata[allow] = { directly_related_user_types: grantUserset };
        metadata[exclude] = { directly_related_user_types: grantUserset };
      }
      // Inside out: what the parent decides, overridden by the role tier, then group, link and
      // membership — each tier: (allow − exclude) ∪ (below − (allow ∪ exclude)).
      let decided: Userset = {
        tupleToUserset: {
          tupleset: { relation: PARENT_RELATION },
          computedUserset: { relation: cap },
        },
      };
      for (const tier of [...TIERS].reverse()) {
        const allow = computed(ruleRelation(cap, tier, "allow"));
        const exclude = computed(ruleRelation(cap, tier, "exclude"));
        decided = union([difference(allow, exclude), difference(decided, union([allow, exclude]))]);
      }
      relations[cap] = decided;
    }
    typeDefinitions.push({ type, relations, metadata: { relations: metadata } });
  }

  return {
    schema_version: OPENFGA_SCHEMA_VERSION,
    type_definitions: typeDefinitions,
    conditions: {
      [VALID_WINDOW_CONDITION]: {
        name: VALID_WINDOW_CONDITION,
        expression: "current_time >= not_before && current_time < not_after",
        parameters: { current_time: TIMESTAMP, not_before: TIMESTAMP, not_after: TIMESTAMP },
      },
    },
  };
}

/** First 16 hex chars of SHA-256 over the model JSON. */
export function modelHash(model: OpenFgaModel): string {
  return createHash("sha256").update(JSON.stringify(model)).digest("hex").slice(0, 16);
}

/** `modelRef` persisted by the kernel: `<authorization_model_id>:<modelHash>`. */
export function formatModelRef(modelId: string, hash: string): string {
  return `${modelId}:${hash}`;
}

export function parseModelRef(
  ref: string | null,
): { readonly modelId: string; readonly hash: string } | null {
  if (ref === null) return null;
  const at = ref.indexOf(":");
  if (at <= 0) return { modelId: ref, hash: "" };
  return { modelId: ref.slice(0, at), hash: ref.slice(at + 1) };
}
