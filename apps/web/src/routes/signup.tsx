import {
  Button,
  Card,
  CardContent,
  Field,
  fieldAria,
  Input,
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
  ThemeToggle,
} from "@fundroomhq/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useId, useMemo, useState } from "react";
import * as z from "zod/mini";
import { SecureStep } from "../components/account/secure-step.js";
import { NativeSelect } from "../components/compliance/common.js";
import { ErrorAlert } from "../components/error-alert.js";
import { FooterLinks, isLinkable } from "../components/footer.js";
import { NotFoundScreen } from "../components/status-screens.js";
import { api, call, describeError, isApiError, isCode } from "../lib/api.js";
import { useWebConfig } from "../lib/config-context.js";
import { meQuery } from "../lib/queries.js";
import {
  countryOptions,
  initialPlan,
  isPlanId,
  isValidSlug,
  previewHost,
  regionSignupHref,
  type SignupPlan,
  type SignupRegion,
  signupPlansQuery,
  signupRegionsQuery,
  slugAvailabilityQuery,
  slugFromName,
} from "../lib/signup-queries.js";
import { m } from "../paraglide/messages.js";
import { getLocale } from "../paraglide/runtime.js";

export const Route = createFileRoute("/signup")({
  validateSearch: z.object({
    /** A-5: the plan the host's pricing page linked to; preselected when it is on offer. */
    plan: z.catch(z.optional(z.string().check(z.refine(isPlanId, "not a plan id"))), undefined),
  }),
  component: SignupPage,
});

/*
 * Self-service signup (E3.10, ADR-0058 §5.7) on the canonical host, only when the install runs
 * SIGNUP_MODE=open (`config.signup`; the API 404s otherwise, and so does this page). Three
 * steps: the company and its address → the code emailed to the founder → a link to the new
 * workspace, where they sign in (or central auth hands them over).
 *
 * Nothing here may tell a visitor whether an address already has an account: `start` answers
 * the same whatever the email is, and the copy never says "welcome back" or "no account".
 */
function SignupPage() {
  const config = useWebConfig();
  // A server with signup open always names its terms (A-5); without them there is no version to
  // accept, so signup is treated as closed rather than guessing one.
  if (config.signup !== true || !config.signupTerms) return <NotFoundScreen />;
  return (
    <SignupLayout>
      <SignupFlow termsVersion={config.signupTerms.version} />
    </SignupLayout>
  );
}

/** The signed-out card layout (`_auth.tsx`), which this top-level route does not sit under. */
function SignupLayout({ children }: { children: ReactNode }) {
  const config = useWebConfig();
  return (
    <div className="flex min-h-svh flex-col bg-muted/30 p-4 sm:p-8">
      <a
        href="#signup-main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded focus:bg-background focus:px-3 focus:py-2"
      >
        {m.nav_skip_to_content()}
      </a>
      <header className="mx-auto flex w-full max-w-lg items-center justify-between py-2">
        <span className="text-sm font-semibold">{config.instanceName}</span>
        <ThemeToggle
          labels={{
            light: m.theme_light(),
            dark: m.theme_dark(),
            system: m.theme_system(),
            toggle: m.theme_toggle(),
          }}
        />
      </header>
      <main id="signup-main" className="mx-auto flex w-full max-w-lg flex-1 items-start py-4">
        <Card className="w-full">
          <CardContent className="pt-6">{children}</CardContent>
        </Card>
      </main>
      <FooterLinks className="mx-auto w-full max-w-lg py-2" center hostLinks />
    </div>
  );
}

interface Details {
  email: string;
  companyName: string;
  legalName: string;
  country: string;
  slug: string;
  /** The version of the host's terms the checkbox accepts (sent with `acceptTerms: true`). */
  termsVersion: number;
  /** A-5: the plan picked (sent with the code); `undefined` leaves it to the host's default. */
  planId?: string | undefined;
}

type Step =
  | { kind: "details"; slugTaken: boolean }
  | { kind: "code"; details: Details }
  | { kind: "done"; workspaceUrl: string };

function SignupFlow({ termsVersion }: { termsVersion: number }) {
  const [step, setStep] = useState<Step>({ kind: "details", slugTaken: false });
  const [details, setDetails] = useState<Details>({
    email: "",
    companyName: "",
    legalName: "",
    country: "",
    slug: "",
    // The version the page config names; one revised while the page is open is corrected by the
    // 409 below.
    termsVersion,
  });
  switch (step.kind) {
    case "details":
      return (
        <DetailsStep
          details={details}
          onChange={setDetails}
          slugTaken={step.slugTaken}
          onSent={(sent) => setStep({ kind: "code", details: sent })}
        />
      );
    case "code":
      return (
        <CodeStep
          details={step.details}
          onBack={(slugTaken) => setStep({ kind: "details", slugTaken })}
          onDone={(workspaceUrl) => setStep({ kind: "done", workspaceUrl })}
        />
      );
    case "done":
      return <DoneStep workspaceUrl={step.workspaceUrl} />;
  }
}

function startBody(details: Details) {
  return {
    email: details.email.trim(),
    companyName: details.companyName.trim(),
    legalName: details.legalName.trim(),
    country: details.country,
    slug: details.slug,
    locale: getLocale(),
    // Only ever sent once the box is ticked: the server stores both with the code and writes the
    // owner's attestation from them (E3.10 R1-L3).
    acceptTerms: true as const,
    termsVersion: details.termsVersion,
  };
}

/**
 * A 409 `conflict` with `reason: terms_version`: the terms changed since this page was loaded.
 * Answers the version the server now holds (`current`), or `undefined` for any other refusal.
 */
function newerTermsVersion(error: unknown): number | undefined {
  if (!isCode(error, "conflict") || !isApiError(error)) return undefined;
  const envelope = error.body.error as Record<string, unknown>;
  const nested = envelope["details"];
  const source =
    typeof nested === "object" && nested !== null ? (nested as Record<string, unknown>) : envelope;
  if (source["reason"] !== "terms_version") return undefined;
  const current = source["current"];
  return typeof current === "number" && Number.isInteger(current) ? current : undefined;
}

/** The value `delay` ms after it last changed — the slug check waits for the typing to stop. */
function useDebounced<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return settled;
}

const SLUG_DEBOUNCE_MS = 400;

function DetailsStep({
  details,
  onChange,
  slugTaken,
  onSent,
}: {
  details: Details;
  onChange: (next: Details) => void;
  slugTaken: boolean;
  /** With the details as sent, the plan resolved (the shown default included). */
  onSent: (sent: Details) => void;
}) {
  const config = useWebConfig();
  const { plan: requestedPlan } = Route.useSearch();
  const ids = {
    email: useId(),
    company: useId(),
    legal: useId(),
    country: useId(),
    slug: useId(),
    terms: useId(),
  };
  // The address follows the company name until the founder edits it themselves.
  const [slugEdited, setSlugEdited] = useState(details.slug !== "");
  const [terms, setTerms] = useState(false);
  const [takenSlug, setTakenSlug] = useState(slugTaken ? details.slug : undefined);
  const countries = useMemo(() => countryOptions(getLocale()), []);
  const set = (patch: Partial<Details>) => onChange({ ...details, ...patch });
  const [elsewhere, setElsewhere] = useState<SignupRegion | null>(null);

  // A-5: the plan the form shows picked; without a list nothing is sent. The form waits for the
  // list to settle, so what is sent is always what was on screen.
  const plans = useQuery(signupPlansQuery);
  const offered = plans.data?.plans ?? [];
  const planId = offered.some((p) => p.id === details.planId)
    ? details.planId
    : initialPlan(offered, requestedPlan);

  const slug = details.slug;
  const slugValid = isValidSlug(slug);
  const settled = useDebounced(slug, SLUG_DEBOUNCE_MS);
  const availability = useQuery({
    ...slugAvailabilityQuery(settled),
    enabled: isValidSlug(settled),
  });
  const checked = settled === slug && availability.data?.slug === slug;
  const taken = takenSlug === slug || (checked && availability.data?.available === false);
  const slugError =
    slug !== "" && !slugValid ? m.signup_slug_invalid() : taken ? m.signup_slug_taken() : undefined;
  const slugStatus =
    slugError !== undefined || !slugValid
      ? undefined
      : checked && availability.data?.available === true
        ? m.signup_slug_available()
        : m.signup_slug_checking();

  const [termsChanged, setTermsChanged] = useState(false);
  const publishedTerms = config.signupTerms?.url ?? null;
  const termsUrl = publishedTerms !== null && isLinkable(publishedTerms) ? publishedTerms : null;
  const start = useMutation({
    mutationFn: () => call(api().POST("/signup/start", { body: startBody(details) })),
    onSuccess: () => onSent({ ...details, planId }),
    onError: (error) => {
      // The terms were revised while this page was open: the tick was for the old ones, so it
      // is taken back and the applicant accepts the current version before anything is sent.
      const current = newerTermsVersion(error);
      if (current === undefined) return;
      setTerms(false);
      setTermsChanged(true);
      set({ termsVersion: current });
    },
  });

  const complete =
    details.email.trim() !== "" &&
    details.companyName.trim() !== "" &&
    details.legalName.trim() !== "" &&
    details.country !== "" &&
    slugValid &&
    !taken &&
    terms &&
    !plans.isPending &&
    // E3.11: a region served by another deployment signs up there, not here.
    elsewhere === null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (complete && !start.isPending) start.mutate();
  };

  return (
    <form className="space-y-5" onSubmit={submit} noValidate>
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">{m.signup_title()}</h1>
        <p className="text-sm text-muted-foreground">
          {m.signup_subtitle({ instance: config.instanceName })}
        </p>
      </div>
      <RegionPicker onElsewhere={setElsewhere} />
      <PlanPicker plans={offered} value={planId} onChange={(id) => set({ planId: id })} />
      {termsChanged ? (
        <p role="alert" className="text-sm font-medium">
          {m.signup_terms_changed()}
        </p>
      ) : (
        <ErrorAlert error={start.error} />
      )}
      <Field id={ids.email} label={m.signup_email()} description={m.signup_email_help()} required>
        <Input
          id={ids.email}
          type="email"
          name="email"
          inputMode="email"
          autoComplete="email"
          autoFocus
          required
          value={details.email}
          onChange={(e) => set({ email: e.target.value })}
          {...fieldAria(ids.email, { description: true })}
        />
      </Field>
      <Field id={ids.company} label={m.signup_company_name()} required>
        <Input
          id={ids.company}
          name="organization"
          autoComplete="organization"
          required
          maxLength={100}
          value={details.companyName}
          onChange={(e) => {
            const companyName = e.target.value;
            set(slugEdited ? { companyName } : { companyName, slug: slugFromName(companyName) });
          }}
        />
      </Field>
      <Field
        id={ids.legal}
        label={m.signup_legal_name()}
        description={m.signup_legal_name_help()}
        required
      >
        <Input
          id={ids.legal}
          name="legal-name"
          autoComplete="off"
          required
          maxLength={200}
          value={details.legalName}
          onChange={(e) => set({ legalName: e.target.value })}
          {...fieldAria(ids.legal, { description: true })}
        />
      </Field>
      <Field id={ids.country} label={m.signup_country()} required>
        <NativeSelect
          id={ids.country}
          name="country"
          autoComplete="country"
          required
          value={details.country}
          onChange={(e) => set({ country: e.target.value })}
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
        id={ids.slug}
        label={m.signup_slug()}
        description={
          slugValid
            ? m.signup_slug_preview({ host: previewHost(slug, config.canonicalOrigin) })
            : m.signup_slug_help()
        }
        error={slugError}
        required
      >
        <Input
          id={ids.slug}
          name="slug"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          required
          maxLength={63}
          value={slug}
          onChange={(e) => {
            setSlugEdited(true);
            setTakenSlug(undefined);
            set({ slug: e.target.value.toLowerCase() });
          }}
          {...fieldAria(ids.slug, { description: true, error: slugError !== undefined })}
        />
      </Field>
      {/* Announced as it changes: whether the address is free is the answer the field waits on. */}
      <p aria-live="polite" className="-mt-3 min-h-5 text-sm text-muted-foreground">
        {slugStatus ?? ""}
      </p>
      <div className="flex items-start gap-2">
        <input
          id={ids.terms}
          type="checkbox"
          className="mt-0.5 size-4 accent-primary"
          checked={terms}
          onChange={(e) => {
            setTerms(e.target.checked);
            if (e.target.checked) setTermsChanged(false);
          }}
          required
        />
        <div className="space-y-1 text-sm">
          <label htmlFor={ids.terms}>{m.signup_terms({ instance: config.instanceName })}</label>
          {/* A-5: readable from the form when the host has published them (TERMS_URL). */}
          {termsUrl === null ? null : (
            <a
              href={termsUrl}
              target="_blank"
              rel="noopener"
              className="block font-medium underline underline-offset-4"
            >
              {m.signup_terms_read()}
              <span className="sr-only"> {m.signup_terms_new_tab()}</span>
            </a>
          )}
        </div>
      </div>
      <Button type="submit" className="w-full" loading={start.isPending} disabled={!complete}>
        {m.signup_submit()}
      </Button>
    </form>
  );
}

/**
 * E3.11: where the workspace's data will live, offered only when the host runs more than one
 * region. This page signs up into its own region; a region served by another deployment has its
 * own sign-up page, so picking it offers a link there (and this form stops) rather than jumping
 * away on selection — arrow keys move through a radio group, and each step must not navigate.
 */
function RegionPicker({ onElsewhere }: { onElsewhere: (region: SignupRegion | null) => void }) {
  const regions = useQuery(signupRegionsQuery);
  const name = useId();
  // A region elsewhere without a usable sign-up page cannot be offered.
  const items = (regions.data?.items ?? []).filter(
    (r) => r.signupUrl === null || regionSignupHref(r) !== null,
  );
  const here = items.find((r) => r.signupUrl === null);
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const selected =
    items.length < 2 ? undefined : (items.find((r) => r.region === picked) ?? here ?? items[0]);
  const away = selected !== undefined && selected.signupUrl !== null ? selected : null;
  // The form below stays closed while the chosen region is served elsewhere.
  useEffect(() => onElsewhere(away), [away, onElsewhere]);
  if (selected === undefined) return null;
  const href = regionSignupHref(selected);
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{m.signup_region()}</legend>
      <p className="text-sm text-muted-foreground">{m.signup_region_help()}</p>
      <div className="grid gap-2">
        {items.map((r) => {
          const id = `${name}-${r.region}`;
          return (
            <div key={r.region} className="flex items-center gap-2">
              <input
                id={id}
                type="radio"
                name={name}
                className="size-4 accent-primary"
                checked={selected?.region === r.region}
                onChange={() => setPicked(r.region)}
              />
              <label htmlFor={id} className="text-sm">
                {r.label.trim() === "" ? r.region : r.label}
              </label>
            </div>
          );
        })}
      </div>
      {href !== null ? (
        <div className="space-y-2 rounded-md border p-3 text-sm">
          <p>{m.signup_region_elsewhere({ region: selected.label || selected.region })}</p>
          <a href={href} className="font-medium underline underline-offset-4">
            {m.signup_region_continue({ region: selected.label || selected.region })}
          </a>
        </div>
      ) : null}
    </fieldset>
  );
}

/**
 * A-5: the plan the workspace starts on, from the host's public plans (`GET /signup/plans`).
 * A native radio group, like the region choice: arrow keys move the choice and nothing happens
 * until the form is sent. Not shown when the host offers no plans or the list cannot be read —
 * the workspace then starts on the host's default plan. No prices: the host's site has them.
 */
function PlanPicker({
  plans,
  value,
  onChange,
}: {
  plans: readonly SignupPlan[];
  value: string | undefined;
  onChange: (id: string) => void;
}) {
  const name = useId();
  if (plans.length === 0) return null;
  return (
    <fieldset className="space-y-2" aria-describedby={`${name}-help`}>
      <legend className="text-sm font-medium">{m.signup_plan()}</legend>
      <p id={`${name}-help`} className="text-sm text-muted-foreground">
        {m.signup_plan_help()}
      </p>
      <div className="grid gap-2">
        {plans.map((p) => {
          const id = `${name}-${p.id}`;
          const terms = planTerms(p);
          return (
            <div key={p.id} className="flex items-start gap-2">
              <input
                id={id}
                type="radio"
                name={name}
                value={p.id}
                className="mt-0.5 size-4 accent-primary"
                checked={value === p.id}
                onChange={() => onChange(p.id)}
                aria-describedby={terms === undefined ? undefined : `${id}-terms`}
              />
              <div className="text-sm">
                <label htmlFor={id} className="font-medium">
                  {p.name}
                </label>
                {terms === undefined ? null : (
                  <p id={`${id}-terms`} className="text-muted-foreground">
                    {terms}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}

/**
 * How a plan starts: a free trial, or a subscription. Never "free": `paid` is false for a priced
 * plan on a manually billed install too (no self-serve checkout), so its absence proves nothing.
 */
function planTerms(plan: SignupPlan): string | undefined {
  if (plan.trialDays > 0) return m.billing_plan_trial({ count: plan.trialDays });
  return plan.paid ? m.signup_plan_paid() : undefined;
}

const RESEND_COOLDOWN_S = 30;

function CodeStep({
  details,
  onBack,
  onDone,
}: {
  details: Details;
  onBack: (slugTaken: boolean) => void;
  onDone: (workspaceUrl: string) => void;
}) {
  const id = useId();
  const [code, setCode] = useState("");
  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN_S);
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const verify = useMutation({
    mutationFn: (c: string) =>
      call(
        api().POST("/signup/verify", {
          body: {
            email: details.email.trim(),
            code: c,
            ...(details.planId === undefined ? {} : { planId: details.planId }),
          },
        }),
      ),
    onSuccess: (out) => onDone(out.workspaceUrl),
    onError: (error) => {
      setCode("");
      // Someone else took the address between the check and the code: back to the form,
      // with the field saying so, rather than a dead end.
      if (isCode(error, "slug_taken")) onBack(true);
    },
  });
  const resend = useMutation({
    mutationFn: () => call(api().POST("/signup/start", { body: startBody(details) })),
    onSuccess: () => setCooldown(RESEND_COOLDOWN_S),
  });

  const inlineError =
    verify.isError && isCode(verify.error, "invalid_code", "expired", "too_many_attempts")
      ? describeError(verify.error).body
      : undefined;
  const otherError = verify.isError && inlineError === undefined ? verify.error : resend.error;

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (code.length === 6) verify.mutate(code);
      }}
    >
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">{m.signup_code_title()}</h1>
        <p className="text-sm text-muted-foreground">
          {m.signup_code_subtitle({ email: details.email.trim() })}
        </p>
      </div>
      <ErrorAlert error={otherError} />
      <Field id={id} label={m.verify_code()} error={inlineError}>
        <InputOTP
          id={id}
          maxLength={6}
          value={code}
          autoFocus
          autoComplete="one-time-code"
          inputMode="numeric"
          disabled={verify.isPending}
          onChange={setCode}
          onComplete={(c: string) => verify.mutate(c)}
          {...fieldAria(id, { error: inlineError !== undefined })}
        >
          <InputOTPGroup>
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <InputOTPSlot key={i} index={i} />
            ))}
          </InputOTPGroup>
        </InputOTP>
      </Field>
      <Button
        type="submit"
        className="w-full"
        loading={verify.isPending}
        disabled={code.length < 6}
      >
        {m.signup_code_submit()}
      </Button>
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <Button
          type="button"
          variant="link"
          size="sm"
          disabled={cooldown > 0 || resend.isPending}
          onClick={() => resend.mutate()}
        >
          {cooldown > 0 ? m.verify_resend_in({ seconds: String(cooldown) }) : m.verify_resend()}
        </Button>
        <Button type="button" variant="link" size="sm" onClick={() => onBack(false)}>
          {m.signup_code_change_details()}
        </Button>
      </div>
    </form>
  );
}

/**
 * The server picks where the founder lands (A-5): the setup wizard, or the billing page first
 * when the plan needs a subscription before anything else. So the copy names neither, and the
 * address shown is the workspace's own, not the page the button opens.
 */
function DoneStep({ workspaceUrl }: { workspaceUrl: string }) {
  const config = useWebConfig();
  /*
   * A-5: the second factor is asked for here, on the canonical host, while the session is the
   * signup's own — an ordinary, fresh one that may add the first factor. On the workspace host
   * the founder may arrive with a session handed over by central auth, which may not change the
   * account at all. An account that already has a factor (signup never says whether the address
   * had one) is not asked; nor is anyone when `/me` cannot be read.
   */
  const me = useQuery({ ...meQuery, refetchOnMount: "always" });
  // Decided once, from the first answer: enrolling refreshes `/me`, and the recovery codes the
  // step ends on must not vanish when it says "enrolled".
  const [askFactor, setAskFactor] = useState<boolean | undefined>(undefined);
  const firstAnswer = me.isFetching ? undefined : me.data;
  useEffect(() => {
    if (askFactor !== undefined || firstAnswer === undefined) return;
    setAskFactor(firstAnswer !== null && !firstAnswer.session.user.mfaEnrolled);
  }, [askFactor, firstAnswer]);
  /*
   * A passkey added here that left the session at level 1 (its confirmation was cancelled or
   * did not verify): the workspace would only ask again, so going on is the second choice, said
   * as such, below the step's own way on (confirm again, or add an authenticator app).
   */
  const [unconfirmed, setUnconfirmed] = useState(false);
  const secureAsked = askFactor === true;
  return (
    <div className="space-y-4">
      <div className="space-y-1" role="status">
        <h1 className="text-xl font-semibold">{m.signup_done_title()}</h1>
        {askFactor ? (
          <p className="text-sm text-muted-foreground">{m.signup_done_secure()}</p>
        ) : null}
      </div>
      {askFactor ? (
        <SecureStep
          passwordEnabled={config.auth.methods.includes("password")}
          onNext={() => setAskFactor(false)}
          // No `stepUpReturn`: confirming happens on this screen, never through the step-up
          // screen, whose way back (`/signup`) is an empty form without the workspace address.
          onUnconfirmed={setUnconfirmed}
          // Too old a session to add one here: the workspace's own sign-in (by email code) can.
          staleAction={
            <Button asChild variant="outline">
              <a href={workspaceUrl}>{m.signup_done_secure_later()}</a>
            </Button>
          }
        />
      ) : null}
      <p className="text-sm text-muted-foreground">{m.signup_done_body()}</p>
      <p className="font-mono text-sm break-all">{workspaceHost(workspaceUrl)}</p>
      {secureAsked && unconfirmed ? (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">{m.signup_done_unconfirmed()}</p>
          <Button asChild variant="ghost" size="sm">
            <a href={workspaceUrl}>{m.signup_done_continue_anyway()}</a>
          </Button>
        </div>
      ) : (
        <Button asChild className="w-full" variant={secureAsked ? "outline" : "default"}>
          <a href={workspaceUrl}>
            <ArrowRight aria-hidden="true" />
            {m.signup_done_continue()}
          </a>
        </Button>
      )}
    </div>
  );
}

/** The workspace's address without the landing page: `acme.fundroom.app` (or `…/w/acme`). */
function workspaceHost(workspaceUrl: string): string {
  try {
    const url = new URL(workspaceUrl);
    const base = url.pathname.replace(/\/(?:setup|admin\/billing)\/?$/u, "");
    return `${url.host}${base === "/" ? "" : base}`;
  } catch {
    return workspaceUrl;
  }
}
