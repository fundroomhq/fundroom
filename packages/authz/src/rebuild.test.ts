import { describe, expect, it } from "vitest";
import type { Gate, Principal, Rule } from "./model.js";
import { computeEffectiveRows, locatedDocumentIds } from "./rebuild.js";

const NOW = new Date("2026-09-11T12:00:00Z");
const UNTIL = new Date("2026-12-31T00:00:00Z");
const M = "01920000-0000-7000-8000-00000000000a";
const principal: Principal = {
  membershipId: M,
  kind: "external",
  role: "investor",
  groupIds: [],
  linkIds: [],
  attestations: [],
};
const base: Rule = {
  grantId: "g1",
  subject: { kind: "membership", id: M },
  resource: { kind: "post", id: "p1" },
  capability: "view",
  effect: "allow",
  validFrom: undefined,
  validUntil: undefined,
};

describe("computeEffectiveRows", () => {
  it("stores the row's expiry, and null when nothing expires", () => {
    const [timed] = computeEffectiveRows([principal], [{ ...base, validUntil: UNTIL }], [], 1, NOW);
    expect(timed).toMatchObject({ expiresAt: UNTIL, resourcePath: null, computedAt: NOW });
    const [open] = computeEffectiveRows([principal], [base], [], 1, NOW);
    expect(open?.expiresAt).toBeNull();
  });

  it("bounds the row by an ageing accreditation or the membership, not only by grants", () => {
    const signedAt = new Date(NOW.getTime() - 10 * 24 * 3600_000);
    const accredited = {
      policyId: "p",
      kind: "accredited" as const,
      config: { maxAgeDays: 30 },
      target: { kind: "workspace" as const },
    };
    const lapse = new Date(signedAt.getTime() + 30 * 24 * 3600_000 + 1);
    const holder = { ...principal, attestations: [{ kind: "accredited", signedAt }] };
    const [aged] = computeEffectiveRows([holder], [base], [accredited], 1, NOW);
    expect(aged?.pendingGates).toEqual([]);
    expect(aged?.expiresAt).toEqual(lapse);
    // The grant ends first → the grant's end.
    const [grantFirst] = computeEffectiveRows(
      [holder],
      [{ ...base, validUntil: new Date(NOW.getTime() + 1000) }],
      [accredited],
      1,
      NOW,
    );
    expect(grantFirst?.expiresAt).toEqual(new Date(NOW.getTime() + 1000));
    // The gate lapses first even though the grant has an end → the gate's lapse.
    const [gateFirst] = computeEffectiveRows(
      [holder],
      [{ ...base, validUntil: UNTIL }],
      [accredited],
      1,
      NOW,
    );
    expect(gateFirst?.expiresAt).toEqual(lapse);
    const leaving = { ...principal, expiresAt: new Date(NOW.getTime() + 5000) };
    const [member] = computeEffectiveRows([leaving], [base], [], 1, NOW);
    expect(member?.expiresAt).toEqual(new Date(NOW.getTime() + 5000));
  });

  it("carries the pending gates of the node", () => {
    const [row] = computeEffectiveRows(
      [principal],
      [base],
      [{ policyId: "p", kind: "nda", config: { version: "v2" }, target: { kind: "workspace" } }],
      3,
      NOW,
    );
    expect(row?.pendingGates).toEqual([
      {
        kind: "nda",
        detail: { stamp: "nda:v2", version: "v2", documentId: null },
        source: "workspace",
      },
    ]);
  });

  describe("the staff-only veil (E3.5)", () => {
    const S = "01920000-0000-7000-8000-0000000000f1";
    const SPATH = "r.019200000000700080000000000000f1";
    const INNER = "01920000-0000-7000-8000-0000000000f2";
    const INNER_PATH = `${SPATH}.019200000000700080000000000000f2`;
    const OTHER = "01920000-0000-7000-8000-0000000000f3";
    const OTHER_PATH = "r.019200000000700080000000000000f3";
    const ROOT = "01920000-0000-7000-8000-0000000000f0";
    const DOC = "01920000-0000-7000-8000-0000000000d1";
    const staffOnly = [{ kind: "folder", id: S, path: SPATH }];
    const onFolder = (id: string, path: string, grantId = `g-${id}`): Rule => ({
      ...base,
      grantId,
      resource: { kind: "folder", id, path },
    });
    const rootRule = onFolder(ROOT, "r");
    const rowFor = (rows: ReturnType<typeof computeEffectiveRows>, id: string) =>
      rows.find((r) => r.resourceId === id);

    it("adds a zero row at the staff-only folder under an external's root grant", () => {
      const rows = computeEffectiveRows([principal], [rootRule], [], 1, NOW, new Map(), staffOnly);
      expect(rowFor(rows, ROOT)?.capabilities).toEqual(["view"]);
      expect(rowFor(rows, S)).toMatchObject({
        resourceKind: "folder",
        resourcePath: SPATH,
        capabilities: [],
        pendingGates: [],
        expiresAt: null,
      });
    });

    it("zeroes a grant on the staff-only folder itself, a folder inside it and a document in it", () => {
      const doc: Rule = { ...base, grantId: "gd", resource: { kind: "document", id: DOC } };
      const rows = computeEffectiveRows(
        [principal],
        [onFolder(S, SPATH), onFolder(INNER, INNER_PATH), doc, { ...doc, capability: "download" }],
        [],
        1,
        NOW,
        new Map([[`document:${DOC}`, INNER_PATH]]),
        staffOnly,
      );
      for (const id of [S, INNER, DOC]) expect(rowFor(rows, id)?.capabilities).toEqual([]);
      // One row per node: the staff-only folder's own row is not duplicated.
      expect(rows.filter((r) => r.resourceId === S)).toHaveLength(1);
    });

    it("keeps an exclude-free allow outside the veil and never veils staff", () => {
      const staff: Principal = {
        ...principal,
        membershipId: "01920000-0000-7000-8000-0000000000b1",
        kind: "staff",
        role: "admin",
      };
      const rows = computeEffectiveRows(
        [principal, staff],
        [
          onFolder(OTHER, OTHER_PATH),
          { ...onFolder(S, SPATH, "gs"), subject: { kind: "role", role: "admin" } },
        ],
        [],
        1,
        NOW,
        new Map(),
        staffOnly,
      );
      const mine = rows.filter((r) => r.membershipId === M);
      expect(rowFor(mine, OTHER)?.capabilities).toEqual(["view"]);
      const staffRow = rows.find((r) => r.membershipId !== M && r.resourceId === S);
      expect(staffRow?.capabilities).toEqual(["view"]);
    });

    it("veils share-link visitors, group members and delegates alike", () => {
      const link = "01920000-0000-7000-8000-0000000000a1";
      const group = "01920000-0000-7000-8000-0000000000a2";
      const principalId = "01920000-0000-7000-8000-0000000000a3";
      const visitor: Principal = { ...principal, linkIds: [link] };
      const member: Principal = { ...principal, groupIds: [group] };
      const delegate: Principal = {
        ...principal,
        role: "delegate",
        delegation: { principalMembershipId: principalId, principalGroupIds: [], scope: "all" },
      };
      for (const [p, subject] of [
        [visitor, { kind: "link", id: link }],
        [member, { kind: "group", id: group }],
        [delegate, { kind: "membership", id: principalId }],
      ] as const) {
        const rows = computeEffectiveRows(
          [p],
          [
            { ...rootRule, subject },
            { ...onFolder(S, SPATH), subject },
          ],
          [],
          1,
          NOW,
          new Map(),
          staffOnly,
        );
        expect(rowFor(rows, ROOT)?.capabilities).toEqual(["view"]);
        expect(rowFor(rows, S)?.capabilities).toEqual([]);
      }
    });

    it("changes nothing when the workspace has no staff-only folder", () => {
      const rules = [rootRule, onFolder(S, SPATH)];
      expect(computeEffectiveRows([principal], rules, [], 1, NOW, new Map(), [])).toEqual(
        computeEffectiveRows([principal], rules, [], 1, NOW),
      );
      expect(rowFor(computeEffectiveRows([principal], rules, [], 1, NOW), S)?.capabilities).toEqual(
        ["view"],
      );
    });

    it("leaves a document whose location is unknown alone (it is not in the tree)", () => {
      const doc: Rule = { ...base, grantId: "gd", resource: { kind: "document", id: DOC } };
      const rows = computeEffectiveRows([principal], [doc], [], 1, NOW, new Map(), staffOnly);
      expect(rowFor(rows, DOC)?.capabilities).toEqual(["view"]);
    });
  });

  describe("gates below a granted node (review AZ)", () => {
    const R = "01920000-0000-7000-8000-0000000000e0";
    const RPATH = "r.019200000000700080000000000000e0";
    const SUB = "01920000-0000-7000-8000-0000000000e1";
    const SUB_PATH = `${RPATH}.019200000000700080000000000000e1`;
    const DEEP = "01920000-0000-7000-8000-0000000000e2";
    const DEEP_PATH = `${SUB_PATH}.019200000000700080000000000000e2`;
    const ELSEWHERE = "r.019200000000700080000000000000e9";
    const DOC = "01920000-0000-7000-8000-0000000000d7";
    const onR: Rule = { ...base, grantId: "gr", resource: { kind: "folder", id: R, path: RPATH } };
    const ndaOn = (resource: Gate["target"], version = "v4"): Gate => ({
      policyId: `p-${version}`,
      kind: "nda",
      config: { version },
      target: resource,
    });
    const subGate = ndaOn({
      kind: "resource",
      resource: { kind: "folder", id: SUB, path: SUB_PATH },
    });
    const docGate = ndaOn({ kind: "resource", resource: { kind: "document", id: DOC } }, "v5");
    const pendingNda = (version: string, source: string) => [
      {
        kind: "nda",
        detail: { stamp: `nda:${version}`, version, documentId: null },
        source,
      },
    ];
    const rowFor = (rows: ReturnType<typeof computeEffectiveRows>, id: string) =>
      rows.filter((r) => r.resourceId === id);
    const kindsOf = (gates: unknown) =>
      (gates as readonly { kind: string }[] | undefined)?.map((g) => g.kind);

    it("gives a gated sub-folder of a granted folder its own row carrying the gate", () => {
      const rows = computeEffectiveRows([principal], [onR], [subGate], 1, NOW);
      expect(rowFor(rows, R)).toEqual([
        expect.objectContaining({ capabilities: ["view"], pendingGates: [] }),
      ]);
      expect(rowFor(rows, SUB)).toEqual([
        expect.objectContaining({
          resourceKind: "folder",
          resourcePath: SUB_PATH,
          capabilities: ["view"],
          pendingGates: pendingNda("v4", `resource:folder:${SUB}`),
        }),
      ]);
    });

    it("gives a gated document of a granted folder a path-less row carrying the gate", () => {
      const rows = computeEffectiveRows(
        [principal],
        [onR],
        [docGate],
        1,
        NOW,
        new Map([[`document:${DOC}`, SUB_PATH]]),
      );
      expect(rowFor(rows, DOC)).toEqual([
        expect.objectContaining({
          resourceKind: "document",
          // Never the folder's path: that would cover every sibling.
          resourcePath: null,
          capabilities: ["view"],
          pendingGates: pendingNda("v5", `resource:document:${DOC}`),
        }),
      ]);
      // A document nobody knows the location of is not in the tree: no row.
      expect(rowFor(computeEffectiveRows([principal], [onR], [docGate], 1, NOW), DOC)).toEqual([]);
    });

    it("applies a gate on a folder to a document inside it that was granted directly", () => {
      const doc: Rule = { ...base, grantId: "gd", resource: { kind: "document", id: DOC } };
      const rows = computeEffectiveRows(
        [principal],
        [doc],
        [subGate],
        1,
        NOW,
        new Map([[`document:${DOC}`, DEEP_PATH]]),
      );
      expect(rowFor(rows, DOC)).toEqual([
        expect.objectContaining({
          resourcePath: null,
          capabilities: ["view"],
          pendingGates: pendingNda("v4", `resource:folder:${SUB}`),
        }),
      ]);
      // The folder itself is not reached by any rule of theirs: no row there.
      expect(rowFor(rows, SUB)).toEqual([]);
    });

    it("adds nothing where no rule of the member reaches the gated node", () => {
      const elsewhere: Rule = {
        ...onR,
        resource: { kind: "folder", id: DEEP, path: ELSEWHERE },
      };
      const rows = computeEffectiveRows([principal], [elsewhere], [subGate], 1, NOW);
      expect(rows.map((r) => r.resourceId)).toEqual([DEEP]);
    });

    it("resolves the gated node like the node itself: an exclude there, one row, no capability", () => {
      const exclude: Rule = {
        ...onR,
        grantId: "gx",
        effect: "exclude",
        resource: { kind: "folder", id: SUB, path: SUB_PATH },
      };
      const rows = computeEffectiveRows([principal], [onR, exclude], [subGate], 1, NOW);
      expect(rowFor(rows, SUB)).toEqual([expect.objectContaining({ capabilities: [] })]);
    });

    it("keeps the row (no pending gate) once the NDA is signed, and still veils", () => {
      const signed = {
        ...principal,
        attestations: [{ kind: "nda:v4", signedAt: NOW }],
      };
      expect(rowFor(computeEffectiveRows([signed], [onR], [subGate], 1, NOW), SUB)).toEqual([
        expect.objectContaining({ capabilities: ["view"], pendingGates: [] }),
      ]);
      const veiled = computeEffectiveRows([principal], [onR], [subGate], 1, NOW, new Map(), [
        { kind: "folder", id: SUB, path: SUB_PATH },
      ]);
      expect(rowFor(veiled, SUB)).toEqual([
        expect.objectContaining({ capabilities: [], pendingGates: [] }),
      ]);
    });

    it("binds a delegate on what it borrows, with its own attestations", () => {
      const principalId = "01920000-0000-7000-8000-0000000000a9";
      const delegate: Principal = {
        ...principal,
        role: "delegate",
        delegation: { principalMembershipId: principalId, principalGroupIds: [], scope: "all" },
      };
      const borrowed: Rule = { ...onR, subject: { kind: "membership", id: principalId } };
      const rows = computeEffectiveRows(
        [delegate],
        [borrowed],
        [docGate],
        1,
        NOW,
        new Map([[`document:${DOC}`, RPATH]]),
      );
      expect(rowFor(rows, DOC)).toEqual([
        expect.objectContaining({
          capabilities: ["view"],
          pendingGates: pendingNda("v5", `resource:document:${DOC}`),
        }),
      ]);
    });

    it("gives every gated node its row, one per node however many gates sit on it", () => {
      const rows = computeEffectiveRows(
        [principal],
        [onR],
        [subGate, docGate, { ...subGate, policyId: "p-again", kind: "accredited", config: {} }],
        1,
        NOW,
        new Map([[`document:${DOC}`, SUB_PATH]]),
      );
      expect(rows.map((r) => r.resourceId).sort()).toEqual([R, SUB, DOC].sort());
      expect(kindsOf(rowFor(rows, SUB)[0]?.pendingGates)).toEqual(["nda", "accredited"]);
      // The document inside the gated sub-folder carries both the folder's gates and its own.
      expect(kindsOf(rowFor(rows, DOC)[0]?.pendingGates)).toEqual(["nda", "nda", "accredited"]);
    });

    it("gives a member with no rule no row at all, gated or veiled", () => {
      expect(
        computeEffectiveRows([principal], [], [subGate], 1, NOW, new Map(), [
          { kind: "folder", id: SUB, path: SUB_PATH },
        ]),
      ).toEqual([]);
    });

    it("asks for document locations whenever a resource-targeted gate exists", () => {
      const doc: Rule = { ...base, grantId: "gd", resource: { kind: "document", id: "d1" } };
      expect(locatedDocumentIds([principal], [doc], [], [])).toEqual([]);
      // …and, as before, for the staff-only veil or a delegate.
      expect(
        locatedDocumentIds([principal], [doc], [], [{ kind: "folder", id: SUB, path: SUB_PATH }]),
      ).toEqual(["d1"]);
      const delegate: Principal = {
        ...principal,
        role: "delegate",
        delegation: { principalMembershipId: M, principalGroupIds: [], scope: "all" },
      };
      expect(locatedDocumentIds([principal, delegate], [doc], [], [])).toEqual(["d1"]);
      expect(locatedDocumentIds([principal], [doc], [ndaOn({ kind: "workspace" })], [])).toEqual(
        [],
      );
      expect(locatedDocumentIds([principal], [doc, onR], [docGate], []).sort()).toEqual(
        ["d1", DOC].sort(),
      );
      expect(locatedDocumentIds([principal], [doc], [subGate], [])).toEqual(["d1"]);
    });
  });
});

describe("a document's own rule keeps what its folders grant (E3.13 R3-2)", () => {
  const folderView: Rule = {
    ...base,
    grantId: "fv",
    resource: { kind: "folder", id: "f1", path: "r.f1" },
  };
  const docDownload: Rule = {
    ...base,
    grantId: "dd",
    resource: { kind: "document", id: "d1" },
    capability: "download",
  };
  const docRow = (rules: Rule[], p: Principal = principal) =>
    computeEffectiveRows([p], rules, [], 1, NOW, new Map([["document:d1", "r.f1"]])).find(
      (r) => r.resourceKind === "document",
    );

  it("resolves the document where it sits: inherited view plus its own download", () => {
    expect(docRow([folderView, docDownload])?.capabilities).toEqual(["view", "download"]);
    // The stored row still carries no path (a leaf never covers a sibling).
    expect(docRow([folderView, docDownload])?.resourcePath).toBeNull();
  });

  it("a document exclude still beats the folder allow (nearest wins)", () => {
    const docExclude: Rule = {
      ...docDownload,
      grantId: "dx",
      capability: "view",
      effect: "exclude",
    };
    expect(docRow([folderView, docExclude])?.capabilities).toEqual([]);
  });

  it("an unlocated document (no location known) is resolved by its own rules alone", () => {
    const [row] = computeEffectiveRows([principal], [docDownload], [], 1, NOW);
    expect(row?.capabilities).toEqual(["download"]);
  });
});
