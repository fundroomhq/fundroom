import assert from "node:assert/strict";
import { test } from "node:test";
// biome-ignore lint/correctness/useImportExtensions: the module is .mjs; the rule's ".js" fix does not resolve under node --test (CI runs this file directly).
import { FOREIGN_DOMAIN, findForeignDomain } from "./check-foreign-domain.mjs";

// Built, not written out, so this file passes the check it tests.
const D = FOREIGN_DOMAIN;

test("the domain is the one FundRoom does not hold", () => {
  assert.equal(D, ["fundroom", "com"].join("."));
});

test("flags the domain, its subdomains and addresses, in any case", () => {
  assert.deepEqual(findForeignDomain(`see ${D}`), [1]);
  assert.deepEqual(findForeignDomain(`https://releases.${D}/index.json`), [1]);
  assert.deepEqual(findForeignDomain(`mailto:security@${D}`), [1]);
  assert.deepEqual(findForeignDomain(D.toUpperCase()), [1]);
  assert.deepEqual(findForeignDomain(`end of sentence ${D}.`), [1]);
  assert.deepEqual(findForeignDomain(`(${D})`), [1]);
});

test("reports the line of each match", () => {
  assert.deepEqual(findForeignDomain(`a\nb ${D}\nc\nwww.${D} and ${D}`), [2, 4, 4]);
});

test("ignores fundroom.io, the staging zone and longer names", () => {
  assert.deepEqual(findForeignDomain("security@fundroom.io releases.fundroom.io"), []);
  assert.deepEqual(findForeignDomain("app.fundroom-staging.com"), []);
  assert.deepEqual(findForeignDomain(`{{ include "${D}ponentSelectorLabels" . }}`), []);
  assert.deepEqual(findForeignDomain(`not${D}`), []);
  assert.deepEqual(findForeignDomain(`${D}-mirror.net`), []);
});
