import { createFileRoute, useNavigate } from "@tanstack/react-router";
import * as z from "zod/mini";
import { LoginForm } from "../../../components/login-form.js";
import { m } from "../../../paraglide/messages.js";

/**
 * Top-level popup login on the portal origin (design/08 §1c, ADR-0040 decision 11): embeds that
 * cannot set a partitioned cookie — or that need a real top-level context for a ceremony the
 * frame cannot run, such as a passkey the host did not delegate — open this window; on success
 * it tells the opener and closes itself.
 *
 * `reason` only changes the sentence above the form. It is not a credential, a permission or an
 * instruction: the popup does exactly the same thing whatever it says, so a host page putting a
 * value of its own in the URL buys nothing, and an unknown one falls through to no sentence.
 */
const searchSchema = z.object({
  reason: z.catch(z.optional(z.enum(["level", "fresh"])), undefined),
});

export const Route = createFileRoute("/_auth/auth/popup")({
  validateSearch: searchSchema,
  component: PopupPage,
});

function PopupPage() {
  const { reason } = Route.useSearch();
  const navigate = useNavigate();
  return (
    <div className="space-y-4">
      {reason === undefined ? null : (
        <p className="text-sm text-muted-foreground">
          {reason === "fresh" ? m.step_up_fresh_body() : m.step_up_level_body()}
        </p>
      )}
      <LoginForm
        returnTo="/"
        onSignedIn={() => {
          if (window.opener && typeof window.opener.postMessage === "function") {
            (window.opener as Window).postMessage(
              { v: 1, type: "auth", payload: { state: "authenticated" } },
              window.location.origin,
            );
            window.close();
          } else {
            void navigate({ to: "/", replace: true });
          }
        }}
      />
    </div>
  );
}
