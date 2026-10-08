import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  fieldAria,
  Input,
  toast,
} from "@fundroomhq/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useId, useMemo, useState } from "react";
import { isCode } from "../../lib/api.js";
import {
  createWorkspace,
  describePlatformError,
  errorField,
  PLATFORM_KEY,
  type PlatformWorkspaceCreate,
  platformCellsQuery,
  platformPlansQuery,
} from "../../lib/platform-queries.js";
import { countryOptions, isValidSlug, slugFromName } from "../../lib/signup-queries.js";
import { m } from "../../paraglide/messages.js";
import { getLocale } from "../../paraglide/runtime.js";
import { NativeSelect } from "../compliance/common.js";

/*
 * "New workspace" (E3.10): what `POST /platform/workspaces` needs — the address, the company
 * (legal name and country: the sanctions screen and invoicing use them), the owner's email (they
 * are invited, not signed up) and the plan. The cell defaults to the server's own; picking one
 * is for an install that runs several.
 *
 * Checked here before sending (so a typo costs no round trip) with the same rules the server
 * applies; what only the server can know — the slug is taken, the plan was archived meanwhile —
 * comes back as a sentence on the field it concerns.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const DEFAULT_CELL = "";
const NO_PLAN = "";

export function CreateWorkspaceForm({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const plans = useQuery(platformPlansQuery);
  const cells = useQuery(platformCellsQuery);
  const countries = useMemo(() => countryOptions(getLocale()), []);
  const ids = {
    name: useId(),
    slug: useId(),
    legal: useId(),
    country: useId(),
    owner: useId(),
    plan: useId(),
    cell: useId(),
  };
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [legalName, setLegalName] = useState("");
  const [country, setCountry] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [planId, setPlanId] = useState(NO_PLAN);
  const [cellId, setCellId] = useState(DEFAULT_CELL);
  const [submitted, setSubmitted] = useState(false);

  const create = useMutation({
    mutationFn: (body: PlatformWorkspaceCreate) => createWorkspace(body),
    onSuccess: (created) => {
      // Not seeded into the detail cache: a write answer carries `owners: []` (the detail GET
      // reads and audits them), so the page loads its own copy.
      void queryClient.invalidateQueries({ queryKey: [...PLATFORM_KEY, "workspaces", "list"] });
      toast.success(m.platform_create_done_toast({ name: created.name }));
      onDone();
      void navigate({ to: "/platform/workspaces/$id", params: { id: created.id } });
    },
  });

  // What the server said about one field (after a send), else what is wrong locally.
  const serverField = create.isError ? errorField(create.error) : undefined;
  const slugTaken = create.isError && isCode(create.error, "slug_taken");
  const invalid = {
    name: name.trim() === "",
    slug: !isValidSlug(slug),
    legal: legalName.trim() === "",
    country: country === "",
    owner: !EMAIL_RE.test(ownerEmail.trim()),
  };
  const errors = {
    name: submitted && invalid.name ? m.platform_create_name_invalid() : undefined,
    slug: slugTaken
      ? m.platform_create_slug_taken()
      : submitted && invalid.slug
        ? m.signup_slug_invalid()
        : undefined,
    legal: submitted && invalid.legal ? m.platform_create_legal_invalid() : undefined,
    country: submitted && invalid.country ? m.platform_create_country_invalid() : undefined,
    owner:
      (submitted && invalid.owner) || serverField === "ownerEmail"
        ? m.platform_create_owner_invalid()
        : undefined,
    plan: serverField === "planId" ? m.platform_create_plan_unavailable() : undefined,
    cell: serverField === "cellId" ? m.platform_create_cell_unavailable() : undefined,
  };
  // A refusal no field explains gets the console's shared sentence under the form.
  const onAField =
    slugTaken ||
    serverField === "ownerEmail" ||
    serverField === "planId" ||
    serverField === "cellId";
  const formError = create.isError && !onAField ? describePlatformError(create.error) : undefined;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (Object.values(invalid).some(Boolean) || create.isPending) return;
    create.mutate({
      slug,
      name: name.trim(),
      legalName: legalName.trim(),
      country,
      ownerEmail: ownerEmail.trim(),
      planId: planId === NO_PLAN ? null : planId,
      ...(cellId === DEFAULT_CELL ? {} : { cellId }),
    });
  };

  const planOptions = (plans.data?.plans ?? []).filter((p) => p.archivedAt === null);
  // E3.11: only cells in this database can take a new workspace from here (a remote cell
  // provisions its own).
  const cellOptions = (cells.data?.cells ?? []).filter((c) => c.local && c.status === "active");
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.platform_create_title()}</CardTitle>
        <CardDescription>{m.platform_create_body()}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-4"
          aria-label={m.platform_create_title()}
          onSubmit={submit}
          noValidate
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id={ids.name} label={m.common_name()} error={errors.name} required>
              <Input
                id={ids.name}
                value={name}
                maxLength={100}
                autoComplete="off"
                onChange={(e) => {
                  setName(e.target.value);
                  if (!slugEdited) setSlug(slugFromName(e.target.value));
                }}
                {...fieldAria(ids.name, { error: errors.name !== undefined })}
              />
            </Field>
            <Field
              id={ids.slug}
              label={m.platform_create_slug()}
              description={m.platform_create_slug_help()}
              error={errors.slug}
              required
            >
              <Input
                id={ids.slug}
                value={slug}
                maxLength={63}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                className="font-mono"
                onChange={(e) => {
                  setSlugEdited(true);
                  setSlug(e.target.value.toLowerCase());
                  if (slugTaken) create.reset();
                }}
                {...fieldAria(ids.slug, { description: true, error: errors.slug !== undefined })}
              />
            </Field>
            <Field
              id={ids.legal}
              label={m.platform_legal_name()}
              description={m.platform_create_legal_help()}
              error={errors.legal}
              required
            >
              <Input
                id={ids.legal}
                value={legalName}
                maxLength={200}
                autoComplete="off"
                onChange={(e) => setLegalName(e.target.value)}
                {...fieldAria(ids.legal, { description: true, error: errors.legal !== undefined })}
              />
            </Field>
            <Field id={ids.country} label={m.platform_country()} error={errors.country} required>
              <NativeSelect
                id={ids.country}
                value={country}
                onChange={(e) => setCountry(e.target.value)}
                {...fieldAria(ids.country, { error: errors.country !== undefined })}
              >
                <option value="">{m.signup_country_choose()}</option>
                {countries.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field
              id={ids.owner}
              label={m.platform_create_owner()}
              description={m.platform_create_owner_help()}
              error={errors.owner}
              required
            >
              <Input
                id={ids.owner}
                type="email"
                inputMode="email"
                autoComplete="off"
                value={ownerEmail}
                onChange={(e) => setOwnerEmail(e.target.value)}
                {...fieldAria(ids.owner, { description: true, error: errors.owner !== undefined })}
              />
            </Field>
            <Field id={ids.plan} label={m.platform_col_plan()} error={errors.plan}>
              <NativeSelect
                id={ids.plan}
                value={planId}
                disabled={plans.isPending}
                onChange={(e) => setPlanId(e.target.value)}
                {...fieldAria(ids.plan, { error: errors.plan !== undefined })}
              >
                <option value={NO_PLAN}>{m.platform_no_plan()}</option>
                {planOptions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field id={ids.cell} label={m.platform_col_cell()} error={errors.cell}>
              <NativeSelect
                id={ids.cell}
                value={cellId}
                disabled={cells.isPending}
                onChange={(e) => setCellId(e.target.value)}
                {...fieldAria(ids.cell, { error: errors.cell !== undefined })}
              >
                <option value={DEFAULT_CELL}>{m.platform_create_cell_default()}</option>
                {cellOptions.map((c) => (
                  <option key={c.id} value={c.id}>
                    {m.platform_cell_option({ id: c.id, region: c.region })}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </div>
          {formError === undefined ? null : (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" loading={create.isPending}>
              {m.platform_create_submit()}
            </Button>
            <Button type="button" variant="outline" onClick={onDone}>
              {m.common_cancel()}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
