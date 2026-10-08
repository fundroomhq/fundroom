import assert from "node:assert/strict";
import { test } from "node:test";
// biome-ignore lint/correctness/useImportExtensions: the module is .mjs; the rule's ".js" fix does not resolve under node --test (CI runs this file directly).
import * as check from "./check-i18n.mjs";
// biome-ignore lint/correctness/useImportExtensions: the module is .mjs; the rule's ".js" fix does not resolve under node --test (CI runs this file directly).
import { pseudoCatalogue } from "./i18n-pseudo.mjs";

const { fakePlurals, jsxLiterals, parityProblems, referencedKeys, unusedKeys } = check;

const texts = (src) => jsxLiterals("x.tsx", src).map((h) => `${h.kind}:${h.text}`);

test("flags JSX text with letters, not whitespace, punctuation or expressions", () => {
  assert.deepEqual(texts("const a = <p>Save changes</p>;"), ["text:Save changes"]);
  assert.deepEqual(texts("const a = <p>{m.save()}</p>;"), []);
  assert.deepEqual(texts("const a = <p> · — / {x} </p>;"), []);
  assert.deepEqual(texts('const a = <p>{"Hello"}</p>;'), ["text:Hello"]);
  assert.deepEqual(texts("const a = <p>{`Hello`}</p>;"), ["text:Hello"]);
  assert.deepEqual(texts("const a = <>Élan</>;"), ["text:Élan"]);
});

test("flags string literals in user-visible attributes only", () => {
  assert.deepEqual(texts('const a = <input placeholder="Search" />;'), ["placeholder:Search"]);
  assert.deepEqual(texts('const a = <button aria-label="Close" />;'), ["aria-label:Close"]);
  assert.deepEqual(texts('const a = <img alt={"Logo"} />;'), ["alt:Logo"]);
  assert.deepEqual(texts('const a = <X title="Hi" label="Name" />;'), ["title:Hi", "label:Name"]);
  // Code, not copy: class names, ids, types, test ids, expressions.
  assert.deepEqual(
    texts(
      'const a = <input className="flex gap-2" id="email" type="email" data-testid="x" aria-label={m.x()} alt="" />;',
    ),
    [],
  );
});

test("flags literals a child expression renders: conditionals, &&, fallbacks, templates", () => {
  assert.deepEqual(texts('const a = <p>{ok ? "Yes" : "No"}</p>;'), ["text:Yes", "text:No"]);
  assert.deepEqual(texts('const a = <p>{ok ? m.yes() : "No"}</p>;'), ["text:No"]);
  assert.deepEqual(texts('const a = <p>{a ? "One" : b ? "Two" : m.x()}</p>;'), [
    "text:One",
    "text:Two",
  ]);
  assert.deepEqual(texts('const a = <p>{saved && "Saved"}</p>;'), ["text:Saved"]);
  // The condition of `&&` / `?:` is not rendered.
  assert.deepEqual(texts('const a = <p>{kind === "draft" && m.draft()}</p>;'), []);
  assert.deepEqual(texts('const a = <p>{kind === "draft" ? m.a() : m.b()}</p>;'), []);
  assert.deepEqual(texts('const a = <p>{name ?? "Anonymous"}</p>;'), ["text:Anonymous"]);
  assert.deepEqual(texts('const a = <p>{name || ("Anonymous")}</p>;'), ["text:Anonymous"]);
  assert.deepEqual(texts('const a = <p>{"Hello " + name}</p>;'), ["text:Hello "]);
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the TSX under test contains a template literal.
  assert.deepEqual(texts("const a = <p>{`Hello ${x}`}</p>;"), ["text:Hello ${…}"]);
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the TSX under test contains a template literal.
  assert.deepEqual(texts("const a = <p>{`${a} · ${b}`}</p>;"), []);
  assert.deepEqual(texts('const a = <p>{ok ? "—" : " · "}</p>;'), []);
  // Call arguments are code, not copy.
  assert.deepEqual(texts('const a = <p>{fmt(x, "long")}</p>;'), []);
});

test("flags conditional, template and fallback literals in user-visible attributes", () => {
  assert.deepEqual(texts('const a = <input placeholder={ok ? "Search" : m.x()} />;'), [
    "placeholder:Search",
  ]);
  assert.deepEqual(
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the TSX under test contains a template literal.
    texts("const a = <button aria-label={`Close ${name}`} />;"),
    // biome-ignore lint/suspicious/noTemplateCurlyInString: how the checker prints a substitution.
    ["aria-label:Close ${…}"],
  );
  assert.deepEqual(texts('const a = <X title={t ?? "Untitled"} alt={ok && "Logo"} />;'), [
    "title:Untitled",
    "alt:Logo",
  ]);
  assert.deepEqual(texts('const a = <X label={open ? "Hide" : "Show"} />;'), [
    "label:Hide",
    "label:Show",
  ]);
  // Not user-visible: className / key / data-* / id, however the value is built.
  assert.deepEqual(
    texts(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the TSX under test contains a template literal.
      'const a = <p className={ok ? "flex gap-2" : `grid ${c}`} key={`row-${i}`} data-state={open ? "open" : "closed"} id={ok && "main"} />;',
    ),
    [],
  );
});

test("ignores comments and string literals outside JSX", () => {
  assert.deepEqual(
    texts('// Save changes\nconst s = "Save changes"; const a = <p>{/* x */}</p>;'),
    [],
  );
});

test("reports the line of each hit", () => {
  const hits = jsxLiterals("x.tsx", "const a = (\n  <div>\n    Hello\n  </div>\n);");
  assert.equal(hits[0]?.line, 3);
});

test("finds referenced keys and the unused ones", () => {
  const refs = referencedKeys('m.a_b(); m.c({ x: 1 }); m["d"](); const x = mm.e();');
  assert.deepEqual([...refs].sort(), ["a_b", "c", "d"]);
  assert.deepEqual(
    unusedKeys({ $schema: "s", a_b: "", c: "", d: "", e: "", f: "" }, refs, { f: "dynamic" }),
    ["e"],
  );
});

test("checks parity and drift of a pseudo-locale catalogue", () => {
  const en = { a: "Hi {name}", b: "Bye" };
  const good = pseudoCatalogue(en);
  assert.deepEqual(parityProblems("x", en, JSON.parse(good), good), []);
  const missing = JSON.stringify({ a: "x" });
  assert.equal(parityProblems("x", en, JSON.parse(missing), missing).length, 1);
  const extra = { ...JSON.parse(good), c: "x" };
  assert.equal(parityProblems("x", en, extra, JSON.stringify(extra)).length, 1);
  // Same keys, hand-edited value: drift.
  const edited = JSON.stringify({ ...JSON.parse(good), b: "edited" }, null, 2);
  assert.match(parityProblems("x", en, JSON.parse(edited), edited)[0] ?? "", /stale/u);
});

test("pseudo-localises every shape and leaves $schema alone", () => {
  const out = JSON.parse(
    pseudoCatalogue({
      $schema: "https://inlang.com/schema/inlang-message-format",
      a: "Save {n}",
      p: [
        {
          declarations: ["input n"],
          selectors: ["nP"],
          match: { "nP=one": "1 day", "nP=*": "{n} days" },
        },
      ],
    }),
  );
  assert.equal(out.$schema, "https://inlang.com/schema/inlang-message-format");
  assert.match(out.a, /^⟦Šáṽé \{n\}/u);
  assert.deepEqual(out.p[0].selectors, ["nP"]);
  assert.match(out.p[0].match["nP=*"], /\{n\} ðáýš/u);
});

test("flags fake plurals in strings, variants and plural objects", () => {
  assert.deepEqual(
    fakePlurals({
      $schema: "x",
      a: "{count} file(s)",
      b: "{count} address(es)",
      c: "Choose (optional)",
      d: [{ match: { "n=one": "{n} file", "n=*": "{n} file(s)" } }],
      e: { one: "1 file", other: "{count} files" },
    }),
    ["a", "b", "d"],
  );
});
