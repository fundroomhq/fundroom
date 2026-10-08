import { describe, expect, it } from "vitest";
import { earliestOf, gateVerdictExpiry, pendingGatesAtRebuild } from "./evaluate.js";
import type { Gate, Principal, PrincipalAttestation } from "./model.js";

/*
 * When a gate verdict lapses on its own (E2.10): an `accredited` attestation ageing past
 * `maxAgeDays`, an attestation reaching `expires_at`, or the membership expiring must bound the
 * materialised row, or the rebuild never runs and the gate stays open (fail-open in time).
 */

const NOW = new Date("2026-09-11T12:00:00Z");
const MS = 1;
const DAY = 24 * 3600_000;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

const M = "01920000-0000-7000-8000-00000000000a";
const G1 = "01920000-0000-7000-8000-00000000000b";
const POST = { kind: "post", id: "01920000-0000-7000-8000-0000000000e0" };
const OTHER_POST = { kind: "post", id: "01920000-0000-7000-8000-0000000000e1" };

const who = (
  attestations: PrincipalAttestation[],
  expiresAt: Date | undefined = undefined,
): Principal => ({
  membershipId: M,
  kind: "external",
  role: "investor",
  groupIds: [G1],
  linkIds: [],
  attestations,
  expiresAt,
});

const accredited = (maxAgeDays: unknown, target: Gate["target"] = { kind: "workspace" }): Gate => ({
  policyId: "p-acc",
  kind: "accredited",
  config: maxAgeDays === undefined ? {} : { maxAgeDays },
  target,
});
const nda = (stamp: string): Gate => ({
  policyId: "p-nda",
  kind: "nda",
  config: { stamp },
  target: { kind: "workspace" },
});

describe("gateVerdictExpiry", () => {
  it("is undefined with no gates and no membership expiry", () => {
    expect(gateVerdictExpiry([], who([]), POST, NOW)).toBeUndefined();
  });

  it("bounds a satisfied accredited gate one millisecond after the attestation ages out", () => {
    const signedAt = at(-10 * DAY);
    const exp = gateVerdictExpiry(
      [accredited(30)],
      who([{ kind: "accredited", signedAt }]),
      POST,
      NOW,
    );
    expect(exp).toEqual(new Date(signedAt.getTime() + 30 * DAY + MS));
    // …and that instant is exactly when the gate turns pending again.
    const p = who([{ kind: "accredited", signedAt }]);
    const lapse = exp ?? NOW;
    expect(
      pendingGatesAtRebuild([accredited(30)], p, POST, new Date(lapse.getTime() - MS)),
    ).toEqual([]);
    expect(pendingGatesAtRebuild([accredited(30)], p, POST, lapse)).toHaveLength(1);
  });

  it("uses the 365-day default when maxAgeDays is missing or not a finite number", () => {
    const signedAt = at(-DAY);
    for (const bad of [undefined, "30", Number.NaN]) {
      expect(
        gateVerdictExpiry([accredited(bad)], who([{ kind: "accredited", signedAt }]), POST, NOW),
      ).toEqual(new Date(signedAt.getTime() + 365 * DAY + MS));
    }
  });

  it("takes the freshest accreditation, since any one of them satisfies the gate", () => {
    const old = at(-20 * DAY);
    const fresh = at(-2 * DAY);
    const p = who([
      { kind: "accredited", signedAt: old },
      { kind: "accredited", signedAt: fresh },
      { kind: "accredited", signedAt: at(-5 * DAY) },
    ]);
    expect(gateVerdictExpiry([accredited(30)], p, POST, NOW)).toEqual(
      new Date(fresh.getTime() + 30 * DAY + MS),
    );
  });

  it("caps an accreditation by its own expires_at when that comes first", () => {
    const p = who([{ kind: "accredited", signedAt: at(-DAY), expiresAt: at(3 * DAY) }]);
    expect(gateVerdictExpiry([accredited(30)], p, POST, NOW)).toEqual(at(3 * DAY));
    const late = who([{ kind: "accredited", signedAt: at(-DAY), expiresAt: at(90 * DAY) }]);
    expect(gateVerdictExpiry([accredited(30)], late, POST, NOW)).toEqual(at(-DAY + 30 * DAY + MS));
  });

  it("ignores accreditations that no longer satisfy the gate, and other kinds", () => {
    const p = who([
      { kind: "accredited", signedAt: at(-31 * DAY) }, // aged out
      { kind: "accredited", signedAt: at(-DAY), expiresAt: NOW }, // expired this instant
      { kind: "nda:v1", signedAt: NOW },
    ]);
    // Pending already: time cannot make it any more pending, so nothing lapses.
    expect(gateVerdictExpiry([accredited(30)], p, POST, NOW)).toBeUndefined();
  });

  it("bounds a signed NDA by the signature's expires_at, and never lapses an open-ended one", () => {
    const p = who([
      { kind: "mutual:v2", signedAt: at(-DAY), expiresAt: at(5 * DAY) },
      { kind: "mutual:v1", signedAt: at(-DAY), expiresAt: at(DAY) }, // other version: irrelevant
    ]);
    expect(gateVerdictExpiry([nda("mutual:v2")], p, POST, NOW)).toEqual(at(5 * DAY));
    const open = who([
      { kind: "mutual:v2", signedAt: at(-DAY), expiresAt: at(2 * DAY) },
      { kind: "mutual:v2", signedAt: at(-DAY) },
    ]);
    expect(gateVerdictExpiry([nda("mutual:v2")], open, POST, NOW)).toBeUndefined();
    // NDA age is not limited: a signature from years ago holds.
    const ancient = who([{ kind: "mutual:v2", signedAt: at(-3000 * DAY) }]);
    expect(gateVerdictExpiry([nda("mutual:v2")], ancient, POST, NOW)).toBeUndefined();
  });

  it("is the earliest lapse across gates and the membership", () => {
    const p = who(
      [
        { kind: "accredited", signedAt: at(-25 * DAY) }, // lapses in 5 days (+1 ms)
        { kind: "nda:v1", signedAt: at(-DAY), expiresAt: at(2 * DAY) },
      ],
      at(10 * DAY),
    );
    expect(gateVerdictExpiry([accredited(30), nda("nda:v1")], p, POST, NOW)).toEqual(at(2 * DAY));
    expect(gateVerdictExpiry([accredited(30)], p, POST, NOW)).toEqual(at(5 * DAY + MS));
    expect(gateVerdictExpiry([], p, POST, NOW)).toEqual(at(10 * DAY));
    const soon = who([{ kind: "accredited", signedAt: at(-25 * DAY) }], at(DAY));
    expect(gateVerdictExpiry([accredited(30)], soon, POST, NOW)).toEqual(at(DAY));
  });

  it("only counts gates that apply to this principal on this resource", () => {
    const p = who([{ kind: "accredited", signedAt: at(-DAY) }]);
    const onOther: Gate = accredited(30, { kind: "resource", resource: OTHER_POST });
    expect(gateVerdictExpiry([onOther], p, POST, NOW)).toBeUndefined();
    expect(gateVerdictExpiry([onOther], p, OTHER_POST, NOW)).toEqual(at(29 * DAY + MS));
    const otherGroup = accredited(30, {
      kind: "group",
      id: "01920000-0000-7000-8000-0000000000ff",
    });
    expect(gateVerdictExpiry([otherGroup], p, POST, NOW)).toBeUndefined();
  });

  it("ignores session-bound gates, which are settled per request", () => {
    const p = who([{ kind: "accredited", signedAt: at(-DAY) }]);
    const mfa: Gate = {
      policyId: "p-mfa",
      kind: "min_auth_level",
      config: { level: 2 },
      target: { kind: "workspace" },
    };
    expect(gateVerdictExpiry([mfa], p, POST, NOW)).toBeUndefined();
  });
});

describe("earliestOf", () => {
  it("treats undefined as never and otherwise picks the earlier instant", () => {
    expect(earliestOf(undefined, undefined)).toBeUndefined();
    expect(earliestOf(NOW, undefined)).toBe(NOW);
    expect(earliestOf(undefined, NOW)).toBe(NOW);
    const later = at(MS);
    expect(earliestOf(NOW, later)).toBe(NOW);
    expect(earliestOf(later, NOW)).toBe(NOW);
    const same = new Date(NOW.getTime());
    expect(earliestOf(NOW, same)).toBe(NOW);
  });
});
