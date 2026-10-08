import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  fieldAria,
  Input,
  LoadingState,
  toast,
} from "@fundroomhq/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";
import { callNoContent } from "../../lib/access-admin-queries.js";
import { api, call } from "../../lib/api.js";
import { formatDateTime } from "../../lib/format.js";
import { SSO_KEY, type SsoDomain, ssoDomainsQuery } from "../../lib/sso-queries.js";
import { useGuardedMutation } from "../../lib/use-guarded-mutation.js";
import { m } from "../../paraglide/messages.js";
import { ConfirmDialog } from "../access/common.js";
import { PlanFeatureHint, usePlanAllowsFeature } from "../billing/plan-feature-notice.js";
import { ErrorAlert } from "../error-alert.js";
import { CopyRow, SsoRefusal } from "./common.js";

/*
 * Verified domains (E3.8). A domain proved by a DNS TXT record is what lets the identity
 * provider vouch for an email the workspace has never seen (just-in-time accounts, SCIM users).
 * One workspace per verified domain across the whole server; matching is exact, so a
 * subdomain is its own entry.
 */
export function SsoDomainsCard({ canManage }: { canManage: boolean }) {
  const domains = useQuery(ssoDomainsQuery);
  const list = domains.data?.domains ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.sso_admin_domains_title()}</CardTitle>
        <CardDescription>{m.sso_admin_domains_body()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {domains.isPending ? <LoadingState lines={2} label={m.common_loading()} /> : null}
        {domains.isError ? <ErrorAlert error={domains.error} /> : null}
        {domains.data === undefined ? null : list.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m.sso_admin_domains_empty()}</p>
        ) : (
          <ul className="space-y-4">
            {list.map((domain) => (
              <DomainRow key={domain.id} domain={domain} canManage={canManage} />
            ))}
          </ul>
        )}
        {canManage ? <AddDomain /> : null}
      </CardContent>
    </Card>
  );
}

function AddDomain() {
  const id = useId();
  // A-3: a domain is new scope — adding or verifying one needs `sso` on the plan.
  const planAllows = usePlanAllowsFeature("sso");
  const hintId = `${id}-plan`;
  const queryClient = useQueryClient();
  const [domain, setDomain] = useState("");
  const add = useGuardedMutation({
    mutationFn: (value: string) => call(api().POST("/sso/domains", { body: { domain: value } })),
    onSuccess: (result) => {
      toast.success(m.sso_admin_domain_added({ domain: result.domain.domain }));
      setDomain("");
      void queryClient.invalidateQueries({ queryKey: SSO_KEY });
    },
  });
  const value = domain.trim().toLowerCase();
  return (
    <form
      className="space-y-3"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (value !== "") add.mutate(value);
      }}
    >
      <Field id={id} label={m.sso_admin_domain_field()} description={m.sso_admin_domain_help()}>
        <Input
          id={id}
          value={domain}
          autoComplete="off"
          spellCheck={false}
          inputMode="url"
          onChange={(e) => {
            setDomain(e.target.value);
            add.reset();
          }}
          {...fieldAria(id, { description: true })}
        />
      </Field>
      {add.isError ? (
        <SsoRefusal error={add.error} title={m.sso_admin_domain_refused_title()} />
      ) : null}
      <PlanFeatureHint feature="sso" id={hintId} />
      <Button
        type="submit"
        loading={add.isPending}
        disabled={value === "" || !planAllows}
        aria-describedby={planAllows ? undefined : hintId}
      >
        {m.sso_admin_domain_add()}
      </Button>
    </form>
  );
}

function DomainRow({ domain, canManage }: { domain: SsoDomain; canManage: boolean }) {
  const queryClient = useQueryClient();
  const headingId = useId();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: SSO_KEY });
  const verify = useGuardedMutation({
    mutationFn: () =>
      call(api().POST("/sso/domains/{id}/verify", { params: { path: { id: domain.id } } })),
    onSuccess: (result) => {
      if (result.domain.status === "verified") {
        toast.success(m.sso_admin_domain_verified_ok({ domain: result.domain.domain }));
      } else {
        toast.error(m.sso_admin_domain_still_pending({ domain: result.domain.domain }));
      }
      void invalidate();
    },
  });
  const remove = useGuardedMutation({
    mutationFn: () =>
      callNoContent(api().DELETE("/sso/domains/{id}", { params: { path: { id: domain.id } } })),
    onSuccess: () => {
      toast.success(m.sso_admin_domain_removed({ domain: domain.domain }));
      void invalidate();
    },
  });
  const verified = domain.status === "verified";
  const planAllows = usePlanAllowsFeature("sso");
  const hintId = `${headingId}-plan`;
  return (
    <li aria-labelledby={headingId} className="space-y-3 rounded-md border p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h3 id={headingId} className="font-semibold break-all">
          {domain.domain}
        </h3>
        <Badge variant={verified ? "success" : "warning"}>
          {verified ? m.sso_admin_domain_verified() : m.sso_admin_domain_pending()}
        </Badge>
      </div>
      {verified && domain.verifiedAt !== null ? (
        <p className="text-sm text-muted-foreground">
          {m.sso_admin_domain_verified_at({ when: formatDateTime(domain.verifiedAt) })}
        </p>
      ) : null}
      {verified ? null : (
        <>
          <p className="text-sm text-muted-foreground">{m.sso_admin_domain_txt_body()}</p>
          <dl className="space-y-3">
            <CopyRow
              label={m.sso_admin_domain_txt_name()}
              value={domain.txtName}
              copyLabel={m.sso_admin_copy_txt_name({ domain: domain.domain })}
            />
            <CopyRow
              label={m.sso_admin_domain_txt_value()}
              value={domain.txtValue}
              copyLabel={m.sso_admin_copy_txt_value({ domain: domain.domain })}
            />
          </dl>
        </>
      )}
      {domain.lastError === null || verified ? null : (
        <p className="text-sm text-destructive">
          {domain.lastCheckedAt === null
            ? m.sso_admin_domain_last_error({ error: domain.lastError })
            : m.sso_admin_domain_last_error_at({
                error: domain.lastError,
                when: formatDateTime(domain.lastCheckedAt),
              })}
        </p>
      )}
      {verify.isError ? (
        <SsoRefusal error={verify.error} title={m.sso_admin_domain_verify_refused_title()} />
      ) : null}
      {remove.isError ? <SsoRefusal error={remove.error} /> : null}
      {canManage && !verified ? <PlanFeatureHint feature="sso" id={hintId} /> : null}
      {canManage ? (
        <div className="flex flex-wrap gap-2">
          {verified ? null : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              loading={verify.isPending}
              disabled={!planAllows}
              aria-describedby={planAllows ? undefined : hintId}
              onClick={() => verify.mutate()}
            >
              {m.sso_admin_domain_verify({ domain: domain.domain })}
            </Button>
          )}
          <ConfirmDialog
            trigger={
              <Button type="button" variant="ghost" size="sm">
                {m.sso_admin_domain_remove({ domain: domain.domain })}
              </Button>
            }
            title={m.sso_admin_domain_remove_title({ domain: domain.domain })}
            description={m.sso_admin_domain_remove_body()}
            confirmLabel={m.common_remove()}
            pending={remove.isPending}
            onConfirm={() => remove.mutate()}
          />
        </div>
      ) : null}
    </li>
  );
}
