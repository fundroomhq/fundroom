import { Button, Field, Input } from "@fundroomhq/ui";
import { Upload } from "lucide-react";
import { type FormEvent, useId, useRef, useState } from "react";
import { LOGO_ACCEPT } from "../../lib/branding-queries.js";
import { m } from "../../paraglide/messages.js";

/*
 * The two brand controls that the admin screen (`/admin/branding`) and the setup wizard's
 * company step both need (E1.7).
 *
 * Only the presentation is shared, never the mutation: the two screens disagree about what a
 * failure means. Admin raises a toast and lets `useGuardedMutation` bounce a weak session to
 * the step-up screen; the wizard has its own security step to send the founder back to, and
 * navigating out of a half-finished wizard would lose the steps behind it. So these components
 * hand the caller a `File` or a URL and stay out of it.
 */

/** `<input type="color">` will not accept "": it needs a concrete swatch to sit on. */
export const SWATCH_FALLBACK = "#1d4ed8";
export const HEX_RE = /^#[0-9a-f]{6}$/iu;

export function isLogoType(value: string): value is "image/png" | "image/jpeg" | "image/webp" {
  return value === "image/png" || value === "image/jpeg" || value === "image/webp";
}

/** Bytes → base64 in 8 KiB slices; `String.fromCharCode(...all)` blows the call stack. */
export function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

/*
 * There is no colour picker in the design system, and a bespoke one would be a worse control
 * than the operating system's: `<input type="color">` is the native swatch, and the text field
 * beside it is how a brand hex actually arrives — pasted from a brand guide, not chosen from a
 * wheel.
 */
export function AccentField({
  id,
  value,
  onChange,
  disabled = false,
  description,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  description?: string;
}) {
  return (
    <Field id={`${id}-hex`} label={m.brand_field_accent()} description={description}>
      <div className="flex items-center gap-2">
        <input
          type="color"
          id={id}
          aria-label={m.brand_field_accent_swatch()}
          value={HEX_RE.test(value) ? value : SWATCH_FALLBACK}
          disabled={disabled}
          className="h-9 w-12 shrink-0 cursor-pointer rounded-md border border-input bg-transparent p-1"
          onChange={(e) => onChange(e.target.value)}
        />
        <Input
          id={`${id}-hex`}
          value={value}
          placeholder={SWATCH_FALLBACK}
          maxLength={7}
          spellCheck={false}
          disabled={disabled}
          {...(description === undefined ? {} : { "aria-describedby": `${id}-hex-description` })}
          onChange={(e) => onChange(e.target.value.trim())}
        />
        {value === "" ? null : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => onChange("")}
          >
            {m.brand_accent_clear()}
          </Button>
        )}
      </div>
    </Field>
  );
}

/** A hidden file input behind a button; hands the chosen file back and clears itself. */
export function LogoFileButton({
  onPick,
  loading = false,
  disabled = false,
}: {
  onPick: (file: File) => void;
  loading?: boolean;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        hidden
        accept={LOGO_ACCEPT}
        aria-label={m.brand_logo_upload_input()}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) onPick(file);
        }}
      />
      <Button
        type="button"
        variant="outline"
        loading={loading}
        disabled={disabled}
        onClick={() => input.current?.click()}
      >
        <Upload aria-hidden="true" />
        {m.brand_logo_upload()}
      </Button>
    </>
  );
}

/** "Pull it from our website": a URL in, `POST /branding/logo/fetch` for the caller to run. */
export function LogoFetchForm({
  onFetch,
  loading = false,
  disabled = false,
}: {
  onFetch: (url: string) => void;
  loading?: boolean;
  disabled?: boolean;
}) {
  const [url, setUrl] = useState("");
  const id = useId();
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (url !== "") onFetch(url);
      }}
    >
      <Field
        id={id}
        label={m.brand_logo_from_url()}
        description={m.brand_logo_from_url_hint()}
        className="min-w-56 flex-1"
      >
        <Input
          id={id}
          type="url"
          value={url}
          placeholder="https://example.com"
          disabled={disabled}
          aria-describedby={`${id}-description`}
          onChange={(e) => setUrl(e.target.value)}
        />
      </Field>
      <Button type="submit" variant="outline" loading={loading} disabled={disabled || url === ""}>
        {m.brand_logo_fetch()}
      </Button>
    </form>
  );
}
