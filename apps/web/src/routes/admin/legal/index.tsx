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
  Checkbox,
  Field,
  Input,
  Label,
  LoadingState,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  toast,
} from "@fundroomhq/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";
import { z } from "zod";
import {
  legalAudienceLabel,
  legalKindLabel,
  NativeSelect,
  OfferingStatusBadge,
  offeringStatusLabel,
  requiresConfirmation,
} from "../../../components/compliance/common.js";
import { ErrorAlert } from "../../../components/error-alert.js";
import { api, call, describeError } from "../../../lib/api.js";
import {
  type ComplianceSettings,
  type ConsentMode,
  complianceSettingsQuery,
  LEGAL_AUDIENCES,
  LEGAL_DOCUMENT_KINDS,
  type LegalAudience,
  type LegalDocumentKind,
  legalDocumentsQuery,
  legalTemplateQuery,
  legalTemplatesQuery,
  OFFERING_STATUSES,
  type OfferingChangeResult,
  type OfferingStatus,
  offeringQuery,
  PRIVACY_REGIONS,
  type PrivacyRegion,
} from "../../../lib/compliance-queries.js";
import { formatDateTime } from "../../../lib/format.js";
import { Markdown } from "../../../lib/markdown.js";
import { useBootstrap } from "../../../lib/queries.js";
import { useGuardedMutation } from "../../../lib/use-guarded-mutation.js";
import { m } from "../../../paraglide/messages.js";
import { DataRequestsArea } from "./-data-requests.js";

/*
 * E3.11: other screens link straight to a tab (the residency page to the settings, and to the
 * documents tab with the DPA template picked). Anything unrecognised is dropped, not an error.
 */
const searchSchema = z.object({
  tab: z.catch(z.optional(z.enum(["offering", "documents", "settings", "requests"])), undefined),
  template: z.catch(z.optional(z.string().max(64)), undefined),
});

export const Route = createFileRoute("/admin/legal/")({
  validateSearch: searchSchema,
  component: LegalPage,
});

/*
 * Legal & offering (E1.6, ADR-0037). Three areas behind one route: the offering mode with its
 * period history, the tenant's legal documents, and the workspace legal settings. The
 * "not legal advice" framing sits where the consequence is — the offering change and the
 * publish form — rather than on every card, where it would become wallpaper.
 */
function LegalPage() {
  const bootstrap = useBootstrap();
  const permissions = bootstrap.data?.permissions ?? [];
  const search = Route.useSearch();
  return (
    <div className="space-y-6">
      <PageHeader title={m.legal_title()} description={m.legal_subtitle()} />
      <Tabs defaultValue={search.tab ?? "offering"}>
        <TabsList aria-label={m.legal_tabs()}>
          <TabsTrigger value="offering">{m.legal_tab_offering()}</TabsTrigger>
          <TabsTrigger value="documents">{m.legal_tab_documents()}</TabsTrigger>
          <TabsTrigger value="settings">{m.legal_tab_settings()}</TabsTrigger>
          <TabsTrigger value="requests">{m.legal_tab_requests()}</TabsTrigger>
        </TabsList>
        <TabsContent value="offering">
          <OfferingArea canChange={permissions.includes("compliance.offering")} />
        </TabsContent>
        <TabsContent value="documents">
          <DocumentsArea
            canManage={permissions.includes("compliance.manage")}
            initialTemplate={search.template}
          />
        </TabsContent>
        <TabsContent value="settings">
          <SettingsArea canManage={permissions.includes("compliance.manage")} />
        </TabsContent>
        <TabsContent value="requests">
          <DataRequestsArea canManage={permissions.includes("compliance.manage")} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// --- offering mode -------------------------------------------------------------------------

function yesNo(value: boolean): string {
  return value ? m.common_yes() : m.common_no();
}

function OfferingArea({ canChange }: { canChange: boolean }) {
  const offering = useQuery(offeringQuery);
  if (offering.isPending) return <LoadingState lines={5} label={m.common_loading()} />;
  if (offering.isError) return <ErrorAlert error={offering.error} />;
  const state = offering.data;
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>{m.offering_current_title()}</CardTitle>
          <CardDescription>{m.offering_current_subtitle()}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
            <dt className="text-muted-foreground">{m.offering_field_mode()}</dt>
            <dd>
              <OfferingStatusBadge status={state.status} />
            </dd>
            <dt className="text-muted-foreground">{m.offering_field_since()}</dt>
            <dd>{formatDateTime(state.current.startedAt)}</dd>
            {state.current.reason === null ? null : (
              <>
                <dt className="text-muted-foreground">{m.offering_field_reason()}</dt>
                <dd>{state.current.reason}</dd>
              </>
            )}
          </dl>
          {/* The explanation is the server's, per status: restating it here would be a second
              place for the §11 table to go stale. */}
          <p>{state.permits.explanation}</p>
          {state.irrevocable ? (
            <Alert variant="warning">
              <AlertTitle>{m.offering_irrevocable_title()}</AlertTitle>
              <AlertDescription>{m.offering_irrevocable_body()}</AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{m.offering_permits_title()}</CardTitle>
          <CardDescription>{m.offering_permits_subtitle()}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{m.offering_field_mode()}</TableHead>
                  <TableHead>{m.offering_permit_round()}</TableHead>
                  <TableHead>{m.offering_permit_public()}</TableHead>
                  <TableHead>{m.offering_permit_links()}</TableHead>
                  <TableHead>{m.offering_permit_accreditation()}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {state.table.map((row) => (
                  <TableRow key={row.status}>
                    <TableCell>
                      {offeringStatusLabel(row.status)}
                      {row.status === state.status ? (
                        <Badge variant="secondary" className="ml-2">
                          {m.offering_current_badge()}
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell>{yesNo(row.roundAndTerms)}</TableCell>
                    <TableCell>{yesNo(row.publicSections)}</TableCell>
                    <TableCell>{yesNo(row.shareLinks)}</TableCell>
                    <TableCell>{yesNo(row.accreditationRequired)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {canChange ? (
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{m.offering_change_title()}</CardTitle>
            <CardDescription>{m.offering_change_subtitle()}</CardDescription>
          </CardHeader>
          <CardContent>
            {state.irrevocable ? (
              <p className="text-sm text-muted-foreground">{m.offering_change_locked()}</p>
            ) : (
              <OfferingChangeForm current={state.status} />
            )}
          </CardContent>
        </Card>
      ) : null}

      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>{m.offering_history_title()}</CardTitle>
          <CardDescription>{m.offering_history_subtitle()}</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{m.offering_field_mode()}</TableHead>
                <TableHead>{m.offering_col_from()}</TableHead>
                <TableHead>{m.offering_col_to()}</TableHead>
                <TableHead>{m.offering_field_reason()}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.history.map((period) => (
                <TableRow key={period.id}>
                  <TableCell>{offeringStatusLabel(period.status)}</TableCell>
                  <TableCell>{formatDateTime(period.startedAt)}</TableCell>
                  <TableCell>
                    {period.endedAt === null
                      ? m.offering_period_open()
                      : formatDateTime(period.endedAt)}
                  </TableCell>
                  <TableCell>{period.reason ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

interface ChangeVars {
  status: OfferingStatus;
  reason: string;
  confirm: boolean;
}

function OfferingChangeForm({ current }: { current: OfferingStatus }) {
  // Never offer a transition away from 506(c): the server refuses it outright, and an
  // affordance that always fails is worse than no affordance (ADR-0037 decision 2).
  const options = OFFERING_STATUSES.filter((s) => s !== current && current !== "506c");
  const [status, setStatus] = useState<OfferingStatus>(options[0] ?? current);
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState<OfferingStatus | null>(null);
  const statusId = useId();
  const reasonId = useId();
  const queryClient = useQueryClient();
  const change = useGuardedMutation<OfferingChangeResult, ChangeVars>({
    mutationFn: (v) =>
      call(
        api().PATCH("/compliance/offering", {
          body: {
            status: v.status,
            ...(v.reason === "" ? {} : { reason: v.reason }),
            ...(v.confirm ? { confirm: v.status } : {}),
          },
        }),
      ),
    onSuccess: (result) => {
      setConfirming(null);
      toast.success(m.offering_changed({ status: offeringStatusLabel(result.to) }));
      void queryClient.invalidateQueries({ queryKey: ["compliance"] });
      void queryClient.invalidateQueries({ queryKey: ["bootstrap"] });
    },
    onError: (error, variables) => {
      // The confirm round-trip: the server tells us what has to be confirmed, and the retry
      // echoes the status back in `confirm`.
      if (requiresConfirmation(error)) {
        setConfirming(variables.status);
        return;
      }
      toast.error(describeError(error).title);
    },
  });
  if (options.length === 0) return <p className="text-sm">{m.offering_change_locked()}</p>;
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        change.mutate({ status, reason: reason.trim(), confirm: false });
      }}
    >
      <div className="grid gap-4 md:grid-cols-2">
        <Field id={statusId} label={m.offering_field_new_mode()}>
          <NativeSelect
            id={statusId}
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as OfferingStatus);
              setConfirming(null);
            }}
          >
            {options.map((s) => (
              <option key={s} value={s}>
                {offeringStatusLabel(s)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field
          id={reasonId}
          label={m.offering_field_reason()}
          description={m.offering_reason_hint()}
        >
          <Input
            id={reasonId}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            aria-describedby={`${reasonId}-description`}
          />
        </Field>
      </div>
      {status === "506c" ? (
        // Said before the click, not after it: this is the whole point of decision 2.
        <Alert variant="warning">
          <AlertTitle>{m.offering_506c_warning_title()}</AlertTitle>
          <AlertDescription>{m.offering_506c_warning_body()}</AlertDescription>
        </Alert>
      ) : null}
      <Alert>
        <AlertTitle>{m.legal_not_advice_title()}</AlertTitle>
        <AlertDescription>{m.legal_not_advice_body()}</AlertDescription>
      </Alert>
      {confirming === null ? (
        <Button type="submit" loading={change.isPending}>
          {m.offering_change_submit()}
        </Button>
      ) : (
        <Alert variant="destructive">
          <AlertTitle>{m.offering_confirm_title()}</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>{m.offering_confirm_body({ status: offeringStatusLabel(confirming) })}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="destructive"
                loading={change.isPending}
                onClick={() =>
                  change.mutate({ status: confirming, reason: reason.trim(), confirm: true })
                }
              >
                {m.offering_confirm_submit()}
              </Button>
              <Button type="button" variant="outline" onClick={() => setConfirming(null)}>
                {m.common_cancel()}
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}
    </form>
  );
}

// --- legal documents -----------------------------------------------------------------------

function DocumentsArea({
  canManage,
  initialTemplate,
}: {
  canManage: boolean;
  initialTemplate?: string | undefined;
}) {
  const documents = useQuery(legalDocumentsQuery);
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{m.legal_documents_title()}</CardTitle>
          <CardDescription>{m.legal_documents_subtitle()}</CardDescription>
        </CardHeader>
        <CardContent>
          {documents.isPending ? <LoadingState lines={3} label={m.common_loading()} /> : null}
          {documents.isError ? <ErrorAlert error={documents.error} /> : null}
          {documents.data === undefined ? null : documents.data.documents.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">{m.legal_documents_empty()}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{m.legal_col_title()}</TableHead>
                  <TableHead>{m.legal_col_kind()}</TableHead>
                  <TableHead>{m.legal_col_audience()}</TableHead>
                  <TableHead>{m.legal_col_version()}</TableHead>
                  <TableHead>{m.legal_col_acceptance()}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {documents.data.documents.map((doc) => (
                  <TableRow key={doc.id}>
                    <TableCell>
                      <Link
                        to="/admin/legal/$documentId"
                        params={{ documentId: doc.id }}
                        className="font-medium underline-offset-4 hover:underline"
                      >
                        {doc.title}
                      </Link>
                      <div className="text-xs text-muted-foreground">
                        <code className="font-mono">{doc.slug}</code>
                      </div>
                    </TableCell>
                    <TableCell>{legalKindLabel(doc.kind)}</TableCell>
                    <TableCell>{legalAudienceLabel(doc.audience)}</TableCell>
                    <TableCell>
                      {doc.currentVersionNo === null
                        ? m.legal_unpublished()
                        : m.legal_version_no({ version: String(doc.currentVersionNo) })}
                    </TableCell>
                    <TableCell>{yesNo(doc.requiresAcceptance)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {canManage ? <CreateDocumentCard initialTemplate={initialTemplate} /> : null}
    </div>
  );
}

function CreateDocumentCard({ initialTemplate }: { initialTemplate?: string | undefined }) {
  const templates = useQuery(legalTemplatesQuery);
  const [from, setFrom] = useState("");
  const [slug, setSlug] = useState("");
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<LegalDocumentKind>("privacy_notice");
  const [audience, setAudience] = useState<LegalAudience>("external");
  const [requiresAcceptance, setRequiresAcceptance] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const preview = useQuery(legalTemplateQuery(showPreview ? from : ""));
  const base = useId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const create = useGuardedMutation({
    mutationFn: () =>
      call(
        api().POST("/compliance/documents", {
          body: {
            slug: slug.trim(),
            kind,
            audience,
            requiresAcceptance,
            ...(title.trim() === "" ? {} : { title: title.trim() }),
            ...(from === "" ? {} : { from }),
          },
        }),
      ),
    onSuccess: (created) => {
      toast.success(m.legal_document_created());
      void queryClient.invalidateQueries({ queryKey: ["compliance"] });
      void navigate({
        to: "/admin/legal/$documentId",
        params: { documentId: created.document.id },
      });
    },
    onError: (error) => toast.error(describeError(error).title),
  });
  const pickTemplate = (id: string) => {
    setFrom(id);
    setShowPreview(false);
    const picked = templates.data?.templates.find((t) => t.id === id);
    if (picked) {
      if (slug === "") setSlug(picked.id);
      if (title === "") setTitle(picked.title);
      setRequiresAcceptance(picked.requiresAcceptance);
    }
  };
  // A link that names a template (`?template=dpa`) picks it once the list has loaded.
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (seeded || initialTemplate === undefined || templates.data === undefined) return;
    setSeeded(true);
    const picked = templates.data.templates.find((t) => t.id === initialTemplate);
    if (picked === undefined) return;
    setFrom(picked.id);
    setSlug((s) => (s === "" ? picked.id : s));
    setTitle((t) => (t === "" ? picked.title : t));
    setRequiresAcceptance(picked.requiresAcceptance);
  }, [seeded, initialTemplate, templates.data]);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.legal_create_title()}</CardTitle>
        <CardDescription>{m.legal_create_subtitle()}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <div className="grid gap-4 md:grid-cols-2">
            <Field
              id={`${base}-from`}
              label={m.legal_field_template()}
              description={m.legal_field_template_hint()}
            >
              <NativeSelect
                id={`${base}-from`}
                value={from}
                aria-describedby={`${base}-from-description`}
                onChange={(e) => pickTemplate(e.target.value)}
              >
                <option value="">{m.legal_template_blank()}</option>
                {(templates.data?.templates ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field id={`${base}-slug`} label={m.legal_field_slug()} required>
              <Input
                id={`${base}-slug`}
                value={slug}
                required
                onChange={(e) => setSlug(e.target.value)}
              />
            </Field>
            <Field id={`${base}-title`} label={m.legal_field_title()}>
              <Input
                id={`${base}-title`}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </Field>
            <Field id={`${base}-kind`} label={m.legal_field_kind()}>
              <NativeSelect
                id={`${base}-kind`}
                value={kind}
                onChange={(e) => setKind(e.target.value as LegalDocumentKind)}
              >
                {LEGAL_DOCUMENT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {legalKindLabel(k)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field id={`${base}-audience`} label={m.legal_field_audience()}>
              <NativeSelect
                id={`${base}-audience`}
                value={audience}
                onChange={(e) => setAudience(e.target.value as LegalAudience)}
              >
                {LEGAL_AUDIENCES.map((a) => (
                  <option key={a} value={a}>
                    {legalAudienceLabel(a)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id={`${base}-accept`}
              checked={requiresAcceptance}
              onCheckedChange={(on) => setRequiresAcceptance(on === true)}
            />
            <Label htmlFor={`${base}-accept`}>{m.legal_field_requires_acceptance()}</Label>
          </div>
          {from === "" ? null : (
            <div className="space-y-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setShowPreview((v) => !v)}
              >
                {showPreview ? m.legal_preview_hide() : m.legal_preview_show()}
              </Button>
              {showPreview && preview.data ? (
                <div className="space-y-3 rounded-md border p-4 text-sm">
                  <Markdown source={preview.data.preview} />
                </div>
              ) : null}
            </div>
          )}
          <Alert>
            <AlertTitle>{m.legal_not_advice_title()}</AlertTitle>
            <AlertDescription>{m.legal_template_counsel_body()}</AlertDescription>
          </Alert>
          <Button type="submit" loading={create.isPending} disabled={slug.trim() === ""}>
            {m.legal_create_submit()}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

// --- workspace legal settings ---------------------------------------------------------------

function privacyRegionLabel(region: PrivacyRegion): string {
  switch (region) {
    case "eu":
      return m.legal_region_eu();
    case "uk":
      return m.legal_region_uk();
    case "us":
      return m.legal_region_us();
    case "other":
      return m.legal_region_other();
  }
}

function consentModeLabel(mode: ConsentMode): string {
  switch (mode) {
    case "opt_in":
      return m.consent_mode_opt_in();
    case "opt_out":
      return m.consent_mode_opt_out();
    case "notice_only":
      return m.consent_mode_notice_only();
  }
}

function SettingsArea({ canManage }: { canManage: boolean }) {
  const settings = useQuery(complianceSettingsQuery);
  const documents = useQuery(legalDocumentsQuery);
  if (settings.isPending) return <LoadingState lines={4} label={m.common_loading()} />;
  if (settings.isError) return <ErrorAlert error={settings.error} />;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.legal_settings_title()}</CardTitle>
        <CardDescription>{m.legal_settings_subtitle()}</CardDescription>
      </CardHeader>
      <CardContent>
        <SettingsForm
          settings={settings.data}
          disclaimers={(documents.data?.documents ?? []).filter((d) => d.kind === "disclaimer")}
          canManage={canManage}
        />
      </CardContent>
    </Card>
  );
}

function SettingsForm({
  settings,
  disclaimers,
  canManage,
}: {
  settings: ComplianceSettings;
  disclaimers: readonly { id: string; slug: string; title: string }[];
  canManage: boolean;
}) {
  const [consentMode, setConsentMode] = useState(settings.consentMode);
  // Untouched while the region changes, the mode is left out of the PATCH and the server sets
  // the region's suggestion (decision 4) — the browser never re-derives that table.
  const [consentTouched, setConsentTouched] = useState(false);
  const [region, setRegion] = useState<PrivacyRegion | "">(settings.privacyRegion ?? "");
  const [legalHold, setLegalHold] = useState(settings.legalHold);
  const [enforce, setEnforce] = useState(settings.enforceAcceptance);
  const [days, setDays] = useState(String(settings.relationshipWarningDays));
  const [disclaimer, setDisclaimer] = useState(settings.defaultDisclaimerSlug ?? "");
  const base = useId();
  const queryClient = useQueryClient();
  const regionChanged = (region === "" ? null : region) !== settings.privacyRegion;
  const sendMode = consentTouched || !regionChanged;
  const save = useGuardedMutation({
    mutationFn: () =>
      call(
        api().PATCH("/compliance/settings", {
          body: {
            ...(sendMode ? { consentMode } : {}),
            privacyRegion: region === "" ? null : region,
            legalHold,
            enforceAcceptance: enforce,
            relationshipWarningDays: Number(days),
            defaultDisclaimerSlug: disclaimer === "" ? null : disclaimer,
          },
        }),
      ),
    onSuccess: (saved) => {
      toast.success(m.legal_settings_saved());
      setConsentMode(saved.consentMode);
      setConsentTouched(false);
      queryClient.setQueryData(complianceSettingsQuery.queryKey, saved);
      void queryClient.invalidateQueries({ queryKey: ["compliance"] });
    },
    onError: (error) => toast.error(describeError(error).title),
  });
  const showSuggestion =
    settings.privacyRegion !== null &&
    !regionChanged &&
    consentMode !== settings.suggestedConsentMode;
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="grid gap-4 md:grid-cols-2">
        <Field
          id={`${base}-region`}
          label={m.legal_field_privacy_region()}
          description={m.legal_field_privacy_region_hint()}
        >
          <NativeSelect
            id={`${base}-region`}
            value={region}
            disabled={!canManage}
            aria-describedby={`${base}-region-description`}
            onChange={(e) => setRegion(e.target.value as PrivacyRegion | "")}
          >
            <option value="">{m.legal_region_none()}</option>
            {PRIVACY_REGIONS.map((r) => (
              <option key={r} value={r}>
                {privacyRegionLabel(r)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field
          id={`${base}-consent`}
          label={m.legal_field_consent_mode()}
          description={m.legal_field_consent_mode_hint()}
        >
          <NativeSelect
            id={`${base}-consent`}
            value={consentMode}
            disabled={!canManage}
            aria-describedby={`${base}-consent-description`}
            onChange={(e) => {
              setConsentMode(e.target.value as ConsentMode);
              setConsentTouched(true);
            }}
          >
            <option value="opt_in">{consentModeLabel("opt_in")}</option>
            <option value="opt_out">{consentModeLabel("opt_out")}</option>
            <option value="notice_only">{consentModeLabel("notice_only")}</option>
          </NativeSelect>
        </Field>
        {regionChanged && !consentTouched ? (
          <p className="text-sm text-muted-foreground md:col-span-2" role="status">
            {m.legal_region_will_suggest()}
          </p>
        ) : null}
        {settings.consentModeWeakerThanRegion && !regionChanged ? (
          <Alert variant="warning" className="md:col-span-2">
            <AlertTitle>{m.legal_consent_weaker_title()}</AlertTitle>
            <AlertDescription>
              {m.legal_consent_weaker_body({
                suggested: consentModeLabel(settings.suggestedConsentMode),
              })}
            </AlertDescription>
          </Alert>
        ) : null}
        {showSuggestion && canManage ? (
          <div className="flex flex-wrap items-center gap-2 text-sm md:col-span-2">
            <span>
              {m.legal_region_suggestion({
                suggested: consentModeLabel(settings.suggestedConsentMode),
              })}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setConsentMode(settings.suggestedConsentMode);
                setConsentTouched(true);
              }}
            >
              {m.legal_region_apply_suggestion()}
            </Button>
          </div>
        ) : null}
        <Field
          id={`${base}-days`}
          label={m.legal_field_warning_days()}
          description={m.legal_field_warning_days_hint()}
        >
          <Input
            id={`${base}-days`}
            type="number"
            min={0}
            max={3650}
            value={days}
            disabled={!canManage}
            aria-describedby={`${base}-days-description`}
            onChange={(e) => setDays(e.target.value)}
          />
        </Field>
        <Field
          id={`${base}-disclaimer`}
          label={m.legal_field_default_disclaimer()}
          description={m.legal_field_default_disclaimer_hint()}
          className="md:col-span-2"
        >
          <NativeSelect
            id={`${base}-disclaimer`}
            value={disclaimer}
            disabled={!canManage}
            aria-describedby={`${base}-disclaimer-description`}
            onChange={(e) => setDisclaimer(e.target.value)}
          >
            <option value="">{m.legal_disclaimer_none()}</option>
            {disclaimers.map((d) => (
              <option key={d.id} value={d.slug}>
                {d.title}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox
          id={`${base}-enforce`}
          checked={enforce}
          disabled={!canManage}
          onCheckedChange={(on) => setEnforce(on === true)}
        />
        <Label htmlFor={`${base}-enforce`}>{m.legal_field_enforce()}</Label>
      </div>
      <p className="text-sm text-muted-foreground">{m.legal_field_enforce_hint()}</p>
      <div className="flex items-center gap-2">
        <Checkbox
          id={`${base}-hold`}
          checked={legalHold}
          disabled={!canManage}
          onCheckedChange={(on) => setLegalHold(on === true)}
          aria-describedby={`${base}-hold-description`}
        />
        <Label htmlFor={`${base}-hold`}>{m.legal_field_legal_hold()}</Label>
      </div>
      <p id={`${base}-hold-description`} className="text-sm text-muted-foreground">
        {m.legal_field_legal_hold_hint()}
      </p>
      {canManage ? (
        <Button type="submit" loading={save.isPending}>
          {m.common_save()}
        </Button>
      ) : null}
    </form>
  );
}
