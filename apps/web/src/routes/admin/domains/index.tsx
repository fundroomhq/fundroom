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
  EmptyState,
  Field,
  Input,
  LoadingState,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from "@fundroomhq/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Globe } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { ConfirmDialog } from "../../../components/access/common.js";
import { CopyButton } from "../../../components/copy-button.js";
import {
  DomainRecordsTable,
  domainStatusLabel,
  domainStatusVariant,
} from "../../../components/domains/domain-records.js";
import { ErrorAlert } from "../../../components/error-alert.js";
import { api, call, describeError } from "../../../lib/api.js";
import {
  type CustomDomain,
  type CustomDomainList,
  DOMAINS_KEY,
  describeDomainError,
  domainErrorReason,
  domainsQuery,
  isVerified,
} from "../../../lib/domains-queries.js";
import { formatDateTime } from "../../../lib/format.js";
import { useBootstrap } from "../../../lib/queries.js";
import { useGuardedMutation } from "../../../lib/use-guarded-mutation.js";
import { m } from "../../../paraglide/messages.js";

export const Route = createFileRoute("/admin/domains/")({ component: DomainsPage });

/*
 * Custom portal domains (E2.1, EXECUTION_PLAN §9.2, ADR-0039). A kernel file route rather than
 * a module page, because the server side is kernel: the hostname → workspace lookup runs in the
 * tenant classifier, before there is a tenant context or a module enablement row to consult.
 *
 * The screen is the E1.4 sending-domain card generalised to a list, and it owes the operator
 * three things the sending-domain card did not have to say:
 *
 *  - **`dns_ok` is not a waiting room.** Verified means a certificate is *allowed*, not that one
 *    exists: it is obtained on the first HTTPS request to the hostname. Without that sentence
 *    and a link to open the domain, a founder sits on `dns_ok` waiting for something only their
 *    own visit can trigger.
 *  - **Every refusal gets its own sentence.** The server distinguishes an IP literal from a
 *    public suffix from a hostname another workspace already verified, and collapsing those into
 *    "conflict" would make the admin guess which problem they have (`describeDomainError`).
 *  - **What DNS actually said**, verbatim from the last check, because "no TXT record at that
 *    name" and "TXT present but different" have different owners.
 *
 * E3.10 `cloudflare-saas`: Cloudflare issues the certificate, so `dns_ok` there IS a waiting
 * room — the row becomes `active` by itself once Cloudflare reports the hostname and its
 * certificate active — and the screen shows Cloudflare's own state and any extra records it asks
 * for (`providerState` / `providerRecords`) instead of telling the founder to open the domain.
 *
 * Mutations need fresh auth (design/02 §78), so they go through `useGuardedMutation`: a session
 * that is signed in but stale gets the step-up screen and comes back, instead of a toast that
 * says "forbidden" to an admin who is holding the right permission.
 */
function DomainsPage() {
  const bootstrap = useBootstrap();
  const canManage = (bootstrap.data?.permissions ?? []).includes("domains.manage");
  const domains = useQuery(domainsQuery);
  return (
    <div className="space-y-6">
      <PageHeader title={m.domains_title()} description={m.domains_subtitle()} />
      {domains.isPending ? <LoadingState lines={5} label={m.common_loading()} /> : null}
      {domains.isError ? <ErrorAlert error={domains.error} /> : null}
      {domains.data ? <DomainsList list={domains.data} canManage={canManage} /> : null}
    </div>
  );
}

function DomainsList({ list, canManage }: { list: CustomDomainList; canManage: boolean }) {
  return (
    <>
      {list.driver === "manual" ? (
        <Alert>
          <Globe aria-hidden="true" />
          <AlertTitle>{m.domains_title()}</AlertTitle>
          <AlertDescription>{m.domains_driver_manual()}</AlertDescription>
        </Alert>
      ) : null}
      {list.domains.length === 0 ? (
        <EmptyState
          icon={<Globe />}
          title={m.domains_none_title()}
          description={m.domains_none_body()}
        />
      ) : (
        <ul className="space-y-4">
          {list.domains.map((domain) => (
            <li key={domain.id}>
              <DomainCard domain={domain} driver={list.driver} canManage={canManage} />
            </li>
          ))}
        </ul>
      )}
      <AddDomainCard canManage={canManage} />
    </>
  );
}

type Driver = CustomDomainList["driver"];

/** The one sentence each state owes the operator; `dns_ok` also owes them a link (see above). */
function StateNote({ domain, driver }: { domain: CustomDomain; driver: Driver }) {
  switch (domain.status) {
    case "dns_ok":
      // The provider issues the certificate by itself; there is nothing for the founder to open.
      if (driver === "cloudflare-saas") {
        return (
          <Alert variant="warning">
            <AlertTitle>{m.domains_state_dns_ok_title()}</AlertTitle>
            <AlertDescription>{m.domains_state_dns_ok_provider()}</AlertDescription>
          </Alert>
        );
      }
      return (
        <Alert variant="warning">
          <AlertTitle>{m.domains_state_dns_ok_title()}</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>{m.domains_state_dns_ok()}</p>
            <Button asChild size="sm">
              <a href={`https://${domain.hostname}`} target="_blank" rel="noreferrer noopener">
                {m.domains_open({ host: domain.hostname })}
              </a>
            </Button>
          </AlertDescription>
        </Alert>
      );
    case "active":
      return (
        <Alert variant="success">
          <AlertTitle>{m.domains_state_active_title()}</AlertTitle>
          <AlertDescription>{m.domains_state_active()}</AlertDescription>
        </Alert>
      );
    case "failed":
      return (
        <Alert variant="destructive">
          <AlertTitle>{m.domains_state_failed_title()}</AlertTitle>
          <AlertDescription>{m.domains_state_failed()}</AlertDescription>
        </Alert>
      );
    default:
      return (
        <Alert>
          <AlertTitle>{m.domains_state_pending_title()}</AlertTitle>
          <AlertDescription>
            {m.domains_state_pending({ deadline: formatDateTime(domain.deadlineAt) })}
          </AlertDescription>
        </Alert>
      );
  }
}

function providerStateLabel(state: NonNullable<CustomDomain["providerState"]>): string {
  switch (state) {
    case "active":
      return m.domains_provider_state_active();
    case "failed":
      return m.domains_provider_state_failed();
    default:
      return m.domains_provider_state_pending();
  }
}

/**
 * What the certificate provider (Cloudflare) last said, and the extra TXT records it offers. They
 * are optional — with the CNAME in place it validates on its own — so they are labelled as such
 * and kept apart from the two records verification actually checks.
 */
function ProviderSection({ domain }: { domain: CustomDomain }) {
  const state = domain.providerState;
  if (state === undefined) return null;
  const records = domain.providerRecords ?? [];
  return (
    <section className="space-y-2 rounded-md border p-3" aria-label={m.domains_provider_title()}>
      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
        {m.domains_provider_title()}
        <Badge
          variant={state === "failed" ? "destructive" : state === "active" ? "default" : "warning"}
        >
          {providerStateLabel(state)}
        </Badge>
      </p>
      {records.length === 0 ? null : (
        <>
          <p className="text-sm text-muted-foreground">{m.domains_provider_records_body()}</p>
          <Table aria-label={m.domains_provider_records_for({ host: domain.hostname })}>
            <TableHeader>
              <TableRow>
                <TableHead>{m.domains_rec_type()}</TableHead>
                <TableHead>{m.domains_rec_name()}</TableHead>
                <TableHead>{m.domains_rec_value()}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {records.map((record) => (
                <TableRow key={`${record.type}:${record.name}:${record.value}`}>
                  <TableCell>
                    {record.type}
                    {record.required ? null : (
                      <span className="block text-xs text-muted-foreground">
                        {m.domains_rec_optional()}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs break-all">{record.name}</TableCell>
                  <TableCell className="font-mono text-xs break-all">
                    <span className="flex flex-wrap items-center gap-2">
                      <span>{record.value}</span>
                      <CopyButton value={record.value} label={m.common_copy()} />
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
    </section>
  );
}

function DomainCard({
  domain,
  driver,
  canManage,
}: {
  domain: CustomDomain;
  driver: Driver;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: DOMAINS_KEY });
  const verify = useGuardedMutation({
    mutationFn: () =>
      call(api().POST("/domains/{id}/verify", { params: { path: { id: domain.id } } })),
    onSuccess: (checked) => {
      void invalidate();
      if (isVerified(checked)) toast.success(m.domains_verify_ok());
      else toast.info(m.domains_verify_not_yet());
    },
    onError: (error) => toast.error(describeDomainError(error)),
  });
  const remove = useGuardedMutation({
    mutationFn: () => call(api().DELETE("/domains/{id}", { params: { path: { id: domain.id } } })),
    onSuccess: () => {
      void invalidate();
      toast.success(m.domains_removed());
    },
    onError: (error) => toast.error(describeDomainError(error)),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm break-all">{domain.hostname}</span>
          <Badge variant={domainStatusVariant(domain.status)}>
            {domainStatusLabel(domain.status)}
          </Badge>
          <span className="text-xs font-normal text-muted-foreground">
            {domain.lastCheckedAt === null
              ? m.domains_never_checked()
              : m.domains_checked({ when: formatDateTime(domain.lastCheckedAt) })}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <StateNote domain={domain} driver={driver} />
        <DomainRecordsTable domain={domain} />
        <ProviderSection domain={domain} />
        {domain.detail === null ? null : (
          <div className="space-y-1 rounded-md border p-3">
            <p className="text-sm font-medium">{m.domains_answer_title()}</p>
            <p className="text-sm text-muted-foreground">{domain.detail}</p>
            <ResolverLine domain={domain} />
          </div>
        )}
        {canManage ? (
          <div className="flex flex-wrap gap-2">
            <Button type="button" loading={verify.isPending} onClick={() => verify.mutate()}>
              {m.domains_verify()}
            </Button>
            <ConfirmDialog
              trigger={
                <Button type="button" variant="outline" disabled={remove.isPending}>
                  {m.domains_remove()}
                </Button>
              }
              title={m.domains_remove()}
              description={m.domains_remove_body()}
              confirmLabel={m.domains_remove()}
              onConfirm={() => remove.mutate()}
              pending={remove.isPending}
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** Which resolver produced the answer on screen: two have to agree, and one of them said this. */
function ResolverLine({ domain }: { domain: CustomDomain }) {
  const answer = domain.answer;
  const resolver = answer?.txt?.resolver ?? answer?.cname?.resolver;
  if (resolver === undefined) return null;
  return <p className="text-xs text-muted-foreground">{m.domains_answer_resolver({ resolver })}</p>;
}

function AddDomainCard({ canManage }: { canManage: boolean }) {
  const queryClient = useQueryClient();
  const bootstrap = useBootstrap();
  // The sending domain is a different record set with a different state machine (decision 2),
  // and E1.4 already shipped its screen — so this points at it instead of rebuilding it. Only
  // when the module is actually on: a link to a page that 404s is worse than no link.
  const hasUpdates = (bootstrap.data?.modules ?? []).some(
    (mod) => mod.id === "updates" && mod.enabled,
  );
  const id = useId();
  const [hostname, setHostname] = useState("");
  const add = useGuardedMutation({
    mutationFn: () => call(api().POST("/domains", { body: { hostname: hostname.trim() } })),
    onSuccess: () => {
      setHostname("");
      void queryClient.invalidateQueries({ queryKey: DOMAINS_KEY });
      toast.success(m.domains_added());
    },
    // A refused hostname is a typo in the field above, not a failed screen, so it is rendered
    // beside the field rather than thrown at a toast that vanishes while the admin is still
    // reading it. Anything that is not a refusal (offline, 500, rate limit) still gets the toast.
    onError: (error) => {
      if (domainErrorReason(error) === undefined) toast.error(describeError(error).body);
    },
  });
  const rejection = add.isError ? domainErrorReason(add.error) : undefined;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.domains_add_title()}</CardTitle>
        <CardDescription>{m.domains_add_body()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (hostname.trim() !== "") add.mutate();
          }}
        >
          <Field
            id={id}
            label={m.domains_field()}
            description={m.domains_field_help()}
            className="flex-1"
            error={rejection === undefined ? undefined : describeDomainError(add.error)}
          >
            <Input
              id={id}
              value={hostname}
              disabled={!canManage}
              placeholder="investors.example.com"
              autoComplete="off"
              onChange={(e) => setHostname(e.target.value)}
            />
          </Field>
          {canManage ? (
            <Button type="submit" loading={add.isPending} disabled={hostname.trim() === ""}>
              {m.domains_add()}
            </Button>
          ) : null}
        </form>
        {hasUpdates ? (
          <p className="text-sm text-muted-foreground">
            {m.domains_sending_note()}{" "}
            <Link
              to="/admin/$"
              params={{ _splat: "updates/settings" }}
              // Persistently underlined for the same reason as the wizard's copy of this
              // link: inside a muted paragraph, `text-primary` is under the 3:1 contrast
              // that would let colour carry the distinction on its own (WCAG 2.2 AA 1.4.1).
              className="text-primary underline underline-offset-4"
            >
              {m.domains_sending_link()}
            </Link>
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
