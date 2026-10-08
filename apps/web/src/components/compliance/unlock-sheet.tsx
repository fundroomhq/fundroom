import type { FundRoomSchemas } from "@fundroom/sdk";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  LoadingState,
} from "@fundroomhq/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import { type ReactNode, useState } from "react";
import { api, call } from "../../lib/api.js";
import type { PendingAcceptance } from "../../lib/compliance-queries.js";
import { splitByCeremony } from "../../lib/esign-member-queries.js";
import { m } from "../../paraglide/messages.js";
import { gateLabel } from "../access/common.js";
import { ErrorAlert } from "../error-alert.js";
import { CertificateButton } from "./certificate-button.js";
import { Clickwrap } from "./clickwrap.js";
import { ESignCeremony } from "./esign-ceremony.js";

export type PendingGate = FundRoomSchemas["PendingGate"];

/**
 * The document id an `nda` gate names, or `undefined` for a legacy `{ version }` config.
 * `PendingGate.detail` is an open record on the wire (contract A2), so this is the one place
 * that narrows it — a `documentId` read inline somewhere else would be a second place to get
 * the `null` case wrong.
 */
export function ndaDocumentId(gate: PendingGate): string | undefined {
  if (gate.kind !== "nda") return undefined;
  const id = gate.detail["documentId"];
  return typeof id === "string" && id !== "" ? id : undefined;
}

/*
 * "Accept to unlock" — the resource-scoped NDA (E2.3, contract S6.3).
 *
 * The third click-wrap surface and the only genuinely new one. A workspace-wide NDA is the
 * all-or-nothing interstitial and a share-link NDA is a step in the landing's ceremony, but a
 * gate on *one folder* cannot be either: the member may legitimately see the rest of the portal,
 * and replacing it with an interstitial would take away everything they are entitled to in order
 * to ask about the one thing they are not. So it is a sheet, launched from the lock badge the
 * data room already draws, and it shares the ceremony with the other two.
 *
 * Where the bytes come from: `GET /compliance/gates`. It lists the documents that gate the whole
 * portal (`scope: "workspace"`) and, since E3.5 (B3), also the documents named by the live `nda`
 * gates this member has not satisfied on one folder, document or share link
 * (`scope: "resource"`) — exactly the ones this sheet exists for; the interstitial and the
 * share-link landing ignore those. The sheet keeps only the documents its own gates name, and if
 * none comes back (an older server, or a gate naming a deleted document) it says honestly that
 * the text is not available rather than inventing one.
 */
export function UnlockSheet({
  gates,
  resourceLabel,
  membershipId,
  trigger,
  onUnlocked,
}: {
  gates: readonly PendingGate[];
  /** What is locked, for the sheet's title. Never the gated bytes — just the name. */
  resourceLabel: string;
  /** Whose certificate to offer afterwards. Empty when the bootstrap has not said. */
  membershipId: string;
  trigger: ReactNode;
  onUnlocked: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [stamps, setStamps] = useState<readonly string[]>([]);
  // E3.5: an e-signature NDA finishes without a click-wrap stamp; this is its "done".
  const [signed, setSigned] = useState(false);
  const queryClient = useQueryClient();
  const pending = useQuery({
    queryKey: ["compliance", "gates"],
    queryFn: () => call(api().GET("/compliance/gates")),
    enabled: open,
  });

  const wanted = new Set(gates.map(ndaDocumentId).filter((id) => id !== undefined));
  const documents: readonly PendingAcceptance[] = (pending.data?.pending ?? []).filter((doc) =>
    wanted.has(doc.documentId),
  );
  const other = gates.filter((g) => g.kind !== "nda");
  const { clickwrap, esign } = splitByCeremony(documents);
  const unlocked = () => {
    void queryClient.invalidateQueries({ queryKey: ["data-room"] });
    void queryClient.invalidateQueries({ queryKey: ["bootstrap"] });
    void queryClient.invalidateQueries({ queryKey: ["compliance", "gates"] });
    onUnlocked();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setStamps([]);
          setSigned(false);
        }
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{m.unlock_title({ name: resourceLabel })}</DialogTitle>
          <DialogDescription>{m.unlock_body()}</DialogDescription>
        </DialogHeader>
        {stamps.length > 0 || signed ? (
          <div className="space-y-4">
            <Alert variant="success">
              <AlertTitle>{m.unlock_done_title()}</AlertTitle>
              <AlertDescription>{m.unlock_done_body()}</AlertDescription>
            </Alert>
            {membershipId === "" ? null : (
              <div className="flex flex-wrap gap-2">
                {stamps.map((stamp) => (
                  <CertificateButton key={stamp} membershipId={membershipId} stamp={stamp} />
                ))}
              </div>
            )}
            <Button type="button" onClick={() => setOpen(false)}>
              {m.common_close()}
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            {other.length > 0 ? (
              <Alert>
                <Lock aria-hidden="true" />
                <AlertTitle>{m.unlock_other_gates_title()}</AlertTitle>
                <AlertDescription>
                  {other.map((g) => gateLabel(g.kind, g.detail)).join(", ")}
                </AlertDescription>
              </Alert>
            ) : null}
            {pending.isPending && wanted.size > 0 ? (
              <LoadingState lines={3} label={m.common_loading()} />
            ) : null}
            {pending.isError ? <ErrorAlert error={pending.error} /> : null}
            {pending.data && documents.length === 0 && wanted.size > 0 ? (
              <Alert variant="warning">
                <AlertTitle>{m.unlock_unavailable_title()}</AlertTitle>
                <AlertDescription>{m.unlock_unavailable_body()}</AlertDescription>
              </Alert>
            ) : null}
            {esign.map((doc) => (
              <ESignCeremony
                key={doc.documentId}
                doc={doc}
                idPrefix="unlock"
                onCompleted={() => {
                  setSigned(true);
                  unlocked();
                }}
              />
            ))}
            {clickwrap.length > 0 ? (
              <Clickwrap
                documents={clickwrap}
                idPrefix="unlock"
                submitLabel={m.unlock_submit()}
                onAccepted={(accepted) => {
                  setStamps(accepted);
                  unlocked();
                }}
              />
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
