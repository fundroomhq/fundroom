import {
  Badge,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@fundroomhq/ui";
import type { ReactNode } from "react";
import type { Person } from "../../lib/queries.js";
import { m } from "../../paraglide/messages.js";

/** Localised names for kinds, roles, statuses and capabilities shared by the access screens. */
export function roleLabel(role: string): string {
  switch (role) {
    case "owner":
      return m.role_owner();
    case "admin":
      return m.role_admin();
    case "editor":
      return m.role_editor();
    case "viewer":
      return m.role_viewer();
    case "finance":
      return m.role_finance();
    case "legal":
      return m.role_legal();
    case "investor":
      return m.role_investor();
    case "delegate":
      return m.role_delegate();
    default:
      return role;
  }
}

export function statusLabel(status: string): string {
  switch (status) {
    case "invited":
      return m.status_invited();
    case "active":
      return m.status_active();
    case "dormant":
      return m.status_dormant();
    case "suspended":
      return m.status_suspended();
    case "revoked":
      return m.status_revoked();
    default:
      return status;
  }
}

export function capabilityLabel(cap: string): string {
  switch (cap) {
    case "view":
      return m.cap_view();
    case "download":
      return m.cap_download();
    case "comment":
      return m.cap_comment();
    case "edit":
      return m.cap_edit();
    default:
      return cap;
  }
}

export function gateLabel(kind: string, detail: Record<string, unknown>): string {
  switch (kind) {
    case "nda":
      return m.gate_nda({ version: String(detail["version"] ?? "") });
    case "accredited":
      return m.gate_accredited();
    case "min_auth_level":
      return m.gate_min_auth_level();
    case "ip_allowlist":
      return m.gate_ip_allowlist();
    default:
      return kind;
  }
}

export function StatusBadge({ status }: { status: Person["status"] }) {
  const variant =
    status === "active"
      ? "success"
      : status === "invited"
        ? "secondary"
        : status === "revoked"
          ? "destructive"
          : "outline";
  return <Badge variant={variant}>{statusLabel(status)}</Badge>;
}

/**
 * A person's name as every access screen shows it. A delegate reads "Jane Doe (for Acme Ventures —
 * Bob Smith)" (design/05 §4.2, E3.2), so nobody mistakes someone acting for an investor for the
 * investor.
 */
export function personName(
  p: Pick<Person, "displayName" | "email"> & {
    profile?: Person["profile"];
    principal?: Person["principal"] | undefined;
  },
): string {
  const fromProfile = p.profile?.["displayName"];
  const name =
    p.displayName || (typeof fromProfile === "string" ? fromProfile : "") || p.email || "—";
  const principal = p.principal;
  if (principal === undefined || principal === null) return name;
  return principal.firm
    ? m.person_delegate_for_firm({ name, firm: principal.firm, principal: principal.displayName })
    : m.person_delegate_for({ name, principal: principal.displayName });
}

export function ConfirmDialog({
  trigger,
  title,
  description,
  confirmLabel,
  onConfirm,
  pending,
  children,
}: {
  trigger: ReactNode;
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  pending: boolean;
  children?: ReactNode;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {m.common_cancel()}
            </Button>
          </DialogClose>
          <DialogClose asChild>
            <Button type="button" variant="destructive" loading={pending} onClick={onConfirm}>
              {confirmLabel}
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
