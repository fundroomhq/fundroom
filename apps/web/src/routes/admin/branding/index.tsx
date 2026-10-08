import { brandTokens, contrastReport } from "@fundroom/branding";
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
  Input,
  Label,
  LoadingState,
  PageHeader,
  Separator,
  Switch,
  toast,
  useTheme,
} from "@fundroomhq/ui";
import { applyThemeTokens } from "@fundroomhq/ui/theme";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Trash2 } from "lucide-react";
import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AccentField,
  base64,
  isLogoType,
  LogoFetchForm,
  LogoFileButton,
} from "../../../components/branding/brand-controls.js";
import { NativeSelect } from "../../../components/compliance/common.js";
import { ErrorAlert } from "../../../components/error-alert.js";
import { api, call, describeError } from "../../../lib/api.js";
import {
  BRAND_FONTS,
  BRAND_RADII,
  type BrandFont,
  type Branding,
  type BrandRadius,
  brandingQuery,
  type ContrastFinding,
} from "../../../lib/branding-queries.js";
import { useBootstrap } from "../../../lib/queries.js";
import { useGuardedMutation } from "../../../lib/use-guarded-mutation.js";
import { m } from "../../../paraglide/messages.js";

export const Route = createFileRoute("/admin/branding/")({ component: BrandingPage });

/*
 * Branding (E1.7, design/08 §4). A workspace stores one colour, a font choice, a corner
 * radius and a logo; everything the portal renders is derived from those. The screen is
 * built around that asymmetry: the inputs are few and the preview is large, because the
 * interesting question is never "what hex did I type" but "what does the portal look like
 * now", and the answer is one `brandThemeTokens` call away in the browser.
 *
 * The preview themes a container, not the document. Theming the document would be a more
 * impressive demo and a worse tool: the founder would lose the unbranded chrome they are
 * comparing against, and an abandoned edit would leave the admin tree wearing a colour that
 * was never saved.
 */
function BrandingPage() {
  const bootstrap = useBootstrap();
  const canManage = (bootstrap.data?.permissions ?? []).includes("branding.manage");
  const branding = useQuery(brandingQuery);
  return (
    <div className="space-y-6">
      <PageHeader title={m.brand_title()} description={m.brand_subtitle()} />
      {branding.isPending ? <LoadingState lines={6} label={m.common_loading()} /> : null}
      {branding.isError ? <ErrorAlert error={branding.error} /> : null}
      {branding.data ? <BrandingForm branding={branding.data} canManage={canManage} /> : null}
    </div>
  );
}

interface Draft {
  displayName: string;
  tagline: string;
  accentColor: string;
  fontFamily: BrandFont;
  radius: BrandRadius;
  supportEmail: string;
  showPoweredBy: boolean;
}

function draftOf(branding: Branding): Draft {
  return {
    displayName: branding.displayName ?? "",
    tagline: branding.tagline ?? "",
    accentColor: branding.accentColor ?? "",
    fontFamily: branding.fontFamily,
    radius: branding.radius,
    supportEmail: branding.supportEmail ?? "",
    showPoweredBy: branding.showPoweredBy,
  };
}

export function fontLabel(font: BrandFont): string {
  switch (font) {
    case "humanist":
      return m.brand_font_humanist();
    case "geometric":
      return m.brand_font_geometric();
    case "serif":
      return m.brand_font_serif();
    case "slab":
      return m.brand_font_slab();
    case "mono":
      return m.brand_font_mono();
    default:
      return m.brand_font_system();
  }
}

export function radiusLabel(radius: BrandRadius): string {
  switch (radius) {
    case "sharp":
      return m.brand_radius_sharp();
    case "round":
      return m.brand_radius_round();
    default:
      return m.brand_radius_soft();
  }
}

function BrandingForm({ branding, canManage }: { branding: Branding; canManage: boolean }) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(branding));
  const base = useId();
  const queryClient = useQueryClient();

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const save = useGuardedMutation({
    mutationFn: () =>
      call(
        api().PATCH("/branding", {
          body: {
            displayName: draft.displayName === "" ? null : draft.displayName,
            tagline: draft.tagline === "" ? null : draft.tagline,
            accentColor: draft.accentColor === "" ? null : draft.accentColor,
            fontFamily: draft.fontFamily,
            radius: draft.radius,
            supportEmail: draft.supportEmail === "" ? null : draft.supportEmail,
            showPoweredBy: draft.showPoweredBy,
          },
        }),
      ),
    onSuccess: () => {
      toast.success(m.brand_saved());
      void queryClient.invalidateQueries({ queryKey: ["branding"] });
    },
    onError: (error) => toast.error(describeError(error).title),
  });

  /*
   * The saved accent is the server's to judge — it already measured it and shipped the
   * verdict in `contrast`. An unsaved one has no server verdict yet, so the same pure
   * derivation runs here. Only the colour moves a ratio; the font and radius cannot.
   */
  const findings: readonly ContrastFinding[] =
    draft.accentColor === (branding.accentColor ?? "")
      ? branding.contrast
      : contrastReport({
          accentColor: draft.accentColor === "" ? null : draft.accentColor,
          fontFamily: draft.fontFamily,
          radius: draft.radius,
        });
  const failures = findings.filter((f) => !f.passes);

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>{m.brand_identity_title()}</CardTitle>
          <CardDescription>{m.brand_identity_subtitle()}</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <Field
              id={`${base}-name`}
              label={m.brand_field_display_name()}
              description={m.brand_field_display_name_hint({ fallback: branding.effectiveName })}
            >
              <Input
                id={`${base}-name`}
                value={draft.displayName}
                maxLength={80}
                disabled={!canManage}
                aria-describedby={`${base}-name-description`}
                onChange={(e) => set("displayName", e.target.value)}
              />
            </Field>
            <Field
              id={`${base}-tagline`}
              label={m.brand_field_tagline()}
              description={m.brand_field_tagline_hint()}
            >
              <Input
                id={`${base}-tagline`}
                value={draft.tagline}
                maxLength={140}
                disabled={!canManage}
                aria-describedby={`${base}-tagline-description`}
                onChange={(e) => set("tagline", e.target.value)}
              />
            </Field>
            <AccentField
              id={`${base}-accent`}
              value={draft.accentColor}
              disabled={!canManage}
              description={m.brand_field_accent_hint()}
              onChange={(next) => set("accentColor", next)}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id={`${base}-font`} label={m.brand_field_font()}>
                <NativeSelect
                  id={`${base}-font`}
                  value={draft.fontFamily}
                  disabled={!canManage}
                  onChange={(e) => set("fontFamily", e.target.value as BrandFont)}
                >
                  {BRAND_FONTS.map((font) => (
                    <option key={font} value={font}>
                      {fontLabel(font)}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field id={`${base}-radius`} label={m.brand_field_radius()}>
                <NativeSelect
                  id={`${base}-radius`}
                  value={draft.radius}
                  disabled={!canManage}
                  onChange={(e) => set("radius", e.target.value as BrandRadius)}
                >
                  {BRAND_RADII.map((radius) => (
                    <option key={radius} value={radius}>
                      {radiusLabel(radius)}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            </div>
            <Field
              id={`${base}-support`}
              label={m.brand_field_support_email()}
              description={m.brand_field_support_email_hint()}
            >
              <Input
                id={`${base}-support`}
                type="email"
                value={draft.supportEmail}
                disabled={!canManage}
                aria-describedby={`${base}-support-description`}
                onChange={(e) => set("supportEmail", e.target.value)}
              />
            </Field>
            <div className="flex items-start gap-3">
              <Switch
                id={`${base}-powered`}
                checked={draft.showPoweredBy}
                disabled={!canManage}
                onCheckedChange={(on) => set("showPoweredBy", on === true)}
              />
              <div className="grid gap-1">
                <Label htmlFor={`${base}-powered`}>{m.brand_field_powered_by()}</Label>
                <p className="text-sm text-muted-foreground">{m.brand_field_powered_by_hint()}</p>
              </div>
            </div>
            {canManage ? (
              <Button type="submit" loading={save.isPending}>
                {m.common_save()}
              </Button>
            ) : null}
          </form>
        </CardContent>
      </Card>

      <div className="space-y-6">
        <BrandPreview draft={draft} logoUrl={branding.logo?.url ?? null} />
        {/*
         * Advice, never a gate. The derivation already pushes each pair as far as the hue
         * allows, so a failure here means the hue itself cannot reach AA — worth saying, not
         * worth refusing: the workspace owns its brand.
         */}
        {failures.length > 0 ? (
          <Alert variant="warning">
            <AlertTitle>{m.brand_contrast_title()}</AlertTitle>
            <AlertDescription>
              <p>{m.brand_contrast_body()}</p>
              <ul className="list-disc space-y-1 pl-5">
                {failures.map((f) => (
                  <li key={`${f.mode}:${f.pair}`}>
                    {m.brand_contrast_finding({
                      pair: f.pair,
                      mode: f.mode === "dark" ? m.brand_mode_dark() : m.brand_mode_light(),
                      ratio: f.ratio.toFixed(2),
                      required: f.required.toFixed(1),
                    })}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}
        <LogoCard branding={branding} canManage={canManage} />
      </div>
    </div>
  );
}

// --- live preview --------------------------------------------------------------------------

function BrandPreview({ draft, logoUrl }: { draft: Draft; logoUrl: string | null }) {
  const { resolvedTheme } = useTheme();
  const ref = useRef<HTMLDivElement>(null);
  const tokens = useMemo(
    () =>
      brandTokens(
        {
          accentColor: draft.accentColor === "" ? null : draft.accentColor,
          fontFamily: draft.fontFamily,
          radius: draft.radius,
        },
        resolvedTheme,
      ),
    [draft.accentColor, draft.fontFamily, draft.radius, resolvedTheme],
  );
  const applied = useRef<readonly string[]>([]);
  useLayoutEffect(() => {
    const root = ref.current;
    if (root === null) return;
    for (const name of applied.current) {
      if (!(name in tokens)) root.style.removeProperty(name);
    }
    applied.current = applyThemeTokens(tokens, root);
  }, [tokens]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.brand_preview_title()}</CardTitle>
        <CardDescription>{m.brand_preview_subtitle()}</CardDescription>
      </CardHeader>
      <CardContent>
        <div
          ref={ref}
          data-testid="brand-preview"
          className="space-y-4 rounded-[var(--sh-radius-base,0.5rem)] border bg-background p-4 font-[family-name:var(--sh-font-sans)] text-foreground"
        >
          <div className="flex items-center gap-2">
            {logoUrl === null ? null : (
              <img src={logoUrl} alt="" className="h-7 w-auto max-w-32 object-contain" />
            )}
            <span className="font-semibold">
              {draft.displayName === "" ? m.brand_preview_name() : draft.displayName}
            </span>
            <Badge variant="secondary">{m.brand_preview_badge()}</Badge>
          </div>
          {draft.tagline === "" ? null : (
            <p className="text-sm text-muted-foreground">{draft.tagline}</p>
          )}
          <Separator />
          <p className="text-sm">{m.brand_preview_body()}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button">{m.brand_preview_button()}</Button>
            <Button type="button" variant="outline">
              {m.brand_preview_button_secondary()}
            </Button>
          </div>
          {draft.showPoweredBy ? (
            <p className="text-xs text-muted-foreground">{m.brand_powered_by()}</p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

// --- logo ----------------------------------------------------------------------------------

function LogoCard({ branding, canManage }: { branding: Branding; canManage: boolean }) {
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["branding"] });
  };

  const upload = useGuardedMutation<unknown, File>({
    mutationFn: async (file) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const contentType = isLogoType(file.type) ? { contentType: file.type } : {};
      // JSON, not multipart: the route takes base64 because the bytes are small (1 MiB cap)
      // and the server decides the real content type by sniffing them, never by trusting
      // this field or the file name.
      return call(api().POST("/branding/logo", { body: { data: base64(bytes), ...contentType } }));
    },
    onSuccess: () => {
      toast.success(m.brand_logo_saved());
      invalidate();
    },
    onError: (error) => toast.error(describeError(error).title),
  });

  const fetchLogo = useGuardedMutation<unknown, string>({
    mutationFn: (url) => call(api().POST("/branding/logo/fetch", { body: { url } })),
    onSuccess: () => {
      toast.success(m.brand_logo_saved());
      invalidate();
    },
    onError: (error) => toast.error(describeError(error).title),
  });

  const remove = useGuardedMutation({
    mutationFn: () => call(api().DELETE("/branding/logo")),
    onSuccess: () => {
      toast.success(m.brand_logo_removed());
      invalidate();
    },
    onError: (error) => toast.error(describeError(error).title),
  });

  const logo = branding.logo;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.brand_logo_title()}</CardTitle>
        <CardDescription>{m.brand_logo_subtitle()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {logo === null ? (
          <p className="text-sm text-muted-foreground">{m.brand_logo_none()}</p>
        ) : (
          <div className="flex items-center gap-3">
            <img
              src={logo.url}
              alt={m.brand_logo_alt({ name: branding.effectiveName })}
              className="h-12 w-auto max-w-40 object-contain"
            />
            <p className="text-sm text-muted-foreground">
              {m.brand_logo_meta({
                width: String(logo.width),
                height: String(logo.height),
                kb: String(Math.max(1, Math.round(logo.bytes / 1024))),
              })}
            </p>
          </div>
        )}
        {canManage ? (
          <>
            <div className="flex flex-wrap gap-2">
              <LogoFileButton loading={upload.isPending} onPick={(file) => upload.mutate(file)} />
              {logo === null ? null : (
                <Button
                  type="button"
                  variant="ghost"
                  loading={remove.isPending}
                  onClick={() => remove.mutate()}
                >
                  <Trash2 aria-hidden="true" />
                  {m.brand_logo_remove()}
                </Button>
              )}
            </div>
            <LogoFetchForm
              loading={fetchLogo.isPending}
              onFetch={(next) => fetchLogo.mutate(next)}
            />
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
