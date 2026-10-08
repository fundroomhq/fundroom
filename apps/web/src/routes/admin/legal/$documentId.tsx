import {
  Alert,
  AlertDescription,
  AlertTitle,
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
  Textarea,
  toast,
} from "@fundroomhq/ui";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Download } from "lucide-react";
import { useId, useState } from "react";
import { ConfirmDialog } from "../../../components/access/common.js";
import { CertificateButton } from "../../../components/compliance/certificate-button.js";
import {
  legalAudienceLabel,
  legalKindLabel,
  NativeSelect,
} from "../../../components/compliance/common.js";
import { ErrorAlert } from "../../../components/error-alert.js";
import { api, call, describeError } from "../../../lib/api.js";
import { downloadRegister } from "../../../lib/certificates.js";
import {
  acceptancesQuery,
  LEGAL_AUDIENCES,
  LEGAL_DOCUMENT_KINDS,
  type LegalAudience,
  type LegalCeremony,
  type LegalDocument,
  type LegalDocumentDetail,
  type LegalDocumentKind,
  legalDocumentQuery,
} from "../../../lib/compliance-queries.js";
import {
  ceremonyRefusal,
  esignConnectionQuery,
  esignErrorCode,
} from "../../../lib/esign-queries.js";
import { formatDate, formatDateTime } from "../../../lib/format.js";
import { Markdown } from "../../../lib/markdown.js";
import { useBootstrap } from "../../../lib/queries.js";
import { useGuardedMutation } from "../../../lib/use-guarded-mutation.js";
import { m } from "../../../paraglide/messages.js";

export const Route = createFileRoute("/admin/legal/$documentId")({ component: DocumentPage });

/*
 * One legal document: its metadata, the published versions (immutable — a change is a new
 * version, never an edit), and the register of who accepted which bytes. Publishing is the
 * moment a tenant puts a legal text in front of investors, so the counsel-review framing sits
 * on the publish form itself.
 */
function DocumentPage() {
  const { documentId } = Route.useParams();
  const detail = useQuery(legalDocumentQuery(documentId));
  const bootstrap = useBootstrap();
  const canManage = (bootstrap.data?.permissions ?? []).includes("compliance.manage");
  if (detail.isPending) return <LoadingState label={m.common_loading()} />;
  if (detail.isError) return <ErrorAlert error={detail.error} />;
  const { document: doc, current, versions } = detail.data;
  return (
    <div className="space-y-6">
      <PageHeader
        title={doc.title}
        description={doc.slug}
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link to="/admin/legal">
              <ArrowLeft aria-hidden="true" />
              {m.legal_back()}
            </Link>
          </Button>
        }
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{m.legal_metadata_title()}</CardTitle>
            <CardDescription>{m.legal_metadata_subtitle()}</CardDescription>
          </CardHeader>
          <CardContent>
            <MetadataForm doc={doc} canManage={canManage} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{m.legal_current_version_title()}</CardTitle>
            <CardDescription>
              {current === null
                ? m.legal_unpublished()
                : m.legal_current_version_subtitle({
                    version: String(current.versionNo),
                    date: formatDate(current.effectiveAt),
                  })}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {current === null ? (
              <p className="text-muted-foreground">{m.legal_no_version_body()}</p>
            ) : (
              <>
                <div className="max-h-72 space-y-3 overflow-y-auto rounded-md border p-4">
                  <Markdown source={current.body} />
                </div>
                <p className="text-xs text-muted-foreground">
                  {m.legal_sha({ sha: current.bodySha256.slice(0, 16) })}
                </p>
              </>
            )}
          </CardContent>
        </Card>

        {canManage ? (
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>{m.legal_publish_title()}</CardTitle>
              <CardDescription>{m.legal_publish_subtitle()}</CardDescription>
            </CardHeader>
            <CardContent>
              <PublishForm detail={detail.data} />
            </CardContent>
          </Card>
        ) : null}

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{m.legal_versions_title()}</CardTitle>
            <CardDescription>{m.legal_versions_subtitle()}</CardDescription>
          </CardHeader>
          <CardContent>
            {versions.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">{m.legal_no_version_body()}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{m.legal_col_version()}</TableHead>
                    <TableHead>{m.legal_col_published()}</TableHead>
                    <TableHead>{m.legal_col_effective()}</TableHead>
                    <TableHead>{m.legal_col_source()}</TableHead>
                    <TableHead>{m.legal_col_summary()}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {versions.map((v) => (
                    <TableRow key={v.id}>
                      <TableCell>{m.legal_version_no({ version: String(v.versionNo) })}</TableCell>
                      <TableCell>{formatDateTime(v.publishedAt)}</TableCell>
                      <TableCell>{formatDate(v.effectiveAt)}</TableCell>
                      <TableCell>
                        {v.source === "template"
                          ? m.legal_source_template()
                          : m.legal_source_custom()}
                      </TableCell>
                      <TableCell>{v.summary ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{m.legal_register_title()}</CardTitle>
            <CardDescription>{m.legal_register_subtitle()}</CardDescription>
          </CardHeader>
          <CardContent>
            <AcceptanceRegister documentId={doc.id} />
          </CardContent>
        </Card>

        {canManage ? (
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>{m.legal_delete_title()}</CardTitle>
              <CardDescription>{m.legal_delete_subtitle()}</CardDescription>
            </CardHeader>
            <CardContent>
              <DeleteDocument doc={doc} />
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  );
}

function MetadataForm({ doc, canManage }: { doc: LegalDocument; canManage: boolean }) {
  const [title, setTitle] = useState(doc.title);
  const [kind, setKind] = useState<LegalDocumentKind>(doc.kind);
  const [audience, setAudience] = useState<LegalAudience>(doc.audience);
  const [requiresAcceptance, setRequiresAcceptance] = useState(doc.requiresAcceptance);
  const [ceremony, setCeremony] = useState<LegalCeremony>(doc.ceremony);
  const base = useId();
  const queryClient = useQueryClient();
  const save = useGuardedMutation({
    mutationFn: () =>
      call(
        api().PATCH("/compliance/documents/{id}", {
          params: { path: { id: doc.id } },
          body: {
            title,
            kind,
            audience,
            requiresAcceptance,
            ...(ceremony === doc.ceremony ? {} : { ceremony }),
          },
        }),
      ),
    onSuccess: () => {
      toast.success(m.legal_metadata_saved());
      void queryClient.invalidateQueries({ queryKey: ["compliance"] });
    },
    onError: (error) => toast.error(ceremonyRefusal(error) ?? describeError(error).title),
  });
  const refusal = save.isError ? ceremonyRefusal(save.error) : undefined;
  if (!canManage) {
    return (
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
        <dt className="text-muted-foreground">{m.legal_field_kind()}</dt>
        <dd>{legalKindLabel(doc.kind)}</dd>
        <dt className="text-muted-foreground">{m.legal_field_audience()}</dt>
        <dd>{legalAudienceLabel(doc.audience)}</dd>
        <dt className="text-muted-foreground">{m.legal_ceremony()}</dt>
        <dd>
          {doc.ceremony === "esign" ? m.legal_ceremony_esign() : m.legal_ceremony_clickwrap()}
        </dd>
      </dl>
    );
  }
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Field id={`${base}-title`} label={m.legal_field_title()}>
        <Input id={`${base}-title`} value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <div className="grid gap-4 md:grid-cols-2">
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
      <CeremonyField
        name={`${base}-ceremony`}
        value={ceremony}
        saved={doc.ceremony}
        kind={kind}
        onChange={setCeremony}
      />
      {refusal === undefined ? null : (
        <Alert variant="destructive" role="alert">
          <AlertTitle>{m.legal_ceremony_refused()}</AlertTitle>
          <AlertDescription>
            <p>
              {refusal}
              {esignErrorCode(save.error) === "esign_not_configured" ? (
                <>
                  {" "}
                  <Link to="/admin/esign" className="font-medium underline underline-offset-4">
                    {m.legal_ceremony_connect()}
                  </Link>
                </>
              ) : null}
            </p>
          </AlertDescription>
        </Alert>
      )}
      <Button type="submit" variant="outline" loading={save.isPending}>
        {m.common_save()}
      </Button>
    </form>
  );
}

/**
 * How a member accepts this document (E3.5, ADR-0053): click-wrap (tick a box; we keep the
 * evidence) or e-signature at the connected vendor (the NDA gate stays closed until the signed
 * copy is collected). E-signature needs a connected vendor — the server refuses it otherwise
 * (409 `esign_not_configured`), so the option is disabled with a link to where one is connected.
 * The legal note is design/03 B4's: a click-wrap acceptance is evidence of assent, not a signed
 * NDA, and a founder choosing between the two should be told so where they choose.
 */
function CeremonyField({
  name,
  value,
  saved,
  kind,
  onChange,
}: {
  name: string;
  value: LegalCeremony;
  saved: LegalCeremony;
  /** Only an NDA is signed electronically; the server refuses the ceremony on anything else. */
  kind: LegalDocumentKind;
  onChange: (next: LegalCeremony) => void;
}) {
  const bootstrap = useBootstrap();
  const canReadESign = (bootstrap.data?.permissions ?? []).includes("esign.read");
  const connection = useQuery({ ...esignConnectionQuery, enabled: canReadESign });
  const vendor = connection.data?.connection ?? null;
  // Unknown (no `esign.read`, or still loading) is not "not connected": the server decides then.
  const notConnected = connection.data !== undefined && vendor === null;
  const notNda = kind !== "nda";
  const esignDisabled = (notConnected || notNda) && saved !== "esign";
  const options: { value: LegalCeremony; label: string; hint: string; disabled: boolean }[] = [
    {
      value: "clickwrap",
      label: m.legal_ceremony_clickwrap(),
      hint: m.legal_ceremony_clickwrap_hint(),
      disabled: false,
    },
    {
      value: "esign",
      label: m.legal_ceremony_esign(),
      hint:
        vendor === null
          ? m.legal_ceremony_esign_hint()
          : m.legal_ceremony_esign_hint_vendor({ vendor: vendor.displayName }),
      disabled: esignDisabled,
    },
  ];
  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-medium">{m.legal_ceremony()}</legend>
      {options.map((option) => {
        const id = `${name}-${option.value}`;
        return (
          <div key={option.value} className="flex items-start gap-2">
            <input
              id={id}
              type="radio"
              name={name}
              className="mt-1"
              value={option.value}
              checked={value === option.value}
              disabled={option.disabled}
              aria-describedby={`${id}-hint`}
              onChange={() => onChange(option.value)}
            />
            <div className="grid gap-0.5">
              <Label htmlFor={id}>{option.label}</Label>
              <p id={`${id}-hint`} className="text-xs text-muted-foreground">
                {option.hint}
              </p>
            </div>
          </div>
        );
      })}
      {notNda ? (
        <p className="text-sm text-muted-foreground">{m.legal_ceremony_nda_only()}</p>
      ) : esignDisabled ? (
        <p className="text-sm text-muted-foreground">
          {m.legal_ceremony_needs_vendor()}{" "}
          <Link to="/admin/esign" className="font-medium underline underline-offset-4">
            {m.legal_ceremony_connect()}
          </Link>
        </p>
      ) : null}
      <Alert>
        <AlertTitle>{m.legal_ceremony_note_title()}</AlertTitle>
        <AlertDescription>{m.legal_ceremony_note_body()}</AlertDescription>
      </Alert>
    </fieldset>
  );
}

function PublishForm({ detail }: { detail: LegalDocumentDetail }) {
  const [body, setBody] = useState(detail.current?.body ?? "");
  const [summary, setSummary] = useState("");
  const [preview, setPreview] = useState(false);
  const base = useId();
  const queryClient = useQueryClient();
  const publish = useGuardedMutation({
    mutationFn: () =>
      call(
        api().POST("/compliance/documents/{id}/versions", {
          params: { path: { id: detail.document.id } },
          body: { body, ...(summary.trim() === "" ? {} : { summary: summary.trim() }) },
        }),
      ),
    onSuccess: (result) => {
      // Republishing an identical body is a no-op on the server: say so rather than claiming
      // a version nobody got.
      toast.success(
        result.published
          ? m.legal_published({ version: String(result.version.versionNo) })
          : m.legal_publish_unchanged(),
      );
      setSummary("");
      void queryClient.invalidateQueries({ queryKey: ["compliance"] });
    },
    onError: (error) => toast.error(ceremonyRefusal(error) ?? describeError(error).title),
  });
  const refusal = publish.isError ? ceremonyRefusal(publish.error) : undefined;
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        publish.mutate();
      }}
    >
      {refusal === undefined ? null : (
        <Alert variant="destructive" role="alert">
          <AlertTitle>{m.legal_publish_refused()}</AlertTitle>
          <AlertDescription>{refusal}</AlertDescription>
        </Alert>
      )}
      <Field
        id={`${base}-body`}
        label={m.legal_field_body()}
        description={m.legal_field_body_hint()}
      >
        <Textarea
          id={`${base}-body`}
          rows={16}
          value={body}
          className="font-mono text-xs"
          aria-describedby={`${base}-body-description`}
          onChange={(e) => setBody(e.target.value)}
        />
      </Field>
      <Field id={`${base}-summary`} label={m.legal_field_summary()}>
        <Input
          id={`${base}-summary`}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
        />
      </Field>
      <Button type="button" variant="outline" size="sm" onClick={() => setPreview((v) => !v)}>
        {preview ? m.legal_preview_hide() : m.legal_preview_show()}
      </Button>
      {preview ? (
        <section
          className="space-y-3 rounded-md border p-4 text-sm"
          aria-label={m.legal_preview_label()}
        >
          <Markdown source={body} />
        </section>
      ) : null}
      {/* This is the screen where a founder puts a legal text in front of investors. */}
      <Alert>
        <AlertTitle>{m.legal_not_advice_title()}</AlertTitle>
        <AlertDescription>{m.legal_publish_counsel_body()}</AlertDescription>
      </Alert>
      <Button type="submit" loading={publish.isPending} disabled={body.trim() === ""}>
        {m.legal_publish_submit()}
      </Button>
    </form>
  );
}

function AcceptanceRegister({ documentId }: { documentId: string }) {
  const register = useInfiniteQuery(acceptancesQuery({ documentId }));
  /*
   * The export is the file counsel is handed (design/04 §1.6, §7) and the certificate is the
   * evidence for one signature. Both are authenticated reads that return bytes, so both go
   * through `lib/certificates.ts` rather than a link: see that file for why.
   */
  const exportCsv = useMutation({
    mutationFn: () => downloadRegister({ documentId }, "csv"),
    onError: (error) => toast.error(describeError(error).body),
  });
  if (register.isPending) return <LoadingState lines={3} label={m.common_loading()} />;
  if (register.isError) return <ErrorAlert error={register.error} />;
  const items = register.data.pages.flatMap((page) => page.items);
  if (items.length === 0)
    return <p className="py-4 text-sm text-muted-foreground">{m.legal_register_empty()}</p>;
  return (
    <div className="space-y-3">
      <Button
        type="button"
        variant="outline"
        size="sm"
        loading={exportCsv.isPending}
        onClick={() => exportCsv.mutate()}
      >
        <Download aria-hidden="true" />
        {m.legal_register_export()}
      </Button>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{m.legal_col_who()}</TableHead>
            <TableHead>{m.legal_col_version()}</TableHead>
            <TableHead>{m.legal_col_accepted()}</TableHead>
            <TableHead>{m.legal_col_evidence()}</TableHead>
            <TableHead>{m.legal_col_certificate()}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((entry) => (
            <TableRow key={`${entry.membershipId}-${entry.stamp}`}>
              <TableCell>
                {entry.displayName}
                {entry.email === null ? null : (
                  <div className="text-xs text-muted-foreground">{entry.email}</div>
                )}
              </TableCell>
              <TableCell>{m.legal_version_no({ version: String(entry.versionNo) })}</TableCell>
              <TableCell>{formatDateTime(entry.acceptedAt)}</TableCell>
              <TableCell>
                <code className="font-mono text-xs">
                  {entry.bodySha256 === null ? "—" : entry.bodySha256.slice(0, 16)}
                </code>
              </TableCell>
              <TableCell>
                {/* No `evidenceRef` means no certificate was stored for that acceptance —
                    every acceptance recorded before E2.3, and any recorded while the issuer
                    was unwired. Offering a button that can only 404 would be worse. */}
                {entry.evidenceRef === null ? (
                  <span className="text-xs text-muted-foreground">{m.certificate_none()}</span>
                ) : (
                  <CertificateButton membershipId={entry.membershipId} stamp={entry.stamp} />
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {register.hasNextPage ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          loading={register.isFetchingNextPage}
          onClick={() => void register.fetchNextPage()}
        >
          {m.common_load_more()}
        </Button>
      ) : null}
    </div>
  );
}

function DeleteDocument({ doc }: { doc: LegalDocument }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const remove = useGuardedMutation({
    mutationFn: () =>
      call(api().DELETE("/compliance/documents/{id}", { params: { path: { id: doc.id } } })),
    onSuccess: () => {
      toast.success(m.legal_deleted());
      void queryClient.invalidateQueries({ queryKey: ["compliance"] });
      void navigate({ to: "/admin/legal" });
    },
    onError: (error) => toast.error(describeError(error).title),
  });
  return (
    <ConfirmDialog
      trigger={
        <Button type="button" variant="destructive">
          {m.legal_delete_submit()}
        </Button>
      }
      title={m.legal_delete_confirm_title({ title: doc.title })}
      description={m.legal_delete_confirm_body()}
      confirmLabel={m.legal_delete_submit()}
      pending={remove.isPending}
      onConfirm={() => remove.mutate()}
    />
  );
}
