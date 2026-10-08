import { Alert, AlertDescription, AlertTitle, PageHeader } from "@fundroomhq/ui";
import { createFileRoute } from "@tanstack/react-router";
import { ShieldOff } from "lucide-react";
import { AccreditationConnectionCard } from "../../../components/accreditation-admin/connection.js";
import { useBootstrap } from "../../../lib/queries.js";
import { m } from "../../../paraglide/messages.js";

export const Route = createFileRoute("/admin/accreditation/")({ component: AccreditationPage });

/*
 * Accreditation vendors (E3.7, ADR-0055). A kernel screen, like e-signature: the connection's
 * credentials and its callback route are kernel facts, while the verification records stay in
 * the round module (its queue at `/admin/round/verifications`).
 */
function AccreditationPage() {
  const bootstrap = useBootstrap();
  const permissions = bootstrap.data?.permissions ?? [];
  if (!permissions.includes("accreditation.read")) {
    return (
      <Alert variant="destructive" role="alert">
        <ShieldOff aria-hidden="true" />
        <AlertTitle>{m.error_forbidden_title()}</AlertTitle>
        <AlertDescription>{m.accreditation_forbidden()}</AlertDescription>
      </Alert>
    );
  }
  const canManage = permissions.includes("accreditation.manage");
  const roundOn =
    (bootstrap.data?.modules ?? []).some((mod) => mod.id === "round" && mod.enabled) &&
    permissions.includes("round.read");
  return (
    <div className="space-y-6">
      <PageHeader title={m.accreditation_title()} description={m.accreditation_subtitle()} />
      {canManage ? null : (
        <p className="text-sm text-muted-foreground">{m.accreditation_read_only()}</p>
      )}
      <AccreditationConnectionCard canManage={canManage} roundOn={roundOn} />
    </div>
  );
}
