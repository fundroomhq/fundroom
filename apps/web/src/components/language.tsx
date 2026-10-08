import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  toast,
} from "@fundroomhq/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { api, call } from "../lib/api.js";
import { chooseLocale, PSEUDO_LOCALE, selectableLocales } from "../lib/locale.js";
import { bootstrapQuery, meQuery, useBootstrap, useMe } from "../lib/queries.js";
import { useGuardedMutation } from "../lib/use-guarded-mutation.js";
import { m } from "../paraglide/messages.js";
import type { Locale } from "../paraglide/runtime.js";
import { NativeSelect } from "./compliance/common.js";
import { ErrorAlert } from "./error-alert.js";

/*
 * Language choice (E2.8). Two controls over `lib/locale.ts`:
 * - `LanguageCard` on `/settings`: the reader's own language (UI and email), saved to the
 *   account with `PUT /me/locale` and remembered on this device;
 * - `WorkspaceLanguageCard` on the admin access settings: the workspace default
 *   (`PUT /workspace/locale`, `access.settings`), for everyone who has not chosen.
 * Each language is named in its own words where there is one; the pseudo-locale is offered only
 * where it may be used (a dev build, or `I18N_PSEUDO_LOCALE`).
 */

/** A locale's name for a picker. */
export function localeName(locale: string): string {
  switch (locale) {
    case "en":
      return m.locale_name_en();
    case PSEUDO_LOCALE:
      return m.locale_name_en_xa();
    default:
      return locale;
  }
}

function usePseudoAllowed(): boolean {
  const bootstrap = useBootstrap();
  return (
    (import.meta.env.DEV && import.meta.env.MODE !== "test") ||
    bootstrap.data?.pseudoLocale === true
  );
}

export function LanguageCard() {
  const id = useId();
  const me = useMe();
  const bootstrap = useBootstrap();
  const queryClient = useQueryClient();
  const pseudoAllowed = usePseudoAllowed();
  const signedIn = me.data !== null && me.data !== undefined;
  const stored = me.data?.session.user.locale ?? null;
  const [choice, setChoice] = useState<string>(stored ?? "");
  const [error, setError] = useState<unknown>(undefined);
  const workspaceDefault = bootstrap.data?.workspace?.defaultLocale ?? "en";

  async function change(value: string) {
    setChoice(value);
    setError(undefined);
    const next = value === "" ? null : (value as Locale);
    try {
      await chooseLocale(next, {
        signedIn,
        serverAcceptsPseudo: bootstrap.data?.pseudoLocale === true,
      });
      if (signedIn && (next !== PSEUDO_LOCALE || bootstrap.data?.pseudoLocale === true)) {
        queryClient.setQueryData(meQuery.queryKey, (prev) =>
          prev
            ? {
                ...prev,
                session: { ...prev.session, user: { ...prev.session.user, locale: next } },
              }
            : prev,
        );
      }
      toast.success(m.language_saved());
    } catch (e) {
      setError(e);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.language_title()}</CardTitle>
        <CardDescription>{m.language_subtitle()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Field id={`${id}-language`} label={m.language_label()} className="max-w-xs">
          <NativeSelect
            id={`${id}-language`}
            value={choice}
            onChange={(e) => void change(e.target.value)}
          >
            <option value="">
              {m.language_workspace_default({ language: localeName(workspaceDefault) })}
            </option>
            {selectableLocales(pseudoAllowed).map((l) => (
              <option key={l} value={l} lang={l}>
                {localeName(l)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        {signedIn ? null : (
          <p className="text-sm text-muted-foreground">{m.language_signed_out_note()}</p>
        )}
        {error === undefined ? null : <ErrorAlert error={error} />}
      </CardContent>
    </Card>
  );
}

export function WorkspaceLanguageCard({ canEdit }: { canEdit: boolean }) {
  const id = useId();
  const bootstrap = useBootstrap();
  const queryClient = useQueryClient();
  const pseudoAllowed = bootstrap.data?.pseudoLocale === true;
  const saved = bootstrap.data?.workspace?.defaultLocale ?? "en";
  const [draft, setDraft] = useState<string>(saved);
  const save = useGuardedMutation({
    mutationFn: (defaultLocale: Locale) =>
      call(api().PUT("/workspace/locale", { body: { defaultLocale } })),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: bootstrapQuery.queryKey });
      toast.success(m.workspace_language_saved());
    },
  });
  // The server refuses the pseudo-locale unless the operator enabled it, so it is offered only then.
  const options = selectableLocales(pseudoAllowed);
  if (!(options as string[]).includes(saved)) options.push(saved as Locale);
  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>{m.workspace_language_title()}</CardTitle>
        <CardDescription>
          {canEdit ? m.workspace_language_body() : m.workspace_language_read_only()}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft !== saved) save.mutate(draft as Locale);
          }}
        >
          <Field id={`${id}-default`} label={m.workspace_language_label()} className="max-w-xs">
            <NativeSelect
              id={`${id}-default`}
              value={draft}
              disabled={!canEdit}
              onChange={(e) => setDraft(e.target.value)}
            >
              {options.map((l) => (
                <option key={l} value={l} lang={l}>
                  {localeName(l)}
                </option>
              ))}
            </NativeSelect>
          </Field>
          {save.isError ? <ErrorAlert error={save.error} /> : null}
          {canEdit ? (
            <Button type="submit" disabled={draft === saved} loading={save.isPending}>
              {m.workspace_language_save()}
            </Button>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}
