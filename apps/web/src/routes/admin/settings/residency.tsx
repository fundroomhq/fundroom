import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
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
import { createFileRoute, Link } from "@tanstack/react-router";
import { ExternalLink, Globe, ShieldOff, Truck } from "lucide-react";
import { ErrorAlert } from "../../../components/error-alert.js";
import { formatDateTime } from "../../../lib/format.js";
import { useBootstrap } from "../../../lib/queries.js";
import {
  componentLabel,
  isMoveOver,
  isMoveSwitched,
  jurisdictionLabel,
  moveStateLabel,
  type Residency,
  type ResidencyComponent,
  type ResidencyRelocation,
  type ResidencySubProcessor,
  regionName,
  residencyQuery,
  safeHttpsUrl,
} from "../../../lib/residency-queries.js";
import { m } from "../../../paraglide/messages.js";

export const Route = createFileRoute("/admin/settings/residency")({ component: ResidencyPage });

/*
 * Data residency (E3.11, ADR-0059), read-only: where this workspace's data lives, as the host
 * declared it — the region, each part of the deployment, and every third party that processes
 * the workspace's data, split into the host's own choices and the vendors this workspace
 * connected itself. None of it is something the tenant can change here: the host places the
 * workspace, and a move to another region is theirs to run (the banner shows one in progress).
 */
function ResidencyPage() {
  const bootstrap = useBootstrap();
  const permissions = bootstrap.data?.permissions ?? [];
  const allowed = permissions.includes("compliance.read");
  // E3.11: while the workspace is unavailable (a move holds it) every other admin screen is the
  // unavailable panel, so this page links nowhere else until it is back.
  const linksOpen = (bootstrap.data?.workspaceStatus ?? null) === null;
  const residency = useQuery({ ...residencyQuery, enabled: allowed });
  if (!allowed) {
    return (
      <Alert variant="destructive" role="alert">
        <ShieldOff aria-hidden="true" />
        <AlertTitle>{m.error_forbidden_title()}</AlertTitle>
        <AlertDescription>{m.residency_forbidden()}</AlertDescription>
      </Alert>
    );
  }
  return (
    <div className="space-y-6">
      <PageHeader title={m.residency_title()} description={m.residency_subtitle()} />
      {linksOpen ? (
        <p className="text-sm">
          <Link to="/admin/settings" className="underline underline-offset-4">
            {m.adminsettings_back()}
          </Link>
        </p>
      ) : null}
      {residency.isPending ? <LoadingState lines={4} label={m.common_loading()} /> : null}
      {residency.isError ? <ErrorAlert error={residency.error} /> : null}
      {residency.data ? <ResidencyBody residency={residency.data} linksOpen={linksOpen} /> : null}
    </div>
  );
}

function ResidencyBody({ residency, linksOpen }: { residency: Residency; linksOpen: boolean }) {
  const deployment = residency.subProcessors.filter((s) => s.scope === "deployment");
  const workspace = residency.subProcessors.filter((s) => s.scope === "workspace");
  return (
    <>
      {residency.relocation === null ? null : (
        <RelocationBanner relocation={residency.relocation} />
      )}
      <RegionCard residency={residency} linksOpen={linksOpen} />
      <ComponentsCard components={residency.components} declared={residency.region !== null} />
      <SubProcessorsCard
        title={m.residency_vendors_deployment_title()}
        description={m.residency_vendors_deployment_body()}
        empty={m.residency_vendors_deployment_none()}
        items={deployment}
      />
      <SubProcessorsCard
        title={m.residency_vendors_workspace_title()}
        description={m.residency_vendors_workspace_body()}
        empty={m.residency_vendors_workspace_none()}
        items={workspace}
      />
      <DpaCard linksOpen={linksOpen} />
    </>
  );
}

function RelocationBanner({ relocation }: { relocation: ResidencyRelocation }) {
  const target = relocation.targetRegion ?? m.residency_relocation_unknown_region();
  const when = formatDateTime(relocation.requestedAt);
  const sentence = isMoveSwitched(relocation.state)
    ? m.residency_relocation_done({ target })
    : isMoveOver(relocation.state)
      ? m.residency_relocation_stopped({ target })
      : m.residency_relocation_live({ target, when });
  return (
    <Alert variant="warning" role="status">
      <Truck aria-hidden="true" />
      <AlertTitle>{m.residency_relocation_title()}</AlertTitle>
      <AlertDescription>
        <p>{sentence}</p>
        <p>{m.residency_relocation_state({ state: moveStateLabel(relocation.state) })}</p>
      </AlertDescription>
    </Alert>
  );
}

function RegionCard({ residency, linksOpen }: { residency: Residency; linksOpen: boolean }) {
  const region = residency.region;
  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Globe aria-hidden="true" className="size-5 text-muted-foreground" />
          {m.residency_region_title()}
        </CardTitle>
        <CardDescription>{m.residency_region_declared_body()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {region === null ? (
          <div className="space-y-1">
            <p className="font-medium">{m.residency_region_none_title()}</p>
            <p className="text-muted-foreground">{m.residency_region_none_body()}</p>
          </div>
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
            <dt className="text-muted-foreground">{m.residency_region_label()}</dt>
            <dd className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{regionName(region)}</span>
              <Badge variant="outline">{m.residency_declared_badge()}</Badge>
            </dd>
            <dt className="text-muted-foreground">{m.residency_region_code()}</dt>
            <dd className="font-mono text-xs">{region.code}</dd>
            <dt className="text-muted-foreground">{m.residency_jurisdiction()}</dt>
            <dd>
              {region.jurisdiction === null
                ? m.residency_not_declared()
                : jurisdictionLabel(region.jurisdiction)}
            </dd>
            {residency.cellId === null ? null : (
              <>
                <dt className="text-muted-foreground">{m.residency_cell()}</dt>
                <dd className="font-mono text-xs">{residency.cellId}</dd>
              </>
            )}
          </dl>
        )}
        {/* Two settings people confuse: this one is where data IS; the Legal one is which
            rules apply to the investors. Say so where both could be looked for. */}
        <p className="text-muted-foreground">
          {m.residency_not_privacy_regime()}
          {linksOpen ? (
            <>
              {" "}
              <Link
                to="/admin/legal"
                search={{ tab: "settings" }}
                className="text-foreground underline underline-offset-4"
              >
                {m.residency_privacy_regime_link()}
              </Link>
            </>
          ) : null}
        </p>
      </CardContent>
    </Card>
  );
}

function InRegionBadge({ value }: { value: boolean | null }) {
  if (value === null) return <Badge variant="outline">{m.residency_in_region_unknown()}</Badge>;
  return value ? (
    <Badge variant="success">{m.residency_in_region()}</Badge>
  ) : (
    <Badge variant="warning">{m.residency_outside_region()}</Badge>
  );
}

/** Shown in a cell the host left empty. */
function notDeclared(): string {
  return m.residency_not_declared();
}

function ComponentsCard({
  components,
  declared,
}: {
  components: readonly ResidencyComponent[];
  declared: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.residency_components_title()}</CardTitle>
        <CardDescription>
          {declared ? m.residency_components_body() : m.residency_components_body_no_region()}
        </CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableCaption className="sr-only">{m.residency_components_title()}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>{m.residency_col_component()}</TableHead>
              <TableHead>{m.residency_col_location()}</TableHead>
              <TableHead>{m.residency_jurisdiction()}</TableHead>
              <TableHead>{m.residency_col_in_region()}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {components.map((c) => (
              <TableRow key={c.component}>
                <TableCell className="font-medium">{componentLabel(c.component)}</TableCell>
                <TableCell>{c.location ?? notDeclared()}</TableCell>
                <TableCell>
                  {c.jurisdiction === null ? notDeclared() : jurisdictionLabel(c.jurisdiction)}
                </TableCell>
                <TableCell>
                  <InRegionBadge value={c.inRegion} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function SubProcessorsCard({
  title,
  description,
  empty,
  items,
}: {
  title: string;
  description: string;
  empty: string;
  items: readonly ResidencySubProcessor[];
}) {
  const sorted = [...items].sort(
    (a, b) => a.name.localeCompare(b.name) || a.purpose.localeCompare(b.purpose),
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        {sorted.length === 0 ? (
          <p className="text-sm text-muted-foreground">{empty}</p>
        ) : (
          <Table>
            <TableCaption className="sr-only">{title}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>{m.residency_col_vendor()}</TableHead>
                <TableHead>{m.residency_col_purpose()}</TableHead>
                <TableHead>{m.residency_col_data()}</TableHead>
                <TableHead>{m.residency_col_location()}</TableHead>
                <TableHead>{m.residency_col_transfer()}</TableHead>
                <TableHead>{m.residency_col_in_region()}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((s) => (
                // The server dedupes on (name, purpose): a name alone can repeat.
                <SubProcessorRow key={`${s.name}\u0000${s.purpose}`} vendor={s} />
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function SubProcessorRow({ vendor }: { vendor: ResidencySubProcessor }) {
  const dpa = safeHttpsUrl(vendor.dpaUrl);
  return (
    <TableRow>
      <TableCell className="align-top">
        <div className="font-medium">{vendor.name}</div>
        {vendor.certifications.length === 0 ? null : (
          <div className="text-xs text-muted-foreground">{vendor.certifications.join(", ")}</div>
        )}
        {dpa === null ? null : (
          <a
            href={dpa}
            target="_blank"
            rel="noreferrer noopener"
            aria-label={m.residency_vendor_dpa_label({ name: vendor.name })}
            className="inline-flex items-center gap-1 text-xs underline underline-offset-4"
          >
            {m.residency_vendor_dpa()}
            <ExternalLink aria-hidden="true" className="size-3" />
          </a>
        )}
      </TableCell>
      <TableCell className="align-top">{vendor.purpose}</TableCell>
      <TableCell className="align-top">{vendor.dataProcessed}</TableCell>
      <TableCell className="align-top">
        <div>{vendor.location}</div>
        <div className="text-xs text-muted-foreground">
          {jurisdictionLabel(vendor.jurisdiction)}
        </div>
      </TableCell>
      <TableCell className="align-top">
        {vendor.transferMechanism ?? m.residency_transfer_none()}
      </TableCell>
      <TableCell className="align-top">
        <InRegionBadge value={vendor.outsideRegion === null ? null : !vendor.outsideRegion} />
      </TableCell>
    </TableRow>
  );
}

function DpaCard({ linksOpen }: { linksOpen: boolean }) {
  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>{m.residency_dpa_title()}</CardTitle>
        <CardDescription>{m.residency_dpa_body()}</CardDescription>
      </CardHeader>
      <CardContent className="text-sm">
        {linksOpen ? (
          <Link
            to="/admin/legal"
            search={{ tab: "documents", template: "dpa" }}
            className="font-medium underline underline-offset-4"
          >
            {m.residency_dpa_link()}
          </Link>
        ) : (
          <p className="text-muted-foreground">{m.residency_dpa_after_move()}</p>
        )}
      </CardContent>
    </Card>
  );
}
