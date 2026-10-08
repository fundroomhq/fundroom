// node --test scripts/release/pack-check.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkConsumerOutput,
  checkManifest,
  checkTokensTarball,
  checkUiTarball,
  lockedVersions,
  minimumReleaseAge,
  publicStrays,
  REPOSITORY_URL,
  stylesheetEscapes,
  TOKENS_EXPORTS,
  TOKENS_FILES,
  unresolvedProtocols,
  // biome-ignore lint/correctness/useImportExtensions: the module is .mjs; the rule's ".js" fix does not resolve under node --test.
} from "./pack-check.mjs";

const base = (/** @type {string} */ name, /** @type {string} */ dir) => ({
  name,
  version: "1.0.0-rc.1",
  license: "MIT",
  type: "module",
  homepage: "https://github.com/fundroomhq/fundroom",
  repository: { type: "git", url: REPOSITORY_URL, directory: dir },
  publishConfig: { access: "public", provenance: true },
});
const tokensManifest = () => ({
  ...base("@fundroomhq/tokens", "packages/tokens"),
  sideEffects: ["*.css"],
  exports: { ...TOKENS_EXPORTS },
});
const CSS = ":root {\n  --sh-color-primary: #2563eb;\n}\n";
const uiManifest = () => ({
  ...base("@fundroomhq/ui", "packages/ui"),
  exports: {
    ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
    "./styles.css": "./dist/styles/index.css",
    "./tokens.css": "./dist/styles/tokens.css",
    "./package.json": "./package.json",
  },
  peerDependencies: { react: "^19.0.0", tailwindcss: "^4.0.0" },
  dependencies: { "@fundroomhq/tokens": "1.0.0-rc.1", clsx: "^2.1.1" },
});
const UI_FILES = [
  "package/package.json",
  "package/README.md",
  "package/LICENSE",
  "package/dist/index.js",
  "package/dist/index.d.ts",
  "package/dist/styles/index.css",
  "package/dist/styles/tokens.css",
];

test("finds workspace: and catalog: specifiers anywhere in a packed manifest", () => {
  assert.deepEqual(
    unresolvedProtocols({
      dependencies: { a: "workspace:*", b: "^1.0.0" },
      devDependencies: { c: "catalog:" },
      peerDependencies: { d: "workspace:^" },
    }),
    [
      "dependencies.a: workspace:*",
      "devDependencies.c: catalog:",
      "peerDependencies.d: workspace:^",
    ],
  );
  assert.deepEqual(unresolvedProtocols({ dependencies: { a: "1.0.0" } }), []);
});

test("a published manifest needs the provenance repository, public access and no protocols", () => {
  assert.deepEqual(checkManifest(tokensManifest(), "@fundroomhq/tokens", "packages/tokens"), []);
  const bad = {
    ...tokensManifest(),
    private: true,
    repository: { url: "https://github.com/FundroomHQ/fundroom", directory: "packages/tokens" },
    publishConfig: { access: "restricted" },
    dependencies: { x: "workspace:*" },
  };
  const problems = checkManifest(bad, "@fundroomhq/tokens", "packages/tokens");
  assert.ok(problems.some((p) => p.includes("private")));
  assert.ok(problems.some((p) => p.includes("repository.url")));
  assert.ok(problems.some((p) => p.includes("access")));
  assert.ok(problems.some((p) => p.includes("provenance")));
  assert.ok(problems.some((p) => p.includes("workspace:*")));
});

test("the tokens tarball is exactly the contract", () => {
  const ok = { files: TOKENS_FILES, manifest: tokensManifest(), tokensCss: CSS, sourceCss: CSS };
  assert.deepEqual(checkTokensTarball(ok), []);
  // Order does not matter, extra and missing files do.
  assert.deepEqual(checkTokensTarball({ ...ok, files: [...TOKENS_FILES].reverse() }), []);
  assert.match(
    checkTokensTarball({
      ...ok,
      files: [...TOKENS_FILES, "package/scripts/build-tokens.mjs"],
    }).join(),
    /files are/u,
  );
  assert.match(
    checkTokensTarball({
      ...ok,
      files: TOKENS_FILES.filter((f) => !f.endsWith("README.md")),
    }).join(),
    /files are/u,
  );
  assert.match(
    checkTokensTarball({ ...ok, sourceCss: `${CSS} ` }).join(),
    /differs from packages\/tokens\/tokens\.css/u,
  );
  const exports = { ...TOKENS_EXPORTS, "./tokens.json": "./tokens.json" };
  assert.match(
    checkTokensTarball({ ...ok, manifest: { ...tokensManifest(), exports } }).join(),
    /exports are/u,
  );
  assert.match(
    checkTokensTarball({ ...ok, manifest: { ...tokensManifest(), sideEffects: false } }).join(),
    /sideEffects/u,
  );
});

test("the ui tarball ships dist only, with every export target", () => {
  assert.deepEqual(checkUiTarball({ files: UI_FILES, manifest: uiManifest() }), []);
  const leaky = [
    ...UI_FILES,
    "package/src/components/button.tsx",
    "package/dist/components/button.test.js",
    "package/dist/components/button.test.d.ts",
    "package/dist/components/button.stories.js",
    "package/dist/.tsbuildinfo",
    "package/dist/index.js.map",
    "package/dist/test/a11y.js",
  ];
  const problems = checkUiTarball({ files: leaky, manifest: uiManifest() });
  for (const f of leaky.slice(UI_FILES.length))
    assert.ok(
      problems.some((p) => p.startsWith(f)),
      `${f} should be refused: ${problems.join("; ")}`,
    );
  assert.match(
    checkUiTarball({
      files: UI_FILES.filter((f) => f !== "package/dist/styles/tokens.css"),
      manifest: uiManifest(),
    }).join(),
    /export target \.\/dist\/styles\/tokens\.css/u,
  );
});

test("no published manifest may depend on @fundroom/* (not our npm scope) or a private @fundroomhq/*", () => {
  for (const [dep, re] of [
    ["@fundroom/tokens", /@fundroom on npm is not ours/u],
    ["@fundroom/contracts", /@fundroom on npm is not ours/u],
    ["@fundroomhq/contracts", /private workspace package/u],
  ]) {
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      const m = { ...tokensManifest(), [field]: { [dep]: "1.0.0-rc.1" } };
      assert.match(checkManifest(m, "@fundroomhq/tokens", "packages/tokens").join(), re);
    }
  }
  assert.deepEqual(checkManifest(uiManifest(), "@fundroomhq/ui", "packages/ui"), []);
});

test("ui: monorepo styles export, private deps and a missing Tailwind peer are refused", () => {
  const m = uiManifest();
  m.exports["./styles.css"] = "./src/styles/index.css";
  assert.match(
    checkUiTarball({ files: [...UI_FILES, "package/src/styles/index.css"], manifest: m }).join(),
    /publishConfig\.exports/u,
  );
  const priv = { ...uiManifest(), dependencies: { "@fundroom/contracts": "1.0.0-rc.1" } };
  assert.match(
    checkUiTarball({ files: UI_FILES, manifest: priv }).join(),
    /private workspace package/u,
  );
  const noPeer = { ...uiManifest(), peerDependencies: { react: "^19.0.0" } };
  assert.match(checkUiTarball({ files: UI_FILES, manifest: noPeer }).join(), /tailwindcss/u);
});

test("a published stylesheet may not reach outside the package", () => {
  const file = "package/dist/styles/index.css";
  assert.deepEqual(
    stylesheetEscapes(
      '@import "tailwindcss";\n@import "@fundroomhq/tokens/tokens.css";\n@source "../";\n@import "./tokens.css";\n',
      file,
    ),
    [],
  );
  assert.equal(stylesheetEscapes('@source "../../../packages/ui/src";\n', file).length, 1);
  assert.equal(stylesheetEscapes("@import '../../../tokens.css';\n", file).length, 1);
  assert.equal(stylesheetEscapes('@source "../../";\n', file).length, 0); // the package root
});

test("only the published packages may be public", () => {
  assert.deepEqual(
    publicStrays([
      { name: "@fundroomhq/ui", private: false },
      { name: "@fundroomhq/tokens" },
      { name: "@fundroom/server", private: true },
    ]),
    [],
  );
  assert.equal(publicStrays([{ name: "@fundroom/embed", private: false }]).length, 1);
  assert.equal(publicStrays([{ name: "@fundroom/web" }]).length, 1);
});

test("reads exact versions from pnpm-lock.yaml and the release-age floor", () => {
  const lock = [
    "lockfileVersion: '9.0'",
    "",
    "importers:",
    "",
    "  packages/other:",
    "    devDependencies:",
    "      react:",
    "        specifier: ^18.0.0",
    "        version: 18.0.0",
    "",
    "  packages/ui:",
    "    devDependencies:",
    "      '@tailwindcss/vite':",
    "        specifier: 'catalog:'",
    "        version: 4.3.3(vite@8.3.0(@types/node@24.13.4))",
    "      react:",
    "        specifier: 'catalog:'",
    "        version: 19.3.0",
    "",
    "packages:",
    "",
    "  vite@9.0.0:",
    "",
  ].join("\n");
  assert.deepEqual(lockedVersions(lock, "packages/ui", ["react", "@tailwindcss/vite"]), {
    react: "19.3.0",
    "@tailwindcss/vite": "4.3.3",
  });
  assert.throws(() => lockedVersions(lock, "packages/ui", ["vite"]), /no locked version of vite/u);
  assert.throws(() => lockedVersions(lock, "packages/nope", ["react"]), /no importer/u);
  assert.equal(minimumReleaseAge("packages:\n  - x\nminimumReleaseAge: 10080\n"), 10080);
  assert.throws(() => minimumReleaseAge("packages: []\n"), /no minimumReleaseAge/u);
});

test("the consumer build must carry the tokens and ui's scanned classes", () => {
  const css =
    ":root{--sh-color-primary:#2563eb}.bg-destructive{background-color:var(--sh-color-destructive)}.bg-primary{background-color:var(--sh-color-primary)}";
  const js = 'createElement("button",{"data-slot":"button"},"Pack check")';
  assert.deepEqual(checkConsumerOutput({ css, js }), []);
  assert.match(
    checkConsumerOutput({ css: css.replace(/\.bg-primary\{[^}]*\}/u, ""), js }).join(),
    /@source/u,
  );
  assert.match(
    checkConsumerOutput({ css: css.replace(/--sh-color-primary:#2563eb/u, ""), js }).join(),
    /tokens\.css/u,
  );
  assert.match(checkConsumerOutput({ css, js: "" }).join(), /Button/u);
});
