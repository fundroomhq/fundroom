import { Link } from "@tanstack/react-router";
import { useBootstrap } from "../../lib/queries.js";
import { m } from "../../paraglide/messages.js";
import type { ModulePageProps } from "../types.js";
import { ContactDetailScreen } from "./contact-detail.js";
import { ContactsScreen } from "./contacts.js";
import { OrganizationsScreen } from "./organizations.js";
import { PipelineScreen } from "./pipeline.js";
import { StagesScreen } from "./stages.js";

/*
 * CRM-lite, staff side (E2.5 §C). Four surfaces under one splat: the pipeline board, the
 * contact list (with a detail page carrying notes and tasks), the organisation list and the
 * stage editor.
 *
 * Two rules from the contract shape the whole module:
 *
 *  - **CRM never reads round's tables** (§D1). The board shows committed money by fetching
 *    `/round/rounds/{id}/allocation` beside its own data and joining on the commitment id in
 *    the browser. If the round module is off, every one of those lookups simply fails and the
 *    board keeps working without them.
 *  - **`pipeline_item.amount` is a forecast, never the committed figure** (§D2). The two are
 *    labelled differently everywhere they appear together, and the reconciliation panel exists
 *    to show the gap between them rather than to hide it.
 *
 * There is no drag-and-drop. A card moves stage through a `<select>` a keyboard reaches in one
 * tab stop, which is both the accessible control and the one jsdom can drive.
 */

type Section = "pipeline" | "contacts" | "organizations" | "stages";

const SECTIONS: readonly { readonly section: Section; readonly splat: string }[] = [
  { section: "pipeline", splat: "crm" },
  { section: "contacts", splat: "crm/contacts" },
  { section: "organizations", splat: "crm/organizations" },
  { section: "stages", splat: "crm/stages" },
];

function sectionLabel(section: Section): string {
  switch (section) {
    case "contacts":
      return m.crm_nav_contacts();
    case "organizations":
      return m.crm_nav_organizations();
    case "stages":
      return m.crm_nav_stages();
    default:
      return m.crm_nav_pipeline();
  }
}

function CrmSubNav({ current }: { current: Section }) {
  return (
    <nav aria-label={m.crm_nav_label()}>
      <ul className="flex flex-wrap gap-1 border-b pb-2">
        {SECTIONS.map(({ section, splat }) => (
          <li key={section}>
            <Link
              to="/admin/$"
              params={{ _splat: splat }}
              aria-current={section === current ? "page" : undefined}
              className="rounded-md px-3 py-1.5 text-sm hover:bg-muted aria-[current=page]:bg-muted aria-[current=page]:font-medium"
            >
              {sectionLabel(section)}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export default function CrmAdmin({ splat }: ModulePageProps) {
  const [head, id] = splat.split("/").filter(Boolean);
  const bootstrap = useBootstrap();
  const permissions = bootstrap.data?.permissions ?? [];
  const canManage = permissions.includes("crm.manage");

  const section: Section =
    head === "contacts"
      ? "contacts"
      : head === "organizations"
        ? "organizations"
        : head === "stages"
          ? "stages"
          : "pipeline";

  return (
    <div className="space-y-6">
      <CrmSubNav current={section} />
      {section === "contacts" ? (
        id === undefined ? (
          <ContactsScreen canManage={canManage} />
        ) : (
          <ContactDetailScreen id={id} canManage={canManage} />
        )
      ) : section === "organizations" ? (
        <OrganizationsScreen canManage={canManage} />
      ) : section === "stages" ? (
        <StagesScreen canManage={canManage} />
      ) : (
        <PipelineScreen canManage={canManage} />
      )}
    </div>
  );
}
