import { Alert, AlertDescription, AlertTitle, Button } from "@fundroomhq/ui";
import type { ReactNode } from "react";
import { m } from "../paraglide/messages.js";
import { CopyButton } from "./copy-button.js";

/*
 * A credential the server returns exactly once (an API key's token, a webhook signing secret).
 * The server keeps only a hash or a sealed copy it never hands back, so the value stays pinned
 * here until the admin dismisses it, copying is one click away, and the copy says plainly that
 * leaving the page loses it. It lives in component state only: never a query cache, never storage.
 */
export function ShownOnce({
  title,
  value,
  copyLabel,
  children,
  onDismiss,
}: {
  title: string;
  value: string;
  copyLabel: string;
  children?: ReactNode;
  onDismiss: () => void;
}) {
  return (
    <Alert variant="success">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>{m.shown_once_warning()}</p>
        <code className="block w-full overflow-x-auto rounded border bg-background p-2 font-mono text-xs break-all">
          {value}
        </code>
        {children}
        <div className="flex flex-wrap gap-2">
          <CopyButton value={value} label={copyLabel} />
          <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
            {m.shown_once_dismiss()}
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}
