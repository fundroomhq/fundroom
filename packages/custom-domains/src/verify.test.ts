import type { DnsAnswer, DnsRecordType } from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import { CHALLENGE_LABEL, LEGACY_CHALLENGE_LABEL } from "./records.js";
import { evaluate, txtCarriesToken } from "./verify.js";

const TOKEN = "abcdefghijklmnopqrstuvwxyz234567";
const TARGET = "edge.fundroom.app";
const HOST = "investors.acme.com";
const TXT_NAME = `_fundroom-challenge.${HOST}`;
const BEL = String.fromCharCode(7);

function answer(over: Partial<DnsAnswer> & { type: DnsRecordType }): DnsAnswer {
  return {
    name: HOST,
    values: [],
    rcode: "ok",
    resolver: "1.1.1.1",
    ...over,
  };
}

const goodCname = answer({ type: "CNAME", values: [TARGET] });
const goodTxt = answer({ type: "TXT", name: TXT_NAME, values: [TOKEN] });

/** `caddy-ask`: it issues the certificate, so it checks both records. */
const BOTH = { cname: true, txt: true } as const;
/** `manual`: the operator terminates TLS on their own edge, so control is all we verify. */
const TXT_ONLY = { cname: false, txt: true } as const;

function run(cname: DnsAnswer, txt: DnsAnswer) {
  return evaluate({ cname, txt, token: TOKEN, cnameTarget: TARGET, requires: BOTH });
}

describe("evaluate", () => {
  it("verifies when the CNAME and the TXT both match", () => {
    const verdict = run(goodCname, goodTxt);
    expect(verdict).toMatchObject({ ok: true, cnameOk: true, txtOk: true });
    expect(verdict.detail).toContain(TARGET);
  });

  it("accepts a trailing dot and mixed case from the resolver", () => {
    const cname = answer({ type: "CNAME", values: ["Edge.FundRoom.App."] });
    expect(run(cname, goodTxt).cnameOk).toBe(true);
  });

  it("accepts a chain that ends at the target", () => {
    const cname = answer({
      type: "CNAME",
      values: ["proxy.example.net"],
      chain: ["proxy.example.net", TARGET],
    });
    const verdict = run(cname, goodTxt);
    expect(verdict.cnameOk).toBe(true);
    expect(verdict.detail).toContain("via proxy.example.net");
  });

  it("accepts a chain that passes through the target", () => {
    const cname = answer({
      type: "CNAME",
      values: ["proxy.example.net"],
      chain: ["proxy.example.net", TARGET, "edge-pool-3.fundroom.app"],
    });
    expect(run(cname, goodTxt).cnameOk).toBe(true);
  });

  it("accepts A records pointing at us for apex flattening", () => {
    const cname = answer({ type: "A", name: "acme.com", values: ["203.0.113.7"] });
    const verdict = evaluate({
      cname,
      txt: goodTxt,
      token: TOKEN,
      cnameTarget: "203.0.113.7",
      requires: BOTH,
    });
    expect(verdict).toMatchObject({ ok: true, cnameOk: true });
  });

  it("accepts AAAA records pointing at us", () => {
    const cname = answer({ type: "AAAA", name: "acme.com", values: ["2001:db8::7"] });
    const verdict = evaluate({
      cname,
      txt: goodTxt,
      token: TOKEN,
      cnameTarget: "2001:db8::7",
      requires: BOTH,
    });
    expect(verdict.cnameOk).toBe(true);
  });

  it("refuses a CNAME to somewhere else and names where it actually points", () => {
    const cname = answer({ type: "CNAME", values: ["shops.myshopify.com"] });
    const verdict = run(cname, goodTxt);
    expect(verdict).toMatchObject({ ok: false, cnameOk: false, txtOk: true });
    expect(verdict.detail).toContain("shops.myshopify.com");
    expect(verdict.detail).toContain(TARGET);
  });

  it("names NXDOMAIN rather than saying verification failed", () => {
    const cname = answer({ type: "CNAME", rcode: "nxdomain" });
    const verdict = run(cname, answer({ type: "TXT", name: TXT_NAME, rcode: "nxdomain" }));
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain("NXDOMAIN");
    expect(verdict.detail).toContain("1.1.1.1");
    expect(verdict.detail).not.toContain("verification failed");
  });

  it("names SERVFAIL and points at the zone's nameservers", () => {
    const cname = answer({ type: "CNAME", rcode: "servfail" });
    expect(run(cname, goodTxt).detail).toContain("SERVFAIL");
  });

  it("names a refusal", () => {
    const cname = answer({ type: "CNAME", rcode: "refused" });
    expect(run(cname, goodTxt).detail).toContain("refused");
  });

  it("reports resolver disagreement as an unusable answer, not as a missing record", () => {
    const cname = answer({ type: "CNAME", rcode: "other" });
    const verdict = run(cname, goodTxt);
    expect(verdict.cnameOk).toBe(false);
    expect(verdict.detail).toContain("disagreed");
  });

  it("suggests flattening when an apex has no CNAME at all", () => {
    const cname = answer({ type: "CNAME", name: "acme.com", values: [] });
    expect(run(cname, goodTxt).detail).toContain("flattening");
  });

  it("accepts a quoted, chunked TXT value", () => {
    const chunked = `"${TOKEN.slice(0, 16)}" "${TOKEN.slice(16)}"`;
    const txt = answer({ type: "TXT", name: TXT_NAME, values: [chunked] });
    expect(run(goodCname, txt).txtOk).toBe(true);
  });

  it("accepts the token among several TXT records on the same name", () => {
    const txt = answer({
      type: "TXT",
      name: TXT_NAME,
      values: ["v=spf1 -all", TOKEN.toUpperCase()],
    });
    expect(run(goodCname, txt).txtOk).toBe(true);
  });

  it("refuses a near-miss token and quotes what it found", () => {
    const txt = answer({ type: "TXT", name: TXT_NAME, values: [`${TOKEN.slice(0, 31)}x`] });
    const verdict = run(goodCname, txt);
    expect(verdict).toMatchObject({ ok: false, cnameOk: true, txtOk: false });
    expect(verdict.detail).toContain("different token");
  });

  it("refuses a token that is a prefix of the expected one", () => {
    const txt = answer({ type: "TXT", name: TXT_NAME, values: [TOKEN.slice(0, 16)] });
    expect(run(goodCname, txt).txtOk).toBe(false);
  });

  it("strips control characters out of a value it echoes back", () => {
    const txt = answer({ type: "TXT", name: TXT_NAME, values: [`bad${BEL}value`] });
    const verdict = run(goodCname, txt);
    expect(verdict.detail).not.toContain(BEL);
    expect(verdict.detail).toContain("bad?value");
  });

  it("truncates a very long TXT value before echoing it", () => {
    const txt = answer({ type: "TXT", name: TXT_NAME, values: ["z".repeat(300)] });
    expect(run(goodCname, txt).detail).toContain("…");
    expect(run(goodCname, txt).detail.length).toBeLessThan(400);
  });

  it("never verifies on an empty target or an empty token", () => {
    expect(
      evaluate({ cname: goodCname, txt: goodTxt, token: TOKEN, cnameTarget: "", requires: BOTH })
        .cnameOk,
    ).toBe(false);
    expect(
      evaluate({ cname: goodCname, txt: goodTxt, token: "", cnameTarget: TARGET, requires: BOTH })
        .txtOk,
    ).toBe(false);
  });

  it("requires both halves for ok", () => {
    const noTxt = answer({ type: "TXT", name: TXT_NAME, values: [] });
    expect(run(goodCname, noTxt).ok).toBe(false);
    const noCname = answer({ type: "CNAME", values: [] });
    expect(run(noCname, goodTxt).ok).toBe(false);
  });
});

/*
 * The `manual` driver (E2.1 defect 1). `ok` used to be `cnameOk && txtOk` unconditionally,
 * which meant a `manual` install showed the founder a TXT record, accepted it, and then failed
 * the domain on a CNAME nobody had mentioned — and with no CNAME target configured at all
 * (`cnameTarget: ""`, the default on a `manual` install) the domain could never verify, ever.
 * These are the assertions that would have caught it.
 */
describe("evaluate with a TXT-only provider (`manual`)", () => {
  /** NXDOMAIN on the CNAME question: the shape when the name points at the operator's own
   *  proxy by A record, or has no CNAME at all. */
  const noCname = answer({ type: "CNAME", rcode: "nxdomain" });

  it("verifies on the TXT alone, with no CNAME and no target configured", () => {
    const verdict = evaluate({
      cname: noCname,
      txt: goodTxt,
      token: TOKEN,
      cnameTarget: "",
      requires: TXT_ONLY,
    });
    expect(verdict).toMatchObject({ ok: true, txtOk: true, cnameOk: false });
  });

  it("verifies even when the CNAME points somewhere else entirely", () => {
    // The operator's own edge, a CDN, anything: where the hostname routes is not our business
    // when we are not the ones terminating TLS.
    const elsewhere = answer({ type: "CNAME", values: ["proxy.acme.internal"] });
    const verdict = evaluate({
      cname: elsewhere,
      txt: goodTxt,
      token: TOKEN,
      cnameTarget: TARGET,
      requires: TXT_ONLY,
    });
    expect(verdict.ok).toBe(true);
  });

  it("never mentions a CNAME in the detail of a failed verification", () => {
    const noTxt = answer({ type: "TXT", name: TXT_NAME, values: [] });
    const verdict = evaluate({
      cname: noCname,
      txt: noTxt,
      token: TOKEN,
      cnameTarget: TARGET,
      requires: TXT_ONLY,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.detail.toLowerCase()).not.toContain("cname");
    expect(verdict.detail).not.toContain(TARGET);
    // It still says what is actually wrong.
    expect(verdict.detail).toContain(TXT_NAME);
    expect(verdict.detail).toContain("no TXT record");
  });

  it("does not mention a CNAME on a successful verification either", () => {
    const verdict = evaluate({
      cname: goodCname,
      txt: goodTxt,
      token: TOKEN,
      cnameTarget: TARGET,
      requires: TXT_ONLY,
    });
    expect(verdict.detail.toLowerCase()).not.toContain("cname");
    // Not even the target: a `manual` operator has no reason to hear about our edge host.
    expect(verdict.detail).not.toContain(TARGET);
    expect(verdict.detail).toContain("TXT matches");
  });

  it("still refuses a wrong token: control of the name is the one thing it checks", () => {
    const wrong = answer({ type: "TXT", name: TXT_NAME, values: ["not-the-token"] });
    const verdict = evaluate({
      cname: goodCname,
      txt: wrong,
      token: TOKEN,
      cnameTarget: TARGET,
      requires: TXT_ONLY,
    });
    expect(verdict).toMatchObject({ ok: false, txtOk: false });
  });

  it("is the only driver that skips the CNAME — `caddy-ask` still requires both", () => {
    const input = { cname: noCname, txt: goodTxt, token: TOKEN, cnameTarget: TARGET } as const;
    expect(evaluate({ ...input, requires: TXT_ONLY }).ok).toBe(true);
    expect(evaluate({ ...input, requires: BOTH }).ok).toBe(false);
    expect(evaluate({ ...input, requires: BOTH }).detail).toContain(TARGET);
  });
});

/*
 * A positive verdict requires `rcode === "ok"` (E2.1 M11).
 *
 * Confirmed before the fix: a `Status: 2` (SERVFAIL) response that happened to carry an answer
 * record verified the domain, and so did an answer whose owner name was an unrelated host (the
 * adapter now drops that one). Neither is reachable without two colluding resolvers, so
 * decision 6 still carries the weight — but "the zone's nameservers did not answer" is not an
 * answer we are entitled to act on, and `modules/updates`' `lookupTxt` already said so.
 */
describe("rcode gates the positive verdict", () => {
  for (const rcode of ["servfail", "refused", "other", "nxdomain"] as const) {
    it(`refuses a ${rcode} answer even when it carries the right records`, () => {
      const verdict = evaluate({
        cname: { ...goodCname, rcode },
        txt: { ...goodTxt, rcode },
        token: TOKEN,
        cnameTarget: TARGET,
        requires: { cname: true, txt: true },
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.cnameOk).toBe(false);
      expect(verdict.txtOk).toBe(false);
      // And it says what actually happened rather than "the record is missing".
      expect(verdict.detail).not.toContain("points at");
    });
  }

  it("still verifies on a plain ok", () => {
    expect(
      evaluate({
        cname: goodCname,
        txt: goodTxt,
        token: TOKEN,
        cnameTarget: TARGET,
        requires: { cname: true, txt: true },
      }).ok,
    ).toBe(true);
  });
});

/*
 * A-2: the label a TXT answer was looked up under is named in the sentence. `judge()` passes the
 * pre-rename label when that is the record that matched, and the sentence must say so — telling
 * a customer their `_fundroom-challenge` matches when it is `_seedhost-challenge` doing the work
 * is the cue to delete the only record keeping their portal verified.
 */
describe("the label named in the verdict", () => {
  const verdictFor = (txtLabel?: string) =>
    evaluate({
      cname: goodCname,
      txt: goodTxt,
      token: TOKEN,
      cnameTarget: TARGET,
      requires: BOTH,
      ...(txtLabel === undefined ? {} : { txtLabel }),
    });

  it("names the current label by default", () => {
    expect(verdictFor().detail).toContain(`${CHALLENGE_LABEL} TXT matches`);
    expect(verdictFor().detail).not.toContain(LEGACY_CHALLENGE_LABEL);
  });

  it("names the pre-rename label when that is the one that matched, and points at the new one", () => {
    const detail = verdictFor(LEGACY_CHALLENGE_LABEL).detail;
    expect(detail).toContain(`${LEGACY_CHALLENGE_LABEL} TXT matches`);
    expect(detail).not.toContain(`${CHALLENGE_LABEL} TXT matches`);
    expect(detail).toContain(`${CHALLENGE_LABEL} is the current one`);
  });

  it("txtCarriesToken is the same test evaluate applies, rcode gate included", () => {
    expect(txtCarriesToken(goodTxt, TOKEN)).toBe(true);
    expect(txtCarriesToken({ ...goodTxt, values: ["v=spf1 -all", `"${TOKEN}"`] }, TOKEN)).toBe(
      true,
    );
    expect(txtCarriesToken({ ...goodTxt, values: ["nope"] }, TOKEN)).toBe(false);
    expect(txtCarriesToken({ ...goodTxt, rcode: "other" }, TOKEN)).toBe(false);
    expect(txtCarriesToken(goodTxt, "")).toBe(false);
  });
});
