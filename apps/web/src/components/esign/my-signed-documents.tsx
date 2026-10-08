import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  toast,
} from "@fundroomhq/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { describeError } from "../../lib/api.js";
import {
  downloadMySignedCopy,
  type ESignEnvelope,
  myEnvelopesQuery,
} from "../../lib/esign-member-queries.js";
import { formatDate } from "../../lib/format.js";
import { useViewAs } from "../../lib/queries.js";
import { m } from "../../paraglide/messages.js";

/*
 * "Signed documents" on the member's own settings page (E3.5): what they signed electronically
 * in this workspace, with their copy of each. Deliberately small — the list is the member's own
 * envelopes (`GET /esign/me/envelopes`), and a workspace that never used e-signature shows
 * nothing at all rather than an empty card about a feature the member has never met.
 */

function statusLabel(status: ESignEnvelope["status"]): string {
  switch (status) {
    case "completed":
      return m.esign_me_status_completed();
    case "declined":
      return m.esign_me_status_declined();
    case "voided":
    case "expired":
    case "error":
      return m.esign_me_status_closed();
    default:
      return m.esign_me_status_open();
  }
}

function DownloadButton({ envelope }: { envelope: ESignEnvelope }) {
  const download = useMutation({
    mutationFn: () => downloadMySignedCopy(envelope),
    onError: (error) => toast.error(describeError(error).body),
  });
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      loading={download.isPending}
      onClick={() => download.mutate()}
      aria-label={m.esign_me_download_named({ title: envelope.title })}
    >
      <Download aria-hidden="true" />
      {m.esign_me_download()}
    </Button>
  );
}

export function MySignedDocuments() {
  const envelopes = useQuery(myEnvelopesQuery);
  const viewingAs = useViewAs() !== null;
  // Errors included: this card is an aside on the profile page, never the reason it fails.
  const items = envelopes.data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.esign_me_title()}</CardTitle>
        <CardDescription>{m.esign_me_subtitle()}</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {items.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0 space-y-1">
                <p className="truncate text-sm font-medium">{e.title}</p>
                <p className="text-xs text-muted-foreground">
                  {e.completedAt === null
                    ? m.esign_me_sent_on({ date: formatDate(e.sentAt ?? e.createdAt) })
                    : m.esign_me_signed_on({ date: formatDate(e.completedAt) })}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={e.status === "completed" ? "success" : "outline"}>
                  {statusLabel(e.status)}
                </Badge>
                {e.hasSigned && !viewingAs ? <DownloadButton envelope={e} /> : null}
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
