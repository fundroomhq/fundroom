import {
  Alert,
  AlertDescription,
  Badge,
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
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Server, Terminal } from "lucide-react";
import { ErrorAlert } from "../../components/error-alert.js";
import { type Cell, formatCount, platformCellsQuery } from "../../lib/platform-queries.js";
import { formatAge, jurisdictionLabel } from "../../lib/residency-queries.js";
import { m } from "../../paraglide/messages.js";

export const Route = createFileRoute("/platform/cells")({ component: CellsPage });

/** A command line, not prose: the same in every language. */
const ADD_COMMAND =
  "fundroom cell add <id> --region <code> --label <text> --jurisdiction <code> --origin <https-origin>";

/** Shown in a cell that has no value (a remote cell's count, a cell that never beat). */
const NONE = "—";

/*
 * The cells this install knows (E3.11, ADR-0059). Local cells share this database — moving a
 * workspace between them is an instant label change on the workspace page. Remote cells come
 * from the shared directory: each is its own deployment (database, bucket, queue, keys) in the
 * region it declares, reached by a move. Read-only on purpose: cells are added and drained at the
 * server's command line, where the database and the directory credentials are.
 */
function CellsPage() {
  const cells = useQuery(platformCellsQuery);
  const items = cells.data?.cells ?? [];
  return (
    <div className="space-y-6">
      <PageHeader title={m.platform_cells_title()} description={m.platform_cells_body()} />
      <Alert>
        <Terminal aria-hidden="true" />
        <AlertDescription className="space-y-1">
          <p>{m.platform_cells_cli_hint()}</p>
          <p>
            <code className="font-mono text-xs break-all">{ADD_COMMAND}</code>
          </p>
        </AlertDescription>
      </Alert>
      {cells.isPending ? <LoadingState lines={3} label={m.common_loading()} /> : null}
      {cells.isError ? <ErrorAlert error={cells.error} /> : null}
      {cells.data && items.length === 0 ? (
        <EmptyState
          icon={<Server />}
          title={m.platform_cells_none_title()}
          description={m.platform_cells_none_body()}
        />
      ) : null}
      {items.length > 0 ? (
        <Card>
          <CardContent className="overflow-x-auto pt-6">
            <Table>
              <TableCaption className="sr-only">{m.platform_cells_title()}</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>{m.platform_col_cell()}</TableHead>
                  <TableHead>{m.platform_col_region()}</TableHead>
                  <TableHead>{m.platform_col_jurisdiction()}</TableHead>
                  <TableHead>{m.platform_col_origin()}</TableHead>
                  <TableHead>{m.platform_col_status()}</TableHead>
                  <TableHead>{m.platform_col_served_by()}</TableHead>
                  <TableHead>{m.platform_col_heartbeat()}</TableHead>
                  <TableHead className="text-right">{m.platform_col_workspaces()}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((c) => (
                  <CellRow key={c.id} cell={c} />
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function CellRow({ cell }: { cell: Cell }) {
  return (
    <TableRow>
      <TableCell className="font-mono text-xs">{cell.id}</TableCell>
      <TableCell>
        <div className="font-mono text-xs">{cell.region}</div>
        {cell.regionLabel.trim() === "" ? null : (
          <div className="text-sm text-muted-foreground">{cell.regionLabel}</div>
        )}
      </TableCell>
      <TableCell>
        {cell.jurisdiction === null
          ? m.platform_not_declared()
          : jurisdictionLabel(cell.jurisdiction)}
      </TableCell>
      <TableCell className="break-all">
        {cell.publicOrigin === "" ? m.platform_origin_this_install() : cell.publicOrigin}
      </TableCell>
      <TableCell>
        <Badge variant={cellStatusVariant(cell.status)}>{cellStatusLabel(cell.status)}</Badge>
      </TableCell>
      <TableCell>
        <Badge variant="outline">
          {cell.local ? m.platform_cell_local() : m.platform_cell_remote()}
        </Badge>
      </TableCell>
      <TableCell>{cell.heartbeatAt === null ? NONE : formatAge(cell.heartbeatAt)}</TableCell>
      <TableCell className="text-right">
        {cell.workspaces === null ? NONE : formatCount(cell.workspaces)}
      </TableCell>
    </TableRow>
  );
}

function cellStatusLabel(status: Cell["status"]): string {
  switch (status) {
    case "active":
      return m.platform_cell_status_active();
    case "draining":
      return m.platform_cell_status_draining();
    default:
      return m.platform_cell_status_closed();
  }
}

function cellStatusVariant(status: Cell["status"]): "success" | "warning" | "outline" {
  return status === "active" ? "success" : status === "draining" ? "warning" : "outline";
}
