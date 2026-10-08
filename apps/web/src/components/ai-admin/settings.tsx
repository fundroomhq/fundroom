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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  fieldAria,
  Input,
  toast,
} from "@fundroomhq/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CloudOff, FileWarning, ServerCog, Sparkles } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import {
  type AiEffectiveFeature,
  type AiProviderInfo,
  type AiStatus,
  aiHostingLabel,
  aiLocationLabel,
  aiStatusQuery,
  aiTrainingLabel,
  aiUsagePercent,
  type PutAiSettings,
  putAiSettings,
} from "../../lib/ai-queries.js";
import { isCode } from "../../lib/api.js";
import { useGuardedMutation } from "../../lib/use-guarded-mutation.js";
import { m } from "../../paraglide/messages.js";
import { getLocale } from "../../paraglide/runtime.js";
import { PlanFeatureNotice, usePlanAllowsFeature } from "../billing/plan-feature-notice.js";
import { ErrorAlert } from "../error-alert.js";

/*
 * Settings → AI assist (E3.12, ADR-0060). What the admin must not get wrong, and the screen is
 * shaped around it:
 *
 *  - **The host decides whether there is a model at all.** With none configured the page says so
 *    and offers nothing to switch on.
 *  - **Where the material goes is said before it goes.** The provider card names the model, who
 *    runs it and where; turning AI assist on (or on again after the host changed the provider)
 *    asks for an acknowledgement whose copy says, for a third-party service, that documents leave
 *    the host's infrastructure.
 *  - **Off by default, per feature.** The master switch and both features start off; turning one
 *    off cancels that feature's requests in flight (the server does it).
 */

const numberFormat = () => new Intl.NumberFormat(getLocale());

export function AiSettingsBody({ status, canManage }: { status: AiStatus; canManage: boolean }) {
  // R3-H1: legal documents are snapshots, so turning AI on changes nothing investors were told.
  const on = status.effective.updateDraft || status.effective.qaAnswer;
  // RR2-L8: a feature turned on in this visit is named in the callout (the notice may predate it).
  // Only this session's saves are known: the web cannot tell which features a published notice
  // already describes.
  const [newlyOn, setNewlyOn] = useState<readonly AiEffectiveFeature[]>([]);
  return (
    <>
      {/* A-3: without `ai` on the plan nothing new can be switched on, and requests stop. */}
      <PlanFeatureNotice feature="ai" className="max-w-3xl" />
      {status.usage.budgetBelowMinimum ? (
        // RR3-L8: the host raised the per-request reservation above this workspace's budget, so
        // every feature reads off and every start is refused until the budget is raised.
        <Alert variant="warning" role="alert" className="max-w-3xl">
          <AlertTitle>{m.ai_budget_below_minimum_title()}</AlertTitle>
          <AlertDescription>
            {m.ai_budget_below_minimum_body({
              min: numberFormat().format(status.usage.minimumBudget),
            })}
          </AlertDescription>
        </Alert>
      ) : null}
      {on || newlyOn.length > 0 ? <PrivacyNoticeCallout newlyOn={newlyOn} /> : null}
      <ProviderCard status={status} />
      {status.available && status.provider !== null ? (
        <>
          <SettingsForm
            // Re-seed the form whenever the stored settings change (a save, another admin).
            key={JSON.stringify(status.settings)}
            status={status}
            provider={status.provider}
            canManage={canManage}
            onSaved={(next) => {
              const added = (["updateDraft", "qaAnswer"] as const).filter(
                (f) => next.effective[f] && !status.effective[f],
              );
              setNewlyOn((prev) => [...new Set([...prev, ...added])]);
            }}
          />
          <UsageCard usage={status.usage} />
        </>
      ) : null}
    </>
  );
}

/** While AI assist is on: the published privacy notice and DPA do not update themselves. */
function PrivacyNoticeCallout({ newlyOn }: { newlyOn: readonly AiEffectiveFeature[] }) {
  const names = newlyOn.map((f) =>
    f === "updateDraft" ? m.ai_feature_update_draft() : m.ai_feature_qa_answer(),
  );
  return (
    <Alert variant="warning" className="max-w-3xl">
      <FileWarning aria-hidden="true" />
      <AlertTitle>{m.ai_privacy_notice_title()}</AlertTitle>
      <AlertDescription>
        {names.length > 0 ? (
          <p className="font-medium">
            {m.ai_privacy_notice_newly_on({
              features: new Intl.ListFormat(getLocale(), { type: "conjunction" }).format(names),
            })}
          </p>
        ) : null}
        <p>
          {m.ai_privacy_notice_body()}{" "}
          <Link
            to="/admin/legal"
            search={{ tab: "documents" }}
            className="font-medium underline underline-offset-4"
          >
            {m.ai_privacy_notice_link()}
          </Link>
        </p>
      </AlertDescription>
    </Alert>
  );
}

function ProviderCard({ status }: { status: AiStatus }) {
  const provider = status.provider;
  if (!status.available || provider === null) {
    return (
      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CloudOff aria-hidden="true" className="size-5 text-muted-foreground" />
            {m.ai_unavailable_title()}
          </CardTitle>
          <CardDescription>{m.ai_unavailable_body()}</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ServerCog aria-hidden="true" className="size-5 text-muted-foreground" />
          {m.ai_provider_title()}
        </CardTitle>
        <CardDescription>{m.ai_provider_body()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
          <dt className="text-muted-foreground">{m.ai_provider_label()}</dt>
          <dd className="font-medium">{provider.label}</dd>
          <dt className="text-muted-foreground">{m.ai_provider_model()}</dt>
          <dd className="font-mono text-xs">{provider.model}</dd>
          <dt className="text-muted-foreground">{m.ai_provider_hosting()}</dt>
          <dd>
            <Badge variant={provider.hosting === "self_hosted" ? "success" : "warning"}>
              {aiHostingLabel(provider.hosting)}
            </Badge>
          </dd>
          <dt className="text-muted-foreground">{m.ai_provider_location()}</dt>
          <dd>{aiLocationLabel(provider)}</dd>
          <dt className="text-muted-foreground">{m.ai_provider_training()}</dt>
          <dd>{aiTrainingLabel(provider)}</dd>
          <dt className="text-muted-foreground">{m.ai_provider_retention()}</dt>
          {/* The provider's own sentence (API facts, English); the frame is localised. */}
          <dd lang="en">{provider.retention}</dd>
        </dl>
      </CardContent>
    </Card>
  );
}

function SettingsForm({
  status,
  provider,
  canManage,
  onSaved,
}: {
  status: AiStatus;
  provider: AiProviderInfo;
  canManage: boolean;
  onSaved: (next: AiStatus) => void;
}) {
  const ids = { enabled: useId(), draft: useId(), qa: useId(), budget: useId() };
  const queryClient = useQueryClient();
  const stored = status.settings;
  // A-3: a switch the plan does not cover can be turned off, not on (the PUT refuses the turn).
  const planAllows = usePlanAllowsFeature("ai");
  const [enabled, setEnabled] = useState(stored.enabled);
  const [updateDraft, setUpdateDraft] = useState(stored.features.updateDraft);
  const [qaAnswer, setQaAnswer] = useState(stored.features.qaAnswer);
  const [budget, setBudget] = useState(
    stored.monthlyTokenBudget === null ? "" : String(stored.monthlyTokenBudget),
  );
  const [acknowledging, setAcknowledging] = useState(false);
  const trimmed = budget.trim();
  const budgetValue = trimmed === "" ? null : Number(trimmed);
  // A budget below one request's reservation could never start a request (the PUT refuses it);
  // an unchanged stored value is still accepted, as the server does.
  const minimum = Math.max(1000, status.usage.minimumBudget);
  const budgetInvalid =
    budgetValue !== null &&
    (!Number.isInteger(budgetValue) ||
      (budgetValue < minimum && budgetValue !== stored.monthlyTokenBudget));

  const body = (acknowledge: boolean): PutAiSettings => ({
    enabled,
    features: { updateDraft, qaAnswer },
    monthlyTokenBudget: budgetValue,
    acknowledge,
  });
  const save = useGuardedMutation({
    mutationFn: (acknowledge: boolean) => putAiSettings(body(acknowledge)),
    onSuccess: (next) => {
      setAcknowledging(false);
      onSaved(next);
      queryClient.setQueryData(aiStatusQuery.queryKey, next);
      toast.success(m.ai_settings_saved());
    },
    onError: (error) => {
      // Another admin's change or a provider switch between load and save: ask now.
      if (isCode(error, "ai_acknowledgement_required")) setAcknowledging(true);
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (budgetInvalid) return;
    // Turning on (or staying on) without an acknowledgement of THIS provider asks for one first.
    if (enabled && status.needsAcknowledgement) {
      setAcknowledging(true);
      return;
    }
    save.mutate(false);
  }

  const lapsed = stored.enabled && status.needsAcknowledgement && stored.acknowledgement !== null;
  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles aria-hidden="true" className="size-5 text-muted-foreground" />
          {m.ai_settings_title()}
        </CardTitle>
        <CardDescription>{m.ai_settings_body()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {lapsed ? (
          <Alert variant="warning" role="status">
            <AlertTitle>{m.ai_ack_lapsed_title()}</AlertTitle>
            <AlertDescription>{m.ai_ack_lapsed_body()}</AlertDescription>
          </Alert>
        ) : null}
        {canManage ? null : <p className="text-sm text-muted-foreground">{m.ai_read_only()}</p>}
        <form className="space-y-4" onSubmit={submit} noValidate>
          <fieldset disabled={!canManage || save.isPending} className="space-y-4">
            <legend className="sr-only">{m.ai_settings_title()}</legend>
            <div className="flex items-start gap-2 text-sm">
              <input
                id={ids.enabled}
                type="checkbox"
                className="mt-1 size-4"
                checked={enabled}
                disabled={!planAllows && !stored.enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              <label htmlFor={ids.enabled}>
                <span className="font-medium">{m.ai_enabled_label()}</span>
                <span className="block text-muted-foreground">{m.ai_enabled_help()}</span>
              </label>
            </div>
            <fieldset disabled={!enabled} className="space-y-3 border-l pl-4">
              <legend className="text-sm font-medium">{m.ai_features_legend()}</legend>
              <div className="flex items-start gap-2 text-sm">
                <input
                  id={ids.draft}
                  type="checkbox"
                  className="mt-1 size-4"
                  checked={updateDraft}
                  disabled={!planAllows && !stored.features.updateDraft}
                  onChange={(e) => setUpdateDraft(e.target.checked)}
                />
                <label htmlFor={ids.draft}>
                  <span className="font-medium">{m.ai_feature_update_draft()}</span>
                  <span className="block text-muted-foreground">
                    {m.ai_feature_update_draft_help()}
                  </span>
                </label>
              </div>
              <div className="flex items-start gap-2 text-sm">
                <input
                  id={ids.qa}
                  type="checkbox"
                  className="mt-1 size-4"
                  checked={qaAnswer}
                  disabled={!planAllows && !stored.features.qaAnswer}
                  onChange={(e) => setQaAnswer(e.target.checked)}
                />
                <label htmlFor={ids.qa}>
                  <span className="font-medium">{m.ai_feature_qa_answer()}</span>
                  <span className="block text-muted-foreground">
                    {m.ai_feature_qa_answer_help()}
                  </span>
                </label>
              </div>
            </fieldset>
            <Field
              id={ids.budget}
              label={m.ai_budget_label()}
              description={`${m.ai_budget_help()} ${m.ai_budget_minimum({ min: numberFormat().format(minimum) })}`}
              {...(budgetInvalid
                ? { error: m.ai_budget_invalid({ min: numberFormat().format(minimum) }) }
                : {})}
            >
              <Input
                id={ids.budget}
                inputMode="numeric"
                className="max-w-xs"
                value={budget}
                placeholder={numberFormat().format(status.usage.budget)}
                onChange={(e) => setBudget(e.target.value)}
                {...fieldAria(ids.budget, { description: true, error: budgetInvalid })}
              />
            </Field>
          </fieldset>
          {save.isError && !isCode(save.error, "ai_acknowledgement_required") ? (
            <ErrorAlert error={save.error} />
          ) : null}
          {canManage ? (
            <Button type="submit" loading={save.isPending}>
              {m.ai_settings_save()}
            </Button>
          ) : null}
        </form>
        {acknowledging ? (
          <AcknowledgeDialog
            provider={provider}
            pending={save.isPending}
            error={save.isError ? save.error : null}
            onCancel={() => setAcknowledging(false)}
            onConfirm={() => save.mutate(true)}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

function AcknowledgeDialog({
  provider,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  provider: AiProviderInfo;
  pending: boolean;
  error: unknown;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [agreed, setAgreed] = useState(false);
  const checkId = useId();
  const thirdParty = provider.hosting === "third_party";
  const vars = {
    label: provider.label,
    model: provider.model,
    location: aiLocationLabel(provider),
  };
  return (
    <Dialog open onOpenChange={(open) => (open ? null : onCancel())}>
      <DialogContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (agreed) onConfirm();
          }}
        >
          <DialogHeader>
            <DialogTitle>{m.ai_ack_title()}</DialogTitle>
            <DialogDescription>
              {thirdParty ? m.ai_ack_body_third_party(vars) : m.ai_ack_body_self_hosted(vars)}
            </DialogDescription>
          </DialogHeader>
          {thirdParty ? (
            <Alert variant="warning">
              <AlertTitle>{m.ai_ack_leaves_title()}</AlertTitle>
              <AlertDescription>
                <p>{m.ai_ack_leaves_body()}</p>
                <p>{aiTrainingLabel(provider)}</p>
              </AlertDescription>
            </Alert>
          ) : null}
          <p className="text-sm">{m.ai_ack_drafts_only()}</p>
          <p className="text-sm">{m.ai_privacy_notice_body()}</p>
          <div className="flex items-start gap-2 text-sm">
            <input
              id={checkId}
              type="checkbox"
              className="mt-1 size-4"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
            />
            <label htmlFor={checkId}>
              {thirdParty ? m.ai_ack_check_third_party() : m.ai_ack_check_self_hosted()}
            </label>
          </div>
          {error !== null && !isCode(error, "ai_acknowledgement_required") ? (
            <ErrorAlert error={error} />
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>
              {m.common_cancel()}
            </Button>
            <Button type="submit" disabled={!agreed} loading={pending}>
              {m.ai_ack_confirm()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function UsageCard({ usage }: { usage: AiStatus["usage"] }) {
  const meterId = useId();
  const used = usage.inputTokens + usage.outputTokens;
  const nf = numberFormat();
  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>{m.ai_usage_title()}</CardTitle>
        <CardDescription>{m.ai_usage_body({ month: usage.month })}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <p id={meterId}>
          {m.ai_usage_tokens({
            used: nf.format(used),
            budget: nf.format(usage.budget),
            percent: String(aiUsagePercent(usage)),
          })}
        </p>
        <meter
          aria-labelledby={meterId}
          className="h-2 w-full max-w-md"
          min={0}
          max={Math.max(1, usage.budget)}
          value={Math.min(used, Math.max(1, usage.budget))}
        />
        <p className="text-muted-foreground">{m.ai_usage_requests({ n: usage.requests })}</p>
      </CardContent>
    </Card>
  );
}
