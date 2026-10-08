import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Field,
  fieldAria,
  Input,
  LoadingState,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  toast,
} from "@fundroomhq/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { ConfirmDialog } from "../../components/access/common.js";
import { NativeSelect } from "../../components/compliance/common.js";
import { ErrorAlert } from "../../components/error-alert.js";
import {
  callAs,
  crmApi,
  crmOrganizationsQuery,
  ORG_KINDS,
  type Organization,
} from "../../lib/crm-queries.js";
import { useGuardedMutation } from "../../lib/use-guarded-mutation.js";
import { m } from "../../paraglide/messages.js";
import { orgKindLabel } from "./format.js";

/*
 * Organisations (§C): the funds, angel groups and family offices behind the contacts. A
 * contact can exist without one and an organisation can exist with no contacts yet, so this
 * list is deliberately independent of the contact list rather than nested inside it.
 *
 * Deleting is soft, like a contact: `crm.contact.organization_id` is `ON DELETE SET NULL`, so
 * removing an organisation must not look like removing the people who worked there.
 */

interface OrgForm {
  name: string;
  domain: string;
  website: string;
  kind: string;
  notes: string;
}

function formOf(org?: Organization): OrgForm {
  return {
    name: org?.name ?? "",
    domain: org?.domain ?? "",
    website: org?.website ?? "",
    kind: typeof org?.kind === "string" ? org.kind : "",
    notes: org?.notes ?? "",
  };
}

function bodyOf(form: OrgForm) {
  const trimmed = (s: string): string | null => (s.trim() === "" ? null : s.trim());
  return {
    name: form.name.trim(),
    domain: trimmed(form.domain),
    website: trimmed(form.website),
    kind: form.kind === "" ? null : form.kind,
    notes: trimmed(form.notes),
  };
}

function OrganizationDialog({ org }: { org?: Organization }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<OrgForm>(formOf(org));
  const base = useId();
  const queryClient = useQueryClient();
  const isNew = org === undefined;

  const save = useGuardedMutation({
    mutationFn: () => {
      const body = bodyOf(form);
      if (org === undefined) {
        const entries = Object.entries(body).filter(([, v]) => v !== null);
        return callAs<Organization>(
          crmApi().POST("/crm/organizations", { body: Object.fromEntries(entries) }),
        );
      }
      return callAs<Organization>(
        crmApi().PATCH("/crm/organizations/{id}", {
          params: { path: { id: org.id } },
          body,
        }),
      );
    },
    onSuccess: () => {
      toast.success(isNew ? m.crm_org_created() : m.crm_org_saved());
      setOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["crm"] });
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setForm(formOf(org));
      }}
    >
      <DialogTrigger asChild>
        {isNew ? (
          <Button type="button">
            <Plus aria-hidden="true" />
            {m.crm_new_org()}
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={m.crm_edit_org({ name: org.name })}
          >
            <Pencil aria-hidden="true" className="size-4" />
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {isNew ? m.crm_new_org() : m.crm_edit_org({ name: org.name })}
            </DialogTitle>
            <DialogDescription>{m.crm_org_dialog_body()}</DialogDescription>
          </DialogHeader>
          <ErrorAlert error={save.error} />
          <Field id={`${base}-name`} label={m.common_name()} required>
            <Input
              id={`${base}-name`}
              required
              maxLength={200}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              id={`${base}-domain`}
              label={m.crm_field_domain()}
              description={m.crm_field_domain_help()}
            >
              <Input
                id={`${base}-domain`}
                value={form.domain}
                {...fieldAria(`${base}-domain`, { description: true })}
                onChange={(e) => setForm({ ...form, domain: e.target.value })}
              />
            </Field>
            <Field id={`${base}-website`} label={m.crm_field_website()}>
              <Input
                id={`${base}-website`}
                type="url"
                value={form.website}
                onChange={(e) => setForm({ ...form, website: e.target.value })}
              />
            </Field>
          </div>
          <Field id={`${base}-kind`} label={m.crm_field_kind()}>
            <NativeSelect
              id={`${base}-kind`}
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value })}
            >
              <option value="">{m.crm_org_kind_unset()}</option>
              {ORG_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {orgKindLabel(kind)}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field id={`${base}-notes`} label={m.crm_field_notes()}>
            <Textarea
              id={`${base}-notes`}
              rows={3}
              maxLength={4000}
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
            />
          </Field>
          <DialogFooter>
            <Button type="submit" loading={save.isPending}>
              {isNew ? m.crm_create_org() : m.common_save()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteOrgButton({ org }: { org: Organization }) {
  const queryClient = useQueryClient();
  const remove = useGuardedMutation({
    mutationFn: () =>
      callAs<unknown>(
        crmApi().DELETE("/crm/organizations/{id}", { params: { path: { id: org.id } } }),
      ),
    onSuccess: () => {
      toast.success(m.crm_org_deleted({ name: org.name }));
      void queryClient.invalidateQueries({ queryKey: ["crm"] });
    },
  });
  return (
    <ConfirmDialog
      trigger={
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={m.crm_delete_org({ name: org.name })}
        >
          <Trash2 aria-hidden="true" className="size-4" />
        </Button>
      }
      title={m.crm_delete_org({ name: org.name })}
      description={m.crm_delete_org_body()}
      confirmLabel={m.crm_delete_confirm()}
      pending={remove.isPending}
      onConfirm={() => remove.mutate()}
    />
  );
}

export function OrganizationsScreen({ canManage }: { canManage: boolean }) {
  const organizations = useQuery(crmOrganizationsQuery());
  const rows = organizations.data?.organizations ?? [];
  return (
    <div className="space-y-6">
      <PageHeader
        title={m.crm_orgs_title()}
        description={m.crm_orgs_subtitle()}
        actions={canManage ? <OrganizationDialog /> : null}
      />
      {organizations.isPending ? <LoadingState label={m.common_loading()} /> : null}
      {organizations.isError ? <ErrorAlert error={organizations.error} /> : null}
      {organizations.data ? (
        rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m.crm_orgs_empty()}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{m.common_name()}</TableHead>
                <TableHead scope="col">{m.crm_col_kind()}</TableHead>
                <TableHead scope="col">{m.crm_col_domain()}</TableHead>
                <TableHead scope="col">{m.crm_col_website()}</TableHead>
                {canManage ? <TableHead scope="col">{m.common_actions()}</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((org) => (
                <TableRow key={org.id}>
                  <TableCell className="font-medium">{org.name}</TableCell>
                  <TableCell>{orgKindLabel(org.kind)}</TableCell>
                  <TableCell>{org.domain ?? m.crm_no_domain()}</TableCell>
                  <TableCell>
                    {org.website === null ? (
                      m.crm_no_website()
                    ) : (
                      <a
                        href={org.website}
                        rel="noreferrer noopener"
                        target="_blank"
                        className="text-primary underline underline-offset-4"
                      >
                        {org.website}
                      </a>
                    )}
                  </TableCell>
                  {canManage ? (
                    <TableCell>
                      <div className="flex gap-1">
                        <OrganizationDialog org={org} />
                        <DeleteOrgButton org={org} />
                      </div>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )
      ) : null}
    </div>
  );
}
