import type { FundRoomSchemas } from "@fundroom/sdk";
import { Card, CardDescription, CardHeader, CardTitle } from "@fundroomhq/ui";
import { Link } from "@tanstack/react-router";
import {
  BadgeCheck,
  FileSpreadsheet,
  KeyRound,
  type LucideIcon,
  Signature,
  Webhook,
} from "lucide-react";
import { m } from "../../paraglide/messages.js";

/*
 * The hub's "elsewhere" row: integrations that predate E3.6 keep their own screens (Google
 * Sheets is a metrics-module service account, e-signature and accreditation kernel vendor
 * connections, webhooks and API keys the generic outbound/inbound), so the hub links to them
 * instead of moving them.
 * Each card appears only for someone who could open the screen behind it. The heading's link
 * stretches over the card (`after:inset-0`), so the whole card is the target and the link's
 * name is the heading.
 */
const STRETCH =
  "after:absolute after:inset-0 after:rounded-xl focus-visible:outline-hidden focus-visible:after:ring-[3px] focus-visible:after:ring-ring/50";

type Related = {
  id: string;
  icon: LucideIcon;
  title: string;
  body: string;
  link: (className: string, text: string) => React.ReactNode;
};

export function RelatedIntegrations({
  bootstrap,
}: {
  bootstrap: FundRoomSchemas["ModulesBootstrap"];
}) {
  const has = (p: string) => bootstrap.permissions.includes(p);
  const metricsOn = bootstrap.modules.some((mod) => mod.id === "metrics" && mod.enabled);
  const cards: Related[] = [];
  if (metricsOn && has("metrics.settings")) {
    cards.push({
      id: "sheets",
      icon: FileSpreadsheet,
      title: m.integrations_related_sheets(),
      body: m.integrations_related_sheets_body(),
      link: (className, text) => (
        <Link to="/admin/$" params={{ _splat: "metrics/sheets" }} className={className}>
          {text}
        </Link>
      ),
    });
  }
  if (has("esign.read")) {
    cards.push({
      id: "esign",
      icon: Signature,
      title: m.integrations_related_esign(),
      body: m.integrations_related_esign_body(),
      link: (className, text) => (
        <Link to="/admin/esign" className={className}>
          {text}
        </Link>
      ),
    });
  }
  // E3.7: accreditation vendors are a kernel connection of their own (ADR-0055).
  if (has("accreditation.read")) {
    cards.push({
      id: "accreditation",
      icon: BadgeCheck,
      title: m.integrations_related_accreditation(),
      body: m.integrations_related_accreditation_body(),
      link: (className, text) => (
        <Link to="/admin/accreditation" className={className}>
          {text}
        </Link>
      ),
    });
  }
  if (has("webhooks.read")) {
    cards.push({
      id: "webhooks",
      icon: Webhook,
      title: m.integrations_related_webhooks(),
      body: m.integrations_related_webhooks_body(),
      link: (className, text) => (
        <Link to="/admin/webhooks" className={className}>
          {text}
        </Link>
      ),
    });
  }
  if (has("api-keys.read")) {
    cards.push({
      id: "api-keys",
      icon: KeyRound,
      title: m.integrations_related_api_keys(),
      body: m.integrations_related_api_keys_body(),
      link: (className, text) => (
        <Link to="/admin/api-keys" className={className}>
          {text}
        </Link>
      ),
    });
  }
  if (cards.length === 0) return null;
  return (
    <section aria-labelledby="integrations-related-heading" className="space-y-4">
      <h2 id="integrations-related-heading" className="text-lg font-semibold">
        {m.integrations_related_title()}
      </h2>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((card) => {
          const Icon = card.icon;
          return (
            <li key={card.id}>
              <Card className="relative h-full transition-colors hover:bg-accent/40">
                <CardHeader>
                  <Icon aria-hidden="true" className="size-5 text-primary" />
                  <CardTitle>
                    <h3>{card.link(STRETCH, card.title)}</h3>
                  </CardTitle>
                  <CardDescription>{card.body}</CardDescription>
                </CardHeader>
              </Card>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
