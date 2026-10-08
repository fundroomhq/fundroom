import { Button } from "@fundroomhq/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { PendingAcceptance } from "../../lib/compliance-queries.js";
import { splitByCeremony } from "../../lib/esign-member-queries.js";
import { m } from "../../paraglide/messages.js";
import { useSignOut } from "../account-menu.js";
import { Clickwrap } from "./clickwrap.js";
import { ESignCeremony } from "./esign-ceremony.js";

/*
 * The acceptance interstitial (ADR-0037 decision 5, design/04 §4). The server refuses every
 * member route until the outstanding documents are accepted — this screen is the humane path
 * to that, not the control. It replaces the portal entirely: no nav, no `Outlet`, nothing of
 * the offering reachable behind it.
 *
 * The ceremony itself lives in `Clickwrap` (contract C3), shared with the share-link landing and
 * the resource-scoped unlock sheet. What is left here is what is particular to *this* surface:
 * it is all-or-nothing, so the only way out other than agreeing is signing out, and success is
 * a bootstrap refresh — the bootstrap is the only thing that decides whether this screen stands.
 *
 * E3.5: a document whose `ceremony` is `esign` is signed with the workspace's e-signature vendor
 * instead (`ESignCeremony`). The two ceremonies stand side by side; each one's success refreshes
 * the bootstrap, so the screen shrinks to whatever is still owed and disappears when nothing is.
 */
export function AcceptanceGate({ pending }: { pending: readonly PendingAcceptance[] }) {
  const queryClient = useQueryClient();
  const signOut = useSignOut();
  const { clickwrap, esign } = splitByCeremony(pending);
  const unlocked = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["bootstrap"] });
    void queryClient.invalidateQueries({ queryKey: ["compliance", "gates"] });
  }, [queryClient]);
  const signOutButton = (
    <Button type="button" variant="ghost" onClick={() => void signOut()}>
      {m.account_sign_out()}
    </Button>
  );
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-6 p-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">{m.acceptance_gate_title()}</h1>
        <p className="text-muted-foreground text-sm">
          {m.acceptance_gate_body({ count: pending.length })}
        </p>
      </header>
      {esign.map((doc, i) => (
        <ESignCeremony
          key={doc.documentId}
          doc={doc}
          idPrefix="accept"
          onCompleted={unlocked}
          // One way out per screen: with no click-wrap below, the last e-sign card carries it.
          secondaryAction={clickwrap.length === 0 && i === esign.length - 1 ? signOutButton : null}
        />
      ))}
      {clickwrap.length > 0 ? (
        <Clickwrap
          documents={clickwrap}
          idPrefix="accept"
          submitLabel={m.acceptance_gate_submit()}
          onAccepted={unlocked}
          secondaryAction={signOutButton}
        />
      ) : null}
    </main>
  );
}
