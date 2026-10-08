import { Alert, AlertDescription, AlertTitle, PageHeader } from "@fundroomhq/ui";
import { createFileRoute } from "@tanstack/react-router";
import { ShieldOff } from "lucide-react";
import { useState } from "react";
import {
  ConnectionCard,
  type RevealedSecret,
  SetupHints,
} from "../../../components/esign-admin/connection.js";
import { EnvelopesCard } from "../../../components/esign-admin/envelopes.js";
import { ShownOnce } from "../../../components/shown-once.js";
import { useBootstrap } from "../../../lib/queries.js";
import { m } from "../../../paraglide/messages.js";

export const Route = createFileRoute("/admin/esign/")({ component: ESignPage });

/*
 * E-signature (E3.5, ADR-0053). A kernel screen: an e-sign NDA ceremony closes the NDA gate,
 * which is enforced before module enablement is knowable, so no module could own it.
 *
 * The callback secret of an "ours" vendor exists once, in the save or rotate response, so it is
 * pinned at the top of the page (with where to paste it) until dismissed. A step-up round trip
 * happens before the write, never after it, so the response is the only place it comes from.
 */
function ESignPage() {
  const bootstrap = useBootstrap();
  const permissions = bootstrap.data?.permissions ?? [];
  if (!permissions.includes("esign.read")) {
    return (
      <Alert variant="destructive" role="alert">
        <ShieldOff aria-hidden="true" />
        <AlertTitle>{m.error_forbidden_title()}</AlertTitle>
        <AlertDescription>{m.esign_forbidden()}</AlertDescription>
      </Alert>
    );
  }
  return <ESignScreen canManage={permissions.includes("esign.manage")} />;
}

function ESignScreen({ canManage }: { canManage: boolean }) {
  const [revealed, setRevealed] = useState<RevealedSecret>();
  return (
    <div className="space-y-6">
      <PageHeader title={m.esign_title()} description={m.esign_subtitle()} />
      {revealed ? (
        <ShownOnce
          title={revealed.title}
          value={revealed.secret}
          copyLabel={m.esign_copy_secret()}
          onDismiss={() => setRevealed(undefined)}
        >
          <SetupHints driver={revealed.driver} />
        </ShownOnce>
      ) : null}
      {canManage ? null : <p className="text-sm text-muted-foreground">{m.esign_read_only()}</p>}
      <ConnectionCard canManage={canManage} onSecret={setRevealed} />
      <EnvelopesCard canManage={canManage} />
    </div>
  );
}
