import type { PageDoc } from "./blocks.js";
import type { VisibilityMap } from "./visibility.js";

/*
 * The home-page template every workspace starts from (§12 "Overview page: Must (template)").
 * Seeded on first access, not by a migration (design/06 §9 "seed data"), and published at
 * once so investors see a page rather than an empty shell. Copy is plain and generic: the
 * founder edits it in /admin/content.
 */
export function homeTemplate(workspaceName: string): { doc: PageDoc; visibility: VisibilityMap } {
  const doc: PageDoc = {
    sections: [
      {
        key: "welcome",
        title: null,
        blocks: [
          {
            id: "hero",
            type: "hero",
            schemaVersion: 1,
            data: {
              heading: `${workspaceName} investor portal`,
              subheading:
                "Updates, documents and metrics for our investors, in one place. Everything here is confidential.",
              imageUrl: null,
              cta: null,
            },
          },
        ],
      },
      {
        key: "about",
        title: "About the company",
        blocks: [
          {
            id: "about-text",
            type: "rich_text",
            schemaVersion: 1,
            data: {
              format: "markdown",
              text: [
                "## What we do",
                "",
                "Replace this paragraph with a short description of the company: the problem, the product and the traction so far.",
                "",
                "## What you will find here",
                "",
                "- **Updates**: our regular investor letters, archived here.",
                "- **Documents**: the data room with the deck, financials and legal documents.",
                "- **Metrics**: the numbers we track, updated every period.",
              ].join("\n"),
            },
          },
        ],
      },
      {
        key: "team",
        title: "Team",
        blocks: [{ id: "team-list", type: "team", schemaVersion: 1, data: { members: [] } }],
      },
      {
        key: "faq",
        title: "Frequently asked questions",
        blocks: [
          {
            id: "faq-list",
            type: "faq",
            schemaVersion: 1,
            data: {
              items: [
                {
                  question: "How often do you send updates?",
                  answer:
                    "Monthly, with a longer quarterly letter. Every update is archived on this portal.",
                },
              ],
            },
          },
        ],
      },
    ],
  };
  return {
    doc,
    visibility: {
      welcome: { mode: "authenticated" },
      about: { mode: "authenticated" },
      team: { mode: "authenticated" },
      faq: { mode: "authenticated" },
    },
  };
}
