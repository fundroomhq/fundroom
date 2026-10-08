import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { audienceToLegal, kindForTemplate, TEMPLATE_IDS, TEMPLATES } from "./library.js";
import { renderRetention, renderSubProcessors, renderTemplate } from "./render.js";

/*
 * The generator is a `.mjs` script so it can run before anything is compiled, which means the
 * tests reach it through a dynamic import rather than a static one. That is deliberate: the
 * validation rules have exactly one implementation, in the script, and these tests exercise it
 * rather than a second copy that could agree with the generated file while both are wrong.
 */
const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = pathToFileURL(join(PACKAGE_DIR, "scripts", "build-templates.mjs")).href;
const TEMPLATE_DIR = join(PACKAGE_DIR, "templates");
const GENERATED = join(PACKAGE_DIR, "src", "generated", "templates.ts");

interface Generator {
  readonly COUNSEL_BANNER: string;
  readonly MERGE_FIELDS: readonly string[];
  parseTemplate(file: string, source: string): { readonly id: string; readonly body: string };
  buildTemplatesModule(dir?: string): string;
}

// A non-literal specifier keeps TypeScript from trying to resolve types for the `.mjs` file.
const specifier: string = SCRIPT;
const generator = (await import(specifier)) as Generator;

/** A minimal template that satisfies the contract, for the failure cases to break one rule at a time. */
function fixture(frontmatter: string, body: string): string {
  return `---\n${frontmatter}\n---\n\n${generator.COUNSEL_BANNER}\n\n${body}\n`;
}

const VALID_FRONTMATTER = [
  "id: sample",
  "version: 1",
  "title: Sample",
  "audience: investor",
  "jurisdiction: [global]",
  "requiresAcceptance: false",
  "mergeFields: [company.name]",
].join("\n");

describe("the generated template module", () => {
  it("matches what the generator produces from templates/*.md right now", () => {
    // The drift check. Editing a template without running `pnpm --filter @fundroom/compliance
    // codegen` fails here rather than shipping a document nobody can see in a diff.
    expect(generator.buildTemplatesModule(TEMPLATE_DIR)).toBe(readFileSync(GENERATED, "utf8"));
  });

  it("ships every template the README lists", () => {
    expect(TEMPLATE_IDS).toHaveLength(12);
    expect(TEMPLATE_IDS).toContain("privacy-notice");
    expect(TEMPLATE_IDS).toContain("nda-clickwrap");
  });

  it("carries the counsel-review banner verbatim on every template", () => {
    for (const id of TEMPLATE_IDS) {
      expect(TEMPLATES[id].body.startsWith(generator.COUNSEL_BANNER)).toBe(true);
    }
  });

  it("declares only merge fields the contract knows about", () => {
    for (const id of TEMPLATE_IDS) {
      for (const field of TEMPLATES[id].mergeFields) {
        expect(generator.MERGE_FIELDS).toContain(field);
      }
    }
  });

  it("is frozen, so a caller cannot edit the shipped library at runtime", () => {
    expect(Object.isFrozen(TEMPLATES)).toBe(true);
  });
});

describe("template validation", () => {
  it("accepts a template that satisfies the contract", () => {
    expect(
      generator.parseTemplate("sample.md", fixture(VALID_FRONTMATTER, "Hi {{company.name}}.")).id,
    ).toBe("sample");
  });

  it("rejects a file with no frontmatter", () => {
    expect(() => generator.parseTemplate("sample.md", "# Just a heading\n")).toThrow(
      /missing YAML frontmatter/u,
    );
  });

  it("rejects a missing required key", () => {
    const frontmatter = VALID_FRONTMATTER.split("\n")
      .filter((l) => !l.startsWith("audience:"))
      .join("\n");
    expect(() =>
      generator.parseTemplate("sample.md", fixture(frontmatter, "{{company.name}}")),
    ).toThrow(/missing `audience`/u);
  });

  it("rejects an unknown audience", () => {
    const frontmatter = VALID_FRONTMATTER.replace("audience: investor", "audience: martians");
    expect(() =>
      generator.parseTemplate("sample.md", fixture(frontmatter, "{{company.name}}")),
    ).toThrow(/`audience` must be one of/u);
  });

  it("rejects a body that has lost the counsel-review banner", () => {
    const source = `---\n${VALID_FRONTMATTER}\n---\n\nHi {{company.name}}.\n`;
    expect(() => generator.parseTemplate("sample.md", source)).toThrow(/counsel-review banner/u);
  });

  it("rejects a merge field outside the contract", () => {
    const frontmatter = VALID_FRONTMATTER.replace(
      "mergeFields: [company.name]",
      "mergeFields: [company.name, company.ceoMood]",
    );
    expect(() =>
      generator.parseTemplate(
        "sample.md",
        fixture(frontmatter, "{{company.name}} {{company.ceoMood}}"),
      ),
    ).toThrow(/outside the contract/u);
  });

  it("rejects a field used in the body but not declared", () => {
    expect(() =>
      generator.parseTemplate(
        "sample.md",
        fixture(VALID_FRONTMATTER, "{{company.name}} {{portal.url}}"),
      ),
    ).toThrow(/used but not declared/u);
  });

  it("rejects a declared field the body never uses", () => {
    const frontmatter = VALID_FRONTMATTER.replace(
      "mergeFields: [company.name]",
      "mergeFields: [company.name, portal.url]",
    );
    expect(() =>
      generator.parseTemplate("sample.md", fixture(frontmatter, "{{company.name}}")),
    ).toThrow(/never used/u);
  });
});

describe("renderTemplate", () => {
  const template = { body: "Hello {{company.name}} at {{portal.url}}, v{{version}}.", version: 3 };

  it("substitutes every declared field", () => {
    expect(
      renderTemplate(template, { company: { name: "Acme" }, portal: { url: "https://p" } }),
    ).toBe("Hello Acme at https://p, v3.");
  });

  it("defaults `version` to the template's own version", () => {
    expect(renderTemplate({ body: "v{{version}}", version: 7 })).toBe("v7");
  });

  it("lets the context override the version (a tenant's own numbering)", () => {
    expect(renderTemplate({ body: "v{{version}}", version: 7 }, { version: 2 })).toBe("v2");
  });

  it("renders an unset optional scalar as nothing, never as `undefined`", () => {
    const out = renderTemplate({ body: "Privacy: {{company.dpoEmail}}.", version: 1 });
    expect(out).toBe("Privacy: .");
    expect(out).not.toContain("undefined");
    expect(out).not.toContain("{{");
  });

  it("leaves no `{{…}}` behind for any shipped template rendered against an empty context", () => {
    for (const id of TEMPLATE_IDS) {
      const out = renderTemplate(TEMPLATES[id], {});
      expect(out, id).not.toMatch(/\{\{/u);
      expect(out, id).not.toContain("undefined");
    }
  });

  it("degrades an unknown placeholder rather than throwing", () => {
    expect(renderTemplate({ body: "x{{nope}}y", version: 1 })).toBe("xy");
  });

  it("honours an explicit placeholder for a gap a reviewer should notice", () => {
    expect(
      renderTemplate(
        { body: "DPO: {{company.dpoEmail}}", version: 1 },
        {},
        { placeholder: "[TBC]" },
      ),
    ).toBe("DPO: [TBC]");
  });

  it("renders a Date effective date as a UTC calendar day", () => {
    expect(
      renderTemplate(
        { body: "{{effectiveDate}}", version: 1 },
        {
          effectiveDate: new Date("2026-09-12T23:30:00Z"),
        },
      ),
    ).toBe("2026-09-12");
  });

  it("renders subProcessors as a Markdown table", () => {
    const out = renderTemplate(
      { body: "{{subProcessors}}", version: 1 },
      {
        subProcessors: [
          {
            provider: "Acme Mail",
            purpose: "Sends update emails",
            dataProcessed: "Name, email",
            location: "EU",
            transferMechanism: "Adequacy",
          },
        ],
      },
    );
    expect(out).toContain(
      "| Provider | Purpose | Data processed | Location | Transfer mechanism |",
    );
    expect(out).toContain("| Acme Mail | Sends update emails | Name, email | EU | Adequacy |");
  });

  it("says 'Not stated' for an omitted transfer mechanism rather than implying none (E3.11)", () => {
    expect(
      renderSubProcessors([{ provider: "P", purpose: "Q", dataProcessed: "", location: "S" }]),
    ).toContain("| P | Q | — | S | Not stated |");
  });

  it("escapes a pipe so a provider name cannot break out of its cell", () => {
    expect(
      renderSubProcessors([{ provider: "A | B", purpose: "p", dataProcessed: "d", location: "l" }]),
    ).toContain("A \\| B");
  });

  it("renders an empty table as a table that says it is empty", () => {
    const out = renderSubProcessors([]);
    expect(out).toContain("| Provider |");
    expect(out).toContain("_None configured._");
  });

  it("renders retention rows with the columns the templates describe", () => {
    const out = renderRetention([
      { recordClass: "Audit", covers: "Sign-ins", retention: "6 years", basis: "Evidence" },
    ]);
    expect(out).toContain("| Record class | What it covers | Retention | Why |");
    expect(out).toContain("| Audit | Sign-ins | 6 years | Evidence |");
  });
});

describe("library metadata", () => {
  it("maps the library's audiences onto the database's", () => {
    expect(audienceToLegal("investor")).toBe("external");
    expect(audienceToLegal("public")).toBe("all");
    expect(audienceToLegal("tenant-admin")).toBe("staff");
    expect(audienceToLegal("host")).toBe("staff");
    expect(audienceToLegal("repo")).toBe("staff");
  });

  it("maps each shipped template onto exactly one document kind", () => {
    expect(kindForTemplate("privacy-notice")).toBe("privacy_notice");
    expect(kindForTemplate("nda-clickwrap")).toBe("nda");
    expect(kindForTemplate("cookie-notice")).toBe("cookie_notice");
    expect(kindForTemplate("accreditation-self-certification")).toBe("accreditation");
    expect(kindForTemplate("tos")).toBe("terms");
    expect(kindForTemplate("dpa")).toBe("terms");
    expect(kindForTemplate("legends")).toBe("disclaimer");
    expect(kindForTemplate("accessibility-statement")).toBe("accessibility_statement");
  });
});

describe("privacy notice wording (E-UP-4)", () => {
  it("sends a data-subject request to the contact email, not to portal controls that do not exist", () => {
    const notice = TEMPLATES["privacy-notice"];
    // Substantive (how a right is exercised), so the version moved: v3 promised the controls.
    expect(notice.version).toBe(4);
    expect(notice.body).not.toMatch(/privacy controls in your portal account/u);
    expect(notice.body).toContain("To exercise a right, email {{company.contactEmail}}.");
  });
});

describe("e-sign NDA rendering (E3.5 fix A15)", () => {
  it("every shipped nda template can be signed electronically as written (WinAnsi only)", async () => {
    const { ndaTextProblem } = await import("@fundroom/esign");
    for (const id of TEMPLATE_IDS) {
      const t = TEMPLATES[id];
      if (kindForTemplate(id) !== "nda") continue;
      expect(ndaTextProblem({ title: t.title, body: t.body }), id).toBeUndefined();
    }
  });
});
