import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  LoadingState,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@fundroomhq/ui";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  ArrowUpCircle,
  CheckCircle2,
  ExternalLink,
  Info,
  RefreshCw,
  ShieldAlert,
  ShieldOff,
} from "lucide-react";
import { ErrorAlert } from "../../../components/error-alert.js";
import { formatDate, formatDateTime } from "../../../lib/format.js";
import {
  type DomainHealth,
  type HealthCheck,
  opsHealthQuery,
  opsUpdateQuery,
  type UpdateStatus,
} from "../../../lib/ops-queries.js";
import { useBootstrap } from "../../../lib/queries.js";
import { m } from "../../../paraglide/messages.js";

export const Route = createFileRoute("/admin/health/")({ component: HealthPage });

/*
 * Health (E2.7; the plan's `/admin/health/deep`, served as `GET /ops/health`). Two tables:
 *
 *  - **Checks** — the adapters' own health checks (database, queue, storage, mail, scanning,
 *    DNS). They describe the whole instance, so on a multi-tenant install the server returns
 *    none and this screen says why (`scope: "workspace"`): the operator watches those, and a
 *    tenant seeing another tenant's outage would be a leak, not a feature.
 *  - **Domains** — this workspace's custom domains with their certificate. An expiry inside
 *    14 days is flagged: ACME renews at 30, so a certificate that close to expiry means
 *    renewal is failing and somebody should look before investors see a browser warning.
 *
 * Above both, an **Updates** card (E2.9, `GET /ops/update`): the running version against the
 * public release index. Single-tenant installs only — on a multi-tenant host the version is the
 * operator's business, the server answers `multi_tenant` and the card is not rendered. A security
 * release is a destructive alert, deliberately louder than an ordinary update; the page never
 * offers to update anything.
 */
function HealthPage() {
  const bootstrap = useBootstrap();
  if (!(bootstrap.data?.permissions ?? []).includes("ops.read")) {
    return (
      <Alert variant="destructive" role="alert">
        <ShieldOff aria-hidden="true" />
        <AlertTitle>{m.error_forbidden_title()}</AlertTitle>
        <AlertDescription>{m.ops_forbidden()}</AlertDescription>
      </Alert>
    );
  }
  return <HealthScreen />;
}

const EXPIRY_WARN_DAYS = 14;
const DAY_MS = 86_400_000;

function HealthScreen() {
  const health = useQuery(opsHealthQuery);
  return (
    <div className="space-y-6">
      <PageHeader
        title={m.health_title()}
        description={m.health_subtitle()}
        actions={
          <Button
            type="button"
            variant="outline"
            size="sm"
            loading={health.isFetching && !health.isPending}
            onClick={() => void health.refetch()}
          >
            <RefreshCw aria-hidden="true" />
            {m.ops_refresh()}
          </Button>
        }
      />
      <UpdateCard />
      {health.isPending ? <LoadingState lines={5} label={m.common_loading()} /> : null}
      {health.isError ? <ErrorAlert error={health.error} /> : null}
      {health.data ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{m.health_checks_title()}</CardTitle>
              <CardDescription>{m.health_checks_body()}</CardDescription>
            </CardHeader>
            <CardContent>
              {health.data.scope === "workspace" ? (
                <Alert>
                  <Info aria-hidden="true" />
                  <AlertTitle>{m.health_scope_workspace_title()}</AlertTitle>
                  <AlertDescription>{m.health_scope_workspace_body()}</AlertDescription>
                </Alert>
              ) : health.data.checks.length === 0 ? (
                <p className="text-sm text-muted-foreground">{m.health_checks_empty()}</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{m.health_col_check()}</TableHead>
                      <TableHead>{m.health_col_status()}</TableHead>
                      <TableHead>{m.health_col_detail()}</TableHead>
                      <TableHead className="text-right">{m.health_col_latency()}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {health.data.checks.map((check) => (
                      <TableRow key={check.name}>
                        <TableCell className="font-medium">{check.name}</TableCell>
                        <TableCell>
                          <CheckBadge status={check.status} />
                        </TableCell>
                        <TableCell className="break-words text-sm">{check.detail ?? "—"}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {check.latencyMs === null
                            ? "—"
                            : m.health_latency_ms({ ms: String(check.latencyMs) })}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{m.health_domains_title()}</CardTitle>
              <CardDescription>{m.health_domains_body()}</CardDescription>
            </CardHeader>
            <CardContent>
              {health.data.domains.length === 0 ? (
                <p className="text-sm text-muted-foreground">{m.health_domains_empty()}</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{m.health_col_hostname()}</TableHead>
                      <TableHead>{m.health_col_domain_status()}</TableHead>
                      <TableHead>{m.health_col_cert()}</TableHead>
                      <TableHead>{m.health_col_expires()}</TableHead>
                      <TableHead>{m.health_col_issuer()}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {health.data.domains.map((domain) => (
                      <DomainRow key={domain.hostname} domain={domain} />
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}

function CheckBadge({ status }: { status: HealthCheck["status"] }) {
  switch (status) {
    case "ok":
      return <Badge variant="success">{m.health_status_ok()}</Badge>;
    case "degraded":
      return <Badge variant="warning">{m.health_status_degraded()}</Badge>;
    case "down":
      return <Badge variant="destructive">{m.health_status_down()}</Badge>;
    case "skipped":
      return <Badge variant="outline">{m.health_status_skipped()}</Badge>;
  }
}

function domainStatusLabel(status: DomainHealth["status"]): string {
  switch (status) {
    case "pending":
      return m.health_domain_pending();
    case "dns_ok":
      return m.health_domain_dns_ok();
    case "active":
      return m.health_domain_active();
    case "failed":
      return m.health_domain_failed();
  }
}

function CertBadge({ status }: { status: DomainHealth["certStatus"] }) {
  switch (status) {
    case "valid":
      return <Badge variant="success">{m.health_cert_valid()}</Badge>;
    case "invalid":
      return <Badge variant="destructive">{m.health_cert_invalid()}</Badge>;
    case "expired":
      return <Badge variant="destructive">{m.health_cert_expired()}</Badge>;
    case "unreachable":
      return <Badge variant="warning">{m.health_cert_unreachable()}</Badge>;
    case "not_checked":
      return <Badge variant="outline">{m.health_cert_not_checked()}</Badge>;
  }
}

function DomainRow({ domain }: { domain: DomainHealth }) {
  const expiresAt = domain.certExpiresAt;
  const daysLeft =
    expiresAt === null ? null : Math.floor((Date.parse(expiresAt) - Date.now()) / DAY_MS);
  const soon = daysLeft !== null && daysLeft >= 0 && daysLeft < EXPIRY_WARN_DAYS;
  return (
    <TableRow>
      <TableCell className="font-mono text-xs">{domain.hostname}</TableCell>
      <TableCell>{domainStatusLabel(domain.status)}</TableCell>
      <TableCell>
        <div className="space-y-1">
          <CertBadge status={domain.certStatus} />
          {domain.certError ? (
            <p className="break-words text-xs text-muted-foreground">{domain.certError}</p>
          ) : null}
          {domain.checkedAt ? (
            <p className="text-xs text-muted-foreground">
              {m.health_checked_at({ when: formatDateTime(domain.checkedAt) })}
            </p>
          ) : null}
        </div>
      </TableCell>
      <TableCell>
        {expiresAt === null ? (
          "—"
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <span>{formatDate(expiresAt)}</span>
            {soon ? (
              <Badge variant="warning">{m.health_cert_expires_soon({ days: daysLeft })}</Badge>
            ) : null}
          </div>
        )}
      </TableCell>
      <TableCell className="text-sm">{domain.certIssuer ?? "—"}</TableCell>
    </TableRow>
  );
}

function UpdateCard() {
  const update = useQuery(opsUpdateQuery);
  // Hidden rather than an error: the page's own checks still render, and the error is not
  // actionable here. A multi-tenant host never reports the instance version to a tenant.
  if (update.isError) return null;
  if (update.data?.status === "disabled" && update.data.reason === "multi_tenant") return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.health_update_title()}</CardTitle>
        <CardDescription>{m.health_update_body()}</CardDescription>
      </CardHeader>
      <CardContent>
        {update.data ? (
          <UpdateBody status={update.data} />
        ) : (
          <LoadingState lines={1} label={m.common_loading()} />
        )}
      </CardContent>
    </Card>
  );
}

function ReleaseNotesLink({ status }: { status: UpdateStatus }) {
  if (status.releaseUrl === undefined || status.latestVersion === undefined) return null;
  return (
    <a
      href={status.releaseUrl}
      rel="noopener noreferrer"
      target="_blank"
      className="inline-flex items-center gap-1 font-medium underline underline-offset-4"
    >
      {m.health_update_notes({ version: status.latestVersion })}
      <ExternalLink aria-hidden="true" className="size-3" />
      <span className="sr-only">{m.health_update_new_tab()}</span>
    </a>
  );
}

function CheckedAt({ status }: { status: UpdateStatus }) {
  if (status.checkedAt === undefined) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {m.health_checked_at({ when: formatDateTime(status.checkedAt) })}
    </p>
  );
}

function UpdateBody({ status }: { status: UpdateStatus }) {
  const latest = status.latestVersion ?? "";
  switch (status.status) {
    case "security_update":
      return (
        <Alert variant="destructive">
          <ShieldAlert aria-hidden="true" />
          <AlertTitle>{m.health_update_security_title()}</AlertTitle>
          <AlertDescription>
            <p>
              {m.health_update_security_body({
                current: status.currentVersion,
                versions: (status.securityReleases ?? []).join(", "),
                latest,
              })}
            </p>
            <ReleaseNotesLink status={status} />
            <CheckedAt status={status} />
          </AlertDescription>
        </Alert>
      );
    case "update_available":
      return (
        <Alert variant="warning">
          <ArrowUpCircle aria-hidden="true" />
          <AlertTitle>{m.health_update_available_title({ version: latest })}</AlertTitle>
          <AlertDescription>
            <p>{m.health_update_available_body({ current: status.currentVersion })}</p>
            <ReleaseNotesLink status={status} />
            <CheckedAt status={status} />
          </AlertDescription>
        </Alert>
      );
    case "current":
      return (
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <CheckCircle2 aria-hidden="true" className="size-4 text-success" />
            <Badge variant="success">{m.health_update_current()}</Badge>
            <span className="text-sm">
              {m.health_update_running({ version: status.currentVersion })}
            </span>
          </div>
          <CheckedAt status={status} />
        </div>
      );
    case "unknown":
      return (
        <div className="space-y-1 text-sm">
          <p>{m.health_update_unknown({ version: status.currentVersion })}</p>
          {status.latestVersion === undefined ? null : (
            <p className="text-muted-foreground">
              {m.health_update_latest({ version: status.latestVersion })}
            </p>
          )}
        </div>
      );
    case "disabled":
      return <p className="text-sm text-muted-foreground">{m.health_update_off()}</p>;
    case "error":
      return (
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">{m.health_update_error()}</p>
          <CheckedAt status={status} />
        </div>
      );
  }
}
