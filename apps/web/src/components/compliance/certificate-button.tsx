import { Button, toast } from "@fundroomhq/ui";
import { useMutation } from "@tanstack/react-query";
import { FileBadge } from "lucide-react";
import { describeError } from "../../lib/api.js";
import { downloadCertificate } from "../../lib/certificates.js";
import { useViewAs } from "../../lib/queries.js";
import { m } from "../../paraglide/messages.js";

/**
 * "Download the certificate" for one acceptance (E2.3). The bytes come from an authenticated
 * API read and are handed over as a blob — see `lib/certificates.ts` for why this is not a
 * plain link. A refusal becomes a toast rather than a blank tab.
 */
export function CertificateButton({
  membershipId,
  stamp,
  variant = "outline",
  size = "sm",
  label,
}: {
  membershipId: string;
  stamp: string;
  variant?: "outline" | "ghost" | "default";
  size?: "sm" | "default";
  label?: string;
}) {
  const viewingAs = useViewAs() !== null;
  const download = useMutation({
    mutationFn: () => downloadCertificate(membershipId, stamp, "pdf"),
    onError: (error) => toast.error(describeError(error).body),
  });
  // Staff viewing as an investor (E2.7) may not download as them; the server refuses with
  // `view_as_read_only`, so a button that can only fail is hidden instead.
  if (viewingAs) return null;
  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      loading={download.isPending}
      onClick={() => download.mutate()}
    >
      <FileBadge aria-hidden="true" />
      {label ?? m.certificate_download()}
    </Button>
  );
}
