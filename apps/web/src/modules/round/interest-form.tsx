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
  Field,
  fieldAria,
  Input,
  Textarea,
  toast,
} from "@fundroomhq/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Upload } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { ConfirmDialog } from "../../components/access/common.js";
import { ErrorAlert } from "../../components/error-alert.js";
import { call } from "../../lib/api.js";
import { formatDateTime } from "../../lib/format.js";
import {
  type AccreditationDocument,
  api,
  type EligibilityCategory,
  EVIDENCE_CONTENT_TYPES,
  EVIDENCE_MAX_BYTES,
  type InterestBody,
  type InterestSubmission,
  isDecimal,
  type Round,
  type RoundOfferingStatus,
  roundEligibilityQuery,
  type Subject,
  uploadEvidence,
} from "../../lib/round-queries.js";
import { useGuardedMutation } from "../../lib/use-guarded-mutation.js";
import { m } from "../../paraglide/messages.js";
import { formatMoney, interestStatusLabel, interestStatusVariant, pathLabel } from "./format.js";

/*
 * The interest form (design/03 E2, contract §W). "Indicate interest" — never "invest", never
 * "subscribe": nothing here is an offer to sell, and no payment instruction appears anywhere
 * before an admin has accepted (plan §15).
 *
 * The one rule that shapes the whole component: **the browser never decides the accreditation
 * path** (contract §D4). Amount and subject go to `GET /round/current/eligibility`, and the
 * answer — the path, whether a questionnaire is asked, which categories it contains, and
 * whether the minimum-investment safe harbour applies — comes back from the server, which is
 * also the thing that will enforce it. A second implementation of that rule in the browser
 * would be a second rule, and the two would eventually disagree about whether somebody had to
 * be verified.
 *
 * The request is debounced rather than sent per keystroke: the path can change mid-number
 * ("2" → "20" → "200000"), and a person watching the copy change three times while typing one
 * figure would reasonably conclude the screen was guessing.
 *
 * `non_us` gets no US prompts at all — no questionnaire, no representations, no mention of
 * accreditation (design/03:185). That is why every one of those sections is rendered from the
 * server's answer instead of from a status check here.
 */

const DEBOUNCE_MS = 400;

interface FormState {
  readonly amount: string;
  readonly subject: Subject;
  readonly entityName: string;
  readonly note: string;
  readonly categories: readonly string[];
  readonly noneApply: boolean;
  readonly sophistication: string;
  readonly repAccredited: boolean;
  readonly repNotFinanced: boolean;
  readonly consent: boolean;
}

const EMPTY: FormState = {
  amount: "",
  subject: "individual",
  entityName: "",
  note: "",
  categories: [],
  noneApply: false,
  sophistication: "",
  repAccredited: false,
  repNotFinanced: false,
  consent: false,
};

function forSubject(
  categories: readonly EligibilityCategory[],
  subject: Subject,
): readonly EligibilityCategory[] {
  return categories.filter((c) => c.subjects === undefined || c.subjects.includes(subject));
}

function pathExplanation(path: string): string {
  switch (path) {
    case "self_attested":
      return m.round_path_explain_self_attested();
    case "self_certified":
      return m.round_path_explain_self_certified();
    case "verification_required":
      return m.round_path_explain_verification_required();
    default:
      return m.round_path_explain_none();
  }
}

/**
 * The evidence upload (`PUT /round/verifications/{id}/evidence`).
 *
 * A raw route with the bytes as the body, so this is a plain `fetch` rather than the typed
 * client. The type and size are checked before anything is sent — not as a security control
 * (the server checks again, and it is the one that counts) but so a person with a 40 MB scan
 * is told so immediately instead of after the upload.
 */
export function EvidenceUpload({ verificationId }: { verificationId: string }) {
  const inputId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const upload = useGuardedMutation({
    mutationFn: () => {
      if (file === null) throw new Error("no file");
      return uploadEvidence(verificationId, file);
    },
    onSuccess: () => {
      toast.success(m.round_evidence_uploaded());
      setFile(null);
      void queryClient.invalidateQueries({ queryKey: ["round"] });
    },
  });
  return (
    <div className="space-y-3 rounded-lg border p-4">
      <h3 className="text-sm font-medium">{m.round_evidence_title()}</h3>
      <p className="text-sm text-muted-foreground">{m.round_evidence_hint()}</p>
      <Field id={inputId} label={m.round_evidence_choose()} description={m.round_evidence_types()}>
        <input
          id={inputId}
          type="file"
          accept={EVIDENCE_CONTENT_TYPES.join(",")}
          className="block w-full text-sm"
          onChange={(e) => {
            const picked = e.target.files?.[0] ?? null;
            if (picked === null) {
              setFile(null);
              setProblem(null);
              return;
            }
            if (picked.size > EVIDENCE_MAX_BYTES) {
              setFile(null);
              setProblem(m.round_evidence_too_large());
              return;
            }
            if (picked.type !== "" && !EVIDENCE_CONTENT_TYPES.includes(picked.type as never)) {
              setFile(null);
              setProblem(m.round_evidence_bad_type());
              return;
            }
            setProblem(null);
            setFile(picked);
          }}
          {...fieldAria(inputId, { description: true })}
        />
      </Field>
      {problem === null ? null : (
        <p role="alert" className="text-sm font-medium text-destructive">
          {problem}
        </p>
      )}
      <ErrorAlert error={upload.error} />
      <Button
        type="button"
        loading={upload.isPending}
        disabled={file === null}
        onClick={() => upload.mutate()}
      >
        <Upload aria-hidden="true" />
        {m.round_evidence_upload()}
      </Button>
    </div>
  );
}

export function InterestForm({
  round,
  accreditationDocument,
  offeringStatus,
}: {
  round: Round;
  accreditationDocument: AccreditationDocument | null;
  offeringStatus: RoundOfferingStatus;
}) {
  const ids = {
    amount: useId(),
    entity: useId(),
    note: useId(),
    sophistication: useId(),
    consent: useId(),
    none: useId(),
  };
  const [form, setForm] = useState<FormState>(EMPTY);
  const [debounced, setDebounced] = useState("");
  const [sent, setSent] = useState<InterestSubmission | null>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    const trimmed = form.amount.trim();
    const timer = setTimeout(() => setDebounced(isDecimal(trimmed) ? trimmed : ""), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [form.amount]);

  const eligibility = useQuery(roundEligibilityQuery(form.subject, debounced));
  const view = eligibility.data;
  const categories = forSubject(view?.categories ?? [], form.subject);
  // Narrowed rather than tested twice: the representations block reads `threshold`.
  const reps = view !== undefined && view.path === "self_certified" ? view : undefined;
  const needsReps = reps !== undefined;
  const needsSophistication = view?.path === "self_attested" && form.noneApply;

  const submit = useGuardedMutation({
    mutationFn: () => {
      const body: InterestBody = {
        amount: form.amount.trim(),
        subject: form.subject,
        consentToElectronicRecords: form.consent,
        ...(form.subject === "entity" && form.entityName.trim() !== ""
          ? { entityName: form.entityName.trim() }
          : {}),
        ...(form.note.trim() === "" ? {} : { note: form.note.trim() }),
        ...(view?.questionnaire === true
          ? {
              accreditation: {
                categories: form.noneApply ? [] : form.categories,
                section: "us",
                ...(form.sophistication.trim() === "" ? {} : { note: form.sophistication.trim() }),
                ...(view.questionnaireVersion === null
                  ? {}
                  : { questionnaireVersion: view.questionnaireVersion }),
              },
            }
          : {}),
        ...(needsReps
          ? {
              representations: {
                accredited: form.repAccredited,
                notThirdPartyFinanced: form.repNotFinanced,
              },
            }
          : {}),
      };
      return call(api().POST<InterestSubmission>("/round/current/interest", { body }));
    },
    onSuccess: (submission) => {
      toast.success(m.round_interest_sent());
      setSent(submission);
      setForm(EMPTY);
      void queryClient.invalidateQueries({ queryKey: ["round"] });
    },
  });

  if (sent !== null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CheckCircle2 aria-hidden="true" className="size-5 text-success" />
            {m.round_interest_submitted_title()}
          </CardTitle>
          <CardDescription>{m.round_interest_submitted_body()}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm">{pathExplanation(sent.accreditationPath)}</p>
          {/*
           * How the verification continues (evidence upload, a vendor's email, a vendor link)
           * is the verification card's job: it reads the server's `handoff`, and a vendor row
           * must never be offered an upload.
           */}
          {sent.verificationId === null ? null : (
            <p className="text-sm">{m.round_myverif_see_card()}</p>
          )}
          <Button type="button" variant="outline" onClick={() => setSent(null)}>
            {m.round_interest_another()}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const repsSatisfied = !needsReps || (form.repAccredited && form.repNotFinanced);
  const canSubmit =
    isDecimal(form.amount.trim()) &&
    Number(form.amount.trim()) > 0 &&
    form.consent &&
    repsSatisfied;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.round_interest_title()}</CardTitle>
        <CardDescription>{m.round_interest_subtitle()}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-6"
          onSubmit={(e) => {
            e.preventDefault();
            submit.mutate();
          }}
        >
          <Field
            id={ids.amount}
            label={m.round_interest_amount({ currency: round.currency })}
            description={
              round.minimumInvestment === null
                ? m.round_interest_amount_hint()
                : m.round_interest_amount_minimum({
                    amount: formatMoney(round.minimumInvestment, round.currency),
                  })
            }
            required
          >
            <Input
              id={ids.amount}
              type="text"
              inputMode="decimal"
              autoComplete="off"
              className="max-w-48 tabular-nums"
              value={form.amount}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
              {...fieldAria(ids.amount, { description: true })}
            />
          </Field>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{m.round_interest_subject()}</legend>
            <div className="flex flex-wrap gap-4">
              {(["individual", "entity"] as const).map((subject) => (
                <label key={subject} className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="round-interest-subject"
                    value={subject}
                    checked={form.subject === subject}
                    onChange={() => setForm({ ...form, subject, categories: [] })}
                  />
                  {subject === "individual"
                    ? m.round_subject_individual()
                    : m.round_subject_entity()}
                </label>
              ))}
            </div>
          </fieldset>

          {form.subject === "entity" ? (
            <Field
              id={ids.entity}
              label={m.round_interest_entity_name()}
              description={m.round_interest_entity_name_hint()}
            >
              <Input
                id={ids.entity}
                value={form.entityName}
                maxLength={200}
                onChange={(e) => setForm({ ...form, entityName: e.target.value })}
                {...fieldAria(ids.entity, { description: true })}
              />
            </Field>
          ) : null}

          {view === undefined ? null : (
            <Alert>
              <AlertTitle>{pathLabel(view.path)}</AlertTitle>
              <AlertDescription>
                <p>{view.reason}</p>
                <p>{pathExplanation(view.path)}</p>
              </AlertDescription>
            </Alert>
          )}

          {view?.questionnaire === true && categories.length > 0 ? (
            <fieldset className="space-y-3">
              <legend className="text-sm font-medium">{m.round_questionnaire_legend()}</legend>
              <p className="text-sm text-muted-foreground">{m.round_questionnaire_hint()}</p>
              <div className="space-y-2">
                {categories.map((category) => (
                  <label key={category.key} className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={form.categories.includes(category.key)}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          noneApply: false,
                          categories: e.target.checked
                            ? [...form.categories, category.key]
                            : form.categories.filter((k) => k !== category.key),
                        })
                      }
                    />
                    <span>{category.label}</span>
                  </label>
                ))}
                {/*
                 * "None of these apply" is a deliberate answer, not the absence of one
                 * (`packages/compliance` accreditation.ts:171): under 506(b) a non-accredited
                 * but sophisticated purchaser is allowed, and the company has to be able to
                 * count them. So it is ticked, and ticking it clears the rest.
                 */}
                <label htmlFor={ids.none} className="flex items-start gap-2 text-sm font-medium">
                  <input
                    id={ids.none}
                    type="checkbox"
                    className="mt-1"
                    checked={form.noneApply}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        noneApply: e.target.checked,
                        categories: e.target.checked ? [] : form.categories,
                      })
                    }
                  />
                  <span>{m.round_questionnaire_none()}</span>
                </label>
              </div>
            </fieldset>
          ) : null}

          {needsSophistication ? (
            <Field
              id={ids.sophistication}
              label={m.round_questionnaire_note()}
              description={m.round_questionnaire_note_hint()}
            >
              <Textarea
                id={ids.sophistication}
                rows={3}
                maxLength={4000}
                value={form.sophistication}
                onChange={(e) => setForm({ ...form, sophistication: e.target.value })}
                {...fieldAria(ids.sophistication, { description: true })}
              />
            </Field>
          ) : null}

          {reps === undefined ? null : (
            <fieldset className="space-y-3">
              <legend className="text-sm font-medium">{m.round_reps_legend()}</legend>
              <p className="text-sm text-muted-foreground">
                {m.round_reps_hint({
                  amount:
                    reps.threshold === undefined
                      ? ""
                      : formatMoney(reps.threshold.amount, reps.threshold.currency),
                })}
              </p>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  required
                  checked={form.repAccredited}
                  onChange={(e) => setForm({ ...form, repAccredited: e.target.checked })}
                />
                <span>{m.round_reps_accredited()}</span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  required
                  checked={form.repNotFinanced}
                  onChange={(e) => setForm({ ...form, repNotFinanced: e.target.checked })}
                />
                <span>{m.round_reps_not_financed()}</span>
              </label>
            </fieldset>
          )}

          <Field
            id={ids.note}
            label={m.round_interest_note()}
            description={m.round_interest_note_hint()}
          >
            <Textarea
              id={ids.note}
              rows={3}
              maxLength={4000}
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
              {...fieldAria(ids.note, { description: true })}
            />
          </Field>

          {/*
           * Consent to electronic records, naming the document and version being certified
           * against — the click-wrap evidence the acceptance service stores alongside the two
           * attestation rows (ADR-0041 §8). It names the version because "I agreed to some
           * earlier draft" is the thing a stamp exists to answer.
           */}
          <label htmlFor={ids.consent} className="flex items-start gap-2 text-sm">
            <input
              id={ids.consent}
              type="checkbox"
              className="mt-1"
              required
              checked={form.consent}
              onChange={(e) => setForm({ ...form, consent: e.target.checked })}
            />
            <span>
              {accreditationDocument === null
                ? m.round_consent_plain()
                : m.round_consent_label({
                    document: accreditationDocument.title,
                    version: String(accreditationDocument.versionNo),
                  })}
            </span>
          </label>

          <ErrorAlert error={submit.error} />
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" loading={submit.isPending} disabled={!canSubmit}>
              {m.round_interest_submit()}
            </Button>
            <p className="text-sm text-muted-foreground">
              {offeringStatus === "non_us"
                ? m.round_interest_not_offer_neutral()
                : m.round_interest_not_offer()}
            </p>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export function MySubmissions({
  submissions,
  currency,
}: {
  submissions: readonly InterestSubmission[];
  currency: string;
}) {
  const queryClient = useQueryClient();
  const withdraw = useGuardedMutation({
    mutationFn: (id: string) =>
      call(
        api().POST<InterestSubmission>("/round/current/interest/{id}/withdraw", {
          params: { path: { id } },
        }),
      ),
    onSuccess: () => {
      toast.success(m.round_withdrawn());
      void queryClient.invalidateQueries({ queryKey: ["round"] });
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.round_my_submissions_title()}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <ErrorAlert error={withdraw.error} />
        {submissions.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m.round_my_submissions_empty()}</p>
        ) : (
          <ul className="list-none space-y-3">
            {submissions.map((submission) => (
              <li key={submission.id} className="space-y-2 rounded-lg border p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium tabular-nums">
                    {formatMoney(submission.amount, submission.currency || currency)}
                  </span>
                  <Badge variant={interestStatusVariant(submission.status)}>
                    {interestStatusLabel(submission.status)}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {formatDateTime(submission.createdAt)}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground">
                  {pathExplanation(submission.accreditationPath)}
                </p>
                {submission.status === "submitted" ? (
                  <ConfirmDialog
                    trigger={
                      <Button type="button" variant="outline" size="sm">
                        {m.round_withdraw()}
                      </Button>
                    }
                    title={m.round_withdraw_title()}
                    description={m.round_withdraw_body()}
                    confirmLabel={m.round_withdraw()}
                    pending={withdraw.isPending}
                    onConfirm={() => withdraw.mutate(submission.id)}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
