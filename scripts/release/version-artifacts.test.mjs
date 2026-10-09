// node --test scripts/release/version-artifacts.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
// biome-ignore lint/correctness/useImportExtensions: the module is .mjs; the rule's ".js" fix does not resolve under node --test.
import { stampOpenApiVersion } from "./version-artifacts.mjs";

const DOC = `{
  "openapi": "3.1.0",
  "info": {
    "title": "FundRoom API",
    "version": "0.0.0",
    "license": {
      "name": "MIT"
    }
  },
  "components": {
    "schemas": {
      "Version": { "properties": { "version": { "type": "string" } } }
    }
  }
}
`;

test("stamps info.version and leaves every other byte alone", () => {
  const out = stampOpenApiVersion(DOC, "1.0.0-rc.0");
  assert.equal(out, DOC.replace('"version": "0.0.0"', '"version": "1.0.0-rc.0"'));
  assert.equal(JSON.parse(out).info.version, "1.0.0-rc.0");
});

test("is a no-op when the version already matches", () => {
  assert.equal(stampOpenApiVersion(DOC, "0.0.0"), DOC);
});

test("never stamps a nested version when info has none of its own", () => {
  const doc = DOC.replace('    "version": "0.0.0",\n', "").replace(
    '"name": "MIT"',
    '"name": "MIT", "version": "x"',
  );
  assert.throws(() => stampOpenApiVersion(doc, "1.0.0"), /no info\.version/u);
});

test("handles the committed document", () => {
  const text = readFileSync(new URL("../../packages/sdk/openapi.json", import.meta.url), "utf8");
  const version = JSON.parse(text).info.version;
  const out = stampOpenApiVersion(text, `${version}-test.1`);
  assert.equal(JSON.parse(out).info.version, `${version}-test.1`);
  assert.equal(stampOpenApiVersion(out, version), text);
});
