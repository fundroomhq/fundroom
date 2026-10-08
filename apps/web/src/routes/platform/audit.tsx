import {
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  LoadingState,
  PageHeader,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@fundroomhq/ui";
import { useInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Shield } from "lucide-react";
import { ErrorAlert } from "../../components/error-alert.js";
import { formatDateTime } from "../../lib/format.js";
import { type PlatformAuditEntry, platformAuditQuery } from "../../lib/platform-queries.js";
import { m } from "../../paraglide/messages.js";

export const Route = createFileRoute("/platform/audit")({ component: AuditPage });

/*
 * The platform audit chain (E3.10): every operator action, CLI grant and control-plane job
 * that touched the install, newest first. Operators appear as actor kind `host` with their user
 * id (the chain's CHECK has no `operator` kind), and `meta.operator` says so — the table shows
 * "Operator" for those rather than making the reader decode it.
 */
function AuditPage() {
  const audit = useInfiniteQuery(platformAuditQuery());
  const items = audit.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <div className="space-y-6">
      <PageHeader title={m.platform_audit_title()} description={m.platform_audit_body()} />
      {audit.isPending ? <LoadingState lines={6} label={m.common_loading()} /> : null}
      {audit.isError ? <ErrorAlert error={audit.error} /> : null}
      {audit.data ? (
        items.length === 0 ? (
          <EmptyState
            icon={<Shield />}
            title={m.platform_audit_none_title()}
            description={m.platform_audit_none_body()}
          />
        ) : (
          <Card>
            <CardContent className="space-y-4 overflow-x-auto pt-6">
              <Table>
                <TableCaption className="sr-only">{m.platform_audit_title()}</TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-right">{m.platform_col_seq()}</TableHead>
                    <TableHead>{m.platform_col_when()}</TableHead>
                    <TableHead>{m.platform_col_action()}</TableHead>
                    <TableHead>{m.platform_col_actor()}</TableHead>
                    <TableHead>{m.platform_col_resource()}</TableHead>
                    <TableHead>{m.platform_col_outcome()}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell className="text-right font-mono text-xs">{e.seq}</TableCell>
                      <TableCell className="whitespace-nowrap">
                        {formatDateTime(e.occurredAt)}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{e.action}</TableCell>
                      <TableCell>
                        <div>{actorLabel(e)}</div>
                        {e.actorUserId === null ? null : (
                          <div className="font-mono text-xs text-muted-foreground">
                            {e.actorUserId}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="font-mono text-xs">{e.resourceKind}</div>
                        {e.resourceId === null ? null : (
                          <div className="font-mono text-xs break-all text-muted-foreground">
                            {e.resourceId}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant={e.outcome === "success" ? "secondary" : "destructive"}>
                          {outcomeLabel(e.outcome)}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {audit.hasNextPage ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  loading={audit.isFetchingNextPage}
                  onClick={() => void audit.fetchNextPage()}
                >
                  {m.common_load_more()}
                </Button>
              ) : null}
            </CardContent>
          </Card>
        )
      ) : null}
    </div>
  );
}

function actorLabel(e: PlatformAuditEntry): string {
  if (e.meta["operator"] === true) return m.platform_actor_operator();
  switch (e.actorKind) {
    case "system":
      return m.platform_actor_system();
    case "host":
      return m.platform_actor_host();
    case "staff":
      return m.platform_actor_staff();
    default:
      return m.platform_actor_external();
  }
}

function outcomeLabel(outcome: PlatformAuditEntry["outcome"]): string {
  switch (outcome) {
    case "success":
      return m.platform_audit_success();
    case "denied":
      return m.platform_audit_denied();
    default:
      return m.platform_audit_failure();
  }
}
