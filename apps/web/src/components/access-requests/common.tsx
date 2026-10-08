import { Badge } from "@fundroomhq/ui";
import { m } from "../../paraglide/messages.js";
import type { AccessRequestStatus } from "./queries.js";

/** Localised names for the access-request statuses (the tab labels double as badge text). */
export function accessRequestStatusLabel(status: AccessRequestStatus): string {
  switch (status) {
    case "pending":
      return m.accessrequests_tab_pending();
    case "approved":
      return m.accessrequests_tab_approved();
    case "denied":
      return m.accessrequests_tab_denied();
    case "expired":
      return m.accessrequests_tab_expired();
  }
}

export function AccessRequestStatusBadge({ status }: { status: AccessRequestStatus }) {
  const variant =
    status === "approved"
      ? "success"
      : status === "pending"
        ? "warning"
        : status === "denied"
          ? "destructive"
          : "outline";
  return <Badge variant={variant}>{accessRequestStatusLabel(status)}</Badge>;
}

export function emptyLabel(status: AccessRequestStatus): string {
  switch (status) {
    case "pending":
      return m.accessrequests_empty_pending();
    case "approved":
      return m.accessrequests_empty_approved();
    case "denied":
      return m.accessrequests_empty_denied();
    case "expired":
      return m.accessrequests_empty_expired();
  }
}
