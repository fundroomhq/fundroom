import {
  Badge,
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
import { Link } from "@tanstack/react-router";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { ConfirmDialog } from "../../components/access/common.js";
import { NativeSelect } from "../../components/compliance/common.js";
import { ErrorAlert } from "../../components/error-alert.js";
import {
  type Contact,
  callAs,
  crmApi,
  crmContactsQuery,
  crmOrganizationsQuery,
  type Organization,
} from "../../lib/crm-queries.js";
import { useGuardedMutation } from "../../lib/use-guarded-mutation.js";
import { m } from "../../paraglide/messages.js";
import { nameOfMembership, OwnerMark, peopleOf, usePeople } from "./common.js";

/*
 * Contacts (§C). A contact is a relationship, not an account: most of them have no membership
 * at all, and the ones that do say so **in words** — "Linked to a member" — rather than with a
 * coloured dot, because that link is what makes a CRM row and a person in the access list the
 * same human.
 *
 * Deleting is a soft delete. The row goes out of every list and stays in the database, which
 * is the only behaviour that is honest about a pipeline item still pointing at it.
 */

export interface ContactForm {
  displayName: string;
  email: string;
  title: string;
  organizationId: string;
  tags: string;
  notes: string;
  membershipId: string;
}

export function formOf(contact?: Contact): ContactForm {
  return {
    displayName: contact?.displayName ?? "",
    email: contact?.email ?? "",
    title: contact?.title ?? "",
    organizationId: contact?.organizationId ?? "",
    tags: (contact?.tags ?? []).join(", "),
    notes: contact?.notes ?? "",
    membershipId: contact?.membershipId ?? "",
  };
}

/** "seed, warm intro ,, fund" → ["seed", "warm intro", "fund"]. Empties are not tags. */
export function parseTags(text: string): string[] {
  return text
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t !== "");
}

function bodyOf(form: ContactForm) {
  const trimmed = (s: string): string | null => (s.trim() === "" ? null : s.trim());
  return {
    displayName: form.displayName.trim(),
    email: trimmed(form.email),
    title: trimmed(form.title),
    organizationId: form.organizationId === "" ? null : form.organizationId,
    tags: parseTags(form.tags),
    notes: trimmed(form.notes),
    membershipId: form.membershipId === "" ? null : form.membershipId,
  };
}

function ContactFields({
  form,
  setForm,
  base,
  organizations,
}: {
  form: ContactForm;
  setForm: (form: ContactForm) => void;
  base: string;
  organizations: readonly Organization[];
}) {
  const people = usePeople();
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id={`${base}-name`} label={m.crm_field_display_name()} required>
          <Input
            id={`${base}-name`}
            required
            maxLength={200}
            value={form.displayName}
            onChange={(e) => setForm({ ...form, displayName: e.target.value })}
          />
        </Field>
        <Field id={`${base}-email`} label={m.crm_field_email()}>
          <Input
            id={`${base}-email`}
            type="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
        </Field>
        <Field id={`${base}-title`} label={m.crm_field_title()}>
          <Input
            id={`${base}-title`}
            maxLength={120}
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
        </Field>
        <Field id={`${base}-org`} label={m.crm_field_organization()}>
          <NativeSelect
            id={`${base}-org`}
            value={form.organizationId}
            onChange={(e) => setForm({ ...form, organizationId: e.target.value })}
          >
            <option value="">{m.crm_org_none()}</option>
            {organizations.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>
      <Field id={`${base}-tags`} label={m.crm_field_tags()} description={m.crm_field_tags_help()}>
        <Input
          id={`${base}-tags`}
          value={form.tags}
          {...fieldAria(`${base}-tags`, { description: true })}
          onChange={(e) => setForm({ ...form, tags: e.target.value })}
        />
      </Field>
      <Field
        id={`${base}-member`}
        label={m.crm_field_member()}
        description={m.crm_field_member_help()}
      >
        <NativeSelect
          id={`${base}-member`}
          value={form.membershipId}
          {...fieldAria(`${base}-member`, { description: true })}
          onChange={(e) => setForm({ ...form, membershipId: e.target.value })}
        >
          <option value="">{m.crm_member_none()}</option>
          {peopleOf(people).map((p) => (
            <option key={p.membershipId} value={p.membershipId}>
              {p.displayName}
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
    </div>
  );
}

function ContactDialog({
  contact,
  organizations,
}: {
  contact?: Contact;
  organizations: readonly Organization[];
}) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<ContactForm>(formOf(contact));
  const base = useId();
  const queryClient = useQueryClient();
  const isNew = contact === undefined;

  const save = useGuardedMutation({
    mutationFn: () => {
      const body = bodyOf(form);
      if (contact === undefined) {
        // `POST` takes the optional fields as absent-or-present; `PATCH` takes them nullable.
        const entries = Object.entries(body).filter(([, v]) => v !== null);
        return callAs<Contact>(
          crmApi().POST("/crm/contacts", { body: Object.fromEntries(entries) }),
        );
      }
      return callAs<Contact>(
        crmApi().PATCH("/crm/contacts/{id}", {
          params: { path: { id: contact.id } },
          body,
        }),
      );
    },
    onSuccess: () => {
      toast.success(isNew ? m.crm_contact_created() : m.crm_contact_saved());
      setOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["crm"] });
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setForm(formOf(contact));
      }}
    >
      <DialogTrigger asChild>
        {isNew ? (
          <Button type="button">
            <Plus aria-hidden="true" />
            {m.crm_new_contact()}
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={m.crm_edit_contact({ name: contact.displayName })}
          >
            <Pencil aria-hidden="true" className="size-4" />
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {isNew ? m.crm_new_contact() : m.crm_edit_contact({ name: contact.displayName })}
            </DialogTitle>
            <DialogDescription>{m.crm_contact_dialog_body()}</DialogDescription>
          </DialogHeader>
          <ErrorAlert error={save.error} />
          <ContactFields form={form} setForm={setForm} base={base} organizations={organizations} />
          <DialogFooter>
            <Button type="submit" loading={save.isPending}>
              {isNew ? m.crm_create_contact() : m.common_save()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteContactButton({ contact }: { contact: Contact }) {
  const queryClient = useQueryClient();
  const remove = useGuardedMutation({
    mutationFn: () =>
      callAs<unknown>(
        crmApi().DELETE("/crm/contacts/{id}", { params: { path: { id: contact.id } } }),
      ),
    onSuccess: () => {
      toast.success(m.crm_contact_deleted({ name: contact.displayName }));
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
          aria-label={m.crm_delete_contact({ name: contact.displayName })}
        >
          <Trash2 aria-hidden="true" className="size-4" />
        </Button>
      }
      title={m.crm_delete_contact({ name: contact.displayName })}
      description={m.crm_delete_contact_body()}
      confirmLabel={m.crm_delete_confirm()}
      pending={remove.isPending}
      onConfirm={() => remove.mutate()}
    />
  );
}

export function ContactsScreen({ canManage }: { canManage: boolean }) {
  const searchId = useId();
  const [q, setQ] = useState("");
  const contacts = useQuery(crmContactsQuery(q));
  const organizations = useQuery(crmOrganizationsQuery());
  const people = usePeople({ kind: "staff" });
  const orgs = organizations.data?.organizations ?? [];
  const rows = contacts.data?.contacts ?? [];

  const orgName = (contact: Contact): string =>
    contact.organization?.name ??
    orgs.find((o) => o.id === contact.organizationId)?.name ??
    m.crm_org_none();

  return (
    <div className="space-y-6">
      <PageHeader
        title={m.crm_contacts_title()}
        description={m.crm_contacts_subtitle()}
        actions={canManage ? <ContactDialog organizations={orgs} /> : null}
      />
      <div className="max-w-sm space-y-1">
        <label htmlFor={searchId} className="text-sm font-medium">
          {m.crm_search_label()}
        </label>
        <Input
          id={searchId}
          type="search"
          value={q}
          placeholder={m.crm_search_placeholder()}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {contacts.isPending ? <LoadingState label={m.common_loading()} /> : null}
      {contacts.isError ? <ErrorAlert error={contacts.error} /> : null}
      {contacts.data ? (
        rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {q.trim() === "" ? m.crm_contacts_empty() : m.crm_contacts_no_match({ q })}
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{m.common_name()}</TableHead>
                <TableHead scope="col">{m.crm_col_email()}</TableHead>
                <TableHead scope="col">{m.crm_col_organization()}</TableHead>
                <TableHead scope="col">{m.crm_col_tags()}</TableHead>
                <TableHead scope="col">{m.crm_col_owner()}</TableHead>
                <TableHead scope="col">{m.crm_col_member()}</TableHead>
                {canManage ? <TableHead scope="col">{m.common_actions()}</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((contact) => (
                <TableRow key={contact.id}>
                  <TableCell className="font-medium">
                    <Link
                      to="/admin/$"
                      params={{ _splat: `crm/contacts/${contact.id}` }}
                      className="text-primary underline underline-offset-4"
                    >
                      {contact.displayName}
                    </Link>
                  </TableCell>
                  <TableCell>{contact.email ?? m.crm_no_email()}</TableCell>
                  <TableCell>{orgName(contact)}</TableCell>
                  <TableCell>
                    {contact.tags.length === 0 ? (
                      m.crm_no_tags()
                    ) : (
                      <span className="flex flex-wrap gap-1">
                        {contact.tags.map((tag) => (
                          <Badge key={tag} variant="outline">
                            {tag}
                          </Badge>
                        ))}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <OwnerMark
                      name={
                        contact.ownerName ??
                        nameOfMembership(peopleOf(people), contact.ownerMembershipId)
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <Badge variant={contact.membershipId === null ? "outline" : "secondary"}>
                      {contact.membershipId === null
                        ? m.crm_member_not_linked()
                        : m.crm_member_linked()}
                    </Badge>
                  </TableCell>
                  {canManage ? (
                    <TableCell>
                      <div className="flex gap-1">
                        <ContactDialog contact={contact} organizations={orgs} />
                        <DeleteContactButton contact={contact} />
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
