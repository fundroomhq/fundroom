import { describe, expect, it } from "vitest";
import { type ConsentDecisionInput, consentAllows } from "./consent.js";

/*
 * R13's safety net. Every mode × every stored answer × GPC on / off, enumerated rather than
 * spot-checked, because the failure mode here is not a broken page: it is tracking somebody in a
 * jurisdiction where that is unlawful, silently, for as long as nobody notices.
 */

const MODES = ["opt_in", "opt_out", "notice_only"] as const;
const STORED = [true, false, null] as const;

/** The table this function is supposed to implement, written out by hand and compared to it. */
const EXPECTED: Readonly<Record<string, boolean>> = {
  // mode | stored | gpc
  "opt_in|true|false": true,
  "opt_in|false|false": false,
  "opt_in|null|false": false,
  "opt_out|true|false": true,
  "opt_out|false|false": false,
  "opt_out|null|false": true,
  "notice_only|true|false": true,
  "notice_only|false|false": false,
  "notice_only|null|false": true,
  // GPC is a flat no, whatever the mode says and whatever was stored.
  "opt_in|true|true": false,
  "opt_in|false|true": false,
  "opt_in|null|true": false,
  "opt_out|true|true": false,
  "opt_out|false|true": false,
  "opt_out|null|true": false,
  "notice_only|true|true": false,
  "notice_only|false|true": false,
  "notice_only|null|true": false,
};

describe("consentAllows", () => {
  for (const mode of MODES) {
    for (const stored of STORED) {
      for (const gpc of [false, true]) {
        const key = `${mode}|${stored}|${gpc}`;
        it(`${mode}, stored=${stored}, gpc=${gpc} → ${EXPECTED[key]}`, () => {
          expect(consentAllows({ mode, stored, gpc })).toBe(EXPECTED[key]);
        });
      }
    }
  }

  it("covers every combination the modes and answers can produce", () => {
    expect(Object.keys(EXPECTED)).toHaveLength(MODES.length * STORED.length * 2);
  });

  it("treats an absent gpc flag as no signal, not as a signal of false", () => {
    const base = { mode: "opt_out", stored: null } satisfies ConsentDecisionInput;
    expect(consentAllows(base)).toBe(true);
    expect(consentAllows({ ...base, gpc: undefined })).toBe(true);
  });

  it("lets an explicit withdrawal beat a permissive mode", () => {
    expect(consentAllows({ mode: "notice_only", stored: false })).toBe(false);
    expect(consentAllows({ mode: "opt_out", stored: false })).toBe(false);
  });

  it("lets GPC beat an explicit grant, because it is the more recent statement", () => {
    expect(consentAllows({ mode: "notice_only", stored: true, gpc: true })).toBe(false);
    expect(consentAllows({ mode: "opt_in", stored: true, gpc: true })).toBe(false);
  });

  it("defaults to no under opt_in for a member nobody has asked", () => {
    expect(consentAllows({ mode: "opt_in", stored: null })).toBe(false);
  });
});
