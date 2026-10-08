import {
  Badge,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Field,
  fieldAria,
  Input,
  Textarea,
} from "@fundroomhq/ui";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { PLAN_FEATURES, type PlanFeature, planFeatureLabel } from "../../lib/plan-features.js";
import {
  formatLimit,
  holdLabel,
  LIMIT_KEYS,
  type LimitKey,
  limitLabel,
  orderedFeatures,
  orderedHolds,
  type PlanEntitlementCatalog,
  type PlanLimits,
  type SuspendReason,
  type WorkspaceHold,
  type WorkspaceStatus,
  workspaceStatusLabel,
  workspaceStatusVariant,
} from "../../lib/platform-queries.js";
import { m } from "../../paraglide/messages.js";

/**
 * The status, and every hold behind it as its own badge (E3.10 FR1: holds are independent — a
 * workspace suspended by an operator can also be behind on billing, and lifting one leaves the
 * other). A server without `holds` falls back to the single derived reason.
 */
export function WorkspaceStatusBadges({
  status,
  reason,
  holds,
}: {
  status: WorkspaceStatus;
  reason: SuspendReason | null;
  holds?: readonly WorkspaceHold[] | undefined;
}) {
  const shown: WorkspaceHold[] =
    holds === undefined ? (reason === null ? [] : [reason]) : badgeHolds(holds);
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge variant={workspaceStatusVariant(status)}>{workspaceStatusLabel(status)}</Badge>
      {shown.map((hold) => (
        <Badge key={hold} variant="outline">
          {m.platform_reason_badge({ reason: holdLabel(hold) })}
        </Badge>
      ))}
    </span>
  );
}

/**
 * Every hold as a badge, strongest first. `relocation` is not a hold an operator lifts (a move
 * sets and clears it), so `orderedHolds` leaves it out of the action list; it is still shown.
 */
function badgeHolds(holds: readonly WorkspaceHold[]): WorkspaceHold[] {
  const liftable: WorkspaceHold[] = orderedHolds(holds);
  if (!holds.includes("relocation")) return liftable;
  // Rank: sanctions > operator > relocation > billing (the server's suspension order).
  const at = liftable.findIndex((h) => h !== "sanctions" && h !== "operator");
  return at === -1
    ? [...liftable, "relocation"]
    : [...liftable.slice(0, at), "relocation", ...liftable.slice(at)];
}

/**
 * A confirm dialog whose action needs a written reason (suspend, unsuspend, a sanctions
 * decision). The note is required by the API and lands in the audit trail, so the confirm
 * button stays disabled until there is one, and the dialog stays open if the call fails —
 * the operator keeps what they wrote and reads the error beside it.
 */
export function NoteConfirmDialog({
  trigger,
  title,
  description,
  confirmLabel,
  noteLabel,
  noteDescription,
  destructive = false,
  onConfirm,
  pending,
  error,
  children,
}: {
  trigger: ReactNode;
  title: string;
  description: string;
  confirmLabel: string;
  noteLabel: string;
  noteDescription?: string;
  destructive?: boolean;
  onConfirm: (note: string) => Promise<unknown>;
  pending: boolean;
  /** The last failure's sentence, shown inside the dialog. */
  error?: string | undefined;
  children?: ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const trimmed = note.trim();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (trimmed === "" || pending) return;
    onConfirm(trimmed).then(
      () => {
        setOpen(false);
        setNote("");
      },
      // The caller's mutation already reports the failure (`error`); keep the dialog open.
      () => undefined,
    );
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setNote("");
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          {children}
          <Field id={id} label={noteLabel} description={noteDescription} error={error} required>
            <Textarea
              id={id}
              value={note}
              maxLength={2000}
              required
              aria-required="true"
              onChange={(e) => setNote(e.target.value)}
              {...fieldAria(id, {
                description: noteDescription !== undefined,
                error: error !== undefined,
              })}
            />
          </Field>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {m.common_cancel()}
              </Button>
            </DialogClose>
            <Button
              type="submit"
              variant={destructive ? "destructive" : "default"}
              loading={pending}
              disabled={trimmed === ""}
            >
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A plan's limits as a definition list; an absent key reads "Unlimited". The two entitlement lists
 * (A-3) follow: absent reads "All", `[]` reads "None", otherwise the module ids / feature names.
 */
export function LimitsList({ limits }: { limits: PlanLimits }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      {LIMIT_KEYS.map((key) => (
        <div key={key} className="contents">
          <dt className="text-muted-foreground">{limitLabel(key)}</dt>
          <dd>{formatLimit(key, limits[key])}</dd>
        </div>
      ))}
      <dt className="text-muted-foreground">{m.platform_plan_modules()}</dt>
      <dd>
        {entitlementText(
          limits.modules,
          (id) => id,
          // `[]`: the required modules stay on — the same words the workspace's Billing page uses.
          m.billing_plan_core_modules_only(),
        )}
      </dd>
      <dt className="text-muted-foreground">{m.platform_plan_features()}</dt>
      <dd>
        {entitlementText(
          limits.features === undefined ? undefined : orderedFeatures(limits.features),
          planFeatureLabel,
          m.platform_plan_entitlements_none(),
        )}
      </dd>
    </dl>
  );
}

function entitlementText<T extends string>(
  list: readonly T[] | undefined,
  label: (id: T) => string,
  empty: string,
): string {
  if (list === undefined) return m.platform_plan_entitlements_all_value();
  if (list.length === 0) return empty;
  return list.map(label).join(", ");
}

/**
 * One entitlement list as the form edits it (A-3, ADR-0063): `all` = the key is absent (no
 * restriction, including modules or features added in later versions); otherwise `ids` is the
 * list. `ids` is `null` until the operator first unticks "All" on a plan that had no list — the
 * checklist then starts from today's whole catalogue, ticked, and the operator unticks what the
 * plan leaves out. Unticking "All" alone therefore still changes what is stored: the plan is frozen
 * at today's catalogue, and the form says so under the checkbox.
 */
export interface EntitlementDraft<T extends string> {
  all: boolean;
  ids: T[] | null;
}
export interface EntitlementsDraft {
  modules: EntitlementDraft<string>;
  features: EntitlementDraft<PlanFeature>;
}

export function entitlementsDraft(limits: PlanLimits): EntitlementsDraft {
  return {
    modules:
      limits.modules === undefined
        ? { all: true, ids: null }
        : { all: false, ids: [...limits.modules] },
    features:
      limits.features === undefined
        ? { all: true, ids: null }
        : { all: false, ids: [...limits.features] },
  };
}

/**
 * The two list keys of `limits` from the draft — absent for "All", sorted otherwise (the order
 * the server stores). Merged over the numeric limits, so editing a number never drops a list.
 */
export function entitlementLimits(
  draft: EntitlementsDraft,
  catalog: PlanEntitlementCatalog | undefined,
): Pick<PlanLimits, "modules" | "features"> {
  const out: Pick<PlanLimits, "modules" | "features"> = {};
  if (!draft.modules.all) out.modules = [...(draft.modules.ids ?? catalog?.modules ?? [])].sort();
  if (!draft.features.all) {
    out.features = [...(draft.features.ids ?? catalog?.features ?? PLAN_FEATURES)].sort();
  }
  return out;
}

/**
 * The entitlement half of the plan form: two fieldsets, Modules and Features, each with an "All
 * (no restriction)" checkbox that, when unticked, shows a checklist from the server's catalogue
 * (features in display order). An id the plan lists that the catalogue no longer has is shown
 * too, so it can be unticked rather than silently kept.
 */
export function EntitlementsFields({
  draft,
  catalog,
  onChange,
}: {
  draft: EntitlementsDraft;
  catalog: PlanEntitlementCatalog | undefined;
  onChange: (next: EntitlementsDraft) => void;
}) {
  const moduleOptions = withExtras(catalog?.modules ?? [], draft.modules.ids);
  const featureOptions = orderedFeatures(
    withExtras<PlanFeature>(catalog?.features ?? [...PLAN_FEATURES], draft.features.ids),
  );
  return (
    <>
      <EntitlementFieldset
        loading={catalog === undefined}
        legend={m.platform_plan_modules()}
        help={m.platform_plan_modules_help()}
        frozenHint={m.platform_plan_modules_frozen()}
        draft={draft.modules}
        options={moduleOptions}
        label={(id) => id}
        mono
        onChange={(modules) => onChange({ ...draft, modules })}
      />
      <EntitlementFieldset
        loading={catalog === undefined}
        legend={m.platform_plan_features()}
        help={m.platform_plan_features_help()}
        frozenHint={m.platform_plan_features_frozen()}
        draft={draft.features}
        options={featureOptions}
        label={planFeatureLabel}
        onChange={(features) => onChange({ ...draft, features })}
      />
    </>
  );
}

function withExtras<T extends string>(options: readonly T[], ids: readonly T[] | null): T[] {
  const extras = (ids ?? []).filter((id) => !options.includes(id));
  return [...options, ...extras];
}

function EntitlementFieldset<T extends string>({
  loading,
  legend,
  help,
  frozenHint,
  draft,
  options,
  label,
  mono = false,
  onChange,
}: {
  /** The catalogue has not arrived: "All" cannot be unticked yet (the checklist would be empty). */
  loading: boolean;
  legend: string;
  help: string;
  /** Under the checkbox: an explicit list is today's ids, not "everything, later ones too". */
  frozenHint: string;
  draft: EntitlementDraft<T>;
  options: readonly T[];
  label: (id: T) => string;
  mono?: boolean;
  onChange: (next: EntitlementDraft<T>) => void;
}) {
  const helpId = useId();
  const hintId = useId();
  const pendingId = useId();
  // "All" cannot be unticked until the catalogue is here (the checklist would be empty); say so.
  const pending = loading && draft.all;
  const ids = draft.ids ?? options;
  const toggle = (id: T, on: boolean) =>
    onChange({ ...draft, ids: on ? [...ids, id] : ids.filter((x) => x !== id) });
  return (
    <fieldset className="grid gap-2" aria-describedby={helpId}>
      <legend className="mb-1 text-sm font-medium">{legend}</legend>
      <p id={helpId} className="text-sm text-muted-foreground">
        {help}
      </p>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-4"
          checked={draft.all}
          disabled={pending}
          aria-describedby={pending ? `${pendingId} ${hintId}` : hintId}
          onChange={(e) => onChange({ ...draft, all: e.target.checked })}
        />
        {m.platform_plan_entitlements_all()} <span className="sr-only">{legend}</span>
      </label>
      {pending ? (
        <p id={pendingId} className="pl-6 text-xs text-muted-foreground">
          {m.platform_plan_catalog_pending()}
        </p>
      ) : null}
      <p id={hintId} className="pl-6 text-xs text-muted-foreground">
        {frozenHint}
      </p>
      {draft.all ? null : (
        <ul className="grid gap-2 pl-6 sm:grid-cols-2">
          {options.map((id) => (
            <li key={id}>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={ids.includes(id)}
                  onChange={(e) => toggle(id, e.target.checked)}
                />
                <span className={mono ? "font-mono" : undefined}>{label(id)}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}

const GIB = 1024 ** 3;

/** One limit as the form edits it: unlimited, or a number (storage in GiB). */
export interface LimitDraft {
  unlimited: boolean;
  value: string;
}
export type LimitsDraft = Record<LimitKey, LimitDraft>;

export function limitsDraft(limits: PlanLimits): LimitsDraft {
  const out = {} as LimitsDraft;
  for (const key of LIMIT_KEYS) {
    const v = limits[key];
    out[key] =
      v === undefined
        ? { unlimited: true, value: "" }
        : { unlimited: false, value: String(key === "storageBytes" ? v / GIB : v) };
  }
  return out;
}

/** The smallest value each limit takes (the contract's `min`): seats start at 1. */
function minimumOf(key: LimitKey): number {
  return key === "staffSeats" || key === "investorSeats" ? 1 : 0;
}

/**
 * Parses the draft back into `PlanLimits`; `undefined` when a value is missing or out of range
 * (the fields are marked invalid in that case, so the form never sends a guess).
 */
export function parseLimits(draft: LimitsDraft): PlanLimits | undefined {
  const out: PlanLimits = {};
  for (const key of LIMIT_KEYS) {
    const d = draft[key];
    if (d.unlimited) continue;
    const n = Number(d.value);
    if (d.value.trim() === "" || !Number.isFinite(n) || n < minimumOf(key)) return undefined;
    if (key === "storageBytes") {
      const bytes = Math.round(n * GIB);
      if (bytes > Number.MAX_SAFE_INTEGER) return undefined;
      out[key] = bytes;
    } else {
      if (!Number.isInteger(n)) return undefined;
      out[key] = n;
    }
  }
  return out;
}

export function limitInvalid(key: LimitKey, d: LimitDraft): boolean {
  if (d.unlimited) return false;
  const n = Number(d.value);
  if (d.value.trim() === "" || !Number.isFinite(n) || n < minimumOf(key)) return true;
  return key !== "storageBytes" && !Number.isInteger(n);
}

/**
 * The limits half of the plan form: one row per limit with an "Unlimited" switch. Unlimited is
 * the absence of the key, not a big number — the server treats an absent key as no limit.
 */
export function LimitsFields({
  draft,
  onChange,
  showErrors,
}: {
  draft: LimitsDraft;
  onChange: (next: LimitsDraft) => void;
  showErrors: boolean;
}) {
  const base = useId();
  return (
    <fieldset className="grid gap-3">
      <legend className="mb-2 text-sm font-medium">{m.platform_plan_limits()}</legend>
      {LIMIT_KEYS.map((key) => {
        const d = draft[key];
        const id = `${base}-${key}`;
        const invalid = showErrors && limitInvalid(key, d);
        const label = key === "storageBytes" ? m.platform_limit_storage_gib() : limitLabel(key);
        return (
          <div key={key} className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
            <Field
              id={id}
              label={label}
              error={invalid ? m.platform_limit_invalid({ min: minimumOf(key) }) : undefined}
            >
              <Input
                id={id}
                type="number"
                inputMode={key === "storageBytes" ? "decimal" : "numeric"}
                min={minimumOf(key)}
                step={key === "storageBytes" ? "any" : 1}
                value={d.unlimited ? "" : d.value}
                disabled={d.unlimited}
                onChange={(e) => onChange({ ...draft, [key]: { ...d, value: e.target.value } })}
                {...fieldAria(id, { error: invalid })}
              />
            </Field>
            <label className="flex h-9 items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4"
                checked={d.unlimited}
                onChange={(e) =>
                  onChange({ ...draft, [key]: { ...d, unlimited: e.target.checked } })
                }
              />
              {m.platform_unlimited()} <span className="sr-only">{label}</span>
            </label>
          </div>
        );
      })}
    </fieldset>
  );
}
