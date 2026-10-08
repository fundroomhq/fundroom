import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Checkbox,
  Label,
  toast,
} from "@fundroomhq/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId } from "react";
import type { AnalyticsNotice } from "../../lib/analytics-queries.js";
import { api, call, describeError } from "../../lib/api.js";
import { consentQuery } from "../../lib/compliance-queries.js";
import { useGuardedMutation } from "../../lib/use-guarded-mutation.js";
import { m } from "../../paraglide/messages.js";

/*
 * The member's own side of consent (ADR-0037 decision 6). The server has already folded the
 * workspace mode, the stored answer and the GPC header into `dwell`; this control only writes
 * the stored answer back.
 *
 * When the browser sends Global Privacy Control there is no control at all: GPC always means
 * no, and a switch that looked as though it could turn measurement back on would be a lie
 * about what the server will do with it.
 */
export function ConsentControl({ notice }: { notice: AnalyticsNotice }) {
  const { consent } = notice;
  const id = useId();
  const queryClient = useQueryClient();
  const save = useGuardedMutation<unknown, boolean>({
    mutationFn: (granted) =>
      call(
        api().PUT("/compliance/consent", {
          body: { purpose: "analytics_engagement", granted, source: "settings" },
        }),
      ),
    onSuccess: (_data, granted) => {
      toast.success(granted ? m.consent_saved_granted() : m.consent_saved_withdrawn());
      void queryClient.invalidateQueries({ queryKey: ["analytics", "notice"] });
      void queryClient.invalidateQueries({ queryKey: ["compliance", "consent"] });
    },
    onError: (error) => toast.error(describeError(error).title),
  });

  if (consent.gpc) {
    return (
      <Alert>
        <AlertTitle>{m.consent_gpc_title()}</AlertTitle>
        <AlertDescription>{m.consent_gpc_body()}</AlertDescription>
      </Alert>
    );
  }

  // Opt-in workspace that has never asked this member: the one case where asking in-portal is
  // the right thing rather than an interruption.
  if (consent.shouldAsk) {
    return (
      <Alert>
        <AlertTitle>{m.consent_ask_title()}</AlertTitle>
        <AlertDescription className="space-y-3">
          <p>{m.consent_ask_body()}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              loading={save.isPending}
              onClick={() => save.mutate(true)}
            >
              {m.consent_ask_allow()}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              loading={save.isPending}
              onClick={() => save.mutate(false)}
            >
              {m.consent_ask_decline()}
            </Button>
          </div>
        </AlertDescription>
      </Alert>
    );
  }

  const granted = consent.granted ?? consent.mode !== "opt_in";
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Checkbox
          id={id}
          checked={granted}
          disabled={save.isPending}
          onCheckedChange={(on) => save.mutate(on === true)}
        />
        <Label htmlFor={id}>{m.consent_toggle_label()}</Label>
      </div>
      <p className="text-xs text-muted-foreground">{m.consent_toggle_hint()}</p>
    </div>
  );
}

/*
 * The `email_tracking` purpose (E2.6), separate from `analytics_engagement`: whether this
 * workspace may see when the member opens an update email and which links they click. The
 * state comes from `GET /compliance/consent`; when that is unavailable the control is simply
 * not shown (the server still refuses tracking without an allowing answer).
 *
 * The checkbox shows the server's `allowed` and nothing else — never `granted` folded with the
 * mode here, because the server also folds in GPC and erasure and the browser must not disagree
 * with it. Under GPC the control stays on screen, off and disabled, and says why: hiding it would
 * leave the member unable to see that email tracking is off for them, and GPC is durable on the
 * server (it is recorded as a refusal), so "off" is the true state, not just this request's.
 */
export function EmailTrackingConsent() {
  const consent = useQuery(consentQuery);
  const id = useId();
  const hintId = useId();
  const queryClient = useQueryClient();
  const save = useGuardedMutation<unknown, boolean>({
    mutationFn: (granted) =>
      call(
        api().PUT("/compliance/consent", {
          body: { purpose: "email_tracking", granted, source: "settings" },
        }),
      ),
    onSuccess: (_data, granted) => {
      toast.success(granted ? m.consent_email_saved_granted() : m.consent_email_saved_withdrawn());
      void queryClient.invalidateQueries({ queryKey: ["compliance", "consent"] });
    },
    onError: (error) => toast.error(describeError(error).title),
  });
  const state = consent.data;
  if (!state) return null;
  const purpose = state.purposes.find((p) => p.purpose === "email_tracking");
  const allowed = purpose?.allowed === true;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Checkbox
          id={id}
          checked={allowed}
          disabled={state.gpc || save.isPending}
          aria-describedby={hintId}
          onCheckedChange={(on) => save.mutate(on === true)}
        />
        <Label htmlFor={id}>{m.consent_email_toggle_label()}</Label>
      </div>
      <p id={hintId} className="text-xs text-muted-foreground">
        {state.gpc ? m.consent_email_gpc_hint() : m.consent_email_toggle_hint()}
      </p>
    </div>
  );
}
