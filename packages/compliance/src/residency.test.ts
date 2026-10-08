import type { ModelProviderInfo, SubProcessorMeta } from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import {
  AI_WORKSPACE_PURPOSE,
  aiAssistFactsOf,
  aiComponentOf,
  aiSubProcessorOf,
  aiWorkspaceSubProcessorOf,
  collectDeploymentSubProcessors,
  fromAccreditationSubProcessor,
  fromBillingSubProcessor,
  fromESignSubProcessor,
  fromIntegrationSubProcessor,
  fromSanctionsSubProcessor,
  inDeclaredRegion,
  inferJurisdiction,
  normaliseSubProcessor,
  type ResidencyRegion,
  residencyComponents,
  standardTransferMechanism,
  subProcessorRowsOf,
  toResidencySubProcessor,
} from "./residency.js";
import { TEMPLATES } from "./templates/library.js";
import { renderDataLocation, renderTemplate } from "./templates/render.js";

const EU: ResidencyRegion = {
  code: "eu",
  label: "European Union (Frankfurt, Germany)",
  jurisdiction: "eu",
};
const US: ResidencyRegion = { code: "us", label: "", jurisdiction: "us" };
const NO_JURISDICTION: ResidencyRegion = { code: "eu", label: "Frankfurt", jurisdiction: null };

const POSTMARK: SubProcessorMeta = {
  name: "Postmark (ActiveCampaign, LLC)",
  purpose: "Email delivery",
  dataProcessed: "Recipient addresses",
  location: "United States",
  jurisdiction: "us",
};

describe("normalisers", () => {
  it("maps each historical adapter shape to SubProcessorMeta", () => {
    const esign = fromESignSubProcessor({
      name: "Dropbox, Inc. (Dropbox Sign)",
      purpose: "Electronic signature",
      region: "United States",
      dpaUrl: "https://example.test/dpa",
      certifications: ["SOC 2"],
    });
    expect(esign).toMatchObject({
      name: "Dropbox, Inc. (Dropbox Sign)",
      location: "United States",
      jurisdiction: "us",
      dpaUrl: "https://example.test/dpa",
      certifications: ["SOC 2"],
    });
    expect(esign.dataProcessed.length).toBeGreaterThan(0);

    const integration = fromIntegrationSubProcessor({
      name: "Xero Limited",
      purpose: "Metrics",
      region: "United States / Australia (Xero-hosted)",
      dpaUrl: "https://example.test/xero",
      jurisdiction: "varies",
    });
    expect(integration).toMatchObject({ location: "United States / Australia (Xero-hosted)" });
    expect(integration.jurisdiction).toBe("varies");

    expect(
      fromAccreditationSubProcessor({
        name: "VerifyInvestor.com, LLC",
        purpose: "Accreditation",
        location: "United States",
        url: "https://www.verifyinvestor.com",
      }),
    ).toMatchObject({ jurisdiction: "us", dpaUrl: "https://www.verifyinvestor.com" });

    expect(fromBillingSubProcessor(null)).toBeNull();
    expect(
      fromBillingSubProcessor({
        name: "Stripe, Inc.",
        purpose: "Billing",
        location: "United States",
        url: "https://stripe.com/legal/dpa",
      })?.jurisdiction,
    ).toBe("us");
    expect(fromSanctionsSubProcessor(null)).toBeNull();
    expect(
      fromSanctionsSubProcessor({
        name: "OpenSanctions",
        purpose: "Screening",
        location: "EU (Germany)",
        url: "https://www.opensanctions.org/",
      })?.jurisdiction,
    ).toBe("eu");
  });

  it("prefers an adapter's declared jurisdiction over the inferred one", () => {
    expect(
      fromESignSubProcessor({
        name: "X",
        purpose: "p",
        region: "United States",
        dpaUrl: "https://x",
        certifications: [],
        jurisdiction: "varies",
      }).jurisdiction,
    ).toBe("varies");
  });

  it("never guesses a jurisdiction from a location naming several places", () => {
    expect(inferJurisdiction("United States")).toBe("us");
    expect(inferJurisdiction("  united kingdom ")).toBe("uk");
    expect(inferJurisdiction("United States, EU, Canada or Australia")).toBe("varies");
    expect(inferJurisdiction("United States (EU instance available at cal.eu)")).toBe("varies");
    expect(inferJurisdiction("Documenso Cloud (vendor-operated)")).toBe("varies");
  });

  it("normaliseSubProcessor dispatches on the source kind", () => {
    expect(normaliseSubProcessor({ kind: "meta", value: POSTMARK })).toBe(POSTMARK);
    expect(normaliseSubProcessor({ kind: "meta", value: null })).toBeNull();
    expect(normaliseSubProcessor({ kind: "billing", value: null })).toBeNull();
    expect(
      normaliseSubProcessor({
        kind: "accreditation",
        value: { name: "P", purpose: "p", location: "United States", url: "https://p" },
      })?.jurisdiction,
    ).toBe("us");
  });
});

describe("out-of-region flags", () => {
  it("compares jurisdictions and is null whenever either side is unknown", () => {
    expect(inDeclaredRegion("us", EU)).toBe(false);
    expect(inDeclaredRegion("eu", EU)).toBe(true);
    expect(inDeclaredRegion("us", null)).toBeNull();
    expect(inDeclaredRegion("us", NO_JURISDICTION)).toBeNull();
    expect(inDeclaredRegion("varies", EU)).toBeNull();
    expect(inDeclaredRegion("other", { ...EU, jurisdiction: "other" })).toBeNull();
    expect(inDeclaredRegion(null, EU)).toBeNull();
  });

  it("names a mechanism only where it is standard, and never SCCs for an unnamed country", () => {
    expect(standardTransferMechanism("us", EU)).toBe(
      "EU SCCs (or the EU-US Data Privacy Framework — operator to confirm)",
    );
    expect(standardTransferMechanism("us", { ...EU, jurisdiction: "uk" })).toMatch(/UK Addendum/u);
    expect(standardTransferMechanism("us", { ...EU, jurisdiction: "ch" })).toMatch(/Swiss/u);
    // R3-9: `other` may be an adequate country — nothing is asserted for it.
    expect(standardTransferMechanism("other", EU)).toBeUndefined();
    expect(standardTransferMechanism("other", { ...EU, jurisdiction: "ch" })).toBeUndefined();
    // Adequacy the module is sure of (EU↔UK↔CH), and nothing it is not (Canada, Australia).
    expect(standardTransferMechanism("uk", EU)).toBe("Adequacy decision");
    expect(standardTransferMechanism("ch", EU)).toBe("Adequacy decision");
    expect(standardTransferMechanism("eu", { ...EU, jurisdiction: "uk" })).toBe(
      "Adequacy decision",
    );
    expect(standardTransferMechanism("ca", EU)).toBeUndefined();
    expect(standardTransferMechanism("au", EU)).toBeUndefined();
    expect(standardTransferMechanism("eu", EU)).toBeUndefined();
    expect(standardTransferMechanism("us", US)).toBeUndefined();
    expect(standardTransferMechanism("varies", EU)).toBeUndefined();
    expect(standardTransferMechanism("us", null)).toBeUndefined();
  });

  it("toResidencySubProcessor flags a US vendor outside an EU region", () => {
    const row = toResidencySubProcessor(POSTMARK, "deployment", EU);
    expect(row).toEqual({
      name: POSTMARK.name,
      purpose: POSTMARK.purpose,
      dataProcessed: POSTMARK.dataProcessed,
      location: "United States",
      jurisdiction: "us",
      transferMechanism: "EU SCCs (or the EU-US Data Privacy Framework — operator to confirm)",
      dpaUrl: null,
      certifications: [],
      scope: "deployment",
      outsideRegion: true,
    });
    expect(toResidencySubProcessor(POSTMARK, "workspace", US)).toMatchObject({
      outsideRegion: false,
      transferMechanism: null,
      scope: "workspace",
    });
    expect(toResidencySubProcessor(POSTMARK, "deployment", null).outsideRegion).toBeNull();
    // An adapter's own mechanism wins over the standard one.
    expect(
      toResidencySubProcessor({ ...POSTMARK, transferMechanism: "DPF + SCCs" }, "deployment", EU)
        .transferMechanism,
    ).toBe("DPF + SCCs");
  });
});

describe("collectDeploymentSubProcessors", () => {
  it("lists configured third parties in a stable order and drops the operator's own", () => {
    const storage: SubProcessorMeta = { ...POSTMARK, name: "AWS S3", purpose: "Object storage" };
    const list = collectDeploymentSubProcessors({
      email: POSTMARK,
      objectStorage: storage,
      customDomains: null,
      billing: { name: "Stripe, Inc.", purpose: "Billing", location: "United States", url: "u" },
      sanctions: null,
    });
    expect(list.map((s) => s.name)).toEqual([POSTMARK.name, "AWS S3", "Stripe, Inc."]);
    expect(collectDeploymentSubProcessors({ email: null, objectStorage: null })).toEqual([]);
    expect(collectDeploymentSubProcessors({})).toEqual([]);
  });

  it("dedupes a vendor listed twice for the same purpose", () => {
    expect(
      collectDeploymentSubProcessors({ email: POSTMARK, objectStorage: { ...POSTMARK } }),
    ).toHaveLength(1);
  });
});

describe("residencyComponents", () => {
  it("puts the cell's own components in the declared region", () => {
    const rows = residencyComponents({
      region: EU,
      objectStorage: { subProcessor: null },
      backupLocation: "Hetzner, Falkenstein",
      email: POSTMARK,
    });
    expect(rows.map((r) => r.component)).toEqual([
      "database",
      "jobs",
      "search",
      "analytics",
      "objectStorage",
      "backups",
      "email",
    ]);
    const by = Object.fromEntries(rows.map((r) => [r.component, r]));
    expect(by["database"]).toEqual({
      component: "database",
      location: EU.label,
      jurisdiction: "eu",
      inRegion: true,
    });
    expect(by["objectStorage"]?.inRegion).toBe(true);
    expect(by["backups"]).toEqual({
      component: "backups",
      location: "Hetzner, Falkenstein",
      jurisdiction: null,
      inRegion: null,
    });
    expect(by["email"]).toMatchObject({ location: "United States", inRegion: false });
  });

  it("is honest when nothing is declared", () => {
    const rows = residencyComponents({
      region: null,
      objectStorage: { subProcessor: null },
      backupLocation: null,
      email: null,
      telemetry: { location: null, jurisdiction: null },
    });
    for (const row of rows) {
      expect(row.location).toBeNull();
      expect(row.jurisdiction).toBeNull();
      expect(row.inRegion).toBeNull();
    }
    expect(rows.at(-1)?.component).toBe("telemetry");
  });

  it("uses the code when the region has no label, and a vendor's location for object storage", () => {
    const rows = residencyComponents({
      region: US,
      objectStorage: {
        subProcessor: { ...POSTMARK, location: "AWS eu-central-1", jurisdiction: "eu" },
      },
      backupLocation: null,
      email: undefined,
      errorReporting: { location: "Germany (Sentry)", jurisdiction: "eu" },
    });
    expect(rows[0]?.location).toBe("us");
    expect(rows.find((r) => r.component === "objectStorage")).toMatchObject({
      location: "AWS eu-central-1",
      inRegion: false,
    });
    expect(rows.find((r) => r.component === "errorReporting")?.inRegion).toBe(false);
    expect(rows.some((r) => r.component === "telemetry")).toBe(false);
  });
});

describe("renderDataLocation and the DPA", () => {
  const components = residencyComponents({
    region: EU,
    objectStorage: { subProcessor: null },
    backupLocation: null,
    email: POSTMARK,
  });

  it("states the declared region as the operator's declaration, with the component table", () => {
    const out = renderDataLocation({ region: EU, components });
    expect(out).toContain(
      "The operator declares that this workspace's data is hosted in **European Union (Frankfurt, Germany)** (region `eu`), jurisdiction: European Union / EEA.",
    );
    expect(out).toContain("cannot verify");
    expect(out).toContain("| Component | Location | Jurisdiction | In the declared region |");
    expect(out).toContain(
      "| Database (all records) | European Union (Frankfurt, Germany) | European Union / EEA | Yes |",
    );
    expect(out).toContain("| Email delivery | United States | United States | **No** |");
    expect(out).toContain("| Backups | Not declared | — | Unknown |");
  });

  it("says plainly that no region is declared rather than rendering an empty sentence", () => {
    for (const out of [
      renderDataLocation(),
      renderDataLocation({ region: null, components: [] }),
    ]) {
      expect(out).toContain("The operator has not declared a data region for this deployment.");
      expect(out).not.toMatch(/hosted in \*\*\s*\*\*/u);
      expect(out).toContain("_None configured._");
    }
  });

  it("renders into the DPA's annex and the sub-processor table, with no empty hosting sentence", () => {
    const dpa = TEMPLATES.dpa;
    expect(dpa.mergeFields).toContain("dataLocation");
    const declared = renderTemplate(dpa, {
      dataLocation: { region: EU, components },
      subProcessors: subProcessorRowsOf([toResidencySubProcessor(POSTMARK, "deployment", EU)]),
    });
    expect(declared).toContain("## Annex: Data location");
    expect(declared).toContain("**European Union (Frankfurt, Germany)**");
    expect(declared).toContain(
      "| Postmark (ActiveCampaign, LLC) | Email delivery | Recipient addresses | United States (outside the declared region) | EU SCCs (or the EU-US Data Privacy Framework — operator to confirm) |",
    );
    const undeclared = renderTemplate(dpa, {});
    expect(undeclared).toContain("The operator has not declared a data region");
    expect(undeclared).not.toMatch(/hosted in\s*\./u);
    expect(undeclared).not.toContain("{{");
  });

  it("puts the data location on the public sub-processor list too", () => {
    const out = renderTemplate(TEMPLATES["sub-processors"], {
      dataLocation: { region: US, components: [] },
    });
    expect(out).toContain("## Where data is stored");
    expect(out).toContain("hosted in **us**");
  });

  it("escapes a pipe in an operator-supplied label", () => {
    const out = renderDataLocation({ region: { ...EU, label: "EU | Frankfurt" }, components: [] });
    expect(out).toContain("EU \\| Frankfurt");
  });
});

describe("fix round 1 (R3-3/R3-8/R3-9)", () => {
  it("says 'Not stated' for a missing mechanism and 'Not applicable' inside the jurisdiction", () => {
    const varies = toResidencySubProcessor(
      { ...POSTMARK, jurisdiction: "varies" },
      "workspace",
      EU,
    );
    const inside = toResidencySubProcessor({ ...POSTMARK, jurisdiction: "eu" }, "workspace", EU);
    const rows = subProcessorRowsOf([varies, inside]);
    expect(rows[0]?.transferMechanism).toBeUndefined();
    expect(rows[1]?.transferMechanism).toBe("Not applicable (same jurisdiction)");
    const table = renderTemplate(
      { body: "{{workspaceSubProcessors}}", version: 1 },
      {
        workspaceSubProcessors: rows,
      },
    );
    expect(table).toContain("| Not stated |");
    expect(table).toContain("| Not applicable (same jurisdiction) |");
  });

  it("lists the workspace's own vendors in the privacy notice but not in the DPA", () => {
    const own = subProcessorRowsOf([
      toResidencySubProcessor({ ...POSTMARK, name: "DocuSeal LLC" }, "workspace", EU),
    ]);
    expect(TEMPLATES["privacy-notice"].mergeFields).toContain("workspaceSubProcessors");
    expect(TEMPLATES.dpa.mergeFields).not.toContain("workspaceSubProcessors");
    expect(renderTemplate(TEMPLATES["privacy-notice"], { workspaceSubProcessors: own })).toContain(
      "| DocuSeal LLC |",
    );
    expect(renderTemplate(TEMPLATES.dpa, { workspaceSubProcessors: own })).not.toContain(
      "DocuSeal",
    );
  });

  it("adds a virus-scanning component: in the region when operator-run, unknown when not", () => {
    const base = {
      region: EU,
      objectStorage: { subProcessor: null },
      backupLocation: null,
      email: null,
    } as const;
    expect(residencyComponents({ ...base, virusScan: { cell: true } }).at(-1)).toEqual({
      component: "virusScan",
      location: EU.label,
      jurisdiction: "eu",
      inRegion: true,
    });
    expect(
      residencyComponents({
        ...base,
        virusScan: { location: "Not identified by the software", jurisdiction: "varies" },
      }).at(-1),
    ).toMatchObject({ component: "virusScan", inRegion: null });
    expect(residencyComponents(base).some((c) => c.component === "virusScan")).toBe(false);
  });

  it("labels varies as 'not identified', never as a global network", () => {
    const out = renderDataLocation({
      region: EU,
      components: [{ component: "email", location: "x", jurisdiction: "varies", inRegion: null }],
    });
    expect(out).toContain("Varies / not identified");
    expect(out).not.toContain("global network");
  });
});

describe("the AI model provider (E3.12)", () => {
  const SELF: ModelProviderInfo = {
    id: "openai-compatible",
    label: "Ollama at ollama:11434",
    model: "qwen3.5:9b",
    hosting: "self_hosted",
    location: null,
    jurisdiction: null,
    trainsOnInputs: false,
    retention: "Prompts stay on the operator's infrastructure.",
    subProcessor: null,
  };
  const SUB: SubProcessorMeta = {
    name: "Example AI Inc.",
    purpose: "AI assist (workspaces that turn it on)",
    dataProcessed: "Prompts",
    location: "Canada",
    jurisdiction: "ca",
  };
  const HOSTED: ModelProviderInfo = {
    id: "openai-compatible",
    label: "Example AI",
    model: "m",
    hosting: "third_party",
    location: "Canada",
    jurisdiction: "ca",
    trainsOnInputs: false,
    retention: "Inputs are kept for 30 days for abuse monitoring.",
    subProcessor: SUB,
  };

  it("is a sub-processor only when a third party hosts it", () => {
    expect(aiSubProcessorOf(null)).toBeNull();
    expect(aiSubProcessorOf(SELF)).toBeNull();
    // A self-hosted info that (wrongly) carries metadata is still operator-run.
    expect(aiSubProcessorOf({ ...SELF, subProcessor: SUB })).toBeNull();
    expect(aiSubProcessorOf(HOSTED)).toBe(HOSTED.subProcessor);
    expect(
      collectDeploymentSubProcessors({ email: POSTMARK, ai: aiSubProcessorOf(HOSTED) }).map(
        (s) => s.name,
      ),
    ).toEqual([POSTMARK.name, "Example AI Inc."]);
  });

  it("synthesises a row for a third party without adapter metadata, never guessing a place", () => {
    const { subProcessor: _absent, ...bare } = HOSTED;
    expect(aiSubProcessorOf(bare)).toMatchObject({
      name: "Example AI",
      location: "Canada",
      jurisdiction: "ca",
    });
    expect(
      aiSubProcessorOf({ ...HOSTED, subProcessor: null, location: null, jurisdiction: null }),
    ).toMatchObject({ location: "Not identified by the software", jurisdiction: "varies" });
  });

  it("the workspace row differs from the deployment row by purpose only", () => {
    const row = aiWorkspaceSubProcessorOf(HOSTED);
    expect(row).toEqual({ ...SUB, purpose: AI_WORKSPACE_PURPOSE });
    expect(aiWorkspaceSubProcessorOf(SELF)).toBeNull();
  });

  it("is a component only when configured: the cell when self-hosted, else by jurisdiction", () => {
    const base = { region: EU, objectStorage: { subProcessor: null }, backupLocation: null };
    const names = (ai: ModelProviderInfo | null) =>
      residencyComponents({ ...base, email: null, ai: aiComponentOf(ai) });
    expect(names(null).map((c) => c.component)).not.toContain("ai");
    expect(names(SELF).at(-1)).toEqual({
      component: "ai",
      location: EU.label,
      jurisdiction: "eu",
      inRegion: true,
    });
    expect(names(HOSTED).at(-1)).toEqual({
      component: "ai",
      location: "Canada",
      jurisdiction: "ca",
      inRegion: false,
    });
    expect(names({ ...HOSTED, jurisdiction: "varies" }).at(-1)?.inRegion).toBeNull();
  });

  it("the DPA makes no unconditional claim about a provider's training (RR2-L6)", () => {
    const dpa = renderTemplate(TEMPLATES.dpa, {}).replace(/\s+/gu, " ");
    expect(dpa).not.toContain("No model is trained");
    expect(dpa).toContain(
      "The operator never uses the customer's data to train a model, and the software sends no training opt-in to the AI model's provider; where that provider is a third party, its own terms govern its use",
    );
  });

  it("renders the {{aiAssist}} paragraph for off, self-hosted and third party", () => {
    const notice = TEMPLATES["privacy-notice"];
    expect(notice.mergeFields).toContain("aiAssist");
    const BOTH = { updateDraft: true, qaAnswer: true };
    const off = renderTemplate(notice, {});
    // R3-H1: a published snapshot must stay true if AI assist is turned on later.
    expect(off).toContain(
      "We do not use AI assist at present. If we turn it on, we will update this notice before any of your data is sent to an AI model.",
    );
    expect(off).not.toContain("none of your data is sent");
    expect(renderTemplate(notice, { aiAssist: null })).toBe(off);
    // No feature on is "off", whatever the provider.
    expect(aiAssistFactsOf(HOSTED, { updateDraft: false, qaAnswer: false }, 168)).toBeNull();
    // The automated-decisions section stays, and says AI assist only drafts.
    expect(off).toContain("## Automated decisions");
    expect(off).toContain("it only drafts text for our staff to review");

    // R3-M3: the operator's statement, not the software's claim.
    const self = renderTemplate(notice, { aiAssist: aiAssistFactsOf(SELF, BOTH, 168) });
    expect(self).toContain(
      "runs on infrastructure that the portal's operator states it runs itself",
    );
    expect(self).toContain("The portal never uses your data to train a model.");
    expect(self).not.toContain("third party listed");

    const hosted = renderTemplate(notice, { aiAssist: aiAssistFactsOf(HOSTED, BOTH, 168) });
    // R3-L4: the host's list comes after this section.
    expect(hosted).toContain(
      "provided by **Example AI Inc.** (Canada), a third party listed below among the host's sub-processors",
    );
    expect(hosted.indexOf("## AI assist")).toBeLessThan(hosted.indexOf("## Who sees your data"));
    expect(hosted).toContain("The provider does not use it to train models.");
    expect(hosted).toContain(HOSTED.retention);
    // RR2-L13: the portal's own retention of drafts, from AI_RESULT_RETENTION_HOURS.
    expect(hosted).toContain(
      "Drafts and suggestions are kept in the portal for about 7 days (up to an hour longer) and then deleted; if that period is shortened, the shorter period applies to new suggestions.",
    );
    expect(renderTemplate(notice, { aiAssist: aiAssistFactsOf(SELF, BOTH, 36) })).toContain(
      "kept in the portal for about 36 hours (up to an hour longer)",
    );
    expect(renderTemplate(TEMPLATES.dpa, {})).not.toContain("never opts in");
    // RR2-L13: no stated location is said in words, never an adapter placeholder in brackets.
    const nowhere = renderTemplate(notice, {
      aiAssist: aiAssistFactsOf(
        { ...HOSTED, location: null, subProcessor: { ...SUB, location: "Not stated by the host" } },
        BOTH,
        168,
      ),
    });
    expect(nowhere).toContain(
      "provided by **Example AI Inc.**, whose processing location the host has not stated, a third party listed below",
    );
    expect(nowhere).not.toContain("(Not stated by the host)");
    expect(hosted).not.toContain("{{");

    // R3-M1: training is claimed only where the adapter knows it.
    const unknown = renderTemplate(notice, {
      aiAssist: aiAssistFactsOf({ ...HOSTED, trainsOnInputs: null }, BOTH, 168),
    });
    expect(unknown).toContain(
      "The host has not stated whether the provider uses this data to train models.",
    );
    expect(unknown).not.toContain("does not use it to train");

    // R3-L4: only the features in use are named.
    const draftsOnly = renderTemplate(notice, {
      aiAssist: aiAssistFactsOf(SELF, { updateDraft: true, qaAnswer: false }, 168),
    });
    expect(draftsOnly).toContain("Our staff can use AI assist to draft investor updates.");
    expect(draftsOnly).not.toContain("suggest answers");
    expect(draftsOnly).not.toContain("investor questions");
    const qaOnly = renderTemplate(notice, {
      aiAssist: aiAssistFactsOf(SELF, { updateDraft: false, qaAnswer: true }, 168),
    });
    expect(qaOnly).toContain("to suggest answers to questions asked in the portal.");
    expect(qaOnly).not.toContain("draft investor updates");
  });
});
