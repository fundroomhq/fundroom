import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Field,
  fieldAria,
  Input,
  Label,
} from "@fundroomhq/ui";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useId, useState } from "react";
import { api, call, isCode } from "../../lib/api.js";
import type { PendingAcceptance } from "../../lib/compliance-queries.js";
import { formatDate } from "../../lib/format.js";
import { Markdown } from "../../lib/markdown.js";
import { useGuardedMutation } from "../../lib/use-guarded-mutation.js";
import { m } from "../../paraglide/messages.js";
import { ErrorAlert } from "../error-alert.js";
import { legalKindLabel } from "./common.js";

/*
 * The click-wrap ceremony, in one place (E2.3 contract C3).
 *
 * Three surfaces need it now — the workspace-wide interstitial (`AcceptanceGate`), the
 * share-link landing's pre-portal step, and the resource-scoped "accept to unlock" sheet — and
 * a second copy of a legal ceremony is a second place for it to drift out of compliance. So the
 * card and the submit are here, and the three surfaces differ only in what they do afterwards.
 *
 * The rules the ceremony must keep, all of them evidential rather than cosmetic:
 *
 *  - **The bytes come from the server with the acceptance's own identity on them.** `body` and
 *    `versionNo` travel together on `pendingAcceptances` / `GET /compliance/gates`, so the text
 *    on screen is the text the acceptance names. There is no second fetch that could serve a
 *    different version between reading and agreeing.
 *  - **Every box starts unticked.** A pre-ticked box is not a click-wrap; the sha256 on the
 *    version is worth nothing without the click it attests to.
 *  - **The client never sends a body hash** (contract C2). It posts `{ documentId, versionNo }`
 *    and the server records *its own* `bodySha256` from the stored version. A hash supplied by
 *    the signer's browser — the one party with an interest in what it says — is evidence of
 *    nothing, and echoing one back would make it look like it was.
 *  - **The text is reachable without a mouse**: the scroll region is focusable and named.
 */

/** One document's card: the text, and the box that says the person read it. */
export function ClickwrapCard({
  doc,
  checked,
  onCheckedChange,
  idPrefix,
}: {
  doc: PendingAcceptance;
  checked: boolean;
  onCheckedChange: (on: boolean) => void;
  /** Distinguishes the boxes when two ceremonies are mounted at once (a sheet over a page). */
  idPrefix: string;
}) {
  const boxId = `${idPrefix}-${doc.documentId}`;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{doc.title}</CardTitle>
        <CardDescription>
          {m.acceptance_gate_version({
            kind: legalKindLabel(doc.kind),
            version: String(doc.versionNo),
            date: formatDate(doc.effectiveAt),
          })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <section
          className="max-h-96 space-y-3 overflow-y-auto rounded-md border p-4 text-sm"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a focusable scroll region so the text can be read without a mouse (WAI-ARIA scrollable region pattern)
          tabIndex={0}
          aria-label={m.acceptance_gate_document_label({ title: doc.title })}
        >
          <Markdown source={doc.body} />
        </section>
        <div className="flex items-start gap-2">
          <Checkbox
            id={boxId}
            checked={checked}
            onCheckedChange={(on) => onCheckedChange(on === true)}
          />
          <Label htmlFor={boxId} className="leading-snug">
            {m.acceptance_gate_agree({ title: doc.title })}
          </Label>
        </div>
      </CardContent>
    </Card>
  );
}

export interface ClickwrapProps {
  readonly documents: readonly PendingAcceptance[];
  /** Distinguishes control ids when two ceremonies can be mounted at once. */
  readonly idPrefix: string;
  readonly submitLabel: string;
  /** Rendered beside the submit button (the interstitial puts "Sign out" there). */
  readonly secondaryAction?: ReactNode;
  /** The stamps just recorded, newest ceremony first. The surface decides what happens next. */
  readonly onAccepted: (stamps: readonly string[]) => void;
}

/**
 * The whole ceremony: a card per document, the optional typed name, and the submit that is
 * disabled until every box is ticked.
 */
export function Clickwrap({
  documents,
  idPrefix,
  submitLabel,
  secondaryAction,
  onAccepted,
}: ClickwrapProps) {
  const [agreed, setAgreed] = useState<readonly string[]>([]);
  const [typedName, setTypedName] = useState("");
  const nameId = useId();
  const queryClient = useQueryClient();
  const accept = useGuardedMutation<readonly string[], readonly PendingAcceptance[]>({
    mutationFn: async (docs) => {
      const stamps: string[] = [];
      for (const doc of docs) {
        const name = typedName.trim();
        const result = await call(
          api().POST("/compliance/acceptances", {
            body: {
              documentId: doc.documentId,
              versionNo: doc.versionNo,
              // Identity evidence (design/04 §4.3), optional and never a substitute for the
              // session that carries it. DEFECT, reported rather than worked around: the wire
              // schema `AcceptanceBody` (packages/contracts/src/compliance.ts) carries only
              // `documentId` and `versionNo`, so zod strips this key server-side and
              // `AcceptInput.typedName` — which `@fundroom/compliance` already reads and the
              // certificate already prints — is unreachable from the browser. Sending it here
              // is what makes the field work the moment the schema and the handler admit it.
              ...(name === "" ? {} : { typedName: name }),
            },
          }),
        );
        stamps.push(result.stamp);
      }
      return stamps;
    },
    onSuccess: (stamps) => onAccepted(stamps),
    onError: (error) => {
      // E3.5: the document became an e-signature NDA since this card was drawn. The server
      // refuses the click (409 `esign_required`); a fresh bootstrap carries the new ceremony.
      if (isCode(error, "esign_required")) {
        void queryClient.invalidateQueries({ queryKey: ["bootstrap"] });
        void queryClient.invalidateQueries({ queryKey: ["compliance", "gates"] });
      }
    },
  });
  const allAgreed = documents.every((d) => agreed.includes(d.documentId));
  return (
    <div className="space-y-6">
      {accept.isError ? (
        isCode(accept.error, "esign_required") ? (
          <Alert variant="destructive" role="alert">
            <AlertTitle>{m.esign_err_required_title()}</AlertTitle>
            <AlertDescription>{m.esign_err_required_body()}</AlertDescription>
          </Alert>
        ) : (
          <ErrorAlert error={accept.error} />
        )
      ) : null}
      {documents.map((doc) => (
        <ClickwrapCard
          key={doc.documentId}
          doc={doc}
          idPrefix={idPrefix}
          checked={agreed.includes(doc.documentId)}
          onCheckedChange={(on) =>
            setAgreed((cur) =>
              on ? [...cur, doc.documentId] : cur.filter((id) => id !== doc.documentId),
            )
          }
        />
      ))}
      <Field
        id={nameId}
        label={m.clickwrap_typed_name()}
        description={m.clickwrap_typed_name_hint()}
      >
        <Input
          id={nameId}
          value={typedName}
          autoComplete="name"
          maxLength={200}
          onChange={(e) => setTypedName(e.target.value)}
          {...fieldAria(nameId, { description: true })}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          loading={accept.isPending}
          disabled={!allAgreed}
          onClick={() => accept.mutate(documents)}
        >
          {submitLabel}
        </Button>
        {secondaryAction}
      </div>
      <p className="text-muted-foreground text-xs">{m.acceptance_gate_footnote()}</p>
    </div>
  );
}
