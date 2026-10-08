import type { FundRoomSchemas } from "@fundroom/sdk";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  cn,
  Field,
  fieldAria,
  Input,
  Label,
  LoadingState,
  Switch,
  Textarea,
  ThemeToggle,
  toast,
} from "@fundroomhq/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import {
  Check,
  FolderTree,
  HardDrive,
  Mail,
  Palette,
  Scale,
  ShieldCheck,
  UserPlus,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import * as z from "zod/mini";
import { SecureStep } from "../components/account/secure-step.js";
import {
  DisableReadOnlyModuleDialog,
  isPlanLocked,
  moduleBadges,
  UNAVAILABLE_SWITCH_CLASS,
} from "../components/billing/module-plan.js";
import {
  BillingLinkIfAllowed,
  workspaceStatusSentence,
} from "../components/billing/workspace-status.js";
import {
  AccentField,
  base64,
  isLogoType,
  LogoFetchForm,
  LogoFileButton,
} from "../components/branding/brand-controls.js";
import {
  NativeSelect,
  offeringStatusLabel,
  requiresConfirmation,
} from "../components/compliance/common.js";
import { CopyButton } from "../components/copy-button.js";
import { DomainRecordsTable } from "../components/domains/domain-records.js";
import { ErrorAlert } from "../components/error-alert.js";
import { FooterLinks } from "../components/footer.js";
import { api, call, describeError, isApiError, isCode, safeReturnTo } from "../lib/api.js";
import { useCanSeeBilling } from "../lib/billing-queries.js";
import {
  type Branding,
  brandingQuery,
  type ModuleEnablement,
  moduleEnablementQuery,
} from "../lib/branding-queries.js";
import { isServerReturnPath } from "../lib/central-auth.js";
import {
  type OfferingState,
  type OfferingStatus,
  offeringQuery,
} from "../lib/compliance-queries.js";
import type { WebConfig } from "../lib/config.js";
import { useWebConfig } from "../lib/config-context.js";
import { DOMAINS_KEY, describeDomainError, domainErrorReason } from "../lib/domains-queries.js";
import { dataRoomTemplatesQuery, meQuery, refreshSession, useMe } from "../lib/queries.js";
import { updatePostsQuery, updateTemplatesQuery } from "../lib/updates-queries.js";
import { m } from "../paraglide/messages.js";

/*
 * First-run wizard (EXECUTION_PLAN §9.4, ADR-0018, design/03 §5). E0.8 shipped
 * token → owner → secure → mail → storage → done; E1.7 added company basics, offering mode,
 * modules, the data-room folder template, the first invitations and an optional first update;
 * E2.1 adds the portal address between offering and modules.
 *
 * **The domain step is optional and deliberately absent from `resumeStep`.** design/03 §5 step 4
 * offers subdomain / custom domain / embed, and two of those three answers mean "nothing to do".
 * A founder who keeps the subdomain, or who will embed the portal (the snippet itself is E2.2),
 * is finished with that question — so there is no kernel fact for it and no way for it to resume
 * the wizard there forever, which is the `hasBrand` bug E1.7 shipped and took back out.
 *
 * **The step lives in the URL** (`/setup?step=…`). At five steps `useState` was survivable; at
 * twelve a reload that threw the founder back to the token field would not be. On a cold load
 * the wizard resumes at the first step `GET /setup/status`'s `progress` says is unfinished, and
 * when every kernel fact is true it lands on `modules` — the first step the kernel deliberately
 * knows nothing about (ADR-0033: the kernel does not read a module's tables, so the module
 * steps report their own state from their own endpoints). There is no wizard-state table and
 * there should not be one: every step's completion is already a fact somewhere else.
 *
 * **Everything after `storage` needs a level-2 session.** `requirePermission` asserts the auth
 * level for every staff route and an owner always needs level 2 (§6.2), so a founder who
 * skipped the security step is refused by the server on company, offering, modules, data room,
 * invitations and update alike. That refusal is rendered honestly — `step_up_required` becomes
 * "finish the security step first" with a button back to it — and never worked around: those
 * controls are what stops a stolen level-1 session from rebranding a portal or declaring a
 * 506(c) offering.
 *
 * **Under the control plane** (`config.controlPlane`, A-5) the host runs mail and storage and the
 * workspace was created by signup, so `token`, `mail` and `storage` are not offered (nor resumed
 * to), and the address the Done step shows is the workspace's own origin. A new hosted workspace
 * is held for a short check (`pending_review`) during which every setup route answers 423; the
 * wizard says so and offers "Check again" rather than an error card — and, to a founder still on
 * the level-1 session signup gave them, the security step, which works while held (`/auth/*` is
 * served) and is what everything after it needs anyway.
 */
export const Route = createFileRoute("/setup")({
  validateSearch: z.object({
    step: z.catch(
      z.optional(
        z.enum([
          "token",
          "owner",
          "secure",
          "mail",
          "storage",
          "company",
          "offering",
          "domain",
          "modules",
          "dataroom",
          "invites",
          "update",
          "done",
        ]),
      ),
      undefined,
    ),
    /**
     * A-5: where to go once the security step is done, instead of the next step — the billing
     * page sends a founder here to add a second factor before they can subscribe.
     */
    returnTo: z.catch(z.optional(z.string()), undefined),
    /** Back from the step-up screen the security step sent the founder to (any value). */
    stepped: z.catch(z.optional(z.union([z.string(), z.number(), z.boolean()])), undefined),
  }),
  /*
   * A-5: a hosted workspace's wizard is its owner's, and signup signs the founder in on the
   * canonical host only — so a signed-out visit here goes to this workspace's sign-in (central
   * auth's "Continue" there hands the canonical session over) and comes back to this URL. Not
   * on the canonical host, whose own first run is the token step's to gate.
   */
  beforeLoad: async ({ context, location }) => {
    if (context.config.controlPlane !== true || context.config.workspace === null) return;
    const me = await context.queryClient.ensureQueryData(meQuery);
    if (me === null) throw redirect({ to: "/login", search: { returnTo: location.href } });
  },
  component: SetupPage,
});

const ALL_STEPS = [
  "token",
  "owner",
  "secure",
  "mail",
  "storage",
  "company",
  "offering",
  "domain",
  "modules",
  "dataroom",
  "invites",
  "update",
  "done",
] as const;
type Step = (typeof ALL_STEPS)[number];

type SetupStatus = FundRoomSchemas["SetupStatus"];
type Owner = FundRoomSchemas["SetupOwner"];

/**
 * The portal's canonical URL; the status only omits it for callers who never see these steps.
 * Under the control plane `baseUrl` is the install's canonical host, not this workspace, so the
 * page config's canonical origin is the address instead — it already carries BASE_PATH and a
 * `/w/<slug>` mount, as "Open in a new tab" in the portal relies on.
 */
function portalUrl(status: SetupStatus, config: WebConfig): string {
  if (config.controlPlane === true) return `${config.canonicalOrigin.replace(/\/$/u, "")}/`;
  return status.baseUrl ?? `${window.location.origin}/`;
}

/**
 * What the host runs itself under the control plane: never asked about in its wizard. Nor is the
 * token: there is no first run there (E-UP-11) — signup or an operator made the owner, and the
 * server neither generates a token nor reports setup as required.
 */
const HOSTED_STEPS: ReadonlySet<Step> = new Set(["token", "mail", "storage"]);

/** Which module a step needs; absent or disabled and the step is dropped, never rendered broken. */
const STEP_MODULE: Partial<Record<Step, string>> = { dataroom: "data-room", update: "updates" };

function stepLabel(step: Step): string {
  switch (step) {
    case "token":
      return m.setup_step_token();
    case "owner":
      return m.setup_step_owner();
    case "secure":
      return m.setup_step_secure();
    case "mail":
      return m.setup_step_mail();
    case "storage":
      return m.setup_step_storage();
    case "company":
      return m.setup_step_company();
    case "offering":
      return m.setup_step_offering();
    case "domain":
      return m.setup_step_domain();
    case "modules":
      return m.setup_step_modules();
    case "dataroom":
      return m.setup_step_dataroom();
    case "invites":
      return m.setup_step_invites();
    case "update":
      return m.setup_step_update();
    case "done":
      return m.setup_step_done();
  }
}

/**
 * Where a cold load lands: the first step whose kernel fact is false. Steps the kernel has no
 * fact for are stepped over rather than re-opened — a wizard that sent the founder back to a
 * step they had already skipped would punish them for reloading — so once every fact is true
 * the answer is `modules`, the first of the module steps. `domain` is stepped over for the same
 * reason and a stronger one: two of its three answers are "no domain, on purpose".
 */
function resumeStep(progress: SetupStatus["progress"], hosted: boolean, level2: boolean): Step {
  // Absent for anyone but a signed-in staff owner/admin (E2.10 ZAP-04): nothing is resumable.
  // (Under the control plane a token step that is not offered normalises to `owner`.)
  if (progress === undefined || !progress.owner) return "token";
  if (!hosted && !progress.mail) return "mail";
  if (!hosted && !progress.storage) return "storage";
  // A-5: every step after this one needs a level-2 session; a level-1 one (a founder fresh from
  // signup, or back with only an email code) adds its second factor first.
  if (!level2) return "secure";
  if (!progress.branding) return "company";
  if (!progress.offering) return "offering";
  return "modules";
}

/**
 * The steps this instance can actually offer. A module that is not installed or not enabled
 * takes its step with it; while the enablement list is unknown (still loading, or refused) the
 * steps stay, because hiding them on a transient failure would silently shorten the wizard.
 */
function availableSteps(
  modules: readonly ModuleEnablement[] | undefined,
  hosted: boolean,
): readonly Step[] {
  const offered = hosted ? ALL_STEPS.filter((step) => !HOSTED_STEPS.has(step)) : ALL_STEPS;
  if (modules === undefined) return offered;
  return offered.filter((step) => {
    const needed = STEP_MODULE[step];
    return needed === undefined || modules.some((mod) => mod.id === needed && mod.enabled);
  });
}

/** The requested step if it exists here, else the next one that does. */
function normalise(steps: readonly Step[], wanted: Step): Step {
  if (steps.includes(wanted)) return wanted;
  const from = ALL_STEPS.indexOf(wanted);
  return ALL_STEPS.slice(from + 1).find((s) => steps.includes(s)) ?? "done";
}

function SetupPage() {
  const config = useWebConfig();
  const { step: requested, returnTo, stepped } = Route.useSearch();
  const navigate = Route.useNavigate();
  const status = useQuery({
    queryKey: ["setup", "status"],
    queryFn: () => call(api().GET("/setup/status")),
    staleTime: 0,
  });
  const me = useMe();
  const [token, setToken] = useState("");
  const [owner, setOwner] = useState<Owner | undefined>();

  /*
   * A wizard in progress and a stranger opening `/setup` after the fact look identical from
   * `setupRequired` alone, which is why E0.8 could get away with `owner === undefined`. With a
   * resumable wizard the session is the tiebreaker: a signed-in staff owner or admin is the
   * founder coming back, anyone else gets the "already set up, go and sign in" card.
   */
  const membership = me.data?.membership;
  const resuming =
    owner !== undefined ||
    (membership?.kind === "staff" && (membership.role === "owner" || membership.role === "admin"));
  const complete = status.data !== undefined && !status.data.required && !me.isPending && !resuming;

  const enablement = useQuery({ ...moduleEnablementQuery, enabled: resuming, retry: false });
  const hosted = config.controlPlane === true;
  // The canonical host of a managed host with signup open: "set up" there means "sign up".
  const signupHere = hosted && config.workspace === null && config.signup === true;
  // A hosted wizard never has a token (E-UP-11), even while the status cannot be read (held).
  const steps = useMemo(
    () => availableSteps(enablement.data?.modules, hosted),
    [enablement.data, hosted],
  );

  const level2 = (me.data?.session.authLevel ?? 0) >= 2;
  const resumed =
    status.data === undefined
      ? normalise(steps, "token")
      : resumeStep(status.data.progress, hosted, level2);
  const step = normalise(steps, requested ?? resumed);
  const setStep = useCallback(
    (next: Step) => {
      void navigate({ search: { step: next } });
    },
    [navigate],
  );

  // The URL is the wizard's state, so write the resumed step into it once the status is in.
  useEffect(() => {
    if (complete || status.data === undefined || me.isPending || requested !== undefined) return;
    void navigate({ search: { step: resumed }, replace: true });
  }, [complete, status.data, me.isPending, requested, resumed, navigate]);

  const current = steps.indexOf(step);
  const advance = () => setStep(normalise(steps, ALL_STEPS[ALL_STEPS.indexOf(step) + 1] ?? "done"));
  // A-5: back to the page that sent the founder here for a second factor (same origin only).
  // Only SPA routes: a server path (`/auth/central/…`) is not somewhere this wizard sends anyone.
  const safeBack = returnTo === undefined ? "" : safeReturnTo(returnTo, "");
  const back = isServerReturnPath(safeBack) ? "" : safeBack;
  const queryClient = useQueryClient();
  /*
   * After a factor was added: the server raises the session to level 2 for an authenticator app
   * but not for a new passkey, so the fresh `/me` decides. Still level 1 → the step-up screen
   * (the new factor proves it), then the page that asked, or the step after this one.
   */
  const next = normalise(steps, ALL_STEPS[ALL_STEPS.indexOf("secure") + 1] ?? "done");
  // Where the founder goes once the session is level 2: the page that asked, or the wizard on.
  const onward = back === "" ? `/setup?step=${next}` : back;
  /*
   * A step-up comes back to this step (`stepped`), not straight on: a passkey that does not
   * verify the user (no PIN or biometric) leaves the session at level 1, and only here is that
   * said — and an authenticator app offered — rather than a refusal on the next page.
   */
  const stepUpReturn = `/setup?step=secure&stepped=1&returnTo=${encodeURIComponent(onward)}`;
  const afterSecure = async () => {
    const fresh = await queryClient.fetchQuery({ ...meQuery, staleTime: 0 });
    if ((fresh?.session.authLevel ?? 0) < 2) {
      await navigate({ to: "/auth/step-up", search: { returnTo: stepUpReturn, reason: "level" } });
      return;
    }
    if (back !== "") await navigate({ href: back });
    else setStep(next);
  };
  /*
   * Back from a step-up: decided once, from the first `/me` after arrival — level 2 already →
   * straight on to where the founder was going. Not later: adding an authenticator app here
   * also makes the session level 2, and its recovery codes must be read before anything moves
   * (the step's own "Continue" goes on from there).
   */
  const steppedBack = stepped !== undefined && step === "secure";
  const [steppedForward, setSteppedForward] = useState<boolean | undefined>(undefined);
  const [secureFinished, setSecureFinished] = useState(false);
  useEffect(() => {
    if (!steppedBack || steppedForward !== undefined || me.isFetching || me.data === undefined)
      return;
    setSteppedForward(level2);
  }, [steppedBack, steppedForward, me.isFetching, me.data, level2]);
  useEffect(() => {
    if (steppedForward === true && !secureFinished) void navigate({ href: onward, replace: true });
  }, [steppedForward, secureFinished, onward, navigate]);
  // `stepped` is about a factor confirmed on the step-up screen; only an account with one has.
  const steppedUnverified = steppedBack && me.data?.session.user.mfaEnrolled === true;
  /*
   * Skipping goes on to where the wizard would resume were it not for the security step (not
   * the next step in line: a self-hosted founder past mail and storage is not walked through them
   * again). A page that asked for the factor would only refuse again, so it offers no skip; nor
   * does a level-1 session bound for a step that needs level 2 (all but mail and storage).
   */
  const skipTarget = ((): Step => {
    const target =
      status.data === undefined
        ? undefined
        : normalise(steps, resumeStep(status.data.progress, hosted, true));
    return target === undefined || ALL_STEPS.indexOf(target) <= ALL_STEPS.indexOf("secure")
      ? normalise(steps, ALL_STEPS[ALL_STEPS.indexOf("secure") + 1] ?? "done")
      : target;
  })();
  const skipSecure =
    back !== "" || (!level2 && skipTarget !== "mail" && skipTarget !== "storage")
      ? undefined
      : () => setStep(skipTarget);

  /*
   * Held for the new-workspace check: the setup routes answer 423, the security step does not.
   * Latched once shown, so the recovery codes it ends on are not taken away when the session
   * turns level 2 underneath it.
   */
  const held = status.isError && underReview(status.error, config);
  const [secureWhileHeld, setSecureWhileHeld] = useState(false);
  useEffect(() => {
    if (held && resuming && me.data !== undefined && !level2) setSecureWhileHeld(true);
  }, [held, resuming, me.data, level2]);

  return (
    <div className="flex min-h-svh flex-col bg-muted/30 p-4 sm:p-8">
      <a
        href="#setup-main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded focus:bg-background focus:px-3 focus:py-2"
      >
        {m.nav_skip_to_content()}
      </a>
      <header className="mx-auto flex w-full max-w-2xl items-center justify-between py-2">
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
      <main id="setup-main" className="mx-auto w-full max-w-2xl flex-1 py-4">
        <h1 className="mb-1 text-2xl font-semibold tracking-tight">{m.setup_title()}</h1>
        <p className="mb-6 text-sm text-muted-foreground">
          {m.setup_subtitle({ name: config.instanceName })}
        </p>
        {complete && signupHere ? (
          // E-UP-11: a managed host's canonical host has no first run; its workspaces come from
          // signup. Point there, with sign-in for whoever already has one.
          <Card>
            <CardContent className="space-y-4 pt-6">
              <Alert>
                <AlertTitle>{m.setup_hosted_title()}</AlertTitle>
                <AlertDescription>{m.setup_hosted_body()}</AlertDescription>
              </Alert>
              <div className="flex flex-wrap gap-2">
                <Button asChild>
                  <a href={`${config.basePath}/signup`}>{m.setup_hosted_action()}</a>
                </Button>
                <Button asChild variant="outline">
                  <a href={`${config.basePath}/login`}>{m.setup_complete_action()}</a>
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : complete ? (
          <Card>
            <CardContent className="space-y-4 pt-6">
              <Alert variant="success">
                <AlertTitle>{m.setup_complete_title()}</AlertTitle>
                <AlertDescription>{m.setup_complete_body()}</AlertDescription>
              </Alert>
              <Button asChild>
                <a href={`${config.basePath}/login`}>{m.setup_complete_action()}</a>
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-6 md:grid-cols-[12rem_1fr]">
            <nav aria-label={m.setup_steps_label()}>
              <ol className="space-y-1 text-sm">
                {steps.map((s, i) => (
                  <li
                    key={s}
                    aria-current={s === step ? "step" : undefined}
                    className={cn(
                      "flex items-center gap-2 rounded px-2 py-1",
                      s === step && "bg-background font-medium shadow-sm",
                      i > current && "text-muted-foreground",
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "flex size-5 items-center justify-center rounded-full border text-xs",
                        i < current && "border-primary bg-primary text-primary-foreground",
                      )}
                    >
                      {i < current ? <Check className="size-3" /> : i + 1}
                    </span>
                    {stepLabel(s)}
                  </li>
                ))}
              </ol>
            </nav>
            <Card>
              <CardContent className="pt-6">
                {status.isPending ? <LoadingState label={m.common_loading()} /> : null}
                {held ? (
                  <div className="space-y-6">
                    <UnderReview
                      onCheck={() => void status.refetch()}
                      checking={status.isFetching}
                    />
                    {secureWhileHeld ? (
                      <SecureStep
                        passwordEnabled={config.auth.methods.includes("password")}
                        onNext={() => {
                          setSecureWhileHeld(false);
                          void afterSecure();
                        }}
                        stepUpReturn={stepUpReturn}
                        stepped={steppedUnverified}
                        onFinished={() => setSecureFinished(true)}
                      />
                    ) : null}
                  </div>
                ) : status.isError ? (
                  <ErrorAlert error={status.error} />
                ) : null}
                {status.data ? (
                  <>
                    {step === "token" ? (
                      <TokenStep
                        status={status.data}
                        token={token}
                        onToken={setToken}
                        onNext={() => setStep("owner")}
                      />
                    ) : null}
                    {step === "owner" ? (
                      <OwnerStep
                        status={status.data}
                        token={token}
                        onCreated={(o) => {
                          setOwner(o);
                          setToken("");
                          setStep("secure");
                        }}
                      />
                    ) : null}
                    {step === "secure" ? (
                      <SecureStep
                        passwordEnabled={status.data.passwordEnabled === true}
                        onNext={() => void afterSecure()}
                        onSkip={skipSecure}
                        stepUpReturn={stepUpReturn}
                        stepped={steppedUnverified}
                        onFinished={() => setSecureFinished(true)}
                      />
                    ) : null}
                    {step === "mail" ? (
                      <MailStep
                        status={status.data}
                        onNext={advance}
                        onSecure={() => setStep("secure")}
                      />
                    ) : null}
                    {step === "storage" ? (
                      <StorageStep status={status.data} onNext={advance} />
                    ) : null}
                    {step === "company" ? (
                      <CompanyStep onNext={advance} onSecure={() => setStep("secure")} />
                    ) : null}
                    {step === "offering" ? (
                      <OfferingStep onNext={advance} onSecure={() => setStep("secure")} />
                    ) : null}
                    {step === "domain" ? (
                      <DomainStep onNext={advance} onSecure={() => setStep("secure")} />
                    ) : null}
                    {step === "modules" ? (
                      <ModulesStep onNext={advance} onSecure={() => setStep("secure")} />
                    ) : null}
                    {step === "dataroom" ? (
                      <DataRoomStep onNext={advance} onSecure={() => setStep("secure")} />
                    ) : null}
                    {step === "invites" ? (
                      <InvitesStep onNext={advance} onSecure={() => setStep("secure")} />
                    ) : null}
                    {step === "update" ? (
                      <UpdateStep onNext={advance} onSecure={() => setStep("secure")} />
                    ) : null}
                    {step === "done" ? <DoneStep owner={owner} status={status.data} /> : null}
                  </>
                ) : null}
              </CardContent>
            </Card>
          </div>
        )}
      </main>
      <FooterLinks className="mx-auto w-full max-w-2xl py-2" center hostLinks />
    </div>
  );
}

/**
 * A-5 D7: a 423 `workspace_unavailable` while the new workspace is held for its check
 * (`pending_review`). The status the server names wins; an older server's refusal without one
 * falls back to what the page config said when it loaded.
 */
function underReview(error: unknown, config: WebConfig): boolean {
  if (!isCode(error, "workspace_unavailable") || !isApiError(error)) return false;
  const envelope = error.body.error as Record<string, unknown>;
  const nested = envelope["details"];
  const details =
    typeof nested === "object" && nested !== null ? (nested as Record<string, unknown>) : envelope;
  const status = details["workspaceStatus"];
  if (status !== undefined) return status === "pending_review";
  return config.workspaceStatus?.status === "pending_review";
}

/**
 * The held workspace, said plainly (never what the check is), with the one useful action: ask
 * again. Billing is the one admin page a held workspace serves, so it is offered when the viewer
 * may open it.
 */
function UnderReview({ onCheck, checking = false }: { onCheck: () => void; checking?: boolean }) {
  const billing = useCanSeeBilling();
  return (
    <Alert>
      <ShieldCheck aria-hidden="true" />
      <AlertTitle>{m.setup_under_review_title()}</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>{workspaceStatusSentence({ status: "pending_review", reason: null }, { billing })}</p>
        <div className="flex flex-wrap items-center gap-4">
          <Button type="button" size="sm" loading={checking} onClick={onCheck}>
            {m.setup_under_review_check()}
          </Button>
          <BillingLinkIfAllowed />
        </div>
      </AlertDescription>
    </Alert>
  );
}

function StepHeading({ title, body }: { title: string; body: string }) {
  return (
    <div className="mb-4 space-y-1">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="text-sm text-muted-foreground">{body}</p>
    </div>
  );
}

/**
 * What every step after `storage` shows when the server refuses it. `step_up_required` gets the
 * one answer that helps — go back and add a second factor — rather than the generic error card
 * or, worse, a redirect to the standalone step-up screen, which would abandon the wizard.
 */
function StepError({
  error,
  onSecure,
  onSkip,
}: {
  error: unknown;
  onSecure: () => void;
  /** Omitted when the step already offers its own skip, so there are never two. */
  onSkip?: (() => void) | undefined;
}) {
  const config = useWebConfig();
  const queryClient = useQueryClient();
  return (
    <div className="space-y-4">
      {underReview(error, config) ? (
        // Asks every query again: the step's own reads come back once the hold is lifted.
        <UnderReview onCheck={() => void queryClient.invalidateQueries()} />
      ) : isCode(error, "step_up_required") ? (
        <Alert variant="warning">
          <ShieldCheck aria-hidden="true" />
          <AlertTitle>{m.setup_step_up_title()}</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>{m.setup_step_up_body()}</p>
            <Button type="button" size="sm" onClick={onSecure}>
              {m.setup_step_up_action()}
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <ErrorAlert error={error} />
      )}
      {onSkip === undefined ? null : (
        <Button type="button" variant="ghost" onClick={onSkip}>
          {m.setup_skip()}
        </Button>
      )}
    </div>
  );
}

function TokenStep({
  status,
  token,
  onToken,
  onNext,
}: {
  status: SetupStatus;
  token: string;
  onToken: (t: string) => void;
  onNext: () => void;
}) {
  const id = useId();
  const verify = useMutation({
    mutationFn: (t: string) => call(api().POST("/setup/token/verify", { body: { token: t } })),
    onSuccess: onNext,
  });
  const inline = verify.isError && isCode(verify.error, "invalid_credential");
  return (
    <form
      className="space-y-4"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (token.trim().length >= 16) verify.mutate(token.trim());
      }}
    >
      <StepHeading
        title={m.setup_token_title()}
        body={status.tokenSource === "env" ? m.setup_token_body_env() : m.setup_token_body_logs()}
      />
      {verify.isError && !inline ? <ErrorAlert error={verify.error} /> : null}
      <Field
        id={id}
        label={m.setup_token_label()}
        required
        description={m.setup_token_hint()}
        error={inline ? m.setup_token_invalid() : undefined}
      >
        <Input
          id={id}
          value={token}
          onChange={(e) => onToken(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          required
          minLength={16}
          className="font-mono"
          {...fieldAria(id, { description: true, error: inline })}
        />
      </Field>
      <Button type="submit" loading={verify.isPending} disabled={token.trim().length < 16}>
        {m.common_continue()}
      </Button>
    </form>
  );
}

function slugPreview(name: string): string {
  return (
    name
      .normalize("NFKD")
      .replace(/[̀-ͯ]/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 63)
      .replace(/-+$/u, "") || "workspace"
  );
}

function OwnerStep({
  status,
  token,
  onCreated,
}: {
  status: SetupStatus;
  token: string;
  onCreated: (owner: Owner) => void;
}) {
  const config = useWebConfig();
  const queryClient = useQueryClient();
  const ids = { name: useId(), email: useId(), workspace: useId() };
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const create = useMutation({
    mutationFn: () =>
      call(
        api().POST("/setup/owner", {
          body: {
            token,
            email,
            displayName: displayName.trim(),
            workspaceName: workspaceName.trim(),
          },
        }),
      ),
    onSuccess: async (data) => {
      await refreshSession(queryClient);
      // The owner's session now earns the full status (drivers, probes, progress: ZAP-04).
      void queryClient.invalidateQueries({ queryKey: ["setup", "status"] });
      onCreated(data);
    },
  });
  const conflict = create.isError && isCode(create.error, "conflict");
  return (
    <form
      className="space-y-4"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <StepHeading title={m.setup_owner_title()} body={m.setup_owner_body()} />
      {create.isError ? <ErrorAlert error={create.error} /> : null}
      <Field id={ids.name} label={m.setup_owner_name()} required>
        <Input
          id={ids.name}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          autoComplete="name"
          required
          maxLength={120}
        />
      </Field>
      <Field
        id={ids.email}
        label={m.setup_owner_email()}
        required
        description={m.setup_owner_email_hint()}
      >
        <Input
          id={ids.email}
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          required
          {...fieldAria(ids.email, { description: true })}
        />
      </Field>
      <Field
        id={ids.workspace}
        label={m.setup_owner_workspace()}
        required
        description={m.setup_owner_workspace_hint({
          slug: slugPreview(workspaceName),
          host: new URL(portalUrl(status, config)).host,
        })}
        error={conflict ? m.setup_owner_slug_taken() : undefined}
      >
        <Input
          id={ids.workspace}
          value={workspaceName}
          onChange={(e) => setWorkspaceName(e.target.value)}
          autoComplete="organization"
          required
          maxLength={120}
          {...fieldAria(ids.workspace, { description: true, error: conflict })}
        />
      </Field>
      <Button type="submit" loading={create.isPending}>
        {m.setup_owner_submit()}
      </Button>
    </form>
  );
}

function MailStep({
  status,
  onNext,
  onSecure,
}: {
  status: SetupStatus;
  onNext: () => void;
  onSecure: () => void;
}) {
  const send = useMutation({
    mutationFn: () => call(api().POST("/setup/probes/mail", { body: {} })),
  });
  return (
    <div className="space-y-4">
      <StepHeading
        title={m.setup_mail_title()}
        body={m.setup_mail_body({ driver: status.drivers?.mail ?? "…" })}
      />
      {send.isError ? <StepError error={send.error} onSecure={onSecure} /> : null}
      {send.isSuccess ? (
        <Alert variant="success">
          <AlertTitle>{m.setup_probe_passed()}</AlertTitle>
          <AlertDescription>
            {m.setup_mail_sent({ ms: String(send.data.latencyMs) })}
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" loading={send.isPending} onClick={() => send.mutate()}>
          <Mail aria-hidden="true" />
          {m.setup_mail_action()}
        </Button>
        <Button type="button" variant={send.isSuccess ? "default" : "ghost"} onClick={onNext}>
          {send.isSuccess ? m.common_continue() : m.setup_skip()}
        </Button>
      </div>
    </div>
  );
}

function StorageStep({ status, onNext }: { status: SetupStatus; onNext: () => void }) {
  const run = useMutation({
    mutationFn: () => call(api().POST("/setup/probes/storage")),
  });
  return (
    <div className="space-y-4">
      <StepHeading
        title={m.setup_storage_title()}
        body={m.setup_storage_body({ driver: status.drivers?.storage ?? "…" })}
      />
      {run.isError ? <ErrorAlert error={run.error} /> : null}
      {run.isSuccess ? (
        <Alert variant="success">
          <AlertTitle>{m.setup_probe_passed()}</AlertTitle>
          <AlertDescription>
            {m.setup_storage_ok({ ms: String(run.data.latencyMs) })}
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" loading={run.isPending} onClick={() => run.mutate()}>
          <HardDrive aria-hidden="true" />
          {m.setup_storage_action()}
        </Button>
        <Button type="button" variant={run.isSuccess ? "default" : "ghost"} onClick={onNext}>
          {run.isSuccess ? m.common_continue() : m.setup_skip()}
        </Button>
      </div>
    </div>
  );
}

// --- company basics (design/03 §5 step 2) ----------------------------------------------------

function CompanyStep({ onNext, onSecure }: { onNext: () => void; onSecure: () => void }) {
  const branding = useQuery({ ...brandingQuery, retry: false });
  return (
    <div className="space-y-4">
      <StepHeading title={m.setup_company_title()} body={m.setup_company_body()} />
      {branding.isPending ? <LoadingState lines={5} label={m.common_loading()} /> : null}
      {branding.isError ? (
        <StepError error={branding.error} onSecure={onSecure} onSkip={onNext} />
      ) : null}
      {branding.data ? <CompanyForm branding={branding.data} onNext={onNext} /> : null}
    </div>
  );
}

function CompanyForm({ branding, onNext }: { branding: Branding; onNext: () => void }) {
  const base = useId();
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = useState(branding.displayName ?? "");
  const [tagline, setTagline] = useState(branding.tagline ?? "");
  const [accentColor, setAccentColor] = useState(branding.accentColor ?? "");

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["branding"] });
    void queryClient.invalidateQueries({ queryKey: ["setup", "status"] });
  };
  const save = useMutation({
    mutationFn: () =>
      call(
        api().PATCH("/branding", {
          body: {
            displayName: displayName.trim() === "" ? null : displayName.trim(),
            tagline: tagline.trim() === "" ? null : tagline.trim(),
            accentColor: accentColor === "" ? null : accentColor,
          },
        }),
      ),
    onSuccess: () => {
      invalidate();
      onNext();
    },
  });
  // Two ways in, one outcome: the bytes are sniffed server-side either way, and the fetch is
  // the SSRF-guarded one — the browser never talks to the founder's website itself.
  const upload = useMutation<unknown, unknown, File>({
    mutationFn: async (file) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const contentType = isLogoType(file.type) ? { contentType: file.type } : {};
      return call(api().POST("/branding/logo", { body: { data: base64(bytes), ...contentType } }));
    },
    onSuccess: invalidate,
  });
  const fetchLogo = useMutation<unknown, unknown, string>({
    mutationFn: (url) => call(api().POST("/branding/logo/fetch", { body: { url } })),
    onSuccess: invalidate,
  });

  const logoError = upload.isError ? upload.error : fetchLogo.isError ? fetchLogo.error : undefined;
  return (
    <>
      <form
        className="space-y-4"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        {save.isError ? <ErrorAlert error={save.error} /> : null}
        <Field
          id={`${base}-name`}
          label={m.brand_field_display_name()}
          description={m.brand_field_display_name_hint({ fallback: branding.effectiveName })}
        >
          <Input
            id={`${base}-name`}
            value={displayName}
            maxLength={80}
            onChange={(e) => setDisplayName(e.target.value)}
            {...fieldAria(`${base}-name`, { description: true })}
          />
        </Field>
        <Field
          id={`${base}-tagline`}
          label={m.brand_field_tagline()}
          description={m.brand_field_tagline_hint()}
        >
          <Input
            id={`${base}-tagline`}
            value={tagline}
            maxLength={140}
            onChange={(e) => setTagline(e.target.value)}
            {...fieldAria(`${base}-tagline`, { description: true })}
          />
        </Field>
        <AccentField
          id={`${base}-accent`}
          value={accentColor}
          description={m.brand_field_accent_hint()}
          onChange={setAccentColor}
        />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" loading={save.isPending}>
            <Palette aria-hidden="true" />
            {m.setup_company_submit()}
          </Button>
          <Button type="button" variant="ghost" onClick={onNext}>
            {m.setup_skip()}
          </Button>
        </div>
      </form>
      <div className="mt-6 space-y-3 border-t pt-4">
        <div>
          <h3 className="text-sm font-medium">{m.setup_company_logo_title()}</h3>
          <p className="text-sm text-muted-foreground">{m.setup_company_logo_body()}</p>
        </div>
        {logoError ? <ErrorAlert error={logoError} /> : null}
        {branding.logo === null ? (
          <p className="text-sm text-muted-foreground">{m.brand_logo_none()}</p>
        ) : (
          <img
            src={branding.logo.url}
            alt={m.brand_logo_alt({ name: branding.effectiveName })}
            className="h-12 w-auto max-w-40 object-contain"
          />
        )}
        <LogoFileButton loading={upload.isPending} onPick={(file) => upload.mutate(file)} />
        <LogoFetchForm loading={fetchLogo.isPending} onFetch={(url) => fetchLogo.mutate(url)} />
      </div>
    </>
  );
}

// --- offering mode (design/03 §5 step 3) -----------------------------------------------------

/*
 * The four modes design/03 §5 step 3 names. `informational` — the fifth status the compliance
 * kernel knows — is deliberately not offered here: it is a shading of "not raising" that only
 * makes sense once a founder has read the permissions table, and the wizard is not where that
 * reading happens. Admin → Legal offers all five.
 */
const WIZARD_OFFERING = ["none", "506b", "506c", "non_us"] as const;

function offeringExplanation(status: (typeof WIZARD_OFFERING)[number]): string {
  switch (status) {
    case "none":
      return m.setup_offering_none_body();
    case "506b":
      return m.setup_offering_506b_body();
    case "506c":
      return m.setup_offering_506c_body();
    case "non_us":
      return m.setup_offering_non_us_body();
  }
}

function OfferingStep({ onNext, onSecure }: { onNext: () => void; onSecure: () => void }) {
  // Reading the offering is what opens the first period, which is exactly the fact
  // `GET /setup/status` reports as `progress.offering`; there is nothing else to prime.
  const offering = useQuery({ ...offeringQuery, retry: false });
  return (
    <div className="space-y-4">
      <StepHeading title={m.setup_offering_title()} body={m.setup_offering_body()} />
      {offering.isPending ? <LoadingState lines={5} label={m.common_loading()} /> : null}
      {offering.isError ? (
        <StepError error={offering.error} onSecure={onSecure} onSkip={onNext} />
      ) : null}
      {offering.data ? (
        <OfferingForm state={offering.data} onNext={onNext} onSecure={onSecure} />
      ) : null}
    </div>
  );
}

function OfferingForm({
  state,
  onNext,
  onSecure,
}: {
  state: OfferingState;
  onNext: () => void;
  onSecure: () => void;
}) {
  const group = useId();
  const queryClient = useQueryClient();
  const [choice, setChoice] = useState<OfferingStatus>(
    WIZARD_OFFERING.find((s) => s === state.status) ?? "none",
  );
  const [confirming, setConfirming] = useState<OfferingStatus | null>(null);
  const change = useMutation<unknown, unknown, { status: OfferingStatus; confirm: boolean }>({
    mutationFn: (v) =>
      call(
        api().PATCH("/compliance/offering", {
          body: { status: v.status, ...(v.confirm ? { confirm: v.status } : {}) },
        }),
      ),
    onSuccess: () => {
      setConfirming(null);
      void queryClient.invalidateQueries({ queryKey: ["compliance"] });
      void queryClient.invalidateQueries({ queryKey: ["setup", "status"] });
      onNext();
    },
    // The confirm round trip: switching to 506(c) answers 409 until the caller echoes the
    // status back, because general solicitation cannot be un-rung (ADR-0037 decision 2).
    onError: (error, variables) => {
      if (requiresConfirmation(error)) setConfirming(variables.status);
    },
  });

  // Never offer a way off 506(c): the server refuses it outright, and an affordance that
  // always fails is worse than no affordance.
  if (state.status === "506c") {
    return (
      <div className="space-y-4">
        <Alert variant="warning">
          <Scale aria-hidden="true" />
          <AlertTitle>{m.offering_irrevocable_title()}</AlertTitle>
          <AlertDescription>{m.setup_offering_locked()}</AlertDescription>
        </Alert>
        <Button type="button" onClick={onNext}>
          {m.common_continue()}
        </Button>
      </div>
    );
  }

  const failed = change.isError && !requiresConfirmation(change.error);
  return (
    <form
      className="space-y-4"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        change.mutate({ status: choice, confirm: false });
      }}
    >
      {failed ? (
        <StepError error={change.error} onSecure={onSecure} onSkip={onNext} />
      ) : (
        <>
          <p className="text-sm">
            {m.setup_offering_current({ status: offeringStatusLabel(state.status) })}
          </p>
          <fieldset className="space-y-2">
            <legend className="sr-only">{m.setup_offering_legend()}</legend>
            {WIZARD_OFFERING.map((status) => (
              <label
                key={status}
                htmlFor={`${group}-${status}`}
                className={cn(
                  "flex cursor-pointer gap-3 rounded-md border p-3 text-sm",
                  choice === status && "border-primary bg-muted/50",
                )}
              >
                <input
                  type="radio"
                  id={`${group}-${status}`}
                  name={group}
                  className="mt-1 size-4 shrink-0"
                  value={status}
                  checked={choice === status}
                  onChange={() => {
                    setChoice(status);
                    setConfirming(null);
                  }}
                />
                <span>
                  <span className="block font-medium">{offeringStatusLabel(status)}</span>
                  <span className="block text-muted-foreground">{offeringExplanation(status)}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {choice === "506c" ? (
            // Said before the click, not after it.
            <Alert variant="warning">
              <AlertTitle>{m.offering_506c_warning_title()}</AlertTitle>
              <AlertDescription>{m.offering_506c_warning_body()}</AlertDescription>
            </Alert>
          ) : null}
          <Alert>
            <Scale aria-hidden="true" />
            <AlertTitle>{m.legal_not_advice_title()}</AlertTitle>
            <AlertDescription>{m.legal_not_advice_body()}</AlertDescription>
          </Alert>
          {confirming === null ? (
            <div className="flex flex-wrap gap-2">
              <Button type="submit" loading={change.isPending}>
                {m.setup_offering_submit()}
              </Button>
              <Button type="button" variant="ghost" onClick={onNext}>
                {m.setup_skip()}
              </Button>
            </div>
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
                    onClick={() => change.mutate({ status: confirming, confirm: true })}
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
        </>
      )}
    </form>
  );
}

// --- portal address (design/03 §5 step 4, E2.1 §9.4) -----------------------------------------

const DOMAIN_CHOICES = ["subdomain", "custom", "embed"] as const;
type DomainChoice = (typeof DOMAIN_CHOICES)[number];

/**
 * The step design/03 §5 asked for and E1.7 could not honestly build: three answers, of which
 * two are "nothing to do here".
 *
 * It is deliberately **not** in `resumeStep`. Most portals never want a custom domain — a
 * founder on the subdomain is finished, and one embedding the portal (E2.2) is finished twice
 * over — so a kernel fact for "has a domain" would resume every one of them here forever. That
 * is exactly the `hasBrand` bug E1.7 shipped and had to take back out.
 *
 * Plain `useMutation`, not `useGuardedMutation`: adding a domain needs fresh auth, and bouncing
 * the founder to the standalone step-up screen mid-wizard would abandon the steps behind them.
 * `StepError` sends them to the wizard's own security step instead.
 */
function DomainStep({ onNext, onSecure }: { onNext: () => void; onSecure: () => void }) {
  const config = useWebConfig();
  const enablement = useQuery({ ...moduleEnablementQuery, retry: false });
  const hasUpdates = (enablement.data?.modules ?? []).some(
    (mod) => mod.id === "updates" && mod.enabled,
  );
  const queryClient = useQueryClient();
  const group = useId();
  const field = useId();
  const [choice, setChoice] = useState<DomainChoice>("subdomain");
  const [hostname, setHostname] = useState("");
  const add = useMutation({
    mutationFn: () => call(api().POST("/domains", { body: { hostname: hostname.trim() } })),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: DOMAINS_KEY });
    },
  });
  const added = add.data;
  // A refused hostname is the founder's typo, not a broken step, so it belongs on the field.
  const rejection = add.isError ? domainErrorReason(add.error) : undefined;
  return (
    <div className="space-y-4">
      <StepHeading title={m.setup_domain_title()} body={m.setup_domain_body()} />
      {added === undefined ? (
        <>
          {add.isError && rejection === undefined ? (
            <StepError error={add.error} onSecure={onSecure} onSkip={onNext} />
          ) : null}
          <fieldset className="space-y-2">
            <legend className="sr-only">{m.setup_domain_legend()}</legend>
            {DOMAIN_CHOICES.map((option) => (
              <label
                key={option}
                htmlFor={`${group}-${option}`}
                className={cn(
                  "flex cursor-pointer gap-3 rounded-md border p-3 text-sm",
                  choice === option && "border-primary bg-muted/50",
                )}
              >
                <input
                  type="radio"
                  id={`${group}-${option}`}
                  name={group}
                  className="mt-1 size-4 shrink-0"
                  value={option}
                  checked={choice === option}
                  onChange={() => setChoice(option)}
                />
                <span>
                  <span className="block font-medium">{domainChoiceLabel(option)}</span>
                  <span className="block text-muted-foreground">
                    {domainChoiceHelp(option, config.canonicalOrigin)}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          {choice === "custom" ? (
            <form
              className="space-y-4"
              onSubmit={(e: FormEvent) => {
                e.preventDefault();
                if (hostname.trim() !== "") add.mutate();
              }}
            >
              <Field
                id={field}
                label={m.domains_field()}
                description={m.domains_field_help()}
                error={rejection === undefined ? undefined : describeDomainError(add.error)}
              >
                <Input
                  id={field}
                  value={hostname}
                  placeholder="investors.example.com"
                  autoComplete="off"
                  onChange={(e) => setHostname(e.target.value)}
                />
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" loading={add.isPending} disabled={hostname.trim() === ""}>
                  {m.domains_add()}
                </Button>
                <Button type="button" variant="ghost" onClick={onNext}>
                  {m.setup_skip()}
                </Button>
              </div>
            </form>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={onNext}>
                {m.common_continue()}
              </Button>
            </div>
          )}
          <p className="text-sm text-muted-foreground">{m.setup_domain_later()}</p>
        </>
      ) : (
        <>
          <Alert variant="success">
            <AlertTitle>{added.hostname}</AlertTitle>
            <AlertDescription>{m.setup_domain_added()}</AlertDescription>
          </Alert>
          <DomainRecordsTable domain={added} />
          <Button type="button" onClick={onNext}>
            {m.common_continue()}
          </Button>
        </>
      )}
      {/*
       * The sending domain is a different record set with its own states (E2.1 decision 2), and
       * E1.4 already built that screen — so this points at it rather than growing a second DKIM
       * form inside the wizard. In a new tab, because a half-finished wizard is not somewhere to
       * navigate away from, and only when the module is on: the modules step comes after this
       * one, so `updates` may yet be switched off.
       */}
      {hasUpdates ? (
        <p className="text-sm text-muted-foreground">
          {m.domains_sending_note()}{" "}
          <a
            href={`${config.basePath}/admin/updates/settings`}
            target="_blank"
            rel="noreferrer noopener"
            // Persistently underlined, not `hover:underline`: this link sits inside a
            // `text-muted-foreground` paragraph, where `text-primary` alone is a 1.4:1
            // difference against the surrounding text — under 3:1, so colour is not
            // distinguishing it (WCAG 2.2 AA 1.4.1, axe `link-in-text-block`). jsdom cannot
            // see this because it computes no colours; real-browser axe in the e2e suite can.
            className="text-primary underline underline-offset-4"
          >
            {m.domains_sending_link()}
          </a>
        </p>
      ) : null}
    </div>
  );
}

function domainChoiceLabel(choice: DomainChoice): string {
  switch (choice) {
    case "custom":
      return m.setup_domain_custom_label();
    case "embed":
      return m.setup_domain_embed_label();
    default:
      return m.setup_domain_subdomain_label();
  }
}

function domainChoiceHelp(choice: DomainChoice, origin: string): string {
  switch (choice) {
    case "custom":
      return m.setup_domain_custom_help();
    case "embed":
      return m.setup_domain_embed_help();
    default:
      return m.setup_domain_subdomain_help({ origin });
  }
}

// --- modules (design/03 §5 step 5) -----------------------------------------------------------

function ModulesStep({ onNext, onSecure }: { onNext: () => void; onSecure: () => void }) {
  const modules = useQuery({ ...moduleEnablementQuery, retry: false });
  return (
    <div className="space-y-4">
      <StepHeading title={m.setup_modules_title()} body={m.setup_modules_body()} />
      {modules.isPending ? <LoadingState lines={5} label={m.common_loading()} /> : null}
      {modules.isError ? (
        <StepError error={modules.error} onSecure={onSecure} onSkip={onNext} />
      ) : null}
      {modules.data ? (
        modules.data.modules.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m.modules_empty()}</p>
        ) : (
          <ul className="divide-y">
            {modules.data.modules.map((mod) => (
              <ModuleToggle key={mod.id} module={mod} />
            ))}
          </ul>
        )
      ) : null}
      {modules.isError ? null : (
        <Button type="button" onClick={onNext}>
          {m.common_continue()}
        </Button>
      )}
    </div>
  );
}

function ModuleToggle({ module }: { module: ModuleEnablement }) {
  const id = useId();
  const switchRef = useRef<HTMLButtonElement>(null);
  const [confirming, setConfirming] = useState(false);
  const queryClient = useQueryClient();
  const toggle = useMutation<unknown, unknown, boolean>({
    mutationFn: (enabled) =>
      call(
        api().PATCH("/modules/{id}", { params: { path: { id: module.id } }, body: { enabled } }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["modules"] });
      void queryClient.invalidateQueries({ queryKey: ["bootstrap"] });
    },
    // Say why, as the modules page does (a 402 names the module the plan leaves out), and
    // reload the list: a refusal usually means it was stale (the plan changed meanwhile).
    onError: (error) => {
      toast.error(describeError(error).title);
      void queryClient.invalidateQueries({ queryKey: ["modules"] });
    },
  });
  // Locked rows stay visible and carry their reason: "the data room is on because updates
  // needs it" is the answer to the question, and hiding the row would hide the answer. A-3: so
  // do modules the plan leaves out (greyed, with the way to Billing) or keeps read-only.
  const unavailable = module.locked || toggle.isPending;
  const badges = moduleBadges(module);
  return (
    <li className="flex flex-wrap items-center gap-3 py-3">
      <Switch
        ref={switchRef}
        id={id}
        checked={module.enabled}
        // Unavailable, not disabled: stays focusable (R3 L2 / RR3 RL3, see UNAVAILABLE_SWITCH_CLASS).
        aria-disabled={unavailable || undefined}
        aria-describedby={badges.length > 0 ? `${id}-state` : undefined}
        className={UNAVAILABLE_SWITCH_CLASS}
        onCheckedChange={(on) => {
          if (unavailable) return;
          if (on !== true && module.readOnly) setConfirming(true);
          else toggle.mutate(on === true);
        }}
      />
      <div className="min-w-0 flex-1">
        <Label htmlFor={id} className="font-medium">
          {module.id}
        </Label>
        {module.dependsOn.length > 0 ? (
          <p className="text-sm text-muted-foreground">
            {m.modules_depends_on({ list: module.dependsOn.join(", ") })}
          </p>
        ) : null}
      </div>
      {badges.length > 0 ? (
        <span id={`${id}-state`} className="flex flex-wrap gap-2">
          {badges.map((badge) => (
            <Badge key={badge} variant="secondary">
              {badge}
            </Badge>
          ))}
        </span>
      ) : null}
      {isPlanLocked(module) ? <BillingLinkIfAllowed /> : null}
      <DisableReadOnlyModuleDialog
        moduleId={module.id}
        open={confirming}
        onOpenChange={setConfirming}
        onConfirm={() => toggle.mutate(false)}
        returnFocusTo={switchRef}
      />
    </li>
  );
}

// --- data-room folder template (design/03 §5 step 7) -----------------------------------------

function DataRoomStep({ onNext, onSecure }: { onNext: () => void; onSecure: () => void }) {
  const templates = useQuery({ ...dataRoomTemplatesQuery, retry: false });
  const group = useId();
  const [choice, setChoice] = useState<string | undefined>();
  const apply = useMutation<unknown, unknown, string>({
    mutationFn: (id) =>
      call(api().POST("/data-room/templates/{id}/apply", { params: { path: { id } }, body: {} })),
  });
  const picked = choice ?? templates.data?.templates[0]?.id;
  return (
    <div className="space-y-4">
      <StepHeading title={m.setup_dataroom_title()} body={m.setup_dataroom_body()} />
      {templates.isPending ? <LoadingState lines={4} label={m.common_loading()} /> : null}
      {templates.isError ? (
        <StepError error={templates.error} onSecure={onSecure} onSkip={onNext} />
      ) : null}
      {apply.isError ? <StepError error={apply.error} onSecure={onSecure} /> : null}
      {apply.isSuccess ? (
        <Alert variant="success">
          <AlertTitle>{m.setup_probe_passed()}</AlertTitle>
          <AlertDescription>
            {m.setup_dataroom_applied({
              count: String((apply.data as { created: number }).created),
            })}
          </AlertDescription>
        </Alert>
      ) : null}
      {templates.data ? (
        templates.data.templates.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m.setup_dataroom_empty()}</p>
        ) : (
          <fieldset className="space-y-2">
            <legend className="sr-only">{m.setup_dataroom_legend()}</legend>
            {templates.data.templates.map((t) => (
              <label
                key={t.id}
                htmlFor={`${group}-${t.id}`}
                className={cn(
                  "flex cursor-pointer gap-3 rounded-md border p-3 text-sm",
                  picked === t.id && "border-primary bg-muted/50",
                )}
              >
                <input
                  type="radio"
                  id={`${group}-${t.id}`}
                  name={group}
                  className="mt-1 size-4 shrink-0"
                  value={t.id}
                  checked={picked === t.id}
                  onChange={() => setChoice(t.id)}
                />
                <span>
                  <span className="block font-medium">{t.name}</span>
                  <span className="block text-muted-foreground">{t.description}</span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {t.folders.slice(0, 6).join(" · ")}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
        )
      ) : null}
      <div className="flex flex-wrap gap-2">
        {picked === undefined || apply.isSuccess ? null : (
          <Button type="button" loading={apply.isPending} onClick={() => apply.mutate(picked)}>
            <FolderTree aria-hidden="true" />
            {m.setup_dataroom_apply()}
          </Button>
        )}
        <Button type="button" variant={apply.isSuccess ? "default" : "ghost"} onClick={onNext}>
          {apply.isSuccess ? m.common_continue() : m.setup_skip()}
        </Button>
      </div>
    </div>
  );
}

// --- invitations (design/03 §5 step 8) -------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/** Split on commas, semicolons and newlines; de-duplicate case-insensitively, keep the order. */
export function parseInviteEmails(raw: string): { valid: string[]; invalid: string[] } {
  const seen = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const part of raw.split(/[\s,;]+/u)) {
    const entry = part.trim();
    if (entry === "") continue;
    const key = entry.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (EMAIL_RE.test(entry)) valid.push(entry);
    else invalid.push(entry);
  }
  return { valid, invalid };
}

type InviteResult = FundRoomSchemas["InviteCreateResult"];

function InvitesStep({ onNext, onSecure }: { onNext: () => void; onSecure: () => void }) {
  const id = useId();
  const [raw, setRaw] = useState("");
  const { valid, invalid } = useMemo(() => parseInviteEmails(raw), [raw]);
  const send = useMutation<InviteResult, unknown, string[]>({
    mutationFn: (emails) =>
      call(
        api().POST("/access/invites", {
          body: {
            invites: emails.map((email) => ({ email })),
            kind: "external" as const,
            role: "investor" as const,
          },
        }),
      ),
  });
  return (
    <div className="space-y-4">
      <StepHeading title={m.setup_invites_title()} body={m.setup_invites_body()} />
      {send.isError ? <StepError error={send.error} onSecure={onSecure} /> : null}
      {send.data ? (
        <>
          <Alert variant="success">
            <AlertTitle>{m.setup_probe_passed()}</AlertTitle>
            <AlertDescription>
              {m.setup_invites_sent({ count: String(send.data.created.length) })}
            </AlertDescription>
          </Alert>
          {/*
           * `POST /access/invites` is per-address: some land, some do not, and the founder is
           * owed the list rather than a cheerful total. `conflict` is the common one and says
           * something useful (they are already here), so it gets its own sentence.
           */}
          {send.data.failed.length === 0 ? null : (
            <Alert variant="warning">
              <AlertTitle>{m.setup_invites_failed_title()}</AlertTitle>
              <AlertDescription>
                <ul className="list-disc space-y-1 pl-5">
                  {send.data.failed.map((f) => (
                    <li key={f.email}>
                      {f.email} —{" "}
                      {f.code === "conflict"
                        ? m.setup_invites_failed_conflict()
                        : m.setup_invites_failed_other({ code: f.code })}
                    </li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}
        </>
      ) : null}
      {send.isSuccess ? null : (
        <form
          className="space-y-4"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (valid.length > 0) send.mutate(valid);
          }}
        >
          <Field id={id} label={m.setup_invites_label()}>
            <Textarea
              id={id}
              rows={5}
              value={raw}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setRaw(e.target.value)}
            />
          </Field>
          {valid.length > 0 ? (
            <p className="text-sm">{m.setup_invites_preview({ count: String(valid.length) })}</p>
          ) : null}
          {invalid.length > 0 ? (
            <p className="text-sm text-destructive">
              {m.setup_invites_invalid({ list: invalid.join(", ") })}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" loading={send.isPending} disabled={valid.length === 0}>
              <UserPlus aria-hidden="true" />
              {m.setup_invites_submit()}
            </Button>
            <Button type="button" variant="ghost" onClick={onNext}>
              {m.setup_skip()}
            </Button>
          </div>
        </form>
      )}
      {send.isSuccess ? (
        <Button type="button" onClick={onNext}>
          {m.common_continue()}
        </Button>
      ) : null}
    </div>
  );
}

// --- first update (design/03 §5 step 9) ------------------------------------------------------

/*
 * The only step in the wizard that is not idempotent: posting twice makes two drafts. Two
 * guards, because a reload and a double-click are different bugs. Existing posts are read
 * first, and any at all means the wizard offers no form — a resumed wizard cannot re-create
 * what it created a minute ago. Within one visit the form disappears the moment a draft comes
 * back, and the button is disabled while the request is in flight.
 */
function UpdateStep({ onNext, onSecure }: { onNext: () => void; onSecure: () => void }) {
  const ids = { title: useId(), template: useId() };
  const posts = useQuery({ ...updatePostsQuery, retry: false });
  const templates = useQuery({ ...updateTemplatesQuery, retry: false });
  const [title, setTitle] = useState("");
  const [template, setTemplate] = useState("yc");
  const queryClient = useQueryClient();
  const create = useMutation({
    mutationFn: () =>
      call(
        api().POST("/updates/posts", {
          body: { title: title.trim(), template: template as "yc" },
        }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["updates"] });
    },
  });

  const existing = posts.data?.posts.length ?? 0;
  const error = posts.isError ? posts.error : templates.isError ? templates.error : undefined;
  return (
    <div className="space-y-4">
      <StepHeading title={m.setup_update_title()} body={m.setup_update_body()} />
      {posts.isPending || templates.isPending ? (
        <LoadingState lines={4} label={m.common_loading()} />
      ) : null}
      {error ? <StepError error={error} onSecure={onSecure} onSkip={onNext} /> : null}
      {create.isError ? <StepError error={create.error} onSecure={onSecure} /> : null}
      {create.data ? (
        <Alert variant="success">
          <AlertTitle>{m.setup_probe_passed()}</AlertTitle>
          <AlertDescription>
            {m.setup_update_created({ title: create.data.post.title })}
          </AlertDescription>
        </Alert>
      ) : null}
      {error === undefined && create.data === undefined && existing > 0 ? (
        <Alert>
          <AlertTitle>{m.setup_update_title()}</AlertTitle>
          <AlertDescription>
            {m.setup_update_existing({ count: String(existing) })}
          </AlertDescription>
        </Alert>
      ) : null}
      {error === undefined && create.data === undefined && existing === 0 && templates.data ? (
        <form
          className="space-y-4"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (title.trim() !== "" && !create.isPending) create.mutate();
          }}
        >
          <Field id={ids.title} label={m.setup_update_title_label()}>
            <Input
              id={ids.title}
              value={title}
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>
          <Field id={ids.template} label={m.setup_update_template_label()}>
            <NativeSelect
              id={ids.template}
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
            >
              {templates.data.templates.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" loading={create.isPending} disabled={title.trim() === ""}>
              {m.setup_update_submit()}
            </Button>
            <Button type="button" variant="ghost" onClick={onNext}>
              {m.setup_skip()}
            </Button>
          </div>
        </form>
      ) : null}
      {create.data !== undefined || (error === undefined && existing > 0) ? (
        <Button type="button" onClick={onNext}>
          {m.common_continue()}
        </Button>
      ) : null}
    </div>
  );
}

function DoneStep({ owner, status }: { owner: Owner | undefined; status: SetupStatus }) {
  const config = useWebConfig();
  const next = [m.setup_done_next_invite(), m.setup_done_next_brand(), m.setup_done_next_update()];
  const address = portalUrl(status, config);
  return (
    <div className="space-y-4">
      <StepHeading
        title={m.setup_done_title()}
        body={m.setup_done_body({ workspace: owner?.workspace.name ?? config.instanceName })}
      />
      {/*
       * The address that always works, whatever the domain step decided: a custom domain is
       * optional, may still be `pending` DNS, and is only the primary origin once it is serving.
       */}
      <div className="space-y-1 rounded-md border p-3">
        <p className="text-sm font-medium">{m.setup_done_url_title()}</p>
        <div className="flex flex-wrap items-center gap-2">
          <code className="break-all font-mono text-sm">{address}</code>
          <CopyButton value={address} label={m.common_copy()} />
        </div>
        <p className="text-sm text-muted-foreground">{m.setup_done_url_hint()}</p>
      </div>
      <Alert variant="success">
        <ShieldCheck aria-hidden="true" />
        <AlertTitle>{m.setup_done_next_title()}</AlertTitle>
        <AlertDescription>
          <ol className="list-decimal space-y-1 pl-4">
            {next.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ol>
        </AlertDescription>
      </Alert>
      {/* A full navigation: the page's WebConfig still says setupRequired. */}
      <Button asChild>
        <a href={`${config.basePath}/admin`}>{m.setup_done_action()}</a>
      </Button>
    </div>
  );
}
