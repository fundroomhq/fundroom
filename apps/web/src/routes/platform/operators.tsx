import {
  Alert,
  AlertDescription,
  Badge,
  Card,
  CardContent,
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
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Terminal } from "lucide-react";
import { ErrorAlert } from "../../components/error-alert.js";
import { formatDateTime } from "../../lib/format.js";
import { platformOperatorsQuery } from "../../lib/platform-queries.js";
import { m } from "../../paraglide/messages.js";

export const Route = createFileRoute("/platform/operators")({ component: OperatorsPage });

/** A command line, not prose: the same in every language. */
const GRANT_COMMAND = "fundroom operator grant <email>";

/*
 * Who can operate this install (E3.10). Read-only on purpose: an operator can suspend any
 * workspace, so granting and revoking happen only at the server's command line, where holding a
 * shell on the host is the proof of authority — a compromised operator session cannot mint a
 * second operator.
 */
function OperatorsPage() {
  const operators = useQuery(platformOperatorsQuery);
  return (
    <div className="space-y-6">
      <PageHeader title={m.platform_operators_title()} description={m.platform_operators_body()} />
      <Alert>
        <Terminal aria-hidden="true" />
        <AlertDescription className="space-y-1">
          <p>{m.platform_operators_cli_hint()}</p>
          <p>
            <code className="font-mono text-xs">{GRANT_COMMAND}</code>
          </p>
        </AlertDescription>
      </Alert>
      {operators.isPending ? <LoadingState lines={3} label={m.common_loading()} /> : null}
      {operators.isError ? <ErrorAlert error={operators.error} /> : null}
      {operators.data ? (
        <Card>
          <CardContent className="overflow-x-auto pt-6">
            <Table>
              <TableCaption className="sr-only">{m.platform_operators_title()}</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>{m.platform_col_operator()}</TableHead>
                  <TableHead>{m.platform_col_granted()}</TableHead>
                  <TableHead>{m.platform_col_granted_by()}</TableHead>
                  <TableHead>{m.platform_col_status()}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {operators.data.operators.map((op) => (
                  <TableRow key={op.userId}>
                    <TableCell>
                      <div>{op.email ?? m.platform_not_recorded()}</div>
                      <div className="font-mono text-xs text-muted-foreground">{op.userId}</div>
                    </TableCell>
                    <TableCell>{formatDateTime(op.createdAt)}</TableCell>
                    <TableCell className="font-mono text-xs">{op.createdBy}</TableCell>
                    <TableCell>
                      {op.revokedAt === null ? (
                        <Badge variant="success">{m.platform_operator_live()}</Badge>
                      ) : (
                        <Badge variant="outline">
                          {m.platform_operator_revoked({ when: formatDateTime(op.revokedAt) })}
                        </Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
